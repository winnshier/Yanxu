import { useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Input, Modal, Row, Space, Tag, Typography, message } from 'antd';
import { FolderOpenOutlined, FolderOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ProjectSpaceRestorePreview } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';
import { CreateProjectModal } from '../components/CreateProjectModal.js';

export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [restorePreview, setRestorePreview] = useState<ProjectSpaceRestorePreview | null>(null);
  const [restoreSelectionToken, setRestoreSelectionToken] = useState<string | null>(null);
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const chooseRestoreSource = useMutation({
    mutationFn: async () => {
      const selection = await api.chooseFolder();
      const preview = await api.previewProjectSpaceRestore(selection.token);
      return { preview, selectionToken: selection.token };
    },
    onSuccess: ({ preview, selectionToken }) => {
      setRestorePreview(preview);
      setRestoreSelectionToken(selectionToken);
    },
    onError: (error: Error) => { if (!error.message.includes('取消')) message.error(error.message); },
  });
  const restore = useMutation({
    mutationFn: (selectionToken: string) => api.restoreProjectSpace(selectionToken),
    onSuccess: (result) => {
      setRestorePreview(null);
      setRestoreSelectionToken(null);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      message.success(`已恢复项目和 ${result.restoredTasks} 个任务`);
      void navigate(`/projects/${result.projectId}`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const filtered = (projects.data ?? []).filter((project) => `${project.name} ${project.description}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="page-container projects-page">
      <PageHeader eyebrow="项目资产" title="项目" description="项目是任务、目录、计划和经验沉淀的共同边界。" actions={<Space><Button icon={<FolderOpenOutlined />} loading={chooseRestoreSource.isPending} onClick={() => chooseRestoreSource.mutate()}>从 ProjectSpace 恢复</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建项目</Button></Space>} />
      <div className="toolbar"><Input allowClear prefix={<SearchOutlined />} placeholder="搜索项目" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <QueryState loading={projects.isLoading} error={projects.error} empty={filtered.length === 0} emptyText="还没有项目，先选择一个本地目录创建项目。" onRetry={() => { void projects.refetch(); }}>
        <Row gutter={[16, 16]} className="project-grid">
          {filtered.map((project) => (
            <Col key={project.id} xs={24} md={12} xl={8}>
              <Card hoverable className="project-card" onClick={() => { void navigate(`/projects/${project.id}`); }}>
                <div className="project-icon"><FolderOutlined /></div>
                <Typography.Title level={4}>{project.name}</Typography.Title>
                <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>{project.description || '暂无项目简介'}</Typography.Paragraph>
                <Space wrap><Tag>{project.directories.length} 个目录</Tag>{project.taskSummary.active > 0 && <Tag color="processing">{project.taskSummary.active} 运行中</Tag>}{project.taskSummary.attention > 0 && <Tag color="warning">{project.taskSummary.attention} 待处理</Tag>}</Space>
              </Card>
            </Col>
          ))}
        </Row>
      </QueryState>
      <CreateProjectModal open={open} onClose={() => setOpen(false)} onCreated={(id) => { void navigate(`/projects/${id}`); }} />
      <Modal
        open={Boolean(restorePreview)}
        title="从 ProjectSpace 恢复项目"
        okText="确认恢复"
        cancelText="取消"
        confirmLoading={restore.isPending}
        okButtonProps={{ disabled: !restorePreview?.valid }}
        onCancel={() => {
          setRestorePreview(null);
          setRestoreSelectionToken(null);
        }}
        onOk={() => restoreSelectionToken && restore.mutate(restoreSelectionToken)}
      >
        {restorePreview && <Space direction="vertical" size={12} className="full-width">
          <Alert
            showIcon
            type={restorePreview.valid ? 'success' : 'error'}
            message={restorePreview.valid ? '状态清单和版本文件校验通过' : '该 ProjectSpace 不能恢复'}
            description={restorePreview.valid
              ? '恢复不会覆盖已有同 ID 项目；丢失运行现场的活动任务会安全转为已停止。'
              : restorePreview.issues.join('；')}
          />
          <Descriptions column={1} size="small" items={[
            { key: 'project', label: '项目', children: `${restorePreview.projectName}（${restorePreview.projectId}）` },
            { key: 'generated', label: '清单时间', children: restorePreview.generatedAt ? new Date(restorePreview.generatedAt).toLocaleString() : '—' },
            { key: 'counts', label: '恢复内容', children: `${restorePreview.counts.directories} 个目录、${restorePreview.counts.tasks} 个任务、${restorePreview.counts.plans} 版计划、${restorePreview.counts.artifacts} 个产物、${restorePreview.counts.knowledge} 条知识` },
            { key: 'path', label: 'ProjectSpace', children: <Typography.Text className="mono-text" copyable>{restorePreview.projectSpacePath}</Typography.Text> },
          ]} />
        </Space>}
      </Modal>
    </div>
  );
}
