import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ProjectSpaceRestorePreview } from '@yanxu/contracts';
import type { SqliteDatabase } from './database.js';
import { writeVersionedArtifact } from './project-space.js';

const schemaVersion = 3;
const manifestRelativePath = 'state/current.json';

type RawRow = Record<string, unknown>;

interface ProjectStatePayload {
  project: RawRow;
  projectSettings: RawRow[];
  directories: RawRow[];
  directoryProfiles: RawRow[];
  agents: RawRow[];
  teams: RawRow[];
  teamMembers: RawRow[];
  tasks: RawRow[];
  taskVersions: RawRow[];
  taskAttachments?: RawRow[];
  plans: RawRow[];
  taskSteps: RawRow[];
  agentSessions: RawRow[];
  permissionRequests: RawRow[];
  permissionGrants: RawRow[];
  preApprovalArtifacts: RawRow[];
  artifacts: RawRow[];
  contextPacks: RawRow[];
  changeManifests: RawRow[];
  designedQualityGates: RawRow[];
  gateResults: RawRow[];
  gateAttempts: RawRow[];
  deliveryConflicts: RawRow[];
  deliveryActions: RawRow[];
  recoveryRecords: RawRow[];
  workflowEvents: RawRow[];
  knowledge: RawRow[];
  deliveryReports: RawRow[];
  runSnapshots: RawRow[];
}

interface ProjectStateManifest {
  schemaVersion: number;
  generatedAt: string;
  payloadHash: string;
  payload: ProjectStatePayload;
}

export interface ProjectSpaceRestoreResult {
  projectId: string;
  restoredTasks: number;
  stoppedTaskIds: string[];
}

