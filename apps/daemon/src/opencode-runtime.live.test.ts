import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { OpenCodeAdapter } from '@yanxu/executors';
import { ExecutorRegistry } from './executor-registry.js';

const roots: string[] = [];
const enabled = process.env.YANXU_LIVE_OPENCODE === '1';
const liveModel = process.env.YANXU_LIVE_OPENCODE_MODEL;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode live runtime adapter', () => {
  it.runIf(enabled)('starts a real local serve runtime, verifies SDK health, and stops it', async () => {
    const executable = spawnSync('/usr/bin/which', ['opencode'], { encoding: 'utf8' }).stdout.trim();
    if (!executable) throw new Error('YANXU_LIVE_OPENCODE=1 requires the opencode CLI.');
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim();
    const installation: ExecutorInstallation = {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      path: executable,
      version,
      health: 'available',
      capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'],
      models: [],
      lastCheckedAt: new Date().toISOString(),
      error: null,
    };
    const root = mkdtempSync(join(tmpdir(), 'yanxu-live-opencode-'));
    roots.push(root);
    const registry = new ExecutorRegistry([installation]);

    const result = await registry.validateRuntime('opencode', root);

    expect(result).toMatchObject({ executor: 'opencode', status: 'passed' });
  }, 30_000);

  it.runIf(enabled && Boolean(liveModel))('creates a real isolated session and returns JSON Schema structured output', async () => {
    const executable = spawnSync('/usr/bin/which', ['opencode'], { encoding: 'utf8' }).stdout.trim();
    if (!executable) throw new Error('YANXU_LIVE_OPENCODE=1 requires the opencode CLI.');
    const model = liveModel as string;
    const installation: ExecutorInstallation = {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      path: executable,
      version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(),
      health: 'available',
      capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'],
      models: [model],
      lastCheckedAt: new Date().toISOString(),
      error: null,
    };
    const root = mkdtempSync(join(tmpdir(), 'yanxu-live-opencode-structured-'));
    roots.push(root);
    const adapter = new OpenCodeAdapter(installation);
    const runtime = await adapter.startRuntime(root, join(root, 'runtime'));
    try {
      const result = await adapter.executeStructured<{ ok: boolean; evidence: string }>({
        runtime,
        title: 'Yanxu live structured contract',
        model,
        prompt: '只返回符合 Schema 的结果：ok 必须为 true；evidence 简短说明这是结构化合约测试。不要调用任何工具。',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['ok', 'evidence'],
        },
        permissionMode: 'managed',
        readOnly: true,
        policy: {
          allowedReadPatterns: [],
          allowedEditPatterns: [],
          allowedBashPatterns: [],
          taskGrants: [],
          forbiddenReadPatterns: ['*'],
        },
      });
      expect(result.output.ok).toBe(true);
      expect(result.output.evidence.length).toBeGreaterThan(0);
      expect(result.sessionId).toBe(runtime.sessionIds[0]);
    } finally {
      await adapter.stopRuntime(runtime);
    }
  }, 120_000);

  it.runIf(enabled)('creates a real session and aborts it through the SDK without requiring model output', async () => {
    const executable = spawnSync('/usr/bin/which', ['opencode'], { encoding: 'utf8' }).stdout.trim();
    if (!executable) throw new Error('YANXU_LIVE_OPENCODE=1 requires the opencode CLI.');
    const installation: ExecutorInstallation = {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      path: executable,
      version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(),
      health: 'available',
      capabilities: ['sessions', 'structured-output', 'permissions', 'abort', 'events'],
      models: [],
      lastCheckedAt: new Date().toISOString(),
      error: null,
    };
    const root = mkdtempSync(join(tmpdir(), 'yanxu-live-opencode-abort-'));
    roots.push(root);
    const adapter = new OpenCodeAdapter(installation);
    const runtime = await adapter.startRuntime(root, join(root, 'runtime'));
    try {
      const execution = adapter.executeStructured<{ ok: boolean }>({
        runtime,
        title: 'Yanxu live abort contract',
        model: 'opencode/yanxu-invalid-model-for-abort',
        prompt: 'This request exists only to create a real session before abort.',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        permissionMode: 'managed',
        readOnly: true,
        policy: {
          allowedReadPatterns: [],
          allowedEditPatterns: [],
          allowedBashPatterns: [],
          taskGrants: [],
          forbiddenReadPatterns: ['*'],
        },
      }).then(
        () => new Error('Invalid model unexpectedly returned output.'),
        (error: unknown) => error,
      );
      const startedAt = Date.now();
      while (runtime.sessionIds.length === 0 && Date.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const sessionId = runtime.sessionIds[0];
      expect(sessionId).toBeTruthy();
      await adapter.abortSession(runtime, sessionId as string);
      expect(await execution).toBeInstanceOf(Error);
    } finally {
      await adapter.stopRuntime(runtime);
    }
  }, 30_000);
});
