export const taskStatuses = [
  'DRAFT', 'COMPOSING_PLAN', 'WAITING_PLAN_APPROVAL', 'PREPARING', 'QUEUED',
  'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING', 'WAITING_APPROVAL',
  'WAITING_REAPPROVAL', 'PAUSED', 'BLOCKED', 'STOPPED', 'DELIVERED', 'ARCHIVED', 'REOPENED',
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type ExecutorType = 'opencode' | 'claude' | 'codex';
export type ExecutorHealth = 'available' | 'unavailable' | 'unchecked';
export type TaskStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type KnowledgeCategory = 'profile' | 'decision' | 'experience' | 'candidate';

export interface ProjectDirectory {
  id: string;
  projectId: string;
  displayName: string;
  selectedPath: string;
  realPath: string;
  gitRootPath: string | null;
  gitInitialized: boolean;
  currentBranch: string | null;
  isDirty: boolean;
  contentTypes: string[];
  stack: string[];
  commands: Record<string, string>;
  localBranches: string[];
  scannedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  projectSpacePath: string;
  createdAt: string;
  updatedAt: string;
  directories: ProjectDirectory[];
  taskSummary: Record<'active' | 'attention' | 'delivered' | 'archived', number>;
}

export interface ProjectSettings {
  projectId: string;
  permissionMode: 'inherit' | 'standard' | 'managed';
  forbiddenPaths: string[];
  updatedAt: string;
}

export interface UpdateProjectSettingsInput {
  description?: string;
  permissionMode: ProjectSettings['permissionMode'];
  forbiddenPaths: string[];
}

export interface DirectoryProfileVersion {
  id: string;
  directoryId: string;
  version: number;
  status: 'candidate' | 'confirmed' | 'superseded';
  content: ProjectDirectory;
  artifactPath: string;
  contentHash: string;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ProjectSpaceOperation {
  id: string;
  projectId: string;
  taskId: string | null;
  operation: string;
  commitHash: string | null;
  changedFiles: string[];
  status: 'prepared' | 'succeeded' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface ProjectSpaceIntegrityIssue {
  entityType: 'task' | 'plan' | 'preapproval' | 'artifact' | 'attachment' | 'snapshot' | 'directory_profile' | 'delivery_report' | 'knowledge' | 'project_settings' | 'state_manifest';
  entityId: string;
  artifactPath: string;
  expectedHash: string;
  actualHash: string | null;
  reason: 'missing' | 'modified' | 'invalid_path';
}

export interface ProjectSpaceIntegrityReport {
  projectId: string;
  status: 'healthy' | 'external_changes';
  gitDirty: boolean;
  checkedAt: string;
  checkedArtifacts: number;
  issues: ProjectSpaceIntegrityIssue[];
}

export interface ProjectSpaceRestorePreview {
  valid: boolean;
  projectId: string;
  projectName: string;
  projectSpacePath: string;
  manifestPath: string;
  schemaVersion: number;
  generatedAt: string;
  payloadHash: string;
  counts: {
    directories: number;
    teams: number;
    agents: number;
    tasks: number;
    taskVersions: number;
    plans: number;
    artifacts: number;
    knowledge: number;
    snapshots: number;
  };
  issues: string[];
}

export interface SystemHealth {
  status: 'ready' | 'starting';
  service: 'yanxu-daemon';
  database: 'ready';
  scheduler: {
    running: boolean;
    activeJobs: number;
  };
  time: string;
}

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  responsibilities: string[];
  skillIds: string[];
  defaultPermissions: string[];
  version: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  roleId: string;
  description: string;
  inputs: string[];
  outputs: string[];
  artifactTypes: string[];
  completionChecks: string[];
  permissions: string[];
  canBlockDelivery: boolean;
  version: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  roleId: string;
  executor: ExecutorType;
  model: string;
  parameters: Record<string, unknown>;
  permissionMode: 'standard' | 'managed';
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskStep {
  id: string;
  taskId: string;
  position: number;
  skillId: string;
  agentId: string | null;
  title: string;
  description: string;
  inputs: string[];
  expectedOutput: string;
  directoryIds: string[];
  status: TaskStepStatus;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  summary: string | null;
}

export interface ExecutionPlanStep {
  id: string;
  position: number;
  skillId: string;
  agentId: string | null;
  title: string;
  description: string;
  inputs: string[];
  expectedOutput: string;
  directoryIds: string[];
}

export interface BranchRoute {
  directoryId: string;
  sourceBranch: string;
  sourceCommit: string;
  sourceWorkingTreeHash?: string;
  taskBranch: string;
  targetBranch: string;
}

export interface QualityGate {
  id: string;
  name: string;
  command: string;
  commandArgv?: string[];
  directoryId: string;
  source?: 'existing_project' | 'project_knowledge' | 'task_specific';
  envAllowlist?: string[];
  timeoutMs?: number;
  expectedExitCodes?: number[];
  required: boolean;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'waived';
}

export interface PreApprovalArtifactVersion {
  id: string;
  taskId: string;
  planId: string;
  artifactType: string;
  title: string;
  version: number;
  status: 'generated' | 'superseded' | 'approved';
  artifactPath: string;
  contentHash: string;
  sourceExecutor: ExecutorType;
  sourceModel: string;
  sourceSessionId: string | null;
  createdAt: string;
}

export interface TaskVersionSummary {
  id: string;
  taskId: string;
  version: number;
  status: 'draft' | 'approved' | 'superseded';
  artifactPath: string;
  contentHash: string;
  createdAt: string;
}

export interface TaskPlan {
  id: string;
  taskId: string;
  version: number;
  taskVersionId: string;
  taskVersion: number;
  preApprovalSkillIds: string[];
  goal: string;
  scope: string[];
  nonScope: string[];
  successCriteria: string[];
  assumptions: string[];
  risks: string[];
  questions: Array<{ id: string; question: string; answer: string | null }>;
  steps: ExecutionPlanStep[];
  permissions: string[];
  branchRoutes: BranchRoute[];
  qualityGates: QualityGate[];
  preApprovalArtifacts: PreApprovalArtifactVersion[];
  answersReviewedAt: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface PermissionManifest {
  id: string;
  taskId: string;
  stepId: string;
  agentId: string;
  permissionMode: AgentProfile['permissionMode'];
  readOnly: boolean;
  directoryIds: string[];
  allowedCommandPatterns: string[];
  forbiddenPaths: string[];
  createdAt: string;
}

export interface TaskRunSnapshot {
  id: string;
  taskId: string;
  planId: string;
  planVersion: number;
  taskVersion: TaskVersionSummary;
  projectSettings: ProjectSettings;
  task: {
    title: string;
    description: string;
    expectedOutput: string;
    constraints: string;
    forbiddenPaths: string[];
  };
  plan: TaskPlan;
  team: Team;
  agents: AgentProfile[];
  roles: RoleTemplate[];
  skills: SkillDefinition[];
  directories: ProjectDirectory[];
  permissionManifests: PermissionManifest[];
  contentHash: string;
  artifactPath: string;
  createdAt: string;
}

export interface TaskRunSnapshotSummary {
  id: string;
  planId: string;
  planVersion: number;
  taskVersionId: string;
  taskVersion: number;
  contentHash: string;
  createdAt: string;
}

export interface SkillArtifactOutput {
  type: string;
  title?: string;
  content: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactVersion {
  id: string;
  taskId: string;
  stepId: string;
  skillId: string;
  artifactType: string;
  title: string;
  version: number;
  status: 'generated' | 'superseded' | 'approved';
  artifactPath: string;
  contentHash: string;
  sourceSessionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ContextPackSource {
  type: 'snapshot' | 'artifact' | 'knowledge' | 'directory' | 'event' | 'gate';
  id: string;
  title: string;
  hash: string;
  characters: number;
}

export interface TaskContextPack {
  id: string;
  taskId: string;
  stepId: string;
  attempt: number;
  task: TaskRunSnapshot['task'];
  plan: TaskPlan;
  currentStep: TaskStep;
  upstreamArtifacts: Array<ArtifactVersion & { content: string }>;
  projectKnowledge: Array<Pick<KnowledgeItem, 'id' | 'category' | 'title' | 'content' | 'version'>>;
  directories: ProjectDirectory[];
  recentEvidence: WorkflowEvent[];
  gateEvidence: Array<{
    gateId: string;
    attempt: number;
    commandArgv: string[];
    status: 'passed' | 'failed';
    exitCode: number | null;
    timedOut: boolean;
    logPath: string;
    logExcerpt: string;
    contentHash: string;
  }>;
  sources: ContextPackSource[];
  estimatedTokens: number;
  truncated: boolean;
  contentHash: string;
  manifestPath: string;
  createdAt: string;
}

export interface ChangeManifestFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldBlob: string | null;
  newBlob: string | null;
  addedLines: number | null;
  deletedLines: number | null;
  inApprovedScope: boolean;
  sensitive: boolean;
}

export interface ChangeManifest {
  id: string;
  taskId: string;
  stepId: string;
  skillId: string;
  attempt: number;
  directoryId: string;
  baseCommit: string;
  checkpointCommit: string;
  files: ChangeManifestFile[];
  hasOutOfScopeChanges: boolean;
  hasSensitiveChanges: boolean;
  artifactPath: string;
  contentHash: string;
  createdAt: string;
}

export interface GateAttempt {
  id: string;
  taskId: string;
  gateId: string;
  attempt: number;
  directoryId: string;
  commandArgv: string[];
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  logPath: string;
  logExcerpt?: string;
  logTruncated?: boolean;
  startedAt: string;
  completedAt: string;
}

export interface AgentSessionEvidence {
  id: string;
  taskId: string;
  stepId: string;
  agentId: string | null;
  executor: ExecutorType;
  model: string;
  externalSessionId: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  resultPath: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface DeliveryConflict {
  id: string;
  taskId: string;
  directoryId: string;
  taskBranch: string;
  targetBranch: string;
  classification: 'semantic';
  conflicts: Array<{ path: string; reason: string; hunkCount: number }>;
  mechanicallyResolvableFiles: string[];
  status: 'pending' | 'resolved';
  resolution: 'merged_after_retry' | 'user_managed' | 'superseded_by_retry' | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RecoveryRecord {
  id: string;
  taskId: string;
  jobId: string | null;
  reason: string;
  previousOwner: string | null;
  recoveredBy: string | null;
  action: string;
  createdAt: string;
}

export interface DeliveryAction {
  id: string;
  taskId: string;
  action: 'merge_to_target' | 'self_merge';
  status: 'started' | 'succeeded' | 'failed';
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TaskEvidence {
  requirementVersions: Array<{
    id: string;
    version: number;
    artifactPath: string;
    contentHash: string;
    status: string;
    createdAt: string;
  }>;
  preApprovalArtifacts: Array<PreApprovalArtifactVersion & { content: string }>;
  permissionManifests: PermissionManifest[];
  permissionRequests: PermissionRequest[];
  attachments: TaskAttachment[];
  artifacts: ArtifactVersion[];
  artifactPreviews: Array<{
    artifactId: string;
    content: string;
    truncated: boolean;
  }>;
  sessions: AgentSessionEvidence[];
  contextPacks: Array<Pick<TaskContextPack, 'id' | 'stepId' | 'attempt' | 'contentHash' | 'manifestPath' | 'estimatedTokens' | 'truncated' | 'createdAt'>>;
  changeManifests: ChangeManifest[];
  designedQualityGates: QualityGate[];
  gateAttempts: GateAttempt[];
  deliveryConflicts: DeliveryConflict[];
  recoveries: RecoveryRecord[];
  deliveryActions: DeliveryAction[];
  deliveryReport: {
    artifactPath: string;
    contentHash: string;
    markdown: string;
    data: Record<string, unknown>;
    createdAt: string;
  } | null;
}

export interface TaskLogChunk {
  taskId: string;
  source: 'opencode-runtime';
  cursor: number;
  nextCursor: number;
  totalBytes: number;
  eof: boolean;
  content: string;
}

export interface TaskFileDiff {
  taskId: string;
  directoryId: string;
  path: string;
  diff: string;
  truncated: boolean;
}

export interface FolderSelection {
  token: string;
  displayPath: string;
  expiresAt: string;
}

export interface FileSelection {
  token: string;
  displayPath: string;
  fileName: string;
  size: number;
  expiresAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  fileName: string;
  artifactPath: string;
  contentHash: string;
  size: number;
  contentPreview: string | null;
  contentTruncated: boolean;
  createdAt: string;
}

export interface LocalSession {
  csrfToken: string;
}

export interface Task {
  id: string;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  title: string;
  description: string;
  expectedOutput: string;
  constraints: string;
  forbiddenPaths: string[];
  status: TaskStatus;
  stateVersion: number;
  progress: number;
  queuePosition?: number | null;
  activeStepId: string | null;
  createdAt: string;
  updatedAt: string;
  plan: TaskPlan | null;
  steps: TaskStep[];
  snapshot: TaskRunSnapshotSummary | null;
  activeExecution?: {
    agentId: string | null;
    agentName: string | null;
    executor: ExecutorType | null;
    model: string | null;
    sessionId: string | null;
    startedAt: string | null;
    heartbeatAt: string | null;
  } | null;
}

export interface WorkflowEvent {
  seq: number;
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  actorType: 'user' | 'system' | 'scheduler' | 'executor';
  message: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface PermissionRequest {
  id: string;
  taskId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  status: 'pending' | 'resolved';
  decision: 'once' | 'always' | 'reject' | null;
  message: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ExecutorInstallation {
  id: ExecutorType;
  name: string;
  command: string;
  path: string | null;
  version: string | null;
  health: ExecutorHealth;
  capabilities: string[];
  models: string[];
  lastCheckedAt: string | null;
  error: string | null;
}

export interface ExecutorRuntimeValidation {
  executor: ExecutorType;
  status: 'passed' | 'failed';
  message: string;
  version: string | null;
  capabilities: string[];
  models: string[];
  loginStatus: 'configured' | 'unknown' | 'not_applicable';
  checkedAt: string;
}

export interface SystemDiagnostics {
  databaseCheck: 'ok' | 'error';
  indexedProjectFiles: number;
  indexedKnowledgeEntries: number;
  runtimeTaskDirectories: number;
  recoveryRecords: number;
  projectSpaceFailedOperations: number;
  gitVersion: string | null;
  workbenchHome: string;
}

export interface SystemSettings {
  maxParallelTasks: number;
  retryLimit: number;
  sessionTimeoutMs: number;
  gateTimeoutMs: number;
  coordinatorExecutor: ExecutorType;
  coordinatorModel: string;
  coordinatorReady: boolean;
  permissionMode: 'standard' | 'managed';
  networkPolicy: 'ask' | 'deny';
  dependencyInstallPolicy: 'ask' | 'deny';
  workbenchHome: string;
}

export interface DashboardData {
  attention: Task[];
  systemAttention: Array<{
    id: string;
    type: 'executor' | 'project_space' | 'recovery';
    title: string;
    description: string;
    targetPath: string;
  }>;
  active: Task[];
  delivered: Task[];
  counts: { active: number; queued: number; attention: number; delivered: number };
  executors: ExecutorInstallation[];
  settings: SystemSettings;
  permissions: PermissionRequest[];
}

export interface KnowledgeItem {
  id: string;
  projectId: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  status: 'active' | 'candidate' | 'rejected' | 'superseded';
  sourceTaskId: string | null;
  version: number;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
