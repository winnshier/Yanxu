import { useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Dropdown, Empty, Input, Modal, Popconfirm, Segmented, Select, Space, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  FolderOpenOutlined,
  GithubOutlined,
  ImportOutlined,
  InfoCircleFilled,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capability } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { groupCapabilities, installedCapabilityForGroup, selectedCapabilityForGroup } from '../lib/capability-groups.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';

const sourceTypeLabel: Record<Capability['source']['type'], string> = {
  opencode: 'OpenCode 配置',
  claude: 'Claude 配置',
  builtin: '研序内置',
  github: 'GitHub',
  zip: 'ZIP 文件',
  local_directory: '本地目录',
};

function capabilityStatus(capability: Capability) {
  if (capability.parseStatus === 'invalid') {
    return { className: 'is-error', icon: <ExclamationCircleFilled />, label: '配置无效' };
  }
  if (capability.security.containsLiteralSecrets) {
    return { className: 'is-warning', icon: <ExclamationCircleFilled />, label: '需处理凭据' };
  }
  if (capability.lifecycleStatus === 'installed') {
    return { className: 'is-success', icon: <CheckCircleFilled />, label: '已安装' };
  }
  return { className: 'is-pending', icon: <InfoCircleFilled />, label: '待安装' };
}

function sourceLabel(capability: Capability): string {
  return `${sourceTypeLabel[capability.source.type]}${capability.lifecycleStatus === 'installed' ? ' · 已安装' : ''} · ${capability.source.ref}`;
}

