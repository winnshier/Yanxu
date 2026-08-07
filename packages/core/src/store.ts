import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { builtinRoles, builtinSkills, defaultExecutionSkillIds } from '@yanxu/builtins';
import { YANXU_VERSION } from '@yanxu/contracts';
import type {
  AgentProfile,
  AnswerPlanInput,
  ArtifactVersion,
  BranchRoute,
  ChangeManifest,
  Capability,
  CapabilityDiscoveryReport,
  CapabilityProjection,
  CapabilitySource,
  ContextPackSource,
  CreateAgentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTeamInput,
  DashboardData,
  DeliveryAction,
  DeliveryConflict,
  DirectoryProfileVersion,
  ExecutionFailureRecord,
  ExecutionPlanStep,
  ExecutorInstallation,
  ExecutorRuntimeValidation,
  GateAttempt,
  JobExecutionContext,
  KnowledgeItem,
  PermissionManifest,
  PermissionRequest,
  PlanQuestionOption,
  PreApprovalArtifactVersion,
  Project,
  ProjectCapability,
  ProjectCapabilityUpdateInput,
  ProjectDirectory,
  ProjectSettings,
  ProjectSpaceOperation,
  ProjectSpaceIntegrityReport,
  ProjectSpaceRestorePreview,
  QualityGate,
  ReviewFinding,
  RequestPlanRevisionInput,
  RoleTemplate,
  RoleTemplateChangePreview,
  SkillArtifactOutput,
  SystemSettings,
  SystemDiagnostics,
  Task,
  TaskAttachment,
  TaskContextPack,
  TaskCapabilitySnapshot,
  TaskDiagnostics,
  TaskEvidence,
  TaskPlan,
  TaskRunSnapshot,
  TaskRunSnapshotSummary,
  TaskStatus,
  TaskStep,
  TaskVersionSummary,
  Team,
  UpdateProjectSettingsInput,
  WorkflowEvent,
} from '@yanxu/contracts';
import { DATABASE_SCHEMA_VERSION, type SqliteDatabase } from './database.js';
import { DomainError } from './errors.js';
import { classifyExecutionFailure } from './execution-failure.js';
import { scanProjectDirectory } from './directory-scanner.js';
import { commandPatternsForPlanPermissions } from './plan-permissions.js';
import { buildIndexedPlanningContext, type PlanningDirectoryContext } from './planning-context.js';
import { commitProjectSpace as commitProjectSpaceGit, ensureProjectSpace, writeVersionedArtifact } from './project-space.js';
import {
  previewProjectStateRestore,
  restoreProjectState,
  writeProjectStateManifest,
  type ProjectSpaceRestoreResult,
} from './project-state.js';
import { transitionTask, type TaskCommand } from './transitions.js';
import { workingTreeFingerprint, type MergeResult, type PreparedWorkspace } from './git-workspace.js';
import type { GitChangeInspection } from './git-workspace.js';
import { discoverLocalCapabilities, inspectSkillDirectory, type DiscoveredCapability } from './capabilities.js';
import { discoverRoleTemplates, type DiscoveredRoleTemplate } from './roles.js';

interface ProjectRow {
  id: string; name: string; description: string; project_space_path: string; created_at: string; updated_at: string;
}
interface DirectoryRow {
  id: string; project_id: string; display_name: string; selected_path: string; real_path: string; git_root_path: string | null;
  git_initialized: number; current_branch: string | null; is_dirty: number; content_types_json: string; stack_json: string;
  commands_json: string; scanned_at: string; removed_at: string | null;
}
interface AgentRow {
  id: string; name: string; role_id: string; executor: AgentProfile['executor']; model: string; parameters_json: string;
  default_capability_ids_json: string; permission_mode: AgentProfile['permissionMode']; status: AgentProfile['status']; created_at: string; updated_at: string;
}
interface TeamRow {
  id: string; name: string; description: string; is_default: number; created_at: string; updated_at: string;
}
interface TaskRow {
  id: string; project_id: string; team_id: string; project_name: string; team_name: string; title: string; description: string;
  expected_output: string; constraints_text: string; forbidden_paths_json: string; status: TaskStatus; state_version: number;
  active_step_id: string | null; flow_version: 1 | 2; created_at: string; updated_at: string;
}
interface PlanRow {
  id: string; task_id: string; version: number; content_json: string; created_at: string; confirmed_at: string | null;
}
interface TaskVersionRow {
  id: string; task_id: string; version: number; artifact_path: string; content_hash: string;
  status: TaskVersionSummary['status']; created_at: string;
}
interface TaskAttachmentRow {
  id: string; task_id: string; file_name: string; artifact_path: string; content_hash: string;
  size_bytes: number; created_at: string;
}
interface StepRow {
  id: string; task_id: string; position: number; skill_id: string; agent_id: string | null; title: string; description: string;
  inputs_json: string; expected_output: string; directory_ids_json: string; status: TaskStep['status']; attempt: number;
  started_at: string | null; completed_at: string | null; summary: string | null;
  unit_kind: TaskStep['kind']; required_capabilities_json: string; verification_json: string;
  capability_ids_json: string; execution_mode: TaskStep['mode']; requires_independent_session: number;
}
interface CapabilityRow {
  id: string; origin_key: string; kind: Capability['kind']; name: string; description: string;
  source_type: Capability['source']['type']; source_scope: Capability['source']['scope'];
  source_executor: Capability['source']['executor']; source_ref: string; source_version: string | null;
  version: string; content_hash: string; compatibility_json: string; lifecycle_status: Capability['lifecycleStatus'];
  parse_status: Capability['parseStatus']; parse_error: string | null; command_status: Capability['commandStatus'];
  runtime_health: Capability['runtimeHealth']; credential_refs_json: string; manifest_json: string; managed_path: string | null;
  security_json: string; last_discovered_at: string; created_at: string; updated_at: string;
}
interface ProjectCapabilityRow {
  project_id: string; capability_id: string; enabled: number; locked_version: string; locked_hash: string;
  configuration_json: string; enabled_at: string | null; updated_at: string;
}
interface TaskCapabilityRow {
  id: string; task_id: string; step_id: string; agent_id: string; capability_id: string;
  kind: TaskCapabilitySnapshot['kind']; name: string; version: string; content_hash: string;
  executor: TaskCapabilitySnapshot['executor']; configuration_json: string; projection_path: string | null;
  status: TaskCapabilitySnapshot['status']; error: string | null; created_at: string;
}
interface RoleTemplateRow {
  id: string; origin_key: string; name: string; description: string; instructions: string;
  responsibilities_json: string; capability_ids_json: string; dependency_names_json: string;
  default_permissions_json: string; compatibility_json: string;
  source_type: RoleTemplate['source']['type']; source_scope: RoleTemplate['source']['scope'];
  source_executor: RoleTemplate['source']['executor']; source_ref: string; source_version: string | null;
  version: string; content_hash: string; lifecycle_status: 'draft' | 'installed';
  parse_status: RoleTemplate['parseStatus']; parse_error: string | null; format: string;
  managed_path: string | null; created_at: string; updated_at: string;
}
interface RoleTemplateVersionRow {
  id: string; role_id: string; version: string; content_hash: string; content_json: string;
  managed_path: string; created_at: string;
}
interface EventRow {
  seq: number; id: string; aggregate_type: string; aggregate_id: string; event_type: string; actor_type: WorkflowEvent['actorType'];
  message: string; payload_json: string; occurred_at: string;
}
interface KnowledgeRow {
  id: string; project_id: string; category: KnowledgeItem['category']; title: string; content: string; status: KnowledgeItem['status'];
  source_task_id: string | null; version: number; supersedes_id: string | null; created_at: string; updated_at: string;
}

export interface ClaimedJob {
  id: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string;
}

interface JobRow {
  id: string; type: string; aggregate_id: string; payload_json: string; attempt: number; max_attempts: number;
}

interface PermissionRow {
  id: string; task_id: string; session_id: string; permission: string; patterns_json: string; metadata_json: string;
  status: PermissionRequest['status']; decision: PermissionRequest['decision']; message: string | null; created_at: string; resolved_at: string | null;
  previous_task_status: TaskStatus;
}

interface WorkspaceRow {
  task_id: string; directory_id: string; workspace_path: string; baseline_commit: string; task_branch: string; target_branch: string;
  real_path: string; git_root_path: string | null;
}

interface SnapshotRow {
  id: string;
  task_id: string;
  plan_id: string;
  plan_version: number;
  content_json: string;
  content_hash: string;
  artifact_path: string;
  created_at: string;
}

interface GateResultInput {
  id: string;
  directoryId: string;
  command: string;
  status: 'passed' | 'failed';
  exitCode: number;
  logPath: string;
  startedAt: string;
  completedAt: string;
  attempt: number;
  commandArgv: string[];
  signal: string | null;
  timedOut: boolean;
}

interface ArtifactRow {
  id: string; task_id: string; step_id: string; skill_id: string; artifact_type: string; title: string; version: number;
  status: ArtifactVersion['status']; artifact_path: string; content_hash: string; source_session_id: string | null;
  metadata_json: string; created_at: string;
}

interface ContextPackRow {
  id: string; task_id: string; step_id: string; attempt: number; manifest_path: string; content_hash: string;
  source_count: number; estimated_tokens: number; truncated: number; created_at: string;
}

interface ChangeManifestRow {
  id: string; task_id: string; step_id: string; attempt: number; directory_id: string; base_commit: string;
  checkpoint_commit: string; artifact_path: string; content_hash: string; has_out_of_scope_changes: number;
  has_sensitive_changes: number; created_at: string;
}

interface GateAttemptRow {
  id: string; task_id: string; gate_id: string; attempt: number; directory_id: string; command_argv_json: string;
  status: GateAttempt['status']; exit_code: number | null; signal: string | null; timed_out: number; log_path: string;
  started_at: string; completed_at: string;
}

interface DesignedGateRow {
  id: string;
  task_id: string;
  source_step_id: string;
  name: string;
  command_argv_json: string;
  directory_id: string;
  required: number;
  timeout_ms: number;
  expected_exit_codes_json: string;
  created_at: string;
}

interface DeliveryConflictRow {
  id: string;
  task_id: string;
  directory_id: string;
  task_branch: string;
  target_branch: string;
  classification: DeliveryConflict['classification'];
  conflicts_json: string;
  mechanically_resolvable_files_json: string;
  status: DeliveryConflict['status'];
  resolution: DeliveryConflict['resolution'];
  created_at: string;
  resolved_at: string | null;
}

interface DirectoryProfileRow {
  id: string;
  directory_id: string;
  version: number;
  status: DirectoryProfileVersion['status'];
  content_json: string;
  artifact_path: string;
  content_hash: string;
  created_at: string;
  confirmed_at: string | null;
}

interface ProjectSpaceOperationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  operation: string;
  commit_hash: string | null;
  changed_files_json: string;
  status: ProjectSpaceOperation['status'];
  error: string | null;
  created_at: string;
}

interface RecoveryRecordRow {
  id: string;
  task_id: string;
  job_id: string | null;
  reason: string;
  previous_owner: string | null;
  recovered_by: string | null;
  action: string;
  created_at: string;
}

