import { Form, Input, Modal, Select, Segmented, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentProfile, CreateAgentInput, ExecutorInstallation, RoleTemplate } from '@yanxu/contracts';
import { api } from '../lib/api.js';

interface CreateAgentModalProps {
  open: boolean;
  roles: RoleTemplate[];
  executors: ExecutorInstallation[];
  agent?: AgentProfile | null;
  onClose: () => void;
}

export function CreateAgentModal({ open, roles, executors, agent, onClose }: CreateAgentModalProps) {
  const [form] = Form.useForm<CreateAgentInput>();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const executor = Form.useWatch('executor', form);
  const installation = executors.find((item) => item.id === executor);
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
      form.resetFields();
      onClose();
    },
    onError: (error: Error) => message.error(error.message),
  });

  return (
    <Modal
      title={agent ? '编辑 AI 人员' : '创建 AI 人员'}
      open={open}
      onCancel={onClose}
      okText={agent ? '保存人员' : '创建人员'}
      confirmLoading={mutation.isPending}
      onOk={() => { void form.validateFields().then((values) => mutation.mutate(values)); }}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) {
          form.setFieldsValue(agent ? {
            name: agent.name,
            roleId: agent.roleId,
            executor: agent.executor,
            model: agent.model,
            permissionMode: agent.permissionMode,
            parameters: agent.parameters,
          } : {
            executor: 'opencode',
            permissionMode: settings.data?.permissionMode ?? 'standard',
            parameters: {},
          });
          probe.mutate();
        }
      }}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input placeholder="例如：产品一号" autoFocus /></Form.Item>
        <Form.Item name="roleId" label="Role" rules={[{ required: true }]}>
          <Select options={roles.map((role) => ({ label: role.name, value: role.id, title: role.description }))} />
        </Form.Item>
        <Form.Item name="executor" label="CLI" rules={[{ required: true }]}>
          <Select loading={probe.isPending} placeholder={probe.isPending ? '正在检测本地 CLI' : '选择可用 CLI'} options={executors.map((item) => {
            const adapterReady = item.capabilities.includes('structured-output');
            const state = !adapterReady ? '适配待接入' : item.health === 'available' ? '可用' : item.health === 'unchecked' ? '待检测' : '不可用';
            return { label: `${item.name} · ${state}`, value: item.id, disabled: item.health !== 'available' || !adapterReady };
          })} />
        </Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true, message: '请选择模型' }]}>
          <Select showSearch optionFilterProp="label" placeholder="先在设置中检测 CLI" options={(installation?.models ?? []).map((model) => ({ label: model, value: model }))} />
        </Form.Item>
        <Form.Item name="permissionMode" label="默认权限模式">
          <Segmented block options={[{ label: '标准模式', value: 'standard' }, { label: '全托管模式', value: 'managed' }]} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
