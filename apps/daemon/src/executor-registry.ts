import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorInstallation, ExecutorRuntimeValidation, ExecutorType } from '@yanxu/contracts';
import { OpenCodeAdapter, probeExecutors } from '@yanxu/executors';

export class ExecutorRegistry {
  private installations: ExecutorInstallation[];

  constructor(
    initialInstallations: ExecutorInstallation[] = [
    { id: 'opencode', name: 'OpenCode', command: 'opencode', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    { id: 'claude', name: 'Claude Code', command: 'claude', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    { id: 'codex', name: 'Codex CLI', command: 'codex', path: null, version: null, health: 'unchecked', capabilities: [], models: [], lastCheckedAt: null, error: null },
    ],
    private readonly probeExecutorsFn: typeof probeExecutors = probeExecutors,
  ) {
    this.installations = initialInstallations;
  }

  list(): ExecutorInstallation[] {
    return this.installations;
  }

  get(executor: ExecutorType): ExecutorInstallation | undefined {
    return this.installations.find((item) => item.id === executor);
  }

  async probe(): Promise<ExecutorInstallation[]> {
    this.installations = await this.probeExecutorsFn();
    return this.installations;
  }

  async validateRuntime(executor: ExecutorType, workbenchHome: string): Promise<ExecutorRuntimeValidation> {
    const checkedAt = new Date().toISOString();
    if (executor !== 'opencode') {
      return {
        executor,
        status: 'failed',
        message: '该执行器尚未接入运行时验证。',
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
        message: 'OpenCode CLI 当前不可用，请先重新检测。',
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
    const adapter = new OpenCodeAdapter(installation);
    try {
      const runtime = await adapter.startRuntime(workspacePath, runtimePath);
      await adapter.stopRuntime(runtime);
      return {
        executor,
        status: 'passed',
        message: `OpenCode ${installation.version ?? ''} 的 serve、SDK health 与终止流程均可用。`.trim(),
        version: installation.version,
        capabilities: installation.capabilities,
        models: installation.models,
        loginStatus: installation.models.length > 0 ? 'configured' : 'unknown',
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
        loginStatus: installation.models.length > 0 ? 'configured' : 'unknown',
        checkedAt,
      };
    }
  }
}
