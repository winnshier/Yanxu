import type { ExecutorInstallation, ExecutorType } from '@yanxu/contracts';

export interface RuntimeHandle {
  id: string;
  executor: ExecutorType;
  workspacePath: string;
  endpoint: string;
  sessionIds: string[];
}

export interface RuntimeStartOptions {
  environment?: Record<string, string>;
}

export interface StructuredExecutionInput {
  runtime: RuntimeHandle;
  title: string;
  prompt: string;
  model: string;
  schema: Record<string, unknown>;
  abortSignal?: AbortSignal;
  permissionMode?: 'standard' | 'managed';
  toolMode?: 'enabled' | 'disabled';
  readOnly?: boolean;
  resumeSessionId?: string;
  policy?: RuntimePermissionPolicy;
  onSessionStarted?: (sessionId: string) => void | Promise<void>;
  onPermission?: (request: ExecutorPermissionRequest) => Promise<'once' | 'always' | 'reject'>;
}

export interface RuntimePermissionPolicy {
  allowedReadPatterns: string[];
  allowedExternalDirectoryPatterns?: string[];
  allowedEditPatterns: string[];
  allowedBashPatterns: string[];
  allowedSkillPatterns?: string[];
  allowedMcpToolPatterns?: string[];
  denyUnlistedSkills?: boolean;
  deniedMcpToolPatterns?: string[];
  taskGrants: Array<{ permission: string; patterns: string[] }>;
  forbiddenReadPatterns: string[];
  networkPolicy?: 'ask' | 'deny';
  dependencyInstallPolicy?: 'ask' | 'deny';
}

export interface ExecutorPermissionRequest {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

export interface StructuredExecutionResult<T> {
  sessionId: string;
  output: T;
}

export interface ExecutorAdapter {
  probe(): Promise<ExecutorInstallation>;
  startRuntime(workspacePath: string, runtimeDirectory: string, options?: RuntimeStartOptions): Promise<RuntimeHandle>;
  executeStructured<T>(input: StructuredExecutionInput): Promise<StructuredExecutionResult<T>>;
  abortSession(runtime: RuntimeHandle, sessionId: string): Promise<void>;
  stopRuntime(runtime: RuntimeHandle): Promise<void>;
}
