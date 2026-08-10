import { useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Input, Segmented, Select, Space, Spin, Tag, Timeline, Typography, message } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { ExecutionRun, WorkflowEvent } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';

type EventFilter = 'all' | 'status' | 'thinking' | 'text' | 'tool' | 'error';

const statusColors: Record<ExecutionRun['status'], string> = {
  preparing: 'gold',
  running: 'processing',
  succeeded: 'green',
  failed: 'red',
  interrupted: 'orange',
  stopped: 'default',
};

function eventKind(event: WorkflowEvent): EventFilter {
  const kind = typeof event.payload.kind === 'string' ? event.payload.kind : '';
  if (kind === 'tool_call' || kind === 'tool_result') return 'tool';
  if (kind === 'thinking') return 'thinking';
  if (kind === 'text' || kind === 'log') return 'text';
  if (kind === 'error' || event.type.includes('failed')) return 'error';
  return 'status';
}

function durationLabel(startedAt: string, endedAt: string | null): string {
  const milliseconds = Math.max(0, new Date(endedAt ?? Date.now()).getTime() - new Date(startedAt).getTime());
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor(milliseconds % 60_000 / 1_000)}s`;
}

function eventOffset(startedAt: string, occurredAt: string): string {
  const milliseconds = Math.max(0, new Date(occurredAt).getTime() - new Date(startedAt).getTime());
  return `+${(milliseconds / 1_000).toFixed(1)}s`;
}

export function RunDetailPage() {
  const { taskId = '', runId = '' } = useParams();
  const [filter, setFilter] = useState<EventFilter>('all');
  const [sort, setSort] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const run = useQuery({
    queryKey: ['task-run', taskId, runId],
    queryFn: () => api.taskRun(taskId, runId),
    enabled: Boolean(taskId && runId),
    refetchInterval: (query) => ['preparing', 'running'].includes(query.state.data?.status ?? '') ? 2_000 : false,
  });
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId), enabled: Boolean(taskId) });
  const events = useQuery({
    queryKey: ['task-run-events', taskId, runId],
    queryFn: () => api.taskRunEvents(taskId, runId),
    enabled: Boolean(taskId && runId),
    refetchInterval: ['preparing', 'running'].includes(run.data?.status ?? '') ? 2_000 : false,
  });
  const runtimeLog = useQuery({
    queryKey: ['task-run-log', taskId, runId],
    queryFn: () => api.taskRunLog(taskId, runId),
    enabled: Boolean(taskId && runId),
    refetchInterval: ['preparing', 'running'].includes(run.data?.status ?? '') ? 3_000 : false,
  });
  const evidence = useQuery({
    queryKey: ['task-evidence', taskId],
    queryFn: () => api.taskEvidence(taskId),
    enabled: Boolean(taskId),
    refetchInterval: ['preparing', 'running'].includes(run.data?.status ?? '') ? 3_000 : false,
  });
  const taskRuns = useQuery({ queryKey: ['task-runs', taskId], queryFn: () => api.taskRuns(taskId), enabled: Boolean(taskId) });
  const nextRunStartedAt = (taskRuns.data ?? [])
    .filter((item) => item.startedAt > (run.data?.startedAt ?? '') && item.id !== runId)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0]?.startedAt;
  const runChanges = (evidence.data?.changeManifests ?? []).filter((manifest) =>
    manifest.stepId === run.data?.stepId && manifest.attempt === run.data?.attempt);
  const runGates = (evidence.data?.gateAttempts ?? []).filter((gate) =>
    gate.startedAt >= (run.data?.completedAt ?? run.data?.startedAt ?? '')
      && (!nextRunStartedAt || gate.startedAt < nextRunStartedAt));
  const visibleEvents = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const selected = (events.data ?? []).filter((event) => {
      if (filter !== 'all' && eventKind(event) !== filter) return false;
      if (!normalizedSearch) return true;
      return `${event.type}\n${event.message}\n${JSON.stringify(event.payload)}`.toLowerCase().includes(normalizedSearch);
    });
    return selected.sort((left, right) => sort === 'asc'
      ? left.occurredAt.localeCompare(right.occurredAt)
      : right.occurredAt.localeCompare(left.occurredAt));
  }, [events.data, filter, search, sort]);
  const refresh = () => { void Promise.all([run.refetch(), task.refetch(), events.refetch(), runtimeLog.refetch(), evidence.refetch(), taskRuns.refetch()]); };
  const copyRun = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ run: run.data, events: events.data ?? [] }, null, 2));
    message.success('Run 证据已复制');
  };

  return <div className="page-container run-detail-page">
    <PageHeader
      eyebrow="运行证据"
      title={task.data ? `${task.data.title} · Run` : '独立 Run 证据'}
      description="按时间查看一次真实 CLI 调用的会话、事件、工具活动、失败定位与恢复关系。"
      actions={<Space wrap>
        <Link to={`/tasks/${taskId}`}><Button icon={<ArrowLeftOutlined />}>返回任务</Button></Link>
        <Button icon={<CopyOutlined />} disabled={!run.data} onClick={() => { void copyRun(); }}>复制证据</Button>
        <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
      </Space>}
    />
    <QueryState loading={run.isLoading} error={run.error} onRetry={() => { void run.refetch(); }}>
      {run.data && <div className="run-layout">
        <main className="run-main">
          {run.data.failureMessage && <Alert
            type="error"
            showIcon
            title={run.data.failureCode ? `${run.data.failureCode} · ${run.data.failureCategory ?? '未分类'}` : '本次运行失败'}
            description={<Space orientation="vertical" size={2}>
              <Typography.Text>{run.data.failureMessage}</Typography.Text>
              {run.data.nextAction && <Typography.Text strong>下一步：{run.data.nextAction}</Typography.Text>}
            </Space>}
          />}
          <Card title={`事件 · ${visibleEvents.length}/${events.data?.length ?? 0}`} extra={events.isFetching ? <Spin size="small" /> : null}>
            <div className="run-event-toolbar">
              <Segmented<EventFilter>
                value={filter}
                onChange={setFilter}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '状态', value: 'status' },
                  { label: '思考', value: 'thinking' },
                  { label: '文本', value: 'text' },
                  { label: '工具', value: 'tool' },
                  { label: '错误', value: 'error' },
                ]}
              />
              <Input.Search allowClear value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选事件内容" />
              <Select value={sort} onChange={setSort} options={[{ label: '时间正序', value: 'asc' }, { label: '时间倒序', value: 'desc' }]} />
            </div>
            {visibleEvents.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下没有事件" /> : <Timeline
              className="run-event-timeline"
              items={visibleEvents.map((event) => {
                const kind = eventKind(event);
                return {
                  key: event.id,
                  color: kind === 'error' ? 'red' : kind === 'tool' ? 'purple' : kind === 'thinking' ? 'blue' : 'gray',
                  content: <article className="run-event">
                    <div className="run-event-heading">
                      <Space size={6} wrap><Tag>{kind}</Tag><Typography.Text strong>{event.message}</Typography.Text></Space>
                      <Typography.Text type="secondary" className="mono-text">{eventOffset(run.data.startedAt, event.occurredAt)} · {new Date(event.occurredAt).toLocaleTimeString()}</Typography.Text>
                    </div>
                    <Typography.Text type="secondary" className="mono-text">{event.type} · {event.actorType}</Typography.Text>
                    {Object.keys(event.payload).length > 1 && <pre className="run-event-payload">{JSON.stringify(event.payload, null, 2)}</pre>}
                  </article>,
                };
              })}
            />}
          </Card>
          <Card title="本次 Run 事件日志" extra={<Typography.Text type="secondary">仅包含本次 CLI 调用的 JSONL 事件</Typography.Text>}>
            {runtimeLog.isLoading ? <Spin /> : runtimeLog.error ? <Alert type="warning" showIcon title="日志暂不可用" description={runtimeLog.error.message} />
              : runtimeLog.data?.content ? <pre className="runtime-log run-viewer-log">{runtimeLog.data.content}</pre>
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无 Runtime 日志" />}
          </Card>
          <div className="detail-grid">
            <Card title={`变更清单 · ${runChanges.length}`}>
              {runChanges.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次 Run 没有记录文件变更" /> : <Space orientation="vertical" className="full-width">
                {runChanges.map((manifest) => <div key={manifest.id}>
                  <Space wrap><Tag>{manifest.directoryId}</Tag><Typography.Text className="mono-text">{manifest.baseCommit.slice(0, 10)} → {manifest.checkpointCommit.slice(0, 10)}</Typography.Text></Space>
                  <div>{manifest.files.map((file) => `${file.status} ${file.path}`).join('、') || '无文件变化'}</div>
                </div>)}
              </Space>}
            </Card>
            <Card title={`后续确定性门禁 · ${runGates.length}`}>
              {runGates.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次 Run 后尚无归属明确的门禁记录" /> : <Space orientation="vertical" className="full-width">
                {runGates.map((gate) => <div key={gate.id}>
                  <Space wrap><Tag color={gate.status === 'passed' ? 'green' : 'red'}>{gate.status}</Tag><Typography.Text className="mono-text">{gate.commandArgv.join(' ')}</Typography.Text></Space>
                  <Typography.Text type="secondary">退出码 {gate.exitCode ?? '—'} · {new Date(gate.completedAt).toLocaleString()}</Typography.Text>
                </div>)}
              </Space>}
            </Card>
          </div>
        </main>
        <aside className="run-context">
          <Card title="本次运行" className="run-context-card">
            <Space orientation="vertical" size={12} className="full-width">
              <Space wrap><Tag color={statusColors[run.data.status]}>{run.data.status}</Tag><Tag>{run.data.triggerSource}</Tag><Tag>{run.data.phase}</Tag></Space>
              <Descriptions column={1} size="small" items={[
                { key: 'id', label: 'Run ID', children: <Typography.Text copyable className="mono-text">{run.data.id}</Typography.Text> },
                { key: 'duration', label: '耗时', children: durationLabel(run.data.startedAt, run.data.completedAt) },
                { key: 'started', label: '开始', children: new Date(run.data.startedAt).toLocaleString() },
                { key: 'heartbeat', label: '最近活动', children: new Date(run.data.heartbeatAt ?? run.data.startedAt).toLocaleString() },
                { key: 'agent', label: '人员实例', children: <Typography.Text className="mono-text">{run.data.agentId}</Typography.Text> },
                { key: 'agentName', label: '人员', children: run.data.agentName ?? '—' },
                { key: 'step', label: '执行单元', children: `${run.data.stepTitle} · 第 ${run.data.attempt} 次` },
                { key: 'executor', label: '执行器 / 模型', children: `${run.data.executor} / ${run.data.model}` },
                { key: 'session', label: 'CLI Session', children: <Typography.Text copyable className="mono-text">{run.data.externalSessionId ?? '尚未建立'}</Typography.Text> },
                { key: 'workspace', label: '工作区', children: run.data.workspaceReused ? '复用现有隔离现场' : '新准备隔离现场' },
                { key: 'sessionMode', label: '会话', children: run.data.sessionReused ? '恢复原 Session' : '新建 Session' },
              ]} />
            </Space>
          </Card>
          <Card title="恢复与下一步" className="run-context-card">
            <Space orientation="vertical" size={10} className="full-width">
              {run.data.retryOfRunId ? <>
                <Typography.Text type="secondary">本次运行由上一 Run 重试产生</Typography.Text>
                <Link to={`/tasks/${taskId}/runs/${run.data.retryOfRunId}`}>查看上一 Run · {run.data.retryOfRunId.slice(-10)}</Link>
              </> : <Typography.Text type="secondary">这是当前执行单元的首个 Run。</Typography.Text>}
              {run.data.sessionInvalidationReason && <Alert type="warning" showIcon title="原 Session 已失效" description={run.data.sessionInvalidationReason} />}
              <Typography.Text>{run.data.nextAction ?? (run.data.status === 'succeeded' ? 'Run 已完成，继续按任务计划推进。' : '等待当前运行产生下一步决定。')}</Typography.Text>
            </Space>
          </Card>
          <Card title="文件与现场" className="run-context-card">
            <Descriptions column={1} size="small" items={[
              { key: 'runtime', label: 'Runtime 目录', children: <Typography.Text copyable className="mono-text">{run.data.runtimeDirectory ?? '—'}</Typography.Text> },
              { key: 'result', label: '结果证据', children: <Typography.Text copyable className="mono-text">{run.data.resultPath ?? '—'}</Typography.Text> },
            ]} />
            {run.data.workspaces.map((workspace) => <Card key={workspace.directoryId} size="small" className="run-workspace-card">
              <Typography.Text strong>{workspace.directoryId}</Typography.Text>
              <Descriptions column={1} size="small" items={[
                { key: 'path', label: '隔离路径', children: <Typography.Text copyable className="mono-text">{workspace.scopePath}</Typography.Text> },
                { key: 'branch', label: '分支', children: `${workspace.taskBranch} → ${workspace.targetBranch}` },
                { key: 'commit', label: '基线', children: <Typography.Text copyable className="mono-text">{workspace.baselineCommit}</Typography.Text> },
              ]} />
            </Card>)}
          </Card>
        </aside>
      </div>}
    </QueryState>
  </div>;
}
