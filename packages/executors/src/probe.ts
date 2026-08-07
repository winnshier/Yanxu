import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorInstallation, ExecutorType } from '@yanxu/contracts';

const definitions: Array<{ id: ExecutorType; name: string; command: string; capabilities: string[] }> = [
  { id: 'opencode', name: 'OpenCode', command: 'opencode', capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'] },
  { id: 'claude', name: 'Claude Code', command: 'claude', capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'] },
  { id: 'codex', name: 'Codex CLI', command: 'codex', capabilities: [] },
];

interface ExecutableResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
  shell?: string | null;
  useLoginShell?: boolean;
}

function run(
  command: string,
  args: string[],
  timeout = 12_000,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function resolveExecutablePath(
  command: string,
  options: ExecutableResolutionOptions = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(command)) return null;
  const environment = options.environment ?? process.env;
  const result = await run('/usr/bin/which', [command], 3_000, environment);
  const currentPath = executableFromOutput(result.stdout);
  if (result.code === 0 && currentPath && isExecutable(currentPath)) return currentPath;

  const userHome = options.userHome ?? homedir();
  for (const candidate of commonExecutablePaths(command, userHome)) {
    if (isExecutable(candidate)) return candidate;
  }

  if (options.useLoginShell !== false) {
    const shell = options.shell === undefined ? environment.SHELL : options.shell;
    if (shell && isExecutable(shell)) {
      const shellResult = await run(shell, ['-lic', `command -v -- ${command}`], 5_000, environment);
      const shellPath = executableFromOutput(shellResult.stdout);
      if (shellResult.code === 0 && shellPath && isExecutable(shellPath)) return shellPath;
    }
  }
  return null;
}

async function probeOne(definition: (typeof definitions)[number]): Promise<ExecutorInstallation> {
  const checkedAt = new Date().toISOString();
  const path = await resolveExecutablePath(definition.command);
  if (!path) {
    return { ...definition, path: null, version: null, health: 'unavailable', models: [], lastCheckedAt: checkedAt, error: '未找到可执行文件。' };
  }
  const versionResult = await run(path, ['--version']);
  const version = (versionResult.stdout || versionResult.stderr).trim().split('\n')[0] || null;
  if (versionResult.code !== 0) {
    return { ...definition, path, version, health: 'unavailable', models: [], lastCheckedAt: checkedAt, error: versionResult.stderr.trim() || '版本检测失败。' };
  }
  let models: string[] = [];
  if (definition.id === 'opencode') {
    const modelResult = await run(path, ['models'], 20_000);
    if (modelResult.code === 0) {
      models = modelResult.stdout.split('\n').map((item) => item.trim()).filter((item) => item.includes('/'));
    }
  }
  if (definition.id === 'claude') {
    // Claude Code accepts aliases and full model identifiers. Keep aliases
    // available even though the CLI intentionally has no provider model list command.
    models = ['sonnet', 'opus', 'haiku'];
  }
  return { ...definition, path, version, health: 'available', models: [...new Set(models)].sort(), lastCheckedAt: checkedAt, error: null };
}

export async function probeExecutors(): Promise<ExecutorInstallation[]> {
  return Promise.all(definitions.map(probeOne));
}

function commonExecutablePaths(command: string, userHome: string): string[] {
  const candidates = [
    join(userHome, '.local', 'bin', command),
    join(userHome, '.npm-global', 'bin', command),
    join(userHome, '.volta', 'bin', command),
    join(userHome, '.bun', 'bin', command),
    join(userHome, '.claude', 'local', command),
    join('/opt/homebrew/bin', command),
    join('/usr/local/bin', command),
  ];
  const nvmRoot = join(userHome, '.nvm', 'versions', 'node');
  try {
    const nvmCandidates = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(nvmRoot, entry.name, 'bin', command))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    candidates.push(...nvmCandidates);
  } catch {
    // NVM is optional.
  }
  return [...new Set(candidates)];
}

function executableFromOutput(output: string): string | null {
  return output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('/')) ?? null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
