import { useState } from 'react';
import { DeleteOutlined, PaperClipOutlined } from '@ant-design/icons';
import { Button, Form, Input, List, Modal, Select, Space, Switch, Typography, message } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskInput, FileSelection, Project, Team } from '@yanxu/contracts';
import { api } from '../lib/api.js';

interface CreateTaskModalProps {
  open: boolean;
  projects: Project[];
  teams: Team[];
  initialProjectId?: string;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}

interface TaskFormValues extends CreateTaskInput {
  forbiddenPathsText?: string;
}

export function CreateTaskModal({ open, projects, teams, initialProjectId, onClose, onCreated }: CreateTaskModalProps) {
  const [form] = Form.useForm<TaskFormValues>();
  const [attachments, setAttachments] = useState<FileSelection[]>([]);
  const queryClient = useQueryClient();
  const chooseAttachment = useMutation({
    mutationFn: api.chooseFile,
    onSuccess: (selection) => {
      setAttachments((current) => current.length >= 10 ? current : [...current, selection]);
    },
    onError: (error: Error) => {
      if (!['已取消选择附件。'].includes(error.message)) message.error(error.message);
    },
  });
  const mutation = useMutation({
    mutationFn: (values: TaskFormValues) => {
      const { forbiddenPathsText, ...input } = values;
      const forbiddenPaths = forbiddenPathsText?.split('\n').map((item) => item.trim()).filter(Boolean);
      return api.createTask({
        ...input,
        ...(forbiddenPaths ? { forbiddenPaths } : {}),
        attachmentSelectionTokens: attachments.map((attachment) => attachment.token),
      });
    },
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      message.success(task.status === 'DRAFT' ? '草稿已保存' : '任务已提交分析');
      form.resetFields();
      setAttachments([]);
      onClose();
      onCreated?.(task.id);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const defaultTeam = teams.find((team) => team.isDefault)?.id;
  return (
    <Modal
      title="创建任务"
      width={980}
      className="task-compose-modal"
      open={open}
      onCancel={() => {
        form.resetFields();
        setAttachments([]);
        onClose();
      }}
      okText="保存"
      confirmLoading={mutation.isPending}
      onOk={() => { void form.validateFields().then((values) => mutation.mutate(values)); }}
      destroyOnHidden
      afterOpenChange={(isOpen) => {
        if (isOpen) form.setFieldsValue({
          ...(initialProjectId ? { projectId: initialProjectId } : {}),
          ...(defaultTeam ? { teamId: defaultTeam } : {}),
          submitForAnalysis: true,
        });
      }}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <div className="task-compose-grid">
          <section className="task-compose-main">
            <div className="editor-section-label">需求</div>
            <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}><Input size="large" placeholder="一句话说明要完成什么" /></Form.Item>
            <Form.Item name="description" label="需求描述" rules={[{ required: true, message: '请描述需求' }]}><Input.TextArea rows={10} placeholder="描述背景、功能和你关心的结果。计划阶段会继续澄清关键歧义。" /></Form.Item>
            <Form.Item name="expectedOutput" label="预期产出"><Input.TextArea rows={3} placeholder="选填，例如：可运行功能、接口文档和测试报告" /></Form.Item>
            <Form.Item label="需求附件">
              <Space direction="vertical" className="full-width">
                <Button
                  icon={<PaperClipOutlined />}
                  loading={chooseAttachment.isPending}
                  disabled={attachments.length >= 10}
                  onClick={() => chooseAttachment.mutate()}
                >选择本地文件</Button>
                <List
                  size="small"
                  locale={{ emptyText: '可选；最多 10 个文件，单个不超过 10 MB。文本附件会作为计划上下文。' }}
                  dataSource={attachments}
                  rowKey={(attachment) => attachment.token}
                  renderItem={(attachment) => <List.Item
                    actions={[<Button
                      key="remove"
                      type="text"
                      danger
                      aria-label={`移除附件 ${attachment.fileName}`}
                      icon={<DeleteOutlined />}
                      onClick={() => setAttachments((current) => current.filter((item) => item.token !== attachment.token))}
                    />]}
                  >
                    <List.Item.Meta
                      title={attachment.fileName}
                      description={`${Math.max(1, Math.ceil(attachment.size / 1024))} KB`}
                    />
                  </List.Item>}
                />
              </Space>
            </Form.Item>
          </section>
          <aside className="task-compose-properties">
            <div className="editor-section-label">任务属性</div>
            <Form.Item name="projectId" label="项目" rules={[{ required: true, message: '请选择项目' }]}>
              <Select options={projects.map((project) => ({ label: project.name, value: project.id }))} />
            </Form.Item>
            <Form.Item name="teamId" label="执行团队" rules={[{ required: true, message: '请选择团队' }]}>
              <Select options={teams.map((team) => ({ label: `${team.name}${team.isDefault ? '（默认）' : ''}`, value: team.id }))} />
            </Form.Item>
            <Form.Item name="constraints" label="约束"><Input.TextArea rows={4} placeholder="选填，例如：保持现有 API 兼容" /></Form.Item>
            <Form.Item name="forbiddenPathsText" label="禁止路径"><Input.TextArea rows={4} placeholder="选填，每行一个路径" /></Form.Item>
            <Form.Item name="submitForAnalysis" label="保存后立即提交分析" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Typography.Text type="secondary">提交分析会校验全局协调执行器；仅保存草稿不会调用模型。</Typography.Text>
          </aside>
        </div>
      </Form>
    </Modal>
  );
}
