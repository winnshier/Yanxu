import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const temporaryDirectories: string[] = [];
const availableOpenCode: ExecutorInstallation = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  path: '/tmp/opencode',
  version: 'test',
  health: 'available',
  capabilities: ['structured-output'],
  models: ['test-model'],
  lastCheckedAt: new Date().toISOString(),
  error: null,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `yanxu-${name}-`));
  temporaryDirectories.push(root);
  const repository = join(root, 'repository');
  const workbench = join(root, 'workbench');
  mkdirSync(repository);
  const database = openDatabase(join(workbench, 'system', 'app.db'));
  const store = new YanxuStore(database, workbench);
  const agent = store.createAgent({
    name: '项目研发',
    roleId: 'implementation-worker',
    executor: 'opencode',
    model: 'test-model',
  }, availableOpenCode);
  const team = store.createTeam({ name: '项目团队', memberIds: [agent.id] });
  const project = store.createProject({ name: '知识项目', directoryPath: repository });
  const task = store.createTask({
    projectId: project.id,
    teamId: team.id,
    title: '沉淀项目经验',
    description: '只沉淀经过交付证据验证、可在项目内复用的经验。',
  });
  const directory = project.directories[0];
  if (!directory) throw new Error('directory missing');
  return { root, database, store, project, task, directory };
}

function markDelivered(
  database: ReturnType<typeof openDatabase>,
  store: YanxuStore,
  taskId: string,
) {
  database.prepare(`UPDATE tasks SET status = 'DELIVERED' WHERE id = ?`).run(taskId);
  return store.getTask(taskId);
}

describe('archived task knowledge candidates', () => {
  it('waits for archive, excludes runtime failures and deduplicates identical candidates', () => {
    const fixture = createFixture('knowledge-boundary');
    let task = fixture.store.submitTask(fixture.task.id, fixture.task.stateVersion);
    const firstJob = fixture.store.claimReadyJob('knowledge-test');
    if (!firstJob) throw new Error('first job missing');
    fixture.store.failJob(firstJob, new Error('Injected executor transport failure'));
    fixture.database.prepare(`UPDATE jobs SET available_at = ? WHERE id = ?`)
      .run(new Date(0).toISOString(), firstJob.id);
    const repeatedJob = fixture.store.claimReadyJob('knowledge-test');
    if (!repeatedJob) throw new Error('repeated job missing');
    fixture.store.failJob(repeatedJob, new Error('Injected executor transport failure'));

    expect(fixture.store.listKnowledge(fixture.project.id)).toEqual([]);
    task = markDelivered(fixture.database, fixture.store, task.id);
    expect(fixture.store.listKnowledge(fixture.project.id)).toEqual([]);

    task = fixture.store.commandTask(task.id, 'self_merge', task.stateVersion);
    expect(task.status).toBe('ARCHIVED');
    expect(fixture.store.listKnowledge(fixture.project.id)).toEqual([
      expect.objectContaining({
        category: 'decision',
        status: 'candidate',
        sourceTaskId: task.id,
        version: 1,
      }),
    ]);

    const testAccess = fixture.store as unknown as {
      createKnowledgeCandidatesForArchivedTask(taskId: string): void;
    };
    testAccess.createKnowledgeCandidatesForArchivedTask(task.id);

    expect(fixture.store.listKnowledge(fixture.project.id)).toHaveLength(1);
    expect(fixture.store.listEvents(fixture.project.id)
      .filter((event) => event.type === 'knowledge.candidates_created')).toHaveLength(1);
    fixture.database.close();
  });

  it('creates reusable experience only from failed quality evidence with an explicit validation boundary', () => {
    const fixture = createFixture('knowledge-evidence');
    const failedLog = join(fixture.root, 'failed.log');
    const passedLog = join(fixture.root, 'passed.log');
    writeFileSync(failedLog, 'AssertionError: expected protected route to reject anonymous access\n');
    writeFileSync(passedLog, 'protected route rejects anonymous access\n');
    const startedAt = new Date().toISOString();

    fixture.store.saveGateResults(fixture.task.id, [{
      id: 'gate-auth',
      directoryId: fixture.directory.id,
      command: 'pnpm test auth',
      status: 'failed',
      exitCode: 1,
      logPath: failedLog,
      startedAt,
      completedAt: startedAt,
      attempt: 1,
      commandArgv: ['pnpm', 'test', 'auth'],
      signal: null,
      timedOut: false,
    }]);
    fixture.store.saveGateResults(fixture.task.id, [{
      id: 'gate-auth',
      directoryId: fixture.directory.id,
      command: 'pnpm test auth',
      status: 'passed',
      exitCode: 0,
      logPath: passedLog,
      startedAt,
      completedAt: new Date().toISOString(),
      attempt: 2,
      commandArgv: ['pnpm', 'test', 'auth'],
      signal: null,
      timedOut: false,
    }]);

    let task = markDelivered(fixture.database, fixture.store, fixture.task.id);
    task = fixture.store.commandTask(task.id, 'self_merge', task.stateVersion);
    const candidates = fixture.store.listKnowledge(fixture.project.id);
    expect(candidates.map((candidate) => candidate.category).sort()).toEqual(['decision', 'experience']);
    expect(candidates.find((candidate) => candidate.category === 'experience')?.content).toContain(
      '问题：质量门禁 `pnpm test auth` 在第 1 轮失败',
    );
    expect(candidates.find((candidate) => candidate.category === 'experience')?.content).toContain(
      '原因证据：AssertionError: expected protected route to reject anonymous access',
    );
    expect(candidates.find((candidate) => candidate.category === 'experience')?.content).toContain(
      '验证：后续同一门禁已经通过。',
    );
    expect(candidates.find((candidate) => candidate.category === 'experience')?.content).toContain('适用边界：');
    fixture.database.close();
  });
});
