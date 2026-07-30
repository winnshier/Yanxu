import type { TaskStatus } from '@yanxu/contracts';
import { DomainError } from './errors.js';

export type TaskCommand = 'submit' | 'confirm' | 'pause' | 'resume' | 'stop' | 'cancel' | 'self_merge' | 'merge' | 'reopen';

const transitions: Record<TaskCommand, Partial<Record<TaskStatus, TaskStatus>>> = {
  submit: { DRAFT: 'COMPOSING_PLAN', REOPENED: 'COMPOSING_PLAN' },
  confirm: { WAITING_PLAN_APPROVAL: 'PREPARING', WAITING_REAPPROVAL: 'PREPARING' },
  pause: { PREPARING: 'PAUSED', QUEUED: 'PAUSED', RUNNING: 'PAUSED', VALIDATING: 'PAUSED', RETRYING: 'PAUSED', REPLANNING: 'PAUSED' },
  resume: { PAUSED: 'QUEUED', STOPPED: 'QUEUED', BLOCKED: 'QUEUED' },
  stop: {
    COMPOSING_PLAN: 'STOPPED',
    WAITING_PLAN_APPROVAL: 'STOPPED',
    PREPARING: 'STOPPED',
    QUEUED: 'STOPPED',
    RUNNING: 'STOPPED',
    VALIDATING: 'STOPPED',
    RETRYING: 'STOPPED',
    REPLANNING: 'STOPPED',
    WAITING_APPROVAL: 'STOPPED',
    WAITING_REAPPROVAL: 'STOPPED',
    PAUSED: 'STOPPED',
  },
  cancel: {
    DRAFT: 'CANCELLED',
    WAITING_PLAN_APPROVAL: 'CANCELLED',
    WAITING_REAPPROVAL: 'CANCELLED',
    BLOCKED: 'CANCELLED',
    STOPPED: 'CANCELLED',
    DELIVERED: 'CANCELLED',
    REOPENED: 'CANCELLED',
  },
  self_merge: { DELIVERED: 'ARCHIVED' },
  merge: { DELIVERED: 'ARCHIVED' },
  reopen: { DELIVERED: 'REOPENED', ARCHIVED: 'REOPENED', CANCELLED: 'REOPENED' },
};

export function transitionTask(current: TaskStatus, command: TaskCommand): TaskStatus {
  const next = transitions[command][current];
  if (!next) {
    throw new DomainError('INVALID_TRANSITION', `任务状态 ${current} 不允许执行 ${command}。`, 409, { current, command });
  }
  return next;
}
