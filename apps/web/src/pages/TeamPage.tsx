import { useState } from 'react';
import { Avatar, Button, Card, Col, Descriptions, Popconfirm, Row, Space, Tabs, Tag, Typography, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined, TeamOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentProfile, Team } from '@yanxu/contracts';
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
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const builtins = useQuery({ queryKey: ['builtins'], queryFn: api.builtins });
  const executors = useQuery({ queryKey: ['executors'], queryFn: api.executors });
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
  const coverageForTeam = (team: Team) => {
    const memberRoleIds = new Set((agents.data ?? []).filter((agent) => team.memberIds.includes(agent.id)).map((agent) => agent.roleId));
    const covered = (builtins.data?.skills ?? []).filter((skill) => memberRoleIds.has(skill.roleId));
    const uncovered = (builtins.data?.skills ?? []).filter((skill) => !memberRoleIds.has(skill.roleId));
    return { covered, uncovered };
  };

  const items = [
    {
      key: 'agents', label: 'AI 人员', children: <QueryState loading={agents.isLoading} error={agents.error} empty={(agents.data?.length ?? 0) === 0} emptyText="还没有 AI 人员；人员负责把 Role、CLI 和模型绑定在一起。">
        <Row gutter={[16, 16]}>{(agents.data ?? []).map((agent) => {
          const executor = executorForAgent(agent.executor);
          return <Col key={agent.id} xs={24} md={12} xl={8}><Card
            extra={<Space size="small">
              <Button type="text" icon={<EditOutlined />} onClick={() => { setEditingAgent(agent); setAgentModal(true); }}>编辑</Button>
              <Button type="link" onClick={() => setAgentStatus.mutate({ id: agent.id, status: agent.status === 'active' ? 'inactive' : 'active' })}>
                {agent.status === 'active' ? '停用' : '启用'}
              </Button>
              <Popconfirm title="删除这个未被引用的人员？" onConfirm={() => deleteAgent.mutate(agent.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${agent.name}`} />
              </Popconfirm>
            </Space>}
          ><Space align="start"><Avatar size={44} icon={<RobotOutlined />} /><div><Typography.Title level={5}>{agent.name}</Typography.Title><Space wrap><Tag color="blue">{roleName(agent.roleId)}</Tag><Tag>{agent.executor}</Tag><Tag color={agent.permissionMode === 'managed' ? 'purple' : 'default'}>{agent.permissionMode}</Tag><Tag color={agent.status === 'active' ? 'green' : 'default'}>{agent.status === 'active' ? '启用' : '停用'}</Tag></Space><Typography.Paragraph className="card-caption" type="secondary">{agent.model}</Typography.Paragraph><Typography.Paragraph className="card-caption" type="secondary">所属团队：{teamsForAgent(agent.id).map((team) => team.name).join('、') || '未加入团队'}</Typography.Paragraph><Typography.Text type="secondary">CLI：{executor?.health ?? 'unchecked'} · {executor?.lastCheckedAt ? new Date(executor.lastCheckedAt).toLocaleString() : '尚未检测'}</Typography.Text></div></Space></Card></Col>;
        })}</Row>
      </QueryState>,
    },
    {
      key: 'teams', label: '团队', children: <QueryState loading={teams.isLoading} error={teams.error} empty={(teams.data?.length ?? 0) === 0}>
        <Row gutter={[16, 16]}>{(teams.data ?? []).map((team) => {
          const coverage = coverageForTeam(team);
          return <Col key={team.id} xs={24} md={12}><Card
            title={<Space><TeamOutlined />{team.name}{team.isDefault && <Tag color="blue">默认</Tag>}</Space>}
            extra={<Button type="text" icon={<EditOutlined />} onClick={() => { setEditingTeam(team); setTeamModal(true); }}>编辑</Button>}
          ><Typography.Paragraph type="secondary">{team.description || '暂无说明'}</Typography.Paragraph><Typography.Paragraph>{team.memberIds.length} 名 AI 人员</Typography.Paragraph><Typography.Text strong>已覆盖 Skills</Typography.Text><div className="tag-row">{coverage.covered.length ? coverage.covered.map((skill) => <Tag color="green" key={skill.id}>{skill.name}</Tag>) : <Tag>无</Tag>}</div><Typography.Text strong>未覆盖（任务选择后才构成缺口）</Typography.Text><div className="tag-row">{coverage.uncovered.length ? coverage.uncovered.map((skill) => <Tag key={skill.id}>{skill.name}</Tag>) : <Tag color="green">全部覆盖</Tag>}</div></Card></Col>;
        })}</Row>
      </QueryState>,
    },
    {
      key: 'roles', label: 'Role 库', children: <Row gutter={[16, 16]}>{(builtins.data?.roles ?? []).map((role) => <Col key={role.id} xs={24} md={12}><Card title={role.name}><Typography.Paragraph type="secondary">{role.description}</Typography.Paragraph><Descriptions column={1} size="small" items={[{ key: 'skills', label: 'Skills', children: role.skillIds.map((skill) => <Tag key={skill}>{skill}</Tag>) }, { key: 'version', label: '版本', children: role.version }]} /></Card></Col>)}</Row>,
    },
    {
      key: 'skills', label: 'Skill 库', children: <Row gutter={[16, 16]}>{(builtins.data?.skills ?? []).map((skill) => <Col key={skill.id} xs={24} lg={12}><Card title={skill.name} extra={<Space><Tag>{roleName(skill.roleId)}</Tag>{skill.canBlockDelivery && <Tag color="red">可阻断交付</Tag>}</Space>}><Typography.Paragraph type="secondary">{skill.description}</Typography.Paragraph><Typography.Text strong>必需 Artifact</Typography.Text><div className="tag-row">{skill.artifactTypes.map((artifactType) => <Tag color="geekblue" key={artifactType}>{artifactType}</Tag>)}</div><Typography.Text strong>机器校验条件</Typography.Text><div className="tag-row">{skill.completionChecks.map((check) => <Tag color="cyan" key={check}>{check}</Tag>)}</div></Card></Col>)}</Row>,
    },
  ];

  return (
    <div className="page-container">
      <PageHeader eyebrow="模型人员编排" title="AI 团队" description="人员绑定 Role、CLI 与模型；团队只是可复用的人员组合，不是写死的工作流。" actions={<Space><Button icon={<PlusOutlined />} onClick={() => { setEditingTeam(null); setTeamModal(true); }}>创建团队</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setAgentModal(true)}>创建人员</Button></Space>} />
      <Tabs items={items} />
      <CreateAgentModal open={agentModal} roles={builtins.data?.roles ?? []} executors={executors.data ?? []} agent={editingAgent} onClose={() => { setAgentModal(false); setEditingAgent(null); }} />
      <CreateTeamModal open={teamModal} agents={(agents.data ?? []).filter((agent) => agent.status === 'active')} team={editingTeam} onClose={() => { setTeamModal(false); setEditingTeam(null); }} />
    </div>
  );
}
