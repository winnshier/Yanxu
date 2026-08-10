import { useState } from 'react';
import { Button, Checkbox, Segmented, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';
import { TaskTrack } from '../components/TaskTrack.js';
import { CreateTaskModal } from '../components/CreateTaskModal.js';

type TaskGroup = '全部' | '需要处理' | '运行中' | '暂停 / 等待' | '已交付';

function inGroup(task: Task, group: TaskGroup): boolean {
  if (group === '全部') return true;
  if (group === '需要处理') return ['WAITING_PLAN_APPROVAL', 'WAITING_APPROVAL', 'WAITING_REAPPROVAL', 'BLOCKED', 'REOPENED'].includes(task.status);
  if (group === '运行中') return ['COMPOSING_PLAN', 'PREPARING', 'QUEUED', 'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING'].includes(task.status);
  if (group === '暂停 / 等待') return ['PAUSED', 'STOPPED'].includes(task.status);
  return task.status === 'DELIVERED';
}

export function TasksPage() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<TaskGroup>('全部');
  const [archived, setArchived] = useState(false);
  const tasks = useQuery({ queryKey: ['tasks', archived], queryFn: () => api.tasks(archived), refetchInterval: 10_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const filtered = (tasks.data ?? []).filter((task) => inGroup(task, group));
  return (
    <div className="page-container tasks-page">
      <PageHeader eyebrow="执行看板" title="任务" description="每条任务按实际 WorkUnit 展开，当前、已完成和后续工作一眼可见。" actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建任务</Button>} />
      <section className="module-table task-library" aria-label="任务执行列表">
        <div className="module-toolbar toolbar-split">
          <Segmented value={group} onChange={(value) => setGroup(value as TaskGroup)} options={['全部', '需要处理', '运行中', '暂停 / 等待', '已交付']} />
          <Space><Typography.Text type="secondary">{filtered.length} 条任务</Typography.Text><Checkbox checked={archived} onChange={(event) => setArchived(event.target.checked)}>包含已归档 / 已废弃</Checkbox></Space>
        </div>
        <div className="task-list-header" aria-hidden="true"><span>任务</span><span>执行流程</span><span>当前运行</span><span>状态</span></div>
        <QueryState loading={tasks.isLoading} error={tasks.error} empty={filtered.length === 0} emptyText="当前筛选下没有任务。" onRetry={() => { void tasks.refetch(); }}>
          <Space direction="vertical" size={0} className="full-width task-list">{filtered.map((task) => <TaskTrack key={task.id} task={task} />)}</Space>
        </QueryState>
      </section>
      <CreateTaskModal open={open} projects={projects.data ?? []} teams={teams.data ?? []} onClose={() => setOpen(false)} onCreated={(id) => { void navigate(`/tasks/${id}`); }} />
    </div>
  );
}