interface DeliveryActionRow {
  id: string;
  task_id: string;
  action: DeliveryAction['action'];
  status: DeliveryAction['status'];
  details_json: string;
  created_at: string;
}
interface AgentSessionRow {
  id: string;
  task_id: string;
  step_id: string;
  agent_id: string | null;
  executor: AgentProfile['executor'];
  model: string;
  external_session_id: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  result_path: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface DeliveryReportRow {
  artifact_path: string;
  content_hash: string;
  content_json: string;
  created_at: string;
}

interface PreApprovalArtifactRow {
  id: string;
  task_id: string;
  plan_id: string;
  artifact_type: string;
  title: string;
  version: number;
  status: PreApprovalArtifactVersion['status'];
  artifact_path: string;
  content_hash: string;
  source_executor: PreApprovalArtifactVersion['sourceExecutor'];
  source_model: string;
  source_session_id: string | null;
  created_at: string;
}

export interface PreApprovalArtifactInput {
  artifactType: string;
  title: string;
  content: string;
  sourceExecutor: PreApprovalArtifactVersion['sourceExecutor'];
  sourceModel: string;
  sourceSessionId: string | null;
}

const attentionStates: TaskStatus[] = ['WAITING_PLAN_APPROVAL', 'WAITING_APPROVAL', 'WAITING_REAPPROVAL', 'BLOCKED', 'STOPPED', 'REOPENED'];
const activeStates: TaskStatus[] = ['COMPOSING_PLAN', 'PREPARING', 'QUEUED', 'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING'];

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function createPlanQuestionOptions(
  options: Array<Omit<PlanQuestionOption, 'id' | 'recommended'> & { recommended?: boolean }>,
): PlanQuestionOption[] {
  const recommendedIndex = options.findIndex((option) => option.recommended);
  const firstIndex = recommendedIndex >= 0 ? recommendedIndex : 0;
  const ordered = [
    options[firstIndex]!,
    ...options.filter((_, index) => index !== firstIndex),
  ];
  return ordered.map((option, index) => ({
    id: id('option'),
    label: option.label,
    description: option.description,
    value: option.value,
    recommended: index === 0,
  }));
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function git(path: string, args: string[]): string {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : '';
}

export class YanxuStore {
  readonly workbenchHome: string;

  constructor(private readonly database: SqliteDatabase, workbenchHome?: string) {
    this.workbenchHome = workbenchHome ?? process.env.YANXU_HOME ?? join(homedir(), '.yanxu');
    for (const directory of ['system', 'projects', 'capabilities', 'runtime/tasks', 'runtime/logs', 'runtime/tmp', 'cache/context']) {
      mkdirSync(join(this.workbenchHome, directory), { recursive: true });
    }
    this.reconcilePreparedProjectSpaceOperations();
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const timestamp = now();
    const defaults: Record<string, unknown> = {
      maxParallelTasks: 2,
      retryLimit: 2,
      sessionTimeoutMs: 30 * 60_000,
      gateTimeoutMs: 10 * 60_000,
      coordinatorExecutor: 'opencode',
      coordinatorModel: '',
      permissionMode: 'standard',
      networkPolicy: 'ask',
      dependencyInstallPolicy: 'ask',
    };
    const insert = this.database.prepare('INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)');
    for (const [key, value] of Object.entries(defaults)) insert.run(key, JSON.stringify(value), timestamp);

    const team = this.database.prepare('SELECT id FROM teams WHERE is_default = 1').get() as { id: string } | undefined;
    if (!team) {
      this.database.prepare(`
        INSERT INTO teams(id, name, description, is_default, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(id('team'), '默认团队', '新任务默认选择的团队，可在 AI 团队中添加人员。', timestamp, timestamp);
    }
  }

  getSettings(executors: ExecutorInstallation[] = []): SystemSettings {
    const rows = this.database.prepare('SELECT key, value_json FROM settings').all() as Array<{ key: string; value_json: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.key, parseJson<unknown>(row.value_json, null)]));
    const coordinatorExecutor = (values.coordinatorExecutor ?? 'opencode') as SystemSettings['coordinatorExecutor'];
    const coordinatorModel = typeof values.coordinatorModel === 'string' ? values.coordinatorModel : '';
    const installation = executors.find((executor) => executor.id === coordinatorExecutor);
    return {
      maxParallelTasks: Number(values.maxParallelTasks ?? 2),
      retryLimit: Number(values.retryLimit ?? 2),
      sessionTimeoutMs: Number(values.sessionTimeoutMs ?? 30 * 60_000),
      gateTimeoutMs: Number(values.gateTimeoutMs ?? 10 * 60_000),
      coordinatorExecutor,
      coordinatorModel,
      coordinatorReady: Boolean(installation?.health === 'available' && coordinatorModel),
      permissionMode: (values.permissionMode ?? 'standard') as SystemSettings['permissionMode'],
      networkPolicy: (values.networkPolicy ?? 'ask') as SystemSettings['networkPolicy'],
      dependencyInstallPolicy: (values.dependencyInstallPolicy ?? 'ask') as SystemSettings['dependencyInstallPolicy'],
      workbenchHome: this.workbenchHome,
    };
  }

  updateSettings(patch: Partial<Omit<SystemSettings, 'coordinatorReady' | 'workbenchHome'>>): SystemSettings {
    const statement = this.database.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    const write = this.database.transaction(() => {
      for (const [key, value] of Object.entries(patch)) statement.run(key, JSON.stringify(value), now());
    });
    write();
    return this.getSettings();
  }

  saveExecutorValidation(result: ExecutorRuntimeValidation): ExecutorRuntimeValidation {
    this.database.prepare(`
      INSERT INTO executor_validations(
        executor, status, message, version, capabilities_json, models_json, login_status, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(executor) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        version = excluded.version,
        capabilities_json = excluded.capabilities_json,
        models_json = excluded.models_json,
        login_status = excluded.login_status,
        checked_at = excluded.checked_at
    `).run(result.executor, result.status, result.message, result.version, JSON.stringify(result.capabilities),
      JSON.stringify(result.models), result.loginStatus, result.checkedAt);
    return result;
  }

  listExecutorValidations(): ExecutorRuntimeValidation[] {
    return (this.database.prepare('SELECT * FROM executor_validations ORDER BY executor').all() as Array<{
      executor: ExecutorRuntimeValidation['executor'];
      status: ExecutorRuntimeValidation['status'];
      message: string;
      version: string | null;
      capabilities_json: string;
      models_json: string;
      login_status: ExecutorRuntimeValidation['loginStatus'];
      checked_at: string;
    }>).map((row) => ({
      executor: row.executor,
      status: row.status,
      message: row.message,
      version: row.version,
      capabilities: parseJson(row.capabilities_json, []),
      models: parseJson(row.models_json, []),
      loginStatus: row.login_status,
      checkedAt: row.checked_at,
    }));
  }

  recordExecutorRuntimeCheck(
    taskId: string,
    stepId: string,
    installation: ExecutorInstallation,
    expected?: NonNullable<TaskRunSnapshot['executors']>[number],
  ): void {
    const versionDrift = Boolean(expected?.version && installation.version && expected.version !== installation.version);
    const executableDrift = Boolean(expected?.executableHash && installation.path
      && expected.executableHash !== sha256(installation.path));
    this.appendEvent(
      'task',
      taskId,
      versionDrift || executableDrift ? 'executor.runtime_drift' : 'executor.runtime_checked',
      'scheduler',
      versionDrift || executableDrift
        ? `${installation.name} 的本地运行环境与任务确认快照不同，已记录差异并继续按当前兼容契约执行。`
        : `${installation.name} 运行环境与任务快照兼容。`,
      {
        stepId,
        executor: installation.id,
        expectedVersion: expected?.version ?? null,
        currentVersion: installation.version,
        versionDrift,
        executableDrift,
        capabilities: installation.capabilities,
      },
    );
  }

  systemDiagnostics(): SystemDiagnostics {
    const quickCheck = this.database.pragma('quick_check') as Array<{ quick_check: string }>;
    const count = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count;
    const runtimeTaskRoot = join(this.workbenchHome, 'runtime', 'tasks');
    const daemonLogPath = join(this.workbenchHome, 'system', 'logs', 'daemon.log');
    const databaseSchemaVersion = (this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number }).version;
    const migrationRecoveryPoints = (this.database.prepare(`
      SELECT id, from_version, to_version, backup_path, status, created_at, restored_at
      FROM migration_recovery_points ORDER BY created_at DESC LIMIT 20
    `).all() as Array<{
      id: string; from_version: number; to_version: number; backup_path: string;
      status: 'created' | 'restored'; created_at: string; restored_at: string | null;
    }>).map((row) => ({
      id: row.id,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      backupPath: row.backup_path,
      status: row.status,
      createdAt: row.created_at,
      restoredAt: row.restored_at,
    }));
    return {
      appVersion: YANXU_VERSION,
      databaseSchemaVersion,
      latestDatabaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      databaseCheck: quickCheck.every((row) => row.quick_check === 'ok') ? 'ok' : 'error',
      indexedProjectFiles: count('SELECT COUNT(*) AS count FROM project_file_index'),
      indexedKnowledgeEntries: count('SELECT COUNT(*) AS count FROM context_fts'),
      runtimeTaskDirectories: existsSync(runtimeTaskRoot)
        ? readdirSync(runtimeTaskRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
        : 0,
      recoveryRecords: count('SELECT COUNT(*) AS count FROM recovery_records'),
      projectSpaceFailedOperations: count(`SELECT COUNT(*) AS count FROM project_space_operations WHERE status = 'failed'`),
      gitVersion: git(process.cwd(), ['--version']) || null,
      workbenchHome: this.workbenchHome,
      daemonLogPath,
      daemonLogBytes: existsSync(daemonLogPath) ? statSync(daemonLogPath).size : 0,
      migrationRecoveryPoints,
    };
  }

  listProjects(): Project[] {
    const rows = this.database.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  getProject(projectId: string): Project {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
    if (!row) throw new DomainError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    return this.projectFromRow(row);
  }

  listCapabilities(): Capability[] {
    return (this.database.prepare(`
      SELECT * FROM capabilities ORDER BY kind, name COLLATE NOCASE, updated_at DESC
    `).all() as CapabilityRow[]).map((row) => this.capabilityFromRow(row));
  }

  getCapability(capabilityId: string): Capability {
    const row = this.database.prepare('SELECT * FROM capabilities WHERE id = ?').get(capabilityId) as CapabilityRow | undefined;
    if (!row) throw new DomainError('CAPABILITY_NOT_FOUND', '能力不存在或已经移除。', 404);
    return this.capabilityFromRow(row);
  }

  discoverCapabilities(projectId?: string): CapabilityDiscoveryReport {
    const directories = projectId
      ? this.getProject(projectId).directories
      : this.listProjects().flatMap((project) => project.directories);
    const scan = discoverLocalCapabilities(directories);
    const scannedAt = now();
    let discovered = 0;
    let updated = 0;
    this.database.transaction(() => {
      for (const candidate of scan.capabilities) {
        const existing = this.database.prepare('SELECT * FROM capabilities WHERE origin_key = ?')
          .get(candidate.originKey) as CapabilityRow | undefined;
        if (existing) {
          const changed = existing.content_hash !== candidate.contentHash
            || existing.parse_status !== candidate.parseStatus
            || existing.command_status !== candidate.commandStatus;
          this.updateDiscoveredCapability(existing.id, candidate, scannedAt);
          if (changed) {
            updated += 1;
            this.appendEvent('capability', existing.id, 'capability.updated', 'system', `能力 ${candidate.name} 的来源内容已变化。`, {
              source: candidate.source,
              version: candidate.version,
              contentHash: candidate.contentHash,
              requiresReinstall: existing.content_hash !== candidate.contentHash,
            });
          }
        } else {
          const capabilityId = id('cap');
          this.insertDiscoveredCapability(capabilityId, candidate, scannedAt);
          this.appendEvent('capability', capabilityId, 'capability.discovered', 'system', `发现${candidate.kind === 'skill' ? ' Skill' : ' MCP'} 能力 ${candidate.name}。`, {
            source: candidate.source,
            parseStatus: candidate.parseStatus,
            commandStatus: candidate.commandStatus,
          });
          discovered += 1;
        }
      }
    })();
    return {
      scannedAt,
      discovered,
      updated,
      invalid: scan.capabilities.filter((item) => item.parseStatus === 'invalid').length,
      removed: 0,
      sourceErrors: scan.sourceErrors,
      capabilities: this.listCapabilities(),
    };
  }

  importLocalSkill(directoryPath: string, sourceOverride?: CapabilitySource): Capability {
    const inspected = inspectSkillDirectory(directoryPath);
    const localSourceRoot = dirname(inspected.source.ref);
    const candidate: DiscoveredCapability = sourceOverride
      ? {
        ...inspected,
        source: sourceOverride,
        version: sourceOverride.version ?? inspected.version,
        originKey: sha256(JSON.stringify({
          kind: inspected.kind,
          name: inspected.name,
          sourceType: sourceOverride.type,
          sourceScope: sourceOverride.scope,
          sourceExecutor: sourceOverride.executor,
          sourceRef: sourceOverride.ref,
        })),
      }
      : inspected;
    if (candidate.parseStatus !== 'valid') {
      throw new DomainError('CAPABILITY_IMPORT_INVALID', candidate.parseError ?? 'SKILL.md 无法解析。', 422, { candidate });
    }
    const timestamp = now();
    const existing = this.database.prepare('SELECT * FROM capabilities WHERE origin_key = ?')
      .get(candidate.originKey) as CapabilityRow | undefined;
    const capabilityId = existing?.id ?? id('cap');
    this.database.transaction(() => {
      if (existing) {
        this.updateDiscoveredCapability(existing.id, candidate, timestamp);
      } else {
        this.insertDiscoveredCapability(capabilityId, candidate, timestamp);
      }
    })();
    const sourceRoot = localSourceRoot;
    const target = join(this.workbenchHome, 'imports', capabilityId, candidate.contentHash);
    const temporary = `${target}.tmp-${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    try {
      for (const file of candidate.security.files) {
        const sourcePath = resolve(sourceRoot, file);
        const relativePath = relative(sourceRoot, sourcePath);
        if (relativePath === '..' || relativePath.startsWith('../')) {
          throw new DomainError('CAPABILITY_FILE_OUTSIDE_SOURCE', `能力文件不在来源目录内：${file}`, 422);
        }
        const targetPath = join(temporary, relativePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    this.database.prepare(`
      UPDATE capabilities SET lifecycle_status = 'imported', managed_path = ?, updated_at = ? WHERE id = ?
    `).run(target, timestamp, capabilityId);
    this.appendEvent('capability', capabilityId, 'capability.imported', 'user', `已导入 Skill ${candidate.name}，等待安装。`, {
      source: candidate.source,
      version: candidate.version,
      contentHash: candidate.contentHash,
    });
    return this.getCapability(capabilityId);
  }

  importGitHubSkills(address: string): Capability[] {
    const parsed = parseGitHubSkillAddress(address);
    const temporaryRoot = join(this.workbenchHome, 'tmp', `github-import-${randomUUID()}`);
    const repositoryRoot = join(temporaryRoot, 'repository');
    mkdirSync(temporaryRoot, { recursive: true });
    try {
      const clone = spawnSync('git', ['clone', '--depth=1', '--no-tags', '--', parsed.cloneUrl, repositoryRoot], {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (clone.status !== 0) {
        throw new DomainError('CAPABILITY_GITHUB_CLONE_FAILED', 'GitHub 仓库读取失败。', 422, {
          message: (clone.stderr || clone.stdout || '').trim().slice(-2_000),
        });
      }
      let selectedRef: string | null = null;
      let selectedSubpath = '';
      if (parsed.treeSegments.length > 0) {
        for (let boundary = 1; boundary <= parsed.treeSegments.length; boundary += 1) {
          const candidateRef = parsed.treeSegments.slice(0, boundary).join('/');
          const fetch = spawnSync('git', ['-C', repositoryRoot, 'fetch', '--depth=1', 'origin', candidateRef], {
            encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          });
          if (fetch.status === 0) {
            selectedRef = candidateRef;
            selectedSubpath = parsed.treeSegments.slice(boundary).join('/');
            break;
          }
        }
        if (!selectedRef) throw new DomainError('CAPABILITY_GITHUB_REF_NOT_FOUND', 'GitHub 分支、标签或提交不存在或无法读取。', 422);
        const checkout = spawnSync('git', ['-C', repositoryRoot, 'checkout', '--detach', 'FETCH_HEAD'], {
          encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        });
        if (checkout.status !== 0) throw new DomainError('CAPABILITY_GITHUB_CHECKOUT_FAILED', 'GitHub 版本检出失败。', 422);
      }
      const targetRoot = resolve(repositoryRoot, selectedSubpath);
      if (!pathWithin(repositoryRoot, targetRoot) || !existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
        throw new DomainError('CAPABILITY_GITHUB_PATH_INVALID', 'GitHub 子目录不存在或超出仓库范围。', 422);
      }
      validateImportedTree(targetRoot);
      const skillDirectories = findSkillDirectories(targetRoot);
      if (skillDirectories.length === 0) {
        throw new DomainError('CAPABILITY_SKILL_NOT_FOUND', '所选 GitHub 地址中没有找到标准 SKILL.md。', 422);
      }
      const commit = git(repositoryRoot, ['rev-parse', 'HEAD']);
      return skillDirectories.map((directory) => {
        const subpath = relative(repositoryRoot, directory).replaceAll('\\', '/');
        return this.importLocalSkill(directory, {
          type: 'github',
          scope: 'managed',
          executor: null,
          ref: `${parsed.canonicalUrl}${subpath ? `#${subpath}` : ''}`,
          version: commit || selectedRef,
        });
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  importZipSkills(archivePath: string): Capability[] {
    if (!archivePath.toLowerCase().endsWith('.zip')) {
      throw new DomainError('CAPABILITY_ARCHIVE_TYPE_INVALID', '当前只支持 ZIP 格式扩展包。', 422);
    }
    const listing = spawnSync('/usr/bin/unzip', ['-Z1', archivePath], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (listing.status !== 0) throw new DomainError('CAPABILITY_ARCHIVE_INVALID', 'ZIP 文件无法读取或已经损坏。', 422);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (entries.length > 2_000) throw new DomainError('CAPABILITY_ARCHIVE_TOO_MANY_FILES', 'ZIP 文件条目超过 2000 个。', 422);
    for (const entry of entries) {
      const normalized = entry.replaceAll('\\', '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new DomainError('CAPABILITY_ARCHIVE_PATH_INVALID', 'ZIP 包含越界路径，已拒绝导入。', 422, { entry });
      }
    }
    const temporaryRoot = join(this.workbenchHome, 'tmp', `zip-import-${randomUUID()}`);
    const extractedRoot = join(temporaryRoot, 'contents');
    mkdirSync(extractedRoot, { recursive: true });
    try {
      const extraction = spawnSync('/usr/bin/ditto', ['-x', '-k', '--', archivePath, extractedRoot], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      });
      if (extraction.status !== 0) throw new DomainError('CAPABILITY_ARCHIVE_EXTRACT_FAILED', 'ZIP 文件解压失败。', 422);
      validateImportedTree(extractedRoot);
      const skillDirectories = findSkillDirectories(extractedRoot);
      if (skillDirectories.length === 0) throw new DomainError('CAPABILITY_SKILL_NOT_FOUND', 'ZIP 中没有找到标准 SKILL.md。', 422);
      return skillDirectories.map((directory) => {
        const subpath = relative(extractedRoot, directory).replaceAll('\\', '/');
        return this.importLocalSkill(directory, {
          type: 'zip',
          scope: 'managed',
          executor: null,
          ref: `${archivePath}${subpath ? `#${subpath}` : ''}`,
          version: null,
        });
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  installCapability(capabilityId: string): Capability {
    const capability = this.getCapability(capabilityId);
    if (capability.parseStatus !== 'valid') {
      throw new DomainError('CAPABILITY_INSTALL_INVALID', '无效能力不能安装，请先处理解析错误。', 422, {
        capabilityId,
        parseError: capability.parseError,
      });
    }
    if (capability.security.containsLiteralSecrets) {
      throw new DomainError('CAPABILITY_LITERAL_SECRET_DETECTED', '能力来源中检测到疑似明文凭据，拒绝安装；请先改为本地环境变量引用。', 422, {
        capabilityId,
        source: capability.source.ref,
      });
    }
    const target = join(this.workbenchHome, 'capabilities', capability.id, capability.contentHash);
    const temporary = `${target}.tmp-${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    try {
      if (capability.kind === 'skill') {
        const sourceRoot = capability.lifecycleStatus === 'imported' && capability.managedPath
          ? capability.managedPath
          : dirname(capability.source.ref);
        for (const file of capability.security.files) {
          const sourcePath = resolve(sourceRoot, file);
          const relativePath = relative(sourceRoot, sourcePath);
          if (relativePath === '..' || relativePath.startsWith('../')) {
            throw new DomainError('CAPABILITY_FILE_OUTSIDE_SOURCE', `能力文件不在来源目录内：${file}`, 422);
          }
          const targetPath = join(temporary, relativePath);
          mkdirSync(dirname(targetPath), { recursive: true });
          copyFileSync(sourcePath, targetPath);
        }
      }
      writeFileSync(join(temporary, 'yanxu-capability.json'), `${JSON.stringify({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        version: capability.version,
        contentHash: capability.contentHash,
        source: capability.source,
        manifest: capability.manifest,
        security: capability.security,
      }, null, 2)}\n`, { mode: 0o600 });
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const timestamp = now();
    this.database.prepare(`
      UPDATE capabilities SET lifecycle_status = 'installed', managed_path = ?, updated_at = ? WHERE id = ?
    `).run(target, timestamp, capabilityId);
    this.appendEvent('capability', capabilityId, 'capability.installed', 'user', `能力 ${capability.name} 已安装到研序托管目录。`, {
      kind: capability.kind,
      version: capability.version,
      contentHash: capability.contentHash,
    });
    return this.getCapability(capabilityId);
  }

  listRoleTemplates(includeDrafts = true): RoleTemplate[] {
    const external = (this.database.prepare(`
      SELECT * FROM role_templates
      ${includeDrafts ? '' : "WHERE lifecycle_status = 'installed'"}
      ORDER BY name COLLATE NOCASE, updated_at DESC
    `).all() as RoleTemplateRow[]).map((row) => this.roleTemplateFromRow(row));
    return [...builtinRoles, ...external];
  }

  getRoleTemplate(roleId: string): RoleTemplate {
    const builtin = builtinRoles.find((role) => role.id === roleId);
    if (builtin) return builtin;
    const row = this.database.prepare('SELECT * FROM role_templates WHERE id = ?').get(roleId) as RoleTemplateRow | undefined;
    if (!row) throw new DomainError('ROLE_NOT_FOUND', 'RoleTemplate 不存在或已经移除。', 404);
    return this.roleTemplateFromRow(row);
  }

  importGitHubRoleTemplates(address: string): RoleTemplate[] {
    const parsed = parseGitHubSkillAddress(address);
    const temporaryRoot = join(this.workbenchHome, 'tmp', `github-role-import-${randomUUID()}`);
    const repositoryRoot = join(temporaryRoot, 'repository');
    mkdirSync(temporaryRoot, { recursive: true });
    try {
      const clone = spawnSync('git', ['clone', '--depth=1', '--no-tags', '--', parsed.cloneUrl, repositoryRoot], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (clone.status !== 0) {
        throw new DomainError('ROLE_GITHUB_CLONE_FAILED', 'GitHub 角色仓库读取失败。', 422, {
          message: (clone.stderr || clone.stdout || '').trim().slice(-2_000),
        });
      }
      let selectedRef: string | null = null;
      let selectedSubpath = '';
      if (parsed.treeSegments.length > 0) {
        for (let boundary = 1; boundary <= parsed.treeSegments.length; boundary += 1) {
          const candidateRef = parsed.treeSegments.slice(0, boundary).join('/');
          const fetch = spawnSync('git', ['-C', repositoryRoot, 'fetch', '--depth=1', 'origin', candidateRef], {
            encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          });
          if (fetch.status === 0) {
            selectedRef = candidateRef;
            selectedSubpath = parsed.treeSegments.slice(boundary).join('/');
            break;
          }
        }
        if (!selectedRef) throw new DomainError('ROLE_GITHUB_REF_NOT_FOUND', 'GitHub 分支、标签或提交不存在或无法读取。', 422);
        const checkout = spawnSync('git', ['-C', repositoryRoot, 'checkout', '--detach', 'FETCH_HEAD'], {
          encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        });
        if (checkout.status !== 0) throw new DomainError('ROLE_GITHUB_CHECKOUT_FAILED', 'GitHub 角色版本检出失败。', 422);
      }
      const targetRoot = resolve(repositoryRoot, selectedSubpath);
      if (!pathWithin(repositoryRoot, targetRoot) || !existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
        throw new DomainError('ROLE_GITHUB_PATH_INVALID', 'GitHub 角色子目录不存在或超出仓库范围。', 422);
      }
      validateImportedTree(targetRoot);
      const commit = git(repositoryRoot, ['rev-parse', 'HEAD']) || selectedRef;
      const importedCapabilities = findSkillDirectories(targetRoot).map((directory) => {
        const subpath = relative(repositoryRoot, directory).replaceAll('\\', '/');
        return this.importLocalSkill(directory, {
          type: 'github', scope: 'managed', executor: null,
          ref: `${parsed.canonicalUrl}${subpath ? `#${subpath}` : ''}`,
          version: commit,
        });
      });
      const candidates = discoverRoleTemplates(targetRoot, {
        type: 'github', scope: 'managed', executor: null,
        ref: `${parsed.canonicalUrl}${selectedSubpath ? `#${selectedSubpath}` : ''}`,
        version: commit,
      });
      if (candidates.length === 0) {
        throw new DomainError('ROLE_TEMPLATE_NOT_FOUND', '所选 GitHub 地址中没有找到受支持的角色定义。', 422);
      }
      return candidates.map((candidate) => this.upsertRoleTemplateDraft(candidate, importedCapabilities));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  importLocalRoleTemplates(directoryPath: string): RoleTemplate[] {
    const root = resolve(directoryPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new DomainError('ROLE_LOCAL_PATH_INVALID', '所选角色目录不存在。', 422);
    }
    validateImportedTree(root);
    const capabilities = findSkillDirectories(root).map((directory) => this.importLocalSkill(directory));
    const candidates = discoverRoleTemplates(root, {
      type: 'local_directory', scope: 'managed', executor: null, ref: root, version: null,
    });
    if (candidates.length === 0) throw new DomainError('ROLE_TEMPLATE_NOT_FOUND', '所选目录中没有找到受支持的角色定义。', 422);
    return candidates.map((candidate) => this.upsertRoleTemplateDraft(candidate, capabilities));
  }

  installRoleTemplate(roleId: string, capabilityIds?: string[]): RoleTemplate {
    const role = this.getRoleTemplate(roleId);
    if (role.origin === 'builtin') return role;
    if (role.parseStatus !== 'valid') {
      throw new DomainError('ROLE_TEMPLATE_NOT_INSTALLABLE', role.parseError ?? '该角色无法可靠转换，只能查看。', 422);
    }
    const selectedCapabilityIds = capabilityIds ?? role.capabilityIds;
    for (const capabilityId of selectedCapabilityIds) this.getCapability(capabilityId);
    const timestamp = now();
    this.database.prepare(`
      UPDATE role_templates SET lifecycle_status = 'installed', capability_ids_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify([...new Set(selectedCapabilityIds)]), timestamp, roleId);
    this.appendEvent('role', roleId, 'role.installed', 'user', `RoleTemplate ${role.name} 已审查并安装。`, {
      compatibility: role.compatibility,
      capabilityIds: selectedCapabilityIds,
      source: role.source,
      version: role.version,
    });
    return this.getRoleTemplate(roleId);
  }

  getRoleTemplateChangePreview(roleId: string): RoleTemplateChangePreview {
    const role = this.getRoleTemplate(roleId);
    if (role.origin === 'builtin') {
      return {
        roleId, current: { version: role.version, contentHash: role.contentHash, createdAt: '' }, previous: null,
        changedFields: [], instructionChanges: { added: [], removed: [] },
      };
    }
    const versions = this.database.prepare(`
      SELECT * FROM role_template_versions WHERE role_id = ? ORDER BY created_at DESC LIMIT 2
    `).all(roleId) as RoleTemplateVersionRow[];
    const current = versions[0];
    if (!current) throw new DomainError('ROLE_VERSION_NOT_FOUND', '该角色没有可用版本记录。', 404);
    const previous = versions[1];
    const currentContent = parseJson<Record<string, unknown>>(current.content_json, {});
    const previousContent = previous ? parseJson<Record<string, unknown>>(previous.content_json, {}) : {};
    const changedFields = ['name', 'description', 'instructions', 'responsibilities', 'dependencyNames', 'defaultPermissions', 'compatibility']
      .filter((field) => JSON.stringify(currentContent[field]) !== JSON.stringify(previousContent[field]));
    const currentLines = new Set(String(currentContent.instructions ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    const previousLines = new Set(String(previousContent.instructions ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    return {
      roleId,
      current: { version: current.version, contentHash: current.content_hash, createdAt: current.created_at },
      previous: previous ? { version: previous.version, contentHash: previous.content_hash, createdAt: previous.created_at } : null,
      changedFields,
      instructionChanges: {
        added: [...currentLines].filter((line) => !previousLines.has(line)).slice(0, 200),
        removed: [...previousLines].filter((line) => !currentLines.has(line)).slice(0, 200),
      },
    };
  }

  private upsertRoleTemplateDraft(candidate: DiscoveredRoleTemplate, importedCapabilities: Capability[]): RoleTemplate {
    const existing = this.database.prepare('SELECT * FROM role_templates WHERE origin_key = ?')
      .get(candidate.originKey) as RoleTemplateRow | undefined;
    const roleId = existing?.id ?? id('role');
    const timestamp = now();
    const dependencyNames = candidate.dependencyNames.map((item) => item.toLowerCase());
    const capabilityIds = importedCapabilities
      .filter((capability) => dependencyNames.includes(capability.name.toLowerCase()))
      .map((capability) => capability.id);
    const target = join(this.workbenchHome, 'imports', 'roles', roleId, candidate.contentHash);
    mkdirSync(target, { recursive: true });
    copyFileSync(candidate.entryPath, join(target, 'ROLE.md'));
    this.database.prepare(`
      INSERT INTO role_templates(
        id, origin_key, name, description, instructions, responsibilities_json, capability_ids_json,
        dependency_names_json, default_permissions_json, compatibility_json,
        source_type, source_scope, source_executor, source_ref, source_version,
        version, content_hash, lifecycle_status, parse_status, parse_error, format, managed_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_key) DO UPDATE SET
        name = excluded.name, description = excluded.description, instructions = excluded.instructions,
        responsibilities_json = excluded.responsibilities_json, capability_ids_json = excluded.capability_ids_json,
        dependency_names_json = excluded.dependency_names_json, default_permissions_json = excluded.default_permissions_json,
        compatibility_json = excluded.compatibility_json, source_version = excluded.source_version,
        version = excluded.version, content_hash = excluded.content_hash,
        lifecycle_status = CASE WHEN role_templates.content_hash = excluded.content_hash THEN role_templates.lifecycle_status ELSE 'draft' END,
        parse_status = excluded.parse_status, parse_error = excluded.parse_error, format = excluded.format,
        managed_path = excluded.managed_path, updated_at = excluded.updated_at
    `).run(
      roleId, candidate.originKey, candidate.name, candidate.description, candidate.instructions,
      JSON.stringify(candidate.responsibilities), JSON.stringify(capabilityIds), JSON.stringify(candidate.dependencyNames),
      JSON.stringify(candidate.defaultPermissions), JSON.stringify(candidate.compatibility),
      candidate.source.type, candidate.source.scope, candidate.source.executor, candidate.source.ref, candidate.source.version,
      candidate.version, candidate.contentHash, candidate.parseStatus, candidate.parseError, candidate.format, target,
      existing?.created_at ?? timestamp, timestamp,
    );
    this.database.prepare(`
      INSERT OR IGNORE INTO role_template_versions(id, role_id, version, content_hash, content_json, managed_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id('rolev'), roleId, candidate.version, candidate.contentHash, JSON.stringify({
      name: candidate.name,
      description: candidate.description,
      instructions: candidate.instructions,
      responsibilities: candidate.responsibilities,
      dependencyNames: candidate.dependencyNames,
      defaultPermissions: candidate.defaultPermissions,
      compatibility: candidate.compatibility,
      format: candidate.format,
    }), target, timestamp);
    this.appendEvent('role', roleId, 'role.imported', 'user', `已导入 RoleTemplate 草稿 ${candidate.name}，等待审查。`, {
      format: candidate.format,
      compatibility: candidate.compatibility,
      parseStatus: candidate.parseStatus,
      dependencyNames: candidate.dependencyNames,
      capabilityIds,
    });
    return this.getRoleTemplate(roleId);
  }

  listProjectCapabilities(projectId: string): ProjectCapability[] {
    this.getProject(projectId);
    const rows = this.database.prepare(`
      SELECT * FROM project_capabilities WHERE project_id = ? ORDER BY updated_at DESC
    `).all(projectId) as ProjectCapabilityRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      capabilityId: row.capability_id,
      enabled: Boolean(row.enabled),
      lockedVersion: row.locked_version,
      lockedHash: row.locked_hash,
      configuration: parseJson(row.configuration_json, {}),
      enabledAt: row.enabled_at,
      updatedAt: row.updated_at,
      capability: this.getCapability(row.capability_id),
    }));
  }

  updateProjectCapability(
    projectId: string,
    capabilityId: string,
    input: ProjectCapabilityUpdateInput,
  ): ProjectCapability {
    const project = this.getProject(projectId);
    const capability = this.getCapability(capabilityId);
    if (input.enabled && capability.lifecycleStatus !== 'installed') {
      throw new DomainError('CAPABILITY_INSTALL_REQUIRED', '能力必须先安装，才能启用到项目。', 409);
    }
    if (input.enabled && capability.parseStatus !== 'valid') {
      throw new DomainError('CAPABILITY_INVALID', '无效能力不能启用到项目。', 422, { parseError: capability.parseError });
    }
    const baseConfiguration = isRecordValue(capability.manifest.configuration)
      ? capability.manifest.configuration
      : {};
    const configuration = { ...baseConfiguration, ...(input.configuration ?? {}) };
    assertNoLiteralCredential(configuration);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_capabilities(
        project_id, capability_id, enabled, locked_version, locked_hash, configuration_json, enabled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, capability_id) DO UPDATE SET enabled = excluded.enabled,
        locked_version = excluded.locked_version, locked_hash = excluded.locked_hash,
        configuration_json = excluded.configuration_json,
        enabled_at = excluded.enabled_at, updated_at = excluded.updated_at
    `).run(projectId, capabilityId, Number(input.enabled), capability.version, capability.contentHash,
      JSON.stringify(configuration), input.enabled ? timestamp : null, timestamp);
    this.writeProjectCapabilityLock(projectId);
    this.appendEvent('project', projectId, input.enabled ? 'capability.enabled' : 'capability.disabled', 'user',
      `${input.enabled ? '启用' : '停用'}项目能力 ${capability.name}。`, {
        capabilityId,
        kind: capability.kind,
        version: capability.version,
        contentHash: capability.contentHash,
      });
    this.recordProjectSpaceCommit(project.projectSpacePath,
      `${input.enabled ? 'feat' : 'chore'}: ${input.enabled ? 'enable' : 'disable'} capability ${capability.name}`);
    return this.listProjectCapabilities(projectId).find((item) => item.capabilityId === capabilityId) as ProjectCapability;
  }

  listTaskCapabilitySnapshots(taskId: string): TaskCapabilitySnapshot[] {
    this.getTask(taskId);
    return (this.database.prepare(`
      SELECT * FROM task_capability_snapshots WHERE task_id = ? ORDER BY created_at, step_id, name
    `).all(taskId) as TaskCapabilityRow[]).map((row) => this.taskCapabilityFromRow(row));
  }

  prepareTaskCapabilityProjection(
    taskId: string,
    executor: TaskCapabilitySnapshot['executor'],
    runtimeDirectory: string,
  ): CapabilityProjection {
    const task = this.getTask(taskId);
    const snapshots = this.listTaskCapabilitySnapshots(taskId).filter((item) => item.executor === executor);
    const configDirectory = join(runtimeDirectory, 'capability-config');
    rmSync(configDirectory, { recursive: true, force: true });
    mkdirSync(configDirectory, { recursive: true });
    const skillNames: string[] = [];
    const mcpNames: string[] = [];
    const mcpDefinitions: Record<string, Record<string, unknown>> = {};
    const projectionFiles: string[] = [];
    try {
      for (const snapshot of snapshots) {
        const capability = this.getCapability(snapshot.capabilityId);
        const managedVersionPath = join(this.workbenchHome, 'capabilities', capability.id, snapshot.contentHash);
        if (!existsSync(managedVersionPath)) {
          throw new DomainError('TASK_CAPABILITY_VERSION_MISSING', `任务锁定的能力 ${capability.name} 版本已不可用。`, 409, {
            expectedHash: snapshot.contentHash,
            currentHash: capability.contentHash,
          });
        }
        if (snapshot.kind === 'skill') {
          const frozenFiles = Array.isArray(snapshot.configuration.__yanxuFiles)
            ? snapshot.configuration.__yanxuFiles.filter((item): item is string => typeof item === 'string')
            : capability.security.files;
          const skillRoot = executor === 'opencode'
            ? join(configDirectory, 'skills', snapshot.name)
            : join(configDirectory, '.claude', 'skills', snapshot.name);
          for (const file of frozenFiles) {
            const sourcePath = join(managedVersionPath, file);
            const targetPath = join(skillRoot, file);
            mkdirSync(dirname(targetPath), { recursive: true });
            copyFileSync(sourcePath, targetPath);
            projectionFiles.push(relative(configDirectory, targetPath).replaceAll('\\', '/'));
          }
          skillNames.push(snapshot.name);
          this.markTaskCapabilityProjected(snapshot.id, skillRoot);
          continue;
        }
        const normalized = isRecordValue(snapshot.configuration)
          ? snapshot.configuration
          : {};
        mcpDefinitions[snapshot.name] = executor === 'opencode'
          ? toOpenCodeMcpConfiguration(normalized)
          : toClaudeMcpConfiguration(normalized);
        mcpNames.push(snapshot.name);
      }
      const skillPermission = Object.fromEntries([
        ['*', 'deny'],
        ...skillNames.map((name) => [name, 'allow']),
      ]);
      const configPath = executor === 'opencode'
        ? join(configDirectory, 'opencode.json')
        : join(configDirectory, '.mcp.json');
      const registeredMcpNames = [...new Set(this.listCapabilities()
        .filter((item) => item.kind === 'mcp')
        .map((item) => item.name))];
      const config = executor === 'opencode'
        ? {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            ...Object.fromEntries(registeredMcpNames
              .filter((name) => !mcpNames.includes(name))
              .map((name) => [name, { enabled: false }])),
            ...mcpDefinitions,
          },
          permission: { skill: skillPermission },
          tools: Object.fromEntries(registeredMcpNames.map((name) => [`${name}_*`, mcpNames.includes(name)])),
        }
        : { mcpServers: mcpDefinitions };
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      projectionFiles.push(relative(configDirectory, configPath).replaceAll('\\', '/'));
      for (const snapshot of snapshots.filter((item) => item.kind === 'mcp')) {
        this.markTaskCapabilityProjected(snapshot.id, configPath);
      }
      const createdAt = now();
      const contentHash = sha256(JSON.stringify({
        taskId,
        executor,
        capabilities: snapshots.map((item) => ({ id: item.capabilityId, hash: item.contentHash })),
        projectionFiles: projectionFiles.sort(),
      }));
      const projection: CapabilityProjection = {
        taskId,
        executor,
        configDirectory,
        configPath,
        capabilityIds: snapshots.map((item) => item.capabilityId),
        skillNames,
        mcpNames,
        contentHash,
        createdAt,
      };
      writeFileSync(join(configDirectory, 'yanxu-projection.json'), `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
      this.appendEvent('task', task.id, 'capability.projected', 'system',
        `已为 ${executor} 投影 ${snapshots.length} 项任务能力。`, {
          capabilityIds: projection.capabilityIds,
          skillNames,
          mcpNames,
          contentHash,
        });
      return projection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const snapshot of snapshots) {
        this.database.prepare(`
          UPDATE task_capability_snapshots SET status = 'failed', error = ? WHERE id = ?
        `).run(message, snapshot.id);
      }
      throw error;
    }
  }

  private insertDiscoveredCapability(capabilityId: string, candidate: DiscoveredCapability, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO capabilities(
        id, origin_key, kind, name, description, source_type, source_scope, source_executor, source_ref, source_version,
        version, content_hash, compatibility_json, lifecycle_status, parse_status, parse_error, command_status,
        runtime_health, credential_refs_json, manifest_json, managed_path, security_json,
        last_discovered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(capabilityId, candidate.originKey, candidate.kind, candidate.name, candidate.description,
      candidate.source.type, candidate.source.scope, candidate.source.executor, candidate.source.ref, candidate.source.version,
      candidate.version, candidate.contentHash, JSON.stringify(candidate.compatibility), candidate.parseStatus,
      candidate.parseError, candidate.commandStatus, candidate.runtimeHealth, JSON.stringify(candidate.credentialRefs),
      JSON.stringify(candidate.manifest), JSON.stringify(candidate.security), timestamp, timestamp, timestamp);
  }

  private updateDiscoveredCapability(capabilityId: string, candidate: DiscoveredCapability, timestamp: string): void {
    const existing = this.getCapability(capabilityId);
    const contentChanged = existing.contentHash !== candidate.contentHash;
    this.database.prepare(`
      UPDATE capabilities SET kind = ?, name = ?, description = ?, source_type = ?, source_scope = ?,
        source_executor = ?, source_ref = ?, source_version = ?, version = ?, content_hash = ?, compatibility_json = ?,
        lifecycle_status = ?, parse_status = ?, parse_error = ?, command_status = ?, runtime_health = ?,
        credential_refs_json = ?, manifest_json = ?, managed_path = ?, security_json = ?, last_discovered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(candidate.kind, candidate.name, candidate.description, candidate.source.type, candidate.source.scope,
      candidate.source.executor, candidate.source.ref, candidate.source.version, candidate.version, candidate.contentHash,
      JSON.stringify(candidate.compatibility), contentChanged ? 'discovered' : existing.lifecycleStatus,
      candidate.parseStatus, candidate.parseError, candidate.commandStatus,
      contentChanged ? candidate.runtimeHealth : existing.runtimeHealth,
      JSON.stringify(candidate.credentialRefs), JSON.stringify(candidate.manifest),
      contentChanged ? null : existing.managedPath, JSON.stringify(candidate.security), timestamp, timestamp, capabilityId);
  }

  private capabilityFromRow(row: CapabilityRow): Capability {
    return {
      id: row.id,
      originKey: row.origin_key,
      kind: row.kind,
      name: row.name,
      description: row.description,
      source: {
        type: row.source_type,
        scope: row.source_scope,
        executor: row.source_executor,
        ref: row.source_ref,
        version: row.source_version,
      },
      version: row.version,
      contentHash: row.content_hash,
      compatibility: parseJson(row.compatibility_json, []),
      lifecycleStatus: row.lifecycle_status,
      parseStatus: row.parse_status,
      parseError: row.parse_error,
      commandStatus: row.command_status,
      runtimeHealth: row.runtime_health,
      credentialRefs: parseJson(row.credential_refs_json, []),
      manifest: parseJson(row.manifest_json, {}),
      managedPath: row.managed_path,
      security: parseJson(row.security_json, {
        files: [], scripts: [], executableFiles: [], networkHosts: [], environmentKeys: [], headerKeys: [], containsLiteralSecrets: false,
      }),
      lastDiscoveredAt: row.last_discovered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private roleTemplateFromRow(row: RoleTemplateRow): RoleTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      responsibilities: parseJson(row.responsibilities_json, []),
      skillIds: [],
      defaultPermissions: parseJson(row.default_permissions_json, []),
      version: row.version,
      origin: 'external',
      lifecycleStatus: row.lifecycle_status,
      parseStatus: row.parse_status,
      parseError: row.parse_error,
      instructions: row.instructions,
      capabilityIds: parseJson(row.capability_ids_json, []),
      dependencyNames: parseJson(row.dependency_names_json, []),
      compatibility: parseJson(row.compatibility_json, []),
      source: {
        type: row.source_type,
        scope: row.source_scope,
        executor: row.source_executor,
        ref: row.source_ref,
        version: row.source_version,
      },
      contentHash: row.content_hash,
      format: row.format,
      managedPath: row.managed_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private taskCapabilityFromRow(row: TaskCapabilityRow): TaskCapabilitySnapshot {
    return {
      id: row.id,
      taskId: row.task_id,
      stepId: row.step_id,
      agentId: row.agent_id,
      capabilityId: row.capability_id,
      kind: row.kind,
      name: row.name,
      version: row.version,
      contentHash: row.content_hash,
      executor: row.executor,
      configuration: parseJson(row.configuration_json, {}),
      projectionPath: row.projection_path,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
    };
  }

  private markTaskCapabilityProjected(snapshotId: string, projectionPath: string): void {
    this.database.prepare(`
      UPDATE task_capability_snapshots SET status = 'projected', projection_path = ?, error = NULL WHERE id = ?
    `).run(projectionPath, snapshotId);
  }

  private writeProjectCapabilityLock(projectId: string): void {
    const project = this.getProject(projectId);
    const capabilities = this.listProjectCapabilities(projectId).map((item) => ({
      capabilityId: item.capabilityId,
      name: item.capability.name,
      kind: item.capability.kind,
      enabled: item.enabled,
      version: item.lockedVersion,
      contentHash: item.lockedHash,
      compatibility: item.capability.compatibility,
      source: item.capability.source,
      configuration: item.configuration,
      credentialRefs: item.capability.credentialRefs,
      updatedAt: item.updatedAt,
    }));
    const updatedAt = now();
    const artifact = writeVersionedArtifact(project.projectSpacePath, 'capabilities/lock.json', `${JSON.stringify({
      projectId,
      updatedAt,
      capabilities,
    }, null, 2)}\n`);
    this.database.prepare(`
      INSERT INTO project_capability_locks(project_id, artifact_path, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET artifact_path = excluded.artifact_path,
        content_hash = excluded.content_hash, updated_at = excluded.updated_at
    `).run(projectId, artifact.path, artifact.hash, updatedAt);
  }

  private freezeTaskCapabilities(
    task: Task,
    plan: TaskPlan,
    agents: AgentProfile[],
    createdAt: string,
  ): TaskCapabilitySnapshot[] {
    const enabled = new Map(this.listProjectCapabilities(task.projectId)
      .filter((item) => item.enabled)
      .map((item) => [item.capabilityId, item]));
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const snapshots: TaskCapabilitySnapshot[] = [];
    for (const step of plan.steps) {
      const agent = step.agentId ? agentsById.get(step.agentId) : null;
      if (!agent) continue;
      for (const capabilityId of [...new Set(step.capabilityIds ?? [])]) {
        const projectCapability = enabled.get(capabilityId);
        if (!projectCapability) {
          throw new DomainError('TASK_CAPABILITY_NOT_ENABLED', `执行单元“${step.title}”使用了未在项目启用的能力。`, 422, {
            stepId: step.id,
            capabilityId,
          });
        }
        const capability = projectCapability.capability;
        if (!capability.compatibility.includes(agent.executor)) {
          throw new DomainError('TASK_CAPABILITY_INCOMPATIBLE', `能力 ${capability.name} 与 ${agent.executor} 不兼容。`, 422, {
            stepId: step.id,
            capabilityId,
            executor: agent.executor,
          });
        }
        const missingCredentials = capability.credentialRefs.filter((name) => !process.env[name]);
        if (missingCredentials.length > 0) {
          throw new DomainError('TASK_CAPABILITY_CREDENTIALS_MISSING', `能力 ${capability.name} 缺少本地凭据引用。`, 422, {
            capabilityId,
            missingCredentials,
          });
        }
        const managedVersionPath = join(this.workbenchHome, 'capabilities', capability.id, projectCapability.lockedHash);
        if (!existsSync(managedVersionPath)) {
          throw new DomainError('TASK_CAPABILITY_VERSION_MISSING', `项目锁定的能力 ${capability.name} 版本尚未安装或已丢失。`, 409, {
            capabilityId,
            lockedHash: projectCapability.lockedHash,
          });
        }
        snapshots.push({
          id: id('taskcap'),
          taskId: task.id,
          stepId: step.id,
          agentId: agent.id,
          capabilityId,
          kind: capability.kind,
          name: capability.name,
          version: projectCapability.lockedVersion,
          contentHash: projectCapability.lockedHash,
          executor: agent.executor,
          configuration: capability.kind === 'skill'
            ? {
              ...projectCapability.configuration,
              __yanxuFiles: capability.security.files,
              __yanxuManifest: capability.manifest,
            }
            : projectCapability.configuration,
          projectionPath: null,
          status: 'frozen',
          error: null,
          createdAt,
        });
      }
    }
    return snapshots;
  }

  private persistTaskCapabilitySnapshots(taskId: string, snapshots: TaskCapabilitySnapshot[]): void {
    this.database.prepare('DELETE FROM task_capability_snapshots WHERE task_id = ?').run(taskId);
    const insert = this.database.prepare(`
      INSERT INTO task_capability_snapshots(
        id, task_id, step_id, agent_id, capability_id, kind, name, version, content_hash,
        executor, configuration_json, projection_path, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const snapshot of snapshots) {
      insert.run(snapshot.id, snapshot.taskId, snapshot.stepId, snapshot.agentId, snapshot.capabilityId,
        snapshot.kind, snapshot.name, snapshot.version, snapshot.contentHash, snapshot.executor,
        JSON.stringify(snapshot.configuration), snapshot.projectionPath, snapshot.status, snapshot.error, snapshot.createdAt);
    }
  }

  getProjectSettings(projectId: string): ProjectSettings {
    const project = this.getProject(projectId);
    const row = this.database.prepare('SELECT * FROM project_settings WHERE project_id = ?').get(projectId) as {
      project_id: string;
      permission_mode: ProjectSettings['permissionMode'];
      forbidden_paths_json: string;
      updated_at: string;
    } | undefined;
    return row ? {
      projectId: row.project_id,
      permissionMode: row.permission_mode,
      forbiddenPaths: parseJson(row.forbidden_paths_json, []),
      updatedAt: row.updated_at,
    } : {
      projectId,
      permissionMode: 'inherit',
      forbiddenPaths: [],
      updatedAt: project.updatedAt,
    };
  }

  updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput): ProjectSettings {
    const project = this.getProject(projectId);
    const timestamp = now();
    const forbiddenPaths = [...new Set(input.forbiddenPaths.map((item) => item.trim()).filter(Boolean))];
    const settingsArtifact = writeVersionedArtifact(project.projectSpacePath, 'settings.json', `${JSON.stringify({
      projectId,
      description: input.description ?? project.description,
      permissionMode: input.permissionMode,
      forbiddenPaths,
      updatedAt: timestamp,
    }, null, 2)}\n`);
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO project_settings(project_id, permission_mode, forbidden_paths_json, artifact_path, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET permission_mode = excluded.permission_mode,
          forbidden_paths_json = excluded.forbidden_paths_json, artifact_path = excluded.artifact_path,
          content_hash = excluded.content_hash, updated_at = excluded.updated_at
      `).run(projectId, input.permissionMode, JSON.stringify(forbiddenPaths), settingsArtifact.path, settingsArtifact.hash, timestamp);
      if (input.description !== undefined) {
        this.database.prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?')
          .run(input.description.trim(), timestamp, projectId);
      }
      this.appendEvent('project', projectId, 'project.settings_updated', 'user', '更新项目说明与权限边界。', {
        permissionMode: input.permissionMode,
        forbiddenPaths,
      });
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, 'chore: update project settings');
    return this.getProjectSettings(projectId);
  }

  listProjectSpaceOperations(projectId: string): ProjectSpaceOperation[] {
    this.getProject(projectId);
    const rows = this.database.prepare(`
      SELECT * FROM project_space_operations WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as ProjectSpaceOperationRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      operation: row.operation,
      commitHash: row.commit_hash,
      changedFiles: parseJson(row.changed_files_json, []),
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
    }));
  }

  checkProjectSpaceIntegrity(projectId: string): ProjectSpaceIntegrityReport {
    const project = this.getProject(projectId);
    const rows = this.database.prepare(`
      SELECT 'task' AS entity_type, tv.id AS entity_id, tv.artifact_path, tv.content_hash
      FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'plan', p.id, p.artifact_path, p.content_hash
      FROM plans p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'preapproval', a.id, a.artifact_path, a.content_hash
      FROM preapproval_artifact_versions a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'artifact', a.id, a.artifact_path, a.content_hash
      FROM artifact_versions a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'attachment', a.id, a.artifact_path, a.content_hash
      FROM task_attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'snapshot', s.id, s.artifact_path, s.content_hash
      FROM run_snapshots s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'artifact', c.id, c.artifact_path, c.content_hash
      FROM change_manifests c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'directory_profile', d.id, d.artifact_path, d.content_hash
      FROM directory_profiles d JOIN project_directories pd ON pd.id = d.directory_id WHERE pd.project_id = ?
      UNION ALL
      SELECT 'delivery_report', r.id, r.artifact_path, r.content_hash
      FROM delivery_reports r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ?
      UNION ALL
      SELECT 'project_settings', s.project_id, s.artifact_path, s.content_hash
      FROM project_settings s WHERE s.project_id = ?
      UNION ALL
      SELECT 'capability_lock', l.project_id, l.artifact_path, l.content_hash
      FROM project_capability_locks l WHERE l.project_id = ?
    `).all(projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId) as Array<{
      entity_type: ProjectSpaceIntegrityReport['issues'][number]['entityType'];
      entity_id: string;
      artifact_path: string;
      content_hash: string;
    }>;
    const activeKnowledge = this.database.prepare(`
      SELECT * FROM knowledge_items WHERE project_id = ? AND status = 'active'
    `).all(projectId) as KnowledgeRow[];
    for (const item of activeKnowledge) {
      const content = this.renderKnowledge(item.title, item.category, item.status, item.content, item.source_task_id);
      rows.push({
        entity_type: 'knowledge',
        entity_id: item.id,
        artifact_path: join(project.projectSpacePath, 'knowledge', 'items', `${item.id}.md`),
        content_hash: createHash('sha256').update(content).digest('hex'),
      });
    }

    const issues: ProjectSpaceIntegrityReport['issues'] = [];
    for (const row of rows) {
      const relativePath = relative(project.projectSpacePath, row.artifact_path);
      if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        issues.push({
          entityType: row.entity_type,
          entityId: row.entity_id,
          artifactPath: row.artifact_path,
          expectedHash: row.content_hash,
          actualHash: null,
          reason: 'invalid_path',
        });
        continue;
      }
      if (!existsSync(row.artifact_path)) {
        issues.push({
          entityType: row.entity_type,
          entityId: row.entity_id,
          artifactPath: row.artifact_path,
          expectedHash: row.content_hash,
          actualHash: null,
          reason: 'missing',
        });
        continue;
      }
      const actualHash = createHash('sha256').update(readFileSync(row.artifact_path)).digest('hex');
      if (actualHash !== row.content_hash) {
        issues.push({
          entityType: row.entity_type,
          entityId: row.entity_id,
          artifactPath: row.artifact_path,
          expectedHash: row.content_hash,
          actualHash,
          reason: 'modified',
        });
      }
    }
    const stateManifestPath = join(project.projectSpacePath, 'state', 'current.json');
    if (existsSync(stateManifestPath)) {
      const preview = previewProjectStateRestore(project.projectSpacePath, { verifyArtifacts: false });
      if (!preview.valid) {
        issues.push({
          entityType: 'state_manifest',
          entityId: projectId,
          artifactPath: stateManifestPath,
          expectedHash: preview.payloadHash,
          actualHash: null,
          reason: 'modified',
        });
      }
    }
    return {
      projectId,
      status: issues.length > 0 ? 'external_changes' : 'healthy',
      gitDirty: Boolean(git(project.projectSpacePath, ['status', '--porcelain=v1'])),
      checkedAt: now(),
      checkedArtifacts: rows.length,
      issues,
    };
  }

  previewProjectSpaceRestore(projectSpacePath: string): ProjectSpaceRestorePreview {
    return previewProjectStateRestore(projectSpacePath);
  }

  refreshProjectSpaceState(projectId: string): ProjectSpaceRestorePreview {
    const project = this.getProject(projectId);
    this.recordProjectSpaceCommit(project.projectSpacePath, 'chore: refresh ProjectSpace recovery point');
    return previewProjectStateRestore(project.projectSpacePath);
  }

  restoreProjectSpace(projectSpacePath: string): ProjectSpaceRestoreResult {
    try {
      const result = restoreProjectState(this.database, projectSpacePath);
      this.recordProjectSpaceCommit(projectSpacePath, 'chore: rebuild project database from ProjectSpace');
      return result;
    } catch (error) {
      throw new DomainError(
        'PROJECTSPACE_RESTORE_FAILED',
        error instanceof Error ? error.message : 'ProjectSpace 恢复失败。',
        422,
      );
    }
  }

  createProject(input: CreateProjectInput): Project {
    const projectId = id('prj');
    const directory = scanProjectDirectory({ id: id('dir'), projectId, selectedPath: input.directoryPath, initializeGit: false });
    const timestamp = now();
    const projectSpace = ensureProjectSpace(this.workbenchHome, projectId, input.name.trim(), input.description?.trim() ?? '');

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO projects(id, name, description, project_space_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, input.name.trim(), input.description?.trim() ?? '', projectSpace.root, timestamp, timestamp);
      this.insertDirectory(directory);
      this.appendEvent('project', projectId, 'project.created', 'user', '创建项目并关联首个项目目录。', { directoryId: directory.id });
    })();

    const profile = `${JSON.stringify({ projectId, name: input.name, description: input.description ?? '', directories: [directory] }, null, 2)}\n`;
    writeVersionedArtifact(projectSpace.root, 'project.json', profile);
    this.createDirectoryProfile(projectSpace.root, directory, 'candidate');
    this.recordProjectSpaceCommit(projectSpace.root, 'feat: link first project directory');
    return this.getProject(projectId);
  }

  addProjectDirectory(projectId: string, directoryPath: string): ProjectDirectory {
    const project = this.getProject(projectId);
    const scanned = scanProjectDirectory({ id: id('dir'), projectId, selectedPath: directoryPath, initializeGit: false });
    const removed = this.database.prepare(`
      SELECT * FROM project_directories
      WHERE project_id = ? AND real_path = ? AND removed_at IS NOT NULL
    `).get(projectId, scanned.realPath) as DirectoryRow | undefined;
    const directory = removed ? { ...scanned, id: removed.id } : scanned;
    try {
      this.database.transaction(() => {
        if (removed) {
          this.database.prepare(`
            UPDATE project_directories SET display_name = ?, selected_path = ?, real_path = ?, git_root_path = ?,
              git_initialized = ?, current_branch = ?, is_dirty = ?, content_types_json = ?, stack_json = ?,
              commands_json = ?, scanned_at = ?, removed_at = NULL
            WHERE id = ?
          `).run(directory.displayName, directory.selectedPath, directory.realPath, directory.gitRootPath,
            Number(directory.gitInitialized), directory.currentBranch, Number(directory.isDirty),
            JSON.stringify(directory.contentTypes), JSON.stringify(directory.stack), JSON.stringify(directory.commands),
            directory.scannedAt, directory.id);
        } else {
          this.insertDirectory(directory);
        }
        this.database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);
        this.appendEvent('project', projectId, removed ? 'project.directory_restored' : 'project.directory_added', 'user',
          `${removed ? '重新关联' : '关联'}项目目录 ${directory.displayName}。`, { directoryId: directory.id });
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new DomainError('DIRECTORY_ALREADY_LINKED', '该目录已经关联到当前项目。', 409);
      }
      throw error;
    }
    writeVersionedArtifact(project.projectSpacePath, `directories/${directory.id}.json`, `${JSON.stringify(directory, null, 2)}\n`);
    this.createDirectoryProfile(project.projectSpacePath, directory, 'confirmed');
    this.recordProjectSpaceCommit(project.projectSpacePath, `feat: ${removed ? 'relink' : 'link'} directory ${directory.displayName}`);
    return directory;
  }

  removeProjectDirectory(directoryId: string): { removedDirectoryId: string; projectId: string } {
    const row = this.database.prepare('SELECT * FROM project_directories WHERE id = ? AND removed_at IS NULL').get(directoryId) as DirectoryRow | undefined;
    if (!row) throw new DomainError('DIRECTORY_NOT_FOUND', '项目目录不存在。', 404);
    const project = this.getProject(row.project_id);
    if (project.directories.length <= 1) {
      throw new DomainError('PROJECT_DIRECTORY_REQUIRED', '项目至少需要保留一个关联目录。', 409);
    }
    const referencingTasks = this.database.prepare(`
      SELECT DISTINCT t.id, t.title, t.status
      FROM tasks t
      JOIN task_steps s ON s.task_id = t.id
      JOIN json_each(s.directory_ids_json) d ON d.value = ?
      WHERE t.project_id = ? AND t.status NOT IN ('ARCHIVED', 'CANCELLED')
      ORDER BY t.updated_at DESC
    `).all(directoryId, row.project_id) as Array<{ id: string; title: string; status: TaskStatus }>;
    if (referencingTasks.length > 0) {
      throw new DomainError('DIRECTORY_IN_USE', '该目录仍被未归档任务引用，不能移除。', 409, {
        tasks: referencingTasks,
      });
    }
    const removedAt = now();
    const removalArtifact = writeVersionedArtifact(
      project.projectSpacePath,
      `directories/${directoryId}/removed.json`,
      `${JSON.stringify({
        directoryId,
        projectId: row.project_id,
        displayName: row.display_name,
        selectedPath: row.selected_path,
        realPath: row.real_path,
        removedAt,
      }, null, 2)}\n`,
    );
    this.database.transaction(() => {
      this.database.prepare('UPDATE project_directories SET removed_at = ? WHERE id = ?').run(removedAt, directoryId);
      this.database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(removedAt, row.project_id);
      this.appendEvent('project', row.project_id, 'project.directory_removed', 'user',
        `解除项目目录 ${row.display_name} 的关联。`, {
          directoryId,
          artifactPath: removalArtifact.path,
          contentHash: removalArtifact.hash,
        });
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `chore: unlink project directory ${directoryId}`);
    return { removedDirectoryId: directoryId, projectId: row.project_id };
  }

  rescanDirectory(directoryId: string): DirectoryProfileVersion {
    const row = this.database.prepare('SELECT * FROM project_directories WHERE id = ? AND removed_at IS NULL').get(directoryId) as DirectoryRow | undefined;
    if (!row) throw new DomainError('DIRECTORY_NOT_FOUND', '项目目录不存在。', 404);
    const directory = scanProjectDirectory({ id: row.id, projectId: row.project_id, selectedPath: row.selected_path, initializeGit: false });
    const project = this.getProject(row.project_id);
    const profile = this.createDirectoryProfile(project.projectSpacePath, directory, 'candidate');
    this.appendEvent('project', row.project_id, 'directory.profile_candidate', 'user',
      `目录 ${directory.displayName} 的扫描结果已生成候选 v${profile.version}，等待确认。`, {
        directoryId,
        profileId: profile.id,
      });
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: scan directory profile v${profile.version}`);
    return profile;
  }

  listDirectoryProfiles(projectId: string): DirectoryProfileVersion[] {
    this.getProject(projectId);
    const rows = this.database.prepare(`
      SELECT dp.* FROM directory_profiles dp
      JOIN project_directories pd ON pd.id = dp.directory_id
      WHERE pd.project_id = ? AND pd.removed_at IS NULL
      ORDER BY dp.created_at DESC
    `).all(projectId) as DirectoryProfileRow[];
    return rows.map(this.directoryProfileFromRow);
  }

  confirmDirectoryProfile(profileId: string): ProjectDirectory {
    const row = this.database.prepare('SELECT * FROM directory_profiles WHERE id = ?').get(profileId) as DirectoryProfileRow | undefined;
    if (!row) throw new DomainError('DIRECTORY_PROFILE_NOT_FOUND', '目录认知版本不存在。', 404);
    if (row.status !== 'candidate') throw new DomainError('DIRECTORY_PROFILE_NOT_CANDIDATE', '只有候选目录认知可以确认。', 409);
    const directory = parseJson<ProjectDirectory>(row.content_json, null as unknown as ProjectDirectory);
    const project = this.getProject(directory.projectId);
    const confirmedAt = now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE directory_profiles SET status = 'superseded'
        WHERE directory_id = ? AND status = 'confirmed'
      `).run(directory.id);
      this.database.prepare(`
        UPDATE directory_profiles SET status = 'confirmed', confirmed_at = ? WHERE id = ?
      `).run(confirmedAt, profileId);
      this.database.prepare(`
        UPDATE project_directories SET display_name = ?, real_path = ?, git_root_path = ?, git_initialized = ?, current_branch = ?,
          is_dirty = ?, content_types_json = ?, stack_json = ?, commands_json = ?, scanned_at = ? WHERE id = ?
      `).run(directory.displayName, directory.realPath, directory.gitRootPath, Number(directory.gitInitialized), directory.currentBranch,
        Number(directory.isDirty), JSON.stringify(directory.contentTypes), JSON.stringify(directory.stack),
        JSON.stringify(directory.commands), directory.scannedAt, directory.id);
      this.appendEvent('project', project.id, 'directory.profile_confirmed', 'user',
        `已确认目录 ${directory.displayName} 的认知版本 v${row.version}。`, {
          directoryId: directory.id,
          profileId,
          version: row.version,
        });
    })();
    writeVersionedArtifact(project.projectSpacePath, `directories/${directory.id}.json`, `${JSON.stringify(directory, null, 2)}\n`);
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: confirm directory profile v${row.version}`);
    return this.getProject(project.id).directories.find((item) => item.id === directory.id) as ProjectDirectory;
  }

  listAgents(): AgentProfile[] {
    return (this.database.prepare('SELECT * FROM agent_profiles ORDER BY created_at').all() as AgentRow[]).map(this.agentFromRow);
  }

  createAgent(input: CreateAgentInput, installation: ExecutorInstallation | undefined): AgentProfile {
    const role = this.getRoleTemplate(input.roleId);
    if (role.lifecycleStatus === 'draft') throw new DomainError('ROLE_NOT_INSTALLED', '外部 Role 必须先完成审查并安装。', 422);
    if (!role.compatibility.includes(input.executor)) throw new DomainError('ROLE_EXECUTOR_INCOMPATIBLE', '所选 Role 与该 CLI 不兼容。', 422);
    if (!installation || installation.health !== 'available') throw new DomainError('EXECUTOR_UNAVAILABLE', '所选 CLI 当前不可用，请先在设置中检测。', 422);
    if (installation.id === 'opencode' && installation.models.length > 0 && !installation.models.includes(input.model)) {
      throw new DomainError('MODEL_UNAVAILABLE', '所选模型不在 CLI 当前可用模型中。', 422);
    }
    const defaultCapabilityIds = this.validateAgentDefaultCapabilities(input.defaultCapabilityIds ?? [], input.executor);
    const timestamp = now();
    const agentId = id('agent');
    this.database.prepare(`
      INSERT INTO agent_profiles(id, name, role_id, executor, model, parameters_json, default_capability_ids_json, permission_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(agentId, input.name.trim(), input.roleId, input.executor, input.model, JSON.stringify(input.parameters ?? {}),
      JSON.stringify(defaultCapabilityIds), input.permissionMode ?? 'standard', timestamp, timestamp);
    this.appendEvent('agent', agentId, 'agent.created', 'user', `创建 AI 人员 ${input.name.trim()}。`, { roleId: input.roleId, executor: input.executor });
    return this.getAgent(agentId);
  }

  updateAgent(agentId: string, input: CreateAgentInput, installation: ExecutorInstallation | undefined): AgentProfile {
    this.getAgent(agentId);
    const role = this.getRoleTemplate(input.roleId);
    if (role.lifecycleStatus === 'draft') throw new DomainError('ROLE_NOT_INSTALLED', '外部 Role 必须先完成审查并安装。', 422);
    if (!role.compatibility.includes(input.executor)) throw new DomainError('ROLE_EXECUTOR_INCOMPATIBLE', '所选 Role 与该 CLI 不兼容。', 422);
    if (!installation || installation.health !== 'available') throw new DomainError('EXECUTOR_UNAVAILABLE', '所选 CLI 当前不可用，请先在设置中检测。', 422);
    if (installation.id === 'opencode' && installation.models.length > 0 && !installation.models.includes(input.model)) {
      throw new DomainError('MODEL_UNAVAILABLE', '所选模型不在 CLI 当前可用模型中。', 422);
    }
    const defaultCapabilityIds = this.validateAgentDefaultCapabilities(input.defaultCapabilityIds ?? [], input.executor);
    const timestamp = now();
    this.database.prepare(`
      UPDATE agent_profiles
      SET name = ?, role_id = ?, executor = ?, model = ?, parameters_json = ?, default_capability_ids_json = ?, permission_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name.trim(), input.roleId, input.executor, input.model, JSON.stringify(input.parameters ?? {}),
      JSON.stringify(defaultCapabilityIds), input.permissionMode ?? 'standard', timestamp, agentId);
    this.appendEvent('agent', agentId, 'agent.updated', 'user', `更新 AI 人员 ${input.name.trim()}。`, {
      roleId: input.roleId,
      executor: input.executor,
      model: input.model,
    });
    return this.getAgent(agentId);
  }

  private validateAgentDefaultCapabilities(capabilityIds: string[], executor: AgentProfile['executor']): string[] {
    const uniqueIds = [...new Set(capabilityIds)];
    for (const capabilityId of uniqueIds) {
      const capability = this.getCapability(capabilityId);
      if (capability.lifecycleStatus !== 'installed' || capability.parseStatus !== 'valid') {
        throw new DomainError('AGENT_CAPABILITY_NOT_INSTALLED', `默认能力 ${capability.name} 尚未完成安装。`, 422, { capabilityId });
      }
      if (!capability.compatibility.includes(executor)) {
        throw new DomainError('AGENT_CAPABILITY_INCOMPATIBLE', `默认能力 ${capability.name} 与 ${executor} 不兼容。`, 422, { capabilityId, executor });
      }
    }
    return uniqueIds;
  }

  setAgentStatus(agentId: string, status: AgentProfile['status']): AgentProfile {
    const agent = this.getAgent(agentId);
    if (agent.status === status) return agent;
    const timestamp = now();
    this.database.prepare('UPDATE agent_profiles SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, timestamp, agentId);
    this.appendEvent('agent', agentId, `agent.${status}`, 'user',
      `${status === 'active' ? '启用' : '停用'} AI 人员 ${agent.name}。`);
    return this.getAgent(agentId);
  }

  deleteAgent(agentId: string): { deletedAgentId: string } {
    const agent = this.getAgent(agentId);
    const references = {
      teams: (this.database.prepare('SELECT COUNT(*) AS count FROM team_members WHERE agent_id = ?').get(agentId) as { count: number }).count,
      steps: (this.database.prepare('SELECT COUNT(*) AS count FROM task_steps WHERE agent_id = ?').get(agentId) as { count: number }).count,
      sessions: (this.database.prepare('SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id = ?').get(agentId) as { count: number }).count,
    };
    if (Object.values(references).some((count) => count > 0)) {
      throw new DomainError('AGENT_IN_USE', '该人员仍被团队或历史任务引用，不能删除；可以先停用。', 409, references);
    }
    this.database.prepare('DELETE FROM agent_profiles WHERE id = ?').run(agentId);
    this.appendEvent('agent', agentId, 'agent.deleted', 'user', `删除未被引用的 AI 人员 ${agent.name}。`);
    return { deletedAgentId: agentId };
  }

  getAgent(agentId: string): AgentProfile {
    const row = this.database.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(agentId) as AgentRow | undefined;
    if (!row) throw new DomainError('AGENT_NOT_FOUND', 'AI 人员不存在。', 404);
    return this.agentFromRow(row);
  }

  listTeams(): Team[] {
    return (this.database.prepare('SELECT * FROM teams ORDER BY is_default DESC, created_at').all() as TeamRow[]).map((row) => this.teamFromRow(row));
  }

  createTeam(input: CreateTeamInput): Team {
    const uniqueMembers = [...new Set(input.memberIds)];
    for (const agentId of uniqueMembers) {
      if (this.getAgent(agentId).status !== 'active') throw new DomainError('TEAM_AGENT_INACTIVE', '团队不能加入已停用人员。', 422, { agentId });
    }
    const timestamp = now();
    const teamId = id('team');
    this.database.transaction(() => {
      if (input.isDefault) this.database.prepare('UPDATE teams SET is_default = 0').run();
      this.database.prepare(`INSERT INTO teams(id, name, description, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(teamId, input.name.trim(), input.description?.trim() ?? '', Number(input.isDefault ?? false), timestamp, timestamp);
      const addMember = this.database.prepare('INSERT INTO team_members(team_id, agent_id, position) VALUES (?, ?, ?)');
      uniqueMembers.forEach((agentId, position) => addMember.run(teamId, agentId, position));
      this.appendEvent('team', teamId, 'team.created', 'user', `创建团队 ${input.name.trim()}。`, { memberCount: uniqueMembers.length });
    })();
    return this.getTeam(teamId);
  }

  updateTeam(teamId: string, input: CreateTeamInput): Team {
    this.getTeam(teamId);
    const uniqueMembers = [...new Set(input.memberIds)];
    for (const agentId of uniqueMembers) {
      if (this.getAgent(agentId).status !== 'active') throw new DomainError('TEAM_AGENT_INACTIVE', '团队不能加入已停用人员。', 422, { agentId });
    }
    this.database.transaction(() => {
      if (input.isDefault) this.database.prepare('UPDATE teams SET is_default = 0').run();
      this.database.prepare('UPDATE teams SET name = ?, description = ?, is_default = ?, updated_at = ? WHERE id = ?')
        .run(input.name.trim(), input.description?.trim() ?? '', Number(input.isDefault ?? false), now(), teamId);
      this.database.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
      const addMember = this.database.prepare('INSERT INTO team_members(team_id, agent_id, position) VALUES (?, ?, ?)');
      uniqueMembers.forEach((agentId, position) => addMember.run(teamId, agentId, position));
      this.appendEvent('team', teamId, 'team.updated', 'user', `更新团队 ${input.name.trim()}。`, { memberCount: uniqueMembers.length });
    })();
    return this.getTeam(teamId);
  }

  getTeam(teamId: string): Team {
    const row = this.database.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!row) throw new DomainError('TEAM_NOT_FOUND', '团队不存在。', 404);
    return this.teamFromRow(row);
  }

  createTask(input: CreateTaskInput): Task {
    const project = this.getProject(input.projectId);
    this.getTeam(input.teamId);
    const timestamp = now();
    const taskId = id('task');
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks(id, project_id, team_id, title, description, expected_output, constraints_text, forbidden_paths_json,
          status, state_version, flow_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0, 2, ?, ?)
      `).run(taskId, input.projectId, input.teamId, input.title.trim(), input.description.trim(), input.expectedOutput?.trim() ?? '',
        input.constraints?.trim() ?? '', JSON.stringify(input.forbiddenPaths ?? []), timestamp, timestamp);
      this.appendEvent('task', taskId, 'task.created', 'user', '保存任务草稿。', {
        projectId: input.projectId, teamId: input.teamId,
      });
    })();

    const artifact = this.writeTaskVersion(project.projectSpacePath, taskId, 1, input);
    this.database.prepare(`INSERT INTO task_versions(id, task_id, version, artifact_path, content_hash, status, created_at) VALUES (?, ?, 1, ?, ?, 'draft', ?)`)
      .run(id('taskv'), taskId, artifact.path, artifact.hash, timestamp);
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: create task ${taskId}`, taskId);
    return this.getTask(taskId);
  }

  attachTaskFiles(taskId: string, sourcePaths: string[]): TaskAttachment[] {
    const task = this.getTask(taskId);
    if (task.status !== 'DRAFT') {
      throw new DomainError('TASK_ATTACHMENT_STATE_INVALID', '只能在任务提交分析前添加附件。', 409);
    }
    if (sourcePaths.length > 10) {
      throw new DomainError('TASK_ATTACHMENT_LIMIT', '单个任务最多添加 10 个附件。', 422);
    }
    const project = this.getProject(task.projectId);
    const prepared = sourcePaths.map((sourcePath) => {
      const resolvedPath = realpathSync(sourcePath);
      const statistics = statSync(resolvedPath);
      if (!statistics.isFile()) throw new DomainError('TASK_ATTACHMENT_NOT_FILE', '任务附件必须是普通文件。', 422);
      if (statistics.size > 10 * 1024 * 1024) {
        throw new DomainError('TASK_ATTACHMENT_TOO_LARGE', '单个附件不能超过 10 MB。', 422);
      }
      const attachmentId = id('attachment');
      const originalName = basename(resolvedPath);
      const safeName = originalName.replaceAll(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_').slice(0, 160) || 'attachment';
      return {
        id: attachmentId,
        sourcePath: resolvedPath,
        fileName: originalName,
        artifactPath: join(project.projectSpacePath, 'tasks', taskId, 'attachments', `${attachmentId}-${safeName}`),
        size: statistics.size,
        createdAt: now(),
      };
    });
    const attachmentDirectory = join(project.projectSpacePath, 'tasks', taskId, 'attachments');
    mkdirSync(attachmentDirectory, { recursive: true });
    for (const item of prepared) copyFileSync(item.sourcePath, item.artifactPath);
    this.database.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO task_attachments(id, task_id, file_name, artifact_path, content_hash, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of prepared) {
        const contentHash = createHash('sha256').update(readFileSync(item.artifactPath)).digest('hex');
        insert.run(item.id, taskId, item.fileName, item.artifactPath, contentHash, item.size, item.createdAt);
      }
      this.appendEvent('task', taskId, 'task.attachments_added', 'user', `已添加 ${prepared.length} 个任务附件。`, {
        attachments: prepared.map((item) => ({ id: item.id, fileName: item.fileName, size: item.size })),
      });
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: attach files to task ${taskId}`, taskId);
    return this.listTaskAttachments(taskId);
  }

  listTaskAttachments(taskId: string): TaskAttachment[] {
    this.getTask(taskId);
    const rows = this.database.prepare(`
      SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as TaskAttachmentRow[];
    return rows.map((row) => {
      const content = readAttachmentPreview(row.artifact_path);
      return {
        id: row.id,
        taskId: row.task_id,
        fileName: row.file_name,
        artifactPath: row.artifact_path,
        contentHash: row.content_hash,
        size: row.size_bytes,
        contentPreview: content.preview,
        contentTruncated: content.truncated,
        createdAt: row.created_at,
      };
    });
  }

  listTasks(options?: { projectId?: string; includeArchived?: boolean }): Task[] {
    const where: string[] = [];
    const parameters: string[] = [];
    if (options?.projectId) { where.push('t.project_id = ?'); parameters.push(options.projectId); }
    if (!options?.includeArchived) where.push(`t.status NOT IN ('ARCHIVED', 'CANCELLED')`);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT t.*, p.name AS project_name, tm.name AS team_name
      FROM tasks t JOIN projects p ON p.id = t.project_id JOIN teams tm ON tm.id = t.team_id
      ${clause} ORDER BY t.updated_at DESC
    `).all(...parameters) as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  getTask(taskId: string): Task {
    const row = this.database.prepare(`
      SELECT t.*, p.name AS project_name, tm.name AS team_name
      FROM tasks t JOIN projects p ON p.id = t.project_id JOIN teams tm ON tm.id = t.team_id WHERE t.id = ?
    `).get(taskId) as TaskRow | undefined;
    if (!row) throw new DomainError('TASK_NOT_FOUND', '任务不存在。', 404);
    return this.taskFromRow(row);
  }

  buildPlanningContext(projectId: string, query: string): PlanningDirectoryContext[] {
    const project = this.getProject(projectId);
    return buildIndexedPlanningContext(this.database, project, query);
  }

  submitTask(taskId: string, stateVersion: number): Task {
    const task = this.getTask(taskId);
    this.assertStateVersion(task, stateVersion);
    const next = transitionTask(task.status, 'submit');
    this.database.transaction(() => {
      this.updateTaskState(taskId, task.stateVersion, next, 'task.analysis_requested', '任务已提交分析，等待协调执行器生成计划。');
      this.enqueueJobOrAssertRunnable(
        'COMPOSE_PLAN',
        taskId,
        `task:${taskId}:compose-plan:${task.stateVersion + 1}`,
        100,
      );
    })();
    return this.getTask(taskId);
  }

  saveComposedPlan(
    taskId: string,
    planDraft?: Partial<TaskPlan>,
    preApprovalArtifactInputs: PreApprovalArtifactInput[] = [],
    options: { preservePreviousSteps?: boolean } = {},
  ): Task {
    const task = this.getTask(taskId);
    if (task.status !== 'COMPOSING_PLAN' && task.status !== 'REPLANNING') {
      throw new DomainError('INVALID_TRANSITION', '当前任务不在计划生成状态。', 409);
    }
    const project = this.getProject(task.projectId);
    const planVersion = (this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM plans WHERE task_id = ?').get(taskId) as { version: number }).version + 1;
    let plan = this.buildPlan(task, project, planVersion, planDraft);
    if (task.status === 'REPLANNING' && options.preservePreviousSteps) {
      plan = this.preservePreviousPlanSteps(task, plan);
    }
    if (task.status === 'REPLANNING' && task.steps.some((step) => step.status !== 'pending')) {
      plan = this.alignReplannedSteps(task, plan);
    }
    const preApprovalArtifacts = preApprovalArtifactInputs.map((input) =>
      this.preparePreApprovalArtifact(task, plan, input));
    plan = { ...plan, preApprovalArtifacts };
    const nextTaskVersion = preApprovalArtifactInputs.length > 0
      ? this.prepareTaskVersionFromPlan(task, project, plan, '协调器确认前技能产出')
      : null;
    if (nextTaskVersion) {
      plan = {
        ...plan,
        taskVersionId: nextTaskVersion.id,
        taskVersion: nextTaskVersion.version,
      };
    }
    const markdown = this.renderPlan(task, plan);
    const artifact = writeVersionedArtifact(project.projectSpacePath, `plans/${taskId}/v${planVersion}.md`, markdown);
    const isRevision = task.status === 'REPLANNING';
    const nextStatus: TaskStatus = isRevision ? 'WAITING_REAPPROVAL' : 'WAITING_PLAN_APPROVAL';

    this.database.transaction(() => {
      if (nextTaskVersion) {
        this.database.prepare(`
          UPDATE task_versions SET status = 'superseded'
          WHERE task_id = ? AND status != 'superseded'
        `).run(taskId);
        this.database.prepare(`
          INSERT INTO task_versions(id, task_id, version, artifact_path, content_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?)
        `).run(nextTaskVersion.id, taskId, nextTaskVersion.version, nextTaskVersion.artifactPath,
          nextTaskVersion.contentHash, nextTaskVersion.createdAt);
      }
      this.database.prepare(`INSERT INTO plans(id, task_id, version, content_json, artifact_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(plan.id, taskId, plan.version, JSON.stringify(plan), artifact.path, artifact.hash, plan.createdAt);
      this.database.prepare('UPDATE tasks SET flow_version = ? WHERE id = ?').run(plan.flowVersion ?? 1, taskId);
      const insertPreApprovalArtifact = this.database.prepare(`
        INSERT INTO preapproval_artifact_versions(
          id, task_id, plan_id, artifact_type, title, version, status, artifact_path,
          content_hash, source_executor, source_model, source_session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of preApprovalArtifacts) {
        this.database.prepare(`
          UPDATE preapproval_artifact_versions SET status = 'superseded'
          WHERE task_id = ? AND artifact_type = ? AND status != 'superseded'
        `).run(taskId, item.artifactType);
        insertPreApprovalArtifact.run(
          item.id,
          item.taskId,
          item.planId,
          item.artifactType,
          item.title,
          item.version,
          item.status,
          item.artifactPath,
          item.contentHash,
          item.sourceExecutor,
          item.sourceModel,
          item.sourceSessionId,
          item.createdAt,
        );
      }
      this.replaceStepsForComposedPlan(task, plan, isRevision);
      this.updateTaskState(taskId, task.stateVersion, nextStatus, isRevision ? 'plan.recomposed' : 'plan.composed',
        `计划 v${planVersion} 已生成，等待确认。`, { planId: plan.id });
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: compose plan v${planVersion} for ${taskId}`, taskId);
    return this.getTask(taskId);
  }

  listTaskPlans(taskId: string): TaskPlan[] {
    this.getTask(taskId);
    const fallbackTaskVersion = this.getCurrentTaskVersion(taskId);
    const rows = this.database.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC').all(taskId) as PlanRow[];
    return rows.map((row) => {
      const plan = parseJson<TaskPlan>(row.content_json, null as unknown as TaskPlan);
      return {
        ...plan,
        taskVersionId: plan.taskVersionId ?? fallbackTaskVersion.id,
        taskVersion: plan.taskVersion ?? fallbackTaskVersion.version,
        preApprovalSkillIds: plan.preApprovalSkillIds ?? [],
        steps: plan.steps ?? [],
        preApprovalArtifacts: plan.preApprovalArtifacts ?? [],
        answersReviewedAt: plan.answersReviewedAt ?? null,
        confirmedAt: row.confirmed_at,
      };
    });
  }

  listTaskArtifacts(taskId: string): ArtifactVersion[] {
    this.getTask(taskId);
    return (this.database.prepare(`
      SELECT * FROM artifact_versions WHERE task_id = ? ORDER BY created_at, artifact_type, version
    `).all(taskId) as ArtifactRow[]).map(this.artifactFromRow);
  }

  listDesignedQualityGates(taskId: string): QualityGate[] {
    this.getTask(taskId);
    const rows = this.database.prepare(`
      SELECT * FROM task_designed_gates WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as DesignedGateRow[];
    return rows.map((row) => {
      const commandArgv = parseJson<string[]>(row.command_argv_json, []);
      return {
        id: row.id,
        name: row.name,
        command: commandArgv.join(' '),
        commandArgv,
        directoryId: row.directory_id,
        source: 'task_specific',
        timeoutMs: row.timeout_ms,
        expectedExitCodes: parseJson<number[]>(row.expected_exit_codes_json, [0]),
        required: Boolean(row.required),
        status: 'pending',
      };
    });
  }

  getEffectiveQualityGates(taskId: string): QualityGate[] {
    const task = this.getTask(taskId);
    const confirmed = task.plan?.qualityGates ?? [];
    const signatures = new Set(confirmed.map((gate) =>
      `${gate.directoryId}:${(gate.commandArgv ?? gate.command.trim().split(/\s+/)).join('\u0000')}`));
    const designed = this.listDesignedQualityGates(taskId)
      .filter((gate) => this.isDesignedGateWithinConfirmedCommand(task, gate))
      .filter((gate) => {
        const signature = `${gate.directoryId}:${(gate.commandArgv ?? []).join('\u0000')}`;
        if (signatures.has(signature)) return false;
        signatures.add(signature);
        return true;
      });
    return [...confirmed, ...designed];
  }

  listDeliveryConflicts(taskId: string): DeliveryConflict[] {
    this.getTask(taskId);
    const rows = this.database.prepare(`
      SELECT * FROM delivery_conflicts WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as DeliveryConflictRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      directoryId: row.directory_id,
      taskBranch: row.task_branch,
      targetBranch: row.target_branch,
      classification: row.classification,
      conflicts: parseJson(row.conflicts_json, []),
      mechanicallyResolvableFiles: parseJson(row.mechanically_resolvable_files_json, []),
      status: row.status,
      resolution: row.resolution,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  buildContextPack(taskId: string, stepId: string): TaskContextPack {
    const task = this.getTask(taskId);
    const snapshot = this.getRunSnapshot(taskId);
    if (!snapshot) throw new DomainError('RUN_SNAPSHOT_REQUIRED', '构建上下文前必须存在已确认运行快照。', 409);
    const currentStep = task.steps.find((step) => step.id === stepId);
    if (!currentStep) throw new DomainError('STEP_NOT_FOUND', '当前执行单元不存在。', 404);
    const previousStepIds = new Set(task.steps.filter((step) => step.position < currentStep.position).map((step) => step.id));
    let remainingCharacters = 64_000;
    let truncated = false;
    const upstreamArtifacts = this.listTaskArtifacts(taskId)
      .filter((artifact) => previousStepIds.has(artifact.stepId) && artifact.status !== 'superseded')
      .map((artifact) => {
        const raw = readArtifactContent(artifact.artifactPath);
        const budget = Math.max(0, Math.min(16_000, remainingCharacters));
        const content = raw.slice(0, budget);
        if (content.length < raw.length) truncated = true;
        remainingCharacters -= content.length;
        return { ...artifact, content };
      })
      .filter((artifact) => artifact.content.length > 0);
    const resultRows = this.database.prepare(`
      SELECT s.step_id, s.agent_id, s.external_session_id, s.result_path, ts.title, ts.position
      FROM agent_sessions s
      JOIN task_steps ts ON ts.id = s.step_id
      WHERE s.task_id = ? AND ts.position < ? AND ts.status = 'succeeded'
        AND s.status = 'succeeded' AND s.result_path IS NOT NULL
      ORDER BY ts.position, s.started_at DESC
    `).all(taskId, currentStep.position) as Array<{
      step_id: string;
      agent_id: string | null;
      external_session_id: string | null;
      result_path: string;
      title: string;
      position: number;
    }>;
    const seenResultSteps = new Set<string>();
    const upstreamResults = resultRows.filter((row) => {
      if (seenResultSteps.has(row.step_id)) return false;
      seenResultSteps.add(row.step_id);
      return true;
    }).map((row) => {
      const raw = readArtifactContent(row.result_path);
      const envelope = parseJson<Record<string, unknown>>(raw, {});
      const result = envelope.result && typeof envelope.result === 'object'
        ? envelope.result as Record<string, unknown>
        : {};
      const strings = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
      return {
        stepId: row.step_id,
        title: row.title,
        agentId: row.agent_id,
        externalSessionId: row.external_session_id,
        summary: typeof result.summary === 'string' ? result.summary : '',
        issues: strings(result.issues),
        assumptions: strings(result.assumptions),
        reportedChecks: strings(result.reportedChecks),
        findings: Array.isArray(result.findings) ? result.findings as ReviewFinding[] : [],
        resultPath: row.result_path,
        contentHash: sha256(raw),
      };
    });
    const queryText = [
      task.title, task.description, currentStep.title, currentStep.description,
      ...currentStep.inputs, ...upstreamArtifacts.map((artifact) => `${artifact.title} ${artifact.content.slice(0, 1_000)}`),
      ...upstreamResults.map((result) => `${result.title} ${result.summary} ${result.issues.join(' ')}`),
    ].join(' ');
    const failedGateRows = this.database.prepare(`
      SELECT * FROM gate_attempts
      WHERE task_id = ? AND status = 'failed'
      ORDER BY started_at DESC
      LIMIT 6
    `).all(taskId) as GateAttemptRow[];
    const gateEvidence = failedGateRows.map((row) => {
      const raw = readArtifactContent(row.log_path);
      const budget = Math.max(0, Math.min(8_000, remainingCharacters));
      const logExcerpt = raw.slice(Math.max(0, raw.length - budget));
      if (logExcerpt.length < raw.length) truncated = true;
      remainingCharacters -= logExcerpt.length;
      return {
        gateId: row.gate_id,
        attempt: row.attempt,
        commandArgv: parseJson<string[]>(row.command_argv_json, []),
        status: row.status,
        exitCode: row.exit_code,
        timedOut: Boolean(row.timed_out),
        logPath: row.log_path,
        logExcerpt,
        contentHash: sha256(raw),
      };
    }).filter((item) => item.logExcerpt.length > 0);
    const projectKnowledge = rankKnowledge(
      this.listKnowledge(task.projectId).filter((item) => item.status === 'active'),
      queryText,
    ).slice(0, 6).map((item) => {
      const budget = Math.max(0, Math.min(6_000, remainingCharacters));
      const content = item.content.slice(0, budget);
      if (content.length < item.content.length) truncated = true;
      remainingCharacters -= content.length;
      return { id: item.id, category: item.category, title: item.title, content, version: item.version };
    }).filter((item) => item.content.length > 0);
    const recentEvidence = this.listEvents(taskId).filter((event) =>
      ['skill_step.succeeded', 'skill_step.failed', 'work_unit.succeeded', 'work_unit.changes_required', 'work_unit.blocked',
        'quality_gate.completed', 'job.retry_scheduled', 'task.retrying',
        'skill_step.changes_required', 'skill_step.blocked', 'plan.recomposed', 'permission.responded',
        'scope.change_detected'].includes(event.type),
    ).slice(-12);
    const createdAt = now();
    const contextId = id('context');
    const sources: ContextPackSource[] = [
      {
        type: 'snapshot', id: snapshot.id, title: `运行快照 plan v${snapshot.planVersion}`,
        hash: snapshot.contentHash, characters: JSON.stringify({ task: snapshot.task, plan: snapshot.plan }).length,
      },
      ...upstreamArtifacts.map((artifact) => ({
        type: 'artifact' as const,
        id: artifact.id,
        title: artifact.title,
        hash: artifact.contentHash,
        characters: artifact.content.length,
      })),
      ...upstreamResults.map((result) => ({
        type: 'result' as const,
        id: result.stepId,
        title: `${result.title} · 执行结果`,
        hash: result.contentHash,
        characters: JSON.stringify(result).length,
      })),
      ...projectKnowledge.map((item) => ({
        type: 'knowledge' as const,
        id: item.id,
        title: item.title,
        hash: sha256(item.content),
        characters: item.content.length,
      })),
      ...snapshot.directories.filter((directory) => currentStep.directoryIds.includes(directory.id)).map((directory) => ({
        type: 'directory' as const,
        id: directory.id,
        title: directory.displayName,
        hash: sha256(JSON.stringify(directory)),
        characters: JSON.stringify(directory).length,
      })),
      ...recentEvidence.map((event) => ({
        type: 'event' as const,
        id: event.id,
        title: event.message,
        hash: sha256(JSON.stringify(event)),
        characters: JSON.stringify(event).length,
      })),
      ...gateEvidence.map((gate) => ({
        type: 'gate' as const,
        id: `${gate.gateId}:${gate.attempt}`,
        title: `${gate.commandArgv.join(' ')} · ${gate.status}`,
        hash: gate.contentHash,
        characters: gate.logExcerpt.length,
      })),
    ];
    const base = {
      id: contextId,
      taskId,
      stepId,
      attempt: currentStep.attempt,
      task: snapshot.task,
      plan: snapshot.plan,
      currentStep,
      upstreamArtifacts,
      upstreamResults,
      projectKnowledge,
      directories: snapshot.directories.filter((directory) => currentStep.directoryIds.includes(directory.id)),
      recentEvidence,
      gateEvidence,
      sources,
      estimatedTokens: Math.ceil((sources.reduce((sum, source) => sum + source.characters, 0) + queryText.length) / 3),
      truncated,
      createdAt,
    };
    const project = this.getProject(task.projectId);
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `runs/${taskId}/context/${currentStep.position + 1}-${currentStep.skillId}-attempt-${currentStep.attempt}.json`,
      `${JSON.stringify(base, null, 2)}\n`,
    );
    this.database.prepare(`
      INSERT INTO context_packs(
        id, task_id, step_id, attempt, manifest_path, content_hash, source_count, estimated_tokens, truncated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, step_id, attempt) DO UPDATE SET manifest_path = excluded.manifest_path,
        content_hash = excluded.content_hash, source_count = excluded.source_count,
        estimated_tokens = excluded.estimated_tokens, truncated = excluded.truncated, created_at = excluded.created_at
    `).run(contextId, taskId, stepId, currentStep.attempt, artifact.path, artifact.hash, sources.length,
      base.estimatedTokens, Number(truncated), createdAt);
    this.appendEvent('task', taskId, 'context_pack.created', 'scheduler', `已为 ${currentStep.title} 构建最小上下文包。`, {
      contextPackId: contextId,
      sourceCount: sources.length,
      estimatedTokens: base.estimatedTokens,
      truncated,
    });
    return { ...base, contentHash: artifact.hash, manifestPath: artifact.path };
  }

  getTaskEvidence(taskId: string): TaskEvidence {
    this.getTask(taskId);
    const requirementRows = this.database.prepare(`
      SELECT id, version, artifact_path, content_hash, status, created_at
      FROM task_versions WHERE task_id = ? ORDER BY version
    `).all(taskId) as Array<{
      id: string; version: number; artifact_path: string; content_hash: string; status: string; created_at: string;
    }>;
    const contextRows = this.database.prepare(`
      SELECT * FROM context_packs WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as ContextPackRow[];
    const manifestRows = this.database.prepare(`
      SELECT * FROM change_manifests WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as ChangeManifestRow[];
    const gateRows = this.database.prepare(`
      SELECT * FROM gate_attempts WHERE task_id = ? ORDER BY started_at
    `).all(taskId) as GateAttemptRow[];
    const recoveryRows = this.database.prepare(`
      SELECT * FROM recovery_records WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as RecoveryRecordRow[];
    const deliveryActionRows = this.database.prepare(`
      SELECT * FROM delivery_actions WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as DeliveryActionRow[];
    const sessionRows = this.database.prepare(`
      SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY started_at
    `).all(taskId) as AgentSessionRow[];
    const deliveryReport = this.database.prepare(`
      SELECT artifact_path, content_hash, content_json, created_at
      FROM delivery_reports WHERE task_id = ?
    `).get(taskId) as DeliveryReportRow | undefined;
    const preApprovalRows = this.database.prepare(`
      SELECT * FROM preapproval_artifact_versions WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as PreApprovalArtifactRow[];
    const permissionRows = this.database.prepare(`
      SELECT * FROM permission_requests WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as PermissionRow[];
    return {
      requirementVersions: requirementRows.map((row) => ({
        id: row.id,
        version: row.version,
        artifactPath: row.artifact_path,
        contentHash: row.content_hash,
        status: row.status,
        createdAt: row.created_at,
      })),
      preApprovalArtifacts: preApprovalRows.map((row) => ({
        ...this.preApprovalArtifactFromRow(row),
        content: readArtifactContent(row.artifact_path),
      })),
      permissionManifests: this.getRunSnapshot(taskId)?.permissionManifests ?? [],
      permissionRequests: permissionRows.map((row) => this.permissionFromRow(row)),
      attachments: this.listTaskAttachments(taskId),
      artifacts: this.listTaskArtifacts(taskId),
      artifactPreviews: this.listTaskArtifacts(taskId).map((artifact) => {
        const content = readArtifactContent(artifact.artifactPath);
        return {
          artifactId: artifact.id,
          content: content.slice(0, 16_000),
          truncated: content.length > 16_000,
        };
      }),
      sessions: sessionRows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        stepId: row.step_id,
        agentId: row.agent_id,
        executor: row.executor,
        model: row.model,
        externalSessionId: row.external_session_id,
        status: row.status,
        resultPath: row.result_path,
        error: row.error,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
      contextPacks: contextRows.map((row) => ({
        id: row.id,
        stepId: row.step_id,
        attempt: row.attempt,
        contentHash: row.content_hash,
        manifestPath: row.manifest_path,
        estimatedTokens: row.estimated_tokens,
        truncated: Boolean(row.truncated),
        createdAt: row.created_at,
      })),
      changeManifests: manifestRows.map((row) => {
        const stored = parseJson<ChangeManifest>(readArtifactContent(row.artifact_path), null as unknown as ChangeManifest);
        return {
          ...stored,
          id: row.id,
          artifactPath: row.artifact_path,
          contentHash: row.content_hash,
          hasOutOfScopeChanges: Boolean(row.has_out_of_scope_changes),
          hasSensitiveChanges: Boolean(row.has_sensitive_changes),
          createdAt: row.created_at,
        };
      }),
      designedQualityGates: this.listDesignedQualityGates(taskId),
      qualitySummary: this.getTaskQualitySummary(taskId),
      gateAttempts: gateRows.map((row) => {
        const log = readArtifactContent(row.log_path);
        return {
          id: row.id,
          taskId: row.task_id,
          gateId: row.gate_id,
          attempt: row.attempt,
          directoryId: row.directory_id,
          commandArgv: parseJson(row.command_argv_json, []),
          status: row.status,
          exitCode: row.exit_code,
          signal: row.signal,
          timedOut: Boolean(row.timed_out),
          logPath: row.log_path,
          logExcerpt: log.slice(Math.max(0, log.length - 8_000)),
          logTruncated: log.length > 8_000,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        };
      }),
      deliveryConflicts: this.listDeliveryConflicts(taskId),
      recoveries: recoveryRows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        jobId: row.job_id,
        reason: row.reason,
        previousOwner: row.previous_owner,
        recoveredBy: row.recovered_by,
        action: row.action,
        createdAt: row.created_at,
      })),
      deliveryActions: deliveryActionRows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        action: row.action,
        status: row.status,
        details: parseJson(row.details_json, {}),
        createdAt: row.created_at,
      })),
      deliveryReport: deliveryReport ? {
        artifactPath: deliveryReport.artifact_path,
        contentHash: deliveryReport.content_hash,
        markdown: readArtifactContent(deliveryReport.artifact_path),
        data: parseJson(deliveryReport.content_json, {}),
        createdAt: deliveryReport.created_at,
      } : null,
    };
  }

  refreshDeliveryReport(taskId: string): void {
    const task = this.getTask(taskId);
    if (task.status !== 'DELIVERED') {
      throw new DomainError('DELIVERY_REPORT_STATE_INVALID', '只有待确认交付的任务可以刷新交付报告。', 409);
    }
    this.createDeliveryReport(taskId);
  }

  getRunSnapshot(taskId: string): TaskRunSnapshot | null {
    const row = this.database.prepare('SELECT * FROM run_snapshots WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as SnapshotRow | undefined;
    if (!row) return null;
    const content = parseJson<TaskRunSnapshot>(row.content_json, null as unknown as TaskRunSnapshot);
    return {
      ...content,
      id: row.id,
      taskId: row.task_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      contentHash: row.content_hash,
      artifactPath: row.artifact_path,
      createdAt: row.created_at,
    };
  }

  requestPlanRevision(taskId: string, input: RequestPlanRevisionInput): Task {
    const task = this.getTask(taskId);
    this.assertStateVersion(task, input.stateVersion);
    if (!task.plan || !['WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL'].includes(task.status)) {
      throw new DomainError('PLAN_REVISION_NOT_ALLOWED', '只有待确认的计划可以请求协调器重新规划。', 409);
    }
    const feedback = input.feedback.trim();
    if (!feedback) throw new DomainError('PLAN_REVISION_FEEDBACK_REQUIRED', '请说明需要修改的内容。', 422);
    const project = this.getProject(task.projectId);
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `plans/${taskId}/revision-requests/v${task.plan.version}.md`,
      `# 计划 v${task.plan.version} 修改请求\n\n- 步骤结构：${
        input.allowStepChanges === true ? '允许人工要求增删或重排' : '保持原 Skill 序列，仅完善内容'
      }\n\n${feedback}\n`,
    );
    this.database.transaction(() => {
      this.updateTaskState(taskId, task.stateVersion, 'REPLANNING', 'plan.revision_requested', '用户请求协调器修改计划。', {
        planId: task.plan?.id,
        planVersion: task.plan?.version,
        feedback,
        allowStepChanges: input.allowStepChanges === true,
        artifactPath: artifact.path,
      });
      this.enqueueJobOrAssertRunnable(
        'COMPOSE_PLAN',
        taskId,
        `task:${taskId}:replan:${task.stateVersion + 1}`,
        100,
        {
          feedback,
          previousPlanVersion: task.plan?.version,
          preservePreviousSteps: input.allowStepChanges !== true,
        },
      );
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: request plan revision for ${taskId}`, taskId);
    return this.getTask(taskId);
  }

  updatePlanAnswers(taskId: string, input: AnswerPlanInput): Task {
    const task = this.getTask(taskId);
    if (!task.plan || !['WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL'].includes(task.status)) {
      throw new DomainError('PLAN_NOT_EDITABLE', '当前任务没有可编辑的待确认计划。', 409);
    }
    const project = this.getProject(task.projectId);
    const stepAssignments = new Map(input.stepAssignments?.map((item) => [item.stepId, item.agentId]) ?? []);
    const stepCapabilities = new Map(input.stepCapabilities?.map((item) => [item.stepId, item.capabilityIds]) ?? []);
    const planStepIds = new Set(task.plan.steps.map((step) => step.id));
    for (const stepId of [...stepAssignments.keys(), ...stepCapabilities.keys()]) {
      if (!planStepIds.has(stepId)) throw new DomainError('PLAN_STEP_UNKNOWN', '计划修订引用了不存在的执行单元。', 422, { stepId });
    }
    const nextSteps = task.plan.steps.map((step) => ({
      ...step,
      agentId: stepAssignments.has(step.id) ? stepAssignments.get(step.id) ?? null : step.agentId,
      capabilityIds: stepCapabilities.has(step.id)
        ? [...new Set(stepCapabilities.get(step.id) ?? [])]
        : (step.capabilityIds ?? []),
    }));
    this.validatePlanSteps(task, project, nextSteps);
    const nextRoutes = input.branchRoutes
      ? this.resolveBranchRoutes(task, project, nextSteps, input.branchRoutes)
      : task.plan.branchRoutes;
    const waivedGateIds = new Set(input.waivedGateIds ?? task.plan.qualityGates.filter((gate) => gate.status === 'waived').map((gate) => gate.id));
    const nextQualityGates = task.plan.qualityGates.map((gate) => ({
      ...gate,
      status: waivedGateIds.has(gate.id) ? 'waived' as const : 'pending' as const,
    }));
    const answersChanged = task.plan.questions.some((question) => {
      const nextAnswer = input.answers[question.id];
      return nextAnswer !== undefined && nextAnswer.trim() !== (question.answer ?? '').trim();
    });
    const requirementFieldsChanged = answersChanged
      || (input.goal !== undefined && input.goal.trim() !== task.plan.goal.trim())
      || (input.scope !== undefined && JSON.stringify(input.scope) !== JSON.stringify(task.plan.scope))
      || (input.nonScope !== undefined && JSON.stringify(input.nonScope) !== JSON.stringify(task.plan.nonScope))
      || (input.successCriteria !== undefined
        && JSON.stringify(input.successCriteria) !== JSON.stringify(task.plan.successCriteria));
    const planContentChanged = requirementFieldsChanged
      || JSON.stringify(nextSteps) !== JSON.stringify(task.plan.steps)
      || JSON.stringify(nextRoutes) !== JSON.stringify(task.plan.branchRoutes)
      || JSON.stringify(input.permissions ?? task.plan.permissions) !== JSON.stringify(task.plan.permissions)
      || JSON.stringify(nextQualityGates) !== JSON.stringify(task.plan.qualityGates);
    if (!planContentChanged) return task;
    let nextPlan: TaskPlan = {
      ...task.plan,
      version: task.plan.version + 1,
      id: id('plan'),
      goal: input.goal ?? task.plan.goal,
      scope: input.scope ?? task.plan.scope,
      nonScope: input.nonScope ?? task.plan.nonScope,
      successCriteria: input.successCriteria ?? task.plan.successCriteria,
      questions: task.plan.questions.map((item) => ({ ...item, answer: input.answers[item.id] ?? item.answer })),
      steps: nextSteps,
      branchRoutes: nextRoutes,
      permissions: input.permissions ?? task.plan.permissions,
      qualityGates: nextQualityGates,
      answersReviewedAt: answersChanged ? null : task.plan.answersReviewedAt,
      createdAt: now(),
      confirmedAt: null,
    };
    const nextTaskVersion = requirementFieldsChanged
      ? this.prepareTaskVersionFromPlan(task, project, nextPlan, '用户修订计划需求与歧义答案')
      : null;
    if (nextTaskVersion) {
      nextPlan = {
        ...nextPlan,
        taskVersionId: nextTaskVersion.id,
        taskVersion: nextTaskVersion.version,
      };
    }
    const artifact = writeVersionedArtifact(project.projectSpacePath, `plans/${taskId}/v${nextPlan.version}.md`, this.renderPlan(task, nextPlan));
    this.database.transaction(() => {
      if (nextTaskVersion) {
        this.database.prepare(`
          UPDATE task_versions SET status = 'superseded'
          WHERE task_id = ? AND status != 'superseded'
        `).run(taskId);
        this.database.prepare(`
          INSERT INTO task_versions(id, task_id, version, artifact_path, content_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?)
        `).run(nextTaskVersion.id, taskId, nextTaskVersion.version, nextTaskVersion.artifactPath,
          nextTaskVersion.contentHash, nextTaskVersion.createdAt);
      }
      this.database.prepare(`INSERT INTO plans(id, task_id, version, content_json, artifact_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(nextPlan.id, taskId, nextPlan.version, JSON.stringify(nextPlan), artifact.path, artifact.hash, nextPlan.createdAt);
      this.replacePendingSteps(task, nextPlan);
      this.appendEvent('task', taskId, 'plan.revised', 'user', `计划已修订为 v${nextPlan.version}。`, {
        planId: nextPlan.id,
        taskVersionId: nextPlan.taskVersionId,
        taskVersion: nextPlan.taskVersion,
      });
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: revise plan v${nextPlan.version} for ${taskId}`, taskId);
    return this.getTask(taskId);
  }

  commandTask(
    taskId: string,
    command: TaskCommand,
    stateVersion: number,
    reason?: string,
    executorInstallations: ExecutorInstallation[] = [],
  ): Task {
    const task = this.validateTaskCommand(taskId, command, stateVersion);
    if (command === 'resume') return this.resumeTask(task, reason);
    const correction = command === 'reopen' ? reason?.trim() : undefined;
    if (command === 'reopen' && !correction) {
      throw new DomainError('TASK_CORRECTION_REQUIRED', '请先说明交付结果与预期不符的具体内容。', 422);
    }
    if (command === 'confirm' && task.plan?.questions.some((question) => !question.answer?.trim())) {
      throw new DomainError('PLAN_QUESTIONS_UNANSWERED', '请先回答计划中的全部歧义问题。', 422);
    }
    if (command === 'confirm' && task.plan?.questions.length && !task.plan.answersReviewedAt) {
      throw new DomainError('PLAN_ANSWERS_NOT_REVIEWED', '歧义答案需要先交给协调器完善计划，再进行最终确认。', 422);
    }
    if (command === 'confirm' && task.plan) {
      const missingPreApprovalSkills = task.plan.preApprovalSkillIds.filter((skillId) => {
        const skill = builtinSkills.find((item) => item.id === skillId);
        return !skill || !skill.artifactTypes.some((artifactType) =>
          task.plan?.preApprovalArtifacts.some((artifact) =>
            artifact.artifactType === artifactType && artifact.status !== 'superseded'));
      });
      if (missingPreApprovalSkills.length > 0) {
        throw new DomainError('PREAPPROVAL_ARTIFACT_MISSING', '确认前 Skill 没有形成完整的版本化产物。', 422, {
          skills: missingPreApprovalSkills,
        });
      }
      const versionChainIds = new Set([
        task.plan.id,
        task.plan.taskVersionId,
        ...task.plan.preApprovalArtifacts.map((artifact) => artifact.id),
      ]);
      const modifiedVersionChain = this.checkProjectSpaceIntegrity(task.projectId).issues
        .filter((issue) => versionChainIds.has(issue.entityId));
      if (modifiedVersionChain.length > 0) {
        throw new DomainError(
          'PROJECT_SPACE_VERSION_CHAIN_MODIFIED',
          '需求、计划或确认前产物已在 ProjectSpace 外部发生变化，请先核对后重新生成计划。',
          409,
          { issues: modifiedVersionChain },
        );
      }
    }
    if (command === 'confirm') {
      const uncovered = task.steps.filter((step) => !step.agentId);
      if (uncovered.length > 0) {
        throw new DomainError('TEAM_ASSIGNMENT_GAP', '计划中仍有执行单元未分配人员，请调整团队或修改计划。', 422, {
          steps: uncovered.map((step) => step.title),
        });
      }
    }
    const next = transitionTask(task.status, command);
    const snapshot = command === 'confirm' ? this.buildRunSnapshot(task, executorInstallations) : null;
    const requirementRevision = correction ? this.prepareRequirementRevision(task, correction) : null;
    this.database.transaction(() => {
      if (command === 'confirm' && task.plan) {
        this.database.prepare('UPDATE plans SET confirmed_at = ? WHERE id = ?').run(now(), task.plan.id);
        this.database.prepare(`
          UPDATE task_versions SET status = 'approved'
          WHERE id = ? AND task_id = ? AND status = 'draft'
        `).run(task.plan.taskVersionId, taskId);
        this.database.prepare(`
          UPDATE preapproval_artifact_versions
          SET status = 'approved'
          WHERE plan_id = ? AND status = 'generated'
        `).run(task.plan.id);
        this.database.prepare('DELETE FROM gate_results WHERE task_id = ?').run(taskId);
        this.database.prepare('UPDATE tasks SET auto_replan_count = 0 WHERE id = ?').run(taskId);
      }
      if (snapshot) {
        this.persistTaskCapabilitySnapshots(taskId, snapshot.capabilities ?? []);
        this.database.prepare(`
          INSERT INTO run_snapshots(
            id, task_id, plan_id, plan_version, content_json, content_hash, artifact_path, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(snapshot.id, snapshot.taskId, snapshot.planId, snapshot.planVersion, JSON.stringify(snapshot),
          snapshot.contentHash, snapshot.artifactPath, snapshot.createdAt);
      }
      if (requirementRevision) {
        this.database.prepare(`
          DELETE FROM context_fts
          WHERE entity_id IN (
            SELECT id FROM knowledge_items
            WHERE source_task_id = ? AND status IN ('candidate', 'active')
          )
        `).run(taskId);
        this.database.prepare(`
          UPDATE knowledge_items SET status = 'superseded', updated_at = ?
          WHERE source_task_id = ? AND status IN ('candidate', 'active')
        `).run(requirementRevision.createdAt, taskId);
        this.database.prepare(`
          UPDATE task_versions SET status = 'superseded' WHERE task_id = ? AND status != 'superseded'
        `).run(taskId);
        this.database.prepare(`
          INSERT INTO task_versions(id, task_id, version, artifact_path, content_hash, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?)
        `).run(id('taskv'), taskId, requirementRevision.version, requirementRevision.artifactPath,
          requirementRevision.contentHash, requirementRevision.createdAt);
        this.database.prepare(`
          UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?
        `).run(requirementRevision.description, requirementRevision.createdAt, taskId);
      }
      this.updateTaskState(taskId, task.stateVersion, next, `task.${command}`, reason || this.commandMessage(command), {
        previousStatus: task.status,
        ...(requirementRevision ? {
          requirementVersion: requirementRevision.version,
          artifactPath: requirementRevision.artifactPath,
          contentHash: requirementRevision.contentHash,
        } : {}),
      });
      if (command === 'stop') {
        this.database.prepare(`
          UPDATE permission_requests SET status = 'resolved', decision = 'reject', message = '任务已停止。', resolved_at = ?
          WHERE task_id = ? AND status = 'pending'
        `).run(now(), taskId);
      }
      if (command === 'cancel') {
        this.database.prepare(`
          UPDATE permission_requests SET status = 'resolved', decision = 'reject', message = '任务已废弃。', resolved_at = ?
          WHERE task_id = ? AND status = 'pending'
        `).run(now(), taskId);
        this.database.prepare(`
          UPDATE jobs SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE aggregate_id = ? AND status = 'READY'
        `).run(now(), taskId);
      }
      if (command === 'self_merge') {
        this.database.prepare(`
          UPDATE delivery_conflicts
          SET status = 'resolved', resolution = 'user_managed', resolved_at = ?
          WHERE task_id = ? AND status = 'pending'
        `).run(now(), taskId);
        this.database.prepare(`
          INSERT INTO delivery_actions(id, task_id, action, status, details_json, created_at)
          VALUES (?, ?, 'self_merge', 'succeeded', ?, ?)
        `).run(id('deliveryaction'), taskId, JSON.stringify({
          taskBranches: this.getPreparedWorkspaces(taskId).map((workspace) => ({
            directoryId: workspace.directoryId,
            taskBranch: workspace.taskBranch,
            targetBranch: workspace.targetBranch,
          })),
        }), now());
      }
      if (command === 'confirm') {
        this.enqueueJobOrAssertRunnable(
          'PREPARE_WORKSPACE',
          taskId,
          `task:${taskId}:prepare:${task.stateVersion + 1}`,
          80,
        );
      }
    })();
    if (snapshot) {
      const project = this.getProject(task.projectId);
      this.recordProjectSpaceCommit(project.projectSpacePath, `docs: confirm plan v${snapshot.planVersion} for ${taskId}`, taskId);
    }
    if (requirementRevision) {
      this.recordProjectSpaceCommit(this.getProject(task.projectId).projectSpacePath,
        `docs: revise requirement v${requirementRevision.version} for ${taskId}`, taskId);
    }
    if (command === 'cancel') {
      this.recordProjectSpaceCommit(this.getProject(task.projectId).projectSpacePath,
        `docs: cancel task ${taskId}`, taskId);
    }
    if (command === 'self_merge') this.createDeliveryReport(taskId);
    if (command === 'self_merge' || command === 'merge') this.createKnowledgeCandidatesForArchivedTask(taskId);
    return this.getTask(taskId);
  }

  private resumeTask(task: Task, reason?: string): Task {
    const lastInterruption = this.database.prepare(`
      SELECT payload_json FROM workflow_events
      WHERE aggregate_id = ? AND event_type IN ('task.pause', 'task.stop')
      ORDER BY seq DESC LIMIT 1
    `).get(task.id) as { payload_json: string } | undefined;
    const interruptedStatus = parseJson<{ previousStatus?: TaskStatus }>(lastInterruption?.payload_json ?? '{}', {}).previousStatus;
    const latestJob = this.database.prepare(`
      SELECT type, payload_json, status FROM jobs WHERE aggregate_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(task.id) as { type: string; payload_json: string; status: string } | undefined;
    const stoppedDuringPlanning = task.status !== 'BLOCKED'
      && ['COMPOSING_PLAN', 'REPLANNING', 'WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL'].includes(interruptedStatus ?? '');
    const planningInterrupted = stoppedDuringPlanning
      || (latestJob?.type === 'COMPOSE_PLAN' && (latestJob.status === 'FAILED' || !task.snapshot));
    const hasRunnableJob = (type: string) => Boolean(this.database.prepare(`
      SELECT 1 FROM jobs WHERE aggregate_id = ? AND type = ? AND status IN ('READY', 'LEASED') LIMIT 1
    `).get(task.id, type));

    let nextStatus: TaskStatus;
    let nextJob: { type: string; priority: number; payload?: Record<string, unknown> } | null = null;
    let resetRunningStep = false;
    let resetBlockedStepId: string | null = null;

    if (planningInterrupted) {
      if (interruptedStatus === 'WAITING_PLAN_APPROVAL' || interruptedStatus === 'WAITING_REAPPROVAL') {
        nextStatus = interruptedStatus;
      } else {
        nextStatus = interruptedStatus === 'REPLANNING' ? 'REPLANNING' : 'COMPOSING_PLAN';
        if (!hasRunnableJob('COMPOSE_PLAN')) {
          nextJob = {
            type: 'COMPOSE_PLAN',
            priority: 100,
            payload: parseJson(latestJob?.payload_json ?? '{}', {}),
          };
        }
      }
    } else if (!task.snapshot) {
      nextStatus = task.plan?.version && task.plan.version > 1 ? 'WAITING_REAPPROVAL' : 'WAITING_PLAN_APPROVAL';
    } else {
      const runSnapshot = this.getRunSnapshot(task.id);
      const workspaceCount = this.getPreparedWorkspaces(task.id).length;
      const requiredWorkspaceCount = runSnapshot?.plan.branchRoutes.length ?? 0;
      const runningStep = task.steps.find((step) => step.status === 'running');
      const pendingStep = task.steps.find((step) => step.status === 'pending');
      const blockedStep = task.status === 'BLOCKED'
        ? task.steps.find((step) => step.status === 'failed')
        : undefined;
      if (workspaceCount < requiredWorkspaceCount) {
        nextStatus = 'PREPARING';
        if (!hasRunnableJob('PREPARE_WORKSPACE')) nextJob = { type: 'PREPARE_WORKSPACE', priority: 80 };
      } else if (runningStep) {
        nextStatus = task.status === 'PAUSED' && hasRunnableJob('RUN_SKILL_STEP') ? 'RUNNING' : 'RETRYING';
        if (nextStatus === 'RETRYING') {
          resetRunningStep = true;
          nextJob = { type: 'RUN_SKILL_STEP', priority: 85 };
        }
      } else if (blockedStep) {
        nextStatus = 'RETRYING';
        resetBlockedStepId = blockedStep.id;
        nextJob = { type: 'RUN_SKILL_STEP', priority: 85 };
      } else if (!this.requiredGatesSatisfied(task) && (!pendingStep || pendingStep.skillId === 'delivery-review')) {
        nextStatus = 'VALIDATING';
        if (!hasRunnableJob('RUN_QUALITY_GATE')) nextJob = { type: 'RUN_QUALITY_GATE', priority: 75 };
      } else if (pendingStep) {
        nextStatus = 'RUNNING';
        if (!hasRunnableJob('RUN_SKILL_STEP')) nextJob = { type: 'RUN_SKILL_STEP', priority: 70 };
      } else {
        nextStatus = 'DELIVERED';
      }
    }

    this.database.transaction(() => {
      const cleanupTimestamp = now();
      this.database.prepare(`
        UPDATE task_steps
        SET status = 'skipped', completed_at = COALESCE(completed_at, ?)
        WHERE task_id = ? AND position >= 1000 AND status != 'succeeded'
      `).run(cleanupTimestamp, task.id);
      this.database.prepare(`
        UPDATE tasks SET active_step_id = NULL
        WHERE id = ? AND active_step_id IN (
          SELECT id FROM task_steps WHERE task_id = ? AND position >= 1000
        )
      `).run(task.id, task.id);
      if (resetRunningStep) {
        this.database.prepare(`
          UPDATE task_steps SET status = 'pending', completed_at = NULL
          WHERE task_id = ? AND status = 'running' AND position < 1000
        `).run(task.id);
        this.database.prepare('UPDATE tasks SET active_step_id = NULL WHERE id = ?').run(task.id);
      }
      if (resetBlockedStepId) {
        this.database.prepare(`
          UPDATE task_steps SET status = 'pending', completed_at = NULL
          WHERE id = ? AND task_id = ? AND status = 'failed'
        `).run(resetBlockedStepId, task.id);
      }
      this.updateTaskState(task.id, task.stateVersion, nextStatus, 'task.resume', reason || this.commandMessage('resume'), {
        previousStatus: task.status,
        resumedTo: nextStatus,
      });
      if (nextJob) {
        this.enqueueJobOrAssertRunnable(
          nextJob.type,
          task.id,
          `task:${task.id}:resume:${task.stateVersion + 1}:${nextJob.type}`,
          nextJob.priority,
          nextJob.payload,
        );
      }
    })();
    if (nextStatus === 'DELIVERED') this.createDeliveryReport(task.id);
    return this.getTask(task.id);
  }

  validateTaskCommand(taskId: string, command: TaskCommand, stateVersion: number): Task {
    const task = this.getTask(taskId);
    this.assertStateVersion(task, stateVersion);
    transitionTask(task.status, command);
    return task;
  }

  recordDeliveryMerge(taskId: string, results: MergeResult[]): void {
    this.getTask(taskId);
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE delivery_conflicts
        SET status = 'resolved', resolution = 'merged_after_retry', resolved_at = ?
        WHERE task_id = ? AND status = 'pending'
      `).run(now(), taskId);
      this.appendEvent('task', taskId, 'delivery.merged', 'system', '任务分支已合并到指定目标分支。', {
        results: results.map((result) => ({
          directoryId: result.directoryId,
          taskBranch: result.taskBranch,
          targetBranch: result.targetBranch,
          previousTargetCommit: result.previousTargetCommit,
          mergedCommit: result.mergedCommit,
          alreadyMerged: result.alreadyMerged,
          mechanicallyResolvedFiles: result.mechanicallyResolvedFiles,
        })),
      });
    })();
  }

  recordDeliveryAction(
    taskId: string,
    action: DeliveryAction['action'],
    status: DeliveryAction['status'],
    details: Record<string, unknown> = {},
  ): DeliveryAction {
    this.getTask(taskId);
    const deliveryAction: DeliveryAction = {
      id: id('deliveryaction'),
      taskId,
      action,
      status,
      details,
      createdAt: now(),
    };
    this.database.prepare(`
      INSERT INTO delivery_actions(id, task_id, action, status, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(deliveryAction.id, taskId, action, status, JSON.stringify(details), deliveryAction.createdAt);
    return deliveryAction;
  }

  recordDeliveryConflict(taskId: string, error: DomainError): DeliveryConflict {
    this.getTask(taskId);
    const details = (error.details ?? {}) as {
      directoryId?: string;
      taskBranch?: string;
      targetBranch?: string;
      conflicts?: DeliveryConflict['conflicts'];
      mechanicallyResolvableFiles?: string[];
    };
    const conflict: DeliveryConflict = {
      id: id('deliveryconflict'),
      taskId,
      directoryId: details.directoryId ?? 'unknown',
      taskBranch: details.taskBranch ?? 'unknown',
      targetBranch: details.targetBranch ?? 'unknown',
      classification: 'semantic',
      conflicts: details.conflicts ?? [],
      mechanicallyResolvableFiles: details.mechanicallyResolvableFiles ?? [],
      status: 'pending',
      resolution: null,
      createdAt: now(),
      resolvedAt: null,
    };
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE delivery_conflicts
        SET status = 'resolved', resolution = 'superseded_by_retry', resolved_at = ?
        WHERE task_id = ? AND status = 'pending'
      `).run(conflict.createdAt, taskId);
      this.database.prepare(`
        INSERT INTO delivery_conflicts(
          id, task_id, directory_id, task_branch, target_branch, classification,
          conflicts_json, mechanically_resolvable_files_json, status, resolution, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conflict.id,
        conflict.taskId,
        conflict.directoryId,
        conflict.taskBranch,
        conflict.targetBranch,
        conflict.classification,
        JSON.stringify(conflict.conflicts),
        JSON.stringify(conflict.mechanicallyResolvableFiles),
        conflict.status,
        conflict.resolution,
        conflict.createdAt,
        conflict.resolvedAt,
      );
      this.appendEvent('task', taskId, 'delivery.semantic_conflict', 'system',
        '自动合并检测到语义冲突，任务分支和目标分支均保持不变。', {
          conflictId: conflict.id,
          directoryId: conflict.directoryId,
          conflicts: conflict.conflicts,
        });
    })();
    return conflict;
  }

  recordDeliveryRollback(taskId: string, results: MergeResult[], error: unknown, succeeded: boolean): void {
    this.getTask(taskId);
    this.appendEvent(
      'task',
      taskId,
      succeeded ? 'delivery.merge_rolled_back' : 'delivery.merge_rollback_failed',
      'system',
      succeeded
        ? '合并后验证失败，目标分支已恢复到交付前提交。'
        : '合并后验证失败，且目标分支未能全部自动恢复，需要人工处理。',
      {
        error: error instanceof Error ? error.message : String(error),
        results: results.map((result) => ({
          directoryId: result.directoryId,
          targetBranch: result.targetBranch,
          previousTargetCommit: result.previousTargetCommit,
          mergedCommit: result.mergedCommit,
          alreadyMerged: result.alreadyMerged,
        })),
      },
    );
  }

  listEvents(aggregateId?: string, afterSeq = 0): WorkflowEvent[] {
    const rows = aggregateId
      ? this.database.prepare('SELECT * FROM workflow_events WHERE aggregate_id = ? AND seq > ? ORDER BY seq').all(aggregateId, afterSeq) as EventRow[]
      : this.database.prepare('SELECT * FROM workflow_events WHERE seq > ? ORDER BY seq LIMIT 500').all(afterSeq) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq, id: row.id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, type: row.event_type,
      actorType: row.actor_type, message: row.message, payload: parseJson(row.payload_json, {}), occurredAt: row.occurred_at,
    }));
  }

  getTaskDiagnostics(taskId: string): TaskDiagnostics {
    const task = this.getTask(taskId);
    const generatedAt = now();
    const events = this.listEvents(taskId);
    const sessions = this.database.prepare(`
      SELECT status, started_at, completed_at FROM agent_sessions WHERE task_id = ? ORDER BY started_at
    `).all(taskId) as Array<{
      status: 'running' | 'succeeded' | 'failed' | 'interrupted';
      started_at: string;
      completed_at: string | null;
    }>;
    const jobs = this.database.prepare(`
      SELECT status, attempt FROM jobs WHERE aggregate_id = ? ORDER BY created_at
    `).all(taskId) as Array<{ status: string; attempt: number }>;
    const gates = this.database.prepare(`
      SELECT started_at, completed_at FROM gate_attempts WHERE task_id = ? ORDER BY started_at
    `).all(taskId) as Array<{ started_at: string; completed_at: string }>;
    const contexts = this.database.prepare(`
      SELECT estimated_tokens, truncated FROM context_packs WHERE task_id = ?
    `).all(taskId) as Array<{ estimated_tokens: number; truncated: number }>;
    const planCount = (this.database.prepare('SELECT COUNT(*) AS count FROM plans WHERE task_id = ?').get(taskId) as { count: number }).count;
    const recoveryCount = (this.database.prepare('SELECT COUNT(*) AS count FROM recovery_records WHERE task_id = ?').get(taskId) as { count: number }).count;
    const endAt = ['DELIVERED', 'ARCHIVED', 'CANCELLED'].includes(task.status) ? task.updatedAt : generatedAt;
    const elapsed = (startedAt: string, completedAt: string | null) => Math.max(
      0,
      new Date(completedAt ?? generatedAt).getTime() - new Date(startedAt).getTime(),
    );
    const totalMs = elapsed(task.createdAt, endAt);
    const modelMs = sessions.reduce((sum, session) => sum + elapsed(session.started_at, session.completed_at), 0);
    const gateMs = gates.reduce((sum, gate) => sum + elapsed(gate.started_at, gate.completed_at), 0);
    const decisionTypes = new Set([
      'task.analysis_requested', 'plan.composed', 'plan.recomposed', 'task.confirm', 'plan.auto_reapproved',
      'task.retrying', 'task.review_retrying', 'task.replan_requested', 'task.blocked', 'task.delivered',
      'task.stop', 'task.pause', 'task.resume', 'task.self_merge', 'task.merge', 'task.cancel', 'task.reopen',
      'delivery.merged', 'quality_gate.started', 'quality_gate.completed',
      'quality_gate.skipped', 'scope.change_detected', 'permission.requested', 'permission.responded',
      'recovery.daemon_restart', 'recovery.orphaned_task', 'job.stale_discarded',
    ]);
    const recentDecisions = events.filter((event) => decisionTypes.has(event.type)).slice(-12);
    const latestDecision = recentDecisions.at(-1) ?? events.at(-1) ?? null;
    const failures = events.filter((event) => event.type === 'job.failure_classified').map((event): ExecutionFailureRecord => ({
      jobId: String(event.payload.jobId ?? ''),
      jobType: String(event.payload.jobType ?? 'UNKNOWN'),
      category: event.payload.category as ExecutionFailureRecord['category'],
      code: typeof event.payload.code === 'string' ? event.payload.code : null,
      message: String(event.payload.error ?? event.message),
      fingerprint: String(event.payload.fingerprint ?? ''),
      retryable: event.payload.retryable === true,
      suggestedAction: event.payload.suggestedAction as ExecutionFailureRecord['suggestedAction'],
      repeated: event.payload.repeated === true,
      attempt: Number(event.payload.attempt ?? 0),
      maxAttempts: Number(event.payload.maxAttempts ?? 0),
      context: event.payload.runContext as ExecutionFailureRecord['context'] ?? null,
      occurredAt: event.occurredAt,
    }));
    const currentStep = task.steps.find((step) => step.status === 'running')
      ?? (task.activeStepId ? task.steps.find((step) => step.id === task.activeStepId) : undefined)
      ?? null;
    const countJobs = (status: string) => jobs.filter((job) => job.status === status).length;
    return {
      taskId,
      generatedAt,
      status: task.status,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, attempt: currentStep.attempt } : null,
      statusReason: latestDecision ? {
        type: latestDecision.type,
        message: latestDecision.message,
        occurredAt: latestDecision.occurredAt,
      } : null,
      duration: {
        totalMs,
        modelMs,
        gateMs,
        waitingMs: Math.max(0, totalMs - modelMs - gateMs),
      },
      sessions: {
        total: sessions.length,
        running: sessions.filter((session) => session.status === 'running').length,
        succeeded: sessions.filter((session) => session.status === 'succeeded').length,
        failed: sessions.filter((session) => session.status === 'failed').length,
        interrupted: sessions.filter((session) => session.status === 'interrupted').length,
      },
      jobs: {
        total: jobs.length,
        ready: countJobs('READY'),
        leased: countJobs('LEASED'),
        succeeded: countJobs('SUCCEEDED'),
        failed: countJobs('FAILED'),
        cancelled: countJobs('CANCELLED'),
        retries: events.filter((event) => event.type === 'job.retry_scheduled').length,
      },
      planning: {
        versions: planCount,
        currentVersion: task.plan?.version ?? null,
        replans: events.filter((event) => ['task.replan_requested', 'plan.revision_requested'].includes(event.type)).length,
      },
      context: {
        packs: contexts.length,
        estimatedTokens: contexts.reduce((sum, context) => sum + context.estimated_tokens, 0),
        truncatedPacks: contexts.filter((context) => Boolean(context.truncated)).length,
      },
      recoveries: recoveryCount,
      quality: this.getTaskQualitySummary(taskId),
      failures,
      recentDecisions,
    };
  }

  listKnowledge(projectId: string): KnowledgeItem[] {
    this.getProject(projectId);
    return (this.database.prepare('SELECT * FROM knowledge_items WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as KnowledgeRow[])
      .map((row) => ({ id: row.id, projectId: row.project_id, category: row.category, title: row.title, content: row.content,
        status: row.status, sourceTaskId: row.source_task_id, version: row.version, supersedesId: row.supersedes_id,
        createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  searchKnowledge(projectId: string, query: string): KnowledgeItem[] {
    this.getProject(projectId);
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`);
    if (terms.length === 0) return this.listKnowledge(projectId);
    const ids = this.database.prepare(`SELECT entity_id FROM context_fts WHERE project_id = ? AND context_fts MATCH ? LIMIT 20`)
      .all(projectId, terms.join(' OR ')) as Array<{ entity_id: string }>;
    if (ids.length === 0) {
      const normalized = query.trim().toLowerCase();
      return rankKnowledge(
        this.listKnowledge(projectId).filter((item) => item.status === 'active'),
        query,
      ).filter((item) => `${item.title}\n${item.content}`.toLowerCase().includes(normalized)).slice(0, 20);
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT * FROM knowledge_items WHERE id IN (${placeholders})`).all(...ids.map((item) => item.entity_id)) as KnowledgeRow[];
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, category: row.category, title: row.title, content: row.content,
      status: row.status, sourceTaskId: row.source_task_id, version: row.version, supersedesId: row.supersedes_id,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  reviewKnowledge(itemId: string, decision: 'accept' | 'reject', edits?: { title?: string; content?: string }): KnowledgeItem {
    const row = this.database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(itemId) as KnowledgeRow | undefined;
    if (!row) throw new DomainError('KNOWLEDGE_NOT_FOUND', '项目知识不存在。', 404);
    const revisingActive = row.status === 'active' && decision === 'accept';
    if (row.status !== 'candidate' && !revisingActive) {
      throw new DomainError('KNOWLEDGE_NOT_REVIEWABLE', '只有候选知识可以确认或驳回；已生效知识只能修订为新版本。', 409);
    }
    const project = this.getProject(row.project_id);
    const title = edits?.title?.trim() || row.title;
    const content = edits?.content?.trim() || row.content;
    const timestamp = now();
    const acceptedId = decision === 'accept' ? id('knowledge') : itemId;
    const version = revisingActive
      ? row.version + 1
      : decision === 'accept'
      ? (this.database.prepare(`
        SELECT COALESCE(MAX(version), 0) AS version FROM knowledge_items
        WHERE project_id = ? AND category = ?
          AND ((source_task_id = ? AND ? IS NOT NULL) OR title = ?)
      `).get(row.project_id, row.category, row.source_task_id, row.source_task_id, title) as { version: number }).version + 1
      : row.version;
    this.database.transaction(() => {
      if (decision === 'accept') {
        const previous = this.database.prepare(`
          SELECT id FROM knowledge_items WHERE project_id = ? AND category = ? AND status = 'active'
            AND ((source_task_id = ? AND ? IS NOT NULL) OR title = ?)
        `).all(row.project_id, row.category, row.source_task_id, row.source_task_id, title) as Array<{ id: string }>;
        for (const item of previous) {
          this.database.prepare(`UPDATE knowledge_items SET status = 'superseded', updated_at = ? WHERE id = ?`).run(timestamp, item.id);
          this.database.prepare('DELETE FROM context_fts WHERE entity_id = ?').run(item.id);
        }
        this.database.prepare(`UPDATE knowledge_items SET status = 'superseded', updated_at = ? WHERE id = ?`)
          .run(timestamp, itemId);
        this.database.prepare(`
          INSERT INTO knowledge_items(
            id, project_id, category, title, content, status, source_task_id,
            version, supersedes_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `).run(acceptedId, row.project_id, row.category, title, content, row.source_task_id,
          version, itemId, timestamp, timestamp);
        this.database.prepare('INSERT INTO context_fts(entity_id, project_id, title, content) VALUES (?, ?, ?, ?)')
          .run(acceptedId, row.project_id, title, content);
      } else {
        this.database.prepare(`UPDATE knowledge_items SET status = 'rejected', updated_at = ? WHERE id = ?`)
          .run(timestamp, itemId);
      }
      this.database.prepare('DELETE FROM context_fts WHERE entity_id = ?').run(itemId);
      const eventType = revisingActive ? 'knowledge.revised' : decision === 'accept' ? 'knowledge.active' : 'knowledge.rejected';
      this.appendEvent('project', row.project_id, eventType, 'user',
        revisingActive ? `修订项目知识：${title}` : decision === 'accept' ? `确认项目知识：${title}` : `驳回知识候选：${row.title}`, {
        knowledgeId: acceptedId, sourceKnowledgeId: itemId, sourceTaskId: row.source_task_id,
      });
    })();
    const resultTitle = decision === 'accept' ? title : row.title;
    const resultContent = decision === 'accept' ? content : row.content;
    const resultStatus: KnowledgeItem['status'] = decision === 'accept' ? 'active' : 'rejected';
    writeVersionedArtifact(project.projectSpacePath, `knowledge/items/${acceptedId}.md`,
      this.renderKnowledge(resultTitle, row.category, resultStatus, resultContent, row.source_task_id));
    this.recordProjectSpaceCommit(project.projectSpacePath,
      revisingActive ? `docs: revise knowledge ${itemId}` : `docs: ${decision} knowledge ${itemId}`, row.source_task_id);
    return this.listKnowledge(row.project_id).find((item) => item.id === acceptedId) as KnowledgeItem;
  }

  dashboard(executors: ExecutorInstallation[]): DashboardData {
    const tasks = this.listTasks();
    const conflictTaskIds = new Set((this.database.prepare(`
      SELECT DISTINCT task_id FROM delivery_conflicts WHERE status = 'pending'
    `).all() as Array<{ task_id: string }>).map((row) => row.task_id));
    const attention = tasks.filter((task) => attentionStates.includes(task.status) || conflictTaskIds.has(task.id));
    let queuePosition = 0;
    const active = tasks.filter((task) => activeStates.includes(task.status) || ['PAUSED', 'STOPPED'].includes(task.status))
      .map((task) => {
        if (task.status !== 'QUEUED') return { ...task, queuePosition: null };
        queuePosition += 1;
        return { ...task, queuePosition };
      });
    const delivered = tasks.filter((task) => task.status === 'DELIVERED');
    const permissions = this.listPendingPermissions();
    const settings = this.getSettings(executors);
    const systemAttention: DashboardData['systemAttention'] = [];
    const coordinator = executors.find((executor) => executor.id === settings.coordinatorExecutor);
    if (!settings.coordinatorReady) {
      const executorAvailable = coordinator?.health === 'available';
      systemAttention.push({
        id: `executor:${settings.coordinatorExecutor}`,
        type: 'executor',
        title: executorAvailable ? '全局协调模型未配置' : '全局协调 CLI 不可用',
        description: executorAvailable
          ? '请在系统设置中选择全局协调模型。'
          : `请在系统设置中检测 ${settings.coordinatorExecutor} 的安装、登录和模型配置。`,
        targetPath: '/settings',
      });
    }
    const failedOperationCount = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM project_space_operations WHERE status = 'failed'
    `).get() as { count: number }).count;
    if (failedOperationCount > 0) {
      systemAttention.push({
        id: 'project-space:failed-operations',
        type: 'project_space',
        title: 'ProjectSpace 操作需要检查',
        description: `${failedOperationCount} 个文件/版本操作未完整提交，请在系统状态和项目完整性中检查。`,
        targetPath: '/settings',
      });
    }
    return {
      attention, systemAttention, active, delivered,
      counts: { active: active.filter((task) => task.status !== 'QUEUED').length, queued: active.filter((task) => task.status === 'QUEUED').length,
        attention: attention.length + permissions.length + systemAttention.length, delivered: delivered.length },
      executors,
      settings,
      permissions,
    };
  }

  claimReadyJob(instanceId: string, leaseMilliseconds = 30_000): ClaimedJob | null {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT candidate.id, candidate.type, candidate.aggregate_id, candidate.payload_json, candidate.attempt, candidate.max_attempts
        FROM jobs candidate
        WHERE candidate.status = 'READY' AND candidate.available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM jobs active
            WHERE active.aggregate_id = candidate.aggregate_id AND active.status = 'LEASED'
          )
        ORDER BY candidate.priority DESC, candidate.created_at LIMIT 1
      `).get(now()) as JobRow | undefined;
      if (!row) return null;
      const timestamp = now();
      const leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
      const result = this.database.prepare(`
        UPDATE jobs SET status = 'LEASED', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'READY'
      `).run(instanceId, leaseExpiresAt, timestamp, timestamp, row.id);
      if (result.changes !== 1) return null;
      return { id: row.id, type: row.type, aggregateId: row.aggregate_id, payload: parseJson(row.payload_json, {}),
        attempt: row.attempt, maxAttempts: row.max_attempts, leaseOwner: instanceId };
    })();
  }

  assertJobExecutionCurrent(
    job: ClaimedJob,
    phase: 'before_execution' | 'before_result' = 'before_execution',
    runningStep?: Pick<TaskStep, 'id' | 'attempt'>,
  ): void {
    const context = job.payload.runContext as JobExecutionContext | undefined;
    if (!context) return; // Existing queued jobs created before this invariant was introduced remain runnable.
    const task = this.getTask(job.aggregateId);
    if (phase === 'before_execution' && task.stateVersion !== context.taskStateVersion) {
      throw new DomainError('RUN_CONTEXT_STALE', '后台作业对应的任务状态版本已经变化，不能继续执行。', 409, {
        jobId: job.id,
        expectedStateVersion: context.taskStateVersion,
        actualStateVersion: task.stateVersion,
      });
    }
    const allowedStatuses: Record<string, TaskStatus[]> = {
      COMPOSE_PLAN: ['COMPOSING_PLAN', 'REPLANNING'],
      PREPARE_WORKSPACE: ['PREPARING', 'QUEUED'],
      RUN_SKILL_STEP: ['RUNNING', 'RETRYING', 'PAUSED'],
      RUN_QUALITY_GATE: ['VALIDATING'],
    };
    const allowed = allowedStatuses[job.type] ?? [];
    if (allowed.length > 0 && !allowed.includes(task.status)) {
      throw new DomainError('RUN_CONTEXT_STALE', `后台作业状态已过期：${job.type} 不能在 ${task.status} 状态执行。`, 409, {
        jobId: job.id,
        phase,
        expectedStatuses: allowed,
        actualStatus: task.status,
      });
    }

    const snapshot = job.type === 'COMPOSE_PLAN' ? null : this.getRunSnapshot(task.id);
    const latestTaskVersion = job.type === 'COMPOSE_PLAN'
      ? this.getLatestTaskVersion(task.id)
      : snapshot?.taskVersion ?? this.getLatestTaskVersion(task.id);
    const mismatch =
      latestTaskVersion.id !== context.taskVersionId
      || latestTaskVersion.version !== context.taskVersion
      || (context.planId !== null && snapshot?.planId !== context.planId)
      || (context.planVersion !== null && snapshot?.planVersion !== context.planVersion);
    if (mismatch) {
      throw new DomainError('RUN_CONTEXT_STALE', '后台作业引用的需求或计划版本已经过期，结果不能写入当前任务。', 409, {
        jobId: job.id,
        phase,
        expected: context,
        actual: {
          taskVersionId: latestTaskVersion.id,
          taskVersion: latestTaskVersion.version,
          planId: snapshot?.planId ?? null,
          planVersion: snapshot?.planVersion ?? null,
        },
      });
    }

    if (job.type !== 'RUN_SKILL_STEP' || !context.stepId || context.expectedStepAttempt === null) return;
    const step = task.steps.find((item) => item.id === context.stepId);
    const currentRunnable = task.steps.find((item) => item.status === 'running')
      ?? task.steps.find((item) => item.status === 'pending');
    const actualAttempt = runningStep?.attempt ?? step?.attempt ?? null;
    const attemptMatches = phase === 'before_execution'
      ? actualAttempt !== null && [context.expectedStepAttempt - 1, context.expectedStepAttempt].includes(actualAttempt)
      : actualAttempt === context.expectedStepAttempt;
    if (!step || currentRunnable?.id !== context.stepId || runningStep?.id && runningStep.id !== context.stepId || !attemptMatches) {
      throw new DomainError('RUN_CONTEXT_STALE', '后台作业引用的步骤或执行轮次已经过期，结果不能写入当前任务。', 409, {
        jobId: job.id,
        phase,
        expectedStepId: context.stepId,
        expectedStepAttempt: context.expectedStepAttempt,
        actualStepId: runningStep?.id ?? currentRunnable?.id ?? null,
        actualStepAttempt: actualAttempt,
      });
    }
  }

  discardClaimedJob(job: ClaimedJob, reason: string): void {
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'LEASED' AND lease_owner = ?
    `).run(reason, now(), job.id, job.leaseOwner);
    if (result.changes !== 1) return;
    this.appendEvent('task', job.aggregateId, 'job.stale_discarded', 'scheduler', '旧运行结果已丢弃，没有改变当前任务。', {
      jobId: job.id,
      jobType: job.type,
      reason,
      runContext: job.payload.runContext ?? null,
    });
  }

  ensureTaskDirectoriesGit(taskId: string): Project {
    const task = this.getTask(taskId);
    if (!task.plan) throw new DomainError('PLAN_REQUIRED', '任务缺少已确认计划。', 409);
    const project = this.getProject(task.projectId);
    for (const route of task.plan.branchRoutes) {
      const directory = project.directories.find((item) => item.id === route.directoryId);
      if (!directory) throw new DomainError('PROJECT_DIRECTORY_NOT_FOUND', '计划引用的项目目录不存在。', 409, { directoryId: route.directoryId });
      if (directory.gitInitialized) continue;
      const initialized = scanProjectDirectory({
        id: directory.id,
        projectId: project.id,
        selectedPath: directory.selectedPath,
        initializeGit: true,
      });
      this.database.transaction(() => {
        this.database.prepare(`
          UPDATE project_directories SET display_name = ?, real_path = ?, git_root_path = ?, git_initialized = ?,
            current_branch = ?, is_dirty = ?, content_types_json = ?, stack_json = ?, commands_json = ?, scanned_at = ?
          WHERE id = ?
        `).run(initialized.displayName, initialized.realPath, initialized.gitRootPath, Number(initialized.gitInitialized),
          initialized.currentBranch, Number(initialized.isDirty), JSON.stringify(initialized.contentTypes), JSON.stringify(initialized.stack),
          JSON.stringify(initialized.commands), initialized.scannedAt, initialized.id);
        this.appendEvent('project', project.id, 'project.directory_git_initialized', 'system',
          `任务确认后初始化项目目录 ${initialized.displayName} 的本地 Git。`, { taskId, directoryId: initialized.id });
      })();
    }
    return this.getProject(project.id);
  }

  savePreparedWorkspaces(taskId: string, workspaces: PreparedWorkspace[]): Task {
    const task = this.getTask(taskId);
    if (task.status !== 'PREPARING' && task.status !== 'QUEUED') {
      throw new DomainError('WORKSPACE_STATE_INVALID', '任务当前不能准备工作区。', 409);
    }
    const nextPending = task.steps.find((step) => step.status === 'pending');
    if (!nextPending) {
      throw new DomainError('NEXT_EXECUTION_UNIT_NOT_FOUND', '工作区已准备，但任务没有可执行的执行单元。', 409);
    }
    const planVersion = task.snapshot?.planVersion ?? task.plan?.version ?? 0;
    const runJobDedupeKey = `task:${taskId}:plan:${planVersion}:step:${nextPending.id}:attempt:${nextPending.attempt + 1}`;
    const statement = this.database.prepare(`
      INSERT INTO task_workspaces(task_id, directory_id, workspace_path, baseline_commit, task_branch, target_branch, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(task_id, directory_id) DO UPDATE SET workspace_path = excluded.workspace_path,
        baseline_commit = excluded.baseline_commit, task_branch = excluded.task_branch, target_branch = excluded.target_branch,
        status = 'ready', updated_at = excluded.updated_at
    `);
    this.database.transaction(() => {
      const timestamp = now();
      for (const workspace of workspaces) {
        statement.run(taskId, workspace.directoryId, workspace.workspacePath, workspace.baselineCommit, workspace.taskBranch,
          workspace.targetBranch, timestamp, timestamp);
      }
      this.updateTaskState(taskId, task.stateVersion, 'RUNNING', 'workspace.prepared', '隔离任务工作区已准备完成。', {
        directories: workspaces.map((workspace) => workspace.directoryId),
      });
      this.enqueueJobOrAssertRunnable('RUN_SKILL_STEP', taskId, runJobDedupeKey, 70);
    })();
    return this.getTask(taskId);
  }

  getPreparedWorkspaces(taskId: string): PreparedWorkspace[] {
    const rows = this.database.prepare(`
      SELECT tw.*, pd.real_path, pd.git_root_path
      FROM task_workspaces tw
      JOIN project_directories pd ON pd.id = tw.directory_id
      WHERE tw.task_id = ?
      ORDER BY tw.directory_id
    `).all(taskId) as WorkspaceRow[];
    return rows.map((row) => ({
      taskId: row.task_id, directoryId: row.directory_id, workspacePath: row.workspace_path,
      scopePath: (() => {
        const prefix = relative(row.git_root_path ?? row.real_path, row.real_path);
        return !prefix || prefix === '.' ? row.workspace_path : join(row.workspace_path, prefix);
      })(),
      baselineCommit: row.baseline_commit, taskBranch: row.task_branch, targetBranch: row.target_branch,
    }));
  }

  startOrResumeStep(taskId: string): TaskStep {
    const task = this.getTask(taskId);
    if (!['RUNNING', 'RETRYING'].includes(task.status)) throw new DomainError('STEP_STATE_INVALID', '任务当前状态不能执行工作单元。', 409);
    const running = task.steps.find((step) => step.status === 'running');
    if (running) {
      const activeSession = this.database.prepare(`
        SELECT 1 FROM agent_sessions WHERE task_id = ? AND step_id = ? AND status = 'running' LIMIT 1
      `).get(taskId, running.id);
      if (activeSession) return running;
      this.database.transaction(() => {
        this.database.prepare(`
          UPDATE task_steps SET attempt = attempt + 1 WHERE id = ? AND status = 'running'
        `).run(running.id);
        this.appendEvent('task', taskId, 'skill_step.restarted', 'scheduler', `重新执行 ${running.title}。`, {
          stepId: running.id,
          skillId: running.skillId,
          attempt: running.attempt + 1,
        });
      })();
      return this.getTask(taskId).steps.find((item) => item.id === running.id) ?? running;
    }
    const step = task.steps.find((item) => item.status === 'pending');
    if (!step) throw new DomainError('STEP_NOT_FOUND', '没有待执行的执行单元。', 409);
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE task_steps SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'pending'
      `).run(now(), step.id);
      this.database.prepare('UPDATE tasks SET active_step_id = ?, updated_at = ? WHERE id = ?').run(step.id, now(), taskId);
      this.appendEvent('task', taskId, step.kind === 'work_unit' ? 'work_unit.started' : 'skill_step.started', 'scheduler', `开始执行 ${step.title}。`, { stepId: step.id, skillId: step.skillId, attempt: step.attempt + 1 });
    })();
    return this.getTask(taskId).steps.find((item) => item.id === step.id) ?? step;
  }

  createAgentSession(taskId: string, step: TaskStep, agent: AgentProfile): string {
    const sessionId = id('session');
    this.database.prepare(`
      INSERT INTO agent_sessions(id, task_id, step_id, agent_id, executor, model, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(sessionId, taskId, step.id, agent.id, agent.executor, agent.model, now());
    return sessionId;
  }

  getResumableExternalSession(taskId: string, agentId: string): string | null {
    const row = this.database.prepare(`
      SELECT external_session_id
      FROM agent_sessions
      WHERE task_id = ? AND agent_id = ? AND external_session_id IS NOT NULL
        AND status IN ('succeeded', 'failed', 'interrupted')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(taskId, agentId) as { external_session_id: string } | undefined;
    return row?.external_session_id ?? null;
  }

  recordExternalSessionId(sessionRecordId: string, externalSessionId: string): void {
    const session = this.database.prepare(`
      SELECT task_id, step_id FROM agent_sessions WHERE id = ?
    `).get(sessionRecordId) as { task_id: string; step_id: string } | undefined;
    if (!session) throw new DomainError('AGENT_SESSION_NOT_FOUND', '执行会话不存在。', 404);
    const result = this.database.prepare(`
      UPDATE agent_sessions SET external_session_id = ?
      WHERE id = ? AND status = 'running'
    `).run(externalSessionId, sessionRecordId);
    if (result.changes !== 1) return;
    this.appendEvent('task', session.task_id, 'agent_session.connected', 'executor', '本地执行器会话已建立。', {
      sessionRecordId,
      externalSessionId,
      stepId: session.step_id,
    });
  }

  completeStep(
    taskId: string,
    stepId: string,
    sessionRecordId: string,
    externalSessionId: string,
    result: {
      summary: string;
      artifacts: SkillArtifactOutput[];
      issues?: string[];
      assumptions?: string[];
      reportedChecks?: string[];
      requestedScopeChanges?: string[];
      findings?: ReviewFinding[];
    },
    checkpoints: Array<{ directoryId: string; baseCommit: string; commit: string; inspection: GitChangeInspection }>,
  ): Task {
    const task = this.getTask(taskId);
    const step = task.steps.find((item) => item.id === stepId);
    if (!step || step.status !== 'running') throw new DomainError('STEP_STATE_INVALID', '执行单元已不在运行状态。', 409);
    const project = this.getProject(task.projectId);
    if (step.kind !== 'work_unit' && result.artifacts.length === 0) {
      throw new DomainError('SKILL_ARTIFACT_REQUIRED', `${step.title} 没有返回可供后续步骤消费的结构化产物。`, 422);
    }
    const artifactVersions = result.artifacts.map((output) => this.prepareArtifactVersion(
      task,
      step,
      sessionRecordId,
      output,
    ));
    const designedQualityGates = step.kind === 'work_unit' ? [] : this.prepareDesignedQualityGates(task, step, result.artifacts);
    const changeManifests = checkpoints.map((checkpoint) => this.prepareChangeManifest(task, step, checkpoint));
    const resultArtifact = writeVersionedArtifact(
      project.projectSpacePath,
      `tasks/${taskId}/steps/${step.position + 1}-${step.skillId}/attempt-${step.attempt}.json`,
      `${JSON.stringify({
        result,
        artifactVersions: artifactVersions.map((artifact) => ({
          id: artifact.id,
          type: artifact.artifactType,
          version: artifact.version,
          path: artifact.artifactPath,
          hash: artifact.contentHash,
        })),
        changeManifests: changeManifests.map((manifest) => ({
          id: manifest.id,
          directoryId: manifest.directoryId,
          path: manifest.artifactPath,
          hash: manifest.contentHash,
        })),
        designedQualityGates,
      }, null, 2)}\n`,
    );
    this.database.transaction(() => {
      const insertArtifact = this.database.prepare(`
        INSERT INTO artifact_versions(
          id, task_id, step_id, skill_id, artifact_type, title, version, status,
          artifact_path, content_hash, source_session_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifactVersions) {
        this.database.prepare(`
          UPDATE artifact_versions SET status = 'superseded'
          WHERE task_id = ? AND artifact_type = ? AND status != 'superseded'
        `).run(taskId, artifact.artifactType);
        insertArtifact.run(
          artifact.id,
          artifact.taskId,
          artifact.stepId,
          artifact.skillId,
          artifact.artifactType,
          artifact.title,
          artifact.version,
          artifact.status,
          artifact.artifactPath,
          artifact.contentHash,
          artifact.sourceSessionId,
          JSON.stringify(artifact.metadata),
          artifact.createdAt,
        );
      }
      const insertManifest = this.database.prepare(`
        INSERT INTO change_manifests(
          id, task_id, step_id, attempt, directory_id, base_commit, checkpoint_commit,
          artifact_path, content_hash, has_out_of_scope_changes, has_sensitive_changes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const manifest of changeManifests) {
        insertManifest.run(
          manifest.id,
          manifest.taskId,
          manifest.stepId,
          manifest.attempt,
          manifest.directoryId,
          manifest.baseCommit,
          manifest.checkpointCommit,
          manifest.artifactPath,
          manifest.contentHash,
          Number(manifest.hasOutOfScopeChanges),
          Number(manifest.hasSensitiveChanges),
          manifest.createdAt,
        );
      }
      if (step.skillId === 'test-design') {
        this.database.prepare('DELETE FROM task_designed_gates WHERE task_id = ? AND source_step_id = ?')
          .run(taskId, step.id);
        const insertDesignedGate = this.database.prepare(`
          INSERT INTO task_designed_gates(
            id, task_id, source_step_id, name, command_argv_json, directory_id,
            required, timeout_ms, expected_exit_codes_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const gate of designedQualityGates) {
          insertDesignedGate.run(
            gate.id,
            taskId,
            step.id,
            gate.name,
            JSON.stringify(gate.commandArgv ?? []),
            gate.directoryId,
            Number(gate.required),
            gate.timeoutMs ?? 10 * 60_000,
            JSON.stringify(gate.expectedExitCodes ?? [0]),
            now(),
          );
        }
      }
      this.database.prepare(`
        UPDATE task_steps SET status = 'succeeded', completed_at = ?, summary = ? WHERE id = ?
      `).run(now(), result.summary, stepId);
      this.database.prepare(`
        UPDATE agent_sessions SET external_session_id = ?, status = 'succeeded', result_path = ?, completed_at = ? WHERE id = ?
      `).run(externalSessionId, resultArtifact.path, now(), sessionRecordId);
      this.database.prepare('UPDATE tasks SET active_step_id = NULL WHERE id = ?').run(taskId);
      this.appendEvent('task', taskId, step.kind === 'work_unit' ? 'work_unit.succeeded' : 'skill_step.succeeded', 'executor', `${step.title} 已完成。`, {
        stepId,
        skillId: step.skillId,
        artifactVersions: artifactVersions.map((artifact) => ({
          id: artifact.id, type: artifact.artifactType, version: artifact.version, hash: artifact.contentHash,
        })),
        changeManifests: changeManifests.map((manifest) => ({
          id: manifest.id, directoryId: manifest.directoryId, files: manifest.files.length, hash: manifest.contentHash,
        })),
        checkpoints: checkpoints.map((checkpoint) => ({
          directoryId: checkpoint.directoryId,
          baseCommit: checkpoint.baseCommit,
          commit: checkpoint.commit,
          changedFiles: checkpoint.inspection.files.map((file) => file.path),
        })),
        issues: result.issues ?? [],
        findings: result.findings ?? [],
        designedQualityGates: designedQualityGates.map((gate) => ({
          id: gate.id,
          name: gate.name,
          directoryId: gate.directoryId,
          commandArgv: gate.commandArgv,
        })),
      });

      if (task.status === 'PAUSED') return;
      const nextPending = task.steps.find((item) => item.status === 'pending' && item.id !== stepId);
      const gatesRequiredBeforeNextStep = !this.requiredGatesSatisfied(task)
        && (!nextPending || nextPending.skillId === 'delivery-review'
          || (nextPending.kind === 'work_unit' && nextPending.requiresIndependentSession));
      if (gatesRequiredBeforeNextStep) {
        this.updateTaskState(taskId, task.stateVersion, 'VALIDATING', 'quality_gate.started', '开始运行独立质量门禁。');
        this.enqueueJobOrAssertRunnable(
          'RUN_QUALITY_GATE',
          taskId,
          `task:${taskId}:gates:${step.attempt + 1}`,
          75,
        );
      } else if (nextPending) {
        this.updateTaskState(taskId, task.stateVersion, 'RUNNING', 'task.step_advanced', `准备执行下一步：${nextPending.title}。`);
        this.enqueueJobOrAssertRunnable(
          'RUN_SKILL_STEP',
          taskId,
          `task:${taskId}:step:${nextPending.id}:attempt:${nextPending.attempt + 1}`,
          70,
        );
      } else {
        this.updateTaskState(taskId, task.stateVersion, 'DELIVERED', 'task.delivered', '全部执行单元与质量门禁已完成，等待交付确认。');
      }
    })();
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: record ${step.skillId} result for ${taskId}`, taskId);
    if (this.getTask(taskId).status === 'DELIVERED') this.createDeliveryReport(taskId);
    return this.getTask(taskId);
  }

  handleNonPassingStep(
    taskId: string,
    stepId: string,
    sessionRecordId: string,
    externalSessionId: string,
    result: {
      status: 'changes_required' | 'blocked';
      summary: string;
      artifacts: SkillArtifactOutput[];
      issues?: string[];
      findings?: ReviewFinding[];
      completionChecks?: Array<{ check: string; status: 'passed' | 'failed'; evidence: string }>;
    },
    retryLimit: number,
  ): Task {
    const task = this.getTask(taskId);
    const step = task.steps.find((item) => item.id === stepId);
    if (!step || step.status !== 'running') throw new DomainError('STEP_STATE_INVALID', '执行单元已不在运行状态。', 409);
    const project = this.getProject(task.projectId);
    const artifactVersions = result.artifacts.map((output) => this.prepareArtifactVersion(task, step, sessionRecordId, output));
    const resultArtifact = writeVersionedArtifact(
      project.projectSpacePath,
      `tasks/${taskId}/steps/${step.position + 1}-${step.skillId}/attempt-${step.attempt}-${result.status}.json`,
      `${JSON.stringify({ result, artifactVersions }, null, 2)}\n`,
    );
    const implementationStep = task.flowVersion === 2
      ? task.steps.filter((item) => item.kind === 'work_unit' && item.mode === 'write' && item.position < step.position)
        .sort((left, right) => right.position - left.position)[0]
      : task.steps.find((item) => item.skillId === 'implementation' && item.position < step.position);
    const precedingProducerStep = task.steps
      .filter((item) => item.position < step.position && item.position < 1000 && item.skillId !== 'delivery-review')
      .sort((left, right) => right.position - left.position)[0];
    const correctionStep = implementationStep ?? precedingProducerStep;
    const reviewRetryCount = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM workflow_events
      WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'task.review_retrying'
        AND seq > COALESCE((
          SELECT MAX(seq) FROM workflow_events
          WHERE aggregate_type = 'task' AND aggregate_id = ?
            AND event_type IN ('task.confirm', 'plan.auto_reapproved')
        ), 0)
    `).get(taskId, taskId) as { count: number }).count;
    const canRetryCorrection = result.status === 'changes_required'
      && Boolean(correctionStep)
      && reviewRetryCount < retryLimit;
    const planVersion = task.snapshot?.planVersion ?? task.plan?.version ?? 0;

    this.database.transaction(() => {
      const insertArtifact = this.database.prepare(`
        INSERT INTO artifact_versions(
          id, task_id, step_id, skill_id, artifact_type, title, version, status,
          artifact_path, content_hash, source_session_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifactVersions) {
        this.database.prepare(`
          UPDATE artifact_versions SET status = 'superseded'
          WHERE task_id = ? AND artifact_type = ? AND status != 'superseded'
        `).run(taskId, artifact.artifactType);
        insertArtifact.run(
          artifact.id,
          artifact.taskId,
          artifact.stepId,
          artifact.skillId,
          artifact.artifactType,
          artifact.title,
          artifact.version,
          artifact.status,
          artifact.artifactPath,
          artifact.contentHash,
          artifact.sourceSessionId,
          JSON.stringify(artifact.metadata),
          artifact.createdAt,
        );
      }
      this.database.prepare(`
        UPDATE agent_sessions
        SET external_session_id = ?, status = 'succeeded', result_path = ?, completed_at = ?
        WHERE id = ?
      `).run(externalSessionId, resultArtifact.path, now(), sessionRecordId);
      this.database.prepare(`
        UPDATE task_steps SET status = 'failed', completed_at = ?, summary = ? WHERE id = ?
      `).run(now(), result.summary, stepId);
      this.database.prepare('UPDATE tasks SET active_step_id = NULL WHERE id = ?').run(taskId);
      this.appendEvent(
        'task',
        taskId,
        result.status === 'blocked'
          ? (step.kind === 'work_unit' ? 'work_unit.blocked' : 'skill_step.blocked')
          : (step.kind === 'work_unit' ? 'work_unit.changes_required' : 'skill_step.changes_required'),
        'executor',
        result.status === 'blocked'
          ? `${step.title} 判定当前任务无法安全继续。`
          : `${step.title} 发现必须整改的问题。`,
        {
          stepId,
          skillId: step.skillId,
          outcome: result.status,
          summary: result.summary,
          issues: result.issues ?? [],
          findings: result.findings ?? [],
          completionChecks: result.completionChecks ?? [],
          artifactVersions: artifactVersions.map((artifact) => ({
            id: artifact.id,
            type: artifact.artifactType,
            version: artifact.version,
            hash: artifact.contentHash,
          })),
        },
      );
      if (result.status === 'blocked') {
        this.updateTaskState(taskId, task.stateVersion, 'BLOCKED', 'task.blocked',
          `${step.title} 返回阻塞结论，需要人工处理。`, { stepId, issues: result.issues ?? [] });
      } else if (canRetryCorrection && correctionStep) {
        this.database.prepare(`
          UPDATE task_steps SET status = 'pending', completed_at = NULL, summary = NULL
          WHERE task_id = ? AND position >= ? AND position < 1000
        `).run(taskId, correctionStep.position);
        this.updateTaskState(taskId, task.stateVersion, 'RETRYING', 'task.review_retrying',
          `${step.title} 要求整改，带着评审证据重新执行 ${correctionStep.title}。`, {
            stepId,
            correctionStepId: correctionStep.id,
            implementationStepId: correctionStep.skillId === 'implementation' || correctionStep.kind === 'work_unit'
              ? correctionStep.id
              : undefined,
            issues: result.issues ?? [],
          });
        this.enqueueJobOrAssertRunnable(
          'RUN_SKILL_STEP',
          taskId,
          `task:${taskId}:plan:${planVersion}:review-fix:${correctionStep.id}:cycle:${reviewRetryCount + 1}`,
          90,
        );
      }
    })();

    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: record ${step.skillId} ${result.status} for ${taskId}`, taskId);
    if (result.status === 'changes_required' && !canRetryCorrection) {
      return this.requestAutomaticReplan(
        taskId,
        `${step.title} 要求整改：${result.summary}\n${(result.issues ?? []).join('\n')}`,
        `${step.skillId}_changes_required`,
        true,
      );
    }
    return this.getTask(taskId);
  }

  recordSessionFailure(sessionRecordId: string, stepId: string, error: string): void {
    this.database.prepare(`UPDATE agent_sessions SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`).run(now(), error, sessionRecordId);
    this.database.prepare(`UPDATE task_steps SET summary = ? WHERE id = ?`).run(error, stepId);
  }

  saveGateResults(taskId: string, results: GateResultInput[]): void {
    if (results.length === 0) {
      this.appendEvent('task', taskId, 'quality_gate.skipped', 'scheduler', '当前任务未配置可执行质量门禁。', {
        reason: 'not_configured',
      });
      return;
    }
    const statement = this.database.prepare(`
      INSERT INTO gate_results(id, task_id, gate_id, directory_id, command, status, exit_code, log_path, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, gate_id) DO UPDATE SET status = excluded.status, exit_code = excluded.exit_code,
        log_path = excluded.log_path, started_at = excluded.started_at, completed_at = excluded.completed_at
    `);
    const attemptStatement = this.database.prepare(`
      INSERT INTO gate_attempts(
        id, task_id, gate_id, attempt, directory_id, command_argv_json, status,
        exit_code, signal, timed_out, log_path, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      for (const result of results) {
        statement.run(id('gater'), taskId, result.id, result.directoryId, result.command, result.status,
          result.exitCode, result.logPath, result.startedAt, result.completedAt);
        attemptStatement.run(
          id('gateattempt'),
          taskId,
          result.id,
          result.attempt,
          result.directoryId,
          JSON.stringify(result.commandArgv),
          result.status,
          result.exitCode,
          result.signal,
          Number(result.timedOut),
          result.logPath,
          result.startedAt,
          result.completedAt,
        );
      }
      this.appendEvent('task', taskId, 'quality_gate.completed', 'scheduler', results.every((result) => result.status === 'passed') ? '质量门禁全部通过。' : '质量门禁存在失败。', {
        results: results.map((result) => ({
          gateId: result.id,
          attempt: result.attempt,
          status: result.status,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        })),
      });
    })();
  }

  nextGateAttempt(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS attempt FROM gate_attempts WHERE task_id = ?
    `).get(taskId) as { attempt: number };
    return row.attempt + 1;
  }

  getTaskQualitySummary(taskId: string): TaskEvidence['qualitySummary'] {
    const task = this.getTask(taskId);
    const gates = this.getEffectiveQualityGates(taskId);
    const attempts = this.database.prepare(`
      SELECT * FROM gate_attempts WHERE task_id = ? ORDER BY attempt DESC, completed_at DESC
    `).all(taskId) as GateAttemptRow[];
    const latestByGate = new Map<string, GateAttemptRow>();
    for (const attempt of attempts) if (!latestByGate.has(attempt.gate_id)) latestByGate.set(attempt.gate_id, attempt);
    const latestReview = this.listEvents(taskId).filter((event) =>
      ['skill_step.succeeded', 'skill_step.changes_required', 'skill_step.blocked'].includes(event.type)
      && event.payload.skillId === 'delivery-review').at(-1);
    const findings = Array.isArray(latestReview?.payload.findings)
      ? latestReview.payload.findings as ReviewFinding[]
      : [];
    const blockingFindings = findings.filter((finding) =>
      finding.blocking || ['critical', 'major'].includes(finding.severity));
    const advisoryFindings = findings.filter((finding) => !blockingFindings.includes(finding));
    const configured = gates.length;
    const waived = gates.filter((gate) => gate.status === 'waived').length;
    const passed = gates.filter((gate) => latestByGate.get(gate.id)?.status === 'passed').length;
    const failed = gates.filter((gate) => latestByGate.get(gate.id)?.status === 'failed').length;
    const requiredGates = gates.filter((gate) => gate.required && gate.status !== 'waived');
    let status: TaskEvidence['qualitySummary']['status'];
    if (configured === 0) status = 'not_configured';
    else if (failed > 0 || blockingFindings.length > 0) status = 'failed';
    else if (task.status === 'VALIDATING') status = 'running';
    else if (waived === configured) status = 'waived';
    else if (requiredGates.length === 0 || requiredGates.every((gate) => latestByGate.get(gate.id)?.status === 'passed')) status = 'passed';
    else status = 'pending';
    return {
      status,
      configured,
      required: requiredGates.length,
      passed,
      failed,
      waived,
      latestAttemptAt: attempts[0]?.completed_at ?? null,
      blockingFindings,
      advisoryFindings,
    };
  }

  continueAfterGates(taskId: string): Task {
    const task = this.getTask(taskId);
    if (task.status !== 'VALIDATING') throw new DomainError('GATE_STATE_INVALID', '任务当前不在质量验证状态。', 409);
    const next = task.steps.find((step) => step.status === 'pending');
    if (!next) {
      this.updateTaskState(taskId, task.stateVersion, 'DELIVERED', 'task.delivered', '全部步骤和质量门禁已完成，等待交付确认。');
      this.createDeliveryReport(taskId);
    } else {
      this.database.transaction(() => {
        this.updateTaskState(taskId, task.stateVersion, 'RUNNING', 'task.validation_passed', `质量门禁通过，继续执行 ${next.title}。`);
        this.enqueueJobOrAssertRunnable(
          'RUN_SKILL_STEP',
          taskId,
          `task:${taskId}:step:${next.id}:attempt:${next.attempt + 1}`,
          70,
        );
      })();
    }
    return this.getTask(taskId);
  }

  retryAfterGateFailure(taskId: string, retryLimit: number): Task {
    const task = this.getTask(taskId);
    const implementationStep = task.flowVersion === 2
      ? task.steps.filter((step) => step.kind === 'work_unit' && step.mode === 'write' && step.status === 'succeeded')
        .sort((left, right) => right.position - left.position)[0]
      : task.steps.find((step) => step.skillId === 'implementation');
    if (!implementationStep) {
      return this.requestAutomaticReplan(
        taskId,
        '质量门禁失败，但当前计划没有可执行修复的写入单元。请在原目标、成功标准、目录和权限边界内重新组合执行单元。',
        'gate_failure_without_implementation',
        true,
      );
    }
    if (implementationStep.attempt > retryLimit) {
      return this.requestAutomaticReplan(
        taskId,
        `质量门禁在实施步骤自动修复 ${retryLimit} 次后仍失败。请根据 GateResult 和失败日志调整实现与验证步骤，不得扩大已批准边界。`,
        'gate_retries_exhausted',
        true,
      );
    }
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE task_steps SET status = 'pending', completed_at = NULL, summary = NULL
        WHERE task_id = ? AND position >= ? AND position < 1000
      `).run(taskId, implementationStep.position);
      this.updateTaskState(taskId, task.stateVersion, 'RETRYING', 'task.retrying', `质量门禁失败，带着失败证据重新执行 ${implementationStep.title}。`);
      this.enqueueJobOrAssertRunnable(
        'RUN_SKILL_STEP',
        taskId,
        `task:${taskId}:step:${implementationStep.id}:attempt:${implementationStep.attempt + 1}`,
        85,
      );
    })();
    return this.getTask(taskId);
  }

  requestAutomaticReplan(taskId: string, feedback: string, trigger: string, autoResume: boolean): Task {
    const task = this.getTask(taskId);
    const row = this.database.prepare('SELECT auto_replan_count FROM tasks WHERE id = ?').get(taskId) as { auto_replan_count: number };
    if (row.auto_replan_count >= 1) {
      this.updateTaskState(taskId, task.stateVersion, 'BLOCKED', 'task.blocked',
        '自动重试和一次重新规划均已耗尽，需要人工处理。', { trigger, feedback });
      return this.getTask(taskId);
    }
    const activePosition = task.steps.find((step) => step.status === 'running')?.position
      ?? (task.flowVersion === 2
        ? task.steps.filter((step) => step.kind === 'work_unit' && step.mode === 'write')
          .sort((left, right) => right.position - left.position)[0]?.position
        : task.steps.find((step) => step.skillId === 'implementation')?.position)
      ?? task.steps.find((step) => step.status === 'pending')?.position
      ?? 0;
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE task_steps SET status = 'pending', completed_at = NULL
        WHERE task_id = ? AND position >= ? AND position < 1000 AND status != 'succeeded'
      `).run(taskId, activePosition);
      this.database.prepare(`
        UPDATE tasks SET active_step_id = NULL, auto_replan_count = auto_replan_count + 1 WHERE id = ?
      `).run(taskId);
      this.updateTaskState(taskId, task.stateVersion, 'REPLANNING', 'task.replan_requested',
        '自动修复已耗尽，协调器正在生成一次修订计划。', { trigger, feedback, autoResume });
      this.enqueueJobOrAssertRunnable('COMPOSE_PLAN', taskId, `task:${taskId}:automatic-replan:${task.stateVersion + 1}`, 100, {
        feedback,
        autoResume,
        trigger,
      });
    })();
    return this.getTask(taskId);
  }

  createPermissionRequest(
    taskId: string,
    sessionId: string,
    request: { id: string; permission: string; patterns: string[]; metadata: Record<string, unknown> },
  ): PermissionRequest {
    const existing = this.database.prepare('SELECT * FROM permission_requests WHERE session_id = ? AND external_request_id = ?')
      .get(sessionId, request.id) as PermissionRow | undefined;
    if (existing) return this.permissionFromRow(existing);
    const task = this.getTask(taskId);
    const requestId = id('permission');
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO permission_requests(id, task_id, session_id, external_request_id, permission, patterns_json, metadata_json,
          previous_task_status, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(requestId, taskId, sessionId, request.id, request.permission, JSON.stringify(request.patterns), JSON.stringify(request.metadata), task.status, now());
      if (['RUNNING', 'VALIDATING', 'RETRYING'].includes(task.status)) {
        this.updateTaskState(taskId, task.stateVersion, 'WAITING_APPROVAL', 'permission.requested', `执行器请求 ${request.permission} 权限。`, {
          permissionRequestId: requestId, patterns: request.patterns,
        });
      }
    })();
    return this.getPermissionRequest(requestId);
  }

  listPendingPermissions(): PermissionRequest[] {
    return (this.database.prepare(`SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY created_at`).all() as PermissionRow[])
      .map((row) => this.permissionFromRow(row));
  }

  listTaskPermissionGrants(taskId: string): Array<{ permission: string; patterns: string[] }> {
    this.getTask(taskId);
    return (this.database.prepare(`
      SELECT permission, patterns_json FROM task_permission_grants WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as Array<{ permission: string; patterns_json: string }>).map((row) => ({
      permission: row.permission,
      patterns: parseJson(row.patterns_json, []),
    }));
  }

  getPermissionRequest(requestId: string): PermissionRequest {
    const row = this.database.prepare('SELECT * FROM permission_requests WHERE id = ?').get(requestId) as PermissionRow | undefined;
    if (!row) throw new DomainError('PERMISSION_NOT_FOUND', '权限请求不存在。', 404);
    return this.permissionFromRow(row);
  }

  respondPermission(requestId: string, decision: 'once' | 'always' | 'reject', message?: string): PermissionRequest {
    const row = this.database.prepare('SELECT * FROM permission_requests WHERE id = ?').get(requestId) as PermissionRow | undefined;
    if (!row) throw new DomainError('PERMISSION_NOT_FOUND', '权限请求不存在。', 404);
    if (row.status === 'resolved') return this.permissionFromRow(row);
    const task = this.getTask(row.task_id);
    let replanAfterResolution = false;
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE permission_requests SET status = 'resolved', decision = ?, message = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
      `).run(decision, message ?? null, now(), requestId);
      if (decision === 'always') {
        this.database.prepare(`
          INSERT OR IGNORE INTO task_permission_grants(id, task_id, permission, patterns_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id('grant'), row.task_id, row.permission, row.patterns_json, now());
      }
      if (task.status === 'WAITING_APPROVAL') {
        if (decision === 'reject') {
          replanAfterResolution = true;
          this.appendEvent('task', task.id, 'permission.responded', 'user', '权限请求已拒绝。', {
            permissionRequestId: requestId,
            decision,
            permission: row.permission,
            patterns: parseJson(row.patterns_json, []),
          });
        } else {
          this.updateTaskState(task.id, task.stateVersion, row.previous_task_status, 'permission.responded', '权限请求已允许。', {
            permissionRequestId: requestId, decision,
          });
        }
      }
    })();
    if (replanAfterResolution) {
      this.requestAutomaticReplan(
        task.id,
        `执行所需权限“${row.permission}”已被用户拒绝。不得再次申请该权限；请在已批准目标、目录和权限边界内调整实现方案。`,
        'permission_denied',
        true,
      );
    }
    return this.getPermissionRequest(requestId);
  }

  handleScopeViolation(
    taskId: string,
    stepId: string,
    details: {
      reason: 'reported_scope_expansion' | 'out_of_scope_change' | 'sensitive_change' | 'read_only_change';
      requestedScopeChanges?: string[];
      files?: Array<{ directoryId: string; path: string; sensitive: boolean }>;
    },
  ): Task {
    const task = this.getTask(taskId);
    this.appendEvent('task', taskId, 'scope.change_detected', 'scheduler',
      '执行结果超出已批准边界，已停止当前执行并请求重新规划。', { stepId, ...details });
    const feedback = details.reason === 'reported_scope_expansion'
      ? `执行人员报告必须扩大范围：${details.requestedScopeChanges?.join('；') || '未说明'}。请生成修订计划并明确新增范围、权限和验证点，必须由用户重新确认。`
      : `执行工作区检测到${
        details.reason === 'sensitive_change' ? '敏感文件改动'
          : details.reason === 'read_only_change' ? '只读步骤产生了文件改动'
            : '批准目录之外的改动'
      }：${
        details.files?.map((file) => `${file.directoryId}:${file.path}`).join('；') || '未识别文件'
      }。不要把这些改动视为已批准产出；请生成需要用户重新确认的修订计划。`;
    return this.requestAutomaticReplan(task.id, feedback, details.reason, false);
  }

  private permissionFromRow(row: PermissionRow): PermissionRequest {
    return {
      id: row.id, taskId: row.task_id, sessionId: row.session_id, permission: row.permission,
      patterns: parseJson(row.patterns_json, []), metadata: parseJson(row.metadata_json, {}), status: row.status,
      decision: row.decision, message: row.message, createdAt: row.created_at, resolvedAt: row.resolved_at,
    };
  }

  private createDeliveryReport(taskId: string): void {
    const task = this.getTask(taskId);
    const project = this.getProject(task.projectId);
    const workspaces = this.getPreparedWorkspaces(taskId);
    const gates = this.database.prepare(`SELECT gate_id, command, status, exit_code, log_path FROM gate_results WHERE task_id = ?`).all(taskId);
    const evidence = this.getTaskEvidence(taskId);
    const diagnostics = this.getTaskDiagnostics(taskId);
    const capabilities = this.listTaskCapabilitySnapshots(taskId);
    const report = {
      taskId, title: task.title, goal: task.plan?.goal ?? task.description, status: task.status,
      workspaces: workspaces.map((workspace) => ({ directoryId: workspace.directoryId, taskBranch: workspace.taskBranch, targetBranch: workspace.targetBranch, path: workspace.workspacePath })),
      steps: task.steps.map((step) => ({ title: step.title, skillId: step.skillId, status: step.status, summary: step.summary, attempts: step.attempt })),
      gates,
      qualitySummary: evidence.qualitySummary,
      diagnostics,
      capabilities,
      evidence: {
        requirementVersions: evidence.requirementVersions,
        preApprovalArtifacts: evidence.preApprovalArtifacts,
        permissionManifests: evidence.permissionManifests,
        artifacts: evidence.artifacts,
        contextPacks: evidence.contextPacks,
        changeManifests: evidence.changeManifests,
        designedQualityGates: evidence.designedQualityGates,
        qualitySummary: evidence.qualitySummary,
        gateAttempts: evidence.gateAttempts,
        deliveryConflicts: evidence.deliveryConflicts,
        recoveries: evidence.recoveries,
        deliveryActions: evidence.deliveryActions,
      },
      risks: task.plan?.risks ?? [],
      createdAt: now(),
    };
    const markdown = `# ${task.title} · 交付报告

## 完成情况

${task.steps.map((step) => `- ${step.title}: ${step.status}${step.summary ? ` — ${step.summary}` : ''}（${step.attempt} 次）`).join('\n')}

## 结构化产物

${evidence.preApprovalArtifacts.length
    ? evidence.preApprovalArtifacts.map((artifact) =>
      `- 确认前：${artifact.title} · ${artifact.artifactType} v${artifact.version} · ${artifact.status} · \`${artifact.contentHash.slice(0, 16)}\``).join('\n')
    : '- 无确认前产物'}

${evidence.artifacts.length
    ? evidence.artifacts.map((artifact) =>
      `- ${artifact.title} · ${artifact.artifactType} v${artifact.version} · \`${artifact.contentHash.slice(0, 16)}\``).join('\n')
    : '- 无'}

## 任务装载能力

${capabilities.length
    ? capabilities.map((capability) =>
      `- ${capability.name} · ${capability.kind.toUpperCase()} · ${capability.executor} · ${capability.version} · \`${capability.contentHash.slice(0, 16)}\` · ${capability.status}`).join('\n')
    : '- 本任务未装载外部 Skill/MCP'}

## 实际变更

${evidence.changeManifests.length
    ? evidence.changeManifests.flatMap((manifest) => [
      `- ${manifest.directoryId}: ${manifest.baseCommit.slice(0, 10)} → ${manifest.checkpointCommit.slice(0, 10)}`,
      ...manifest.files.map((file) => `  - ${file.status} \`${file.path}\` (+${file.addedLines ?? '?'} -${file.deletedLines ?? '?'})`),
    ]).join('\n')
    : '- 无文件变更'}

## 质量门禁

状态：${evidence.qualitySummary.status} · 已配置 ${evidence.qualitySummary.configured} · 通过 ${evidence.qualitySummary.passed} · 失败 ${evidence.qualitySummary.failed} · 豁免 ${evidence.qualitySummary.waived}

${evidence.gateAttempts.length
    ? evidence.gateAttempts.map((attempt) =>
      `- 第 ${attempt.attempt} 轮 · \`${attempt.commandArgv.join(' ')}\` · ${attempt.status} · exit ${attempt.exitCode ?? 'null'}${attempt.timedOut ? ' · timeout' : ''}`).join('\n')
    : '- 未配置自动化门禁'}

## 评审发现

${evidence.qualitySummary.blockingFindings.length
    ? evidence.qualitySummary.blockingFindings.map((finding) =>
      `- [阻塞/${finding.severity}] ${finding.title}：${finding.description}\n  - 证据：${finding.evidence}\n  - 建议：${finding.recommendation}`).join('\n')
    : '- 无阻塞评审问题'}
${evidence.qualitySummary.advisoryFindings.length
    ? evidence.qualitySummary.advisoryFindings.map((finding) =>
      `- [建议/${finding.severity}] ${finding.title}：${finding.description}\n  - 证据：${finding.evidence}`).join('\n')
    : '- 无非阻塞建议'}

## 运行诊断

- 总耗时：${Math.round(diagnostics.duration.totalMs / 1000)} 秒
- 模型执行：${Math.round(diagnostics.duration.modelMs / 1000)} 秒
- 等待/排队/人工确认：${Math.round(diagnostics.duration.waitingMs / 1000)} 秒
- 会话：${diagnostics.sessions.succeeded} 成功 / ${diagnostics.sessions.failed} 失败 / ${diagnostics.sessions.interrupted} 中断
- 自动重试：${diagnostics.jobs.retries} 次；恢复：${diagnostics.recoveries} 次；重规划：${diagnostics.planning.replans} 次
- 上下文：${diagnostics.context.packs} 个包，累计估算 ${diagnostics.context.estimatedTokens} tokens，截断 ${diagnostics.context.truncatedPacks} 次
- 失败分类：${diagnostics.failures.length ? diagnostics.failures.map((failure) => `${failure.category}/${failure.suggestedAction}`).join('；') : '无'}

## 交付动作

${evidence.deliveryActions.length
    ? evidence.deliveryActions.map((action) =>
      `- ${action.action} · ${action.status} · ${action.createdAt}`).join('\n')
    : '- 尚未执行合并动作；任务分支已保留，可由用户选择合并或自行处理'}

## 恢复与冲突

${evidence.recoveries.length
    ? evidence.recoveries.map((recovery) => `- ${recovery.reason}: ${recovery.action} · ${recovery.createdAt}`).join('\n')
    : '- 未发生调度恢复'}
${evidence.deliveryConflicts.length
    ? evidence.deliveryConflicts.map((conflict) => `- ${conflict.status}: ${conflict.taskBranch} → ${conflict.targetBranch} · ${conflict.conflicts.map((item) => item.path).join('、')}`).join('\n')
    : '- 未发生交付语义冲突'}

## 任务分支

${workspaces.map((workspace) => `- ${workspace.directoryId}: \`${workspace.taskBranch}\` → \`${workspace.targetBranch}\``).join('\n')}

## 风险与限制

${report.risks.length ? report.risks.map((risk) => `- ${risk}`).join('\n') : '- 无新增已知风险'}
`;
    const artifact = writeVersionedArtifact(project.projectSpacePath, `reports/${taskId}/delivery.md`, markdown);
    this.database.prepare(`
      INSERT INTO delivery_reports(id, task_id, artifact_path, content_hash, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET artifact_path = excluded.artifact_path,
        content_hash = excluded.content_hash, content_json = excluded.content_json, created_at = excluded.created_at
    `).run(id('report'), taskId, artifact.path, artifact.hash, JSON.stringify(report), report.createdAt);
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: create delivery report for ${taskId}`, taskId);
  }

  private createKnowledgeCandidatesForArchivedTask(taskId: string): void {
    const task = this.getTask(taskId);
    if (task.status !== 'ARCHIVED') {
      throw new DomainError('KNOWLEDGE_ARCHIVE_REQUIRED', '只有用户确认完成并归档后才能生成项目知识候选。', 409);
    }
    const project = this.getProject(task.projectId);
    const workspaces = this.getPreparedWorkspaces(taskId);
    const evidence = this.getTaskEvidence(taskId);
    const reviewFindings = this.listEvents(taskId)
      .filter((event) => ['skill_step.succeeded', 'skill_step.changes_required', 'skill_step.blocked'].includes(event.type)
        && event.payload.skillId === 'delivery-review')
      .flatMap((event) => Array.isArray(event.payload.findings) ? event.payload.findings as ReviewFinding[] : []);
    const gateLessons = evidence.gateAttempts.filter((attempt) => attempt.status === 'failed').map((attempt) => {
      const laterPassed = evidence.gateAttempts.some((candidate) =>
        candidate.gateId === attempt.gateId && candidate.attempt > attempt.attempt && candidate.status === 'passed');
      return [
        `问题：质量门禁 \`${attempt.commandArgv.join(' ')}\` 在第 ${attempt.attempt} 轮失败（exit ${attempt.exitCode ?? 'null'}${attempt.timedOut ? '，超时' : ''}）。`,
        `原因证据：${attempt.logExcerpt?.trim().slice(-1_000) || `日志保存在 ${attempt.logPath}`}。`,
        '处理：任务回到已批准的实施步骤，携带失败日志进行修复，没有扩大原计划范围。',
        `验证：${laterPassed ? '后续同一门禁已经通过。' : '归档时没有记录到后续同门禁通过证据，应谨慎复用。'}`,
      ].join('\n');
    });
    const reviewLessons = reviewFindings.map((finding) => [
      `问题：${finding.title}（${finding.severity}/${finding.category}${finding.location ? `，${finding.location}` : ''}）。`,
      `原因证据：${finding.evidence}。`,
      `处理：${finding.recommendation}。`,
      `验证：最终质量状态为 ${evidence.qualitySummary.status}；该问题${finding.blocking ? '曾阻塞交付' : '作为非阻塞建议保留'}。`,
    ].join('\n'));
    const reusableLessons = [...gateLessons, ...reviewLessons];
    const currentRequirement = evidence.requirementVersions.find((version) => version.id === task.plan?.taskVersionId)
      ?? evidence.requirementVersions.at(-1);
    const sourceLine = [
      currentRequirement ? `TaskVersion v${currentRequirement.version} ${currentRequirement.contentHash.slice(0, 16)}` : null,
      task.plan ? `Plan v${task.plan.version} ${task.plan.id}` : null,
      evidence.artifacts.length
        ? `Artifacts ${evidence.artifacts.filter((artifact) => artifact.status !== 'superseded').map((artifact) => `${artifact.artifactType}@${artifact.contentHash.slice(0, 12)}`).join('、')}`
        : null,
      evidence.deliveryReport ? `DeliveryReport ${evidence.deliveryReport.contentHash.slice(0, 16)}` : null,
    ].filter(Boolean).join('；');
    const candidates = [
      {
        category: 'decision' as const,
        title: `需求决策：${task.title}`,
        content: [
          `目标：${task.plan?.goal ?? task.description}`,
          `范围：${task.plan?.scope.join('；') || '未单独列出'}`,
          `成功标准：${task.plan?.successCriteria.join('；') || '未单独列出'}`,
          `计划版本：v${task.plan?.version ?? 1}`,
          `适用目录：${workspaces.map((workspace) => workspace.directoryId).join('；') || '无代码目录'}`,
          `来源证据：${sourceLine || '交付报告'}`,
        ].join('\n'),
      },
      ...(reusableLessons.length ? [{
        category: 'experience' as const,
        title: `交付经验：${task.title}`,
        content: [
          ...reusableLessons.map((lesson, index) => `经验 ${index + 1}\n${lesson}`),
          `适用边界：${task.plan?.scope.join('；') || task.description}；目录 ${workspaces.map((workspace) => workspace.directoryId).join('、') || '无'}。`,
          `来源证据：${sourceLine || `ProjectSpace reports/${task.id}/delivery.md`}。`,
        ].join('\n'),
      }] : []),
    ];
    const timestamp = now();
    const createdCandidates: typeof candidates = [];
    this.database.transaction(() => {
      for (const candidate of candidates) {
        const existing = this.database.prepare(`
          SELECT * FROM knowledge_items WHERE project_id = ? AND source_task_id = ? AND category = ?
          ORDER BY version DESC LIMIT 1
        `).get(project.id, task.id, candidate.category) as KnowledgeRow | undefined;
        const candidateHash = sha256(candidate.content);
        if (existing?.title === candidate.title && sha256(existing.content) === candidateHash) continue;
        if (existing) {
          if (existing.status === 'candidate') {
            this.database.prepare(`
              UPDATE knowledge_items SET status = 'superseded', updated_at = ? WHERE id = ?
            `).run(timestamp, existing.id);
          }
          this.database.prepare(`
            INSERT INTO knowledge_items(
              id, project_id, category, title, content, status, source_task_id,
              version, supersedes_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)
          `).run(id('knowledge'), project.id, candidate.category, candidate.title, candidate.content,
            task.id, existing.version + 1, existing.id, timestamp, timestamp);
        } else {
          this.database.prepare(`
            INSERT INTO knowledge_items(
              id, project_id, category, title, content, status, source_task_id,
              version, supersedes_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, 1, NULL, ?, ?)
          `).run(id('knowledge'), project.id, candidate.category, candidate.title, candidate.content,
            task.id, timestamp, timestamp);
        }
        createdCandidates.push(candidate);
      }
      if (createdCandidates.length > 0) {
        this.appendEvent('project', project.id, 'knowledge.candidates_created', 'system', `任务“${task.title}”生成了待确认的项目知识。`, {
          taskId: task.id,
          categories: createdCandidates.map((candidate) => candidate.category),
          contentHashes: createdCandidates.map((candidate) => sha256(candidate.content)),
        });
      }
    })();
    if (createdCandidates.length === 0) return;
    const markdown = `# ${task.title} · 知识候选\n\n> 内容来自已批准计划和实际交付证据，确认前不会进入项目检索上下文。\n\n${candidates.map((candidate) => `## ${candidate.title}\n\n${candidate.content}`).join('\n\n')}\n`;
    writeVersionedArtifact(project.projectSpacePath, `knowledge/candidates/${task.id}.md`, markdown);
    this.recordProjectSpaceCommit(project.projectSpacePath, `docs: create knowledge candidates for ${task.id}`, task.id);
  }

  heartbeatJob(jobId: string, instanceId: string, leaseMilliseconds = 30_000): boolean {
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'LEASED' AND lease_owner = ?
    `).run(timestamp, new Date(Date.now() + leaseMilliseconds).toISOString(), timestamp, jobId, instanceId);
    return result.changes === 1;
  }

  succeedJob(jobId: string, instanceId: string): void {
    this.database.prepare(`
      UPDATE jobs SET status = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'LEASED' AND lease_owner = ?
    `).run(now(), jobId, instanceId);
  }

  failJob(job: ClaimedJob, error: unknown): void {
    const failure = classifyExecutionFailure(error);
    const errorMessage = failure.message.slice(0, 4_000);
    const runContext = job.payload.runContext as JobExecutionContext | undefined;
    if (runContext) {
      const task = this.getTask(job.aggregateId);
      if (task.stateVersion !== runContext.taskStateVersion) {
        this.appendEvent('task', job.aggregateId, 'job.failure_classified', 'scheduler', '后台作业失败时任务版本已经变化，旧作业不会重试。', {
          jobId: job.id,
          jobType: job.type,
          category: 'stale_execution',
          code: 'RUN_CONTEXT_STALE',
          error: errorMessage,
          fingerprint: failure.fingerprint,
          retryable: false,
          suggestedAction: 'discard',
          repeated: false,
          attempt: job.attempt + 1,
          maxAttempts: job.maxAttempts,
          runContext,
          actualStateVersion: task.stateVersion,
          occurredAt: now(),
        });
        this.discardClaimedJob(job, `任务状态版本已从 ${runContext.taskStateVersion} 变化为 ${task.stateVersion}：${errorMessage}`);
        return;
      }
    }
    const nextAttempt = job.attempt + 1;
    const priorFailures = (this.database.prepare(`
      SELECT payload_json FROM workflow_events
      WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'job.failure_classified'
      ORDER BY seq DESC LIMIT 10
    `).all(job.aggregateId) as Array<{ payload_json: string }>).map((row) => parseJson<{
      jobType?: string; fingerprint?: string;
    }>(row.payload_json, {}));
    const previousSameJobType = priorFailures.find((item) => item.jobType === job.type);
    const repeated = previousSameJobType?.fingerprint === failure.fingerprint;
    const occurredAt = now();
    this.appendEvent('task', job.aggregateId, 'job.failure_classified', 'scheduler', `后台作业失败：${failure.category}。`, {
      jobId: job.id,
      jobType: job.type,
      category: failure.category,
      code: failure.code,
      error: errorMessage,
      fingerprint: failure.fingerprint,
      retryable: failure.retryable,
      suggestedAction: failure.suggestedAction,
      repeated,
      attempt: nextAttempt,
      maxAttempts: job.maxAttempts,
      runContext: job.payload.runContext ?? null,
      occurredAt,
    });

    if (failure.suggestedAction === 'discard') {
      this.discardClaimedJob(job, errorMessage);
      return;
    }

    if (failure.retryable && !repeated && nextAttempt < job.maxAttempts) {
      const availableAt = new Date(Date.now() + Math.min(30_000, 1000 * (2 ** nextAttempt))).toISOString();
      this.database.prepare(`
        UPDATE jobs SET status = 'READY', attempt = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ?
      `).run(nextAttempt, availableAt, errorMessage, now(), job.id, job.leaseOwner);
      this.appendEvent('task', job.aggregateId, 'job.retry_scheduled', 'scheduler', `后台任务失败，将进行第 ${nextAttempt + 1} 次尝试。`, {
        jobId: job.id, jobType: job.type, error: errorMessage, attempt: nextAttempt,
        category: failure.category, fingerprint: failure.fingerprint,
      });
      return;
    }
    let shouldReplan = false;
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE jobs SET status = 'FAILED', attempt = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ?
      `).run(nextAttempt, errorMessage, now(), job.id, job.leaseOwner);
      const task = this.getTask(job.aggregateId);
      if (!['ARCHIVED', 'CANCELLED', 'DELIVERED', 'STOPPED'].includes(task.status)) {
        shouldReplan = failure.suggestedAction === 'replan'
          || (['RUN_SKILL_STEP', 'RUN_QUALITY_GATE'].includes(job.type)
            && !['permission', 'model_capability', 'git_conflict', 'system'].includes(failure.category));
        if (!shouldReplan) {
          const reason = repeated
            ? '相同失败重复出现，已停止盲目重试，需要人工处理。'
            : failure.retryable ? '自动重试已耗尽，需要人工处理。' : '该失败无法通过自动重试恢复，需要人工处理。';
          this.updateTaskState(task.id, task.stateVersion, 'BLOCKED', 'task.blocked', reason, {
            jobType: job.type,
            error: errorMessage,
            category: failure.category,
            fingerprint: failure.fingerprint,
            repeated,
          });
        }
      }
    })();
    if (shouldReplan) {
      this.requestAutomaticReplan(
        job.aggregateId,
        `${job.type} 执行失败（${failure.category}）：${errorMessage.slice(0, 2_000)}。请基于现有失败证据重新规划，不得扩大已批准范围。`,
        `job_${job.type.toLowerCase()}_failed`,
        true,
      );
    }
  }

  reconcileExpiredLeases(instanceId: string): number {
    const timestamp = now();
    const expired = this.database.prepare(`
      SELECT id, aggregate_id, lease_owner FROM jobs
      WHERE status = 'LEASED' AND (lease_owner IS NULL OR lease_owner != ?)
    `).all(instanceId) as Array<{ id: string; aggregate_id: string; lease_owner: string | null }>;
    const result = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE agent_sessions
        SET status = 'interrupted', completed_at = ?, error = COALESCE(error, 'Daemon restarted while the session was active.')
        WHERE status = 'running'
      `).run(timestamp);
      const reset = this.database.prepare(`
        UPDATE jobs SET status = 'READY', lease_owner = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, 'Daemon restarted while the job lease was active.')
        WHERE status = 'LEASED' AND (lease_owner IS NULL OR lease_owner != ?)
      `).run(timestamp, timestamp, instanceId);
      const insertRecovery = this.database.prepare(`
        INSERT INTO recovery_records(
          id, task_id, job_id, reason, previous_owner, recovered_by, action, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const job of expired) {
        insertRecovery.run(id('recovery'), job.aggregate_id, job.id, 'daemon_restarted',
          job.lease_owner, instanceId, 'job_requeued_and_session_interrupted', timestamp);
        this.appendEvent('task', job.aggregate_id, 'recovery.daemon_restart', 'scheduler',
          'Daemon 重启后已中断旧会话并将后台任务重新排队。', {
            jobId: job.id,
            previousOwner: job.lease_owner,
            recoveredBy: instanceId,
          });
      }
      return reset;
    })();
    return result.changes;
  }

  reconcileTimedOutLeases(): number {
    const timestamp = now();
    const expired = this.database.prepare(`
      SELECT id, aggregate_id FROM jobs
      WHERE status = 'LEASED' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).all(timestamp) as Array<{ id: string; aggregate_id: string }>;
    if (expired.length === 0) return 0;
    this.database.transaction(() => {
      const reset = this.database.prepare(`
        UPDATE jobs SET status = 'READY', lease_owner = NULL, lease_expires_at = NULL,
          available_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'Job lease expired.')
        WHERE id = ? AND status = 'LEASED'
      `);
      const insertRecovery = this.database.prepare(`
        INSERT INTO recovery_records(
          id, task_id, job_id, reason, previous_owner, recovered_by, action, created_at
        ) VALUES (?, ?, ?, 'lease_timed_out', NULL, NULL, 'job_requeued', ?)
      `);
      for (const job of expired) {
        reset.run(timestamp, timestamp, job.id);
        insertRecovery.run(id('recovery'), job.aggregate_id, job.id, timestamp);
        this.appendEvent('task', job.aggregate_id, 'job.lease_expired', 'scheduler',
          '后台任务租约已过期，已重新进入恢复队列。', { jobId: job.id });
      }
    })();
    return expired.length;
  }

  reconcileOrphanedActiveTasks(): number {
    const candidates = this.database.prepare(`
      SELECT id FROM tasks
      WHERE status IN ('COMPOSING_PLAN', 'PREPARING', 'QUEUED', 'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING')
        AND NOT EXISTS (
          SELECT 1 FROM jobs
          WHERE jobs.aggregate_id = tasks.id AND jobs.status IN ('READY', 'LEASED')
        )
      ORDER BY updated_at
    `).all() as Array<{ id: string }>;
    let recovered = 0;
    for (const candidate of candidates) {
      const task = this.getTask(candidate.id);
      let jobType: string | null = null;
      let priority = 70;
      let payload: Record<string, unknown> = {};
      const runningStep = task.steps.find((step) => step.status === 'running');
      const pendingStep = task.steps.find((step) => step.status === 'pending');
      let resetRunningStep = false;

      if (task.status === 'COMPOSING_PLAN' || task.status === 'REPLANNING') {
        jobType = 'COMPOSE_PLAN';
        priority = 100;
        const previous = this.database.prepare(`
          SELECT payload_json FROM jobs
          WHERE aggregate_id = ? AND type = 'COMPOSE_PLAN'
          ORDER BY created_at DESC LIMIT 1
        `).get(task.id) as { payload_json: string } | undefined;
        payload = parseJson(previous?.payload_json ?? '{}', {});
      } else if (task.status === 'PREPARING' || task.status === 'QUEUED') {
        jobType = 'PREPARE_WORKSPACE';
        priority = 80;
      } else if (task.status === 'VALIDATING') {
        jobType = 'RUN_QUALITY_GATE';
        priority = 75;
      } else if (runningStep) {
        jobType = 'RUN_SKILL_STEP';
        priority = 85;
        resetRunningStep = true;
      } else if (!this.requiredGatesSatisfied(task) && (!pendingStep || pendingStep.skillId === 'delivery-review')) {
        jobType = 'RUN_QUALITY_GATE';
        priority = 75;
      } else if (pendingStep) {
        jobType = 'RUN_SKILL_STEP';
        priority = task.status === 'RETRYING' ? 85 : 70;
      }

      if (!jobType) {
        this.updateTaskState(
          task.id,
          task.stateVersion,
          'BLOCKED',
          'recovery.orphaned_task_blocked',
          '任务处于活跃状态，但没有可恢复的执行步骤或质量门禁。',
          { previousStatus: task.status },
        );
        recovered += 1;
        continue;
      }

      const recoveredJobType = jobType;
      const dedupeKey = `task:${task.id}:orphan-recovery:${task.stateVersion}:${recoveredJobType}`;
      const didRecover = this.database.transaction(() => {
        const current = this.database.prepare(`
          SELECT status, state_version FROM tasks WHERE id = ?
        `).get(task.id) as { status: TaskStatus; state_version: number } | undefined;
        if (!current || current.state_version !== task.stateVersion || current.status !== task.status) return false;
        const runnableJob = this.database.prepare(`
          SELECT 1 FROM jobs
          WHERE aggregate_id = ? AND status IN ('READY', 'LEASED')
          LIMIT 1
        `).get(task.id);
        if (runnableJob) return false;
        if (resetRunningStep && runningStep) {
          const timestamp = now();
          this.database.prepare(`
            UPDATE task_steps SET status = 'pending', completed_at = NULL
            WHERE id = ? AND status = 'running'
          `).run(runningStep.id);
          this.database.prepare(`
            UPDATE agent_sessions
            SET status = 'interrupted', completed_at = ?,
              error = COALESCE(error, 'Recovered an active task that no longer had a runnable job.')
            WHERE task_id = ? AND step_id = ? AND status = 'running'
          `).run(timestamp, task.id, runningStep.id);
          this.database.prepare(`
            UPDATE tasks SET active_step_id = NULL, updated_at = ? WHERE id = ?
          `).run(timestamp, task.id);
        }
        this.enqueueJobOrAssertRunnable(recoveredJobType, task.id, dedupeKey, priority, payload);
        const job = this.database.prepare(`
          SELECT id FROM jobs WHERE dedupe_key = ?
        `).get(dedupeKey) as { id: string };
        this.database.prepare(`
          INSERT INTO recovery_records(
            id, task_id, job_id, reason, previous_owner, recovered_by, action, created_at
          ) VALUES (?, ?, ?, 'active_task_without_job', NULL, NULL, ?, ?)
        `).run(id('recovery'), task.id, job.id, `${recoveredJobType.toLowerCase()}_enqueued`, now());
        this.appendEvent(
          'task',
          task.id,
          'recovery.orphaned_task',
          'scheduler',
          '检测到活跃任务缺少后台作业，已自动恢复执行队列。',
          {
            previousStatus: task.status,
            jobId: job.id,
            jobType: recoveredJobType,
            resetStepId: resetRunningStep ? runningStep?.id : null,
          },
        );
        return true;
      })();
      if (didRecover) recovered += 1;
    }
    return recovered;
  }

  getBuiltins(): { roles: RoleTemplate[]; skills: typeof builtinSkills } {
    return { roles: this.listRoleTemplates(false), skills: builtinSkills };
  }

  private projectFromRow(row: ProjectRow): Project {
    const directories = (this.database.prepare(`
      SELECT * FROM project_directories WHERE project_id = ? AND removed_at IS NULL ORDER BY scanned_at
    `).all(row.id) as DirectoryRow[])
      .map(this.directoryFromRow);
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('COMPOSING_PLAN','PREPARING','QUEUED','RUNNING','VALIDATING','RETRYING','REPLANNING') THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status IN ('WAITING_PLAN_APPROVAL','WAITING_APPROVAL','WAITING_REAPPROVAL','BLOCKED','REOPENED')
          OR EXISTS (
            SELECT 1 FROM delivery_conflicts dc WHERE dc.task_id = tasks.id AND dc.status = 'pending'
          ) THEN 1 ELSE 0 END) attention,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) delivered,
        SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) archived
      FROM tasks WHERE project_id = ?
    `).get(row.id) as Record<string, number | null>;
    return {
      id: row.id, name: row.name, description: row.description, projectSpacePath: row.project_space_path,
      createdAt: row.created_at, updatedAt: row.updated_at, directories,
      taskSummary: { active: counts.active ?? 0, attention: counts.attention ?? 0, delivered: counts.delivered ?? 0, archived: counts.archived ?? 0 },
    };
  }

  private directoryFromRow = (row: DirectoryRow): ProjectDirectory => ({
    id: row.id, projectId: row.project_id, displayName: row.display_name, selectedPath: row.selected_path, realPath: row.real_path,
    gitRootPath: row.git_root_path, gitInitialized: Boolean(row.git_initialized), currentBranch: row.current_branch, isDirty: Boolean(row.is_dirty),
    contentTypes: parseJson(row.content_types_json, []), stack: parseJson(row.stack_json, []), commands: parseJson(row.commands_json, {}),
    localBranches: row.git_root_path ? git(row.git_root_path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean) : [],
    scannedAt: row.scanned_at,
  });

  private insertDirectory(directory: ProjectDirectory): void {
    this.database.prepare(`
      INSERT INTO project_directories(id, project_id, display_name, selected_path, real_path, git_root_path, git_initialized, current_branch,
        is_dirty, content_types_json, stack_json, commands_json, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(directory.id, directory.projectId, directory.displayName, directory.selectedPath, directory.realPath, directory.gitRootPath,
      Number(directory.gitInitialized), directory.currentBranch, Number(directory.isDirty), JSON.stringify(directory.contentTypes), JSON.stringify(directory.stack),
      JSON.stringify(directory.commands), directory.scannedAt);
  }

  private createDirectoryProfile(
    projectSpacePath: string,
    directory: ProjectDirectory,
    status: DirectoryProfileVersion['status'],
  ): DirectoryProfileVersion {
    const version = (this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM directory_profiles WHERE directory_id = ?
    `).get(directory.id) as { version: number }).version + 1;
    const createdAt = now();
    const artifact = writeVersionedArtifact(
      projectSpacePath,
      `directories/${directory.id}/profiles/v${version}.json`,
      `${JSON.stringify(directory, null, 2)}\n`,
    );
    const profile: DirectoryProfileVersion = {
      id: id('directoryprofile'),
      directoryId: directory.id,
      version,
      status,
      content: directory,
      artifactPath: artifact.path,
      contentHash: artifact.hash,
      createdAt,
      confirmedAt: status === 'confirmed' ? createdAt : null,
    };
    this.database.prepare(`
      INSERT INTO directory_profiles(
        id, directory_id, version, status, content_json, artifact_path,
        content_hash, created_at, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(profile.id, profile.directoryId, profile.version, profile.status, JSON.stringify(profile.content),
      profile.artifactPath, profile.contentHash, profile.createdAt, profile.confirmedAt);
    return profile;
  }

  private directoryProfileFromRow = (row: DirectoryProfileRow): DirectoryProfileVersion => ({
    id: row.id,
    directoryId: row.directory_id,
    version: row.version,
    status: row.status,
    content: parseJson<ProjectDirectory>(row.content_json, null as unknown as ProjectDirectory),
    artifactPath: row.artifact_path,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  });

  private agentFromRow = (row: AgentRow): AgentProfile => ({
    id: row.id, name: row.name, roleId: row.role_id, executor: row.executor, model: row.model, parameters: parseJson(row.parameters_json, {}),
    defaultCapabilityIds: parseJson(row.default_capability_ids_json, []), permissionMode: row.permission_mode,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  });

  private artifactFromRow = (row: ArtifactRow): ArtifactVersion => ({
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    skillId: row.skill_id,
    artifactType: row.artifact_type,
    title: row.title,
    version: row.version,
    status: row.status,
    artifactPath: row.artifact_path,
    contentHash: row.content_hash,
    sourceSessionId: row.source_session_id,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  });

  private preApprovalArtifactFromRow = (row: PreApprovalArtifactRow): PreApprovalArtifactVersion => ({
    id: row.id,
    taskId: row.task_id,
    planId: row.plan_id,
    artifactType: row.artifact_type,
    title: row.title,
    version: row.version,
    status: row.status,
    artifactPath: row.artifact_path,
    contentHash: row.content_hash,
    sourceExecutor: row.source_executor,
    sourceModel: row.source_model,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
  });

  private teamFromRow(row: TeamRow): Team {
    const members = this.database.prepare('SELECT agent_id FROM team_members WHERE team_id = ? ORDER BY position').all(row.id) as Array<{ agent_id: string }>;
    return { id: row.id, name: row.name, description: row.description, isDefault: Boolean(row.is_default), memberIds: members.map((item) => item.agent_id),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private taskFromRow(row: TaskRow): Task {
    const planRow = this.database.prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(row.id) as PlanRow | undefined;
    const currentTaskVersion = this.getCurrentTaskVersion(row.id);
    const steps = (this.database.prepare(`
      SELECT * FROM task_steps
      WHERE task_id = ? AND position < 1000
      ORDER BY position
    `).all(row.id) as StepRow[]).map((step) => ({
      id: step.id, taskId: step.task_id, position: step.position, skillId: step.skill_id, kind: step.unit_kind ?? 'legacy_skill',
      requiredCapabilities: parseJson(step.required_capabilities_json, []), capabilityIds: parseJson(step.capability_ids_json, []),
      verification: parseJson(step.verification_json, []),
      mode: step.execution_mode ?? 'read_only', requiresIndependentSession: Boolean(step.requires_independent_session),
      agentId: step.agent_id, title: step.title,
      description: step.description, inputs: parseJson(step.inputs_json, []), expectedOutput: step.expected_output,
      directoryIds: parseJson(step.directory_ids_json, []), status: step.status, attempt: step.attempt,
      startedAt: step.started_at, completedAt: step.completed_at, summary: step.summary,
    }));
    const storedPlan = planRow ? parseJson<TaskPlan>(planRow.content_json, null as unknown as TaskPlan) : null;
    const plan = storedPlan
      ? {
        ...storedPlan,
        taskVersionId: storedPlan.taskVersionId ?? currentTaskVersion.id,
        taskVersion: storedPlan.taskVersion ?? currentTaskVersion.version,
        flowVersion: storedPlan.flowVersion ?? row.flow_version ?? 1,
        preApprovalSkillIds: storedPlan.preApprovalSkillIds ?? [],
        preApprovalArtifacts: storedPlan.preApprovalArtifacts ?? [],
        answersReviewedAt: storedPlan.answersReviewedAt ?? null,
        questions: (storedPlan.questions ?? []).map((question) => ({
          ...question,
          options: question.options ?? [],
        })),
        confirmedAt: planRow?.confirmed_at ?? storedPlan.confirmedAt,
        steps: (storedPlan.steps ?? steps).map((step) => ({
          id: step.id,
          position: step.position,
          skillId: step.skillId,
          kind: step.kind ?? 'legacy_skill',
          requiredCapabilities: step.requiredCapabilities ?? [],
          capabilityIds: step.capabilityIds ?? [],
          verification: step.verification ?? [],
          mode: step.mode ?? (step.skillId === 'implementation' ? 'write' : 'read_only'),
          requiresIndependentSession: step.requiresIndependentSession ?? false,
          agentId: step.agentId,
          title: step.title,
          description: step.description,
          inputs: step.inputs,
          expectedOutput: step.expectedOutput,
          directoryIds: step.directoryIds,
        })),
      }
      : null;
    const snapshotRow = this.database.prepare(`
      SELECT id, task_id, plan_id, plan_version, content_json, content_hash, artifact_path, created_at
      FROM run_snapshots WHERE task_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(row.id) as SnapshotRow | undefined;
    const storedSnapshot = snapshotRow
      ? parseJson<Partial<TaskRunSnapshot>>(snapshotRow.content_json, {})
      : null;
    const snapshot: TaskRunSnapshotSummary | null = snapshotRow ? {
      id: snapshotRow.id,
      planId: snapshotRow.plan_id,
      planVersion: snapshotRow.plan_version,
      taskVersionId: storedSnapshot?.taskVersion?.id ?? plan?.taskVersionId ?? currentTaskVersion.id,
      taskVersion: storedSnapshot?.taskVersion?.version ?? plan?.taskVersion ?? currentTaskVersion.version,
      contentHash: snapshotRow.content_hash,
      createdAt: snapshotRow.created_at,
    } : null;
    const activeStep = steps.find((step) => step.status === 'running')
      ?? steps.find((step) => step.id === row.active_step_id)
      ?? null;
    const activeSession = this.database.prepare(`
      SELECT s.id, s.agent_id, s.executor, s.model, s.started_at, a.name AS agent_name
      FROM agent_sessions s
      LEFT JOIN agent_profiles a ON a.id = s.agent_id
      WHERE s.task_id = ? AND (? IS NULL OR s.step_id = ?)
      ORDER BY s.started_at DESC LIMIT 1
    `).get(row.id, activeStep?.id ?? null, activeStep?.id ?? null) as {
      id: string;
      agent_id: string | null;
      executor: AgentProfile['executor'];
      model: string;
      started_at: string;
      agent_name: string | null;
    } | undefined;
    const assignedAgent = !activeSession && activeStep?.agentId
      ? this.database.prepare('SELECT id, name, executor, model FROM agent_profiles WHERE id = ?').get(activeStep.agentId) as {
        id: string; name: string; executor: AgentProfile['executor']; model: string;
      } | undefined
      : undefined;
    const jobHeartbeat = this.database.prepare(`
      SELECT heartbeat_at FROM jobs
      WHERE aggregate_id = ? AND status = 'LEASED'
      ORDER BY heartbeat_at DESC LIMIT 1
    `).get(row.id) as { heartbeat_at: string | null } | undefined;
    const activeExecution = activeSession || assignedAgent ? {
      agentId: activeSession?.agent_id ?? assignedAgent?.id ?? null,
      agentName: activeSession?.agent_name ?? assignedAgent?.name ?? null,
      executor: activeSession?.executor ?? assignedAgent?.executor ?? null,
      model: activeSession?.model ?? assignedAgent?.model ?? null,
      sessionId: activeSession?.id ?? null,
      startedAt: activeSession?.started_at ?? activeStep?.startedAt ?? null,
      heartbeatAt: jobHeartbeat?.heartbeat_at ?? null,
    } : null;
    const succeeded = steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped').length;
    return {
      id: row.id, projectId: row.project_id, projectName: row.project_name, teamId: row.team_id, teamName: row.team_name,
      title: row.title, description: row.description, expectedOutput: row.expected_output, constraints: row.constraints_text,
      forbiddenPaths: parseJson(row.forbidden_paths_json, []), status: row.status, stateVersion: row.state_version,
      flowVersion: row.flow_version ?? 1,
      progress: steps.length > 0 ? Math.round((succeeded / steps.length) * 100) : 0, activeStepId: row.active_step_id,
      createdAt: row.created_at, updatedAt: row.updated_at, plan, steps, snapshot, activeExecution,
    };
  }

  private appendEvent(aggregateType: string, aggregateId: string, type: string, actorType: WorkflowEvent['actorType'], message: string, payload: Record<string, unknown> = {}): void {
    this.database.prepare(`
      INSERT INTO workflow_events(id, aggregate_type, aggregate_id, event_type, actor_type, message, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id('evt'), aggregateType, aggregateId, type, actorType, message, JSON.stringify(payload), now());
  }

  private assertStateVersion(task: Task, stateVersion: number): void {
    if (task.stateVersion !== stateVersion) {
      throw new DomainError('STATE_VERSION_CONFLICT', '任务状态已经变化，请刷新后重试。', 409, { expected: stateVersion, actual: task.stateVersion });
    }
  }

  private updateTaskState(taskId: string, expectedVersion: number, status: TaskStatus, eventType: string, message: string, payload: Record<string, unknown> = {}): void {
    const result = this.database.prepare(`UPDATE tasks SET status = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND state_version = ?`)
      .run(status, now(), taskId, expectedVersion);
    if (result.changes !== 1) throw new DomainError('STATE_VERSION_CONFLICT', '任务状态已经变化，请刷新后重试。', 409);
    this.appendEvent('task', taskId, eventType, 'system', message, { status, ...payload });
  }

  private enqueueJob(
    type: string,
    aggregateId: string,
    dedupeKey: string,
    priority: number,
    payload: Record<string, unknown> = {},
  ): boolean {
    const timestamp = now();
    const runContext = this.buildJobExecutionContext(type, aggregateId, timestamp);
    const jobPayload = { ...payload, runContext };
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO jobs(id, type, aggregate_id, payload_json, status, priority, available_at, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?)
    `).run(id('job'), type, aggregateId, JSON.stringify(jobPayload), priority, timestamp, dedupeKey, timestamp, timestamp);
    return result.changes === 1;
  }

  private buildJobExecutionContext(type: string, taskId: string, enqueuedAt: string): JobExecutionContext {
    const task = this.getTask(taskId);
    const snapshot = type === 'COMPOSE_PLAN' ? null : this.getRunSnapshot(taskId);
    const taskVersion = type === 'COMPOSE_PLAN'
      ? this.getLatestTaskVersion(taskId)
      : snapshot?.taskVersion ?? this.getLatestTaskVersion(taskId);
    const step = type === 'RUN_SKILL_STEP'
      ? task.steps.find((item) => item.status === 'running') ?? task.steps.find((item) => item.status === 'pending') ?? null
      : null;
    return {
      taskStateVersion: task.stateVersion,
      taskVersionId: taskVersion.id,
      taskVersion: taskVersion.version,
      planId: snapshot?.planId ?? null,
      planVersion: snapshot?.planVersion ?? null,
      stepId: step?.id ?? null,
      expectedStepAttempt: step ? step.attempt + (step.status === 'pending' ? 1 : 0) : null,
      enqueuedAt,
    };
  }

  private enqueueJobOrAssertRunnable(
    type: string,
    aggregateId: string,
    dedupeKey: string,
    priority: number,
    payload: Record<string, unknown> = {},
  ): void {
    if (this.enqueueJob(type, aggregateId, dedupeKey, priority, payload)) return;
    const existing = this.database.prepare(`
      SELECT id, status FROM jobs WHERE dedupe_key = ? LIMIT 1
    `).get(dedupeKey) as { id: string; status: string } | undefined;
    if (existing && ['READY', 'LEASED'].includes(existing.status)) return;
    throw new DomainError(
      'JOB_NOT_QUEUED',
      '任务状态已经推进，但后续后台作业未能入队。',
      500,
      {
        aggregateId,
        jobType: type,
        dedupeKey,
        conflictingJobId: existing?.id ?? null,
        conflictingJobStatus: existing?.status ?? null,
      },
    );
  }

  private writeTaskVersion(projectSpace: string, taskId: string, version: number, input: CreateTaskInput): { path: string; hash: string } {
    const markdown = `# ${input.title.trim()}\n\n## 原始需求\n\n${input.description.trim()}\n\n## 预期产出\n\n${input.expectedOutput?.trim() || '待计划阶段明确'}\n\n## 约束\n\n${input.constraints?.trim() || '无额外约束'}\n`;
    return writeVersionedArtifact(projectSpace, `requirements/${taskId}/v${version}.md`, markdown);
  }

  private getCurrentTaskVersion(taskId: string): TaskVersionSummary {
    const row = this.database.prepare(`
      SELECT * FROM task_versions
      WHERE task_id = ?
      ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, version DESC
      LIMIT 1
    `).get(taskId) as TaskVersionRow | undefined;
    if (!row) throw new DomainError('TASK_VERSION_NOT_FOUND', '任务缺少可追溯的需求版本。', 409);
    return {
      id: row.id,
      taskId: row.task_id,
      version: row.version,
      status: row.status,
      artifactPath: row.artifact_path,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  }

  private getLatestTaskVersion(taskId: string): TaskVersionSummary {
    const row = this.database.prepare(`
      SELECT * FROM task_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1
    `).get(taskId) as TaskVersionRow | undefined;
    if (!row) throw new DomainError('TASK_VERSION_NOT_FOUND', '任务缺少可追溯的需求版本。', 409);
    return {
      id: row.id,
      taskId: row.task_id,
      version: row.version,
      status: row.status,
      artifactPath: row.artifact_path,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  }

  private getTaskVersion(taskId: string, taskVersionId: string): TaskVersionSummary {
    const row = this.database.prepare(`
      SELECT * FROM task_versions WHERE id = ? AND task_id = ?
    `).get(taskVersionId, taskId) as TaskVersionRow | undefined;
    if (!row) throw new DomainError('TASK_VERSION_NOT_FOUND', '计划引用的需求版本不存在。', 409, {
      taskId,
      taskVersionId,
    });
    return {
      id: row.id,
      taskId: row.task_id,
      version: row.version,
      status: row.status,
      artifactPath: row.artifact_path,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  }

  private prepareTaskVersionFromPlan(
    task: Task,
    project: Project,
    plan: TaskPlan,
    source: string,
  ): TaskVersionSummary {
    const version = (this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM task_versions WHERE task_id = ?
    `).get(task.id) as { version: number }).version + 1;
    const createdAt = now();
    const list = (items: string[]) => items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- 无';
    const questions = plan.questions.length > 0
      ? plan.questions.map((item) => {
        const options = item.options.map((option) =>
          `  - ${option.recommended ? '推荐' : '备选'}：${option.label} — ${option.description}`).join('\n');
        return `- ${item.question}\n${options || '  - 旧版计划未生成候选方案，可填写自定义方案'}\n  - 回答：${item.answer?.trim() || '待回答'}`;
      }).join('\n')
      : '- 无';
    const preApprovalArtifacts = plan.preApprovalArtifacts.length > 0
      ? plan.preApprovalArtifacts.map((item) =>
        `- ${item.artifactType} v${item.version}: ${item.artifactPath}\n  - 哈希：${item.contentHash}`).join('\n')
      : '- 无';
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `requirements/${task.id}/v${version}.md`,
      `# ${task.title} · 需求 v${version}\n\n- 版本来源：${source}\n- 对应计划：v${plan.version}（${plan.id}）\n\n## 用户原始需求\n\n${task.description}\n\n## 当前目标\n\n${plan.goal}\n\n## 范围\n\n${list(plan.scope)}\n\n## 非范围\n\n${list(plan.nonScope)}\n\n## 成功标准\n\n${list(plan.successCriteria)}\n\n## 预期产出\n\n${task.expectedOutput || '待计划阶段明确'}\n\n## 约束\n\n${task.constraints || '无额外约束'}\n\n## 假设\n\n${list(plan.assumptions)}\n\n## 风险\n\n${list(plan.risks)}\n\n## 歧义与回答\n\n${questions}\n\n## 确认前产物引用\n\n${preApprovalArtifacts}\n`,
    );
    return {
      id: id('taskv'),
      taskId: task.id,
      version,
      status: 'draft',
      artifactPath: artifact.path,
      contentHash: artifact.hash,
      createdAt,
    };
  }

  private prepareRequirementRevision(task: Task, correction: string): {
    version: number;
    description: string;
    artifactPath: string;
    contentHash: string;
    createdAt: string;
  } {
    const project = this.getProject(task.projectId);
    const version = (this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM task_versions WHERE task_id = ?
    `).get(task.id) as { version: number }).version + 1;
    const description = `${task.description.trim()}\n\n用户纠正（v${version}）：\n${correction}`;
    const createdAt = now();
    const stored = writeVersionedArtifact(
      project.projectSpacePath,
      `requirements/${task.id}/v${version}.md`,
      `# ${task.title} · 需求 v${version}\n\n## 当前需求\n\n${description}\n\n## 预期产出\n\n${task.expectedOutput || '待计划阶段明确'}\n\n## 约束\n\n${task.constraints || '无额外约束'}\n`,
    );
    return {
      version,
      description,
      artifactPath: stored.path,
      contentHash: stored.hash,
      createdAt,
    };
  }

  private prepareArtifactVersion(
    task: Task,
    step: TaskStep,
    sessionRecordId: string,
    output: SkillArtifactOutput,
  ): ArtifactVersion {
    const project = this.getProject(task.projectId);
    const artifactType = sanitizeArtifactType(output.type || `${step.skillId}-result`);
    const version = (this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM artifact_versions WHERE task_id = ? AND artifact_type = ?
    `).get(task.id, artifactType) as { version: number }).version + 1;
    const title = output.title?.trim() || `${step.title} · ${artifactType}`;
    const createdAt = now();
    const markdown = [
      `# ${title}`,
      '',
      `- Artifact：${artifactType}`,
      `- Skill：${step.skillId}`,
      `- Step：${step.id}`,
      `- Attempt：${step.attempt}`,
      '',
      output.content.trim(),
      '',
    ].join('\n');
    const stored = writeVersionedArtifact(
      project.projectSpacePath,
      `artifacts/${task.id}/${artifactType}/v${version}.md`,
      markdown,
    );
    return {
      id: id('artifact'),
      taskId: task.id,
      stepId: step.id,
      skillId: step.skillId,
      artifactType,
      title,
      version,
      status: 'generated',
      artifactPath: stored.path,
      contentHash: stored.hash,
      sourceSessionId: sessionRecordId,
      metadata: {
        ...(output.metadata ?? {}),
        ...(output.path ? { reportedWorkspacePath: output.path } : {}),
      },
      createdAt,
    };
  }

  private preparePreApprovalArtifact(
    task: Task,
    plan: TaskPlan,
    input: PreApprovalArtifactInput,
  ): PreApprovalArtifactVersion {
    const project = this.getProject(task.projectId);
    const artifactType = sanitizeArtifactType(input.artifactType);
    const version = (this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM preapproval_artifact_versions WHERE task_id = ? AND artifact_type = ?
    `).get(task.id, artifactType) as { version: number }).version + 1;
    const createdAt = now();
    const title = input.title.trim() || `${task.title} · ${artifactType}`;
    const content = [
      `# ${title}`,
      '',
      `- Artifact：${artifactType}`,
      `- Plan：v${plan.version}`,
      `- 生成器：${input.sourceExecutor}/${input.sourceModel}`,
      '',
      input.content.trim(),
      '',
    ].join('\n');
    const stored = writeVersionedArtifact(
      project.projectSpacePath,
      `artifacts/${task.id}/pre-approval/${artifactType}/v${version}.md`,
      content,
    );
    return {
      id: id('preartifact'),
      taskId: task.id,
      planId: plan.id,
      artifactType,
      title,
      version,
      status: 'generated',
      artifactPath: stored.path,
      contentHash: stored.hash,
      sourceExecutor: input.sourceExecutor,
      sourceModel: input.sourceModel,
      sourceSessionId: input.sourceSessionId,
      createdAt,
    };
  }

  private prepareDesignedQualityGates(
    task: Task,
    step: TaskStep,
    artifacts: SkillArtifactOutput[],
  ): QualityGate[] {
    if (step.skillId !== 'test-design') return [];
    const testPlan = artifacts.find((artifact) => artifact.type === 'test-plan');
    const candidate = testPlan?.metadata?.qualityGates;
    if (candidate === undefined) return [];
    if (!Array.isArray(candidate)) {
      throw new DomainError('TEST_GATE_METADATA_INVALID', '测试计划中的 qualityGates 必须是数组。', 422);
    }
    const seen = new Set<string>();
    return candidate.map((value, index) => {
      if (!value || typeof value !== 'object') {
        throw new DomainError('TEST_GATE_METADATA_INVALID', `测试门禁 #${index + 1} 不是有效对象。`, 422);
      }
      const gate = value as Record<string, unknown>;
      const commandArgv = Array.isArray(gate.commandArgv)
        ? gate.commandArgv.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
        : [];
      const directoryId = typeof gate.directoryId === 'string' ? gate.directoryId : '';
      const name = typeof gate.name === 'string' ? gate.name.trim() : '';
      if (!name || commandArgv.length === 0 || !step.directoryIds.includes(directoryId)) {
        throw new DomainError(
          'TEST_GATE_METADATA_INVALID',
          `测试门禁 #${index + 1} 缺少名称、结构化命令，或引用了本步骤范围外的目录。`,
          422,
        );
      }
      const timeoutMs = typeof gate.timeoutMs === 'number'
        ? Math.min(Math.max(Math.trunc(gate.timeoutMs), 1_000), 3_600_000)
        : this.getSettings().gateTimeoutMs;
      const expectedExitCodes = Array.isArray(gate.expectedExitCodes)
        ? gate.expectedExitCodes.filter((code): code is number => Number.isInteger(code))
        : [0];
      const qualityGate: QualityGate = {
        id: id('designedgate'),
        name,
        command: commandArgv.join(' '),
        commandArgv,
        directoryId,
        source: 'task_specific',
        timeoutMs,
        expectedExitCodes: expectedExitCodes.length ? expectedExitCodes : [0],
        required: gate.required !== false,
        status: 'pending',
      };
      if (!this.isDesignedGateWithinConfirmedCommand(task, qualityGate)) {
        throw new DomainError(
          'TEST_GATE_PERMISSION_EXPANSION',
          `测试门禁“${name}”不是已确认命令的更窄调用，不能在运行期扩大执行权限。`,
          422,
          { directoryId, commandArgv },
        );
      }
      const signature = `${directoryId}:${commandArgv.join('\u0000')}`;
      if (seen.has(signature)) {
        throw new DomainError('TEST_GATE_DUPLICATE', `测试门禁“${name}”与同一测试计划中的其他门禁重复。`, 422);
      }
      seen.add(signature);
      return qualityGate;
    });
  }

  private isDesignedGateWithinConfirmedCommand(task: Task, candidate: QualityGate): boolean {
    const commandArgv = candidate.commandArgv ?? candidate.command.trim().split(/\s+/);
    return Boolean(commandArgv.length && task.plan?.qualityGates.some((approved) => {
      if (approved.directoryId !== candidate.directoryId || approved.status === 'waived') return false;
      const approvedArgv = approved.commandArgv ?? approved.command.trim().split(/\s+/);
      return approvedArgv.length > 0
        && approvedArgv.every((argument, index) => commandArgv[index] === argument);
    }));
  }

  private prepareChangeManifest(
    task: Task,
    step: TaskStep,
    checkpoint: { directoryId: string; baseCommit: string; commit: string; inspection: GitChangeInspection },
  ): ChangeManifest {
    const project = this.getProject(task.projectId);
    const createdAt = now();
    const manifestId = id('changes');
    const base = {
      id: manifestId,
      taskId: task.id,
      stepId: step.id,
      skillId: step.skillId,
      attempt: step.attempt,
      directoryId: checkpoint.directoryId,
      baseCommit: checkpoint.baseCommit,
      checkpointCommit: checkpoint.commit,
      files: checkpoint.inspection.files,
      hasOutOfScopeChanges: checkpoint.inspection.hasOutOfScopeChanges,
      hasSensitiveChanges: checkpoint.inspection.hasSensitiveChanges,
      createdAt,
    };
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `changes/${task.id}/${step.position + 1}-${step.skillId}/attempt-${step.attempt}-${checkpoint.directoryId}.json`,
      `${JSON.stringify(base, null, 2)}\n`,
    );
    return { ...base, artifactPath: artifact.path, contentHash: artifact.hash };
  }

  private buildRunSnapshot(task: Task, executorInstallations: ExecutorInstallation[] = []): TaskRunSnapshot {
    if (!task.plan) throw new DomainError('PLAN_REQUIRED', '确认任务前必须先生成计划。', 409);
    const project = this.getProject(task.projectId);
    const projectSettings = this.getProjectSettings(task.projectId);
    const taskVersion: TaskVersionSummary = {
      ...this.getTaskVersion(task.id, task.plan.taskVersionId),
      status: 'approved',
    };
    const team = this.getTeam(task.teamId);
    const agents = this.listAgents().filter((agent) => team.memberIds.includes(agent.id));
    const roleIds = new Set(agents.map((agent) => agent.roleId));
    const executorIds = new Set(agents.map((agent) => agent.executor));
    const skillIds = new Set(task.plan.steps.map((step) => step.skillId));
    const directoryIds = new Set(task.plan.branchRoutes.map((route) => route.directoryId));
    const snapshotId = id('snapshot');
    const createdAt = now();
    const frozenPlan: TaskPlan = {
      ...task.plan,
      branchRoutes: task.plan.branchRoutes.map((route) => {
        const directory = project.directories.find((item) => item.id === route.directoryId);
        if (!directory?.gitRootPath || directory.currentBranch !== route.sourceBranch) return route;
        return {
          ...route,
          sourceWorkingTreeHash: workingTreeFingerprint(directory.gitRootPath),
        };
      }),
    };
    const permissionManifests = this.buildPermissionManifests(
      task,
      frozenPlan,
      agents,
      createdAt,
      project.directories,
    );
    const capabilities = this.freezeTaskCapabilities(task, frozenPlan, agents, createdAt);
    const content = {
      id: snapshotId,
      taskId: task.id,
      planId: task.plan.id,
      planVersion: task.plan.version,
      taskVersion,
      projectSettings,
      task: {
        title: task.title,
        description: task.description,
        expectedOutput: task.expectedOutput,
        constraints: task.constraints,
        forbiddenPaths: [...new Set([...projectSettings.forbiddenPaths, ...task.forbiddenPaths])],
      },
      plan: { ...frozenPlan, confirmedAt: createdAt },
      team,
      agents,
      executors: [...executorIds].map((executor) => {
        const installation = executorInstallations.find((item) => item.id === executor);
        return {
          executor,
          version: installation?.version ?? null,
          executableHash: installation?.path ? sha256(installation.path) : null,
          capabilities: installation?.capabilities ?? [],
          selectedModels: [...new Set(agents.filter((agent) => agent.executor === executor).map((agent) => agent.model))],
          health: installation?.health ?? 'unchecked' as const,
          checkedAt: installation?.lastCheckedAt ?? null,
        };
      }),
      roles: this.listRoleTemplates(false).filter((role) => roleIds.has(role.id)),
      skills: builtinSkills.filter((skill) => skillIds.has(skill.id)),
      directories: project.directories.filter((directory) => directoryIds.has(directory.id)),
      permissionManifests,
      capabilities,
      createdAt,
    };
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `runs/${task.id}/snapshots/${snapshotId}.json`,
      `${JSON.stringify(content, null, 2)}\n`,
    );
    return {
      ...content,
      contentHash: artifact.hash,
      artifactPath: artifact.path,
    };
  }

  private buildPlan(task: Task, project: Project, version: number, draft?: Partial<TaskPlan>): TaskPlan {
    const draftUsesLegacySkills = Boolean(draft?.steps?.length)
      && draft!.steps!.every((step) => step.kind !== 'work_unit'
        && builtinSkills.some((skill) => skill.id === step.skillId));
    const flowVersion = draftUsesLegacySkills ? 1 : (task.flowVersion ?? 1);
    const planningTask: Task = flowVersion === task.flowVersion ? task : { ...task, flowVersion };
    const taskVersion = this.getCurrentTaskVersion(task.id);
    const agents = this.listAgents();
    const team = this.getTeam(task.teamId);
    const teamAgents = agents.filter((agent) => team.memberIds.includes(agent.id));
    const executionSteps = this.normalizePlanSteps(planningTask, project, teamAgents, draft?.steps);
    let branchRoutes = this.resolveBranchRoutes(planningTask, project, executionSteps, draft?.branchRoutes);
    if (task.status === 'COMPOSING_PLAN' && task.snapshot) {
      branchRoutes = branchRoutes.map((route) => ({
        ...route,
        taskBranch: `yanxu/${task.id.slice(5, 17)}-v${version}`,
      }));
    }
    const involvedDirectoryIds = new Set(branchRoutes.map((route) => route.directoryId));
    const previousGates = new Map((task.plan?.qualityGates ?? []).map((gate) => [
      `${gate.directoryId}:${gate.name}:${gate.command}`,
      gate,
    ]));
    const detectedQualityGates: QualityGate[] = project.directories.filter((directory) => involvedDirectoryIds.has(directory.id)).flatMap((directory) =>
      ['typecheck', 'lint', 'test', 'build'].filter((name) => directory.commands[name]).map((name) => {
        const command = directory.commands[name] as string;
        const previous = previousGates.get(`${directory.id}:${name}:${command}`);
        return {
          id: previous?.id ?? id('gate'),
          name,
          command,
          commandArgv: command.trim().split(/\s+/),
          source: 'existing_project' as const,
          directoryId: directory.id,
          required: true,
          status: previous?.status === 'waived' ? 'waived' as const : 'pending' as const,
        };
      }),
    );
    const proposedQualityGates = draft?.qualityGates
      ? draft.qualityGates.map((gate) => {
        if (!involvedDirectoryIds.has(gate.directoryId)) {
          throw new DomainError('PLAN_GATE_DIRECTORY_INVALID', `质量门禁 ${gate.name} 引用了计划范围之外的目录。`, 422, {
            gateId: gate.id,
            directoryId: gate.directoryId,
          });
        }
        const commandArgv = gate.commandArgv?.map((argument) => argument.trim()).filter(Boolean);
        if (!commandArgv?.length) {
          throw new DomainError('PLAN_GATE_COMMAND_INVALID', `质量门禁 ${gate.name} 缺少结构化命令参数。`, 422);
        }
        return {
          ...gate,
          id: gate.id || id('gate'),
          command: commandArgv.join(' '),
          commandArgv,
          source: gate.source ?? 'task_specific',
          timeoutMs: Math.min(Math.max(gate.timeoutMs ?? this.getSettings().gateTimeoutMs, 1_000), 3_600_000),
          expectedExitCodes: gate.expectedExitCodes?.length ? gate.expectedExitCodes : [0],
          status: gate.status === 'waived' ? 'waived' as const : 'pending' as const,
        };
      })
      : [];
    const proposedGateKeys = new Set(proposedQualityGates.map((gate) =>
      `${gate.directoryId}:${(gate.commandArgv ?? [gate.command]).join('\u0000')}`));
    const qualityGates = [
      ...detectedQualityGates.filter((gate) =>
        !proposedGateKeys.has(`${gate.directoryId}:${(gate.commandArgv ?? [gate.command]).join('\u0000')}`)),
      ...proposedQualityGates,
    ];
    const missingSkills = flowVersion === 1
      ? executionSteps.filter((step) => !step.agentId).map((step) => step.skillId)
      : [];
    const questions = (draft?.questions ?? []).map((question) => ({
      ...question,
      options: question.options ?? [],
    }));
    if (!task.expectedOutput.trim()) {
      questions.push({
        id: id('q'),
        question: '这次任务最终必须交付哪些可验收结果？',
        options: createPlanQuestionOptions([
          {
            label: '按计划标准交付',
            description: '以计划中的成功标准、步骤产物和最终交付报告作为验收依据，适合目标已经基本明确的任务。',
            value: '以当前计划的成功标准、各步骤结构化产物和最终交付报告作为本次可验收结果。',
            recommended: true,
          },
          {
            label: '先明确交付清单',
            description: '要求协调器先列出具体文件、文档或可运行结果及验收方式，再进入执行。',
            value: '请先在计划中补充明确的交付物清单、格式和验收方式，再启动任务。',
          },
        ]),
        answer: null,
      });
    }
    if (missingSkills.length > 0) {
      const skillList = missingSkills.join('、');
      questions.push({
        id: id('q'),
        question: `当前团队缺少这些 Skill 的执行人员：${skillList}。应该如何调整？`,
        options: createPlanQuestionOptions([
          {
            label: '先完善团队',
            description: '补充具备缺失 Skill 的人员后重新规划，保留当前任务目标和质量要求。',
            value: `先为当前团队补充具备 ${skillList} 的可用人员，然后重新生成计划。`,
            recommended: true,
          },
          {
            label: '缩减任务范围',
            description: '移除无法覆盖的步骤，并同步收窄目标、范围与成功标准。',
            value: `调整计划，移除对 ${skillList} 的依赖，并同步缩减任务范围和成功标准。`,
          },
        ]),
        answer: null,
      });
    }

    return {
      id: id('plan'), taskId: task.id, version,
      taskVersionId: draft?.taskVersionId ?? taskVersion.id,
      taskVersion: draft?.taskVersion ?? taskVersion.version,
      flowVersion,
      preApprovalSkillIds: draft?.preApprovalSkillIds ?? [],
      goal: draft?.goal ?? task.description,
      scope: draft?.scope ?? project.directories.map((directory) => directory.displayName),
      nonScope: draft?.nonScope ?? ['未经确认的目录', '远程 push、PR、部署'],
      successCriteria: draft?.successCriteria ?? (task.expectedOutput ? [task.expectedOutput] : ['完成计划产物并通过全部非豁免质量门禁']),
      assumptions: draft?.assumptions ?? [], risks: draft?.risks ?? [], questions,
      steps: executionSteps,
      permissions: draft?.permissions ?? ['读取所选项目目录', '写入隔离任务 worktree', '执行计划内项目命令'],
      branchRoutes,
      qualityGates,
      preApprovalArtifacts: draft?.preApprovalArtifacts ?? [],
      answersReviewedAt: draft?.answersReviewedAt ?? null,
      createdAt: now(), confirmedAt: null,
    };
  }

  private buildSteps(task: Task, plan: TaskPlan): TaskStep[] {
    return plan.steps.map((step, position) => ({
      id: step.id,
      taskId: task.id,
      position,
      skillId: step.skillId,
      kind: step.kind ?? (plan.flowVersion === 2 ? 'work_unit' : 'legacy_skill'),
      requiredCapabilities: step.requiredCapabilities ?? [],
      capabilityIds: step.capabilityIds ?? [],
      verification: step.verification ?? [],
      mode: step.mode ?? (step.skillId === 'implementation' ? 'write' : 'read_only'),
      requiresIndependentSession: step.requiresIndependentSession ?? false,
      agentId: step.agentId,
      title: step.title,
      description: step.description,
      inputs: step.inputs,
      expectedOutput: step.expectedOutput,
      directoryIds: step.directoryIds,
      status: 'pending',
      attempt: 0,
      startedAt: null,
      completedAt: null,
      summary: null,
    }));
  }

  private renderPlan(task: Task, plan: TaskPlan): string {
    const section = (title: string, items: string[]) => `## ${title}\n\n${items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- 无'}\n`;
    const steps = plan.steps.map((step) => step.kind === 'work_unit'
      ? `### ${step.position + 1}. ${step.title}\n\n- 执行单元：WorkUnit\n- Agent：${step.agentId ?? '待分配'}\n- 模式：${step.mode === 'write' ? '可写' : '只读'}\n- 所需能力：${step.requiredCapabilities?.join('、') || '通用项目能力'}\n- 装载能力：${step.capabilityIds?.join('、') || '无'}\n- 输入：${step.inputs.join('；') || '当前任务与上游上下文'}\n- 目录：${step.directoryIds.join('、')}\n- 验证：${step.verification?.join('；') || '依据成功标准与独立质量门禁验证'}\n- 预期结果：${step.expectedOutput}`
      : `### ${step.position + 1}. ${step.title}\n\n- Skill：${step.skillId}\n- Agent：${step.agentId ?? '待分配'}\n- 输入：${step.inputs.join('；') || '当前任务与上游产物'}\n- 目录：${step.directoryIds.join('、')}\n- 预期产出：${step.expectedOutput}`,
    ).join('\n\n');
    const preApprovalArtifacts = plan.preApprovalArtifacts.map((artifact) =>
      `- ${artifact.title}（${artifact.artifactType} v${artifact.version}，${artifact.status}）\n  - 路径：${artifact.artifactPath}\n  - 哈希：${artifact.contentHash}`,
    ).join('\n');
    const questions = plan.questions.map((item) => {
      const options = item.options.map((option) =>
        `  - ${option.recommended ? '推荐' : '备选'}：${option.label} — ${option.description}`).join('\n');
      return `- ${item.question}\n${options || '  - 旧版计划未生成候选方案，可填写自定义方案'}\n  - 回答：${item.answer ?? '待回答'}`;
    }).join('\n');
    return `# ${task.title} · 执行计划 v${plan.version}\n\n- 需求版本：v${plan.taskVersion}（${plan.taskVersionId}）\n- 确认前 Skills：${plan.preApprovalSkillIds.join('、') || '无'}\n\n## 目标\n\n${plan.goal}\n\n${section('范围', plan.scope)}\n${section('非范围', plan.nonScope)}\n${section('成功标准', plan.successCriteria)}\n${section('假设', plan.assumptions)}\n${section('风险', plan.risks)}\n## 确认前产物\n\n${preApprovalArtifacts || '- 无'}\n\n## 歧义问题\n\n${questions || '- 无'}\n\n## 执行步骤\n\n${steps}\n\n## 分支路由\n\n${plan.branchRoutes.map((route) => `- ${route.directoryId}: ${route.sourceBranch}@${route.sourceCommit} → ${route.taskBranch} → ${route.targetBranch}`).join('\n')}\n\n${section('权限', plan.permissions)}\n## 质量门禁\n\n${plan.qualityGates.length ? plan.qualityGates.map((gate) => `- ${gate.name}: \`${gate.command}\`${gate.status === 'waived' ? '（已豁免）' : ''}`).join('\n') : '- 暂未识别已有自动化门禁，测试设计阶段必须补充。'}\n`;
  }

  private normalizePlanSteps(
    task: Task,
    project: Project,
    teamAgents: AgentProfile[],
    proposedSteps?: ExecutionPlanStep[],
  ): ExecutionPlanStep[] {
    if (task.flowVersion === 2) {
      const allDirectoryIds = project.directories.map((directory) => directory.id);
      if (!proposedSteps?.length) {
        throw new DomainError('PLAN_WORK_UNITS_REQUIRED', '新流程计划必须根据当前任务明确生成至少一个 WorkUnit。', 422);
      }
      const steps = proposedSteps.map((proposed, position) => {
        const requestedAgent = proposed.agentId
          ? teamAgents.find((agent) => agent.id === proposed.agentId)
          : undefined;
        if (proposed.agentId && !requestedAgent) {
          throw new DomainError('PLAN_STEP_AGENT_INVALID', `人员 ${proposed.agentId} 不属于当前团队。`, 422);
        }
        return {
          id: id('planstep'),
          position,
          skillId: 'work-unit',
          kind: 'work_unit' as const,
          agentId: requestedAgent?.id ?? proposed.agentId ?? teamAgents[0]?.id ?? null,
          title: proposed.title?.trim() || `执行单元 ${position + 1}`,
          description: proposed.description?.trim() || proposed.expectedOutput?.trim() || '完成当前执行单元目标。',
          inputs: proposed.inputs?.map((item) => item.trim()).filter(Boolean) ?? [],
          expectedOutput: proposed.expectedOutput?.trim() || '形成可验证的任务进展',
          directoryIds: proposed.directoryIds?.length ? [...new Set(proposed.directoryIds)] : allDirectoryIds,
          requiredCapabilities: proposed.requiredCapabilities?.map((item) => item.trim()).filter(Boolean) ?? [],
          capabilityIds: [...new Set(proposed.capabilityIds ?? [])],
          verification: proposed.verification?.map((item) => item.trim()).filter(Boolean) ?? [],
          mode: proposed.mode === 'write' ? 'write' as const : 'read_only' as const,
          requiresIndependentSession: proposed.requiresIndependentSession ?? false,
        };
      });
      this.validatePlanSteps(task, project, steps);
      return steps;
    }
    const fallbackSkillIds = defaultExecutionSkillIds.filter((skillId) =>
      teamAgents.some((agent) => this.getRoleTemplate(agent.roleId).skillIds.includes(skillId)),
    );
    const source = proposedSteps?.length
      ? proposedSteps
      : (fallbackSkillIds.length ? fallbackSkillIds : [...defaultExecutionSkillIds]).map((skillId, position) => ({
        id: '',
        position,
        skillId,
        kind: 'legacy_skill' as const,
        requiredCapabilities: [],
        capabilityIds: [],
        verification: [],
        mode: skillId === 'implementation' ? 'write' as const : 'read_only' as const,
        requiresIndependentSession: false,
        agentId: null,
        title: '',
        description: '',
        inputs: [],
        expectedOutput: '',
        directoryIds: project.directories.map((directory) => directory.id),
      }));
    const steps = source.map((proposed, position) => {
      const skill = builtinSkills.find((item) => item.id === proposed.skillId);
      if (!skill) throw new DomainError('PLAN_SKILL_UNKNOWN', `计划包含未知 Skill：${proposed.skillId}`, 422);
      const compatibleAgents = teamAgents.filter((agent) =>
        this.getRoleTemplate(agent.roleId).skillIds.includes(skill.id),
      );
      const requestedAgent = proposed.agentId ? compatibleAgents.find((agent) => agent.id === proposed.agentId) : null;
      if (proposed.agentId && !requestedAgent) {
        throw new DomainError('PLAN_STEP_AGENT_INVALID', `人员 ${proposed.agentId} 不属于当前团队或不具备 Skill ${skill.id}。`, 422);
      }
      const directoryIds = proposed.directoryIds?.length
        ? [...new Set(proposed.directoryIds)]
        : project.directories.map((directory) => directory.id);
      const proposedInputs = proposed.inputs?.map((item) => item.trim()).filter(Boolean) ?? [];
      return {
        id: id('planstep'),
        position,
        skillId: skill.id,
        kind: 'legacy_skill' as const,
        requiredCapabilities: [],
        capabilityIds: [],
        verification: [],
        mode: skill.id === 'implementation' ? 'write' as const : 'read_only' as const,
        requiresIndependentSession: false,
        agentId: requestedAgent?.id ?? compatibleAgents[0]?.id ?? null,
        title: proposed.title?.trim() || skill.name,
        description: proposed.description?.trim() || skill.description,
        inputs: proposedInputs.length ? proposedInputs : skill.inputs,
        expectedOutput: proposed.expectedOutput?.trim() || skill.outputs.join('、'),
        directoryIds,
      };
    });
    this.validatePlanSteps(task, project, steps);
    return steps;
  }

  private validatePlanSteps(task: Task, project: Project, steps: ExecutionPlanStep[]): void {
    if (steps.length === 0) throw new DomainError('PLAN_STEPS_REQUIRED', '执行计划至少需要一个执行单元。', 422);
    const team = this.getTeam(task.teamId);
    const teamAgents = this.listAgents().filter((agent) => team.memberIds.includes(agent.id));
    const projectDirectoryIds = new Set(project.directories.map((directory) => directory.id));
    const enabledCapabilities = new Map(this.listProjectCapabilities(task.projectId)
      .filter((item) => item.enabled)
      .map((item) => [item.capabilityId, item.capability]));
    for (const [position, step] of steps.entries()) {
      if (task.flowVersion === 2 || step.kind === 'work_unit') {
        if (step.position !== position) step.position = position;
        if (step.directoryIds.length === 0 || step.directoryIds.some((directoryId) => !projectDirectoryIds.has(directoryId))) {
          throw new DomainError('PLAN_STEP_DIRECTORY_INVALID', `WorkUnit ${step.title} 的项目目录范围无效。`, 422);
        }
        const assignedAgent = step.agentId ? teamAgents.find((agent) => agent.id === step.agentId) : null;
        if (step.agentId && !assignedAgent) {
          throw new DomainError('PLAN_STEP_AGENT_INVALID', `人员 ${step.agentId} 不属于当前团队。`, 422);
        }
        for (const capabilityId of [...new Set(step.capabilityIds ?? [])]) {
          const capability = enabledCapabilities.get(capabilityId);
          if (!capability) {
            throw new DomainError('PLAN_CAPABILITY_NOT_ENABLED', `WorkUnit ${step.title} 使用了未在项目启用的能力。`, 422, {
              stepId: step.id,
              capabilityId,
            });
          }
          if (assignedAgent && !capability.compatibility.includes(assignedAgent.executor)) {
            throw new DomainError('PLAN_CAPABILITY_INCOMPATIBLE', `能力 ${capability.name} 与人员执行器 ${assignedAgent.executor} 不兼容。`, 422, {
              stepId: step.id,
              capabilityId,
              executor: assignedAgent.executor,
            });
          }
        }
        continue;
      }
      const skill = builtinSkills.find((item) => item.id === step.skillId);
      if (!skill) throw new DomainError('PLAN_SKILL_UNKNOWN', `计划包含未知 Skill：${step.skillId}`, 422);
      if (step.position !== position) step.position = position;
      if (step.directoryIds.length === 0 || step.directoryIds.some((directoryId) => !projectDirectoryIds.has(directoryId))) {
        throw new DomainError('PLAN_STEP_DIRECTORY_INVALID', `SkillStep ${step.title} 的项目目录范围无效。`, 422);
      }
      if (!step.agentId) continue;
      const agent = teamAgents.find((item) => item.id === step.agentId);
      const role = agent ? this.getRoleTemplate(agent.roleId) : null;
      if (!agent || !role?.skillIds.includes(step.skillId)) {
        throw new DomainError('PLAN_STEP_AGENT_INVALID', `人员 ${step.agentId} 不属于当前团队或不具备 Skill ${step.skillId}。`, 422);
      }
    }
  }

  private resolveBranchRoutes(
    task: Task,
    project: Project,
    steps: ExecutionPlanStep[],
    proposedRoutes?: Array<{ directoryId: string; sourceBranch: string; targetBranch: string }>,
  ): BranchRoute[] {
    const involvedDirectoryIds = new Set(steps.flatMap((step) => step.directoryIds));
    const proposals = new Map(proposedRoutes?.map((route) => [route.directoryId, route]) ?? []);
    for (const directoryId of proposals.keys()) {
      if (!involvedDirectoryIds.has(directoryId)) {
        throw new DomainError('PLAN_BRANCH_DIRECTORY_INVALID', '分支路由包含未参与当前计划的项目目录。', 422, { directoryId });
      }
    }
    return project.directories.filter((directory) => involvedDirectoryIds.has(directory.id)).map((directory) => {
      const proposed = proposals.get(directory.id);
      const previous = task.plan?.branchRoutes.find((route) => route.directoryId === directory.id);
      const fallback = directory.currentBranch ?? directory.localBranches[0] ?? 'main';
      const sourceBranch = proposed?.sourceBranch?.trim() || previous?.sourceBranch || fallback;
      const targetBranch = proposed?.targetBranch?.trim() || previous?.targetBranch || sourceBranch;
      if (directory.gitInitialized) {
        if (!directory.localBranches.includes(sourceBranch) || !directory.localBranches.includes(targetBranch)) {
          throw new DomainError('GIT_BRANCH_NOT_FOUND', `目录 ${directory.displayName} 的来源分支或目标分支不存在。`, 422, {
            directoryId: directory.id,
            sourceBranch,
            targetBranch,
            available: directory.localBranches,
          });
        }
      }
      return {
        directoryId: directory.id,
        sourceBranch,
        sourceCommit: directory.gitRootPath
          ? git(directory.gitRootPath, ['rev-parse', '--verify', `refs/heads/${sourceBranch}`]) || 'UNBORN'
          : 'UNBORN',
        taskBranch: previous?.taskBranch ?? `yanxu/${task.id.slice(5, 17)}`,
        targetBranch,
      };
    });
  }

  private replacePendingSteps(task: Task, plan: TaskPlan): void {
    if (task.steps.some((step) => step.status !== 'pending')) {
      throw new DomainError('PLAN_STEPS_ALREADY_STARTED', '执行已经开始，不能直接修改当前执行单元；请请求重新规划。', 409);
    }
    this.database.prepare(`
      DELETE FROM task_steps
      WHERE task_id = ? AND NOT (status = 'skipped' AND position >= 1000)
    `).run(task.id);
    const insert = this.database.prepare(`
      INSERT INTO task_steps(
        id, task_id, position, skill_id, agent_id, title, description, inputs_json, expected_output, directory_ids_json,
        unit_kind, required_capabilities_json, capability_ids_json, verification_json, execution_mode, requires_independent_session, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const step of this.buildSteps(task, plan)) {
      insert.run(step.id, step.taskId, step.position, step.skillId, step.agentId, step.title, step.description,
        JSON.stringify(step.inputs), step.expectedOutput, JSON.stringify(step.directoryIds), step.kind,
        JSON.stringify(step.requiredCapabilities), JSON.stringify(step.capabilityIds), JSON.stringify(step.verification),
        step.mode, Number(step.requiresIndependentSession));
    }
  }

  private alignReplannedSteps(task: Task, plan: TaskPlan): TaskPlan {
    const used = new Set<string>();
    const completed = task.steps.filter((step) => step.status === 'succeeded').sort((a, b) => a.position - b.position);
    const aligned: ExecutionPlanStep[] = [];
    for (const existing of completed) {
      const proposed = plan.steps.find((step) =>
        !used.has(step.id) && (existing.kind === 'work_unit'
          ? step.kind === 'work_unit' && step.position === existing.position
          : step.skillId === existing.skillId));
      if (!proposed) {
        throw new DomainError(
          'REPLAN_DROPPED_COMPLETED_STEP',
          `重新规划不能删除已经完成的执行单元：${existing.title}`,
          422,
          { stepId: existing.id, skillId: existing.skillId },
        );
      }
      used.add(proposed.id);
      aligned.push({
        ...proposed,
        id: existing.id,
        position: aligned.length,
        agentId: existing.agentId,
        title: existing.title,
        description: existing.description,
        inputs: existing.inputs,
        expectedOutput: existing.expectedOutput,
        directoryIds: existing.directoryIds,
      });
    }
    const remainingExisting = task.steps.filter((step) => step.status !== 'succeeded');
    for (const proposed of plan.steps.filter((step) => !used.has(step.id))) {
      const reusable = remainingExisting.find((step) =>
        !aligned.some((item) => item.id === step.id) && (proposed.kind === 'work_unit'
          ? step.kind === 'work_unit' && step.position === proposed.position
          : step.skillId === proposed.skillId),
      );
      aligned.push({
        ...proposed,
        id: reusable?.id ?? proposed.id,
        position: aligned.length,
      });
    }
    return { ...plan, steps: aligned };
  }

  private preservePreviousPlanSteps(task: Task, plan: TaskPlan): TaskPlan {
    const previousSteps = task.plan?.steps ?? [];
    if (previousSteps.length === 0) return plan;
    const used = new Set<string>();
    const steps = previousSteps.map((previous, position) => {
      const proposed = plan.steps.find((step) =>
        !used.has(step.id) && (previous.kind === 'work_unit'
          ? step.kind === 'work_unit' && step.position === previous.position
          : step.skillId === previous.skillId));
      if (proposed) {
        used.add(proposed.id);
        return { ...proposed, position };
      }
      return {
        ...previous,
        id: id('planstep'),
        position,
      };
    });
    this.validatePlanSteps(task, this.getProject(task.projectId), steps);
    return {
      ...plan,
      steps,
      branchRoutes: this.resolveBranchRoutes(task, this.getProject(task.projectId), steps, plan.branchRoutes),
    };
  }

  private replaceStepsForComposedPlan(task: Task, plan: TaskPlan, preserveCompleted: boolean): void {
    const agentsById = new Set(this.listAgents().map((agent) => agent.id));
    const insertStep = this.database.prepare(`
      INSERT INTO task_steps(
        id, task_id, position, skill_id, agent_id, title, description, inputs_json, expected_output, directory_ids_json,
        unit_kind, required_capabilities_json, capability_ids_json, verification_json, execution_mode, requires_independent_session, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    if (!preserveCompleted && task.steps.every((step) => step.status === 'pending')) {
      this.database.prepare('DELETE FROM task_steps WHERE task_id = ?').run(task.id);
      for (const step of this.buildSteps(task, plan)) {
        insertStep.run(step.id, step.taskId, step.position, step.skillId,
          step.agentId && agentsById.has(step.agentId) ? step.agentId : null,
          step.title, step.description, JSON.stringify(step.inputs), step.expectedOutput, JSON.stringify(step.directoryIds),
          step.kind, JSON.stringify(step.requiredCapabilities), JSON.stringify(step.capabilityIds), JSON.stringify(step.verification),
          step.mode, Number(step.requiresIndependentSession));
      }
      return;
    }

    const maximumPosition = (this.database.prepare(`
      SELECT COALESCE(MAX(position), 0) AS position FROM task_steps WHERE task_id = ?
    `).get(task.id) as { position: number }).position;
    const historyOffset = maximumPosition + 1000;
    if (!preserveCompleted) {
      this.database.prepare(`
        UPDATE task_steps SET position = position + ?, status = 'skipped'
        WHERE task_id = ? AND position < 1000
      `).run(historyOffset, task.id);
      for (const step of this.buildSteps(task, plan)) {
        insertStep.run(step.id, step.taskId, step.position, step.skillId,
          step.agentId && agentsById.has(step.agentId) ? step.agentId : null,
          step.title, step.description, JSON.stringify(step.inputs), step.expectedOutput, JSON.stringify(step.directoryIds),
          step.kind, JSON.stringify(step.requiredCapabilities), JSON.stringify(step.capabilityIds), JSON.stringify(step.verification),
          step.mode, Number(step.requiresIndependentSession));
      }
      return;
    }

    this.database.prepare(`
      UPDATE task_steps
      SET position = position + ?, status = CASE WHEN status = 'succeeded' THEN status ELSE 'skipped' END
      WHERE task_id = ? AND status != 'succeeded' AND position < 1000
    `).run(historyOffset, task.id);
    const updateStep = this.database.prepare(`
      UPDATE task_steps SET position = ?, skill_id = ?, agent_id = ?, title = ?, description = ?,
        inputs_json = ?, expected_output = ?, directory_ids_json = ?, unit_kind = ?,
        required_capabilities_json = ?, capability_ids_json = ?, verification_json = ?, execution_mode = ?, requires_independent_session = ?,
        status = CASE WHEN status = 'succeeded' THEN status ELSE 'pending' END,
        completed_at = CASE WHEN status = 'succeeded' THEN completed_at ELSE NULL END
      WHERE id = ? AND task_id = ?
    `);
    for (const step of this.buildSteps(task, plan)) {
      const existing = this.database.prepare('SELECT id FROM task_steps WHERE id = ? AND task_id = ?').get(step.id, task.id);
      if (existing) {
        updateStep.run(step.position, step.skillId, step.agentId && agentsById.has(step.agentId) ? step.agentId : null,
          step.title, step.description, JSON.stringify(step.inputs), step.expectedOutput, JSON.stringify(step.directoryIds),
          step.kind, JSON.stringify(step.requiredCapabilities), JSON.stringify(step.capabilityIds), JSON.stringify(step.verification),
          step.mode, Number(step.requiresIndependentSession),
          step.id, task.id);
      } else {
        insertStep.run(step.id, step.taskId, step.position, step.skillId,
          step.agentId && agentsById.has(step.agentId) ? step.agentId : null,
          step.title, step.description, JSON.stringify(step.inputs), step.expectedOutput, JSON.stringify(step.directoryIds),
          step.kind, JSON.stringify(step.requiredCapabilities), JSON.stringify(step.capabilityIds), JSON.stringify(step.verification),
          step.mode, Number(step.requiresIndependentSession));
      }
    }
  }

  resumeAutomaticReplanIfSafe(taskId: string): Task {
    const task = this.getTask(taskId);
    if (task.status !== 'WAITING_REAPPROVAL' || !task.plan) return task;
    const plan = task.plan;
    const previousSnapshot = this.getRunSnapshot(taskId);
    if (!previousSnapshot || !this.isReplanWithinApprovedBoundary(previousSnapshot, plan)) return task;
    const snapshot = this.buildAutomaticReplanSnapshot(task, previousSnapshot);
    this.database.transaction(() => {
      this.database.prepare('UPDATE plans SET confirmed_at = ? WHERE id = ?').run(now(), plan.id);
      this.database.prepare(`
        UPDATE task_versions SET status = 'approved'
        WHERE id = ? AND task_id = ? AND status = 'draft'
      `).run(plan.taskVersionId, taskId);
      this.database.prepare(`
        UPDATE preapproval_artifact_versions
        SET status = 'approved'
        WHERE plan_id = ? AND status = 'generated'
      `).run(plan.id);
      this.database.prepare('DELETE FROM gate_results WHERE task_id = ?').run(taskId);
      this.persistTaskCapabilitySnapshots(taskId, snapshot.capabilities ?? []);
      this.database.prepare(`
        INSERT INTO run_snapshots(
          id, task_id, plan_id, plan_version, content_json, content_hash, artifact_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, snapshot.taskId, snapshot.planId, snapshot.planVersion, JSON.stringify(snapshot),
        snapshot.contentHash, snapshot.artifactPath, snapshot.createdAt);
      this.updateTaskState(taskId, task.stateVersion, 'RUNNING', 'plan.auto_reapproved',
        `计划 v${task.plan?.version} 未突破已批准边界，已自动继续执行。`, {
          previousPlanVersion: previousSnapshot.planVersion,
          planVersion: plan.version,
          snapshotId: snapshot.id,
        });
      this.enqueueJobOrAssertRunnable(
        'RUN_SKILL_STEP',
        taskId,
        `task:${taskId}:replan-resume:${task.plan?.version}`,
        85,
      );
    })();
    this.recordProjectSpaceCommit(this.getProject(task.projectId).projectSpacePath, `docs: auto resume plan v${plan.version} for ${taskId}`, taskId);
    return this.getTask(taskId);
  }

  private buildAutomaticReplanSnapshot(task: Task, previous: TaskRunSnapshot): TaskRunSnapshot {
    if (!task.plan) throw new DomainError('PLAN_REQUIRED', '重新规划缺少当前计划。', 409);
    const snapshotId = id('snapshot');
    const createdAt = now();
    const usedSkillIds = new Set(task.plan.steps.map((step) => step.skillId));
    const usedDirectoryIds = new Set(task.plan.branchRoutes.map((route) => route.directoryId));
    const capabilities = this.freezeAutomaticReplanCapabilities(task, previous, createdAt);
    const content = {
      id: snapshotId,
      taskId: task.id,
      planId: task.plan.id,
      planVersion: task.plan.version,
      taskVersion: {
        ...this.getTaskVersion(task.id, task.plan.taskVersionId),
        status: 'approved' as const,
      },
      projectSettings: previous.projectSettings ?? this.getProjectSettings(task.projectId),
      task: previous.task,
      plan: { ...task.plan, confirmedAt: createdAt },
      team: previous.team,
      agents: previous.agents,
      roles: previous.roles,
      skills: builtinSkills.filter((skill) => usedSkillIds.has(skill.id)),
      directories: previous.directories.filter((directory) => usedDirectoryIds.has(directory.id)),
      permissionManifests: this.buildPermissionManifests(
        task,
        task.plan,
        previous.agents,
        createdAt,
        previous.directories,
      ),
      capabilities,
      createdAt,
    };
    const project = this.getProject(task.projectId);
    const artifact = writeVersionedArtifact(
      project.projectSpacePath,
      `runs/${task.id}/snapshots/${snapshotId}.json`,
      `${JSON.stringify(content, null, 2)}\n`,
    );
    return { ...content, contentHash: artifact.hash, artifactPath: artifact.path };
  }

  private freezeAutomaticReplanCapabilities(
    task: Task,
    previous: TaskRunSnapshot,
    createdAt: string,
  ): TaskCapabilitySnapshot[] {
    if (!task.plan) return [];
    const previousCapabilities = previous.capabilities ?? [];
    const agents = new Map(previous.agents.map((agent) => [agent.id, agent]));
    return task.plan.steps.flatMap((step) => {
      const agent = step.agentId ? agents.get(step.agentId) : null;
      if (!agent) return [];
      return [...new Set(step.capabilityIds ?? [])].map((capabilityId) => {
        const approved = previousCapabilities.find((item) =>
          item.capabilityId === capabilityId && item.executor === agent.executor);
        if (!approved) {
          throw new DomainError('REPLAN_CAPABILITY_OUT_OF_BOUNDARY', '重新规划引入了未批准的能力或执行器。', 422, {
            stepId: step.id,
            capabilityId,
            executor: agent.executor,
          });
        }
        return {
          ...approved,
          id: id('taskcap'),
          taskId: task.id,
          stepId: step.id,
          agentId: agent.id,
          projectionPath: null,
          status: 'frozen' as const,
          error: null,
          createdAt,
        };
      });
    });
  }

  private buildPermissionManifests(
    task: Task,
    plan: TaskPlan,
    agents: AgentProfile[],
    createdAt: string,
    directories: ProjectDirectory[],
  ): PermissionManifest[] {
    const projectSettings = this.getProjectSettings(task.projectId);
    return plan.steps.map((step) => {
      if (!step.agentId) {
        throw new DomainError('PLAN_AGENT_REQUIRED', `步骤“${step.title}”尚未分配执行人员。`, 422, {
          stepId: step.id,
        });
      }
      const agent = agents.find((item) => item.id === step.agentId);
      if (!agent) {
        throw new DomainError('PLAN_AGENT_NOT_IN_TEAM', `步骤“${step.title}”的执行人员不在已选团队中。`, 422, {
          stepId: step.id,
          agentId: step.agentId,
        });
      }
      const canRunProjectCommands = step.kind === 'work_unit'
        ? step.mode === 'write'
        : ['implementation', 'test-execution'].includes(step.skillId);
      const commands = new Set(['pwd', 'ls', 'ls -la', 'git status*', 'git diff*']);
      if (canRunProjectCommands) {
        for (const gate of plan.qualityGates) {
          if (!step.directoryIds.includes(gate.directoryId) || gate.status === 'waived') continue;
          const directory = directories.find((item) => item.id === gate.directoryId);
          if (!directory) continue;
          const selectedPrefix = relative(
            directory.gitRootPath ?? directory.realPath,
            directory.realPath,
          ).replaceAll('\\', '/').replace(/^\.\/+/, '');
          const commandRoot = selectedPrefix && selectedPrefix !== '.'
            ? `${gate.directoryId}/${selectedPrefix}`
            : gate.directoryId;
          commands.add(gate.command);
          commands.add(`${gate.command} *`);
          commands.add(`cd ${commandRoot} && ${gate.command}`);
          commands.add(`cd ${commandRoot} && ${gate.command} *`);
        }
        for (const pattern of commandPatternsForPlanPermissions(plan)) commands.add(pattern);
      }
      return {
        id: id('permission-manifest'),
        taskId: task.id,
        stepId: step.id,
        agentId: step.agentId,
        permissionMode: projectSettings.permissionMode === 'inherit'
          ? agent.permissionMode
          : projectSettings.permissionMode,
        readOnly: step.kind === 'work_unit' ? step.mode !== 'write' : step.skillId !== 'implementation',
        directoryIds: [...step.directoryIds],
        allowedCommandPatterns: [...commands],
        forbiddenPaths: [...new Set([...projectSettings.forbiddenPaths, ...task.forbiddenPaths])],
        createdAt,
      };
    });
  }

  private isReplanWithinApprovedBoundary(previousSnapshot: TaskRunSnapshot, current: TaskPlan): boolean {
    const previous = previousSnapshot.plan;
    if (previous.goal !== current.goal) return false;
    if (JSON.stringify(previous.scope) !== JSON.stringify(current.scope)) return false;
    if (JSON.stringify(previous.successCriteria) !== JSON.stringify(current.successCriteria)) return false;
    if (JSON.stringify(previous.nonScope) !== JSON.stringify(current.nonScope)) return false;
    if (current.questions.some((question) => !question.answer?.trim())) return false;
    const previousPermissions = new Set(previous.permissions);
    if (current.permissions.some((permission) => !previousPermissions.has(permission))) return false;
    const previousRoutes = new Map(previous.branchRoutes.map((route) => [route.directoryId, route]));
    for (const route of current.branchRoutes) {
      const approved = previousRoutes.get(route.directoryId);
      if (!approved
        || approved.sourceBranch !== route.sourceBranch
        || approved.sourceCommit !== route.sourceCommit
        || approved.taskBranch !== route.taskBranch
        || approved.targetBranch !== route.targetBranch) return false;
    }
    if (current.branchRoutes.length > previous.branchRoutes.length) return false;
    const previousGates = new Map(previous.qualityGates.map((gate) => [gate.id, gate]));
    for (const gate of previous.qualityGates.filter((item) => item.required && item.status !== 'waived')) {
      const currentGate = current.qualityGates.find((item) => item.id === gate.id);
      if (!currentGate
        || !currentGate.required
        || currentGate.status === 'waived'
        || currentGate.directoryId !== gate.directoryId
        || currentGate.command !== gate.command) return false;
    }
    const approvedDirectories = new Set(previous.steps.flatMap((step) => step.directoryIds));
    const approvedCapabilityIds = new Set((previousSnapshot.capabilities ?? []).map((item) => item.capabilityId));
    const agents = new Map(previousSnapshot.agents.map((agent) => [agent.id, agent]));
    const roles = new Map(previousSnapshot.roles.map((role) => [role.id, role]));
    return current.steps.every((step) => {
      if (!step.agentId || !step.directoryIds.every((directoryId) => approvedDirectories.has(directoryId))) return false;
      if ((step.capabilityIds ?? []).some((capabilityId) => !approvedCapabilityIds.has(capabilityId))) return false;
      const agent = agents.get(step.agentId);
      return Boolean(agent && roles.get(agent.roleId)?.skillIds.includes(step.skillId));
    }) && previousGates.size <= current.qualityGates.length;
  }

  private requiredGatesSatisfied(task: Task): boolean {
    const requiredGateIds = this.getEffectiveQualityGates(task.id)
      .filter((gate) => gate.required && gate.status !== 'waived')
      .map((gate) => gate.id);
    if (requiredGateIds.length === 0) return true;
    const placeholders = requiredGateIds.map(() => '?').join(',');
    const result = this.database.prepare(`
      SELECT COUNT(*) AS passed FROM gate_results
      WHERE task_id = ? AND gate_id IN (${placeholders}) AND status = 'passed'
    `).get(task.id, ...requiredGateIds) as { passed: number };
    return result.passed === requiredGateIds.length;
  }

  private commandMessage(command: TaskCommand): string {
    const messages: Record<TaskCommand, string> = {
      submit: '提交任务分析。', confirm: '确认计划并启动任务。', pause: '请求暂停任务。', resume: '恢复任务。', stop: '立即停止任务并保留现场。',
      cancel: '任务已废弃；执行现场与证据已保留。',
      self_merge: '保留本地任务分支，由用户自行合并；任务已归档。', merge: '任务分支已合并到目标分支；任务已归档。', reopen: '反馈问题并重新打开任务。',
    };
    return messages[command];
  }

  private renderKnowledge(title: string, category: KnowledgeItem['category'], status: KnowledgeItem['status'], content: string, sourceTaskId: string | null): string {
    return `# ${title}\n\n- 类别：${category}\n- 状态：${status}\n- 来源任务：${sourceTaskId ?? '人工维护'}\n\n${content}\n`;
  }

  private recordProjectSpaceCommit(root: string, operation: string, taskId: string | null = null): void {
    const project = this.database.prepare('SELECT id FROM projects WHERE project_space_path = ?').get(root) as { id: string } | undefined;
    if (!project) throw new DomainError('PROJECTSPACE_PROJECT_MISSING', 'ProjectSpace 没有关联的项目记录。', 500, { root });
    const operationId = id('projectspaceop');
    const createdAt = now();
    this.database.prepare(`
      INSERT INTO project_space_operations(
        id, project_id, task_id, operation, commit_hash, changed_files_json, status, error, created_at
      ) VALUES (?, ?, ?, ?, NULL, '[]', 'prepared', NULL, ?)
    `).run(operationId, project.id, taskId, operation, createdAt);
    try {
      const integrity = this.checkProjectSpaceIntegrity(project.id);
      if (integrity.issues.length > 0) {
        throw new Error(`ProjectSpace 存在未处理的外部变化：${integrity.issues.map((issue) =>
          `${issue.entityType}:${issue.entityId}:${issue.reason}`).join('；')}`);
      }
      writeProjectStateManifest(this.database, project.id, root);
      const result = commitProjectSpaceGit(root, operation, this.knownProjectSpaceFiles(project.id, root));
      this.database.prepare(`
        UPDATE project_space_operations
        SET commit_hash = ?, changed_files_json = ?, status = 'succeeded', error = NULL
        WHERE id = ? AND status = 'prepared'
      `).run(result.commitHash, JSON.stringify(result.changedFiles), operationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.prepare(`
        UPDATE project_space_operations SET status = 'failed', error = ?
        WHERE id = ? AND status = 'prepared'
      `).run(message, operationId);
      throw new DomainError('PROJECTSPACE_COMMIT_FAILED', 'ProjectSpace 版本提交失败，操作已记录。', 500, {
        operationId,
        operation,
        error: message,
      });
    }
  }

  private reconcilePreparedProjectSpaceOperations(): void {
    this.database.prepare(`
      UPDATE project_space_operations
      SET status = 'failed', error = COALESCE(error, 'Daemon 在 ProjectSpace 操作提交完成前中断；需要完整性检查后重试。')
      WHERE status = 'prepared'
    `).run();
  }

  private knownProjectSpaceFiles(projectId: string, root: string): string[] {
    const files = new Set<string>([
      join(root, 'README.md'),
      join(root, 'project.json'),
      join(root, 'settings.json'),
      join(root, 'state', 'current.json'),
    ]);
    const artifactQueries = [
      `SELECT tv.artifact_path AS path FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE t.project_id = ?`,
      `SELECT p.artifact_path AS path FROM plans p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ?`,
      `SELECT a.artifact_path AS path FROM preapproval_artifact_versions a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?`,
      `SELECT a.artifact_path AS path FROM artifact_versions a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?`,
      `SELECT a.artifact_path AS path FROM task_attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?`,
      `SELECT s.artifact_path AS path FROM run_snapshots s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ?`,
      `SELECT c.artifact_path AS path FROM change_manifests c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?`,
      `SELECT c.manifest_path AS path FROM context_packs c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?`,
      `SELECT d.artifact_path AS path FROM directory_profiles d JOIN project_directories pd ON pd.id = d.directory_id WHERE pd.project_id = ?`,
      `SELECT r.artifact_path AS path FROM delivery_reports r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ?`,
      `SELECT s.result_path AS path FROM agent_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.result_path IS NOT NULL`,
      `SELECT ps.artifact_path AS path FROM project_settings ps WHERE ps.project_id = ?`,
      `SELECT l.artifact_path AS path FROM project_capability_locks l WHERE l.project_id = ?`,
    ];
    for (const sql of artifactQueries) {
      const rows = this.database.prepare(sql).all(projectId) as Array<{ path: string | null }>;
      for (const row of rows) if (row.path) files.add(row.path);
    }
    const directories = this.database.prepare(`
      SELECT id, removed_at FROM project_directories WHERE project_id = ?
    `).all(projectId) as Array<{ id: string; removed_at: string | null }>;
    for (const directory of directories) {
      files.add(join(root, 'directories', `${directory.id}.json`));
      if (directory.removed_at) files.add(join(root, 'directories', directory.id, 'removed.json'));
    }
    const knowledge = this.database.prepare(`
      SELECT id, source_task_id FROM knowledge_items WHERE project_id = ?
    `).all(projectId) as Array<{ id: string; source_task_id: string | null }>;
    for (const item of knowledge) {
      files.add(join(root, 'knowledge', 'items', `${item.id}.md`));
      if (item.source_task_id) files.add(join(root, 'knowledge', 'candidates', `${item.source_task_id}.md`));
    }
    const taskIds = this.database.prepare('SELECT id FROM tasks WHERE project_id = ?').all(projectId) as Array<{ id: string }>;
    for (const task of taskIds) {
      const events = this.database.prepare(`
        SELECT payload_json FROM workflow_events WHERE aggregate_type = 'task' AND aggregate_id = ?
      `).all(task.id) as Array<{ payload_json: string }>;
      for (const event of events) {
        const artifactPath = parseJson<{ artifactPath?: string }>(event.payload_json, {}).artifactPath;
        if (artifactPath) files.add(artifactPath);
      }
    }
    return [...files].filter((path) => existsSync(path));
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseGitHubSkillAddress(address: string): {
  cloneUrl: string;
  canonicalUrl: string;
  treeSegments: string[];
} {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new DomainError('CAPABILITY_GITHUB_URL_INVALID', '请输入有效的 GitHub HTTPS 地址。', 422);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
    throw new DomainError('CAPABILITY_GITHUB_URL_INVALID', '当前只允许公开的 github.com HTTPS 地址。', 422);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? '') || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1] ?? '')) {
    throw new DomainError('CAPABILITY_GITHUB_URL_INVALID', 'GitHub 地址必须包含仓库所有者和仓库名。', 422);
  }
  const owner = parts[0] as string;
  const repository = (parts[1] as string).replace(/\.git$/, '');
  let treeSegments: string[] = [];
  if (parts[2]) {
    if (parts[2] !== 'tree' || !parts[3]) {
      throw new DomainError('CAPABILITY_GITHUB_URL_INVALID', '子目录地址必须使用 GitHub 的 /tree/<ref>/<path> 格式。', 422);
    }
    treeSegments = parts.slice(3).map(decodeURIComponent);
  }
  if (treeSegments.includes('..') || treeSegments.length > 32) throw new DomainError('CAPABILITY_GITHUB_PATH_INVALID', 'GitHub 引用或子目录无效。', 422);
  const canonicalUrl = `https://github.com/${owner}/${repository}`;
  return { cloneUrl: `${canonicalUrl}.git`, canonicalUrl, treeSegments };
}

function findSkillDirectories(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 12 || result.length >= 100) return;
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) result.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', 'node_modules', '.next', 'dist', 'build'].includes(entry.name)) continue;
      visit(join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return result;
}

function validateImportedTree(root: string): void {
  let files = 0;
  let totalBytes = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 16) throw new DomainError('CAPABILITY_ARCHIVE_TOO_DEEP', 'ZIP 解压目录层级超过 16 层。', 422);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (entry.isSymbolicLink()) throw new DomainError('CAPABILITY_ARCHIVE_SYMLINK_REJECTED', '扩展来源包含符号链接，已拒绝导入。', 422);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      totalBytes += statSync(path).size;
      if (files > 2_000 || totalBytes > 40 * 1024 * 1024) {
        throw new DomainError('CAPABILITY_ARCHIVE_TOO_LARGE', 'ZIP 解压后超过 2000 个文件或 40MB。', 422);
      }
    }
  };
  visit(root, 0);
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoLiteralCredential(value: unknown, parentKey = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoLiteralCredential(item, parentKey));
    return;
  }
  if (!isRecordValue(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = `${parentKey}.${key}`;
    const usesEnvironmentReference = typeof item === 'string'
      && /(?:\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-?[^}]*)?\})/.test(item);
    if (typeof item === 'string'
      && (/\.headers?\./i.test(fieldPath)
        || /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i.test(fieldPath))
      && !usesEnvironmentReference) {
      throw new DomainError('CAPABILITY_LITERAL_CREDENTIAL_REJECTED',
        `能力配置 ${key} 不能保存明文凭据，请改用本地环境变量引用。`, 422);
    }
    if (typeof item === 'string' && /\.url$/i.test(fieldPath)) {
      try {
        const url = new URL(item);
        const hasLiteralUrlCredential = Boolean(url.username || url.password)
          || [...url.searchParams.entries()].some(([name, content]) =>
            /(token|secret|password|api[-_]?key|credential)/i.test(name)
            && !/(?:\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-?[^}]*)?\})/.test(content));
        if (hasLiteralUrlCredential) throw new DomainError('CAPABILITY_LITERAL_CREDENTIAL_REJECTED',
          'MCP URL 不能包含明文凭据，请改用本地环境变量引用。', 422);
      } catch (error) {
        if (error instanceof DomainError) throw error;
      }
    }
    assertNoLiteralCredential(item, fieldPath);
  }
}

function toOpenCodeMcpConfiguration(configuration: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown => convertCredentialReferences(value, 'opencode');
  const type = configuration.type;
  if (type === 'local') {
    return {
      type: 'local',
      command: Array.isArray(configuration.command) ? convert(configuration.command) : [],
      ...(isRecordValue(configuration.environment) ? { environment: convert(configuration.environment) } : {}),
      enabled: configuration.disabled !== true,
    };
  }
  return {
    type: 'remote',
    url: convert(configuration.url),
    ...(isRecordValue(configuration.headers) ? { headers: convert(configuration.headers) } : {}),
    enabled: configuration.disabled !== true,
  };
}

function toClaudeMcpConfiguration(configuration: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown => convertCredentialReferences(value, 'claude');
  const type = configuration.type;
  if (type === 'local') {
    const command = Array.isArray(configuration.command)
      ? configuration.command.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      type: 'stdio',
      command: convert(command[0] ?? ''),
      args: convert(command.slice(1)),
      ...(isRecordValue(configuration.environment) ? { env: convert(configuration.environment) } : {}),
    };
  }
  return {
    type: 'http',
    url: convert(configuration.url),
    ...(isRecordValue(configuration.headers) ? { headers: convert(configuration.headers) } : {}),
  };
}

function convertCredentialReferences(value: unknown, target: 'opencode' | 'claude'): unknown {
  if (typeof value === 'string') {
    return target === 'opencode'
      ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}/g, '{env:$1}')
      : value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  }
  if (Array.isArray(value)) return value.map((item) => convertCredentialReferences(item, target));
  if (isRecordValue(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, convertCredentialReferences(item, target)]));
  return value;
}

function readArtifactContent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readAttachmentPreview(path: string): { preview: string | null; truncated: boolean } {
  try {
    const content = readFileSync(path);
    const sample = content.subarray(0, Math.min(content.length, 16_000));
    if (sample.includes(0)) return { preview: null, truncated: false };
    const preview = sample.toString('utf8');
    const replacementCount = [...preview].filter((character) => character === '\uFFFD').length;
    if (replacementCount > Math.max(4, preview.length * 0.01)) return { preview: null, truncated: false };
    return { preview, truncated: content.length > sample.length };
  } catch {
    return { preview: null, truncated: false };
  }
}

function sanitizeArtifactType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || 'skill-result';
}

function rankKnowledge(items: KnowledgeItem[], query: string): KnowledgeItem[] {
  const terms = contextTerms(query);
  return items.map((item) => {
    const title = item.title.toLowerCase();
    const content = item.content.toLowerCase();
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 4 : 0) + (content.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))
    .map(({ item }) => item);
}

function contextTerms(value: string): string[] {
  const normalized = value.toLowerCase();
  const latin = normalized.split(/[^a-z0-9_.-]+/).filter((term) => term.length >= 2);
  const chineseSegments = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const chinese = chineseSegments.flatMap((segment) => {
    const grams: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) grams.push(segment.slice(index, index + 2));
    return grams;
  });
  return [...new Set([...latin, ...chinese])].slice(0, 80);
}
