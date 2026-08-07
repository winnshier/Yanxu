import type {
  AgentProfile, AnswerPlanInput, CreateAgentInput, CreateProjectRequest, CreateTaskRequest, CreateTeamInput, DirectoryProfileVersion,
  Capability, CapabilityDiscoveryReport, DashboardData, ExecutorInstallation, ExecutorRuntimeValidation, FileSelection, FolderSelection, KnowledgeItem, LocalSession, PermissionRequest, Project, ProjectCapability, ProjectSettings, ProjectSpaceIntegrityReport, ProjectSpaceOperation, ProjectSpaceRestorePreview, RoleTemplate, SkillDefinition, SystemSettings,
  ProjectCapabilityUpdateInput, RequestPlanRevisionInput, RoleTemplateChangePreview, SystemDiagnostics, SystemHealth, Task, TaskCapabilitySnapshot, TaskCommandInput, TaskDiagnostics, TaskEvidence, TaskFileDiff, TaskLogChunk, TaskPlan, Team, UpdateProjectSettingsInput, WorkflowEvent,
} from '@yanxu/contracts';

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/api/') && path !== '/api/session') await ensureSession();
  const mutation = init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase());
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(mutation && csrfToken ? { 'x-yanxu-csrf': csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(body?.error?.code ?? `HTTP_${response.status}`, body?.error?.message ?? '请求失败。', body?.error?.details);
  }
  return response.json() as Promise<T>;
}

let csrfToken = '';
let sessionPromise: Promise<LocalSession> | null = null;

const emptyQualitySummary: TaskEvidence['qualitySummary'] = {
  status: 'not_configured',
  configured: 0,
  required: 0,
  passed: 0,
  failed: 0,
  waived: 0,
  latestAttemptAt: null,
  blockingFindings: [],
  advisoryFindings: [],
};

export function normalizeTaskEvidence(value: Partial<TaskEvidence>): TaskEvidence {
  return {
    requirementVersions: value.requirementVersions ?? [],
    preApprovalArtifacts: value.preApprovalArtifacts ?? [],
    permissionManifests: value.permissionManifests ?? [],
    permissionRequests: value.permissionRequests ?? [],
    attachments: value.attachments ?? [],
    artifacts: value.artifacts ?? [],
    artifactPreviews: value.artifactPreviews ?? [],
    sessions: value.sessions ?? [],
    contextPacks: value.contextPacks ?? [],
    changeManifests: value.changeManifests ?? [],
    designedQualityGates: value.designedQualityGates ?? [],
    qualitySummary: value.qualitySummary ?? emptyQualitySummary,
    gateAttempts: value.gateAttempts ?? [],
    deliveryConflicts: value.deliveryConflicts ?? [],
    recoveries: value.recoveries ?? [],
    deliveryActions: value.deliveryActions ?? [],
    deliveryReport: value.deliveryReport ?? null,
  };
}

export async function ensureSession(): Promise<LocalSession> {
  sessionPromise ??= fetch('/api/session', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) throw new ApiError(`HTTP_${response.status}`, '无法建立本地工作台会话。');
      return response.json() as Promise<LocalSession>;
    })
    .then((session) => {
      csrfToken = session.csrfToken;
      return session;
    })
    .catch((error) => {
      sessionPromise = null;
      throw error;
    });
  return sessionPromise;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined
  ? { method }
  : { method, body: JSON.stringify(body) };

