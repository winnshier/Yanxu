import { Type, type Static } from '@sinclair/typebox';
import { taskStatuses } from './models.js';

export const createProjectSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  directoryPath: Type.String({ minLength: 1 }),
});
export type CreateProjectInput = Static<typeof createProjectSchema>;

export const createProjectRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  directorySelectionToken: Type.String({ minLength: 1 }),
});
export type CreateProjectRequest = Static<typeof createProjectRequestSchema>;

export const folderSelectionRequestSchema = Type.Object({
  selectionToken: Type.String({ minLength: 1 }),
});
export type FolderSelectionRequest = Static<typeof folderSelectionRequestSchema>;

export const createAgentSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  roleId: Type.String({ minLength: 1 }),
  executor: Type.Union([Type.Literal('opencode'), Type.Literal('claude'), Type.Literal('codex')]),
  model: Type.String({ minLength: 1 }),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  permissionMode: Type.Optional(Type.Union([Type.Literal('standard'), Type.Literal('managed')])),
});
export type CreateAgentInput = Static<typeof createAgentSchema>;

export const agentStatusSchema = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
});
export type AgentStatusInput = Static<typeof agentStatusSchema>;

export const createTeamSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  memberIds: Type.Array(Type.String()),
  isDefault: Type.Optional(Type.Boolean()),
});
export type CreateTeamInput = Static<typeof createTeamSchema>;

export const createTaskSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  teamId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1 }),
  expectedOutput: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.String()),
  forbiddenPaths: Type.Optional(Type.Array(Type.String())),
  submitForAnalysis: Type.Optional(Type.Boolean()),
});
export type CreateTaskInput = Static<typeof createTaskSchema>;

export const createTaskRequestSchema = Type.Intersect([
  createTaskSchema,
  Type.Object({
    attachmentSelectionTokens: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 })),
  }),
]);
export type CreateTaskRequest = Static<typeof createTaskRequestSchema>;

export const answerPlanSchema = Type.Object({
  answers: Type.Record(Type.String(), Type.String()),
  goal: Type.Optional(Type.String()),
  scope: Type.Optional(Type.Array(Type.String())),
  nonScope: Type.Optional(Type.Array(Type.String())),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  stepAssignments: Type.Optional(Type.Array(Type.Object({
    stepId: Type.String({ minLength: 1 }),
    agentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  }))),
  branchRoutes: Type.Optional(Type.Array(Type.Object({
    directoryId: Type.String({ minLength: 1 }),
    sourceBranch: Type.String({ minLength: 1 }),
    targetBranch: Type.String({ minLength: 1 }),
  }))),
  permissions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  waivedGateIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type AnswerPlanInput = Static<typeof answerPlanSchema>;

export const requestPlanRevisionSchema = Type.Object({
  stateVersion: Type.Number({ minimum: 0 }),
  feedback: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type RequestPlanRevisionInput = Static<typeof requestPlanRevisionSchema>;

export const taskCommandSchema = Type.Object({
  command: Type.Union([
    Type.Literal('submit'), Type.Literal('confirm'), Type.Literal('pause'), Type.Literal('resume'),
    Type.Literal('stop'), Type.Literal('cancel'), Type.Literal('self_merge'), Type.Literal('merge'), Type.Literal('reopen'),
  ]),
  stateVersion: Type.Number({ minimum: 0 }),
  reason: Type.Optional(Type.String()),
});
export type TaskCommandInput = Static<typeof taskCommandSchema>;

export const permissionDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal('once'), Type.Literal('always'), Type.Literal('reject')]),
  message: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type PermissionDecisionInput = Static<typeof permissionDecisionSchema>;

export const updateSystemSettingsSchema = Type.Partial(Type.Object({
  maxParallelTasks: Type.Integer({ minimum: 1, maximum: 8 }),
  retryLimit: Type.Integer({ minimum: 0, maximum: 5 }),
  sessionTimeoutMs: Type.Integer({ minimum: 60_000, maximum: 24 * 60 * 60_000 }),
  gateTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 60 * 60_000 }),
  coordinatorExecutor: Type.Union([Type.Literal('opencode'), Type.Literal('claude'), Type.Literal('codex')]),
  coordinatorModel: Type.String({ maxLength: 200 }),
  permissionMode: Type.Union([Type.Literal('standard'), Type.Literal('managed')]),
  networkPolicy: Type.Union([Type.Literal('ask'), Type.Literal('deny')]),
  dependencyInstallPolicy: Type.Union([Type.Literal('ask'), Type.Literal('deny')]),
}));

export const knowledgeDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal('accept'), Type.Literal('reject')]),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
});
export type KnowledgeDecisionInput = Static<typeof knowledgeDecisionSchema>;

export const taskStatusSchema = Type.Union(taskStatuses.map((status) => Type.Literal(status)));
