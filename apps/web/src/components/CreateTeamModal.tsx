import { Form, Input, Modal, Select, Switch, message } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentProfile, CreateTeamInput, Team } from '@yanxu/contracts';
import { api } from '../lib/api.js';

interface CreateTeamModalProps {
  open: boolean;
  agents: AgentProfile[];
  team?: Team | null;
  onClose: () => void;
}

export function CreateTeamModal({ open, agents, team, onClose }: CreateTeamModalProps) {
  const [form] = Form.useForm<CreateTeamInput>();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: CreateTeamInput) => team ? api.updateTeam(team.id, input) : api.createTeam(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      message.success(team ? '团队已更新' : '团队已创建');
      form.resetFields();
      onClose();
    },
    onError: (error: Error) => message.error(error.message),
  });
  return (
    <Modal
      title={team ? '编辑团队' : '创建团队'}
      open={open}
      onCancel={onClose}
      okText={team ? '保存修改' : '创建团队'}
      confirmLoading={mutation.isPending}
      onOk={() => { void form.validateFields().then((values) => mutation.mutate(values)); }}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) {
          form.setFieldsValue(team
            ? { name: team.name, description: team.description, memberIds: team.memberIds, isDefault: team.isDefault }
            : { name: '', description: '', memberIds: [], isDefault: false });
        }
      }}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="团队名称" rules={[{ required: true }]}><Input placeholder="例如：完整研发团队" autoFocus /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="memberIds" label="AI 人员">
          <Select mode="multiple" optionFilterProp="label" options={agents.map((agent) => ({ label: `${agent.name} · ${agent.model}`, value: agent.id }))} />
        </Form.Item>
        <Form.Item name="isDefault" label="设为全局默认团队" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}
