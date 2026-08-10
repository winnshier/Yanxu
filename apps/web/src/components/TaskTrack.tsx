import { CheckOutlined, ClockCircleOutlined, LoadingOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { Task, TaskStep } from '@yanxu/contracts';
import { TaskStatusTag } from './TaskStatusTag.js';

interface TaskTrackProps {
  task: Task;
  compact?: boolean;
}

function renderStepIcon(step: TaskStep) {
  if (step.status === 'succeeded') return <CheckOutlined />;
  if (step.status === 'running') return <LoadingOutlined />;
  if (step.status === 'failed') return <StopOutlined />;
  return <ClockCircleOutlined />;
}

function elapsedLabel(startedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function TaskTrack({ task, compact = false }: TaskTrackProps) {
  const navigate = useNavigate();
  const activeStep = task.steps.find((step) => step.status === 'running');
  const execution = task.activeExecution;
  const completedSteps = task.steps.filter((step) => step.status === 'succeeded').length;
  return (
    <article className={`task-track ${compact ? 'task-track-compact' : ''}`}>
      <div className="task-track-identity">
        <div className="task-track-title">
          <Typography.Text className="task-project">{task.projectName}</Typography.Text>
          <Typography.Title level={5}>{task.title}</Typography.Title>
          <Space size={[4, 4]} wrap>
            {task.triggerSource !== 'manual' && <Tag variant="filled" color="purple">{task.triggerSource === 'schedule' ? '定时触发' : task.triggerSource}</Tag>}
            {execution?.agentName && <Tag variant="filled">{execution.agentName}</Tag>}
            {execution?.executor && <Tag variant="filled">{execution.executor}</Tag>}
          </Space>
        </div>
      </div>
      <div className="task-track-flow">
        <div className="task-track-progress-line">
          <Typography.Text>{activeStep ? `当前：${activeStep.title}` : task.steps.length ? `${completedSteps}/${task.steps.length} 个环节完成` : '等待生成计划'}</Typography.Text>
          <Typography.Text type="secondary">{task.progress}%</Typography.Text>
        </div>
        <Progress percent={task.progress} showInfo={false} size="small" />
      </div>
      {task.steps.length > 0 ? (
        <div className="step-line" aria-label={`任务进度 ${task.progress}%`}>
          {task.steps.map((step, index) => (
            <Tooltip key={step.id} title={step.description}>
              <div className={`step-node step-${step.status}`}>
                <span className="step-dot">{renderStepIcon(step)}</span>
                <span className="step-label">{step.title}</span>
                {index < task.steps.length - 1 && <span className="step-connector" />}
              </div>
            </Tooltip>
          ))}
        </div>
      ) : (
        <Typography.Text type="secondary">尚未生成执行计划</Typography.Text>
      )}
      <div className="task-track-runtime">
        {(activeStep || execution) && <Space size={[6, 4]} wrap className="task-runtime-meta">
          {execution?.phase && <Tag variant="filled" color="blue">阶段：{execution.phase}</Tag>}
          {execution?.model && <Typography.Text type="secondary" className="mono-text">{execution.model}</Typography.Text>}
          {execution?.startedAt && <Typography.Text type="secondary">已运行 {elapsedLabel(execution.startedAt)}</Typography.Text>}
          {execution?.heartbeatAt && <Typography.Text type="secondary">心跳 {new Date(execution.heartbeatAt).toLocaleTimeString()}</Typography.Text>}
          {execution?.nextAction && <Typography.Text>下一步：{execution.nextAction}</Typography.Text>}
        </Space>}
        {task.status === 'QUEUED' && <Space size={[6, 4]} wrap className="task-runtime-meta">
          <Tag variant="filled" color="gold">排队第 {task.queuePosition ?? '?'} 位</Tag>
          <Typography.Text type="secondary">等待并发槽位或前置调度完成</Typography.Text>
        </Space>}
        {['WAITING_PLAN_APPROVAL', 'WAITING_APPROVAL', 'WAITING_REAPPROVAL', 'BLOCKED', 'PAUSED', 'STOPPED', 'RETRYING', 'REPLANNING'].includes(task.status)
          && task.statusReason && <div className="task-status-reason">
            <Typography.Text strong>{task.statusReason.message}</Typography.Text>
            <Typography.Text type="secondary">{execution?.nextAction ? `下一步：${execution.nextAction}` : '打开任务详情处理当前状态'}</Typography.Text>
          </div>}
      </div>
      <div className="task-track-actions">
        <TaskStatusTag status={task.status} />
        <Button type="text" onClick={() => { void navigate(`/tasks/${task.id}`); }}>查看详情</Button>
      </div>
    </article>
  );
}
