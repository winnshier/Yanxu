import { useState } from 'react';
import { Badge, Button, Flex, List, Space, Typography, message } from 'antd';
import { ArrowRightOutlined, FolderAddOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';
import { TaskTrack } from '../components/TaskTrack.js';
import { TaskStatusTag } from '../components/TaskStatusTag.js';
import { CreateProjectModal } from '../components/CreateProjectModal.js';
import { CreateTaskModal } from '../components/CreateTaskModal.js';

export function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [projectModal, setProjectModal] = useState(false);
  const [taskModal, setTaskModal] = useState(false);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000, retry: 1 });
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 10_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const data = dashboard.data;
  const permissionDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'once' | 'always' | 'reject' }) => api.respondPermission(id, decision),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['dashboard'] }); message.success('权限决定已提交'); },
    onError: (error: Error) => message.error(error.message),
  });

  return (
    <div className="page-container dashboard-page">
      <PageHeader
        eyebrow="全局调度"
        title="今天要推进什么？"
        description="在一个地方确认计划、观察运行、处理阻塞并完成交付。"
        actions={<Space><Button icon={<FolderAddOutlined />} onClick={() => setProjectModal(true)}>创建项目</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setTaskModal(true)}>创建任务</Button></Space>}
      />
      <QueryState loading={dashboard.isLoading} error={dashboard.error} onRetry={() => { void dashboard.refetch(); }}>
        {data && <>
          <section className="dashboard-summary" aria-label="任务概况">
            <div><span>正在推进</span><strong>{data.counts.active}<small> / {data.settings.maxParallelTasks}</small></strong></div>
            <div><span>排队任务</span><strong>{data.counts.queued}</strong></div>
            <div className={data.counts.attention ? 'has-warning' : ''}><span>需要处理</span><strong>{data.counts.attention}</strong></div>
            <div className={data.counts.delivered ? 'has-success' : ''}><span>待交付确认</span><strong>{data.counts.delivered}</strong></div>
          </section>

          <div className="dashboard-grid">
            <section className="dashboard-main">
              <section className="workspace-section">
                <div className="workspace-section-header"><div><Typography.Text strong>正在运行与排队</Typography.Text><Typography.Text type="secondary">当前执行队列与实时进度</Typography.Text></div><Button type="link" onClick={() => { void navigate('/tasks'); }}>全部任务 <ArrowRightOutlined /></Button></div>
                <div className="workspace-section-body">
                {data.active.length ? <Space direction="vertical" size={12} className="full-width">{data.active.map((task) => <TaskTrack key={task.id} task={task} compact />)}</Space> : <div className="quiet-state">当前没有运行中的任务。</div>}
                </div>
              </section>
              <section className="workspace-section">
                <div className="workspace-section-header"><div><Typography.Text strong>已交付待确认</Typography.Text><Typography.Text type="secondary">等待人工验收的任务产出</Typography.Text></div></div>
                <div className="workspace-section-body">
                {data.delivered.length ? <Space direction="vertical" size={12} className="full-width">{data.delivered.map((task) => <TaskTrack key={task.id} task={task} compact />)}</Space> : <div className="quiet-state">还没有等待确认的交付。</div>}
                </div>
              </section>
            </section>
            <aside className="dashboard-side">
              <section className="workspace-section">
                <div className="workspace-section-header"><Space><Badge status={data.counts.attention ? 'warning' : 'success'} /><Typography.Text strong>需要我处理</Typography.Text></Space></div>
                <div className="workspace-section-body">
                {data.permissions.map((permission) => <div className="permission-card" key={permission.id}>
                  <Typography.Text strong>{permission.permission} 权限请求</Typography.Text>
                  <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>{permission.patterns.join('、')}</Typography.Paragraph>
                  <Space size="small">
                    <Button size="small" type="primary" onClick={() => permissionDecision.mutate({ id: permission.id, decision: 'once' })}>允许一次</Button>
                    <Button size="small" onClick={() => permissionDecision.mutate({ id: permission.id, decision: 'always' })}>本任务同类允许</Button>
                    <Button size="small" danger onClick={() => permissionDecision.mutate({ id: permission.id, decision: 'reject' })}>拒绝</Button>
                  </Space>
                </div>)}
                {data.systemAttention.length > 0 && <List
                  size="small"
                  dataSource={data.systemAttention}
                  rowKey={(item) => item.id}
                  renderItem={(item) => <List.Item
                    onClick={() => { void navigate(item.targetPath); }}
                    className="clickable-list-item"
                  >
                    <List.Item.Meta title={item.title} description={item.description} />
                    <TaskStatusTag status="BLOCKED" />
                  </List.Item>}
                />}
                {data.attention.length > 0 && <List dataSource={data.attention} renderItem={(task) => <List.Item onClick={() => { void navigate(`/tasks/${task.id}`); }} className="clickable-list-item"><List.Item.Meta title={task.title} description={task.projectName} /><TaskStatusTag status={task.status} /></List.Item>} />}
                {data.attention.length === 0 && data.permissions.length === 0 && data.systemAttention.length === 0
                  && <div className="quiet-state">没有待处理事项，系统会继续运行。</div>}
                </div>
              </section>
              <section className="workspace-section">
                <div className="workspace-section-header"><Typography.Text strong>系统状态</Typography.Text><Button type="link" icon={<SettingOutlined />} onClick={() => { void navigate('/settings'); }}>设置</Button></div>
                <div className="workspace-section-body">
                <Space direction="vertical" size={14} className="full-width">
                  <Flex justify="space-between"><Typography.Text type="secondary">本地调度服务</Typography.Text><Badge
                    status={health.data?.status === 'ready' ? 'success' : 'warning'}
                    text={health.data?.status === 'ready' ? `正常 · ${health.data.scheduler.activeJobs} 个执行中` : '连接中'}
                  /></Flex>
                  <Flex justify="space-between"><Typography.Text type="secondary">全局协调器</Typography.Text><Badge status={data.settings.coordinatorReady ? 'success' : 'warning'} text={data.settings.coordinatorReady ? '可用' : '待配置'} /></Flex>
                  {data.executors.map((executor) => <Flex key={executor.id} justify="space-between"><Typography.Text type="secondary">{executor.name}</Typography.Text><Badge status={executor.health === 'available' ? 'success' : 'default'} text={executor.health === 'available' ? executor.version ?? '可用' : '不可用'} /></Flex>)}
                </Space>
                </div>
              </section>
            </aside>
          </div>
        </>}
      </QueryState>
      <CreateProjectModal open={projectModal} onClose={() => setProjectModal(false)} onCreated={(id) => { void navigate(`/projects/${id}`); }} />
      <CreateTaskModal open={taskModal} projects={projects.data ?? []} teams={teams.data ?? []} onClose={() => setTaskModal(false)} onCreated={(id) => { void navigate(`/tasks/${id}`); }} />
    </div>
  );
}
