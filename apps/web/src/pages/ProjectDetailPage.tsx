import { useState } from 'react';
import { Alert, Badge, Button, Card, Descriptions, Empty, Input, List, Modal, Popconfirm, Select, Space, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, FolderAddOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';
import { TaskTrack } from '../components/TaskTrack.js';
import { CreateTaskModal } from '../components/CreateTaskModal.js';

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [taskModal, setTaskModal] = useState(false);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeDraft, setKnowledgeDraft] = useState<{ id: string; title: string; content: string } | null>(null);
  const [profileDirectoryId, setProfileDirectoryId] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<{
    description: string;
    permissionMode: 'inherit' | 'standard' | 'managed';
    forbiddenPaths: string;
  } | null>(null);
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId), enabled: Boolean(projectId) });
  const tasks = useQuery({ queryKey: ['tasks', projectId], queryFn: () => api.tasks(), select: (items) => items.filter((task) => task.projectId === projectId) });
  const knowledge = useQuery({ queryKey: ['knowledge', projectId, knowledgeQuery], queryFn: () => api.knowledge(projectId, knowledgeQuery), enabled: Boolean(projectId) });
  const directoryProfiles = useQuery({ queryKey: ['directory-profiles', projectId], queryFn: () => api.directoryProfiles(projectId), enabled: Boolean(projectId) });
  const projectSpaceOperations = useQuery({ queryKey: ['project-space-operations', projectId], queryFn: () => api.projectSpaceOperations(projectId), enabled: Boolean(projectId) });
  const projectSpaceIntegrity = useQuery({ queryKey: ['project-space-integrity', projectId], queryFn: () => api.projectSpaceIntegrity(projectId), enabled: Boolean(projectId) });
  const projectSettings = useQuery({ queryKey: ['project-settings', projectId], queryFn: () => api.projectSettings(projectId), enabled: Boolean(projectId) });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const addDirectory = useMutation({
    mutationFn: async () => {
      const selection = await api.chooseFolder();
      return api.addDirectory(projectId, selection.token);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['directory-profiles', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      message.success('项目目录已关联');
    },
    onError: (error: Error) => { if (!error.message.includes('取消')) message.error(error.message); },
  });
  const rescan = useMutation({
    mutationFn: api.rescanDirectory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['directory-profiles', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      message.success('目录扫描候选已生成，请确认后应用');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const removeDirectory = useMutation({
    mutationFn: api.removeDirectory,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['directory-profiles', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-integrity', projectId] });
      message.success('已解除目录关联；用户目录和历史证据均未删除');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const updateProjectSettings = useMutation({
    mutationFn: () => {
      if (!settingsDraft) throw new Error('项目设置尚未填写。');
      return api.updateProjectSettings(projectId, {
        description: settingsDraft.description,
        permissionMode: settingsDraft.permissionMode,
        forbiddenPaths: settingsDraft.forbiddenPaths.split('\n').map((item) => item.trim()).filter(Boolean),
      });
    },
    onSuccess: () => {
      setSettingsDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-settings', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-integrity', projectId] });
      message.success('项目设置已保存并写入 ProjectSpace');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const refreshRecoveryPoint = useMutation({
    mutationFn: () => api.refreshProjectSpaceState(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-space-integrity', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      message.success('ProjectSpace 恢复点已刷新');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const confirmProfile = useMutation({
    mutationFn: api.confirmDirectoryProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['directory-profiles', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-space-operations', projectId] });
      message.success('目录认知版本已确认');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const reviewKnowledge = useMutation({
    mutationFn: (input: { id: string; decision: 'accept' | 'reject'; title?: string; content?: string }) => {
      const { id, ...body } = input;
      return api.reviewKnowledge(id, body);
    },
    onSuccess: () => {
      setKnowledgeDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] });
      message.success('项目知识状态已更新');
    },
    onError: (error: Error) => message.error(error.message),
  });

  const data = project.data;
  const items = data ? [
    {
      key: 'overview', label: '概览', children: <div className="detail-grid">
        <Card title="项目状态"><Descriptions column={1} items={[
          { key: 'directories', label: '项目目录', children: `${data.directories.length} 个` },
          { key: 'active', label: '正在推进', children: `${data.taskSummary.active} 个任务` },
          { key: 'attention', label: '需要处理', children: `${data.taskSummary.attention} 个任务` },
          { key: 'space', label: 'ProjectSpace', children: <Typography.Text className="mono-text" copyable>{data.projectSpacePath}</Typography.Text> },
        ]} /></Card>
        <Card title="最近任务">{(tasks.data ?? []).slice(0, 4).length ? <Space direction="vertical" className="full-width">{(tasks.data ?? []).slice(0, 4).map((task) => <TaskTrack key={task.id} task={task} compact />)}</Space> : <Empty description="还没有任务" />}</Card>
      </div>,
    },
    {
      key: 'directories', label: `项目目录 ${data.directories.length}`, children: <Space direction="vertical" size={12} className="full-width">
        {data.directories.map((directory) => {
          const candidate = directoryProfiles.data?.find((profile) =>
            profile.directoryId === directory.id && profile.status === 'candidate');
          return <Card key={directory.id} title={<Space>{directory.displayName}<Badge status={directory.gitInitialized ? 'success' : 'warning'} text={directory.gitInitialized ? 'Git 已初始化' : '未初始化 Git'} /></Space>} extra={<Space>
            <Button icon={<HistoryOutlined />} onClick={() => setProfileDirectoryId(directory.id)}>认知历史</Button>
            <Button icon={<ReloadOutlined />} loading={rescan.isPending} onClick={() => rescan.mutate(directory.id)}>重新扫描</Button>
            <Popconfirm
              title="解除这个目录的项目关联？"
              description="不会删除用户目录或历史证据；未归档任务仍引用时系统会拒绝。"
              onConfirm={() => removeDirectory.mutate(directory.id)}
            >
              <Button danger icon={<DeleteOutlined />} loading={removeDirectory.isPending}>移除</Button>
            </Popconfirm>
          </Space>}>
          <Descriptions column={{ xs: 1, md: 2 }} size="small" items={[
            { key: 'path', label: '用户选择路径', children: <Typography.Text className="mono-text" copyable>{directory.selectedPath}</Typography.Text> },
            { key: 'gitroot', label: 'Git 根目录', children: <Typography.Text className="mono-text">{directory.gitRootPath ?? '—'}</Typography.Text> },
            { key: 'branch', label: '当前分支', children: directory.currentBranch ?? '尚无提交' },
            { key: 'dirty', label: '本地修改', children: <Badge status={directory.isDirty ? 'warning' : 'success'} text={directory.isDirty ? '存在，任务启动时独立冻结基线' : '工作区干净'} /> },
            { key: 'content', label: '内容类型', children: directory.contentTypes.map((item) => <Tag key={item}>{item}</Tag>) },
            { key: 'stack', label: '识别技术栈', children: directory.stack.length ? directory.stack.map((item) => <Tag color="blue" key={item}>{item}</Tag>) : '未限定' },
            { key: 'commands', label: '已识别命令', children: Object.entries(directory.commands).length ? Object.entries(directory.commands).map(([name, command]) => <Tag key={name}>{name}: {command}</Tag>) : '未识别' },
            { key: 'scannedAt', label: '最近扫描', children: new Date(directory.scannedAt).toLocaleString() },
          ]} />
          {candidate && <Alert
            className="settings-card"
            type="info"
            showIcon
            message={`目录认知候选 v${candidate.version}`}
            description={<Space direction="vertical">
              <Typography.Text>技术栈：{candidate.content.stack.join('、') || '未识别'}；命令：{Object.keys(candidate.content.commands).join('、') || '未识别'}</Typography.Text>
              <Button size="small" type="primary" loading={confirmProfile.isPending} onClick={() => confirmProfile.mutate(candidate.id)}>确认并应用</Button>
            </Space>}
          />}
        </Card>;
        })}
        <Button block type="dashed" icon={<FolderAddOutlined />} loading={addDirectory.isPending} onClick={() => addDirectory.mutate()}>添加项目目录</Button>
      </Space>,
    },
    { key: 'tasks', label: '任务', children: (tasks.data?.length ?? 0) > 0 ? <Space direction="vertical" size={12} className="full-width">{tasks.data?.map((task) => <TaskTrack key={task.id} task={task} />)}</Space> : <Empty description="该项目还没有任务" /> },
    {
      key: 'knowledge', label: '项目知识', children: <>
        <Input.Search allowClear placeholder="按需检索项目认知、决策和经验" onSearch={setKnowledgeQuery} className="knowledge-search" />
        <List dataSource={knowledge.data ?? []} locale={{ emptyText: '还没有确认的项目知识；完成任务后会生成候选。' }} renderItem={(item) => <List.Item {...(['candidate', 'active'].includes(item.status) ? { actions: [
          <Button key="accept" type="link" onClick={() => setKnowledgeDraft({ id: item.id, title: item.title, content: item.content })}>
            {item.status === 'active' ? '修订新版本' : '修订并确认'}
          </Button>,
          ...(item.status === 'candidate' ? [
            <Popconfirm key="reject" title="驳回这个知识候选？" onConfirm={() => reviewKnowledge.mutate({ id: item.id, decision: 'reject' })}><Button type="link" danger>驳回</Button></Popconfirm>,
          ] : []),
        ] } : {})}><List.Item.Meta title={<Space>{item.title}<Tag>{item.category}</Tag><Tag color={item.status === 'active' ? 'green' : item.status === 'candidate' ? 'gold' : 'default'}>{item.status}</Tag><Tag>v{item.version}</Tag></Space>} description={<Typography.Paragraph className="knowledge-content">{item.content}</Typography.Paragraph>} /></List.Item>} />
      </>,
    },
    { key: 'settings', label: 'ProjectSpace', children: <Space direction="vertical" size={12} className="full-width">
      <Card
        title="完整性检查"
        extra={<Space><Button size="small" loading={refreshRecoveryPoint.isPending} onClick={() => refreshRecoveryPoint.mutate()}>刷新恢复点</Button><Button size="small" icon={<ReloadOutlined />} loading={projectSpaceIntegrity.isFetching} onClick={() => { void projectSpaceIntegrity.refetch(); }}>重新检查</Button></Space>}
      >
        {projectSpaceIntegrity.data
          ? <Space direction="vertical" className="full-width">
            <Alert
              showIcon
              type={projectSpaceIntegrity.data.status === 'healthy' ? 'success' : 'error'}
              message={projectSpaceIntegrity.data.status === 'healthy' ? 'ProjectSpace 版本文件与索引一致' : `发现 ${projectSpaceIntegrity.data.issues.length} 处外部变化`}
              description={`已校验 ${projectSpaceIntegrity.data.checkedArtifacts} 个版本化文件；Git 工作区${projectSpaceIntegrity.data.gitDirty ? '存在未提交变化' : '干净'}。`}
            />
            {projectSpaceIntegrity.data.issues.length > 0 && <List
              size="small"
              dataSource={projectSpaceIntegrity.data.issues}
              rowKey={(issue) => `${issue.entityType}:${issue.entityId}`}
              renderItem={(issue) => <List.Item>
                <List.Item.Meta
                  title={<Space><Tag color="red">{issue.reason}</Tag><Typography.Text>{issue.entityType} · {issue.entityId}</Typography.Text></Space>}
                  description={<Typography.Text className="mono-text" type="secondary">{issue.artifactPath}</Typography.Text>}
                />
              </List.Item>}
            />}
          </Space>
          : <Typography.Text type="secondary">正在检查版本文件和内容哈希…</Typography.Text>}
      </Card>
      <Card title="版本操作日志">
        <Typography.Paragraph type="secondary">需求、计划、产物、报告和知识每次写入都会形成独立 Git 提交，并在系统库中保存操作结果。</Typography.Paragraph>
      <List
        size="small"
        locale={{ emptyText: '暂无操作记录' }}
        dataSource={projectSpaceOperations.data ?? []}
        rowKey={(operation) => operation.id}
        renderItem={(operation) => <List.Item>
          <List.Item.Meta
            title={<Space><Typography.Text>{operation.operation}</Typography.Text><Tag color={operation.status === 'succeeded' ? 'green' : 'red'}>{operation.status}</Tag></Space>}
            description={<Typography.Text className="mono-text" type="secondary">{operation.commitHash?.slice(0, 12) ?? operation.error ?? '无提交'} · {new Date(operation.createdAt).toLocaleString()}</Typography.Text>}
          />
        </List.Item>}
      />
      </Card>
    </Space> },
  ] : [];

  return (
    <div className="page-container">
      <QueryState loading={project.isLoading} error={project.error} onRetry={() => { void project.refetch(); }}>
        {data && <><PageHeader eyebrow="项目" title={data.name} description={data.description || '暂无项目简介'} actions={<Space><Button icon={<SettingOutlined />} onClick={() => setSettingsDraft({
          description: data.description,
          permissionMode: projectSettings.data?.permissionMode ?? 'inherit',
          forbiddenPaths: projectSettings.data?.forbiddenPaths.join('\n') ?? '',
        })}>项目设置</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setTaskModal(true)}>创建任务</Button></Space>} /><Tabs items={items} /></>}
      </QueryState>
      <CreateTaskModal open={taskModal} projects={data ? [data] : []} teams={teams.data ?? []} initialProjectId={projectId} onClose={() => setTaskModal(false)} onCreated={(id) => { void navigate(`/tasks/${id}`); }} />
      <Modal
        open={Boolean(knowledgeDraft)}
        title="修订并确认项目知识"
        okText="确认并纳入检索"
        cancelText="取消"
        confirmLoading={reviewKnowledge.isPending}
        okButtonProps={{ disabled: !knowledgeDraft?.title.trim() || !knowledgeDraft?.content.trim() }}
        onCancel={() => setKnowledgeDraft(null)}
        onOk={() => knowledgeDraft && reviewKnowledge.mutate({ ...knowledgeDraft, decision: 'accept' })}
      >
        <Space direction="vertical" className="full-width" size={12}>
          <Typography.Text type="secondary">保存会创建新的不可变版本并替代旧版本；只有当前有效版本会进入项目检索上下文。</Typography.Text>
          <Input value={knowledgeDraft?.title ?? ''} placeholder="知识标题" onChange={(event) => setKnowledgeDraft((current) => current ? { ...current, title: event.target.value } : current)} />
          <Input.TextArea value={knowledgeDraft?.content ?? ''} autoSize={{ minRows: 8, maxRows: 16 }} placeholder="知识内容与适用边界" onChange={(event) => setKnowledgeDraft((current) => current ? { ...current, content: event.target.value } : current)} />
        </Space>
      </Modal>
      <Modal
        open={Boolean(profileDirectoryId)}
        title="目录认知版本历史"
        footer={null}
        width={760}
        onCancel={() => setProfileDirectoryId(null)}
      >
        <List
          dataSource={(directoryProfiles.data ?? []).filter((profile) => profile.directoryId === profileDirectoryId)}
          locale={{ emptyText: '暂无目录认知版本' }}
          rowKey={(profile) => profile.id}
          renderItem={(profile) => <List.Item>
            <List.Item.Meta
              title={<Space><Typography.Text>v{profile.version}</Typography.Text><Tag color={profile.status === 'confirmed' ? 'green' : profile.status === 'candidate' ? 'gold' : 'default'}>{profile.status}</Tag></Space>}
              description={<Space direction="vertical" size={2}>
                <Typography.Text type="secondary">{new Date(profile.createdAt).toLocaleString()} · {profile.contentHash.slice(0, 12)}</Typography.Text>
                <Typography.Text>技术栈：{profile.content.stack.join('、') || '未识别'}</Typography.Text>
                <Typography.Text>命令：{Object.entries(profile.content.commands).map(([name, command]) => `${name}=${command}`).join('；') || '未识别'}</Typography.Text>
                <Typography.Text className="mono-text" type="secondary">{profile.artifactPath}</Typography.Text>
              </Space>}
            />
          </List.Item>}
        />
      </Modal>
      <Modal
        open={Boolean(settingsDraft)}
        title="项目设置"
        okText="保存设置"
        cancelText="取消"
        confirmLoading={updateProjectSettings.isPending}
        onCancel={() => setSettingsDraft(null)}
        onOk={() => updateProjectSettings.mutate()}
      >
        <Space direction="vertical" size={12} className="full-width">
          <div>
            <Typography.Text strong>项目说明</Typography.Text>
            <Input.TextArea
              className="settings-card"
              rows={3}
              value={settingsDraft?.description ?? ''}
              onChange={(event) => setSettingsDraft((current) => current ? { ...current, description: event.target.value } : current)}
            />
          </div>
          <div>
            <Typography.Text strong>项目级权限模式</Typography.Text>
            <Select
              className="full-width settings-card"
              value={settingsDraft?.permissionMode ?? 'inherit'}
              options={[
                { label: '继承人员设置', value: 'inherit' },
                { label: '标准询问模式', value: 'standard' },
                { label: '全托管模式', value: 'managed' },
              ]}
              onChange={(permissionMode) => setSettingsDraft((current) => current ? { ...current, permissionMode } : current)}
            />
          </div>
          <div>
            <Typography.Text strong>项目禁止路径</Typography.Text>
            <Typography.Paragraph type="secondary">每行一个相对路径或模式；会与任务级禁止路径合并并冻结到运行快照。</Typography.Paragraph>
            <Input.TextArea
              rows={5}
              placeholder=".env&#10;secrets/**"
              value={settingsDraft?.forbiddenPaths ?? ''}
              onChange={(event) => setSettingsDraft((current) => current ? { ...current, forbiddenPaths: event.target.value } : current)}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}
