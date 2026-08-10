import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { probeExecutors } from './probe.js';
import { createStructuredOutputValidator } from './structured-output.js';
import { rotateLogFile } from './log-rotation.js';
import type {
  ExecutorAdapter,
  RuntimeHandle,
  RuntimePermissionPolicy,
  RuntimeStartOptions,
  StructuredExecutionInput,
  StructuredExecutionResult,
} from './types.js';
import { signalProcessTree } from './process-tree.js';

interface ClaudeRuntime extends RuntimeHandle {
  executable: string;
  runtimeDirectory: string;
  logPath: string;
  capabilityConfigDirectory: string;
  mcpConfigPath: string;
  credentialEnvironment: Record<string, string>;
  activeProcesses: Map<string, ChildProcess>;
}

interface ClaudeJsonEnvelope {
  type?: string;
  session_id?: string;
  structured_output?: unknown;
  result?: string;
  is_error?: boolean;
  subtype?: string;
  errors?: unknown;
  message?: { content?: ClaudeContentBlock[] };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    content_block?: ClaudeContentBlock;
  };
  tools?: string[];
  slash_commands?: string[];
  mcp_servers?: Array<{ name?: string; status?: string; error?: string }>;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeStreamState {
  sawTextDelta: boolean;
  sawThinkingDelta: boolean;
  toolNames: Map<string, string>;
}

const maximumCapturedOutputBytes = 16 * 1024 * 1024;

export class ClaudeCodeAdapter implements ExecutorAdapter {
  private readonly runtimes = new Map<string, ClaudeRuntime>();

  constructor(private readonly knownInstallation?: ExecutorInstallation) {}

  async probe(): Promise<ExecutorInstallation> {
    if (this.knownInstallation) return this.knownInstallation;
    const installation = (await probeExecutors()).find((item) => item.id === 'claude');
    if (!installation) throw new Error('Claude Code definition is missing.');
    return installation;
  }

  async startRuntime(
    workspacePath: string,
    runtimeDirectory: string,
    options: RuntimeStartOptions = {},
  ): Promise<RuntimeHandle> {
    const installation = await this.probe();
    if (installation.health !== 'available' || !installation.path) {
      throw new Error(installation.error ?? 'Claude Code CLI is unavailable.');
    }
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    const capabilityConfigDirectory = join(runtimeDirectory, 'capability-config');
    const mcpConfigPath = join(capabilityConfigDirectory, '.mcp.json');
    mkdirSync(capabilityConfigDirectory, { recursive: true });
    if (!existsSync(mcpConfigPath)) {
      writeFileSync(mcpConfigPath, '{\n  "mcpServers": {}\n}\n', { mode: 0o600 });
    }
    projectClaudeSkills(capabilityConfigDirectory, workspacePath);
    const runtime: ClaudeRuntime = {
      id: `runtime_${randomUUID().replaceAll('-', '')}`,
      executor: 'claude',
      workspacePath,
      endpoint: `process://${basename(installation.path)}`,
      sessionIds: [],
      executable: installation.path,
      runtimeDirectory,
      logPath: join(runtimeDirectory, 'runtime.log'),
      capabilityConfigDirectory,
      mcpConfigPath,
      credentialEnvironment: { ...(options.environment ?? {}) },
      activeProcesses: new Map(),
    };
    this.runtimes.set(runtime.id, runtime);
    return this.publicHandle(runtime);
  }

  async executeStructured<T>(input: StructuredExecutionInput): Promise<StructuredExecutionResult<T>> {
    const runtime = this.getRuntime(input.runtime.id);
    const requestedSessionId = input.resumeSessionId ?? randomUUID();
    await input.onEvent?.({
      kind: 'status',
      message: input.resumeSessionId ? '正在恢复 Claude Code Session。' : '正在创建 Claude Code Session。',
      occurredAt: new Date().toISOString(),
      data: { requestedSessionId, resumed: Boolean(input.resumeSessionId) },
    });
    if (!runtime.sessionIds.includes(requestedSessionId)) runtime.sessionIds.push(requestedSessionId);
    await input.onSessionStarted?.(requestedSessionId);
    const settingsPath = this.writeExecutionSettings(runtime, requestedSessionId, input);
    const args = this.executionArguments(input, runtime, settingsPath, requestedSessionId);
    let envelope: ClaudeJsonEnvelope;
    try {
      envelope = await this.runClaude(runtime, requestedSessionId, args, input);
    } catch (error) {
      await input.onEvent?.({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        occurredAt: new Date().toISOString(),
      });
      throw error;
    }
    const sessionId = envelope.session_id ?? requestedSessionId;
    if (!runtime.sessionIds.includes(sessionId)) runtime.sessionIds.push(sessionId);
    if (sessionId !== requestedSessionId) await input.onSessionStarted?.(sessionId);
    if (envelope.is_error) {
      throw new Error(claudeFailureMessage(envelope));
    }
    const validator = createStructuredOutputValidator<T>(input.schema);
    const rawOutput = envelope.structured_output === undefined
      ? envelope.result ?? ''
      : JSON.stringify(envelope.structured_output);
    const validation = validator.parseAndValidate(rawOutput);
    if (!validation.ok) {
      throw new Error(`Claude Code structured output failed local Schema validation: ${validation.errors.join('; ')}`);
    }
    await input.onEvent?.({
      kind: 'status',
      message: 'Claude Code 已返回结构化结果。',
      occurredAt: new Date().toISOString(),
      data: { sessionId },
    });
    return { sessionId, output: validation.value };
  }

