import { createOpencodeClient, type PermissionRequest, type PermissionRuleset } from '@opencode-ai/sdk/v2';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { probeExecutors } from './probe.js';
import type {
  ExecutorAdapter,
  RuntimeHandle,
  RuntimePermissionPolicy,
  RuntimeStartOptions,
  StructuredExecutionInput,
  StructuredExecutionResult,
} from './types.js';
import { createStructuredOutputValidator, isStructuredOutputCompatibilityError } from './structured-output.js';
import { rotateLogFile } from './log-rotation.js';
import { signalProcessTree } from './process-tree.js';

interface ManagedRuntime extends RuntimeHandle {
  password: string;
  process: ChildProcessWithoutNullStreams;
  log: WriteStream;
}

type SdkClient = ReturnType<typeof createOpencodeClient>;

type StructuredOutputMode = 'opencode-schema' | 'prompt-json';

interface PromptResult<T = unknown> {
  info: {
    id?: string;
    role?: string;
    time?: { created?: number; completed?: number };
    structured?: T;
    error?: { name?: string; data?: { message?: string } };
  };
  parts: Array<{
    id?: string;
    type: string;
    text?: string;
    tool?: string;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      title?: string;
      metadata?: unknown;
    };
  }>;
}

interface OpenCodePartEmissionState {
  textLengths: Map<string, number>;
  toolStatuses: Map<string, string>;
}

const structuredRepairAttempts = 2;
const permissionPollingFailureLimit = 10;
const fallbackOpenCodeToolIds = [
  'bash',
  'read',
  'write',
  'edit',
  'apply_patch',
  'patch',
  'glob',
  'grep',
  'list',
  'task',
  'skill',
  'webfetch',
  'websearch',
  'web-search-prime_web_search_prime',
  'codesearch',
  'lsp',
  'todowrite',
  'todoread',
  'question',
] as const;

export class OpenCodeAdapter implements ExecutorAdapter {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly structuredOutputModes = new Map<string, StructuredOutputMode>();
  private readonly disabledToolsByRuntime = new Map<string, Record<string, boolean>>();
  private readonly activeSessionAborts = new Map<string, AbortController>();

  constructor(private readonly knownInstallation?: ExecutorInstallation) {}

  async probe(): Promise<ExecutorInstallation> {
    if (this.knownInstallation) return this.knownInstallation;
    const executors = await probeExecutors();
    const installation = executors.find((item) => item.id === 'opencode');
    if (!installation) throw new Error('OpenCode definition is missing.');
    return installation;
  }

