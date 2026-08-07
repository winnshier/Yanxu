import { spawn } from 'node:child_process';
import type { ExecutorInstallation, ExecutorType } from '@yanxu/contracts';

const definitions: Array<{ id: ExecutorType; name: string; command: string; capabilities: string[] }> = [
  { id: 'opencode', name: 'OpenCode', command: 'opencode', capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'] },
  { id: 'claude', name: 'Claude Code', command: 'claude', capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'] },
  { id: 'codex', name: 'Codex CLI', command: 'codex', capabilities: [] },
];

function run(command: string, args: string[], timeout = 12_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function executablePath(command: string): Promise<string | null> {
  const result = await run('/usr/bin/which', [command], 3_000);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function probeOne(definition: (typeof definitions)[number]): Promise<ExecutorInstallation> {
  const checkedAt = new Date().toISOString();
  const path = await executablePath(definition.command);
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
