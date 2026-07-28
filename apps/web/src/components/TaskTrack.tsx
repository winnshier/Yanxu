import { CheckOutlined, ClockCircleOutlined, LoadingOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
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
  return (
    <article className={`task-track ${compact ? 'task-track-compact' : ''}`}>
      <div className="task-track-head">
        <div>
          <Typography.Text className="task-project">{task.projectName}</Typography.Text>
          <Typography.Title level={5}>{task.title}</Typography.Title>
        </div>
        <div className="task-track-actions">
          <TaskStatusTag status={task.status} />
          <Button type="text" onClick={() => { void navigate(`/tasks/${task.id}`); }}>查看详情</Button>
        </div>
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
      {(activeStep || execution) && <Space size={[6, 4]} wrap className="task-runtime-meta">
        {activeStep && <Tag color="processing">当前：{activeStep.title}</Tag>}
        {execution?.agentName && <Tag>{execution.agentName}</Tag>}
        {execution?.executor && <Tag>{execution.executor}</Tag>}
        {execution?.model && <Typography.Text type="secondary" className="mono-text">{execution.model}</Typography.Text>}
        {execution?.startedAt && <Typography.Text type="secondary">已运行 {elapsedLabel(execution.startedAt)}</Typography.Text>}
        {execution?.heartbeatAt && <Typography.Text type="secondary">
          心跳 {new Date(execution.heartbeatAt).toLocaleTimeString()}
        </Typography.Text>}
      </Space>}
      {task.status === 'QUEUED' && <Space size={[6, 4]} wrap className="task-runtime-meta">
        <Tag color="gold">排队第 {task.queuePosition ?? '?'} 位</Tag>
        <Typography.Text type="secondary">等待并发槽位或前置调度完成</Typography.Text>
      </Space>}
    </article>
  );
}
