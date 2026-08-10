import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Divider, Form, Input, List, Modal, Popconfirm, Progress, Radio, Select, Space, Tabs, Tag, Timeline, Typography, message } from 'antd';
import { CheckOutlined, DeleteOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { AnswerPlanInput, ProjectCapability, RequestPlanRevisionInput, Task, TaskCommandInput, TaskDiagnostics, TaskEvidence, TaskPlan, WorkflowEvent } from '@yanxu/contracts';
import { api, ApiError } from '../lib/api.js';
import {
  buildPlanQuestionFormAnswers,
  serializePlanQuestionAnswers,
  type PlanQuestionFormAnswer,
} from '../lib/plan-questions.js';
import { PageHeader } from '../components/PageHeader.js';
import { MarkdownContent } from '../components/MarkdownContent.js';
import { QueryState } from '../components/QueryState.js';
import { TaskStatusTag } from '../components/TaskStatusTag.js';

interface PlanFormValues {
  goal: string;
  scopeText: string;
  nonScopeText: string;
  successText: string;
  permissionsText: string;
  answers: Record<string, PlanQuestionFormAnswer>;
  stepAgents: Record<string, string | null>;
  stepCapabilities: Record<string, string[]>;
  branchRoutes: Record<string, { sourceBranch: string; targetBranch: string }>;
  waivedGateIds: string[];
}

interface UpdatePlanVariables {
  values: PlanFormValues;
  action: 'save' | 'confirm' | 'replan';
  revisionFeedback?: string;
}

interface RevisionFormValues {
  feedback: string;
}

interface CorrectionFormValues {
  correction: string;
}

function commandFor(task: Task, command: TaskCommandInput['command']): TaskCommandInput {
  return { command, stateVersion: task.stateVersion };
}

function capabilitiesName(capabilityId: string, capabilities: ProjectCapability[]): string {
  return capabilities.find((item) => item.capabilityId === capabilityId)?.capability.name ?? capabilityId;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${rest} 秒`].filter(Boolean).join(' ');
}

function describePlanChanges(current: TaskPlan, previous?: TaskPlan): string[] {
  if (!previous) return ['首次生成计划'];
  const changes: string[] = [];
  if (current.goal !== previous.goal) changes.push('任务目标已调整');
  if (JSON.stringify(current.scope) !== JSON.stringify(previous.scope)
    || JSON.stringify(current.nonScope) !== JSON.stringify(previous.nonScope)
    || JSON.stringify(current.successCriteria) !== JSON.stringify(previous.successCriteria)) {
    changes.push('范围或成功标准已调整');
  }
  const stepSignature = (plan: TaskPlan) => plan.steps.map((step) => ({
    kind: step.kind,
    skillId: step.skillId,
    title: step.title,
    expectedOutput: step.expectedOutput,
    directoryIds: step.directoryIds,
    requiredCapabilities: step.requiredCapabilities,
    capabilityIds: step.capabilityIds,
    verification: step.verification,
    mode: step.mode,
    requiresIndependentSession: step.requiresIndependentSession,
  }));
  if (JSON.stringify(stepSignature(current)) !== JSON.stringify(stepSignature(previous))) changes.push('执行步骤或产出已调整');
  const routeSignature = (plan: TaskPlan) => plan.branchRoutes.map((route) => ({
    directoryId: route.directoryId,
    sourceBranch: route.sourceBranch,
    targetBranch: route.targetBranch,
  }));
  if (JSON.stringify(routeSignature(current)) !== JSON.stringify(routeSignature(previous))) changes.push('目录或分支路由已调整');
  if (JSON.stringify(current.permissions) !== JSON.stringify(previous.permissions)) changes.push('权限清单已调整');
  const waived = (plan: TaskPlan) => plan.qualityGates.filter((gate) => gate.status === 'waived').map((gate) => gate.id).sort();
  if (JSON.stringify(waived(current)) !== JSON.stringify(waived(previous))) changes.push('质量门禁豁免已调整');
  return changes.length ? changes : ['回答、人员分配或计划说明已修订'];
}

export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const queryClient = useQueryClient();
  const [planForm] = Form.useForm<PlanFormValues>();
  const [revisionForm] = Form.useForm<RevisionFormValues>();
  const [correctionForm] = Form.useForm<CorrectionFormValues>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const plans = useQuery({ queryKey: ['task-plans', taskId], queryFn: () => api.taskPlans(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const events = useQuery({ queryKey: ['task-events', taskId], queryFn: () => api.taskEvents(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const evidence = useQuery({ queryKey: ['task-evidence', taskId], queryFn: () => api.taskEvidence(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const diagnostics = useQuery({ queryKey: ['task-diagnostics', taskId], queryFn: () => api.taskDiagnostics(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const data = task.data;
  const project = useQuery({ queryKey: ['project', data?.projectId], queryFn: () => api.project(data?.projectId ?? ''), enabled: Boolean(data?.projectId) });
  const projectCapabilities = useQuery({ queryKey: ['project-capabilities', data?.projectId], queryFn: () => api.projectCapabilities(data?.projectId ?? ''), enabled: Boolean(data?.projectId) });
  const taskCapabilities = useQuery({ queryKey: ['task-capabilities', taskId], queryFn: () => api.taskCapabilities(taskId), enabled: Boolean(taskId), refetchInterval: 5_000 });
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const builtins = useQuery({ queryKey: ['builtins'], queryFn: api.builtins });

  useEffect(() => {
    if (data?.plan) {
      planForm.setFieldsValue({
        goal: data.plan.goal,
        scopeText: data.plan.scope.join('\n'),
        nonScopeText: data.plan.nonScope.join('\n'),
        successText: data.plan.successCriteria.join('\n'),
        permissionsText: data.plan.permissions.join('\n'),
        answers: buildPlanQuestionFormAnswers(data.plan.questions),
        stepAgents: Object.fromEntries(data.plan.steps.map((step) => [step.id, step.agentId])),
        stepCapabilities: Object.fromEntries(data.plan.steps.map((step) => [step.id, step.capabilityIds ?? []])),
        branchRoutes: Object.fromEntries(data.plan.branchRoutes.map((route) => [route.directoryId, {
          sourceBranch: route.sourceBranch,
          targetBranch: route.targetBranch,
        }])),
        waivedGateIds: data.plan.qualityGates.filter((gate) => gate.status === 'waived').map((gate) => gate.id),
      });
    }
  }, [data?.plan, planForm]);

  const command = useMutation({
    mutationFn: (input: TaskCommandInput) => api.taskCommand(taskId, input),
    onSuccess: (result, input) => {
      queryClient.setQueryData(['task', taskId], result);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['task-evidence', taskId] });
      if (input.command === 'reopen') {
        correctionForm.resetFields();
        setCorrectionOpen(false);
      }
      message.success('任务状态已更新');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const requestRevision = useMutation({
    mutationFn: (input: RequestPlanRevisionInput) => api.requestPlanRevision(taskId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(['task', taskId], result);
      void queryClient.invalidateQueries({ queryKey: ['task-plans', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['task-events', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      revisionForm.resetFields();
      setRevisionOpen(false);
      message.success('修改请求已提交，协调器正在生成新计划');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const updatePlan = useMutation({
    mutationFn: ({ values }: UpdatePlanVariables) => {
      if (!data?.plan) throw new Error('当前任务没有可修订计划。');
      const input: AnswerPlanInput = {
        answers: serializePlanQuestionAnswers(data.plan.questions, values.answers),
        goal: values.goal,
        scope: values.scopeText.split('\n').map((item) => item.trim()).filter(Boolean),
        nonScope: values.nonScopeText.split('\n').map((item) => item.trim()).filter(Boolean),
        successCriteria: values.successText.split('\n').map((item) => item.trim()).filter(Boolean),
        permissions: values.permissionsText.split('\n').map((item) => item.trim()).filter(Boolean),
        stepAssignments: data.plan.steps.map((step) => ({ stepId: step.id, agentId: values.stepAgents?.[step.id] || null })),
        stepCapabilities: data.plan.steps.map((step) => ({ stepId: step.id, capabilityIds: values.stepCapabilities?.[step.id] ?? [] })),
        branchRoutes: data.plan.branchRoutes.map((route) => ({
          directoryId: route.directoryId,
          sourceBranch: values.branchRoutes?.[route.directoryId]?.sourceBranch ?? route.sourceBranch,
          targetBranch: values.branchRoutes?.[route.directoryId]?.targetBranch ?? route.targetBranch,
        })),
        waivedGateIds: values.waivedGateIds ?? [],
      };
      return api.updatePlan(taskId, input);
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(['task', taskId], result);
      void queryClient.invalidateQueries({ queryKey: ['task-plans', taskId] });
      if (variables.action === 'confirm') {
        const needsAnswerReview = Boolean(
          data?.plan?.questions.length
          && !data.plan.answersReviewedAt,
        );
        if (needsAnswerReview) {
          requestRevision.mutate({
            stateVersion: result.stateVersion,
            feedback: '用户已经回答全部歧义问题。请逐项吸收答案，完善目标、范围、成功标准、执行步骤、目录、权限和质量门禁；不要重复已经解决的问题。',
            allowStepChanges: false,
          });
        } else {
          command.mutate(commandFor(result, 'confirm'));
        }
      } else if (variables.action === 'replan' && variables.revisionFeedback) {
        requestRevision.mutate({
          stateVersion: result.stateVersion,
          feedback: variables.revisionFeedback,
          allowStepChanges: true,
        });
      } else {
        message.success('计划修订已保存为新版本');
      }
    },
    onError: (error: Error) => message.error(error.message),
  });

  const planEditable = data ? ['WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL'].includes(data.status) : false;
  const executionStarted = Boolean(data?.snapshot);
  const planDirectlyEditable = planEditable && !executionStarted;
  const actions = data ? <Space wrap className="task-detail-actions">
    {['DRAFT', 'REOPENED'].includes(data.status) && <Button type="primary" icon={<PlayCircleOutlined />} loading={command.isPending} onClick={() => command.mutate(commandFor(data, 'submit'))}>提交分析</Button>}
    {planEditable && <Button icon={<ReloadOutlined />} loading={updatePlan.isPending || requestRevision.isPending} onClick={() => setRevisionOpen(true)}>请求修改</Button>}
    {planEditable && <Button
      type="primary"
      icon={<CheckOutlined />}
      loading={command.isPending || updatePlan.isPending}
      onClick={() => {
        if (executionStarted && !(data.plan?.questions.length && !data.plan.answersReviewedAt)) {
          command.mutate(commandFor(data, 'confirm'));
          return;
        }
        void planForm.validateFields()
          .then((values) => updatePlan.mutate({ values, action: 'confirm' }))
          .catch(() => undefined);
      }}
    >{data.plan?.questions.length && !data.plan.answersReviewedAt
        ? '提交回答并完善计划'
        : executionStarted ? '确认修订计划并继续' : '保存计划并启动'}</Button>}
    {['PREPARING', 'QUEUED', 'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING'].includes(data.status) && <Button icon={<PauseOutlined />} onClick={() => command.mutate(commandFor(data, 'pause'))}>暂停</Button>}
    {['PAUSED', 'STOPPED', 'BLOCKED'].includes(data.status) && <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => command.mutate(commandFor(data, 'resume'))}>恢复</Button>}
    {['DRAFT', 'WAITING_PLAN_APPROVAL', 'WAITING_REAPPROVAL', 'BLOCKED', 'STOPPED', 'DELIVERED', 'REOPENED'].includes(data.status) && <Popconfirm
      title="确认废弃这个任务？"
      description="任务会退出默认看板且不能继续恢复执行；需求、计划、日志、分支与产物仍会保留。"
      okText="确认废弃"
      cancelText="返回"
      okButtonProps={{ danger: true }}
      onConfirm={() => command.mutate(commandFor(data, 'cancel'))}
    ><Button danger icon={<DeleteOutlined />}>废弃任务</Button></Popconfirm>}
    {data.status === 'CANCELLED' && <Button icon={<ReloadOutlined />} onClick={() => setCorrectionOpen(true)}>重新打开</Button>}
    {['COMPOSING_PLAN', 'WAITING_PLAN_APPROVAL', 'PREPARING', 'QUEUED', 'RUNNING', 'VALIDATING', 'RETRYING', 'REPLANNING', 'WAITING_APPROVAL', 'WAITING_REAPPROVAL', 'PAUSED'].includes(data.status) && <Popconfirm title="立即停止并保留现场？" description="当前 Session 会终止，日志、分支和 worktree 会保留。" onConfirm={() => command.mutate(commandFor(data, 'stop'))}><Button danger icon={<StopOutlined />}>立即停止</Button></Popconfirm>}
  </Space> : null;

  const items = data ? [
    {
      key: 'overview', label: '概览', children: <div className="task-overview-document">
        <Card title="任务目标"><Typography.Paragraph>{data.description}</Typography.Paragraph><Divider /><Typography.Text strong>预期产出</Typography.Text><Typography.Paragraph type="secondary">{data.expectedOutput || '待计划阶段明确'}</Typography.Paragraph></Card>
        <Card title={`需求附件 · ${evidence.data?.attachments.length ?? 0}`}>
          <List
            size="small"
            locale={{ emptyText: '当前任务没有附件' }}
            dataSource={evidence.data?.attachments ?? []}
            rowKey={(item) => item.id}
            renderItem={(item) => <List.Item>
              <List.Item.Meta
                title={item.fileName}
                description={<Space direction="vertical" size={2}>
                  <Typography.Text type="secondary">{Math.max(1, Math.ceil(item.size / 1024))} KB · {item.contentHash.slice(0, 12)}</Typography.Text>
                  <Typography.Text type="secondary">{item.contentPreview === null ? '二进制附件已保存在 ProjectSpace，不注入模型文本上下文。' : `文本内容已${item.contentTruncated ? '截断后' : ''}纳入计划上下文。`}</Typography.Text>
                </Space>}
              />
            </List.Item>}
          />
        </Card>
      </div>,
    },
    {
      key: 'plan', label: `任务与计划${data.plan ? ` v${data.plan.version}` : ''}`, children: data.plan ? <Form form={planForm} layout="vertical" disabled={!planDirectlyEditable} onFinish={(values) => updatePlan.mutate({ values, action: 'save' })}>
        {planEditable && executionStarted && <Alert
          type="warning"
          showIcon
          message="这是执行过程中生成的修订计划"
          description="确认后会从整改步骤继续执行；如需修改目标、范围、步骤或权限，请使用“请求修改”，系统会重新规划并保留既有执行证据。"
          className="settings-card"
        />}
        <PreApprovalArtifacts
          artifacts={(evidence.data?.preApprovalArtifacts ?? []).filter((artifact) => artifact.planId === data.plan?.id)}
        />
        <Card title="目标、范围与成功标准">
          <Form.Item name="goal" label="目标" rules={[{ required: true, message: '请明确任务目标' }]}><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item>
          <Form.Item name="scopeText" label="范围（每行一项）" rules={[{ required: true, message: '请至少保留一项范围' }]}><Input.TextArea autoSize={{ minRows: 3 }} /></Form.Item>
          <Form.Item name="nonScopeText" label="非范围（每行一项）"><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item>
          <Form.Item name="successText" label="成功标准（每行一项）" rules={[{ required: true, message: '请至少保留一项成功标准' }]}><Input.TextArea autoSize={{ minRows: 3 }} /></Form.Item>
        </Card>
        {data.plan.questions.length > 0 && <Card title="需要你确认的方案" className="settings-card">
          {!data.plan.answersReviewedAt && <Alert
            type="info"
            showIcon
            message="协调器已经先给出推荐和备选方案"
            description="你可以直接选择，也可以填写自定义方案。提交后，协调器会把决定落实到目标、范围、成功标准、步骤、权限和门禁，再生成新版本供你最终确认。"
          />}
          {data.plan.questions.some((question) => !(question.options ?? []).length) && <Alert
            className="settings-card"
            type="warning"
            showIcon
            message="这个旧版计划还没有候选方案"
            description="你可以填写自定义方案，或使用页面上方“请求修改”让协调器按新规则重新生成推荐与备选方案。"
          />}
          <div className="settings-card">{data.plan.questions.map((question) => {
            const options = question.options ?? [];
            return <Card key={question.id} size="small" className="plan-question-card" title={question.question}>
              <Form.Item
                name={['answers', question.id, 'optionId']}
                rules={[{ required: true, message: '请选择一个方案或选择自定义方案' }]}
              >
                <Radio.Group className="full-width">
                  <Space direction="vertical" size={10} className="full-width">
                    {options.map((option) => <Radio key={option.id} value={option.id} className="plan-question-option">
                      <Space size={8}>
                        <Typography.Text strong>{option.label}</Typography.Text>
                        {option.recommended && <Tag color="blue">推荐</Tag>}
                      </Space>
                      <Typography.Paragraph type="secondary" className="plan-question-description">
                        {option.description}
                      </Typography.Paragraph>
                    </Radio>)}
                    <Radio value="custom" className="plan-question-option">
                      <Typography.Text strong>自定义方案</Typography.Text>
                      <Typography.Paragraph type="secondary" className="plan-question-description">
                        以上方案不合适时，输入你希望采用的处理方式。
                      </Typography.Paragraph>
                    </Radio>
                  </Space>
                </Radio.Group>
              </Form.Item>
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) => getFieldValue(['answers', question.id, 'optionId']) === 'custom'
                  ? <Form.Item
                    name={['answers', question.id, 'custom']}
                    label="你的方案"
                    rules={[{ required: true, whitespace: true, message: '请输入自定义方案' }]}
                  >
                    <Input.TextArea autoSize={{ minRows: 2 }} placeholder="说明你希望采用的方案、范围或验收方式" />
                  </Form.Item>
                  : null}
              </Form.Item>
            </Card>;
          })}</div>
        </Card>}
        <Card title="动态执行步骤" className="settings-card">
          <List className="plan-step-list" rowKey={(step) => step.id} dataSource={data.plan.steps} renderItem={(step) => {
            const team = teams.data?.find((item) => item.id === data.teamId);
            const compatibleAgents = (agents.data ?? []).filter((agent) => {
              if (!team?.memberIds.includes(agent.id)) return false;
              if (agent.status !== 'active') return false;
              if (step.kind === 'work_unit') return true;
              return builtins.data?.roles.find((role) => role.id === agent.roleId)?.skillIds.includes(step.skillId);
            });
            return <List.Item>
              <List.Item.Meta
                title={`${step.position + 1}. ${step.title}`}
                description={<Space direction="vertical" size={2}>
                  <Typography.Text type="secondary">{step.description}</Typography.Text>
                  <Typography.Text type="secondary">输入：{step.inputs.join('、') || '当前任务与上游产物'}</Typography.Text>
                  {step.kind === 'work_unit' && <Typography.Text type="secondary">能力：{step.requiredCapabilities?.join('、') || '通用项目能力'} · {step.mode === 'write' ? '可写' : '只读'}</Typography.Text>}
                  {step.kind === 'work_unit' && <Typography.Text type="secondary">验证：{step.verification?.join('；') || '对照成功标准与质量门禁'}</Typography.Text>}
                  <Typography.Text type="secondary">产出：{step.expectedOutput}</Typography.Text>
                </Space>}
              />
              <Space direction="vertical" size={4} className="plan-inline-field">
                <Form.Item name={['stepAgents', step.id]} label="执行人员" rules={[{ required: true, message: '请选择执行人员' }]}>
                  <Select
                    allowClear
                    placeholder="团队缺少可用人员"
                    options={compatibleAgents.map((agent) => ({ label: `${agent.name} · ${agent.model}`, value: agent.id }))}
                  />
                </Form.Item>
                {step.kind === 'work_unit' && <Form.Item noStyle shouldUpdate>
                  {({ getFieldValue }) => {
                    const selectedAgentId = getFieldValue(['stepAgents', step.id]) as string | null;
                    const selectedAgent = agents.data?.find((agent) => agent.id === selectedAgentId);
                    const enabledCapabilities = (projectCapabilities.data ?? []).filter((item) => item.enabled);
                    const capabilityOptions = enabledCapabilities
                      .map((item) => ({
                        label: `${item.capability.name} · ${item.capability.kind.toUpperCase()} · ${item.lockedVersion}${selectedAgent && !item.capability.compatibility.includes(selectedAgent.executor) ? ` · 不兼容 ${selectedAgent.executor}` : ''}`,
                        value: item.capabilityId,
                        disabled: Boolean(selectedAgent && !item.capability.compatibility.includes(selectedAgent.executor)),
                      }));
                    const unavailableDefaults = (selectedAgent?.defaultCapabilityIds ?? [])
                      .filter((capabilityId) => !enabledCapabilities.some((item) => item.capabilityId === capabilityId));
                    return <><Form.Item name={['stepCapabilities', step.id]} label="装载能力">
                      <Select mode="multiple" allowClear placeholder="按需选择，可为空" options={capabilityOptions} />
                    </Form.Item>{unavailableDefaults.length > 0 && <Alert type="info" showIcon title="人员默认能力未在本项目启用" description={`不会自动装载：${unavailableDefaults.map((id) => capabilitiesName(id, projectCapabilities.data ?? [])).join('、')}。可在项目能力页安装/启用，或保持当前降级方案。`} />}</>;
                  }}
                </Form.Item>}
              </Space>
            </List.Item>;
          }} />
        </Card>
        <Card title="目录与分支" className="settings-card branch-route-list">
          {project.data?.directories.some((directory) => !data.plan?.branchRoutes.some((route) => route.directoryId === directory.id)) && <Alert
            type="info"
            showIcon
            message="项目中存在尚未纳入当前任务的目录"
            description={`未纳入：${project.data.directories
              .filter((directory) => !data.plan?.branchRoutes.some((route) => route.directoryId === directory.id))
              .map((directory) => directory.displayName)
              .join('、')}。如果需求范围已经扩大，需要重新规划并再次确认，系统不会静默扩大写入范围。`}
            action={planEditable ? <Button size="small" onClick={() => {
              revisionForm.setFieldsValue({ feedback: '项目新增了相关目录。请分析目录影响，将确有需要的目录加入分支路由、步骤范围、权限和质量门禁，并说明范围变化。' });
              setRevisionOpen(true);
            }}>分析范围变化</Button> : undefined}
          />}
          <List rowKey={(route) => route.directoryId} dataSource={data.plan.branchRoutes} renderItem={(route) => {
            const directory = project.data?.directories.find((item) => item.id === route.directoryId);
            const branchOptions = (directory?.localBranches.length ? directory.localBranches : [route.sourceBranch])
              .map((branch) => ({ label: branch, value: branch }));
            return <List.Item>
              <List.Item.Meta
                title={directory?.displayName ?? route.directoryId}
                description={<Typography.Text className="mono-text">{route.sourceCommit === 'UNBORN' ? '确认后初始化 Git' : route.sourceCommit.slice(0, 10)} → {route.taskBranch}</Typography.Text>}
              />
              <Space>
                <Form.Item name={['branchRoutes', route.directoryId, 'sourceBranch']} label="来源分支" rules={[{ required: true }]} className="plan-inline-field">
                  <Select options={branchOptions} className="branch-select" />
                </Form.Item>
                <Form.Item name={['branchRoutes', route.directoryId, 'targetBranch']} label="目标分支" rules={[{ required: true }]} className="plan-inline-field">
                  <Select options={branchOptions} className="branch-select" />
                </Form.Item>
              </Space>
            </List.Item>;
          }} />
        </Card>
        <Card title="质量门禁与权限" className="settings-card">
          <Space direction="vertical" className="full-width">
            {data.plan.qualityGates.length
              ? <Form.Item name="waivedGateIds" label="豁免门禁（被选中的门禁不会阻塞交付）"><Checkbox.Group options={data.plan.qualityGates.map((gate) => ({ label: `${gate.name} · ${gate.command}`, value: gate.id }))} /></Form.Item>
              : <Alert type="warning" showIcon message="未识别已有自动化门禁，测试设计步骤需要补充专项验证。" />}
            <Form.Item name="permissionsText" label="权限清单（每行一项）"><Input.TextArea autoSize={{ minRows: 3 }} /></Form.Item>
          </Space>
        </Card>
        <Card title="版本历史与差异" className="settings-card">
          <List
            rowKey={(plan) => plan.id}
            dataSource={plans.data ?? [data.plan]}
            renderItem={(plan, index) => {
              const previous = plans.data?.[index + 1];
              return <List.Item>
                <List.Item.Meta
                  title={<Space><Typography.Text strong>计划 v{plan.version}</Typography.Text><Tag>需求 v{plan.taskVersion}</Tag>{plan.id === data.plan?.id && <Tag color="blue">当前</Tag>}{plan.confirmedAt && <Tag color="green">已确认</Tag>}</Space>}
                  description={<Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">{new Date(plan.createdAt).toLocaleString()}</Typography.Text>
                    <Typography.Text>{describePlanChanges(plan, previous).join('；')}</Typography.Text>
                  </Space>}
                />
              </List.Item>;
            }}
          />
        </Card>
        {planDirectlyEditable && <Button htmlType="submit" icon={<ReloadOutlined />} loading={updatePlan.isPending}>保存当前修订</Button>}
      </Form> : <Card><Typography.Text type="secondary">任务提交分析后会在这里生成可确认的计划。</Typography.Text></Card>,
    },
    {
      key: 'execution', label: '执行', children: <Space direction="vertical" size="middle" className="full-width">
        <Card title={data.flowVersion === 2 ? 'WorkUnit 执行链' : 'Skill 执行链'}><Timeline items={data.steps.map((step) => ({
          key: step.id,
          color: step.status === 'succeeded' ? 'green' : step.status === 'running' ? 'blue' : step.status === 'failed' ? 'red' : 'gray',
          children: <div><Typography.Text strong>{step.title}</Typography.Text><Typography.Paragraph type="secondary">{step.summary ?? step.description}</Typography.Paragraph><Space wrap><Tag>{step.status}</Tag>{step.attempt > 0 && <Tag color="orange">第 {step.attempt} 次尝试</Tag>}{(taskCapabilities.data ?? []).filter((item) => item.stepId === step.id).map((item) => <Tag
            key={item.id}
            color={item.runtimeStatus === 'failed' || item.runtimeStatus === 'needs_auth' || item.status === 'failed'
              ? 'red'
              : item.runtimeStatus === 'healthy' || item.runtimeStatus === 'connected' || item.runtimeStatus === 'loaded'
                ? 'green'
                : 'purple'}
            title={item.runtimeCheckedAt ? `运行态检查：${new Date(item.runtimeCheckedAt).toLocaleString()}` : '尚未进入真实运行态检查'}
          >{item.name} · 投影 {item.status} · 运行 {item.runtimeStatus}</Tag>)}</Space></div>,
        }))} /></Card>
        <ExecutionEvidence taskId={taskId} evidence={evidence.data} />
      </Space>,
    },
    {
      key: 'delivery', label: '交付', children: ['DELIVERED', 'ARCHIVED'].includes(data.status) ? <Card title="结构化交付报告"><Descriptions column={1} items={[
        { key: 'goal', label: '目标', children: data.plan?.goal },
        { key: 'completion', label: '完成情况', children: `已生成 ${evidence.data?.artifacts.length ?? 0} 个产物版本、${evidence.data?.changeManifests.length ?? 0} 份变更清单，质量门禁执行 ${evidence.data?.gateAttempts.length ?? 0} 次。` },
        { key: 'risk', label: '风险与限制', children: data.plan?.risks.length ? data.plan.risks.join('；') : '无新增已知风险' },
      ]} />
      <DeliveryConflictPanel conflicts={evidence.data?.deliveryConflicts ?? []} />
      {evidence.data?.deliveryReport && <Card type="inner" title="交付报告正文" className="settings-card">
        <MarkdownContent content={evidence.data.deliveryReport.markdown} className="artifact-content" />
        <Typography.Text className="mono-text" type="secondary">{evidence.data.deliveryReport.contentHash.slice(0, 12)}</Typography.Text>
      </Card>}
      {(evidence.data?.deliveryActions.length ?? 0) > 0 && <List
        className="settings-card"
        header="交付动作"
        size="small"
        dataSource={evidence.data?.deliveryActions ?? []}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <Space><Typography.Text>{item.action}</Typography.Text><Tag color={item.status === 'succeeded' ? 'green' : item.status === 'failed' ? 'red' : 'blue'}>{item.status}</Tag><Typography.Text type="secondary">{new Date(item.createdAt).toLocaleString()}</Typography.Text></Space>
        </List.Item>}
      />}
      <Divider /><Space>
        {data.status === 'DELIVERED' && <Button onClick={() => command.mutate(commandFor(data, 'self_merge'))}>自行合并并完成</Button>}
        {data.status === 'DELIVERED' && <Button type="primary" onClick={() => command.mutate(commandFor(data, 'merge'))}>合并到目标分支</Button>}
        <Button type="link" onClick={() => setCorrectionOpen(true)}>反馈问题并继续处理</Button>
      </Space></Card> : <Alert type="info" showIcon message="任务通过测试与评审后生成交付报告" description="确认交付时可以保留本地任务分支自行合并，或由研序合并到任务指定的目标分支。" />,
    },
    {
      key: 'diagnostics', label: '运行诊断', children: <TaskDiagnosticsPanel
        diagnostics={diagnostics.data}
        loading={diagnostics.isLoading}
        error={diagnostics.error}
        onRetry={() => { void diagnostics.refetch(); }}
      />,
    },
    {
      key: 'history', label: '历史', children: <TaskHistory events={events.data ?? []} evidence={evidence.data} />,
    },
  ] : [];

  return (
    <div className="page-container task-detail-page">
      <QueryState loading={task.isLoading} error={task.error} onRetry={() => { void task.refetch(); }}>
        {data && <>
          <PageHeader eyebrow={`${data.projectName} · ${data.teamName}`} title={data.title} description="计划、执行、门禁和交付记录都绑定在这个任务版本链上。" actions={actions} />
          {task.error instanceof ApiError && <Alert type="error" message={task.error.message} />}
          <div className="entity-detail-layout task-workspace-layout">
            <main className="entity-detail-main">
              <Tabs className="workspace-tabs" defaultActiveKey={planEditable ? 'plan' : 'overview'} items={items} />
            </main>
            <aside className="entity-properties-panel" aria-label="任务属性">
              <div className="properties-panel-title">任务属性</div>
              <section className="properties-section properties-status-section">
                <Space wrap><TaskStatusTag status={data.status} /><Tag>{data.triggerSource === 'schedule' ? '定时触发' : '人工任务'}</Tag></Space>
                <Progress percent={data.progress} status={data.status === 'BLOCKED' ? 'exception' : 'active'} size="small" />
              </section>
              <section className="properties-section">
                <Typography.Text strong>当前执行</Typography.Text>
                <Descriptions column={1} size="small" colon={false} items={[
                  { key: 'phase', label: '阶段', children: data.activeExecution?.phase ?? data.steps.find((step) => step.status === 'running')?.title ?? '等待下一步' },
                  { key: 'project', label: '项目', children: data.projectName },
                  { key: 'team', label: '团队', children: data.teamName },
                  { key: 'version', label: '状态版本', children: `v${data.stateVersion}` },
                ]} />
              </section>
              <section className="properties-section">
                <Typography.Text strong>目录与分支</Typography.Text>
                <Space orientation="vertical" size={6} className="full-width">{data.plan?.branchRoutes.length
                  ? data.plan.branchRoutes.map((route) => <Tag className="properties-branch" key={route.directoryId}>{route.sourceBranch} → {route.targetBranch}</Tag>)
                  : <Typography.Text type="secondary">{project.data?.directories.length ?? 0} 个目录 · 尚未冻结分支</Typography.Text>}
                </Space>
              </section>
              <section className="properties-section">
                <Typography.Text strong>下一步</Typography.Text>
                <Typography.Paragraph type="secondary">{data.activeExecution?.nextAction ?? data.statusReason?.message ?? '等待当前状态完成后继续推进。'}</Typography.Paragraph>
              </section>
            </aside>
          </div>
          <Modal
            title="请求协调器修改计划"
            open={revisionOpen}
            okText="保存当前修订并重新规划"
            cancelText="取消"
            confirmLoading={updatePlan.isPending || requestRevision.isPending}
            onCancel={() => setRevisionOpen(false)}
            onOk={() => {
              void Promise.all([revisionForm.validateFields(), planForm.validateFields()])
                .then(([revisionValues, planValues]) => updatePlan.mutate({
                  values: planValues,
                  action: 'replan',
                  revisionFeedback: revisionValues.feedback,
                }))
                .catch(() => undefined);
            }}
          >
            <Alert
              type="info"
              showIcon
              message="适用于增删或重排步骤、扩大目录范围、改变产出结构或关键方案"
              description="目标、范围、人员、分支、权限和门禁豁免可以直接在计划页修改。"
            />
            <Form form={revisionForm} layout="vertical" className="settings-card">
              <Form.Item name="feedback" label="需要怎样修改" rules={[{ required: true, message: '请说明修改要求' }]}>
                <Input.TextArea rows={5} placeholder="例如：删除技术设计步骤，仅对前端目录实施；增加接口兼容性专项测试。" />
              </Form.Item>
            </Form>
          </Modal>
          <Modal
            title="反馈问题并生成新需求版本"
            open={correctionOpen}
            okText="保存纠正内容"
            cancelText="取消"
            confirmLoading={command.isPending}
            onCancel={() => setCorrectionOpen(false)}
            onOk={() => {
              void correctionForm.validateFields().then(({ correction }) => {
                command.mutate({ command: 'reopen', stateVersion: data.stateVersion, reason: correction });
              });
            }}
          >
            <Alert
              type="warning"
              showIcon
              message="纠正内容会形成新的 TaskVersion"
              description="旧需求、计划、产物和测试证据都会保留；重新提交分析后，协调器会基于修订后的当前需求生成新计划。"
            />
            <Form form={correctionForm} layout="vertical" className="settings-card">
              <Form.Item name="correction" label="哪里不符合预期，需要怎样修正" rules={[{ required: true, message: '请说明需要纠正的内容' }]}>
                <Input.TextArea rows={6} />
              </Form.Item>
            </Form>
          </Modal>
        </>}
      </QueryState>
    </div>
  );
}

export function TaskDiagnosticsPanel({
  diagnostics,
  loading = false,
  error,
  onRetry,
}: {
  diagnostics: TaskDiagnostics | undefined;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  if (error) return <Alert
    type="error"
    showIcon
    title="运行诊断加载失败"
    description={error.message}
    action={onRetry ? <Button size="small" danger onClick={onRetry}>重试</Button> : undefined}
  />;
  if (!diagnostics) return loading
    ? <Card loading />
    : <Alert type="info" showIcon title="暂无运行诊断" description="任务产生执行记录后会在这里汇总耗时、失败分类和恢复记录。" />;
  const failureLabels: Record<TaskDiagnostics['failures'][number]['category'], string> = {
    infrastructure: '运行基础设施',
    network: '网络连接',
    configuration: '运行配置',
    context: '上下文连续性',
    business_result: '业务结果',
    transient: '瞬时故障',
    invalid_output: '输出不合法',
    skill_contract: 'Skill 契约',
    permission: '权限问题',
    scope_change: '范围变化',
    model_capability: '模型能力',
    git_conflict: 'Git 冲突',
    stale_execution: '旧运行结果',
    system: '系统故障',
  };
  return <Space orientation="vertical" size="middle" className="full-width">
    {diagnostics.statusReason && <Alert
      type={diagnostics.status === 'BLOCKED' ? 'error' : diagnostics.status === 'RETRYING' || diagnostics.status === 'REPLANNING' ? 'warning' : 'info'}
      showIcon
      title={`当前状态：${diagnostics.status}`}
      description={`${diagnostics.statusReason.message} · ${new Date(diagnostics.statusReason.occurredAt).toLocaleString()}`}
    />}
    <div className="detail-grid">
      <Card title="耗时构成">
        <Descriptions column={1} size="small" items={[
          { key: 'total', label: '任务总耗时', children: formatDuration(diagnostics.duration.totalMs) },
          { key: 'model', label: '模型执行', children: formatDuration(diagnostics.duration.modelMs) },
          { key: 'gate', label: '质量门禁', children: formatDuration(diagnostics.duration.gateMs) },
          { key: 'waiting', label: '排队/等待/人工确认', children: formatDuration(diagnostics.duration.waitingMs) },
        ]} />
      </Card>
      <Card title="执行健康度">
        <Descriptions column={1} size="small" items={[
          { key: 'runs', label: '独立 Run', children: `${diagnostics.runs.succeeded} 成功 / ${diagnostics.runs.failed} 失败 / ${diagnostics.runs.interrupted + diagnostics.runs.stopped} 中断` },
          { key: 'session', label: '会话', children: `${diagnostics.sessions.succeeded} 成功 / ${diagnostics.sessions.failed} 失败 / ${diagnostics.sessions.interrupted} 中断` },
          { key: 'job', label: '后台作业', children: `${diagnostics.jobs.succeeded} 成功 / ${diagnostics.jobs.failed} 失败 / ${diagnostics.jobs.cancelled} 取消` },
          { key: 'retry', label: '自动重试 / 恢复', children: `${diagnostics.jobs.retries} / ${diagnostics.recoveries}` },
          { key: 'plan', label: '计划版本 / 重规划', children: `${diagnostics.planning.versions} / ${diagnostics.planning.replans}` },
        ]} />
      </Card>
      <Card title="上下文成本">
        <Descriptions column={1} size="small" items={[
          { key: 'packs', label: '上下文包', children: diagnostics.context.packs },
          { key: 'tokens', label: '累计估算 Token', children: diagnostics.context.estimatedTokens.toLocaleString() },
          { key: 'truncated', label: '发生截断', children: `${diagnostics.context.truncatedPacks} 次` },
          { key: 'quality', label: '质量结论', children: <Tag color={diagnostics.quality.status === 'passed' ? 'green' : diagnostics.quality.status === 'failed' ? 'red' : 'orange'}>{diagnostics.quality.status}</Tag> },
        ]} />
      </Card>
    </div>
    <Card title={`Run 时间线 · ${diagnostics.runs.total}`}>
      {diagnostics.recentRuns.length === 0
        ? <Typography.Text type="secondary">尚未启动真实 CLI Run</Typography.Text>
        : <List
          size="small"
          dataSource={diagnostics.recentRuns}
          rowKey={(run) => run.id}
          renderItem={(run) => <List.Item actions={[
            <Link key="view" to={`/tasks/${diagnostics.taskId}/runs/${run.id}`}>查看证据</Link>,
          ]}>
            <List.Item.Meta
              title={<Space wrap>
                <Typography.Text strong>{run.phase}</Typography.Text>
                <Tag color={run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : run.status === 'running' ? 'blue' : 'orange'}>{run.status}</Tag>
                <Tag>{run.triggerSource}</Tag>
                {run.retryOfRunId && <Tag color="purple">重试 {run.retryOfRunId.slice(-8)}</Tag>}
              </Space>}
              description={<Space orientation="vertical" size={2}>
                <Typography.Text type="secondary">Run {run.id} · Session {run.externalSessionId ?? '未建立'} · 工作区{run.workspaceReused ? '复用' : '新准备'} / 会话{run.sessionReused ? '复用' : '新建'}</Typography.Text>
                {run.failureMessage && <Typography.Text type="danger">{run.failureMessage}</Typography.Text>}
                {run.nextAction && <Typography.Text>下一步：{run.nextAction}</Typography.Text>}
                <Typography.Text type="secondary">{new Date(run.startedAt).toLocaleString()} · 最近活动 {new Date(run.heartbeatAt ?? run.startedAt).toLocaleString()}</Typography.Text>
              </Space>}
            />
          </List.Item>}
        />}
    </Card>
    <Card title={`失败分类时间线 · ${diagnostics.failures.length}`}>
      {diagnostics.failures.length === 0
        ? <Typography.Text type="secondary">没有记录到后台执行失败</Typography.Text>
        : <Space orientation="vertical" size={10} className="full-width">
          {diagnostics.failures.slice().reverse().map((failure) => <div key={`${failure.jobId}-${failure.occurredAt}-${failure.attempt}`}>
            <Space wrap>
              <Tag color={failure.retryable ? 'orange' : failure.suggestedAction === 'discard' ? 'default' : 'red'}>{failureLabels[failure.category]}</Tag>
              <Typography.Text strong>{failure.jobType}</Typography.Text>
              <Tag>第 {failure.attempt} 次</Tag>
              {failure.repeated && <Tag color="red">重复指纹，停止盲重试</Tag>}
            </Space>
            <Space orientation="vertical" size={2} className="full-width">
              <Typography.Text>{failure.message}</Typography.Text>
              <Typography.Text type="secondary">动作：{failure.suggestedAction} · 指纹 {failure.fingerprint.slice(0, 12)} · {new Date(failure.occurredAt).toLocaleString()}</Typography.Text>
            </Space>
          </div>)}
        </Space>}
    </Card>
    <Card title="最近关键决策">
      <Timeline items={diagnostics.recentDecisions.slice().reverse().map((event) => ({
        key: event.id,
        content: <div>
          <Typography.Text strong>{event.message}</Typography.Text>
          <div><Typography.Text type="secondary">{event.type} · {new Date(event.occurredAt).toLocaleString()}</Typography.Text></div>
        </div>,
      }))} />
    </Card>
  </Space>;
}

export function DeliveryConflictPanel({ conflicts }: {
  conflicts: TaskEvidence['deliveryConflicts'];
}) {
  const pending = conflicts.filter((conflict) => conflict.status === 'pending');
  if (pending.length === 0) return null;
  return <Alert
    className="settings-card"
    type="warning"
    showIcon
    title="自动合并已停在语义冲突"
    description={<Space orientation="vertical" size="small">
      <Typography.Text>系统只自动合并独立插入等机械冲突；以下重叠修改需要你判断。目标分支和任务分支都没有被覆盖。</Typography.Text>
      {pending.map((conflict) => <div key={conflict.id}>
        <Typography.Text strong>{conflict.taskBranch} → {conflict.targetBranch}</Typography.Text>
        <div>{conflict.conflicts.map((item) =>
          `${item.path}（${item.hunkCount} 个重叠区；${item.reason}）`).join('、') || '冲突文件详情不可用'}</div>
      </div>)}
      <Typography.Text type="secondary">你可以在本地解决后再次点击“合并到目标分支”，或选择“自行合并并完成”。</Typography.Text>
    </Space>}
  />;
}

export function PreApprovalArtifacts({ artifacts }: {
  artifacts: TaskEvidence['preApprovalArtifacts'];
}) {
  return <Card title="确认前需求规格" className="settings-card">
    <List
      locale={{ emptyText: '需求规格正在生成，完成后才会出现可确认计划。' }}
      dataSource={artifacts}
      rowKey={(artifact) => artifact.id}
      renderItem={(artifact) => <List.Item>
        <List.Item.Meta
          title={<Space>
            <Typography.Text strong>{artifact.title}</Typography.Text>
            <Tag>v{artifact.version}</Tag>
            <Tag color={artifact.status === 'approved' ? 'green' : artifact.status === 'superseded' ? 'default' : 'blue'}>
              {artifact.status}
            </Tag>
          </Space>}
          description={<>
            <MarkdownContent content={artifact.content} className="artifact-content" />
            <Typography.Text className="mono-text" type="secondary">
              {artifact.sourceExecutor}/{artifact.sourceModel} · {artifact.contentHash.slice(0, 12)}
            </Typography.Text>
          </>}
        />
      </List.Item>}
    />
  </Card>;
}

export function TaskHistory({ events, evidence }: {
  events: WorkflowEvent[];
  evidence: TaskEvidence | undefined;
}) {
  if (!evidence) return <Card loading />;
  return <Space orientation="vertical" size="middle" className="full-width">
    <div className="detail-grid">
      <Card title="证据链汇总">
        <Descriptions column={1} size="small" items={[
          { key: 'versions', label: '需求 / 计划前产物', children: `${evidence.requirementVersions.length} / ${evidence.preApprovalArtifacts.length}` },
          { key: 'execution', label: '执行会话 / 上下文包', children: `${evidence.sessions.length} / ${evidence.contextPacks.length}` },
          { key: 'permissions', label: '权限决策', children: `${evidence.permissionRequests.filter((item) => item.status === 'resolved').length} 已处理，${evidence.permissionRequests.filter((item) => item.status === 'pending').length} 待处理` },
          { key: 'changes', label: '变更清单 / 门禁尝试', children: `${evidence.changeManifests.length} / ${evidence.gateAttempts.length}` },
          { key: 'delivery', label: '交付动作 / 恢复记录', children: `${evidence.deliveryActions.length} / ${evidence.recoveries.length}` },
        ]} />
      </Card>
      <Card title="异常与恢复">
        {[
            ...evidence.deliveryConflicts.map((item) => ({
              id: item.id,
              title: `语义冲突 · ${item.taskBranch} → ${item.targetBranch}`,
              detail: `${item.status} · ${item.conflicts.map((conflict) => conflict.path).join('、') || '无文件详情'}`,
            })),
            ...evidence.recoveries.map((item) => ({
              id: item.id,
              title: `恢复 · ${item.reason}`,
              detail: `${item.action} · ${new Date(item.createdAt).toLocaleString()}`,
            })),
          ].length === 0
          ? <Typography.Text type="secondary">没有语义冲突或调度恢复记录</Typography.Text>
          : <Space orientation="vertical" size={8} className="full-width">{[
            ...evidence.deliveryConflicts.map((item) => ({
              id: item.id,
              title: `语义冲突 · ${item.taskBranch} → ${item.targetBranch}`,
              detail: `${item.status} · ${item.conflicts.map((conflict) => conflict.path).join('、') || '无文件详情'}`,
            })),
            ...evidence.recoveries.map((item) => ({
              id: item.id,
              title: `恢复 · ${item.reason}`,
              detail: `${item.action} · ${new Date(item.createdAt).toLocaleString()}`,
            })),
          ].map((item) => <div key={item.id}><Typography.Text strong>{item.title}</Typography.Text><div><Typography.Text type="secondary">{item.detail}</Typography.Text></div></div>)}</Space>}
      </Card>
    </div>
    <Card title={`状态与操作时间线 · ${events.length}`}>
      <Timeline items={events.slice().reverse().map((event) => ({
        key: event.id,
        content: <div>
          <Typography.Text strong>{event.message}</Typography.Text>
          <div><Typography.Text type="secondary">{new Date(event.occurredAt).toLocaleString()} · {event.actorType} · {event.type}</Typography.Text></div>
        </div>,
      }))} />
    </Card>
  </Space>;
}

function ExecutionEvidence({ taskId, evidence }: { taskId: string; evidence: TaskEvidence | undefined }) {
  const [diffTarget, setDiffTarget] = useState<{ directoryId: string; path: string } | null>(null);
  const [logCursor, setLogCursor] = useState<number | undefined>();
  const runtimeLog = useQuery({
    queryKey: ['task-runtime-log', taskId, logCursor],
    queryFn: () => api.taskRuntimeLog(taskId, logCursor),
    enabled: Boolean(taskId),
  });
  const fileDiff = useQuery({
    queryKey: ['task-file-diff', taskId, diffTarget?.directoryId, diffTarget?.path],
    queryFn: () => api.taskFileDiff(taskId, diffTarget?.directoryId ?? '', diffTarget?.path ?? ''),
    enabled: Boolean(diffTarget),
  });
  if (!evidence) return <Card loading />;
  return <><div className="detail-grid">
    <Card title={`结构化产物 · ${evidence.artifacts.length}`}>
      <List
        size="small"
        locale={{ emptyText: '当前还没有 ArtifactVersion' }}
        dataSource={evidence.artifacts}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{item.title}</Typography.Text><Tag>v{item.version}</Tag><Tag color={item.status === 'superseded' ? 'default' : 'blue'}>{item.status}</Tag></Space>}
            description={<Space direction="vertical" className="full-width" size={4}>
              <Typography.Text className="mono-text" type="secondary">{item.contentHash.slice(0, 12)} · {item.skillId}</Typography.Text>
              <MarkdownContent
                className="artifact-content"
                content={evidence.artifactPreviews.find((preview) => preview.artifactId === item.id)?.content || '产物正文不可用'}
              />
            </Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`执行会话 · ${evidence.sessions.length}`}>
      <List
        size="small"
        locale={{ emptyText: '步骤启动后会创建独立执行会话' }}
        dataSource={evidence.sessions}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space>
              <Typography.Text>Step {item.stepId.slice(-8)}</Typography.Text>
              <Tag color={item.status === 'succeeded' ? 'green' : item.status === 'failed' ? 'red' : item.status === 'interrupted' ? 'orange' : 'blue'}>{item.status}</Tag>
            </Space>}
            description={<Space direction="vertical" size={2}>
              <Typography.Text type="secondary">{item.executor}/{item.model} · {new Date(item.startedAt).toLocaleString()}</Typography.Text>
              {item.externalSessionId && <Typography.Text className="mono-text" type="secondary">CLI Session：{item.externalSessionId}</Typography.Text>}
              {item.error && <Typography.Text type="danger">{item.error}</Typography.Text>}
            </Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`权限清单 · ${evidence.permissionManifests.length}`}>
      <List
        size="small"
        locale={{ emptyText: '计划确认后会冻结逐步骤权限清单' }}
        dataSource={evidence.permissionManifests}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space>
              <Typography.Text>Step {item.stepId.slice(-8)}</Typography.Text>
              <Tag color={item.permissionMode === 'managed' ? 'purple' : 'blue'}>{item.permissionMode}</Tag>
              {item.readOnly && <Tag>只读</Tag>}
            </Space>}
            description={<>
              <Typography.Paragraph type="secondary">
                目录：{item.directoryIds.join('、') || '无'} · 禁止路径：{item.forbiddenPaths.join('、') || '无'}
              </Typography.Paragraph>
              <Typography.Text className="mono-text" type="secondary">
                {item.allowedCommandPatterns.join(' · ')}
              </Typography.Text>
            </>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`权限决策 · ${evidence.permissionRequests.length}`}>
      <List
        size="small"
        locale={{ emptyText: '当前任务没有运行时权限请求' }}
        dataSource={evidence.permissionRequests}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space>
              <Typography.Text>{item.permission}</Typography.Text>
              <Tag color={item.status === 'pending' ? 'orange' : item.decision === 'reject' ? 'red' : 'green'}>
                {item.status === 'pending' ? '待处理' : item.decision}
              </Tag>
            </Space>}
            description={<Space direction="vertical" size={2}>
              <Typography.Text className="mono-text" type="secondary">{item.patterns.join(' · ') || '无路径或命令模式'}</Typography.Text>
              {item.message && <Typography.Text type="secondary">{item.message}</Typography.Text>}
              <Typography.Text type="secondary">{new Date(item.createdAt).toLocaleString()}{item.resolvedAt ? ` → ${new Date(item.resolvedAt).toLocaleString()}` : ''}</Typography.Text>
            </Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`需求版本 · ${evidence.requirementVersions.length}`}>
      <List
        size="small"
        dataSource={evidence.requirementVersions}
        rowKey={(item) => item.version}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>TaskVersion v{item.version}</Typography.Text><Tag color={item.status === 'superseded' ? 'default' : 'blue'}>{item.status}</Tag></Space>}
            description={<Typography.Text className="mono-text" type="secondary">{item.contentHash.slice(0, 12)} · {new Date(item.createdAt).toLocaleString()}</Typography.Text>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`上下文包 · ${evidence.contextPacks.length}`}>
      <List
        size="small"
        locale={{ emptyText: '步骤启动时会生成最小上下文包' }}
        dataSource={evidence.contextPacks}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={`Step ${item.stepId.slice(-8)} · 第 ${item.attempt} 次`}
            description={<Space><Typography.Text type="secondary">约 {item.estimatedTokens} tokens</Typography.Text><Typography.Text className="mono-text">{item.contentHash.slice(0, 12)}</Typography.Text>{item.truncated && <Tag color="orange">已截断</Tag>}</Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`变更清单 · ${evidence.changeManifests.length}`}>
      <List
        size="small"
        locale={{ emptyText: '写入步骤完成后会记录逐文件证据' }}
        dataSource={evidence.changeManifests}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{item.directoryId}</Typography.Text><Tag>{item.files.length} 个文件</Tag>{item.hasOutOfScopeChanges && <Tag color="red">越界</Tag>}{item.hasSensitiveChanges && <Tag color="red">敏感</Tag>}</Space>}
            description={<Space direction="vertical" size={3}>
              <Typography.Text className="mono-text" type="secondary">基线 {item.baseCommit.slice(0, 10)} → 检查点 {item.checkpointCommit.slice(0, 10)}</Typography.Text>
              {item.files.length
                ? <Space wrap>{item.files.map((file) => <Button
                  key={file.path}
                  type="link"
                  size="small"
                  danger={file.sensitive || !file.inApprovedScope}
                  disabled={file.sensitive}
                  onClick={() => setDiffTarget({ directoryId: item.directoryId, path: file.path })}
                >{file.path}</Button>)}</Space>
                : <Typography.Text type="secondary">本步骤无文件变更</Typography.Text>}
            </Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`测试设计门禁 · ${evidence.designedQualityGates.length}`}>
      <List
        size="small"
        locale={{ emptyText: '测试设计尚未生成专项门禁' }}
        dataSource={evidence.designedQualityGates}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{item.name}</Typography.Text><Tag>{item.directoryId}</Tag></Space>}
            description={<Typography.Text className="mono-text" type="secondary">
              {(item.commandArgv ?? [item.command]).join(' ')}
            </Typography.Text>}
          />
        </List.Item>}
      />
    </Card>
    <Card
      title={`质量门禁与评审 · ${evidence.gateAttempts.length} 次执行`}
      extra={<Tag color={
        evidence.qualitySummary.status === 'passed' ? 'green'
          : evidence.qualitySummary.status === 'failed' ? 'red'
            : evidence.qualitySummary.status === 'not_configured' ? 'orange'
              : evidence.qualitySummary.status === 'waived' ? 'default' : 'blue'
      }>{({
        not_configured: '未配置门禁',
        pending: '等待门禁',
        running: '门禁执行中',
        passed: '门禁通过',
        failed: '存在阻塞问题',
        waived: '已全部豁免',
      } as const)[evidence.qualitySummary.status]}</Tag>}
    >
      <Descriptions size="small" column={{ xs: 2, md: 5 }} items={[
        { key: 'configured', label: '已配置', children: evidence.qualitySummary.configured },
        { key: 'required', label: '必需', children: evidence.qualitySummary.required },
        { key: 'passed', label: '通过', children: evidence.qualitySummary.passed },
        { key: 'failed', label: '失败', children: evidence.qualitySummary.failed },
        { key: 'waived', label: '豁免', children: evidence.qualitySummary.waived },
      ]} />
      {evidence.qualitySummary.blockingFindings.length > 0 && <Alert
        className="settings-card"
        type="error"
        showIcon
        message={`${evidence.qualitySummary.blockingFindings.length} 项阻塞评审问题`}
        description={<List
          size="small"
          dataSource={evidence.qualitySummary.blockingFindings}
          renderItem={(finding) => <List.Item>
            <List.Item.Meta
              title={<Space><Tag color="red">{finding.severity}</Tag><Typography.Text strong>{finding.title}</Typography.Text></Space>}
              description={`${finding.description} · 证据：${finding.evidence}`}
            />
          </List.Item>}
        />}
      />}
      {evidence.qualitySummary.advisoryFindings.length > 0 && <Alert
        className="settings-card"
        type="warning"
        showIcon
        message={`${evidence.qualitySummary.advisoryFindings.length} 项非阻塞建议`}
        description={evidence.qualitySummary.advisoryFindings.map((finding) => finding.title).join('；')}
      />}
      <List
        size="small"
        locale={{ emptyText: evidence.qualitySummary.status === 'not_configured' ? '当前任务未配置可执行质量门禁' : '尚未运行质量门禁' }}
        dataSource={evidence.gateAttempts}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{item.commandArgv.join(' ')}</Typography.Text><Tag color={item.status === 'passed' ? 'green' : 'red'}>{item.status}</Tag></Space>}
            description={<Space direction="vertical" className="full-width" size={4}>
              <Typography.Text type="secondary">第 {item.attempt} 轮 · exit {item.exitCode ?? 'null'}{item.timedOut ? ' · 超时' : ''}</Typography.Text>
              {item.logExcerpt && <Typography.Paragraph className="artifact-content" ellipsis={{ rows: 5, expandable: true, symbol: '展开日志' }}>
                {item.logExcerpt}{item.logTruncated ? '\n…（仅显示末尾 8000 字符）' : ''}
              </Typography.Paragraph>}
            </Space>}
          />
        </List.Item>}
      />
    </Card>
    <Card title={`恢复记录 · ${evidence.recoveries.length}`}>
      <List
        size="small"
        locale={{ emptyText: '当前任务没有发生调度恢复' }}
        dataSource={evidence.recoveries}
        rowKey={(item) => item.id}
        renderItem={(item) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{item.reason}</Typography.Text><Tag>{item.action}</Tag></Space>}
            description={<Typography.Text type="secondary">{item.previousOwner ?? '未知实例'} → {item.recoveredBy ?? '自动队列'} · {new Date(item.createdAt).toLocaleString()}</Typography.Text>}
          />
        </List.Item>}
      />
    </Card>
    <Card
      title="CLI Runtime 原始日志"
      extra={<Space size="small">
        <Button
          size="small"
          disabled={!runtimeLog.data || runtimeLog.data.cursor === 0}
          onClick={() => setLogCursor(Math.max(0, (runtimeLog.data?.cursor ?? 0) - 64 * 1024))}
        >上一段</Button>
        <Button
          size="small"
          disabled={!runtimeLog.data || runtimeLog.data.eof}
          onClick={() => setLogCursor(runtimeLog.data?.nextCursor)}
        >下一段</Button>
        <Button size="small" disabled={logCursor === undefined} onClick={() => setLogCursor(undefined)}>回到末尾</Button>
        <Button size="small" icon={<ReloadOutlined />} loading={runtimeLog.isFetching} onClick={() => { void runtimeLog.refetch(); }}>刷新</Button>
      </Space>}
    >
      {runtimeLog.data?.content
        ? <Typography.Paragraph className="artifact-content mono-text" ellipsis={{ rows: 14, expandable: true, symbol: '展开日志' }}>
          {runtimeLog.data.content}
        </Typography.Paragraph>
        : <Typography.Text type="secondary">当前没有 Runtime 日志。</Typography.Text>}
      {runtimeLog.data && <div><Typography.Text type="secondary">
        字节 {runtimeLog.data.cursor}–{runtimeLog.data.nextCursor} / {runtimeLog.data.totalBytes}
      </Typography.Text></div>}
    </Card>
  </div>
  <Modal
    width={960}
    open={Boolean(diffTarget)}
    title={diffTarget ? `文件 Diff · ${diffTarget.path}` : '文件 Diff'}
    footer={null}
    onCancel={() => setDiffTarget(null)}
  >
    {fileDiff.isLoading
      ? <Card loading />
      : fileDiff.error
        ? <Alert type="error" showIcon message={fileDiff.error.message} />
        : <Typography.Paragraph className="artifact-content mono-text">
          {fileDiff.data?.diff || '该文件当前没有可展示的提交差异。'}
          {fileDiff.data?.truncated ? '\n\n…Diff 已按安全上限截断' : ''}
        </Typography.Paragraph>}
  </Modal></>;
}
