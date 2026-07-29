import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  agentStatusSchema, answerPlanSchema, createAgentSchema, createProjectRequestSchema, createTaskRequestSchema, createTeamSchema, folderSelectionRequestSchema,
  knowledgeDecisionSchema, permissionDecisionSchema, requestPlanRevisionSchema, taskCommandSchema, updateSystemSettingsSchema,
  type AgentStatusInput, type AnswerPlanInput, type CreateAgentInput, type CreateProjectRequest, type CreateTaskRequest, type CreateTeamInput,
  type FolderSelectionRequest, type KnowledgeDecisionInput, type PermissionDecisionInput, type RequestPlanRevisionInput,
  type TaskCommandInput, type UpdateProjectSettingsInput,
} from '@yanxu/contracts';
import { DomainError } from '@yanxu/core';
import type { YanxuStore } from '@yanxu/core';
import { chooseFile, chooseFolder, FileSelectionRegistry, FolderSelectionRegistry } from './folder-picker.js';
import type { ExecutorRegistry } from './executor-registry.js';
import type { Scheduler } from './scheduler.js';

interface ServerOptions {
  chooseFolder?: () => Promise<string>;
  chooseFile?: () => Promise<string>;
}

export async function createServer(
  store: YanxuStore,
  executors: ExecutorRegistry,
  scheduler: Scheduler,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const daemonLogDirectory = join(store.workbenchHome, 'system', 'logs');
  mkdirSync(daemonLogDirectory, { recursive: true });
  const daemonLogPath = join(daemonLogDirectory, 'daemon.log');
  const daemonLogStream = createWriteStream(daemonLogPath, { flags: 'a', mode: 0o600 });
  daemonLogStream.on('error', (error) => {
    process.stderr.write(`[yanxu] Failed to write daemon log: ${error.message}\n`);
  });
  const server = Fastify({
    logger: {
      level: process.env.YANXU_LOG_LEVEL ?? 'info',
      stream: {
        write(message: string) {
          process.stdout.write(message);
          daemonLogStream.write(message);
        },
      },
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  server.addHook('onClose', (_instance, done) => {
    daemonLogStream.end(() => done());
  });
  const webOrigin = process.env.YANXU_WEB_ORIGIN;
  const folderSelections = new FolderSelectionRegistry();
  const fileSelections = new FileSelectionRegistry();
  const authToken = loadOrCreateLocalAuthToken(store.workbenchHome);
  const csrfToken = createHash('sha256').update(`${authToken}:csrf`).digest('hex');
  if (webOrigin) await server.register(cors, { origin: webOrigin });

  server.addHook('onRequest', (request, _reply, done) => {
    if (!request.url.startsWith('/api/')) {
      done();
      return;
    }
    const routePath = request.url.split('?')[0];
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const fetchSite = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!safeMethod && fetchSite === 'cross-site') {
      done(new DomainError('CROSS_SITE_REQUEST_REJECTED', '研序拒绝跨站修改本地数据。', 403));
      return;
    }
    if (!safeMethod && origin && host) {
      const allowed = new Set([`http://${host}`, `https://${host}`, ...(webOrigin ? [webOrigin] : [])]);
      if (!allowed.has(origin)) {
        done(new DomainError('ORIGIN_NOT_ALLOWED', '请求来源不属于当前研序工作台。', 403, { origin }));
        return;
      }
    }
    if (routePath === '/api/session') {
      done();
      return;
    }
    if (!matchesSecret(readCookie(request.headers.cookie, 'yanxu_session'), authToken)) {
      done(new DomainError('LOCAL_SESSION_REQUIRED', '本地工作台会话无效，请刷新页面。', 401));
      return;
    }
    if (!safeMethod && !matchesSecret(readHeader(request.headers['x-yanxu-csrf']), csrfToken)) {
      done(new DomainError('CSRF_TOKEN_INVALID', '请求缺少有效的本地安全令牌，请刷新页面。', 403));
      return;
    }
    done();
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof Error && 'validation' in error && error.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '提交的数据格式不正确。', details: error.validation } });
    }
    request.log.error({ err: error, requestId: request.id, method: request.method, url: request.url }, 'Unhandled request error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '本地服务发生未预期错误。',
        details: { requestId: request.id, logPath: daemonLogPath },
      },
    });
  });

  const systemHealth = () => {
    const schedulerHealth = scheduler.health();
    return {
      status: schedulerHealth.running ? 'ready' as const : 'starting' as const,
      service: 'yanxu-daemon' as const,
      database: 'ready' as const,
      scheduler: schedulerHealth,
      time: new Date().toISOString(),
    };
  };
  server.get('/health', systemHealth);
  server.get('/health/live', () => ({ status: 'live', service: 'yanxu-daemon', time: new Date().toISOString() }));
  server.get('/health/ready', (_request, reply) => {
    const health = systemHealth();
    return reply.status(health.status === 'ready' ? 200 : 503).send(health);
  });
  server.get('/api/session', (_request, reply) => {
    reply.header('set-cookie', `yanxu_session=${encodeURIComponent(authToken)}; Path=/; HttpOnly; SameSite=Strict`);
    return { csrfToken };
  });
  server.get('/api/dashboard', () => store.dashboard(executors.list()));
  server.get('/api/builtins', () => store.getBuiltins());
  server.post('/api/folder-picker', async () => folderSelections.issue(await (options.chooseFolder ?? chooseFolder)()));
  server.post('/api/file-picker', async () => fileSelections.issue(await (options.chooseFile ?? chooseFile)()));

  server.get('/api/executors', () => executors.list());
  server.post('/api/executors/probe', () => executors.probe());
  server.get('/api/executor-validations', () => store.listExecutorValidations());
  server.post<{ Params: { executor: 'opencode' | 'claude' | 'codex' } }>('/api/executors/:executor/validate', async (request) => {
    const result = await executors.validateRuntime(request.params.executor, store.workbenchHome);
    store.saveExecutorValidation(result);
    if (result.status === 'failed') {
      throw new DomainError('EXECUTOR_RUNTIME_VALIDATION_FAILED', result.message, 422, result);
    }
    return result;
  });
  server.get('/api/settings', () => store.getSettings(executors.list()));
  server.get('/api/system/diagnostics', () => store.systemDiagnostics());
  server.patch('/api/settings', { schema: { body: updateSystemSettingsSchema } }, (request) => {
    store.updateSettings(request.body as Parameters<YanxuStore['updateSettings']>[0]);
    return store.getSettings(executors.list());
  });
  server.get('/api/permissions', () => store.listPendingPermissions());
  server.post<{ Params: { requestId: string }; Body: PermissionDecisionInput }>(
    '/api/permissions/:requestId/respond',
    { schema: { body: permissionDecisionSchema } },
    (request) => store.respondPermission(request.params.requestId, request.body.decision, request.body.message),
  );

  server.get('/api/projects', () => store.listProjects());
  server.post<{ Body: FolderSelectionRequest }>('/api/project-space/restore/preview',
    { schema: { body: folderSelectionRequestSchema } },
    (request) => store.previewProjectSpaceRestore(folderSelections.resolve(request.body.selectionToken, false)));
  server.post<{ Body: FolderSelectionRequest }>('/api/project-space/restore',
    { schema: { body: folderSelectionRequestSchema } },
    (request) => store.restoreProjectSpace(folderSelections.resolve(request.body.selectionToken)));
  server.post<{ Body: CreateProjectRequest }>('/api/projects', { schema: { body: createProjectRequestSchema } }, (request, reply) => {
    const project = store.createProject({
      name: request.body.name,
      ...(request.body.description === undefined ? {} : { description: request.body.description }),
      directoryPath: folderSelections.resolve(request.body.directorySelectionToken),
    });
    return reply.status(201).send(project);
  });
  server.get<{ Params: { projectId: string } }>('/api/projects/:projectId', (request) => store.getProject(request.params.projectId));
  server.get<{ Params: { projectId: string } }>('/api/projects/:projectId/settings', (request) =>
    store.getProjectSettings(request.params.projectId));
  server.put<{ Params: { projectId: string }; Body: UpdateProjectSettingsInput }>('/api/projects/:projectId/settings', (request) =>
    store.updateProjectSettings(request.params.projectId, request.body));
  server.get<{ Params: { projectId: string } }>('/api/projects/:projectId/project-space-operations', (request) =>
    store.listProjectSpaceOperations(request.params.projectId));
  server.get<{ Params: { projectId: string } }>('/api/projects/:projectId/project-space-integrity', (request) =>
    store.checkProjectSpaceIntegrity(request.params.projectId));
  server.post<{ Params: { projectId: string } }>('/api/projects/:projectId/project-space-state/refresh', (request) =>
    store.refreshProjectSpaceState(request.params.projectId));
  server.get<{ Params: { projectId: string } }>('/api/projects/:projectId/directory-profiles', (request) =>
    store.listDirectoryProfiles(request.params.projectId));
  server.post<{ Params: { projectId: string }; Body: FolderSelectionRequest }>(
    '/api/projects/:projectId/directories',
    { schema: { body: folderSelectionRequestSchema } },
    (request, reply) => {
    const directory = store.addProjectDirectory(request.params.projectId, folderSelections.resolve(request.body.selectionToken));
    return reply.status(201).send(directory);
  });
  server.delete<{ Params: { directoryId: string } }>('/api/directories/:directoryId', (request) =>
    store.removeProjectDirectory(request.params.directoryId));
  server.post<{ Params: { directoryId: string } }>('/api/directories/:directoryId/rescan', (request) => store.rescanDirectory(request.params.directoryId));
  server.post<{ Params: { profileId: string } }>('/api/directory-profiles/:profileId/confirm', (request) =>
    store.confirmDirectoryProfile(request.params.profileId));
  server.get<{ Params: { projectId: string }; Querystring: { q?: string } }>('/api/projects/:projectId/knowledge', (request) =>
    request.query.q ? store.searchKnowledge(request.params.projectId, request.query.q) : store.listKnowledge(request.params.projectId));
  server.post<{ Params: { itemId: string }; Body: KnowledgeDecisionInput }>(
    '/api/knowledge/:itemId/review',
    { schema: { body: knowledgeDecisionSchema } },
    (request) => store.reviewKnowledge(request.params.itemId, request.body.decision, request.body),
  );

  server.get('/api/agents', () => store.listAgents());
  server.post<{ Body: CreateAgentInput }>('/api/agents', { schema: { body: createAgentSchema } }, async (request, reply) => {
    await executors.probe();
    if (request.body.executor !== 'opencode') {
      throw new DomainError('EXECUTOR_ADAPTER_PENDING', '第一版只开放 OpenCode 执行适配器；Claude Code 与 Codex CLI 将按顺序接入。', 422);
    }
    const agent = store.createAgent({
      ...request.body,
      permissionMode: request.body.permissionMode ?? store.getSettings(executors.list()).permissionMode,
    }, executors.get(request.body.executor));
    return reply.status(201).send(agent);
  });
  server.put<{ Params: { agentId: string }; Body: CreateAgentInput }>(
    '/api/agents/:agentId',
    { schema: { body: createAgentSchema } },
    async (request) => {
      await executors.probe();
      if (request.body.executor !== 'opencode') {
        throw new DomainError('EXECUTOR_ADAPTER_PENDING', '第一版只开放 OpenCode 执行适配器；Claude Code 与 Codex CLI 将按顺序接入。', 422);
      }
      return store.updateAgent(request.params.agentId, request.body, executors.get(request.body.executor));
    },
  );
  server.patch<{ Params: { agentId: string }; Body: AgentStatusInput }>(
    '/api/agents/:agentId/status',
    { schema: { body: agentStatusSchema } },
    (request) => store.setAgentStatus(request.params.agentId, request.body.status),
  );
  server.delete<{ Params: { agentId: string } }>('/api/agents/:agentId', (request) =>
    store.deleteAgent(request.params.agentId));

  server.get('/api/teams', () => store.listTeams());
  server.post<{ Body: CreateTeamInput }>('/api/teams', { schema: { body: createTeamSchema } }, (request, reply) => {
    const team = store.createTeam(request.body);
    return reply.status(201).send(team);
  });
  server.put<{ Params: { teamId: string }; Body: CreateTeamInput }>('/api/teams/:teamId', { schema: { body: createTeamSchema } }, (request) =>
    store.updateTeam(request.params.teamId, request.body));

  server.get<{ Querystring: { projectId?: string; archived?: string } }>('/api/tasks', (request) =>
    store.listTasks({
      ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
      includeArchived: request.query.archived === 'true',
    }));
  server.post<{ Body: CreateTaskRequest }>('/api/tasks', { schema: { body: createTaskRequestSchema } }, async (request, reply) => {
    if (request.body.submitForAnalysis) {
      await executors.probe();
      const settings = store.getSettings(executors.list());
      if (!settings.coordinatorReady) throw new DomainError('COORDINATOR_UNAVAILABLE', '请先在设置中检测 OpenCode 并选择全局协调模型。', 422);
    }
    const { attachmentSelectionTokens = [], ...taskInput } = request.body;
    const attachmentPaths = attachmentSelectionTokens.map((token) => fileSelections.resolve(token));
    let task = store.createTask(taskInput);
    if (attachmentPaths.length > 0) store.attachTaskFiles(task.id, attachmentPaths);
    if (request.body.submitForAnalysis) task = store.submitTask(task.id, task.stateVersion);
    return reply.status(201).send(task);
  });
  server.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', (request) => store.getTask(request.params.taskId));
  server.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/plans', (request) => store.listTaskPlans(request.params.taskId));
  server.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/evidence', (request) => store.getTaskEvidence(request.params.taskId));
  server.get<{
    Params: { taskId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/api/tasks/:taskId/runtime-log', (request) => {
    store.getTask(request.params.taskId);
    const logPath = join(store.workbenchHome, 'runtime', 'tasks', request.params.taskId, 'executor', 'opencode.log');
    const totalBytes = existsSync(logPath) ? statSync(logPath).size : 0;
    const limit = Math.min(Math.max(Number(request.query.limit ?? 64 * 1024), 1), 256 * 1024);
    const requestedCursor = request.query.cursor === undefined ? Math.max(0, totalBytes - limit) : Number(request.query.cursor);
    const cursor = Math.min(Math.max(Number.isFinite(requestedCursor) ? requestedCursor : 0, 0), totalBytes);
    const length = Math.min(limit, totalBytes - cursor);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      const descriptor = openSync(logPath, 'r');
      try {
        readSync(descriptor, buffer, 0, length, cursor);
      } finally {
        closeSync(descriptor);
      }
    }
    return {
      taskId: request.params.taskId,
      source: 'opencode-runtime' as const,
      cursor,
      nextCursor: cursor + length,
      totalBytes,
      eof: cursor + length >= totalBytes,
      content: buffer.toString('utf8'),
    };
  });
  server.get<{
    Params: { taskId: string };
    Querystring: { directoryId: string; path: string };
  }>('/api/tasks/:taskId/diff', (request) =>
    scheduler.taskFileDiff(request.params.taskId, request.query.directoryId, request.query.path));
  server.get<{ Params: { taskId: string }; Querystring: { after?: string } }>('/api/tasks/:taskId/events', (request) =>
    store.listEvents(request.params.taskId, Number(request.query.after ?? 0)));
  server.patch<{ Params: { taskId: string }; Body: AnswerPlanInput }>('/api/tasks/:taskId/plan', { schema: { body: answerPlanSchema } }, (request) =>
    store.updatePlanAnswers(request.params.taskId, request.body));
  server.post<{ Params: { taskId: string }; Body: RequestPlanRevisionInput }>(
    '/api/tasks/:taskId/plan/revise',
    { schema: { body: requestPlanRevisionSchema } },
    async (request) => {
      await executors.probe();
      const settings = store.getSettings(executors.list());
      if (!settings.coordinatorReady) throw new DomainError('COORDINATOR_UNAVAILABLE', '请先在设置中检测 OpenCode 并选择全局协调模型。', 422);
      return store.requestPlanRevision(request.params.taskId, request.body);
    },
  );
  server.post<{ Params: { taskId: string }; Body: TaskCommandInput }>('/api/tasks/:taskId/commands', { schema: { body: taskCommandSchema } }, async (request) => {
    if (request.body.command === 'submit') {
      await executors.probe();
      const settings = store.getSettings(executors.list());
      if (!settings.coordinatorReady) throw new DomainError('COORDINATOR_UNAVAILABLE', '请先在设置中检测 OpenCode 并选择全局协调模型。', 422);
      return store.submitTask(request.params.taskId, request.body.stateVersion);
    }
    if (request.body.command === 'confirm') {
      await executors.probe();
      const task = store.getTask(request.params.taskId);
      for (const step of task.steps) {
        if (!step.agentId) continue;
        const agent = store.getAgent(step.agentId);
        const installation = executors.get(agent.executor);
        if (agent.status !== 'active') {
          throw new DomainError('TASK_AGENT_INACTIVE', `执行步骤“${step.title}”对应的人员已停用。`, 422);
        }
        if (agent.executor !== 'opencode' || installation?.health !== 'available') {
          throw new DomainError('TASK_EXECUTOR_UNAVAILABLE', `执行步骤“${step.title}”对应的 ${agent.executor} 执行器当前不可用或尚未接入。`, 422);
        }
      }
    }
    if (request.body.command === 'merge') {
      store.validateTaskCommand(request.params.taskId, request.body.command, request.body.stateVersion);
      const results = await scheduler.mergeTask(request.params.taskId);
      store.recordDeliveryMerge(request.params.taskId, results);
    }
    const task = store.commandTask(request.params.taskId, request.body.command, request.body.stateVersion, request.body.reason);
    if (request.body.command === 'stop') {
      await scheduler.abortTask(request.params.taskId);
    }
    return task;
  });

  server.get<{ Querystring: { after?: string } }>('/api/events/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    const lastEventId = Array.isArray(request.headers['last-event-id'])
      ? request.headers['last-event-id'][0]
      : request.headers['last-event-id'];
    let after = Number(request.query.after ?? lastEventId ?? 0);
    const push = () => {
      for (const event of store.listEvents(undefined, after)) {
        after = event.seq;
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    push();
    const interval = setInterval(() => { push(); reply.raw.write(': heartbeat\n\n'); }, 2_000);
    request.raw.once('close', () => clearInterval(interval));
  });

  const webRoot = join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(webRoot)) {
    await server.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      cacheControl: false,
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) response.setHeader('cache-control', 'no-store');
        else if (filePath.includes(`${join('assets', '')}`)) response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/health')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      if (request.url.split('?')[0]?.startsWith('/assets/')) return reply.status(404).type('text/plain').send('Static asset not found.');
      return reply.header('cache-control', 'no-store').sendFile('index.html');
    });
  }
  return server;
}

function loadOrCreateLocalAuthToken(workbenchHome: string): string {
  const systemDirectory = join(workbenchHome, 'system');
  const tokenPath = join(systemDirectory, 'auth-token');
  mkdirSync(systemDirectory, { recursive: true });
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const entry of header.split(';')) {
    const [key, ...value] = entry.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function readHeader(header: string | string[] | undefined): string {
  return Array.isArray(header) ? header[0] ?? '' : header ?? '';
}

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}
