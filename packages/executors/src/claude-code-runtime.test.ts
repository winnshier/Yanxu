import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { ClaudeCodeAdapter } from './claude-code-runtime.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ClaudeCodeAdapter', () => {
  it('uses a resumable CLI session and validates Claude structured output', async () => {
    const fixture = createFakeClaude();
    const adapter = new ClaudeCodeAdapter(fixture.installation);
    const runtime = await adapter.startRuntime(fixture.workspace, fixture.runtime, {
      environment: { YANXU_TEST_CREDENTIAL: 'runtime-secret' },
    });
    let sessionId = '';
    const result = await adapter.executeStructured<{ summary: string }>({
      runtime,
      title: 'test work unit',
      prompt: 'return a result',
      model: 'sonnet',
      schema: {
        type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
      },
      permissionMode: 'managed',
      policy: {
        allowedReadPatterns: [`${fixture.workspace}/**`],
        allowedEditPatterns: [`${fixture.workspace}/**`],
        allowedBashPatterns: ['git status*'],
        allowedSkillPatterns: ['review'],
        allowedMcpToolPatterns: ['github_*'],
        taskGrants: [], forbiddenReadPatterns: ['**/.env'], networkPolicy: 'deny', dependencyInstallPolicy: 'deny',
      },
      onSessionStarted: (value) => { sessionId = value; },
    });
    expect(result.output).toEqual({ summary: 'credential-present' });
    expect(result.sessionId).toBe(sessionId);
    const settings = JSON.parse(readFileSync(join(fixture.runtime, `claude-settings-${sessionId}.json`), 'utf8')) as {
      permissions: { defaultMode: string; allow: string[]; deny: string[] };
    };
    expect(settings.permissions.defaultMode).toBe('dontAsk');
    expect(settings.permissions.allow).toContain('Bash(git status*)');
    expect(settings.permissions.allow).toContain('Skill(review)');
    expect(settings.permissions.deny).toContain('WebFetch');
    expect(readFileSync(join(fixture.runtime, 'runtime.log'), 'utf8')).not.toContain('runtime-secret');
    expect(readFileSync(join(fixture.runtime, 'capability-config', '.mcp.json'), 'utf8')).not.toContain('runtime-secret');
    await adapter.stopRuntime(runtime);
  });

  it('terminates the active Claude process when the task is aborted', async () => {
    const fixture = createFakeClaude();
    const adapter = new ClaudeCodeAdapter(fixture.installation);
    const runtime = await adapter.startRuntime(fixture.workspace, fixture.runtime);
    const controller = new AbortController();
    const execution = adapter.executeStructured({
      runtime,
      title: 'abort test',
      prompt: 'WAIT',
      model: 'sonnet',
      schema: { type: 'object' },
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    await adapter.stopRuntime(runtime);
  });
});

function createFakeClaude(): { installation: ExecutorInstallation; workspace: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), 'yanxu-claude-adapter-'));
  roots.push(root);
  const executable = join(root, 'claude');
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sessionId = value('--resume') || value('--session-id');
const finish = () => process.stdout.write(JSON.stringify({
  session_id: sessionId,
  is_error: false,
  structured_output: { summary: process.env.YANXU_TEST_CREDENTIAL === 'runtime-secret' ? 'credential-present' : 'ok' }
}));
if (args.at(-1) === 'WAIT') setTimeout(finish, 5000); else finish();
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const workspace = join(root, 'workspace');
  const runtime = join(root, 'runtime');
  mkdirSync(workspace, { recursive: true });
  return {
    installation: {
      id: 'claude', name: 'Claude Code', command: 'claude', path: executable, version: 'test',
      health: 'available', capabilities: ['sessions', 'structured-output', 'permissions', 'abort'],
      models: ['sonnet'], lastCheckedAt: new Date().toISOString(), error: null,
    },
    workspace,
    runtime,
  };
}
