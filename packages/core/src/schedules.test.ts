import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];
const executor: ExecutorInstallation = {
  id: 'opencode', name: 'OpenCode', command: 'opencode', path: '/tmp/opencode', version: 'test',
  health: 'available', capabilities: ['structured-output', 'sessions'], models: ['test/model'],
  lastCheckedAt: new Date().toISOString(), error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project schedules', () => {
  it('creates an independent scheduled task from a confirmed boundary and prevents overlap', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-schedule-'));
    roots.push(root);
    const directory = join(root, 'project');
    mkdirSync(directory);
    const database = openDatabase(join(root, 'workbench', 'system', 'app.db'));
    const store = new YanxuStore(database, join(root, 'workbench'));
    const agent = store.createAgent({ name: '巡检', roleId: 'testing', executor: 'opencode', model: 'test/model' }, executor);
    const team = store.createTeam({ name: '巡检团队', memberIds: [agent.id] });
    const project = store.createProject({ name: '定时项目', directoryPath: directory });
    const directoryId = project.directories[0]?.id;
    if (!directoryId) throw new Error('directory missing');
    let source = store.createTask({
      projectId: project.id, teamId: team.id, title: '周期巡检', description: '检查项目并生成报告。', expectedOutput: '巡检报告',
    });
    source = store.submitTask(source.id, source.stateVersion);
    source = store.saveComposedPlan(source.id, {
      goal: '生成项目巡检报告', scope: ['project'], nonScope: ['修改文件'], successCriteria: ['报告可追溯'],
      assumptions: [], risks: [], questions: [], permissions: ['只读项目目录'],
      steps: [{
        id: 'scheduled-report', position: 0, unitKey: 'work-unit', agentId: agent.id,
        title: '生成报告', description: '只读检查。', inputs: [], expectedOutput: '报告', directoryIds: [directoryId],
        requiredCapabilities: [], capabilityIds: [], verification: ['报告存在'], mode: 'read_only', requiresIndependentSession: false,
      }],
      qualityGates: [],
    });
    source = store.commandTask(source.id, 'confirm', source.stateVersion, undefined, [executor]);

    const schedule = store.createSchedule({
      sourceTaskId: source.id,
      name: '每日巡检',
      mode: 'report',
      triggerType: 'interval',
      timezone: 'Asia/Shanghai',
      startAt: new Date(Date.now() - 5_000).toISOString(),
      intervalValue: 1,
      intervalUnit: 'day',
      missedPolicy: 'catch_up_once',
      overlapPolicy: 'coalesce',
    });
    expect(schedule.automationBoundary.directoryIds).toEqual([directoryId]);
    expect(schedule.automationBoundary.agents).toEqual([
      expect.objectContaining({ id: agent.id, executor: 'opencode', model: 'test/model' }),
    ]);
    const renamed = store.updateSchedule(schedule.id, { name: '每日只读巡检' });
    expect(renamed.name).toBe('每日只读巡检');
    expect(renamed.nextRunAt).toBe(schedule.nextRunAt);
    const occurrence = store.claimDueScheduleOccurrence();
    expect(occurrence?.status).toBe('running');
    const scheduledTask = store.startScheduleOccurrence(occurrence?.id ?? '', [executor]);
    expect(scheduledTask).toMatchObject({ triggerSource: 'schedule', scheduleOccurrenceId: occurrence?.id, status: 'PREPARING' });
    expect(scheduledTask.id).not.toBe(source.id);

    database.prepare('UPDATE schedule_definitions SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), schedule.id);
    expect(store.claimDueScheduleOccurrence()).toBeNull();
    expect(store.listScheduleOccurrences(schedule.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'queued', reason: 'overlap_coalesced_pending' }),
    ]));

    const discoverySchedule = store.createSchedule({
      sourceTaskId: source.id,
      name: '依赖异常发现',
      mode: 'discover',
      triggerType: 'once',
      timezone: 'Asia/Shanghai',
      startAt: new Date(Date.now() + 60_000).toISOString(),
      missedPolicy: 'catch_up_once',
      overlapPolicy: 'coalesce',
    });
    const discoveryQueued = store.triggerScheduleNow(discoverySchedule.id);
    const discoveryOccurrence = store.claimDueScheduleOccurrence();
    expect(discoveryOccurrence?.id).toBe(discoveryQueued.id);
    const discoveryTask = store.startScheduleOccurrence(discoveryOccurrence?.id ?? '', [executor]);
    expect(discoveryTask.status).toBe('PREPARING');
    database.prepare("UPDATE tasks SET status = 'DELIVERED' WHERE id = ?").run(discoveryTask.id);
    database.prepare(`
      INSERT INTO workflow_events(id, aggregate_type, aggregate_id, event_type, actor_type, message, payload_json, occurred_at)
      VALUES ('event_discovery_finding', 'task', ?, 'work_unit.succeeded', 'executor', '发现依赖异常。', ?, ?)
    `).run(discoveryTask.id, JSON.stringify({ issues: ['锁文件存在高危依赖，需要升级。'], findings: [] }), new Date().toISOString());
    expect(store.reconcileScheduleOccurrences()).toBeGreaterThan(0);
    expect(store.listScheduleOccurrences(discoverySchedule.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: discoveryQueued.id, status: 'awaiting_confirmation', reason: 'discovery_findings: 1' }),
    ]));
    expect(store.getTask(discoveryTask.id)).toMatchObject({ status: 'COMPOSING_PLAN' });
    expect(store.getTask(discoveryTask.id).description).toContain('锁文件存在高危依赖');
    database.prepare("UPDATE tasks SET status = 'RUNNING' WHERE id = ?").run(discoveryTask.id);
    store.reconcileScheduleOccurrences();
    expect(store.listScheduleOccurrences(discoverySchedule.id)[0]?.status).toBe('running');
    database.prepare("UPDATE tasks SET status = 'DELIVERED' WHERE id = ?").run(discoveryTask.id);
    store.reconcileScheduleOccurrences();
    expect(store.listScheduleOccurrences(discoverySchedule.id)[0]?.status).toBe('completed');
    database.close();
  });
});
