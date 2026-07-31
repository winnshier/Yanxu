import { createHash } from 'node:crypto';
import type {
  ExecutionFailureAction,
  ExecutionFailureCategory,
} from '@yanxu/contracts';
import { DomainError } from './errors.js';

export interface ClassifiedExecutionFailure {
  category: ExecutionFailureCategory;
  code: string | null;
  message: string;
  fingerprint: string;
  retryable: boolean;
  suggestedAction: ExecutionFailureAction;
}

const skillContractCodes = new Set([
  'SKILL_ARTIFACT_CONTRACT_FAILED',
  'SKILL_COMPLETION_CHECK_MISSING',
  'SKILL_COMPLETION_CHECK_FAILED',
  'DELIVERY_REVIEW_ISSUES_REQUIRE_CHANGES',
  'IMPLEMENTATION_CHANGE_REQUIRED',
]);

const staleCodes = new Set([
  'STATE_VERSION_CONFLICT',
  'RUN_CONTEXT_STALE',
  'STEP_STATE_INVALID',
  'GATE_STATE_INVALID',
]);

function normalizeForFingerprint(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b(?:task|job|plan|step|session|snapshot|artifact)_[a-z0-9_-]+\b/g, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\/[^\s:]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function fingerprint(category: ExecutionFailureCategory, code: string | null, message: string): string {
  return createHash('sha256')
    .update(`${category}:${code ?? 'none'}:${normalizeForFingerprint(message)}`)
    .digest('hex');
}

export function classifyExecutionFailure(error: unknown): ClassifiedExecutionFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof DomainError ? error.code : null;
  const lower = message.toLowerCase();

  // An untyped executor/runtime exception gets one guarded retry. If its normalized
  // fingerprint repeats, the store stops it before a third blind execution.
  let category: ExecutionFailureCategory = error instanceof DomainError ? 'system' : 'transient';
  let retryable = !(error instanceof DomainError);
  let suggestedAction: ExecutionFailureAction = retryable ? 'retry' : 'await_user';

  if (code && staleCodes.has(code)) {
    category = 'stale_execution';
    suggestedAction = 'discard';
  } else if (code && skillContractCodes.has(code)) {
    category = 'skill_contract';
    retryable = true;
    suggestedAction = 'retry';
  } else if (code?.includes('PERMISSION') || /permission|权限|operation not permitted/.test(lower)) {
    category = 'permission';
    retryable = false;
    suggestedAction = 'await_user';
  } else if (code?.includes('SCOPE') || /out.of.scope|scope expansion|越界|扩大.*范围|敏感文件/.test(lower)) {
    category = 'scope_change';
    retryable = false;
    suggestedAction = 'replan';
  } else if (code?.includes('GIT_') || /merge conflict|semantic conflict|source drift|git.*conflict|冲突/.test(lower)) {
    category = 'git_conflict';
    retryable = false;
    suggestedAction = 'await_user';
  } else if (
    /not support(?:ed)?|unsupported|structured output|json schema|model.*(?:invalid|unavailable|not found)|模型.*(?:不支持|不可用|不兼容)/.test(lower)
  ) {
    category = 'model_capability';
    retryable = false;
    suggestedAction = 'await_user';
  } else if (
    /invalid json|schema validation|failed to parse|malformed|unexpected token|结构化输出|输出格式/.test(lower)
  ) {
    category = 'invalid_output';
    retryable = true;
    suggestedAction = 'retry';
  } else if (
    /timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|network|rate limit|too many requests|\b429\b|\b5\d\d\b|temporar|runtime crash|aborted/.test(lower)
  ) {
    category = 'transient';
    retryable = true;
    suggestedAction = 'retry';
  }

  return {
    category,
    code,
    message,
    fingerprint: fingerprint(category, code, message),
    retryable,
    suggestedAction,
  };
}
