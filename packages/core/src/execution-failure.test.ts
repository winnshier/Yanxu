import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { classifyExecutionFailure } from './execution-failure.js';

describe('execution failure classification', () => {
  it('classifies runtime failures as retryable and normalizes changing ids into one fingerprint', () => {
    const first = classifyExecutionFailure(new Error('Runtime crash in session_abc123 after 1000 ms'));
    const second = classifyExecutionFailure(new Error('Runtime crash in session_def456 after 2000 ms'));
    expect(first).toMatchObject({ category: 'transient', retryable: true, suggestedAction: 'retry' });
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('does not retry stale state or model capability failures', () => {
    expect(classifyExecutionFailure(new DomainError('RUN_CONTEXT_STALE', 'old plan', 409)))
      .toMatchObject({ category: 'stale_execution', retryable: false, suggestedAction: 'discard' });
    expect(classifyExecutionFailure(new Error('The selected model does not support JSON Schema structured output.')))
      .toMatchObject({ category: 'model_capability', retryable: false, suggestedAction: 'await_user' });
  });

  it('allows one guarded correction for a deterministic skill contract failure', () => {
    expect(classifyExecutionFailure(new DomainError('SKILL_COMPLETION_CHECK_FAILED', 'review failed', 422)))
      .toMatchObject({ category: 'skill_contract', retryable: true, suggestedAction: 'retry' });
  });
});
