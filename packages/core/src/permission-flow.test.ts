import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('permission and scope decisions', () => {
  it('records once, task-level always, reject and scope reapproval paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-permission-flow-'));
    roots.push(root);
    const directory = join(root, 'project');
    mkdirSync(directory);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const project = store.createProject({ name: '权限项目', directoryPath: directory });
    const team = store.listTeams()[0];
    if (!team) throw new Error('default team missing');
    const createRunningTask = (title: string) => {
      const task = store.createTask({
        projectId: project.id,
        teamId: team.id,
        title,
        description: '验证权限决定。',
      });
      database.prepare(`UPDATE tasks SET status = 'RUNNING' WHERE id = ?`).run(task.id);
      return store.getTask(task.id);
    };
    const request = (taskId: string, suffix: string) => store.createPermissionRequest(taskId, `session_${suffix}`, {
      id: `external_${suffix}`,
      permission: 'bash',
      patterns: [`pnpm test -- ${suffix}`],
      metadata: { source: 'test' },
    });

    const onceTask = createRunningTask('允许一次');
    const once = request(onceTask.id, 'once');
    expect(store.getTask(onceTask.id).status).toBe('WAITING_APPROVAL');
    expect(store.respondPermission(once.id, 'once')).toMatchObject({ status: 'resolved', decision: 'once' });
    expect(store.getTask(onceTask.id).status).toBe('RUNNING');
    expect(store.listTaskPermissionGrants(onceTask.id)).toEqual([]);

    const alwaysTask = createRunningTask('任务级允许');
    const always = request(alwaysTask.id, 'always');
    expect(store.respondPermission(always.id, 'always')).toMatchObject({ decision: 'always' });
    expect(store.listTaskPermissionGrants(alwaysTask.id)).toEqual([
      { permission: 'bash', patterns: ['pnpm test -- always'] },
    ]);

    const rejectTask = createRunningTask('拒绝并重新规划');
    const rejected = request(rejectTask.id, 'reject');
    expect(store.respondPermission(rejected.id, 'reject')).toMatchObject({ decision: 'reject' });
    expect(store.getTask(rejectTask.id).status).toBe('REPLANNING');
    expect(store.listEvents(rejectTask.id).map((event) => event.type)).toContain('permission.responded');

    const scopeTask = createRunningTask('越界重新确认');
    const scopeResult = store.handleScopeViolation(scopeTask.id, 'step_scope', {
      reason: 'out_of_scope_change',
      files: [{ directoryId: project.directories[0]?.id ?? '', path: 'outside/change.ts', sensitive: false }],
    });
    expect(scopeResult.status).toBe('REPLANNING');
    expect(store.listEvents(scopeTask.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'scope.change_detected' }),
      expect.objectContaining({ type: 'task.replan_requested' }),
    ]));
    database.close();
  });
});
