import { useState } from 'react';
import { Avatar, Button, Card, Col, Descriptions, Input, Modal, Popconfirm, Row, Space, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, FolderOpenOutlined, GithubOutlined, PlusOutlined, RobotOutlined, TeamOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentProfile, RoleTemplateChangePreview, Team } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';
import { CreateAgentModal } from '../components/CreateAgentModal.js';
import { CreateTeamModal } from '../components/CreateTeamModal.js';

export function TeamPage() {
  const [agentModal, setAgentModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentProfile | null>(null);
  const [teamModal, setTeamModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [roleAddress, setRoleAddress] = useState('');
  const [rolePreview, setRolePreview] = useState<RoleTemplateChangePreview | null>(null);
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const builtins = useQuery({ queryKey: ['builtins'], queryFn: api.builtins });
  const roles = useQuery({ queryKey: ['role-templates'], queryFn: api.roleTemplates });
  const executors = useQuery({ queryKey: ['executors'], queryFn: api.executors });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const roleName = (roleId: string) => builtins.data?.roles.find((role) => role.id === roleId)?.name ?? roleId;
  const teamsForAgent = (agentId: string) => (teams.data ?? []).filter((team) => team.memberIds.includes(agentId));
  const executorForAgent = (executorId: string) => executors.data?.find((executor) => executor.id === executorId);
  const setAgentStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AgentProfile['status'] }) => api.setAgentStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      message.success('人员状态已更新');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const deleteAgent = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      message.success('未被引用的人员已删除');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importRoles = useMutation({
    mutationFn: api.importGitHubRoles,
    onSuccess: (data) => {
      setRoleAddress('');
      void queryClient.invalidateQueries({ queryKey: ['role-templates'] });
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success(`已生成 ${data.length} 个待审查 RoleTemplate 草稿`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importLocalRoles = useMutation({
    mutationFn: async () => {
      const selection = await api.chooseFolder();
      return api.importLocalRoles(selection.token);
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['role-templates'] });
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success(`已从本地目录生成 ${data.length} 个待审查 RoleTemplate 草稿`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const installRole = useMutation({
    mutationFn: (roleId: string) => api.installRoleTemplate(roleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['role-templates'] });
      void queryClient.invalidateQueries({ queryKey: ['builtins'] });
      message.success('RoleTemplate 已审查安装，可以创建 AI 人员');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const loadRolePreview = useMutation({
    mutationFn: api.roleTemplateChangePreview,
    onSuccess: setRolePreview,
    onError: (error: Error) => message.error(error.message),
  });
  const items = [
    {
      key: 'agents', label: 'AI 人员', children: <QueryState loading={agents.isLoading} error={agents.error} empty={(agents.data?.length ?? 0) === 0} emptyText="还没有 AI 人员；人员负责把 Role、CLI 和模型绑定在一起。">
        <Row gutter={[16, 16]} className="team-grid">{(agents.data ?? []).map((agent) => {
          const executor = executorForAgent(agent.executor);
          return <Col key={agent.id} xs={24} lg={12} xxl={8}><Card
            className="agent-card"
            title={<Space><Avatar size={32} icon={<RobotOutlined />} /><Typography.Text strong>{agent.name}</Typography.Text></Space>}
            extra={<Space size="small" className="agent-card-actions">
              <Button type="text" icon={<EditOutlined />} onClick={() => { setEditingAgent(agent); setAgentModal(true); }}>编辑</Button>
              <Button type="link" onClick={() => setAgentStatus.mutate({ id: agent.id, status: agent.status === 'active' ? 'inactive' : 'active' })}>
                {agent.status === 'active' ? '停用' : '启用'}
              </Button>
              <Popconfirm title="删除这个未被引用的人员？" onConfirm={() => deleteAgent.mutate(agent.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${agent.name}`} />
              </Popconfirm>
            </Space>}
          ><div className="agent-card-content"><Space wrap><Tag color="blue">{roleName(agent.roleId)}</Tag><Tag>{agent.executor}</Tag><Tag color={agent.permissionMode === 'managed' ? 'purple' : 'default'}>{agent.permissionMode}</Tag><Tag color={agent.status === 'active' ? 'green' : 'default'}>{agent.status === 'active' ? '启用' : '停用'}</Tag></Space><Typography.Paragraph className="card-caption agent-model" type="secondary">{agent.model}</Typography.Paragraph><div className="tag-row">{agent.defaultCapabilityIds.map((id) => <Tag color="purple" key={id}>{capabilities.data?.find((item) => item.id === id)?.name ?? id}</Tag>)}</div><Typography.Paragraph className="card-caption" type="secondary">所属团队：{teamsForAgent(agent.id).map((team) => team.name).join('、') || '未加入团队'}</Typography.Paragraph><Typography.Text type="secondary">CLI：{executor?.health ?? 'unchecked'} · {executor?.lastCheckedAt ? new Date(executor.lastCheckedAt).toLocaleString() : '尚未检测'}</Typography.Text></div></Card></Col>;
        })}</Row>
      </QueryState>,
    },
    {
      key: 'teams', label: '团队', children: <QueryState loading={teams.isLoading} error={teams.error} empty={(teams.data?.length ?? 0) === 0}>
        <Row gutter={[16, 16]} className="team-grid">{(teams.data ?? []).map((team) => {
          const members = (agents.data ?? []).filter((agent) => team.memberIds.includes(agent.id));
          return <Col key={team.id} xs={24} lg={12}><Card className="team-card"
            title={<Space><TeamOutlined />{team.name}{team.isDefault && <Tag color="blue">默认</Tag>}</Space>}
            extra={<Button type="text" icon={<EditOutlined />} onClick={() => { setEditingTeam(team); setTeamModal(true); }}>编辑</Button>}
          ><Typography.Paragraph type="secondary">{team.description || '暂无说明'}</Typography.Paragraph><Typography.Paragraph>{team.memberIds.length} 名候选 AI 人员</Typography.Paragraph><Typography.Text strong>成员池</Typography.Text><div className="tag-row">{members.length ? members.map((agent) => <Tag color="blue" key={agent.id}>{agent.name} · {roleName(agent.roleId)}</Tag>) : <Tag>暂无成员</Tag>}</div><Typography.Paragraph type="secondary" className="card-caption">计划协调器按任务目标选择人员；角色用于分工建议，不再按 Skill 覆盖率阻断任务。</Typography.Paragraph></Card></Col>;
        })}</Row>
      </QueryState>,
    },
    {
      key: 'roles', label: 'Role 库', children: <>
        <Card className="settings-card" title="从 GitHub 导入角色草稿">
          <Typography.Paragraph type="secondary">识别 Claude Code 子代理、OpenCode Agent、GitHub Agent Profile 与纯提示词角色。导入只生成草稿，不会自动激活。</Typography.Paragraph>
          <Space.Compact block><Input value={roleAddress} onChange={(event) => setRoleAddress(event.target.value)} placeholder="https://github.com/org/repo 或具体 tree 子目录" onPressEnter={() => roleAddress.trim() && importRoles.mutate(roleAddress.trim())} /><Button type="primary" icon={<GithubOutlined />} loading={importRoles.isPending} disabled={!roleAddress.trim()} onClick={() => importRoles.mutate(roleAddress.trim())}>读取并生成草稿</Button><Button icon={<FolderOpenOutlined />} loading={importLocalRoles.isPending} onClick={() => importLocalRoles.mutate()}>选择本地目录</Button></Space.Compact>
        </Card>
        <QueryState loading={roles.isLoading} error={roles.error} empty={(roles.data?.length ?? 0) === 0} emptyText="暂无 RoleTemplate。">
          <Row gutter={[16, 16]} className="library-grid">{(roles.data ?? []).map((role) => <Col key={role.id} xs={24} lg={12}><Card className="library-card" title={<Space wrap>{role.name}{role.origin === 'builtin' && <Tag>内置</Tag>}{role.lifecycleStatus === 'draft' && <Tag color="gold">待审查</Tag>}{role.lifecycleStatus === 'installed' && <Tag color="green">已安装</Tag>}{role.parseStatus === 'view_only' && <Tag>仅查看</Tag>}{role.parseStatus === 'incompatible' && <Tag color="red">不兼容</Tag>}</Space>} extra={<Space>{role.origin === 'external' && <Button loading={loadRolePreview.isPending} onClick={() => loadRolePreview.mutate(role.id)}>版本变更</Button>}{role.origin === 'external' && role.lifecycleStatus === 'draft' && role.parseStatus === 'valid' && <Popconfirm title="确认审查并安装这个角色？" description="安装角色不会自动安装或启用其依赖能力。" onConfirm={() => installRole.mutate(role.id)}><Button type="primary" loading={installRole.isPending}>审查并安装</Button></Popconfirm>}</Space>}>
            <Typography.Paragraph type="secondary">{role.description || '暂无描述'}</Typography.Paragraph>
            {role.parseError && <Typography.Paragraph type={role.parseStatus === 'incompatible' ? 'danger' : 'secondary'}>{role.parseError}</Typography.Paragraph>}
            <Typography.Text strong>责任边界</Typography.Text><div>{role.responsibilities.length ? role.responsibilities.map((item) => <Typography.Paragraph key={item} className="card-caption">• {item}</Typography.Paragraph>) : <Typography.Paragraph className="card-caption" type="secondary">导入内容未声明责任列表，以基础指令为准。</Typography.Paragraph>}</div>
            {role.instructions && <Typography.Paragraph ellipsis={{ rows: 5, expandable: true, symbol: '展开基础指令' }} className="card-caption">{role.instructions}</Typography.Paragraph>}
            <div className="tag-row">{role.compatibility.map((item) => <Tag color="blue" key={item}>{item}</Tag>)}{role.dependencyNames.map((item) => <Tag color="purple" key={item}>依赖 {item}</Tag>)}</div>
            <Descriptions column={1} size="small" items={[{ key: 'format', label: '格式', children: role.format }, { key: 'version', label: '版本', children: role.version }, { key: 'source', label: '来源', children: <Typography.Text className="mono-text description-path" ellipsis={{ tooltip: role.source.ref }}>{role.source.ref}</Typography.Text> }]} />
          </Card></Col>)}</Row>
        </QueryState>
      </>,
    },
    {
      key: 'skills', label: '旧版 Skill 库', children: <><Typography.Paragraph type="secondary">仅用于兼容历史任务；新任务使用 WorkUnit，不按固定 Skill 契约编排。</Typography.Paragraph><Row gutter={[16, 16]} className="library-grid">{(builtins.data?.skills ?? []).map((skill) => <Col key={skill.id} xs={24} lg={12}><Card className="library-card" title={skill.name} extra={<Tag>{roleName(skill.roleId)}</Tag>}><Typography.Paragraph type="secondary">{skill.description}</Typography.Paragraph></Card></Col>)}</Row></>,
    },
  ];

  return (
    <div className="page-container team-page">
      <PageHeader eyebrow="模型人员编排" title="AI 团队" description="人员绑定 Role、CLI 与模型；团队只是可复用的人员组合，不是写死的工作流。" actions={<Space><Button icon={<PlusOutlined />} onClick={() => { setEditingTeam(null); setTeamModal(true); }}>创建团队</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setAgentModal(true)}>创建人员</Button></Space>} />
      <Tabs items={items} />
      <CreateAgentModal open={agentModal} roles={builtins.data?.roles ?? []} executors={executors.data ?? []} capabilities={capabilities.data ?? []} agent={editingAgent} onClose={() => { setAgentModal(false); setEditingAgent(null); }} />
      <CreateTeamModal open={teamModal} agents={(agents.data ?? []).filter((agent) => agent.status === 'active')} team={editingTeam} onClose={() => { setTeamModal(false); setEditingTeam(null); }} />
      <Modal title="RoleTemplate 版本变更" open={Boolean(rolePreview)} footer={null} onCancel={() => setRolePreview(null)}>
        {rolePreview && <><Descriptions column={1} items={[{ key: 'current', label: '当前版本', children: `${rolePreview.current.version} · ${rolePreview.current.contentHash.slice(0, 12)}` }, { key: 'previous', label: '上一版本', children: rolePreview.previous ? `${rolePreview.previous.version} · ${rolePreview.previous.contentHash.slice(0, 12)}` : '首次导入' }, { key: 'fields', label: '变化字段', children: rolePreview.changedFields.join('、') || '无' }]} /><Typography.Text strong>基础指令新增</Typography.Text>{rolePreview.instructionChanges.added.map((line) => <Typography.Paragraph className="card-caption" key={`add-${line}`}>+ {line}</Typography.Paragraph>)}<Typography.Text strong>基础指令移除</Typography.Text>{rolePreview.instructionChanges.removed.map((line) => <Typography.Paragraph className="card-caption" key={`remove-${line}`}>− {line}</Typography.Paragraph>)}</>}
      </Modal>
    </div>
  );
}
