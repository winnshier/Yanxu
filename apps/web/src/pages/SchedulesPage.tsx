import { useMemo, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CreateScheduleInput, ScheduleDefinition } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';

type ScheduleDraft = Omit<CreateScheduleInput, 'startAt'> & { startAt: string };

function defaultLocalStart(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTime(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleDefinition | null>(null);
  const [selected, setSelected] = useState<ScheduleDefinition | null>(null);
  const [form] = Form.useForm<ScheduleDraft>();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api.schedules() });
  const tasks = useQuery({ queryKey: ['tasks', 'schedule-sources'], queryFn: () => api.tasks(true) });
  const occurrences = useQuery({
    queryKey: ['schedule-occurrences', selected?.id],
    queryFn: () => api.scheduleOccurrences(selected?.id ?? ''),
    enabled: Boolean(selected),
    refetchInterval: selected ? 5_000 : false,
  });
  const sourceTasks = useMemo(() => (tasks.data ?? []).filter((task) => Boolean(task.plan?.confirmedAt && task.snapshot)), [tasks.data]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    if (selected) void queryClient.invalidateQueries({ queryKey: ['schedule-occurrences', selected.id] });
  };
  const create = useMutation({
    mutationFn: (values: ScheduleDraft) => api.createSchedule({
      ...values,
      startAt: new Date(values.startAt).toISOString(),
      ...(values.triggerType === 'interval'
        ? { intervalValue: values.intervalValue ?? 1, intervalUnit: values.intervalUnit ?? 'day' }
        : {}),
    }),
    onSuccess: () => {
      setCreateOpen(false);
      form.resetFields();
      refresh();
      message.success('定时任务已创建');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const update = useMutation({
    mutationFn: ({ schedule, values }: { schedule: ScheduleDefinition; values: ScheduleDraft }) => {
      const {
        sourceTaskId,
        intervalValue,
        intervalUnit,
        ...editable
      } = values;
      if (sourceTaskId !== schedule.sourceTaskId) throw new Error('编辑定时任务时不能更换确认来源。');
      return api.updateSchedule(schedule.id, {
        ...editable,
        startAt: new Date(values.startAt).toISOString(),
        ...(values.triggerType === 'interval'
          ? { intervalValue: intervalValue ?? 1, intervalUnit: intervalUnit ?? 'day' }
          : {}),
      });
    },
    onSuccess: () => {
      setCreateOpen(false);
      setEditing(null);
      form.resetFields();
      refresh();
      message.success('定时任务已更新，历史触发记录未改变');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setScheduleEnabled(id, enabled),
    onSuccess: refresh,
    onError: (error: Error) => message.error(error.message),
  });
  const runNow = useMutation({
    mutationFn: api.runScheduleNow,
    onSuccess: () => { refresh(); message.success('已创建一次独立触发记录'); },
    onError: (error: Error) => message.error(error.message),
  });
  const archive = useMutation({
    mutationFn: api.archiveSchedule,
    onSuccess: () => { setSelected(null); refresh(); message.success('定时定义已删除，历史任务与运行证据保留'); },
    onError: (error: Error) => message.error(error.message),
  });
  const triggerType = Form.useWatch('triggerType', form);
  return <div className="page-container schedules-page">
    <PageHeader
      eyebrow="统一触发"
      title="定时任务"
      description="定时只负责触发；每次执行仍创建独立 Task、RuntimeSnapshot、Run、门禁和交付证据。"
      actions={<Button type="primary" icon={<PlusOutlined />} disabled={sourceTasks.length === 0} onClick={() => {
        setEditing(null);
        form.resetFields();
        form.setFieldsValue({
          mode: 'auto_execute', triggerType: 'once', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          startAt: defaultLocalStart(), missedPolicy: 'catch_up_once', overlapPolicy: 'coalesce', intervalValue: 1, intervalUnit: 'day',
        });
        setCreateOpen(true);
      }}>创建定时任务</Button>}
    />
    {sourceTasks.length === 0 && <Alert type="info" showIcon message="先完成一次人工确认" description="定时定义必须从已经确认并形成运行快照的任务创建，复用的是边界，不是旧代码基准。" />}
    <QueryState loading={schedules.isLoading} error={schedules.error} onRetry={() => { void schedules.refetch(); }}>
      {(schedules.data?.length ?? 0) === 0 ? <Empty description="还没有定时任务" /> : <section className="module-table schedule-library" aria-label="定时任务列表">
        <div className="schedule-list-header" aria-hidden="true"><span>定时任务</span><span>项目与确认来源</span><span>触发计划</span><span>状态</span><span>操作</span></div>
        <div className="schedule-list">
          {(schedules.data ?? []).map((schedule) => <article key={schedule.id} className="schedule-list-row">
            <div className="schedule-identity">
              <Space size={6} wrap><Typography.Text strong>{schedule.name}</Typography.Text><Tag variant="filled" color={schedule.mode === 'auto_execute' ? 'purple' : schedule.mode === 'report' ? 'blue' : 'gold'}>{schedule.mode}</Tag></Space>
              <Typography.Text type="secondary" ellipsis title={schedule.description}>{schedule.description || '暂无运行说明'}</Typography.Text>
            </div>
            <div className="schedule-scope">
              <Typography.Text>{schedule.projectName} · {schedule.teamName}</Typography.Text>
              <Link to={`/tasks/${schedule.sourceTaskId}`}>{schedule.sourceTaskTitle}</Link>
            </div>
            <div className="schedule-trigger">
              <Typography.Text>{schedule.triggerType === 'once' ? '一次性' : `每 ${schedule.intervalValue} ${schedule.intervalUnit}`}</Typography.Text>
              <Typography.Text type="secondary">{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : schedule.enabled ? '等待计算' : '已暂停或已触发'}</Typography.Text>
              <Typography.Text type="secondary">{schedule.timezone}</Typography.Text>
            </div>
            <div className="schedule-state"><Switch size="small" checked={schedule.enabled} loading={toggle.isPending} onChange={(enabled) => toggle.mutate({ id: schedule.id, enabled })} /><Typography.Text type="secondary">{schedule.enabled ? '已启用' : '已暂停'}</Typography.Text></div>
            <Space size={4} className="schedule-actions">
              <Button type="text" icon={<PlayCircleOutlined />} loading={runNow.isPending} onClick={() => runNow.mutate(schedule.id)}>执行</Button>
              <Button type="text" icon={<EditOutlined />} onClick={() => {
                setEditing(schedule);
                form.setFieldsValue({
                  sourceTaskId: schedule.sourceTaskId,
                  name: schedule.name,
                  description: schedule.description,
                  mode: schedule.mode,
                  triggerType: schedule.triggerType,
                  timezone: schedule.timezone,
                  startAt: localDateTime(schedule.startAt),
                  intervalValue: schedule.intervalValue ?? 1,
                  intervalUnit: schedule.intervalUnit ?? 'day',
                  missedPolicy: schedule.missedPolicy,
                  overlapPolicy: schedule.overlapPolicy,
                });
                setCreateOpen(true);
              }}>编辑</Button>
              <Button type="text" icon={<HistoryOutlined />} onClick={() => setSelected(schedule)}>历史</Button>
              <Popconfirm title="删除这个定时定义？" description="已产生的任务与运行历史不会删除。" onConfirm={() => archive.mutate(schedule.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${schedule.name}`} />
              </Popconfirm>
            </Space>
          </article>)}
        </div>
      </section>}
    </QueryState>
    <Modal
      open={createOpen}
      width={1080}
      className="schedule-editor-modal"
      title={editing ? '编辑定时任务' : '创建定时任务'}
      okText={editing ? '保存修改' : '保存触发定义'}
      cancelText="取消"
      confirmLoading={create.isPending || update.isPending}
      onCancel={() => { setCreateOpen(false); setEditing(null); form.resetFields(); }}
      onOk={() => { void form.validateFields().then((values) => {
        if (editing) update.mutate({ schedule: editing, values });
        else create.mutate(values);
      }).catch(() => undefined); }}
    >
      <Form form={form} layout="vertical">
        <div className="schedule-editor-grid">
          <section className="schedule-runbook-pane">
            <div className="editor-section-label">任务说明与确认边界</div>
            <Form.Item name="name" label="定时任务名称" rules={[{ required: true }]}><Input size="large" placeholder="例如：每天检查项目测试状态" /></Form.Item>
            <Form.Item name="description" label="每次运行交给 Agent 的说明"><Input.TextArea rows={11} placeholder="说明需要检查什么、如何组织结果，以及没有发现问题时如何报告。" /></Form.Item>
            <Form.Item name="sourceTaskId" label="已确认任务" rules={[{ required: true }]}>
              <Select disabled={Boolean(editing)} showSearch optionFilterProp="label" options={sourceTasks.map((task) => ({ value: task.id, label: `${task.projectName} · ${task.title}` }))} />
            </Form.Item>
            <Alert type="info" showIcon message="不会自动合并目标分支、推送远程或部署" />
          </section>
          <aside className="schedule-trigger-pane">
            <div className="editor-section-label">触发与执行</div>
            <Form.Item name="mode" label="执行模式" rules={[{ required: true }]}><Select options={[
              { value: 'report', label: '仅报告（来源任务必须全部只读）' },
              { value: 'discover', label: '先只读发现；有结果再进入计划确认' },
              { value: 'auto_execute', label: '已确认边界内自动执行' },
            ]} /></Form.Item>
            <Form.Item name="triggerType" label="触发类型"><Select options={[{ value: 'once', label: '一次性' }, { value: 'interval', label: '周期' }]} /></Form.Item>
            <Form.Item name="startAt" label="首次运行" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
            <Form.Item name="timezone" label="时区" rules={[{ required: true }]}><Input /></Form.Item>
            {triggerType === 'interval' && <div className="form-grid-two">
              <Form.Item name="intervalValue" label="周期数"><InputNumber min={1} max={365} className="full-width" /></Form.Item>
              <Form.Item name="intervalUnit" label="周期单位"><Select options={[{ value: 'hour', label: '小时' }, { value: 'day', label: '天' }, { value: 'week', label: '周' }]} /></Form.Item>
            </div>}
            <Form.Item name="missedPolicy" label="休眠/关机错过"><Select options={[{ value: 'catch_up_once', label: '恢复后补跑一次' }, { value: 'skip', label: '跳过错过时间' }]} /></Form.Item>
            <Form.Item name="overlapPolicy" label="上次未完成"><Select options={[{ value: 'coalesce', label: '合并为一次机会' }, { value: 'skip', label: '跳过本次' }]} /></Form.Item>
          </aside>
        </div>
      </Form>
    </Modal>
    <Modal open={Boolean(selected)} title={selected ? `${selected.name} · 触发历史` : '触发历史'} footer={null} width={780} onCancel={() => setSelected(null)}>
      <List
        loading={occurrences.isLoading}
        dataSource={occurrences.data ?? []}
        locale={{ emptyText: '尚未触发' }}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item extra={item.taskId ? <Link to={`/tasks/${item.taskId}`}>查看任务</Link> : null}>
          <List.Item.Meta
            title={<Space><Tag color={item.status === 'completed' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'awaiting_confirmation' ? 'gold' : 'blue'}>{item.status}</Tag><Typography.Text>{new Date(item.plannedAt).toLocaleString()}</Typography.Text></Space>}
            description={item.reason ?? '按计划触发'}
          />
        </List.Item>}
      />
    </Modal>
  </div>;
}
