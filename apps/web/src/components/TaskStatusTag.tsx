import { Tag } from 'antd';
import type { TaskStatus } from '@yanxu/contracts';

const labels: Record<TaskStatus, string> = {
  DRAFT: '草稿', COMPOSING_PLAN: '生成计划', WAITING_PLAN_APPROVAL: '待确认计划', PREPARING: '准备工作区', QUEUED: '排队中',
  RUNNING: '执行中', VALIDATING: '质量验证', RETRYING: '自动重试', REPLANNING: '重新规划', WAITING_APPROVAL: '等待批准',
  WAITING_REAPPROVAL: '待重新确认', PAUSED: '已暂停', BLOCKED: '已阻塞', STOPPED: '已停止', DELIVERED: '待交付确认',
  ARCHIVED: '已归档', REOPENED: '已重新打开',
};

const colors: Partial<Record<TaskStatus, string>> = {
  RUNNING: 'processing', VALIDATING: 'cyan', DELIVERED: 'success', ARCHIVED: 'default', BLOCKED: 'error', STOPPED: 'default',
  WAITING_PLAN_APPROVAL: 'warning', WAITING_APPROVAL: 'warning', WAITING_REAPPROVAL: 'warning', PAUSED: 'gold', RETRYING: 'orange', REPLANNING: 'purple',
};

interface TaskStatusTagProps {
  status: TaskStatus;
}

export function TaskStatusTag({ status }: TaskStatusTagProps) {
  return <Tag color={colors[status] ?? 'blue'} bordered={false}>{labels[status]}</Tag>;
}
