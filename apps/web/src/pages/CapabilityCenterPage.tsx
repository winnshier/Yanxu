import { useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, Input, Modal, Row, Segmented, Space, Tag, Typography, message } from 'antd';
import { FolderOpenOutlined, GithubOutlined, ReloadOutlined, SafetyCertificateOutlined, ToolOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capability } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';
import { QueryState } from '../components/QueryState.js';

const lifecycleLabel: Record<Capability['lifecycleStatus'], string> = {
  discovered: '已发现', imported: '已导入', installed: '已安装',
};

function capabilityColor(capability: Capability): string {
  if (capability.parseStatus === 'invalid') return 'red';
  if (capability.lifecycleStatus === 'installed') return 'green';
  return 'blue';
}

function displayManifestValue(value: unknown, fallback = '未声明'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function CapabilityCenterPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'all' | 'skill' | 'mcp'>('all');
  const [query, setQuery] = useState('');
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
      message.success('能力已安装到研序托管目录');
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
  const filtered = useMemo(() => (capabilities.data ?? []).filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${item.name}\n${item.description}\n${item.source.ref}`.toLowerCase().includes(needle);
  }), [capabilities.data, kind, query]);

  return <div className="page-container capability-center-page">
    <PageHeader
      eyebrow="能力资产"
      title="能力中心"
      description="统一发现 OpenCode 与 Claude Code 的 Skill / MCP；安装后由项目显式启用，任务确认时冻结版本。"
      actions={<Space wrap>
        <Button icon={<FolderOpenOutlined />} loading={importLocal.isPending} onClick={() => importLocal.mutate()}>导入本地 Skill</Button>
        <Button icon={<UploadOutlined />} loading={importZip.isPending} onClick={() => importZip.mutate()}>导入 ZIP</Button>
        <Button icon={<GithubOutlined />} onClick={() => setGithubOpen(true)}>从 GitHub 导入</Button>
        <Button type="primary" icon={<ReloadOutlined />} loading={discover.isPending} onClick={() => discover.mutate()}>扫描本机能力</Button>
      </Space>}
    />
    <Alert
      showIcon
      type="info"
      message="发现不等于启用"
      description="扫描只读取元数据，不执行脚本；安装会复制到研序托管目录。能力还需在具体项目中启用，并由任务计划按需选择。"
    />
    <Card className="settings-card">
      <Space wrap className="full-width" style={{ justifyContent: 'space-between' }}>
        <Segmented value={kind} onChange={(value) => setKind(value as typeof kind)} options={[
          { label: '全部', value: 'all' }, { label: 'Skill', value: 'skill' }, { label: 'MCP', value: 'mcp' },
        ]} />
        <Input.Search allowClear placeholder="搜索名称、说明或来源" value={query} onChange={(event) => setQuery(event.target.value)} style={{ maxWidth: 360 }} />
      </Space>
    </Card>
    <QueryState loading={capabilities.isLoading} error={capabilities.error} onRetry={() => { void capabilities.refetch(); }}>
      {filtered.length === 0 ? <Empty description="尚未发现能力，先扫描本机配置或导入本地 Skill" /> : <Row gutter={[16, 16]}>
        {filtered.map((capability) => <Col key={capability.id} xs={24} xl={12}>
          <Card
            className="library-card"
            title={<Space wrap>{capability.kind === 'skill' ? <ToolOutlined /> : <SafetyCertificateOutlined />}<Typography.Text strong>{capability.name}</Typography.Text><Tag>{capability.kind.toUpperCase()}</Tag></Space>}
            extra={<Space>
              <Button size="small" onClick={() => setSelectedCapability(capability)}>审查详情</Button>
              {capability.lifecycleStatus !== 'installed' && capability.parseStatus === 'valid' && !capability.security.containsLiteralSecrets
                ? <Button size="small" type="primary" loading={install.isPending && install.variables === capability.id} onClick={() => install.mutate(capability.id)}>安装</Button>
                : null}
            </Space>}
          >
            <Space direction="vertical" size={10} className="full-width">
              <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>{capability.description || '暂无说明'}</Typography.Paragraph>
              <Space wrap>
                <Tag color={capabilityColor(capability)}>{lifecycleLabel[capability.lifecycleStatus]}</Tag>
                <Tag color={capability.parseStatus === 'valid' ? 'green' : 'red'}>解析 {capability.parseStatus}</Tag>
                <Tag>命令 {capability.commandStatus}</Tag>
                <Tag>运行 {capability.runtimeHealth}</Tag>
                {capability.compatibility.map((executor) => <Tag key={executor} color="geekblue">{executor}</Tag>)}
              </Space>
              <Typography.Text className="mono-text" type="secondary" copyable>{capability.source.ref}</Typography.Text>
              <Typography.Text type="secondary">版本 {capability.version} · {capability.security.files.length} 个文件 · 环境引用 {capability.credentialRefs.length} 项</Typography.Text>
              {capability.parseError && <Alert type="error" showIcon message={capability.parseError} />}
              {(capability.security.executableFiles.length > 0 || capability.security.scripts.length > 0 || capability.security.containsLiteralSecrets) && <Alert type="warning" showIcon message="安全检查提示" description={[
                capability.security.executableFiles.length ? `含可执行文件：${capability.security.executableFiles.join('、')}` : '',
                capability.security.scripts.length ? `检测到脚本引用：${capability.security.scripts.join('、')}` : '',
                capability.security.containsLiteralSecrets ? '检测到疑似明文凭据' : '',
              ].filter(Boolean).join('；')} />}
            </Space>
          </Card>
        </Col>)}
      </Row>}
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
          { key: 'credentials', label: '本地凭据引用', children: selectedCapability.credentialRefs.join('、') || '无' },
          { key: 'headers', label: '环境 / Header 键', children: [...selectedCapability.security.environmentKeys, ...selectedCapability.security.headerKeys].join('、') || '无' },
        ]} />
        {selectedCapability.security.containsLiteralSecrets && <Alert type="error" showIcon message="来源中检测到疑似明文凭据，当前版本已禁止安装" description="研序不会把原始明文写入 ProjectSpace；请先在来源配置中改成本地环境变量引用，再重新扫描或导入。" />}
        {typeof selectedCapability.manifest.contentPreview === 'string' && <Card size="small" title="SKILL.md 内容预览"><Typography.Paragraph className="mono-text" style={{ whiteSpace: 'pre-wrap' }}>{selectedCapability.manifest.contentPreview}</Typography.Paragraph></Card>}
      </Space>}
    </Modal>
  </div>;
}