  async abortSession(runtime: RuntimeHandle, sessionId: string): Promise<void> {
    const managed = this.runtimes.get(runtime.id);
    const child = managed?.activeProcesses.get(sessionId);
    if (!child || child.exitCode !== null) return;
    signalProcessTree(child, 'SIGTERM');
    if (!await waitForProcessExit(child, 3_000) && child.exitCode === null) signalProcessTree(child, 'SIGKILL');
  }

  async stopRuntime(runtime: RuntimeHandle): Promise<void> {
    const managed = this.runtimes.get(runtime.id);
    if (!managed) return;
    await Promise.allSettled([...managed.activeProcesses.values()].map(async (child) => {
      if (child.exitCode !== null) return;
      signalProcessTree(child, 'SIGTERM');
      if (!await waitForProcessExit(child, 3_000) && child.exitCode === null) signalProcessTree(child, 'SIGKILL');
    }));
    managed.activeProcesses.clear();
    this.runtimes.delete(runtime.id);
  }

  private executionArguments(
    input: StructuredExecutionInput,
    runtime: ClaudeRuntime,
    settingsPath: string,
    sessionId: string,
  ): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--json-schema', JSON.stringify(input.schema),
      '--model', input.model,
      '--name', input.title.slice(0, 120),
      '--permission-mode', 'dontAsk',
      '--settings', settingsPath,
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--mcp-config', runtime.mcpConfigPath,
      '--no-chrome',
    ];
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    else args.push('--session-id', sessionId);
    if (input.toolMode === 'disabled') args.push('--tools', '');
    args.push(input.prompt);
    return args;
  }

  private writeExecutionSettings(
    runtime: ClaudeRuntime,
    sessionId: string,
    input: StructuredExecutionInput,
  ): string {
    const policy = input.policy;
    const allow = claudeAllowRules(policy, input.readOnly ?? false, input.toolMode ?? 'enabled');
    const deny = claudeDenyRules(policy, input.readOnly ?? false, input.toolMode ?? 'enabled');
    const settingsPath = join(runtime.runtimeDirectory, `claude-settings-${sessionId}.json`);
    writeFileSync(settingsPath, `${JSON.stringify({
      permissions: {
        defaultMode: 'dontAsk',
        allow,
        deny,
        additionalDirectories: policy?.allowedExternalDirectoryPatterns ?? [],
        disableBypassPermissionsMode: 'disable',
      },
      disableAllHooks: true,
    }, null, 2)}\n`, { mode: 0o600 });
    return settingsPath;
  }

  private runClaude(
    runtime: ClaudeRuntime,
    sessionId: string,
    args: string[],
    input: StructuredExecutionInput,
  ): Promise<ClaudeJsonEnvelope> {
    return new Promise((resolve, reject) => {
      const abortSignal = input.abortSignal;
      if (abortSignal?.aborted) {
        reject(abortedClaudeSessionError());
        return;
      }
      const child = spawn(runtime.executable, args, {
        cwd: runtime.workspacePath,
        env: {
          ...process.env,
          ...runtime.credentialEnvironment,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      runtime.activeProcesses.set(sessionId, child);
      rotateLogFile(runtime.logPath);
      const log = createWriteStream(runtime.logPath, { flags: 'a', mode: 0o600 });
      log.write(`\n[yanxu] ${new Date().toISOString()} executor=claude session=${sessionId} started\n`);
      let stdout = '';
      let stdoutLineBuffer = '';
      let stderr = '';
      let outputBytes = 0;
      const streamState: ClaudeStreamState = {
        sawTextDelta: false,
        sawThinkingDelta: false,
        toolNames: new Map(),
      };
      let eventQueue = Promise.resolve();
      const queueStreamObject = (value: ClaudeJsonEnvelope) => {
        eventQueue = eventQueue.then(() => emitClaudeStreamObject(input, value, streamState));
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maximumCapturedOutputBytes) {
          signalProcessTree(child, 'SIGTERM');
          return;
        }
        const text = chunk.toString();
        if (target === 'stdout') {
          stdout += text;
          stdoutLineBuffer += text;
          const lines = stdoutLineBuffer.split('\n');
          stdoutLineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const value = parseClaudeStreamLine(line);
            if (value) queueStreamObject(value);
          }
        } else stderr += text;
        log.write(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      const abort = () => signalProcessTree(child, 'SIGTERM');
      abortSignal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => {
        runtime.activeProcesses.delete(sessionId);
        abortSignal?.removeEventListener('abort', abort);
        log.end();
        reject(error);
      });
      child.once('close', async (code, signal) => {
        runtime.activeProcesses.delete(sessionId);
        abortSignal?.removeEventListener('abort', abort);
        log.write(`\n[yanxu] ${new Date().toISOString()} executor=claude session=${sessionId} exit=${code ?? signal ?? 'unknown'}\n`);
        log.end();
        if (stdoutLineBuffer.trim()) {
          const value = parseClaudeStreamLine(stdoutLineBuffer);
          if (value) queueStreamObject(value);
        }
        await eventQueue;
        if (abortSignal?.aborted) {
          reject(abortedClaudeSessionError());
          return;
        }
        if (outputBytes > maximumCapturedOutputBytes) {
          reject(new Error(`Claude Code output exceeded ${maximumCapturedOutputBytes} bytes.`));
          return;
        }
        const envelope = parseClaudeEnvelope(stdout);
        if (code !== 0) {
          reject(new Error(claudeProcessFailure(code, signal, stderr, envelope)));
          return;
        }
        if (!envelope) {
          reject(new Error(`Claude Code returned invalid JSON output.${stderr.trim() ? ` ${cleanOutput(stderr)}` : ''}`));
          return;
        }
        resolve(envelope);
      });
    });
  }

  private getRuntime(runtimeId: string): ClaudeRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Claude Code runtime ${runtimeId} is not active.`);
    return runtime;
  }

  private publicHandle(runtime: ClaudeRuntime): RuntimeHandle {
    return {
      id: runtime.id,
      executor: runtime.executor,
      workspacePath: runtime.workspacePath,
      endpoint: runtime.endpoint,
      sessionIds: runtime.sessionIds,
    };
  }
}

function parseClaudeStreamLine(line: string): ClaudeJsonEnvelope | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as ClaudeJsonEnvelope;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function emitClaudeStreamObject(
  input: StructuredExecutionInput,
  value: ClaudeJsonEnvelope,
  state: ClaudeStreamState,
): Promise<void> {
  if (!input.onEvent) return;
  const occurredAt = new Date().toISOString();
  if (value.type === 'system') {
    const mcps = (value.mcp_servers ?? []).map((server) => ({
      name: server.name ?? 'unknown',
      status: normalizeClaudeMcpStatus(server.status),
      ...(server.error ? { error: cleanOutput(server.error) } : {}),
    }));
    const skills = (value.slash_commands ?? [])
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .map((name) => ({ name: name.replace(/^\//, ''), status: 'loaded' }));
    await input.onEvent({
      kind: 'status',
      message: 'Claude Code 运行时已初始化。',
      occurredAt,
      data: {
        sessionId: value.session_id ?? null,
        capabilityRuntime: { skills, mcps },
        availableTools: value.tools ?? [],
      },
    });
    return;
  }
  if (value.type === 'stream_event') {
    const delta = value.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      state.sawTextDelta = true;
      await input.onEvent({ kind: 'text', message: delta.text.slice(0, 2_000), occurredAt });
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
      state.sawThinkingDelta = true;
      await input.onEvent({ kind: 'thinking', message: delta.thinking.slice(0, 2_000), occurredAt });
    }
    const block = value.event?.content_block;
    if (block?.type === 'tool_use') await emitClaudeToolCall(input, block, state, occurredAt);
    return;
  }
  const blocks = value.message?.content ?? [];
  if (value.type === 'assistant') {
    for (const block of blocks) {
      if (block.type === 'tool_use') await emitClaudeToolCall(input, block, state, occurredAt);
      else if (block.type === 'text' && block.text && !state.sawTextDelta) {
        await input.onEvent({ kind: 'text', message: block.text.slice(0, 2_000), occurredAt });
      } else if (block.type === 'thinking' && block.thinking && !state.sawThinkingDelta) {
        await input.onEvent({ kind: 'thinking', message: block.thinking.slice(0, 2_000), occurredAt });
      }
    }
  } else if (value.type === 'user') {
    for (const block of blocks.filter((item) => item.type === 'tool_result')) {
      const tool = block.tool_use_id ? state.toolNames.get(block.tool_use_id) : undefined;
      await input.onEvent({
        kind: 'tool_result',
        message: `${tool ?? 'tool'} · ${block.is_error ? 'failed' : 'completed'}`,
        occurredAt,
        data: {
          tool: tool ?? null,
          toolUseId: block.tool_use_id ?? null,
          status: block.is_error ? 'failed' : 'completed',
          output: boundedEventData(block.content),
        },
      });
    }
  }
}

async function emitClaudeToolCall(
  input: StructuredExecutionInput,
  block: ClaudeContentBlock,
  state: ClaudeStreamState,
  occurredAt: string,
): Promise<void> {
  if (!input.onEvent || !block.name) return;
  if (block.id) {
    if (state.toolNames.has(block.id)) return;
    state.toolNames.set(block.id, block.name);
  }
  await input.onEvent({
    kind: 'tool_call',
    message: `${block.name} · running`,
    occurredAt,
    data: { tool: block.name, toolUseId: block.id ?? null, status: 'running', input: boundedEventData(block.input) },
  });
}

function normalizeClaudeMcpStatus(status?: string): string {
  if (!status) return 'not_checked';
  if (/connected|ready|available/i.test(status)) return 'connected';
  if (/auth/i.test(status)) return 'needs_auth';
  if (/disabled/i.test(status)) return 'disabled';
  if (/fail|error/i.test(status)) return 'failed';
  return status;
}

function boundedEventData(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized.length <= 2_000 ? value : `${serialized.slice(0, 2_000)}…`;
}

function projectClaudeSkills(configDirectory: string, workspacePath: string): void {
  const source = join(configDirectory, '.claude', 'skills');
  if (!existsSync(source)) return;
  const target = join(workspacePath, '.claude', 'skills');
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, dereference: false, errorOnExist: false, force: true });
}

function claudeAllowRules(
  policy: RuntimePermissionPolicy | undefined,
  readOnly: boolean,
  toolMode: 'enabled' | 'disabled',
): string[] {
  if (toolMode === 'disabled') return [];
  const rules = new Set<string>();
  for (const pattern of policy?.allowedReadPatterns ?? []) rules.add(`Read(${pattern})`);
  if (!readOnly) {
    for (const pattern of policy?.allowedEditPatterns ?? []) {
      rules.add(`Edit(${pattern})`);
      rules.add(`Write(${pattern})`);
      rules.add(`NotebookEdit(${pattern})`);
    }
  }
  for (const pattern of policy?.allowedBashPatterns ?? []) rules.add(`Bash(${pattern})`);
  for (const name of policy?.allowedSkillPatterns ?? []) rules.add(`Skill(${name})`);
  for (const pattern of policy?.allowedMcpToolPatterns ?? []) rules.add(`mcp__${pattern.replaceAll('_*', '__*')}`);
  return [...rules];
}

function claudeDenyRules(
  policy: RuntimePermissionPolicy | undefined,
  readOnly: boolean,
  toolMode: 'enabled' | 'disabled',
): string[] {
  if (toolMode === 'disabled') return ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Skill'];
  const rules = new Set<string>();
  if (readOnly) {
    rules.add('Edit');
    rules.add('Write');
    rules.add('NotebookEdit');
  }
  for (const pattern of policy?.forbiddenReadPatterns ?? []) rules.add(`Read(${pattern})`);
  for (const pattern of policy?.deniedMcpToolPatterns ?? []) rules.add(`mcp__${pattern.replaceAll('_*', '__*')}`);
  if (policy?.networkPolicy === 'deny') {
    rules.add('WebFetch');
    rules.add('WebSearch');
  }
  return [...rules];
}

function parseClaudeEnvelope(stdout: string): ClaudeJsonEnvelope | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as ClaudeJsonEnvelope;
  } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as ClaudeJsonEnvelope;
        if (value && typeof value === 'object') return value;
      } catch {
        // Continue to the next line. Some CLI wrappers emit a banner first.
      }
    }
    return null;
  }
}

function claudeFailureMessage(envelope: ClaudeJsonEnvelope): string {
  return cleanOutput(envelope.result ?? envelope.subtype ?? JSON.stringify(envelope.errors ?? 'Claude Code execution failed.'));
}

function claudeProcessFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  envelope: ClaudeJsonEnvelope | null,
): string {
  const detail = envelope ? claudeFailureMessage(envelope) : cleanOutput(stderr);
  return `Claude Code exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.${detail ? ` ${detail}` : ''}`;
}

function cleanOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 4_000);
}

function abortedClaudeSessionError(): Error {
  const error = new Error('Claude Code session was aborted.');
  error.name = 'AbortError';
  return error;
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