  async startRuntime(
    workspacePath: string,
    runtimeDirectory: string,
    options: RuntimeStartOptions = {},
  ): Promise<RuntimeHandle> {
    const installation = await this.probe();
    if (installation.health !== 'available' || !installation.path) throw new Error(installation.error ?? 'OpenCode CLI is unavailable.');
    mkdirSync(runtimeDirectory, { recursive: true });
    const port = await findFreePort();
    const password = randomBytes(24).toString('base64url');
    const capabilityConfigDirectory = join(runtimeDirectory, 'capability-config');
    const capabilityConfigPath = join(capabilityConfigDirectory, 'opencode.json');
    const capabilityEnvironment = existsSync(capabilityConfigPath)
      ? {
        OPENCODE_CONFIG_DIR: capabilityConfigDirectory,
        OPENCODE_CONFIG: capabilityConfigPath,
        OPENCODE_CONFIG_CONTENT: readFileSync(capabilityConfigPath, 'utf8'),
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
      }
      : {};
    const child = spawn(installation.path, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...options.environment,
        OPENCODE_SERVER_USERNAME: 'yanxu',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_SHARE: 'true',
        ...capabilityEnvironment,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const logPath = join(runtimeDirectory, 'runtime.log');
    rotateLogFile(logPath);
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    log.write(`\n[yanxu] ${new Date().toISOString()} executor=opencode runtime=started\n`);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const handle: ManagedRuntime = {
      id: `runtime_${randomUUID().replaceAll('-', '')}`,
      executor: 'opencode', workspacePath, endpoint: `http://127.0.0.1:${port}`, sessionIds: [], password, process: child, log,
    };
    child.once('close', () => log.end());
    this.runtimes.set(handle.id, handle);
    try {
      await this.waitForHealth(handle);
    } catch (error) {
      this.runtimes.delete(handle.id);
      if (handle.process.exitCode === null) signalProcessTree(handle.process, 'SIGTERM');
      throw error;
    }
    return this.publicHandle(handle);
  }

  async executeStructured<T>(input: StructuredExecutionInput): Promise<StructuredExecutionResult<T>> {
    const runtime = this.getRuntime(input.runtime.id);
    const client = this.client(runtime);
    const rules = permissionRules(input.permissionMode ?? 'standard', input.readOnly ?? false, input.policy);
    let session: { id: string } | null = null;
    await input.onEvent?.({
      kind: 'status',
      message: input.resumeSessionId ? '正在验证并恢复 OpenCode Session。' : '正在创建 OpenCode Session。',
      occurredAt: new Date().toISOString(),
      data: { requestedSessionId: input.resumeSessionId ?? null },
    });
    if (input.resumeSessionId) {
      try {
        const existing = unwrap<{ id: string } | undefined>(await client.session.get({
          sessionID: input.resumeSessionId,
          directory: runtime.workspacePath,
        }));
        if (existing?.id === input.resumeSessionId) {
          const updated = unwrap<{ id: string } | undefined>(await client.session.update({
            sessionID: existing.id,
            directory: runtime.workspacePath,
            permission: rules,
          }));
          if (updated?.id === existing.id) session = updated;
        }
      } catch {
        // A session can disappear when OpenCode storage is reset or a runtime
        // is upgraded. Continue safely in a fresh session instead of retrying
        // the same stale identifier forever.
      }
    }
    session ??= unwrap<{ id: string }>(await client.session.create({
        title: input.title,
        directory: runtime.workspacePath,
        permission: rules,
      }));
    if (!runtime.sessionIds.includes(session.id)) runtime.sessionIds.push(session.id);
    await input.onSessionStarted?.(session.id);
    await input.onEvent?.({
      kind: 'status',
      message: input.resumeSessionId && session.id === input.resumeSessionId
        ? 'OpenCode Session 已恢复。'
        : 'OpenCode Session 已建立。',
      occurredAt: new Date().toISOString(),
      data: { sessionId: session.id, resumed: Boolean(input.resumeSessionId && session.id === input.resumeSessionId) },
    });
    await this.emitRuntimeCapabilities(client, runtime, input);
    const executionAbort = new AbortController();
    const forwardInputAbort = () => executionAbort.abort();
    if (input.abortSignal?.aborted) executionAbort.abort();
    else input.abortSignal?.addEventListener('abort', forwardInputAbort, { once: true });
    const executionInput: StructuredExecutionInput = { ...input, abortSignal: executionAbort.signal };
    const activeAbortKey = `${runtime.id}:${session.id}`;
    this.activeSessionAborts.set(activeAbortKey, executionAbort);
    const [providerID, ...modelParts] = input.model.split('/');
    const modelID = modelParts.join('/');
    if (!providerID || !modelID) throw new Error('OpenCode model must use provider/model format.');
    const abort = () => {
      // Abort is best-effort. The runtime may close the HTTP connection while
      // handling the request, which must not become an unhandled rejection and
      // terminate the daemon.
      void client.session.abort({ sessionID: session.id, directory: runtime.workspacePath }).catch(() => undefined);
    };
    executionAbort.signal.addEventListener('abort', abort, { once: true });
    let promptSettled = false;
    const permissionWorker = this.processPermissions(client, runtime, session.id, executionInput, () => promptSettled);
    const promptWorker = (async (): Promise<StructuredExecutionResult<T>> => {
      // OpenCode 1.17.x cannot reliably list messages created by
      // prompt_async when the request uses json_schema: the stored format is
      // rejected while deserializing the message list. Long-running work must
      // use prompt_async, so default to the model-agnostic JSON protocol and
      // validate the response locally instead.
      const preferredMode = this.structuredOutputModes.get(input.model) ?? 'prompt-json';
      let continuingAfterSchemaFailure = false;
      if (preferredMode === 'opencode-schema') {
        try {
          const output = await this.promptWithOpenCodeSchema<T>(client, runtime, session.id, providerID, modelID, executionInput);
          this.structuredOutputModes.set(input.model, 'opencode-schema');
          return { sessionId: session.id, output };
        } catch (error) {
          if (!isStructuredOutputCompatibilityError(error)) throw error;
          // OpenCode currently implements JSON Schema as a forced tool call.
          // Some thinking modes reject tool_choice=required, so remember the
          // compatible path for all later requests using the same model.
          this.structuredOutputModes.set(input.model, 'prompt-json');
          continuingAfterSchemaFailure = true;
        }
      }
      const output = await this.promptWithValidatedJson<T>(
        client,
        runtime,
        session.id,
        providerID,
        modelID,
        executionInput,
        continuingAfterSchemaFailure,
      );
      return { sessionId: session.id, output };
    })();
    const permissionGuard = permissionWorker.then<StructuredExecutionResult<T>>(() => {
      if (!promptSettled) throw new Error('OpenCode permission monitor stopped before the prompt completed.');
      return new Promise<StructuredExecutionResult<T>>(() => undefined);
    });
    let completed = false;
    try {
      const result = await Promise.race([promptWorker, permissionGuard]);
      completed = true;
      await input.onEvent?.({
        kind: 'status',
        message: 'OpenCode 已返回结构化结果。',
        occurredAt: new Date().toISOString(),
        data: { sessionId: session.id },
      });
      return result;
    } catch (error) {
      await input.onEvent?.({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        occurredAt: new Date().toISOString(),
        data: { sessionId: session.id },
      });
      throw error;
    } finally {
      promptSettled = true;
      if (!completed) abort();
      await Promise.allSettled([permissionWorker]);
      this.activeSessionAborts.delete(activeAbortKey);
      input.abortSignal?.removeEventListener('abort', forwardInputAbort);
      executionAbort.signal.removeEventListener('abort', abort);
    }
  }

  private async promptWithOpenCodeSchema<T>(
    client: SdkClient,
    runtime: ManagedRuntime,
    sessionId: string,
    providerID: string,
    modelID: string,
    input: StructuredExecutionInput,
  ): Promise<T> {
    const data = await this.promptAsyncAndWait<T>(
      client,
      runtime,
      sessionId,
      providerID,
      modelID,
      input.prompt,
      input.abortSignal,
      { type: 'json_schema', schema: input.schema, retryCount: structuredRepairAttempts },
      input.toolMode,
      input,
    );
    throwPromptError(data);
    if (data.info.structured === undefined) throw new Error('OpenCode did not return structured output.');
    return data.info.structured;
  }

  private async promptWithValidatedJson<T>(
    client: SdkClient,
    runtime: ManagedRuntime,
    sessionId: string,
    providerID: string,
    modelID: string,
    input: StructuredExecutionInput,
    continuingAfterSchemaFailure: boolean,
  ): Promise<T> {
    const validator = createStructuredOutputValidator<T>(input.schema);
    let prompt = continuingAfterSchemaFailure
      ? jsonContinuationPrompt(input.schema)
      : jsonProtocolPrompt(input.prompt, input.schema);
    let lastErrors: string[] = [];
    let lastResponse = '';
    for (let attempt = 0; attempt <= structuredRepairAttempts; attempt += 1) {
      const data = await this.promptAsyncAndWait(
        client,
        runtime,
        sessionId,
        providerID,
        modelID,
        prompt,
        input.abortSignal,
        undefined,
        input.toolMode,
        input,
      );
      throwPromptError(data);
      lastResponse = data.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n')
        .trim();
      const result = validator.parseAndValidate(lastResponse);
      if (result.ok) return result.value;
      lastErrors = result.errors;
      if (attempt < structuredRepairAttempts) prompt = jsonRepairPrompt(lastResponse, lastErrors, input.schema);
    }
    throw new Error(`OpenCode JSON output failed local Schema validation after ${structuredRepairAttempts + 1} attempts: ${lastErrors.join('; ')}`);
  }

  private async promptAsyncAndWait<T>(
    client: SdkClient,
    runtime: ManagedRuntime,
    sessionId: string,
    providerID: string,
    modelID: string,
    prompt: string,
    abortSignal?: AbortSignal,
    format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount: number },
    toolMode: 'enabled' | 'disabled' = 'enabled',
    eventInput?: StructuredExecutionInput,
  ): Promise<PromptResult<T>> {
    const existingResponse = await client.session.messages({
      sessionID: sessionId,
      directory: runtime.workspacePath,
    });
    const existingMessageIds = new Set(
      unwrap<Array<PromptResult>>(existingResponse).map((message) => message.info.id).filter((value): value is string => Boolean(value)),
    );
    const tools = toolMode === 'disabled'
      ? await this.disabledToolConfiguration(client, runtime)
      : undefined;
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: runtime.workspacePath,
      model: { providerID, modelID },
      parts: [{ type: 'text', text: prompt }],
      ...(tools ? { tools } : {}),
      ...(format ? { format } : {}),
    });

    let consecutivePollingErrors = 0;
    const emissionState: OpenCodePartEmissionState = {
      textLengths: new Map(),
      toolStatuses: new Map(),
    };
    while (true) {
      if (abortSignal?.aborted) throw abortedSessionError();
      if (runtime.process.exitCode !== null) {
        throw new Error(`OpenCode server exited with code ${runtime.process.exitCode}.`);
      }
      try {
        const response = await client.session.messages({
          sessionID: sessionId,
          directory: runtime.workspacePath,
        });
        const messages = unwrap<Array<PromptResult<T>>>(response);
        if (eventInput) await emitOpenCodeUpdates(eventInput, messages, existingMessageIds, emissionState);
        if (toolMode === 'disabled') {
          const attemptedTool = selectNewToolAttempt(messages, existingMessageIds);
          if (attemptedTool) throw unexpectedToolCallError(attemptedTool);
        }
        const statusResponse = await client.session.status({ directory: runtime.workspacePath });
        const sessionStatuses = unwrap<Record<string, { type: string }>>(statusResponse);
        const completed = selectNewCompletedPromptResult<T>(
          messages,
          existingMessageIds,
          sessionStatuses[sessionId]?.type ?? 'idle',
        );
        consecutivePollingErrors = 0;
        if (completed) return completed;
      } catch (error) {
        if (abortSignal?.aborted) throw abortedSessionError();
        if (error instanceof Error && error.name === 'OpenCodeUnexpectedToolCallError') throw error;
        if (runtime.process.exitCode !== null) {
          throw new Error(`OpenCode server exited with code ${runtime.process.exitCode}.`);
        }
        // A short polling request can race with an OpenCode server refresh,
        // but persistent errors indicate a protocol incompatibility and must
        // become observable instead of spinning until the session timeout.
        consecutivePollingErrors += 1;
        if (consecutivePollingErrors >= 10) throw error;
      }
      await waitForPoll(abortSignal);
    }
  }

  async abortSession(runtime: RuntimeHandle, sessionId: string): Promise<void> {
    const managed = this.getRuntime(runtime.id);
    this.activeSessionAborts.get(`${managed.id}:${sessionId}`)?.abort();
    await this.client(managed).session.abort({ sessionID: sessionId, directory: managed.workspacePath });
  }

  async stopRuntime(runtime: RuntimeHandle): Promise<void> {
    const managed = this.runtimes.get(runtime.id);
    if (!managed) return;
    this.runtimes.delete(runtime.id);
    this.disabledToolsByRuntime.delete(runtime.id);
    for (const [key, controller] of this.activeSessionAborts) {
      if (!key.startsWith(`${runtime.id}:`)) continue;
      controller.abort();
      this.activeSessionAborts.delete(key);
    }
    const client = this.client(managed);
    await Promise.allSettled(managed.sessionIds.map((sessionId) =>
      client.session.abort({ sessionID: sessionId, directory: managed.workspacePath })));
    if (managed.process.exitCode !== null) return;
    signalProcessTree(managed.process, 'SIGTERM');
    const exited = await waitForProcessExit(managed.process, 5_000);
    if (!exited && managed.process.exitCode === null) {
      signalProcessTree(managed.process, 'SIGKILL');
      await waitForProcessExit(managed.process, 2_000);
    }
  }

  private client(runtime: ManagedRuntime): SdkClient {
    const authorization = `Basic ${Buffer.from(`yanxu:${runtime.password}`).toString('base64')}`;
    return createOpencodeClient({
      baseUrl: runtime.endpoint,
      throwOnError: true,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        headers.set('authorization', authorization);
        return fetch(input, { ...init, headers });
      },
    });
  }

  private getRuntime(runtimeId: string): ManagedRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`OpenCode runtime ${runtimeId} is not active.`);
    return runtime;
  }

  private publicHandle(runtime: ManagedRuntime): RuntimeHandle {
    return { id: runtime.id, executor: runtime.executor, workspacePath: runtime.workspacePath, endpoint: runtime.endpoint, sessionIds: runtime.sessionIds };
  }

  private async disabledToolConfiguration(
    client: SdkClient,
    runtime: ManagedRuntime,
  ): Promise<Record<string, boolean>> {
    const cached = this.disabledToolsByRuntime.get(runtime.id);
    if (cached) return cached;
    let discoveredToolIds: string[] = [];
    try {
      const response = await client.tool.ids({ directory: runtime.workspacePath });
      discoveredToolIds = unwrap<string[]>(response);
    } catch {
      // OpenCode releases before the tool-id endpoint still receive a bounded
      // fallback list. Response polling below remains the final fail-closed
      // guard for dynamically registered tools unknown to this adapter.
    }
    const tools = Object.fromEntries(
      [...new Set([...fallbackOpenCodeToolIds, ...discoveredToolIds])]
        .map((toolId) => [toolId, false]),
    );
    this.disabledToolsByRuntime.set(runtime.id, tools);
    return tools;
  }

  private async emitRuntimeCapabilities(
    client: SdkClient,
    runtime: ManagedRuntime,
    input: StructuredExecutionInput,
  ): Promise<void> {
    try {
      const [skillsResponse, mcpResponse] = await Promise.all([
        client.app.skills({ directory: runtime.workspacePath }),
        client.mcp.status({ directory: runtime.workspacePath }),
      ]);
      const skills = unwrap<Array<{ name: string; location: string }>>(skillsResponse)
        .map((skill) => ({ name: skill.name, status: 'loaded', location: skill.location }));
      const statuses = unwrap<Record<string, { status: string; error?: string }>>(mcpResponse);
      const mcps = Object.entries(statuses).map(([name, status]) => ({
        name,
        status: status.status,
        ...(status.error ? { error: status.error.slice(0, 2_000) } : {}),
      }));
      await input.onEvent?.({
        kind: 'status',
        message: `OpenCode 运行时已加载 ${skills.length} 个 Skill，检测到 ${mcps.length} 个 MCP。`,
        occurredAt: new Date().toISOString(),
        data: { capabilityRuntime: { skills, mcps } },
      });
    } catch (error) {
      await input.onEvent?.({
        kind: 'status',
        message: 'OpenCode 已启动，但运行时能力状态读取失败。',
        occurredAt: new Date().toISOString(),
        data: {
          capabilityRuntimeError: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        },
      });
    }
  }

  private async waitForHealth(runtime: ManagedRuntime): Promise<void> {
    const client = this.client(runtime);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      if (runtime.process.exitCode !== null) throw new Error(`OpenCode server exited with code ${runtime.process.exitCode}.`);
      try {
        await client.global.health();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    signalProcessTree(runtime.process, 'SIGTERM');
    throw new Error('Timed out waiting for OpenCode server health check.');
  }

  private async processPermissions(
    client: SdkClient,
    runtime: ManagedRuntime,
    sessionId: string,
    input: StructuredExecutionInput,
    settled: () => boolean,
  ): Promise<void> {
    const handled = new Set<string>();
    let consecutivePollingErrors = 0;
    while (!settled()) {
      try {
        const response = await client.permission.list({ directory: runtime.workspacePath });
        const requests = unwrap<PermissionRequest[]>(response);
        for (const request of requests) {
          if (request.sessionID !== sessionId || handled.has(request.id)) continue;
          handled.add(request.id);
          const decision = input.onPermission
            ? await input.onPermission({
              id: request.id,
              sessionId: request.sessionID,
              permission: request.permission,
              patterns: request.patterns,
              metadata: request.metadata,
            })
            : 'reject';
          await client.permission.reply({
            requestID: request.id,
            directory: runtime.workspacePath,
            reply: decision,
          });
        }
        consecutivePollingErrors = 0;
      } catch (error) {
        if (settled()) return;
        consecutivePollingErrors += 1;
        const failure = permissionPollingFailure(error, consecutivePollingErrors);
        if (failure) throw failure;
      }
      if (!settled()) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

async function emitOpenCodeUpdates(
  input: StructuredExecutionInput,
  messages: PromptResult[],
  existingMessageIds: ReadonlySet<string>,
  state: OpenCodePartEmissionState,
): Promise<void> {
  if (!input.onEvent) return;
  for (const message of messages) {
    const messageId = message.info.id;
    if (message.info.role !== 'assistant' || !messageId || existingMessageIds.has(messageId)) continue;
    for (const [partIndex, part] of message.parts.entries()) {
      const key = `${messageId}:${part.id ?? partIndex}`;
      if ((part.type === 'text' || /reason|thinking/i.test(part.type)) && part.text) {
        const previousLength = state.textLengths.get(key) ?? 0;
        const start = part.text.length >= previousLength ? previousLength : 0;
        const delta = part.text.slice(start);
        state.textLengths.set(key, part.text.length);
        if (delta) {
          await input.onEvent({
            kind: part.type === 'text' ? 'text' : 'thinking',
            message: delta.slice(0, 2_000),
            occurredAt: new Date().toISOString(),
            data: { messageId, partId: part.id ?? null },
          });
        }
      } else if (part.tool) {
        const status = part.state?.status ?? part.type;
        if (state.toolStatuses.get(key) === status) continue;
        state.toolStatuses.set(key, status);
        const completed = /completed|success|failed|error/i.test(status);
        await input.onEvent({
          kind: completed ? 'tool_result' : 'tool_call',
          message: `${part.tool} · ${status}`,
          occurredAt: new Date().toISOString(),
          data: {
            tool: part.tool,
            status,
            partType: part.type,
            messageId,
            partId: part.id ?? null,
            input: boundedOpenCodeEventData(part.state?.input),
            output: boundedOpenCodeEventData(part.state?.output),
            error: boundedOpenCodeEventData(part.state?.error),
          },
        });
      }
    }
  }
}

function boundedOpenCodeEventData(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized.length <= 2_000 ? value : `${serialized.slice(0, 2_000)}…`;
}

export function permissionPollingFailure(
  error: unknown,
  consecutiveErrors: number,
  limit = permissionPollingFailureLimit,
): Error | null {
  if (consecutiveErrors < limit) return null;
  const cause = error instanceof Error ? error.message : String(error);
  const failure = new Error(
    `OpenCode permission polling failed ${consecutiveErrors} consecutive times: ${cause}`,
  );
  failure.name = 'OpenCodePermissionPollingError';
  return failure;
}

function unwrap<T>(response: unknown): T {
  if (response && typeof response === 'object' && 'data' in response) return (response as { data: T }).data;
  return response as T;
}

function throwPromptError(result: PromptResult): void {
  if (!result.info.error) return;
  const name = result.info.error.name ?? 'OpenCodePromptError';
  const message = result.info.error.data?.message ?? 'OpenCode prompt failed.';
  const error = new Error(message);
  error.name = name;
  throw error;
}

export function selectNewCompletedPromptResult<T>(
  messages: Array<PromptResult<T>>,
  existingMessageIds: ReadonlySet<string>,
  sessionStatus = 'idle',
): PromptResult<T> | undefined {
  // A single OpenCode prompt may produce several completed assistant messages
  // while it runs tools. Only the last one after the session becomes idle is
  // the final response; treating an intermediate tool-loop message as final
  // would send a JSON repair prompt before the agent has finished its work.
  if (sessionStatus !== 'idle') return undefined;
  const candidates = messages.filter((message) =>
    message.info.role === 'assistant'
    && Boolean(message.info.id)
    && !existingMessageIds.has(message.info.id as string)
    && (message.info.time?.completed !== undefined || message.info.error !== undefined));
  return candidates.reduce<PromptResult<T> | undefined>((latest, message) => {
    if (!latest) return message;
    const latestTime = latest.info.time?.completed ?? latest.info.time?.created ?? Number.NEGATIVE_INFINITY;
    const messageTime = message.info.time?.completed ?? message.info.time?.created ?? Number.NEGATIVE_INFINITY;
    return messageTime > latestTime ? message : latest;
  }, undefined);
}

export interface OpenCodeToolAttempt {
  messageId: string;
  tool: string;
  status: string;
}

export function selectNewToolAttempt(
  messages: Array<PromptResult>,
  existingMessageIds: ReadonlySet<string>,
): OpenCodeToolAttempt | undefined {
  for (const message of messages) {
    const messageId = message.info.id;
    if (message.info.role !== 'assistant' || !messageId || existingMessageIds.has(messageId)) continue;
    const toolPart = message.parts.find((part) => part.type === 'tool');
    if (!toolPart) continue;
    return {
      messageId,
      tool: toolPart.tool ?? 'unknown',
      status: toolPart.state?.status ?? 'unknown',
    };
  }
  return undefined;
}

function unexpectedToolCallError(attempt: OpenCodeToolAttempt): Error {
  const error = new Error(
    `OpenCode attempted disabled tool "${attempt.tool}" (status: ${attempt.status}).`,
  );
  error.name = 'OpenCodeUnexpectedToolCallError';
  return error;
}

function abortedSessionError(): Error {
  const error = new Error('OpenCode session was aborted.');
  error.name = 'AbortError';
  return error;
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedSessionError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, 500);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortedSessionError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jsonProtocolPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\n【研序 JSON 输出协议】\n保留并完成上面的全部工作。最终响应只能包含一个符合下方 JSON Schema 的 JSON 对象，不要使用 Markdown 代码块，不要添加解释文字。\n${JSON.stringify(schema, null, 2)}`;
}

function jsonContinuationPrompt(schema: Record<string, unknown>): string {
  return `OpenCode 的结构化输出通道未能提交结果。继续当前会话中的原任务，不要重复已经完成的工作；如仍有未完成部分则完成它。最终响应只能包含一个符合下方 JSON Schema 的 JSON 对象，不要使用 Markdown 代码块，不要添加解释文字。\n${JSON.stringify(schema, null, 2)}`;
}

function jsonRepairPrompt(previousResponse: string, errors: string[], schema: Record<string, unknown>): string {
  const boundedResponse = previousResponse.slice(-20_000);
  return `你上一次的最终响应没有通过研序的本地 JSON Schema 校验。不要重新执行任务，不要调用工具；只根据本会话已经完成的工作修正最终 JSON。响应只能包含 JSON 对象。\n\n校验错误：\n${errors.map((error) => `- ${error}`).join('\n')}\n\nJSON Schema：\n${JSON.stringify(schema, null, 2)}\n\n上一次响应：\n${boundedResponse}`;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function permissionRules(
  mode: 'standard' | 'managed',
  readOnly: boolean,
  policy?: RuntimePermissionPolicy,
): PermissionRuleset {
  const rules: PermissionRuleset = [
    { permission: '*', pattern: '*', action: mode === 'managed' ? 'deny' : 'ask' },
  ];
  const allowedReadPatterns = policy?.allowedReadPatterns ?? [];
  for (const pattern of allowedReadPatterns) {
    rules.push({ permission: 'read', pattern, action: 'allow' });
  }
  for (const pattern of policy?.allowedExternalDirectoryPatterns ?? []) {
    rules.push({ permission: 'external_directory', pattern, action: 'allow' });
  }
  if (allowedReadPatterns.length > 0) {
    // OpenCode evaluates glob/grep by the search expression (for example `*`),
    // not by the resolved file path. External paths still require the separate
    // external_directory permission, while actual file reads remain restricted
    // by the path-scoped read rules above.
    rules.push(
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'list', pattern: '*', action: 'allow' },
    );
  }
  if (!readOnly) {
    for (const pattern of policy?.allowedEditPatterns ?? []) {
      // These paths come from the confirmed Task Run Snapshot and are the
      // executable form of the user's approved plan, so they do not require a
      // second runtime confirmation in standard mode.
      rules.push({ permission: 'edit', pattern, action: 'allow' });
    }
  }
  for (const pattern of policy?.allowedBashPatterns ?? []) {
    // Only commands frozen in the confirmed quality/step policy arrive here.
    // Commands outside this allowlist still match the leading ask rule.
    rules.push({ permission: 'bash', pattern, action: 'allow' });
  }
  if (policy?.denyUnlistedSkills) {
    rules.push({ permission: 'skill', pattern: '*', action: 'deny' });
  }
  for (const pattern of policy?.allowedSkillPatterns ?? []) {
    rules.push({ permission: 'skill', pattern, action: 'allow' });
  }
  for (const pattern of policy?.deniedMcpToolPatterns ?? []) {
    rules.push({ permission: pattern, pattern: '*', action: 'deny' });
  }
  for (const pattern of policy?.allowedMcpToolPatterns ?? []) {
    rules.push({ permission: pattern, pattern: '*', action: 'allow' });
  }
  for (const grant of policy?.taskGrants ?? []) {
    if (readOnly && (grant.permission === 'edit' || grant.permission === 'bash')) continue;
    for (const pattern of grant.patterns) {
      rules.push({ permission: grant.permission, pattern, action: 'allow' });
    }
  }
  // OpenCode applies the last matching rule, so immutable safety denials must
  // remain after role, task-grant and read-only convenience rules.
  rules.push(
    ...(readOnly ? [{ permission: 'edit' as const, pattern: '*', action: 'deny' as const }] : []),
    { permission: 'task', pattern: '*', action: 'deny' },
    { permission: 'read', pattern: '*.env', action: 'deny' },
    { permission: 'read', pattern: '*.env.*', action: 'deny' },
    { permission: 'read', pattern: '*.pem', action: 'deny' },
    { permission: 'read', pattern: '*.key', action: 'deny' },
    ...(policy?.forbiddenReadPatterns ?? []).map((pattern) => ({
      permission: 'read' as const,
      pattern,
      action: 'deny' as const,
    })),
    { permission: 'bash', pattern: 'git push*', action: 'deny' },
    { permission: 'bash', pattern: 'git remote *', action: 'deny' },
    { permission: 'bash', pattern: 'git config *remote*', action: 'deny' },
    { permission: 'bash', pattern: 'rm -rf *', action: 'deny' },
    { permission: 'bash', pattern: 'sudo *', action: 'deny' },
    { permission: 'bash', pattern: 'env*', action: 'deny' },
    { permission: 'bash', pattern: 'printenv*', action: 'deny' },
    { permission: 'bash', pattern: 'set', action: 'deny' },
    { permission: 'bash', pattern: 'export*', action: 'deny' },
    { permission: 'bash', pattern: '* .env*', action: 'deny' },
    { permission: 'bash', pattern: '* *.pem*', action: 'deny' },
    { permission: 'bash', pattern: '* *.key*', action: 'deny' },
    ...(policy?.networkPolicy === 'deny' ? [
      { permission: 'web*' as const, pattern: '*', action: 'deny' as const },
      { permission: 'webfetch' as const, pattern: '*', action: 'deny' as const },
      { permission: 'websearch' as const, pattern: '*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'curl *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'wget *', action: 'deny' as const },
    ] : []),
    ...(policy?.dependencyInstallPolicy === 'deny' ? [
      { permission: 'bash' as const, pattern: 'npm install*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm i', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm i *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm ci*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm --prefix * install*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm --prefix * i', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm --prefix * i *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm --prefix * ci*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'cd * && npm install*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'cd * && npm i', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'cd * && npm i *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'cd * && npm ci*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'pnpm install*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'pnpm add *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'yarn add *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'pip install *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'pip3 install *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'brew install *', action: 'deny' as const },
    ] : []),
  );
  return rules;
}

function waitForProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const complete = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => complete(true);
    const timer = setTimeout(() => complete(false), timeoutMs);
    process.once('exit', onExit);
  });
}