function displayManifestValue(value: unknown, fallback = '未声明'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function CapabilityCenterPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'all' | 'skill' | 'mcp'>('all');
  const [lifecycle, setLifecycle] = useState<'all' | 'installed' | 'not_installed'>('all');
  const [query, setQuery] = useState('');
  const [sourceSelections, setSourceSelections] = useState<Record<string, string>>({});
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubAddress, setGithubAddress] = useState('');
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });
  const discover = useMutation({
    mutationFn: () => api.discoverCapabilities(),
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success(`扫描完成：发现 ${report.discovered}，更新 ${report.updated}，无效 ${report.invalid}`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importLocal = useMutation({
    mutationFn: async () => {
      const selection = await api.chooseFolder();
      return api.importLocalSkill(selection.token);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success('本地 Skill 已导入为待审查草稿，尚未安装或启用');
    },
    onError: (error: Error) => { if (!error.message.includes('取消')) message.error(error.message); },
  });
  const install = useMutation({
    mutationFn: api.installCapability,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      void queryClient.invalidateQueries({ queryKey: ['role-templates'] });
      void queryClient.invalidateQueries({ queryKey: ['builtins'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ predicate: (item) => item.queryKey[0] === 'project-capabilities' });
      message.success('能力已安装到研序托管目录');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const uninstall = useMutation({
    mutationFn: api.uninstallCapability,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      void queryClient.invalidateQueries({ queryKey: ['role-templates'] });
      void queryClient.invalidateQueries({ queryKey: ['builtins'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ predicate: (item) => item.queryKey[0] === 'project-capabilities' });
      message.success('能力已卸载；保留托管副本用于审计和重新安装，后续调用不会再装载');
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importGitHub = useMutation({
    mutationFn: () => api.importGitHubSkills(githubAddress.trim()),
    onSuccess: (items) => {
      setGithubOpen(false);
      setGithubAddress('');
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success(`已导入 ${items.length} 个 Skill 草稿，请审查后安装`);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const importZip = useMutation({
    mutationFn: async () => {
      const selection = await api.chooseFile();
      return api.importZipSkills(selection.token);
    },
    onSuccess: (items) => {
      void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
      message.success(`已从 ZIP 导入 ${items.length} 个 Skill 草稿，请审查后安装`);
    },
    onError: (error: Error) => { if (!error.message.includes('取消')) message.error(error.message); },
  });
  const groups = useMemo(() => groupCapabilities(capabilities.data ?? []), [capabilities.data]);
  const filtered = useMemo(() => groups.map((group) => ({
    group,
    capability: selectedCapabilityForGroup(group, sourceSelections[group.key]),
    installedCapability: installedCapabilityForGroup(group),
  })).filter(({ group, installedCapability }) => {
    if (kind !== 'all' && group.kind !== kind) return false;
    if (lifecycle === 'installed' && !installedCapability) return false;
    if (lifecycle === 'not_installed' && installedCapability) return false;
    const needle = query.trim().toLocaleLowerCase();
    return !needle || group.variants.some((item) =>
      `${item.name}\n${item.description}\n${item.source.ref}`.toLocaleLowerCase().includes(needle));
  }), [groups, kind, lifecycle, query, sourceSelections]);
  const summary = useMemo(() => {
    return {
      total: groups.length,
      sources: capabilities.data?.length ?? 0,
      skills: groups.filter((item) => item.kind === 'skill').length,
      mcps: groups.filter((item) => item.kind === 'mcp').length,
      installed: groups.filter((item) => installedCapabilityForGroup(item)).length,
      opencode: groups.filter((item) => item.variants.some((variant) => variant.compatibility.includes('opencode'))).length,
      claude: groups.filter((item) => item.variants.some((variant) => variant.compatibility.includes('claude'))).length,
    };
  }, [capabilities.data?.length, groups]);

  return <div className="page-container capability-center-page">
    <PageHeader
      eyebrow="能力资产"
      title="能力中心"
      description="统一发现 OpenCode 与 Claude Code 的 Skill / MCP；安装后由项目显式启用，任务确认时冻结版本。"
      actions={<Space wrap>
        <Dropdown menu={{
          items: [
            { key: 'local', icon: <FolderOpenOutlined />, label: '导入本地 Skill' },
            { key: 'zip', icon: <UploadOutlined />, label: '从 ZIP 导入' },
            { key: 'github', icon: <GithubOutlined />, label: '从 GitHub 导入' },
          ],
          onClick: ({ key }) => {
            if (key === 'local') importLocal.mutate();
            if (key === 'zip') importZip.mutate();
            if (key === 'github') setGithubOpen(true);
          },
        }} trigger={['click']}>
          <Button icon={<ImportOutlined />} loading={importLocal.isPending || importZip.isPending}>导入能力</Button>
        </Dropdown>
        <Button type="primary" icon={<ReloadOutlined />} loading={discover.isPending} onClick={() => discover.mutate()}>扫描本机能力</Button>
      </Space>}
    />
    <section className="module-overview-bar capability-summary" aria-label="能力概况">
      <div className="capability-summary-total"><strong>{summary.total}</strong><span>项逻辑能力 · {summary.sources} 个来源</span></div>
      <div className="capability-summary-metrics">
        <button type="button" className={`capability-metric is-all ${kind === 'all' ? 'is-active' : ''}`} onClick={() => setKind('all')}>全部 <strong>{summary.total}</strong></button>
        <button type="button" className={`capability-metric is-skill ${kind === 'skill' ? 'is-active' : ''}`} onClick={() => setKind('skill')}>Skill <strong>{summary.skills}</strong></button>
        <button type="button" className={`capability-metric is-mcp ${kind === 'mcp' ? 'is-active' : ''}`} onClick={() => setKind('mcp')}>MCP <strong>{summary.mcps}</strong></button>
        <button type="button" className={`capability-metric is-installed ${lifecycle === 'installed' ? 'is-active' : ''}`} onClick={() => setLifecycle(lifecycle === 'installed' ? 'all' : 'installed')}>已安装 <strong>{summary.installed}</strong></button>
        <span className="capability-metric is-opencode">OpenCode <strong>{summary.opencode}</strong></span>
        <span className="capability-metric is-claude">Claude <strong>{summary.claude}</strong></span>
      </div>
    </section>
    <div className="capability-notice"><SafetyCertificateOutlined />扫描只读取元数据，不执行能力脚本；安装后仍需由具体项目显式启用。</div>
    <QueryState loading={capabilities.isLoading} error={capabilities.error} onRetry={() => { void capabilities.refetch(); }}>
      <section className="capability-library" aria-label="能力列表">
        <div className="capability-library-toolbar">
          <Input.Search className="capability-search" allowClear placeholder="搜索名称、说明或来源" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Space wrap>
            <Typography.Text type="secondary">当前显示 {filtered.length} 项</Typography.Text>
            <Segmented value={kind} onChange={(value) => setKind(value as typeof kind)} options={[
              { label: '全部', value: 'all' }, { label: 'Skill', value: 'skill' }, { label: 'MCP', value: 'mcp' },
            ]} />
            <Segmented value={lifecycle} onChange={(value) => setLifecycle(value as typeof lifecycle)} options={[
              { label: '全部状态', value: 'all' }, { label: '已安装', value: 'installed' }, { label: '未安装', value: 'not_installed' },
            ]} />
          </Space>
        </div>
        {filtered.length === 0 ? <Empty description="尚未发现能力，先扫描本机配置或导入本地 Skill" /> : <div className="capability-list">
          <div className="capability-list-header" aria-hidden="true">
            <span />
            <span>能力与来源</span>
            <span>兼容 CLI</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {filtered.map(({ group, capability, installedCapability }) => {
            const status = installedCapability && installedCapability.id !== capability.id
              ? { className: 'is-warning', icon: <ExclamationCircleFilled />, label: '已安装其他来源' }
              : capabilityStatus(capability);
            return <article className="capability-row" key={group.key}>
              <div className={`capability-kind-icon is-${capability.kind}`} aria-hidden="true">
                {capability.kind === 'skill' ? <ToolOutlined /> : <ApiOutlined />}
              </div>
              <div className="capability-identity">
                <div className="capability-name-line">
                  <Typography.Text strong>{capability.name}</Typography.Text>
                  <Tag variant="filled">{capability.kind.toUpperCase()}</Tag>
                  {group.variants.length > 1 && <Tag variant="filled" color="blue">{group.variants.length} 个来源</Tag>}
                  {capability.security.localCredentialBindings > 0 && <Tag variant="filled" color="green" icon={<SafetyCertificateOutlined />}>本机凭据 {capability.security.localCredentialBindings}</Tag>}
                </div>
                <Typography.Text type="secondary" ellipsis title={capability.description || '暂无说明'}>{capability.description || '暂无说明'}</Typography.Text>
                {group.variants.length > 1 ? <Select
                  className="capability-source-select"
                  size="small"
                  value={capability.id}
                  title={capability.source.ref}
                  onChange={(capabilityId) => setSourceSelections((current) => ({ ...current, [group.key]: capabilityId }))}
                  options={group.variants.map((variant) => ({ label: sourceLabel(variant), value: variant.id }))}
                /> : <Typography.Text className="capability-source" type="secondary" ellipsis title={capability.source.ref}>{sourceLabel(capability)}</Typography.Text>}
              </div>
              <div className="capability-compatibility" aria-label="兼容 CLI">
                {capability.compatibility.map((executor) => <span className={`executor-pill is-${executor}`} key={executor}>{executor === 'opencode' ? 'OpenCode' : 'Claude'}</span>)}
              </div>
              <div className={`capability-status ${status.className}`}>{status.icon}<span>{status.label}</span></div>
              <div className="capability-row-actions">
                <Button type="text" onClick={() => setSelectedCapability(capability)}>详情</Button>
                {capability.lifecycleStatus !== 'installed' && capability.parseStatus === 'valid' && !capability.security.containsLiteralSecrets
                  ? <Button type="primary" size="small" loading={install.isPending && install.variables === capability.id} onClick={() => install.mutate(capability.id)}>{installedCapability ? '切换来源' : '安装'}</Button>
                  : null}
                {capability.lifecycleStatus === 'installed' ? <Popconfirm
                  title={`卸载 ${capability.name}？`}
                  description="项目中的该能力会同步停用，后续任务调用不会再挂载；托管副本保留用于审计和重装。"
                  onConfirm={() => uninstall.mutate(capability.id)}
                ><Button danger type="text" size="small" loading={uninstall.isPending && uninstall.variables === capability.id}>卸载</Button></Popconfirm> : null}
              </div>
            </article>;
          })}
        </div>}
      </section>
    </QueryState>
    <Modal
      title="从 GitHub 导入标准 Skill"
      open={githubOpen}
      okText="只读扫描并导入草稿"
      cancelText="取消"
      confirmLoading={importGitHub.isPending}
      okButtonProps={{ disabled: !githubAddress.trim() }}
      onCancel={() => setGithubOpen(false)}
      onOk={() => importGitHub.mutate()}
    >
      <Space direction="vertical" size={12} className="full-width">
        <Alert type="info" showIcon message="扫描不会执行仓库中的脚本或安装命令" description="支持公开 GitHub 仓库地址和 /tree/<ref>/<子目录> 地址；导入后先展示文件、脚本、网络和许可证信息，再由你决定是否安装。" />
        <Input value={githubAddress} onChange={(event) => setGithubAddress(event.target.value)} placeholder="https://github.com/owner/repository/tree/main/path/to/skill" />
      </Space>
    </Modal>
    <Modal
      title={selectedCapability ? `${selectedCapability.name} · 安全审查` : '能力审查'}
      open={Boolean(selectedCapability)}
      width={820}
      onCancel={() => setSelectedCapability(null)}
      footer={selectedCapability && selectedCapability.lifecycleStatus !== 'installed' && selectedCapability.parseStatus === 'valid' && !selectedCapability.security.containsLiteralSecrets
        ? <Space><Button onClick={() => setSelectedCapability(null)}>关闭</Button><Button type="primary" loading={install.isPending} onClick={() => install.mutate(selectedCapability.id, { onSuccess: () => setSelectedCapability(null) })}>确认安装此版本</Button></Space>
        : selectedCapability?.lifecycleStatus === 'installed'
          ? <Space><Button onClick={() => setSelectedCapability(null)}>关闭</Button><Popconfirm
            title={`卸载 ${selectedCapability.name}？`}
            description="卸载后 Role 不再推荐该能力，真实调用也不会挂载。"
            onConfirm={() => uninstall.mutate(selectedCapability.id, { onSuccess: () => setSelectedCapability(null) })}
          ><Button danger loading={uninstall.isPending}>卸载</Button></Popconfirm></Space>
          : <Button onClick={() => setSelectedCapability(null)}>关闭</Button>}
    >
      {selectedCapability && <Space direction="vertical" size={12} className="full-width">
        <Descriptions bordered size="small" column={1} items={[
          { key: 'source', label: '来源', children: <Typography.Text className="mono-text" copyable>{selectedCapability.source.ref}</Typography.Text> },
          { key: 'version', label: '版本 / 哈希', children: <Typography.Text className="mono-text">{selectedCapability.version} · {selectedCapability.contentHash}</Typography.Text> },
          { key: 'license', label: '许可证', children: displayManifestValue(selectedCapability.manifest.license) },
          { key: 'compatibility', label: '兼容 CLI', children: selectedCapability.compatibility.map((item) => <Tag key={item}>{item}</Tag>) },
          { key: 'allowedTools', label: '声明工具 / 权限', children: displayManifestValue(selectedCapability.manifest.allowedTools) },
          { key: 'metadata', label: '依赖与元数据', children: <Typography.Text className="mono-text">{JSON.stringify(selectedCapability.manifest.metadata ?? {})}</Typography.Text> },
          { key: 'files', label: `文件（${selectedCapability.security.files.length}）`, children: <Typography.Text className="mono-text">{selectedCapability.security.files.join('、') || '配置来源文件'}</Typography.Text> },
          { key: 'scripts', label: '脚本 / 安装内容', children: selectedCapability.security.scripts.join('、') || '未发现脚本文件' },
          { key: 'executables', label: '可执行文件', children: selectedCapability.security.executableFiles.join('、') || '无' },
          { key: 'network', label: '网络主机', children: selectedCapability.security.networkHosts.join('、') || '未识别' },
          { key: 'credentials', label: '凭据处理', children: selectedCapability.security.localCredentialBindings > 0
            ? `复用原 CLI 配置中的 ${selectedCapability.security.localCredentialBindings} 项本机凭据`
            : selectedCapability.credentialRefs.join('、') || '无' },
          { key: 'headers', label: '环境 / Header 键', children: [...selectedCapability.security.environmentKeys, ...selectedCapability.security.headerKeys].join('、') || '无' },
        ]} />
        {selectedCapability.security.containsLiteralSecrets && <Alert type="error" showIcon message="外部扩展中检测到疑似明文凭据，当前版本已禁止安装" description="GitHub、ZIP 或扩展文件不应携带密钥；请从扩展内容中移除凭据并改为环境变量引用后重新导入。" />}
        {typeof selectedCapability.manifest.contentPreview === 'string' && <Card size="small" title="SKILL.md 内容预览"><Typography.Paragraph className="mono-text" style={{ whiteSpace: 'pre-wrap' }}>{selectedCapability.manifest.contentPreview}</Typography.Paragraph></Card>}
      </Space>}
    </Modal>
  </div>;
}
