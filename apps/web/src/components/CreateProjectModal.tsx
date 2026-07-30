import { useState } from 'react';
import { Button, Form, Input, Modal, Space, Typography, message } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectRequest } from '@yanxu/contracts';
import { api } from '../lib/api.js';

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (projectId: string) => void;
}

export function CreateProjectModal({ open, onClose, onCreated }: CreateProjectModalProps) {
  const [form] = Form.useForm<CreateProjectRequest & { directoryDisplayPath: string }>();
  const [picking, setPicking] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createProject,
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      message.success('项目已创建');
      form.resetFields();
      onClose();
      onCreated?.(project.id);
    },
    onError: (error: Error) => message.error(error.message),
  });

  const pickFolder = async () => {
    setPicking(true);
    try {
      const result = await api.chooseFolder();
      form.setFieldValue('directorySelectionToken', result.token);
      form.setFieldValue('directoryDisplayPath', result.displayPath);
    } catch (error) {
      if (error instanceof Error && !error.message.includes('取消')) message.error(error.message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal
      title="创建项目"
      width={560}
      open={open}
      onCancel={onClose}
      okText="创建项目"
      confirmLoading={mutation.isPending}
      onOk={() => {
        void form.validateFields().then((values) => mutation.mutate({
          name: values.name,
          ...(values.description === undefined ? {} : { description: values.description }),
          directorySelectionToken: values.directorySelectionToken,
        }));
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">项目会关联你的本地目录；研序自己的 ProjectSpace 由系统单独管理。</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
          <Input placeholder="例如：订单中台" autoFocus />
        </Form.Item>
        <Form.Item name="description" label="项目简介"><Input.TextArea rows={3} placeholder="项目背景、目标或边界" /></Form.Item>
        <Form.Item name="directorySelectionToken" hidden rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="directoryDisplayPath" label="第一个项目目录" rules={[{ required: true, message: '请选择项目目录' }]}>
          <Input readOnly placeholder="点击右侧按钮选择文件夹" addonAfter={
            <Button type="text" loading={picking} icon={<FolderOpenOutlined />} onClick={() => { void pickFolder(); }}>选择</Button>
          } />
        </Form.Item>
        <Space size="small"><Typography.Text type="secondary">空目录、已有 Git 或普通文档目录都可以。</Typography.Text></Space>
      </Form>
    </Modal>
  );
}