export function writeProjectStateManifest(
  database: SqliteDatabase,
  projectId: string,
  projectSpacePath: string,
): { path: string; hash: string; payloadHash: string } {
  const project = row(database, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new Error(`Project ${projectId} is missing while writing ProjectSpace state.`);
  const payload: ProjectStatePayload = {
    project,
    projectSettings: rows(database, 'SELECT * FROM project_settings WHERE project_id = ?', projectId),
    directories: rows(database, 'SELECT * FROM project_directories WHERE project_id = ? ORDER BY scanned_at', projectId),
    directoryProfiles: rows(database, `
      SELECT dp.* FROM directory_profiles dp
      JOIN project_directories pd ON pd.id = dp.directory_id
      WHERE pd.project_id = ? ORDER BY dp.directory_id, dp.version
    `, projectId),
    agents: rows(database, `
      SELECT DISTINCT a.* FROM agent_profiles a
      JOIN team_members tm ON tm.agent_id = a.id
      JOIN tasks t ON t.team_id = tm.team_id
      WHERE t.project_id = ? ORDER BY a.created_at
    `, projectId),
    teams: rows(database, `
      SELECT DISTINCT tm.* FROM teams tm
      JOIN tasks t ON t.team_id = tm.id
      WHERE t.project_id = ? ORDER BY tm.created_at
    `, projectId),
    teamMembers: rows(database, `
      SELECT DISTINCT m.* FROM team_members m
      JOIN tasks t ON t.team_id = m.team_id
      WHERE t.project_id = ? ORDER BY m.team_id, m.position
    `, projectId),
    tasks: rows(database, 'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at', projectId),
    taskVersions: rows(database, `
      SELECT tv.* FROM task_versions tv JOIN tasks t ON t.id = tv.task_id
      WHERE t.project_id = ? ORDER BY tv.task_id, tv.version
    `, projectId),
    taskAttachments: rows(database, `
      SELECT a.* FROM task_attachments a JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? ORDER BY a.task_id, a.created_at
    `, projectId),
    plans: rows(database, `
      SELECT p.* FROM plans p JOIN tasks t ON t.id = p.task_id
      WHERE t.project_id = ? ORDER BY p.task_id, p.version
    `, projectId),
    taskSteps: rows(database, `
      SELECT s.* FROM task_steps s JOIN tasks t ON t.id = s.task_id
      WHERE t.project_id = ? ORDER BY s.task_id, s.position
    `, projectId),
    agentSessions: rows(database, `
      SELECT s.* FROM agent_sessions s JOIN tasks t ON t.id = s.task_id
      WHERE t.project_id = ? ORDER BY s.started_at
    `, projectId),
    permissionRequests: rows(database, `
      SELECT p.* FROM permission_requests p JOIN tasks t ON t.id = p.task_id
      WHERE t.project_id = ? ORDER BY p.created_at
    `, projectId),
    permissionGrants: rows(database, `
      SELECT g.* FROM task_permission_grants g JOIN tasks t ON t.id = g.task_id
      WHERE t.project_id = ? ORDER BY g.created_at
    `, projectId),
    preApprovalArtifacts: rows(database, `
      SELECT a.* FROM preapproval_artifact_versions a JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? ORDER BY a.task_id, a.created_at
    `, projectId),
    artifacts: rows(database, `
      SELECT a.* FROM artifact_versions a JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? ORDER BY a.task_id, a.created_at
    `, projectId),
    contextPacks: rows(database, `
      SELECT c.* FROM context_packs c JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id = ? ORDER BY c.created_at
    `, projectId),
    changeManifests: rows(database, `
      SELECT c.* FROM change_manifests c JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id = ? ORDER BY c.created_at
    `, projectId),
    designedQualityGates: rows(database, `
      SELECT g.* FROM task_designed_gates g JOIN tasks t ON t.id = g.task_id
      WHERE t.project_id = ? ORDER BY g.created_at
    `, projectId),
    gateResults: rows(database, `
      SELECT g.* FROM gate_results g JOIN tasks t ON t.id = g.task_id
      WHERE t.project_id = ? ORDER BY g.completed_at
    `, projectId),
    gateAttempts: rows(database, `
      SELECT g.* FROM gate_attempts g JOIN tasks t ON t.id = g.task_id
      WHERE t.project_id = ? ORDER BY g.started_at
    `, projectId),
    deliveryConflicts: rows(database, `
      SELECT c.* FROM delivery_conflicts c JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id = ? ORDER BY c.created_at
    `, projectId),
    deliveryActions: rows(database, `
      SELECT a.* FROM delivery_actions a JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ? ORDER BY a.created_at
    `, projectId),
    recoveryRecords: rows(database, `
      SELECT r.* FROM recovery_records r JOIN tasks t ON t.id = r.task_id
      WHERE t.project_id = ? ORDER BY r.created_at
    `, projectId),
    workflowEvents: rows(database, `
      SELECT e.* FROM workflow_events e
      WHERE (e.aggregate_type = 'project' AND e.aggregate_id = ?)
        OR (e.aggregate_type = 'task' AND e.aggregate_id IN (
          SELECT id FROM tasks WHERE project_id = ?
        ))
      ORDER BY e.seq
    `, projectId, projectId),
    knowledge: rows(database, 'SELECT * FROM knowledge_items WHERE project_id = ? ORDER BY created_at', projectId),
    deliveryReports: rows(database, `
      SELECT r.* FROM delivery_reports r JOIN tasks t ON t.id = r.task_id
      WHERE t.project_id = ? ORDER BY r.created_at
    `, projectId),
    runSnapshots: rows(database, `
      SELECT s.* FROM run_snapshots s JOIN tasks t ON t.id = s.task_id
      WHERE t.project_id = ? ORDER BY s.created_at
    `, projectId),
  };
  const payloadHash = sha256(JSON.stringify(payload));
  const manifest: ProjectStateManifest = {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    payloadHash,
    payload,
  };
  const artifact = writeVersionedArtifact(
    projectSpacePath,
    manifestRelativePath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { ...artifact, payloadHash };
}

export function previewProjectStateRestore(
  projectSpacePath: string,
  options: { verifyArtifacts?: boolean } = {},
): ProjectSpaceRestorePreview {
  const manifestPath = join(projectSpacePath, manifestRelativePath);
  const issues: string[] = [];
  let manifest: ProjectStateManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProjectStateManifest;
  } catch (error) {
    issues.push(`无法读取状态清单：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest) return emptyPreview(projectSpacePath, manifestPath, issues);
  if (![2, schemaVersion].includes(manifest.schemaVersion)) issues.push(`不支持的状态清单版本：${manifest.schemaVersion}`);
  if (!manifest.payload || typeof manifest.payload !== 'object') {
    issues.push('状态清单缺少 payload。');
    return emptyPreview(projectSpacePath, manifestPath, issues);
  }
  const actualPayloadHash = sha256(JSON.stringify(manifest.payload));
  if (actualPayloadHash !== manifest.payloadHash) issues.push('状态清单 payload 哈希不一致。');
  const projectId = stringValue(manifest.payload.project.id);
  const projectName = stringValue(manifest.payload.project.name);
  if (!projectId || !projectName) issues.push('状态清单缺少有效的项目 ID 或名称。');

  if (options.verifyArtifacts !== false) {
    for (const artifact of artifactReferences(manifest.payload, projectSpacePath)) {
      if (!artifact.path || !isWithin(projectSpacePath, artifact.path)) {
        issues.push(`${artifact.label} 的路径不在 ProjectSpace 内。`);
        continue;
      }
      if (!existsSync(artifact.path)) {
        issues.push(`${artifact.label} 文件不存在：${artifact.path}`);
        continue;
      }
      const actualHash = sha256(readFileSync(artifact.path));
      if (actualHash !== artifact.hash) issues.push(`${artifact.label} 内容哈希不一致。`);
    }
  }

  return {
    valid: issues.length === 0,
    projectId,
    projectName,
    projectSpacePath,
    manifestPath,
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    payloadHash: manifest.payloadHash,
    counts: payloadCounts(manifest.payload),
    issues,
  };
}

export function restoreProjectState(
  database: SqliteDatabase,
  projectSpacePath: string,
): ProjectSpaceRestoreResult {
  const preview = previewProjectStateRestore(projectSpacePath);
  if (!preview.valid) throw new Error(`ProjectSpace 状态清单无效：${preview.issues.join('；')}`);
  const manifest = JSON.parse(readFileSync(preview.manifestPath, 'utf8')) as ProjectStateManifest;
  if (row(database, 'SELECT id FROM projects WHERE id = ?', preview.projectId)) {
    throw new Error(`项目 ${preview.projectId} 已存在，恢复操作不会覆盖现有数据库。`);
  }
  const stoppedTaskIds: string[] = [];
  const safeStatuses = new Set(['DRAFT', 'WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL', 'STOPPED', 'DELIVERED', 'ARCHIVED', 'CANCELLED']);
  database.transaction(() => {
    insertRaw(database, 'projects', {
      ...manifest.payload.project,
      project_space_path: projectSpacePath,
    });
    for (const item of manifest.payload.directories) insertRaw(database, 'project_directories', item);
    for (const item of manifest.payload.projectSettings) {
      insertRaw(database, 'project_settings', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.agents) insertRaw(database, 'agent_profiles', item, true);
    for (const item of manifest.payload.teams) insertRaw(database, 'teams', { ...item, is_default: 0 }, true);
    for (const item of manifest.payload.teamMembers) insertRaw(database, 'team_members', item, true);
    for (const item of manifest.payload.tasks) {
      const status = stringValue(item.status);
      const restoredStatus = safeStatuses.has(status) ? status : 'STOPPED';
      if (restoredStatus === 'STOPPED' && status !== 'STOPPED') stoppedTaskIds.push(stringValue(item.id));
      insertRaw(database, 'tasks', {
        ...item,
        status: restoredStatus,
        active_step_id: null,
      });
    }
    for (const item of manifest.payload.taskVersions) {
      insertRaw(database, 'task_versions', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.taskAttachments ?? []) {
      insertRaw(database, 'task_attachments', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.plans) {
      insertRaw(database, 'plans', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.taskSteps) {
      const taskStopped = stoppedTaskIds.includes(stringValue(item.task_id));
      insertRaw(database, 'task_steps', taskStopped && item.status === 'running'
        ? { ...item, status: 'failed', summary: '数据库恢复后需要重新执行该步骤。', completed_at: new Date().toISOString() }
        : item);
    }
    for (const item of manifest.payload.agentSessions) {
      const taskStopped = stoppedTaskIds.includes(stringValue(item.task_id));
      insertRaw(database, 'agent_sessions', rebaseArtifactPath(
        taskStopped && item.status === 'running'
          ? {
            ...item,
            status: 'interrupted',
            error: item.error ?? '数据库恢复后原执行会话不可重连。',
            completed_at: new Date().toISOString(),
          }
          : item,
        manifest.payload.project,
        projectSpacePath,
      ));
    }
    for (const item of manifest.payload.permissionRequests) {
      const taskStopped = stoppedTaskIds.includes(stringValue(item.task_id));
      insertRaw(database, 'permission_requests', taskStopped && item.status === 'pending'
        ? {
          ...item,
          status: 'resolved',
          decision: 'reject',
          message: '数据库恢复后原权限请求已失效。',
          resolved_at: new Date().toISOString(),
        }
        : item);
    }
    for (const item of manifest.payload.permissionGrants) insertRaw(database, 'task_permission_grants', item);
    for (const item of manifest.payload.directoryProfiles) {
      insertRaw(database, 'directory_profiles', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.preApprovalArtifacts) {
      insertRaw(database, 'preapproval_artifact_versions', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.artifacts) {
      insertRaw(database, 'artifact_versions', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.contextPacks) {
      insertRaw(database, 'context_packs', rebaseNamedPath(item, 'manifest_path', manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.changeManifests) {
      insertRaw(database, 'change_manifests', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.designedQualityGates) insertRaw(database, 'task_designed_gates', item);
    for (const item of manifest.payload.gateResults) insertRaw(database, 'gate_results', item);
    for (const item of manifest.payload.gateAttempts) insertRaw(database, 'gate_attempts', item);
    for (const item of manifest.payload.deliveryConflicts) insertRaw(database, 'delivery_conflicts', item);
    for (const item of manifest.payload.deliveryActions) insertRaw(database, 'delivery_actions', item);
    for (const item of manifest.payload.recoveryRecords) insertRaw(database, 'recovery_records', item);
    for (const item of manifest.payload.knowledge) {
      insertRaw(database, 'knowledge_items', item);
      if (item.status === 'active') {
        database.prepare('INSERT INTO context_fts(entity_id, project_id, title, content) VALUES (?, ?, ?, ?)')
          .run(item.id, item.project_id, item.title, item.content);
      }
    }
    for (const item of manifest.payload.deliveryReports) {
      insertRaw(database, 'delivery_reports', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.runSnapshots) {
      insertRaw(database, 'run_snapshots', rebaseArtifactPath(item, manifest.payload.project, projectSpacePath));
    }
    for (const item of manifest.payload.workflowEvents) {
      const event = { ...item };
      delete event.seq;
      insertRaw(database, 'workflow_events', event, true);
    }
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO workflow_events(
        id, aggregate_type, aggregate_id, event_type, actor_type, message, payload_json, occurred_at
      ) VALUES (?, 'project', ?, 'project.restored', 'system', ?, ?, ?)
    `).run(`evt_restore_${Date.now()}`, preview.projectId, '已从 ProjectSpace 状态清单恢复项目。',
      JSON.stringify({ manifestPath: preview.manifestPath, stoppedTaskIds }), timestamp);
  })();
  return {
    projectId: preview.projectId,
    restoredTasks: manifest.payload.tasks.length,
    stoppedTaskIds,
  };
}

