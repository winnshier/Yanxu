import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('scheduler recovery', () => {
  it('immediately returns a job leased by an old daemon instance to the ready queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-recovery-test-'));
    temporaryDirectories.push(root);
    const projectDirectory = join(root, 'project');
    mkdirSync(projectDirectory);
    const databasePath = join(root, 'workbench', 'system', 'app.db');
    const database = openDatabase(databasePath);
    const store = new YanxuStore(database, join(root, 'workbench'));
    const project = store.createProject({ name: '恢复测试', directoryPath: projectDirectory });
    const team = store.listTeams()[0];
    if (!team) throw new Error('default team missing');
    let task = store.createTask({
      projectId: project.id,
      teamId: team.id,
      title: '验证重启恢复',
      description: 'Daemon 重启后继续计划任务。',
    });
    task = store.submitTask(task.id, task.stateVersion);

    const leased = store.claimReadyJob('daemon_old');
    expect(leased?.aggregateId).toBe(task.id);
    database.close();

    const restartedDatabase = openDatabase(databasePath);
    const restartedStore = new YanxuStore(restartedDatabase, join(root, 'workbench'));
    expect(restartedStore.reconcileExpiredLeases('daemon_new')).toBe(1);
    expect(restartedStore.getTaskEvidence(task.id).recoveries).toEqual([
      expect.objectContaining({
        jobId: leased?.id,
        reason: 'daemon_restarted',
        previousOwner: 'daemon_old',
        recoveredBy: 'daemon_new',
      }),
    ]);
    const recovered = restartedStore.claimReadyJob('daemon_new');
    expect(recovered?.id).toBe(leased?.id);
    restartedDatabase.close();
  });
});
