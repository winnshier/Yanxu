import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, ExecutorInstallation, FileSelection, FolderSelection, LocalSession, Project, Task, TaskEvidence, TaskLogChunk, Team } from '@yanxu/contracts';
import { openDatabase, YanxuStore } from '@yanxu/core';
import { ExecutorRegistry } from './executor-registry.js';
import { Scheduler } from './scheduler.js';
import { createServer } from './server.js';

const roots: string[] = [];
const availableOpenCode: ExecutorInstallation = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  path: '/tmp/fake-opencode',
  version: 'test',
  health: 'available',
  capabilities: ['sessions', 'structured-output', 'permissions', 'abort'],
  models: ['test/fake'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local daemon HTTP boundary', () => {
  it('serves hashed assets created by a build after the daemon has started', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-static-assets-'));
    roots.push(root);
    const webRoot = join(root, 'web');
    const assetsRoot = join(webRoot, 'assets');
    mkdirSync(assetsRoot, { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<div id="root"></div>');
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);
    const registry = new ExecutorRegistry([availableOpenCode], () => Promise.resolve([availableOpenCode]));
    const scheduler = new Scheduler(store, registry);
    const server = await createServer(store, registry, scheduler, { webRoot });
    try {
      await server.ready();
      writeFileSync(join(assetsRoot, 'index-new-build.js'), 'globalThis.__yanxu = true;');

      const response = await server.inject('/assets/index-new-build.js');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/javascript');
      expect(response.body).toBe('globalThis.__yanxu = true;');
    } finally {
      await server.close();
      database.close();
    }
  });

  it('requires a local cookie and CSRF token, rejects cross-site mutations and exposes readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-server-security-'));
    roots.push(root);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);
    const registry = new ExecutorRegistry([availableOpenCode], () => Promise.resolve([availableOpenCode]));
    const scheduler = new Scheduler(store, registry);
    const server = await createServer(store, registry, scheduler);
    server.get('/api/test-internal-error', () => {
      throw new Error('Injected persistent daemon log failure.');
    });
    try {
      const rejected = await server.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: {
          host: '127.0.0.1:43120',
          origin: 'https://malicious.example',
          'sec-fetch-site': 'cross-site',
        },
        payload: {},
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({ error: { code: 'CROSS_SITE_REQUEST_REJECTED' } });

      const unauthenticated = await server.inject('/api/dashboard');
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ error: { code: 'LOCAL_SESSION_REQUIRED' } });

      const session = await openSession(server);
      const missingCsrf = await server.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: session.cookie },
        payload: {},
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_TOKEN_INVALID' } });

      const authenticated = await server.inject({
        method: 'GET',
        url: '/api/dashboard',
        headers: { cookie: session.cookie },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(statSync(join(root, 'system', 'auth-token')).mode & 0o777).toBe(0o600);
      const diagnostics = await server.inject({
        method: 'GET',
        url: '/api/system/diagnostics',
        headers: { cookie: session.cookie },
      });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json()).toMatchObject({ databaseCheck: 'ok', workbenchHome: root });

      expect((await server.inject('/health')).json()).toMatchObject({ status: 'starting', database: 'ready' });
      const liveHealth = await server.inject('/health/live');
      expect(liveHealth.statusCode).toBe(200);
      expect(liveHealth.json()).toMatchObject({ service: 'yanxu-daemon', pid: process.pid });
      expect((await server.inject('/health/ready')).statusCode).toBe(503);
      scheduler.start();
      expect((await server.inject('/health')).json()).toMatchObject({
        status: 'ready',
        scheduler: { running: true },
      });
      expect((await server.inject('/health/ready')).statusCode).toBe(200);

      const internalFailure = await server.inject({
        method: 'GET',
        url: '/api/test-internal-error',
        headers: { cookie: session.cookie },
      });
      expect(internalFailure.statusCode).toBe(500);
      const internalFailureBody = internalFailure.json<{
        error: { code: string; details: { requestId: string; logPath: string } };
      }>();
      expect(internalFailureBody.error.code).toBe('INTERNAL_ERROR');
      expect(internalFailureBody.error.details.requestId).toMatch(/^req-/);
      expect(internalFailureBody.error.details.logPath).toBe(join(root, 'system', 'logs', 'daemon.log'));
    } finally {
      scheduler.stop();
      await server.close();
      database.close();
    }
    expect(readFileSync(join(root, 'system', 'logs', 'daemon.log'), 'utf8'))
      .toContain('Injected persistent daemon log failure.');
  });

  it('accepts only short-lived folder selection tokens and consumes them after project creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-folder-token-'));
    roots.push(root);
    const selectedDirectory = join(root, 'selected');
    mkdirSync(selectedDirectory);
    const attachmentPath = join(root, 'requirement.txt');
    writeFileSync(attachmentPath, '附件中的验收要求');
    const resolvedSelectedDirectory = realpathSync(selectedDirectory);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);
    const registry = new ExecutorRegistry([availableOpenCode], () => Promise.resolve([availableOpenCode]));
    const scheduler = new Scheduler(store, registry);
    const server = await createServer(store, registry, scheduler, {
      chooseFolder: () => Promise.resolve(selectedDirectory),
      chooseFile: () => Promise.resolve(attachmentPath),
    });
    try {
      const session = await openSession(server);
      const headers = { cookie: session.cookie, 'x-yanxu-csrf': session.csrfToken };
      const selection = await server.inject({ method: 'POST', url: '/api/folder-picker', headers });
      expect(selection.statusCode).toBe(200);
      const selected = selection.json<FolderSelection>();
      expect(selected).toMatchObject({ displayPath: resolvedSelectedDirectory });
      expect(selected.token).not.toContain(selectedDirectory);

      const directPath = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: '越界项目', directoryPath: selectedDirectory },
      });
      expect(directPath.statusCode).toBe(400);

      const token = selected.token;
      const created = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: '安全项目', directorySelectionToken: token },
      });
      expect(created.statusCode).toBe(201);
      const createdProject = created.json<Project>();
      expect(createdProject.directories[0]?.realPath).toBe(resolvedSelectedDirectory);

      const replay = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { name: '重放项目', directorySelectionToken: token },
      });
      expect(replay.statusCode).toBe(422);
      expect(replay.json()).toMatchObject({ error: { code: 'FOLDER_SELECTION_INVALID' } });

      const createdAgentResponse = await server.inject({
        method: 'POST',
        url: '/api/agents',
        headers,
        payload: {
          name: 'HTTP 研发',
          roleId: 'development',
          executor: 'opencode',
          model: 'test/fake',
        },
      });
      expect(createdAgentResponse.statusCode).toBe(201);
      const createdAgent = createdAgentResponse.json<AgentProfile>();
      const createdTeamResponse = await server.inject({
        method: 'POST',
        url: '/api/teams',
        headers,
        payload: { name: 'HTTP 团队', memberIds: [createdAgent.id] },
      });
      expect(createdTeamResponse.statusCode).toBe(201);
      const createdTeam = createdTeamResponse.json<Team>();
      const fileSelectionResponse = await server.inject({ method: 'POST', url: '/api/file-picker', headers });
      expect(fileSelectionResponse.statusCode).toBe(200);
      const fileSelection = fileSelectionResponse.json<FileSelection>();
      expect(fileSelection).toMatchObject({ fileName: 'requirement.txt', size: 24 });
      expect(fileSelection.token).not.toContain(attachmentPath);
      const createdTaskResponse = await server.inject({
        method: 'POST',
        url: '/api/tasks',
        headers,
        payload: {
          projectId: createdProject.id,
          teamId: createdTeam.id,
          title: 'HTTP 主线任务',
          description: '验证项目、人员、团队和任务主线接口。',
          attachmentSelectionTokens: [fileSelection.token],
        },
      });
      expect(createdTaskResponse.statusCode).toBe(201);
      const createdTask = createdTaskResponse.json<Task>();
      const loadedTask = await server.inject({
        method: 'GET',
        url: `/api/tasks/${createdTask.id}`,
        headers: { cookie: session.cookie },
      });
      expect(loadedTask.statusCode).toBe(200);
      expect(loadedTask.json<Task>()).toMatchObject({
        id: createdTask.id,
        status: 'DRAFT',
        projectName: '安全项目',
        teamName: 'HTTP 团队',
      });
      const loadedEvidence = await server.inject({
        method: 'GET',
        url: `/api/tasks/${createdTask.id}/evidence`,
        headers: { cookie: session.cookie },
      });
      expect(loadedEvidence.statusCode).toBe(200);
      expect(loadedEvidence.json<TaskEvidence>().attachments).toEqual([
        expect.objectContaining({
          fileName: 'requirement.txt',
          contentPreview: '附件中的验收要求',
        }),
      ]);
    } finally {
      scheduler.stop();
      await server.close();
      database.close();
    }
  });

  it('loads only the requested bounded task runtime log chunk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-runtime-log-'));
    roots.push(root);
    const selectedDirectory = join(root, 'selected');
    mkdirSync(selectedDirectory);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);
    const agent = store.createAgent({
      name: '研发',
      roleId: 'development',
      executor: 'opencode',
      model: 'test/fake',
    }, availableOpenCode);
    const team = store.createTeam({ name: '日志团队', memberIds: [agent.id] });
    const project = store.createProject({ name: '日志项目', directoryPath: selectedDirectory });
    const task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '日志任务',
      description: '验证游标读取。',
    });
    const logDirectory = join(root, 'runtime', 'tasks', task.id, 'executor');
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, 'opencode.log'), '0123456789');
    const registry = new ExecutorRegistry([availableOpenCode], () => Promise.resolve([availableOpenCode]));
    const scheduler = new Scheduler(store, registry);
    const server = await createServer(store, registry, scheduler);
    try {
      const session = await openSession(server);
      const response = await server.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/runtime-log?cursor=3&limit=4`,
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskLogChunk>()).toMatchObject({
        taskId: task.id,
        cursor: 3,
        nextCursor: 7,
        totalBytes: 10,
        eof: false,
        content: '3456',
      });
    } finally {
      scheduler.stop();
      await server.close();
      database.close();
    }
  });
});

async function openSession(server: Awaited<ReturnType<typeof createServer>>): Promise<{ cookie: string; csrfToken: string }> {
  const response = await server.inject('/api/session');
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
  return { cookie, csrfToken: response.json<LocalSession>().csrfToken };
}
