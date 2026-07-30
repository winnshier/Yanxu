import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { transitionTask } from './transitions.js';

describe('task transitions', () => {
  it('moves a confirmed plan into workspace preparation', () => {
    expect(transitionTask('WAITING_PLAN_APPROVAL', 'confirm')).toBe('PREPARING');
  });

  it('archives delivered work through either delivery choice', () => {
    expect(transitionTask('DELIVERED', 'self_merge')).toBe('ARCHIVED');
    expect(transitionTask('DELIVERED', 'merge')).toBe('ARCHIVED');
  });

  it('rejects commands that would skip required states', () => {
    expect(() => transitionTask('DRAFT', 'confirm')).toThrow(DomainError);
  });

  it('allows a waiting plan to be stopped without losing the task', () => {
    expect(transitionTask('WAITING_PLAN_APPROVAL', 'stop')).toBe('STOPPED');
    expect(transitionTask('WAITING_REAPPROVAL', 'stop')).toBe('STOPPED');
  });

  it('turns a stopped task into a terminal cancelled task that cannot resume', () => {
    expect(transitionTask('STOPPED', 'cancel')).toBe('CANCELLED');
    expect(() => transitionTask('CANCELLED', 'resume')).toThrow(DomainError);
    expect(transitionTask('CANCELLED', 'reopen')).toBe('REOPENED');
  });
});
