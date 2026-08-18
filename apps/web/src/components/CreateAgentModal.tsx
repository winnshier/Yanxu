import { AutoComplete, Form, Input, Modal, Select, Segmented, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentProfile, Capability, CreateAgentInput, ExecutorInstallation, ExecutorType, RoleTemplate } from '@yanxu/contracts';
import { api } from '../lib/api.js';

interface CreateAgentModalProps {
  open: boolean;
  roles: RoleTemplate[];
  executors: ExecutorInstallation[];
  capabilities: Capability[];
  agent?: AgentProfile | null;
  onClose: () => void;
}

export function CreateAgentModal({ open, roles, executors, capabilities, agent, onClose }: CreateAgentModalProps) {
  const [form] = Form.useForm<CreateAgentInput>();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const executor = Form.useWatch('executor', form);
  const installation = executors.find((item) => item.id === executor);
  const closeModal = () => {
    form.resetFields();
    onClose();
  };
  const probe = useMutation({
    mutationFn: api.probeExecutors,
    onSuccess: (data) => { queryClient.setQueryData(['executors'], data); },
    onError: (error: Error) => message.error(error.message),
  });
  const mutation = useMutation({
    mutationFn: (input: CreateAgentInput) => agent ? api.updateAgent(agent.id, input) : api.createAgent(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      message.success(agent ? 'AI 人员已更新' : 'AI 人员已创建');
      closeModal();
    },
    onError: (error: Error) => message.error(error.message),
  });

  return (
    <Modal
      title={agent ? '编辑 AI 人员' : '创建 AI 人员'}
      width={560}
      open={open}
      onCancel={closeModal}
      okText={agent ? '保存人员' : '创建人员'}
      confirmLoading={mutation.isPending}
      onOk={() => { void form.validateFields().then((values) => mutation.mutate(values)); }}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) {
          form.resetFields();
          form.setFieldsValue(agent ? {
            name: agent.name,
            roleId: agent.roleId,
            executor: agent.executor,
            model: agent.model,
            permissionMode: agent.permissionMode,
            parameters: agent.parameters,
            defaultCapabilityIds: agent.defaultCapabilityIds,
          } : {
            executor: 'opencode',
            permissionMode: settings.data?.permissionMode ?? 'standard',
            parameters: {},
          });
          probe.mutate();
        } else {
          form.resetFields();
        }
      }}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input placeholder="例如：产品一号" autoFocus /></Form.Item>
        <Form.Item name="roleId" label="Role" rules={[{ required: true }]}>
          <Select onChange={(roleId) => {
            const role = roles.find((item) => item.id === roleId);
            const compatibleDefaults = (role?.capabilityIds ?? []).filter((capabilityId) => {
              const capability = capabilities.find((item) => item.id === capabilityId);
              return capability?.lifecycleStatus === 'installed' && capability.compatibility.includes(executor);
            });
            form.setFieldValue('defaultCapabilityIds', compatibleDefaults);
          }} options={roles.map((role) => ({
            label: `${role.name}${role.origin === 'external' ? ' · 外部' : ''}`,
            value: role.id,
            title: role.description,
            disabled: Boolean(executor && !role.compatibility.includes(executor)),
          }))} />
        </Form.Item>
        <Form.Item name="executor" label="CLI" rules={[{ required: true }]}>
          <Select onChange={(nextExecutor: ExecutorType) => {
            const selected = (form.getFieldValue('defaultCapabilityIds') as string[] | undefined) ?? [];
            form.setFieldValue('defaultCapabilityIds', selected.filter((capabilityId: string) =>
              capabilities.find((item) => item.id === capabilityId)?.compatibility.includes(nextExecutor)));
          }} loading={probe.isPending} placeholder={probe.isPending ? '正在检测本地 CLI' : '选择可用 CLI'} options={executors.map((item) => {
            const adapterReady = item.capabilities.includes('structured-output');
            const state = !adapterReady ? '适配待接入' : item.health === 'available' ? '可用' : item.health === 'unchecked' ? '待检测' : '不可用';
            return { label: `${item.name} · ${state}`, value: item.id, disabled: item.health !== 'available' || !adapterReady };
          })} />
        </Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true, message: '请选择或输入模型' }]}>
          <AutoComplete placeholder={executor === 'claude' ? '选择别名，或输入完整 Claude 模型 ID' : '先检测 CLI，再选择或输入模型'} options={(installation?.models ?? []).map((model) => ({ label: model, value: model }))} />
        </Form.Item>
        <Form.Item name="permissionMode" label="默认权限模式">
          <Segmented block options={[{ label: '标准模式', value: 'standard' }, { label: '全托管模式', value: 'managed' }]} />
        </Form.Item>
        <Form.Item name="defaultCapabilityIds" label="默认 Skill / MCP" extra="这是规划偏好；能力仍必须由具体项目启用，并在任务确认时按 WorkUnit 冻结。">
          <Select mode="multiple" allowClear placeholder="可为空，按任务再选择" options={capabilities
            .filter((capability) => capability.lifecycleStatus === 'installed' && (!executor || capability.compatibility.includes(executor)))
            .map((capability) => ({ label: `${capability.name} · ${capability.kind.toUpperCase()}`, value: capability.id }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