function artifactReferences(payload: ProjectStatePayload, projectSpacePath: string): Array<{ label: string; path: string; hash: string }> {
  const project = payload.project;
  const collections: Array<[string, RawRow[]]> = [
    ['project-settings', payload.projectSettings],
    ['directory-profile', payload.directoryProfiles],
    ['task-version', payload.taskVersions],
    ['attachment', payload.taskAttachments ?? []],
    ['plan', payload.plans],
    ['preapproval', payload.preApprovalArtifacts],
    ['artifact', payload.artifacts],
    ['context-pack', payload.contextPacks.map((item) => ({
      ...item,
      artifact_path: item.manifest_path,
    }))],
    ['change-manifest', payload.changeManifests],
    ['delivery-report', payload.deliveryReports],
    ['snapshot', payload.runSnapshots],
  ];
  return collections.flatMap(([type, items]) => items.map((item) => ({
    label: `${type}:${stringValue(item.id ?? item.project_id)}`,
    path: rebasedPath(stringValue(item.artifact_path), project, projectSpacePath),
    hash: stringValue(item.content_hash),
  }))).filter((item) => item.path && item.hash);
}

function rebaseNamedPath(
  item: RawRow,
  field: string,
  project: RawRow,
  projectSpacePath: string,
): RawRow {
  const rebased = rebaseArtifactPath(item, project, projectSpacePath);
  if (item[field]) rebased[field] = rebasedPath(stringValue(item[field]), project, projectSpacePath);
  return rebased;
}

