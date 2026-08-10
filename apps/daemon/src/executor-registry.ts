import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorInstallation, ExecutorRuntimeValidation, ExecutorType } from '@yanxu/contracts';
import { ClaudeCodeAdapter, OpenCodeAdapter, probeExecutors, type ExecutorAdapter } from '@yanxu/executors';

export class ExecutorRegistry {
  private installations: ExecutorInstallation[];
  private probePromise: Promise<ExecutorInstallation[]> | null = null;
  private readonly adapters = new Map<ExecutorType, ExecutorAdapter>();
  private readonly adapterOverrides = new Set<ExecutorType>();

  constructor(
    initialInstallations: ExecutorInstallation[] = [
    { id: 'opencode', name: 'OpenCode', command: 'opencode', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    { id: 'claude', name: 'Claude Code', command: 'claude', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    { id: 'codex', name: 'Codex CLI', command: 'codex', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    ],
    private readonly probeExecutorsFn: typeof probeExecutors = probeExecutors,
    adapterOverrides: Partial<Record<ExecutorType, ExecutorAdapter>> = {},
  ) {
    this.installations = initialInstallations;
    for (const [executor, adapter] of Object.entries(adapterOverrides)) {
      if (adapter) {
        this.adapters.set(executor as ExecutorType, adapter);
        this.adapterOverrides.add(executor as ExecutorType);
      }
    }
  }

  list(): ExecutorInstallation[] {
    return this.installations;
  }

  get(executor: ExecutorType): ExecutorInstallation | undefined {
    return this.installations.find((item) => item.id === executor);
  }

  async probe(): Promise<ExecutorInstallation[]> {
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.probeExecutorsFn()
      .then((installations) => {
        for (const installation of installations) {
          const previous = this.get(installation.id);
          if (!this.adapterOverrides.has(installation.id)
            && previous
            && (previous.path !== installation.path || previous.version !== installation.version)) {
            this.adapters.delete(installation.id);
          }
        }
        this.installations = installations;
        return this.installations;
      })
      .finally(() => {
        this.probePromise = null;
      });
    return this.probePromise;
  }

  async ensureAvailable(executor: ExecutorType): Promise<ExecutorInstallation> {
    let installation = this.get(executor);
    const checkedAt = installation?.lastCheckedAt ? Date.parse(installation.lastCheckedAt) : Number.NaN;
    const checkedRecently = Number.isFinite(checkedAt) && Date.now() - checkedAt < 15_000;
    if (!installation || installation.health === 'unchecked' || !checkedRecently) {
      await this.probe();
      installation = this.get(executor);
    }
    if (!installation || installation.health !== 'available' || !installation.path) {
      throw new Error(installation?.error ?? `${installation?.name ?? executor} CLI is unavailable.`);
    }
    return installation;
  }

  async adapter(executor: ExecutorType): Promise<ExecutorAdapter> {
    const installation = await this.ensureAvailable(executor);
    const existing = this.adapters.get(executor);
    if (existing) return existing;
    const adapter = executor === 'opencode'
      ? new OpenCodeAdapter(installation)
      : executor === 'claude'
        ? new ClaudeCodeAdapter(installation)
        : null;
    if (!adapter) throw new Error(`${installation.name} 尚未接入执行适配器。`);
    this.adapters.set(executor, adapter);
    return adapter;
  }

  async validateRuntime(executor: ExecutorType, workbenchHome: string): Promise<ExecutorRuntimeValidation> {
    const checkedAt = new Date().toISOString();
    if (executor === 'codex') {
      return {
        executor,
        status: 'failed',
        message: 'Codex CLI 尚未接入运行时验证。',
        version: this.get(executor)?.version ?? null,
        capabilities: this.get(executor)?.capabilities ?? [],
        models: this.get(executor)?.models ?? [],
        loginStatus: 'not_applicable',
        checkedAt,
      };
    }
    const installation = this.get(executor);
    if (!installation || installation.health !== 'available' || !installation.path) {
      return {
        executor,
        status: 'failed',
        message: `${installation?.name ?? executor} CLI 当前不可用，请先重新检测。`,
        version: installation?.version ?? null,
        capabilities: installation?.capabilities ?? [],
        models: installation?.models ?? [],
        loginStatus: 'unknown',
        checkedAt,
      };
    }
    const workspacePath = join(workbenchHome, 'runtime', 'executor-validation', executor, 'workspace');
    const runtimePath = join(workbenchHome, 'runtime', 'executor-validation', executor, 'runtime');
    mkdirSync(workspacePath, { recursive: true });
    const adapter = await this.adapter(executor);
    let runtime: Awaited<ReturnType<ExecutorAdapter['startRuntime']>> | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const model = installation.models[0];
      if (!model) throw new Error(`${installation.name} 未检测到可用于真实调用的模型。`);
      runtime = await adapter.startRuntime(workspacePath, runtimePath);
      const result = await adapter.executeStructured<{ ok: boolean }>({
        runtime,
        title: '研序 CLI 运行时验证',
        prompt: '这是一次只读连通性验证。不要调用工具，只返回 ok=true。',
        model,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
        abortSignal: controller.signal,
        toolMode: 'disabled',
        readOnly: true,
      });
      if (!result.output.ok) throw new Error(`${installation.name} 返回了无效的验证结果。`);
      return {
        executor,
        status: 'passed',
        message: `${installation.name} ${installation.version ?? ''} 已完成真实模型调用、结构化输出校验与终止验证。`.trim(),
        version: installation.version,
        capabilities: installation.capabilities,
        models: installation.models,
        loginStatus: 'configured',
        checkedAt,
      };
    } catch (error) {
      return {
        executor,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        version: installation.version,
        capabilities: installation.capabilities,
        models: installation.models,
        loginStatus: executor === 'opencode' && installation.models.length > 0 ? 'configured' : 'unknown',
        checkedAt,
      };
    } finally {
      clearTimeout(timeout);
      if (runtime) await adapter.stopRuntime(runtime).catch(() => undefined);
    }
  }
}
