import { createOpencodeClient, type PermissionRequest, type PermissionRuleset } from '@opencode-ai/sdk/v2';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { probeExecutors } from './probe.js';
import type {
  ExecutorAdapter,
  RuntimeHandle,
  RuntimePermissionPolicy,
  StructuredExecutionInput,
  StructuredExecutionResult,
} from './types.js';

interface ManagedRuntime extends RuntimeHandle {
  password: string;
  process: ChildProcessWithoutNullStreams;
}

type SdkClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodeAdapter implements ExecutorAdapter {
  private readonly runtimes = new Map<string, ManagedRuntime>();

  constructor(private readonly knownInstallation?: ExecutorInstallation) {}

  async probe(): Promise<ExecutorInstallation> {
    if (this.knownInstallation) return this.knownInstallation;
    const executors = await probeExecutors();
    const installation = executors.find((item) => item.id === 'opencode');
    if (!installation) throw new Error('OpenCode definition is missing.');
    return installation;
  }

  async startRuntime(workspacePath: string, runtimeDirectory: string): Promise<RuntimeHandle> {
    const installation = await this.probe();
    if (installation.health !== 'available' || !installation.path) throw new Error(installation.error ?? 'OpenCode CLI is unavailable.');
    mkdirSync(runtimeDirectory, { recursive: true });
    const port = await findFreePort();
    const password = randomBytes(24).toString('base64url');
    const child = spawn(installation.path, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: workspacePath,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: 'yanxu',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_SHARE: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const log = createWriteStream(join(runtimeDirectory, 'opencode.log'), { flags: 'a', mode: 0o600 });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const handle: ManagedRuntime = {
      id: `runtime_${randomUUID().replaceAll('-', '')}`,
      executor: 'opencode', workspacePath, endpoint: `http://127.0.0.1:${port}`, sessionIds: [], password, process: child,
    };
    this.runtimes.set(handle.id, handle);
    try {
      await this.waitForHealth(handle);
    } catch (error) {
      this.runtimes.delete(handle.id);
      if (handle.process.exitCode === null) handle.process.kill('SIGTERM');
      throw error;
    }
    return this.publicHandle(handle);
  }

  async executeStructured<T>(input: StructuredExecutionInput): Promise<StructuredExecutionResult<T>> {
    const runtime = this.getRuntime(input.runtime.id);
    const client = this.client(runtime);
    const sessionResponse = await client.session.create({
      title: input.title,
      directory: runtime.workspacePath,
      permission: permissionRules(input.permissionMode ?? 'standard', input.readOnly ?? false, input.policy),
    });
    const session = unwrap<{ id: string }>(sessionResponse);
    runtime.sessionIds.push(session.id);
    const [providerID, ...modelParts] = input.model.split('/');
    const modelID = modelParts.join('/');
    if (!providerID || !modelID) throw new Error('OpenCode model must use provider/model format.');
    const abort = () => { void client.session.abort({ sessionID: session.id, directory: runtime.workspacePath }); };
    input.abortSignal?.addEventListener('abort', abort, { once: true });
    let promptSettled = false;
    const permissionWorker = this.processPermissions(client, runtime, session.id, input, () => promptSettled);
    try {
      const response = await client.session.prompt({
        sessionID: session.id,
        directory: runtime.workspacePath,
        model: { providerID, modelID },
        parts: [{ type: 'text', text: input.prompt }],
        format: { type: 'json_schema', schema: input.schema, retryCount: 2 },
      });
      const data = unwrap<{ info: { structured?: T; error?: { name?: string; data?: { message?: string } } } }>(response);
      if (data.info.error) throw new Error(data.info.error.data?.message ?? data.info.error.name ?? 'OpenCode structured output failed.');
      if (data.info.structured === undefined) throw new Error('OpenCode did not return structured output.');
      return { sessionId: session.id, output: data.info.structured };
    } finally {
      promptSettled = true;
      await permissionWorker;
      input.abortSignal?.removeEventListener('abort', abort);
    }
  }

  async abortSession(runtime: RuntimeHandle, sessionId: string): Promise<void> {
    const managed = this.getRuntime(runtime.id);
    await this.client(managed).session.abort({ sessionID: sessionId, directory: managed.workspacePath });
  }

  async stopRuntime(runtime: RuntimeHandle): Promise<void> {
    const managed = this.runtimes.get(runtime.id);
    if (!managed) return;
    this.runtimes.delete(runtime.id);
    const client = this.client(managed);
    await Promise.allSettled(managed.sessionIds.map((sessionId) =>
      client.session.abort({ sessionID: sessionId, directory: managed.workspacePath })));
    if (managed.process.exitCode !== null) return;
    managed.process.kill('SIGTERM');
    const exited = await waitForProcessExit(managed.process, 5_000);
    if (!exited && managed.process.exitCode === null) {
      managed.process.kill('SIGKILL');
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
    runtime.process.kill('SIGTERM');
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
      } catch {
        if (settled()) return;
      }
      if (!settled()) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

function unwrap<T>(response: unknown): T {
  if (response && typeof response === 'object' && 'data' in response) return (response as { data: T }).data;
  return response as T;
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
  for (const pattern of policy?.allowedReadPatterns ?? []) {
    rules.push(
      { permission: 'read', pattern, action: 'allow' },
      { permission: 'glob', pattern, action: 'allow' },
      { permission: 'grep', pattern, action: 'allow' },
      { permission: 'list', pattern, action: 'allow' },
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
      { permission: 'webfetch' as const, pattern: '*', action: 'deny' as const },
      { permission: 'websearch' as const, pattern: '*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'curl *', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'wget *', action: 'deny' as const },
    ] : []),
    ...(policy?.dependencyInstallPolicy === 'deny' ? [
      { permission: 'bash' as const, pattern: 'npm install*', action: 'deny' as const },
      { permission: 'bash' as const, pattern: 'npm i *', action: 'deny' as const },
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