function rebaseArtifactPath(item: RawRow, project: RawRow, projectSpacePath: string): RawRow {
  const previousRoot = stringValue(project.project_space_path);
  const rebased = { ...item };
  if (item.artifact_path) {
    rebased.artifact_path = rebasedPath(stringValue(item.artifact_path), project, projectSpacePath);
  }
  if (previousRoot && previousRoot !== projectSpacePath) {
    for (const [key, value] of Object.entries(rebased)) {
      if (typeof value === 'string' && key.endsWith('_json') && value.includes(previousRoot)) {
        rebased[key] = value.replaceAll(previousRoot, projectSpacePath);
      }
    }
  }
  return rebased;
}

function rebasedPath(path: string, project: RawRow, projectSpacePath: string): string {
  if (!path) return '';
  const previousRoot = stringValue(project.project_space_path);
  if (previousRoot && isAbsolute(path)) {
    const relativePath = relative(previousRoot, path);
    if (relativePath !== '..' && !relativePath.startsWith('../')) return join(projectSpacePath, relativePath);
  }
  return isAbsolute(path) ? path : join(projectSpacePath, path);
}

function isWithin(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate !== '..' && !candidate.startsWith('../') && !isAbsolute(candidate);
}

function payloadCounts(payload: ProjectStatePayload): ProjectSpaceRestorePreview['counts'] {
  return {
    directories: payload.directories.length,
    teams: payload.teams.length,
    agents: payload.agents.length,
    tasks: payload.tasks.length,
    taskVersions: payload.taskVersions.length,
    plans: payload.plans.length,
    artifacts: payload.preApprovalArtifacts.length + payload.artifacts.length + (payload.taskAttachments?.length ?? 0),
    knowledge: payload.knowledge.length,
    snapshots: payload.runSnapshots.length,
  };
}

function emptyPreview(projectSpacePath: string, manifestPath: string, issues: string[]): ProjectSpaceRestorePreview {
  return {
    valid: false,
    projectId: '',
    projectName: '',
    projectSpacePath,
    manifestPath,
    schemaVersion: 0,
    generatedAt: '',
    payloadHash: '',
    counts: {
      directories: 0,
      teams: 0,
      agents: 0,
      tasks: 0,
      taskVersions: 0,
      plans: 0,
      artifacts: 0,
      knowledge: 0,
      snapshots: 0,
    },
    issues,
  };
}

function insertRaw(database: SqliteDatabase, table: string, item: RawRow, ignore = false): void {
  const columns = Object.keys(item);
  if (columns.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  database.prepare(`${ignore ? 'INSERT OR IGNORE' : 'INSERT'} INTO ${table}(${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((column) => item[column]));
}

function row(database: SqliteDatabase, sql: string, parameter: string): RawRow | undefined {
  return database.prepare(sql).get(parameter) as RawRow | undefined;
}

function rows(database: SqliteDatabase, sql: string, ...parameters: string[]): RawRow[] {
  return database.prepare(sql).all(...parameters) as RawRow[];
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
