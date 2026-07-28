import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { QualityGate } from '@yanxu/contracts';
import type { PreparedWorkspace } from '@yanxu/core';

export interface QualityGateResult {
  id: string;
  directoryId: string;
  command: string;
  status: 'passed' | 'failed';
  exitCode: number;
  logPath: string;
  startedAt: string;
  completedAt: string;
  attempt: number;
  commandArgv: string[];
  signal: string | null;
  timedOut: boolean;
}

export async function runQualityGates(
  taskId: string,
  gates: QualityGate[],
  workspaces: PreparedWorkspace[],
  workbenchHome: string,
  attempt: number,
  abortSignal?: AbortSignal,
): Promise<QualityGateResult[]> {
  const results: QualityGateResult[] = [];
  for (const gate of gates.filter((item) => item.required && item.status !== 'waived')) {
    if (abortSignal?.aborted) break;
    const workspace = workspaces.find((item) => item.directoryId === gate.directoryId);
    if (!workspace) throw new Error(`Workspace for gate ${gate.id} is missing.`);
    results.push(await runGate(taskId, gate, workspace, workbenchHome, attempt, abortSignal));
  }
  return results;
}

function runGate(
  taskId: string,
  gate: QualityGate,
  workspace: PreparedWorkspace,
  workbenchHome: string,
  attempt: number,
  abortSignal?: AbortSignal,
): Promise<QualityGateResult> {
  const commandArgv = gate.commandArgv?.length ? gate.commandArgv : parseCommandArgv(gate.command);
  const [command, ...args] = commandArgv;
  if (!command) throw new Error(`Gate ${gate.id} has an empty command.`);
  const logDirectory = join(workbenchHome, 'runtime', 'tasks', taskId, 'gates');
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `${gate.id}-attempt-${attempt}.log`);
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const child = spawn(command, args, {
      cwd: workspace.scopePath,
      env: gateEnvironment(gate.envAllowlist),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    let aborted = false;
    const abort = () => {
      aborted = true;
      log.write('\n[yanxu] Quality gate aborted by task control.\n');
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, gate.timeoutMs ?? 10 * 60_000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', abort);
      log.write(`\n[yanxu] ${error.message}\n`);
      log.end();
      resolve({
        id: gate.id,
        directoryId: gate.directoryId,
        command: gate.command,
        status: 'failed',
        exitCode: 127,
        logPath,
        startedAt,
        completedAt: new Date().toISOString(),
        attempt,
        commandArgv,
        signal: null,
        timedOut: false,
      });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', abort);
      if (timedOut) log.write(`\n[yanxu] Quality gate timed out after ${gate.timeoutMs ?? 10 * 60_000} ms.\n`);
      log.end();
      const exitCode = timedOut ? 124 : aborted ? 130 : code ?? 1;
      const passed = !timedOut && !aborted && (gate.expectedExitCodes ?? [0]).includes(exitCode);
      resolve({
        id: gate.id,
        directoryId: gate.directoryId,
        command: gate.command,
        status: passed ? 'passed' : 'failed',
        exitCode,
        logPath,
        startedAt,
        completedAt: new Date().toISOString(),
        attempt,
        commandArgv,
        signal,
        timedOut,
      });
    });
  });
}

export function parseCommandArgv(input: string): string[] {
  const argv: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;
  for (const character of input.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if ('|&;<>`$'.includes(character)) {
      throw new Error('Quality gate commands must be executable argv, not shell expressions.');
    }
    token += character;
    tokenStarted = true;
  }
  if (quote || escaping) throw new Error('Quality gate command contains an unfinished quote or escape.');
  if (tokenStarted) argv.push(token);
  return argv;
}

function gateEnvironment(allowlist: string[] = []): NodeJS.ProcessEnv {
  const names = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL',
    ...allowlist,
  ]);
  const environment: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