export const api = {
  health: () => request<SystemHealth>('/health'),
  dashboard: () => request<DashboardData>('/api/dashboard'),
  capabilities: () => request<Capability[]>('/api/capabilities'),
  roleTemplates: () => request<RoleTemplate[]>('/api/role-templates'),
  roleTemplateChangePreview: (id: string) => request<RoleTemplateChangePreview>(`/api/role-templates/${id}/change-preview`),
  importGitHubRoles: (address: string) => request<RoleTemplate[]>(
    '/api/role-templates/import/github', json('POST', { address }),
  ),
  importLocalRoles: (selectionToken: string) => request<RoleTemplate[]>(
    '/api/role-templates/import/local', json('POST', { selectionToken }),
  ),
  installRoleTemplate: (id: string, capabilityIds?: string[]) => request<RoleTemplate>(
    `/api/role-templates/${id}/install`, json('POST', capabilityIds ? { capabilityIds } : {}),
  ),
  discoverCapabilities: (projectId?: string) => request<CapabilityDiscoveryReport>(
    '/api/capabilities/discover', json('POST', projectId ? { projectId } : {}),
  ),
  installCapability: (id: string) => request<Capability>(`/api/capabilities/${id}/install`, json('POST')),
  importLocalSkill: (selectionToken: string) => request<Capability>(
    '/api/capabilities/import/local', json('POST', { selectionToken }),
  ),
  importGitHubSkills: (address: string) => request<Capability[]>(
    '/api/capabilities/import/github', json('POST', { address }),
  ),
  importZipSkills: (selectionToken: string) => request<Capability[]>(
    '/api/capabilities/import/zip', json('POST', { selectionToken }),
  ),
  projects: () => request<Project[]>('/api/projects'),
  previewProjectSpaceRestore: (selectionToken: string) =>
    request<ProjectSpaceRestorePreview>('/api/project-space/restore/preview', json('POST', { selectionToken })),
  restoreProjectSpace: (selectionToken: string) =>
    request<{ projectId: string; restoredTasks: number; stoppedTaskIds: string[] }>('/api/project-space/restore', json('POST', { selectionToken })),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  projectSettings: (id: string) => request<ProjectSettings>(`/api/projects/${id}/settings`),
  projectCapabilities: (id: string) => request<ProjectCapability[]>(`/api/projects/${id}/capabilities`),
  updateProjectCapability: (projectId: string, capabilityId: string, input: ProjectCapabilityUpdateInput) =>
    request<ProjectCapability>(`/api/projects/${projectId}/capabilities/${capabilityId}`, json('PUT', input)),
  updateProjectSettings: (id: string, input: UpdateProjectSettingsInput) => request<ProjectSettings>(`/api/projects/${id}/settings`, json('PUT', input)),
  projectSpaceOperations: (id: string) => request<ProjectSpaceOperation[]>(`/api/projects/${id}/project-space-operations`),
  projectSpaceIntegrity: (id: string) => request<ProjectSpaceIntegrityReport>(`/api/projects/${id}/project-space-integrity`),
  refreshProjectSpaceState: (id: string) => request<ProjectSpaceRestorePreview>(`/api/projects/${id}/project-space-state/refresh`, json('POST')),
  directoryProfiles: (id: string) => request<DirectoryProfileVersion[]>(`/api/projects/${id}/directory-profiles`),
  createProject: (input: CreateProjectRequest) => request<Project>('/api/projects', json('POST', input)),
  addDirectory: (projectId: string, selectionToken: string) => request(`/api/projects/${projectId}/directories`, json('POST', { selectionToken })),
  removeDirectory: (directoryId: string) => request<{ removedDirectoryId: string; projectId: string }>(`/api/directories/${directoryId}`, json('DELETE')),
  rescanDirectory: (directoryId: string) => request(`/api/directories/${directoryId}/rescan`, json('POST')),
  confirmDirectoryProfile: (profileId: string) => request(`/api/directory-profiles/${profileId}/confirm`, json('POST')),
  chooseFolder: () => request<FolderSelection>('/api/folder-picker', json('POST')),
  chooseFile: () => request<FileSelection>('/api/file-picker', json('POST')),
  knowledge: (projectId: string, query = '') => request<KnowledgeItem[]>(`/api/projects/${projectId}/knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  reviewKnowledge: (id: string, input: { decision: 'accept' | 'reject'; title?: string; content?: string }) =>
    request<KnowledgeItem>(`/api/knowledge/${id}/review`, json('POST', input)),
  tasks: (archived = false) => request<Task[]>(`/api/tasks?archived=${archived}`),
  task: (id: string) => request<Task>(`/api/tasks/${id}`),
  taskCapabilities: (id: string) => request<TaskCapabilitySnapshot[]>(`/api/tasks/${id}/capabilities`),
  taskPlans: (id: string) => request<TaskPlan[]>(`/api/tasks/${id}/plans`),
  taskEvidence: (id: string) => request<Partial<TaskEvidence>>(`/api/tasks/${id}/evidence`).then(normalizeTaskEvidence),
  taskDiagnostics: (id: string) => request<TaskDiagnostics>(`/api/tasks/${id}/diagnostics`),
  taskRuntimeLog: (id: string, cursor?: number) => request<TaskLogChunk>(
    `/api/tasks/${id}/runtime-log${cursor === undefined ? '' : `?cursor=${cursor}`}`,
  ),
  taskFileDiff: (id: string, directoryId: string, path: string) => request<TaskFileDiff>(
    `/api/tasks/${id}/diff?directoryId=${encodeURIComponent(directoryId)}&path=${encodeURIComponent(path)}`,
  ),
  createTask: (input: CreateTaskRequest) => request<Task>('/api/tasks', json('POST', input)),
  taskCommand: (id: string, input: TaskCommandInput) => request<Task>(`/api/tasks/${id}/commands`, json('POST', input)),
  updatePlan: (id: string, input: AnswerPlanInput) => request<Task>(`/api/tasks/${id}/plan`, json('PATCH', input)),
  requestPlanRevision: (id: string, input: RequestPlanRevisionInput) => request<Task>(`/api/tasks/${id}/plan/revise`, json('POST', input)),
  taskEvents: (id: string) => request<WorkflowEvent[]>(`/api/tasks/${id}/events`),
  agents: () => request<AgentProfile[]>('/api/agents'),
  createAgent: (input: CreateAgentInput) => request<AgentProfile>('/api/agents', json('POST', input)),
  updateAgent: (id: string, input: CreateAgentInput) => request<AgentProfile>(`/api/agents/${id}`, json('PUT', input)),
  setAgentStatus: (id: string, status: AgentProfile['status']) =>
    request<AgentProfile>(`/api/agents/${id}/status`, json('PATCH', { status })),
  deleteAgent: (id: string) => request<{ deletedAgentId: string }>(`/api/agents/${id}`, json('DELETE')),
  teams: () => request<Team[]>('/api/teams'),
  createTeam: (input: CreateTeamInput) => request<Team>('/api/teams', json('POST', input)),
  updateTeam: (id: string, input: CreateTeamInput) => request<Team>(`/api/teams/${id}`, json('PUT', input)),
  builtins: () => request<{ roles: RoleTemplate[]; skills: SkillDefinition[] }>('/api/builtins'),
  executors: () => request<ExecutorInstallation[]>('/api/executors'),
  probeExecutors: () => request<ExecutorInstallation[]>('/api/executors/probe', json('POST')),
  validateExecutor: (executor: ExecutorInstallation['id']) =>
    request<ExecutorRuntimeValidation>(`/api/executors/${executor}/validate`, json('POST')),
  executorValidations: () => request<ExecutorRuntimeValidation[]>('/api/executor-validations'),
  systemDiagnostics: () => request<SystemDiagnostics>('/api/system/diagnostics'),
  settings: () => request<SystemSettings>('/api/settings'),
  updateSettings: (input: Partial<SystemSettings>) => request<SystemSettings>('/api/settings', json('PATCH', input)),
  permissions: () => request<PermissionRequest[]>('/api/permissions'),
  respondPermission: (id: string, decision: 'once' | 'always' | 'reject') =>
    request<PermissionRequest>(`/api/permissions/${id}/respond`, json('POST', { decision })),
};
