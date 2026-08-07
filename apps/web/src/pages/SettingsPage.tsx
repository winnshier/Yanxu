import { useEffect } from 'react';
import { AutoComplete, Badge, Button, Card, Col, Descriptions, Form, InputNumber, Row, Select, Spin, Switch, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemSettings } from '@yanxu/contracts';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.js';

export function SettingsPage() {
  const [form] = Form.useForm<SystemSettings>();
  const queryClient = useQueryClient();
  const executors = useQuery({ queryKey: ['executors'], queryFn: api.executors });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const validations = useQuery({ queryKey: ['executor-validations'], queryFn: api.executorValidations });
  const diagnostics = useQuery({ queryKey: ['system-diagnostics'], queryFn: api.systemDiagnostics, refetchInterval: 15_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000, retry: 1 });
  const coordinatorExecutor = Form.useWatch('coordinatorExecutor', form);
  useEffect(() => { if (settings.data) form.setFieldsValue(settings.data); }, [form, settings.data]);
  const probe = useMutation({
    mutationFn: api.probeExecutors,
    onSuccess: (data) => { queryClient.setQueryData(['executors'], data); void queryClient.invalidateQueries({ queryKey: ['settings'] }); message.success('CLI 检测完成'); },
    onError: (error: Error) => message.error(error.message),
  });
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (data) => { queryClient.setQueryData(['settings'], data); void queryClient.invalidateQueries({ queryKey: ['dashboard'] }); message.success('设置已保存'); },
    onError: (error: Error) => message.error(error.message),
  });
  const validate = useMutation({
    mutationFn: api.validateExecutor,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['executor-validations'] });
      message.success(result.message);
    },
    onError: (error: Error) => message.error(error.message),
  });
  const coordinatorInstallation = executors.data?.find((item) => item.id === coordinatorExecutor);
  const coordinatorOptions = (executors.data ?? [])
    .filter((item) => item.id !== 'codex' && item.capabilities.includes('structured-output'))
    .map((item) => ({ label: item.name, value: item.id, disabled: item.health !== 'available' }));

  return (
    <div className="page-container settings-page">
      <PageHeader eyebrow="本地运行环境" title="设置" description="环境不阻塞浏览和草稿；创建人员、提交分析和启动任务时才进行强校验。" actions={<Button icon={<ReloadOutlined />} loading={probe.isPending} onClick={() => probe.mutate()}>重新检测 CLI</Button>} />
      <Spin spinning={executors.isLoading || settings.isLoading}>
        <Row gutter={[16, 16]} className="executor-grid">
          {(executors.data ?? []).map((executor) => (
            <Col key={executor.id} xs={24} lg={12} xxl={8}>
              <Card className="executor-card" title={executor.name} extra={<Badge status={executor.health === 'available' ? 'success' : 'default'} text={executor.health === 'available' ? '可用' : executor.health === 'unchecked' ? '待检测' : '不可用'} />}>
                <Descriptions size="small" column={1} items={[
                  { key: 'path', label: '路径', children: <Typography.Text ellipsis={{ tooltip: executor.path }} className="mono-text description-path">{executor.path ?? '未找到'}</Typography.Text> },
                  { key: 'version', label: '版本', children: executor.version ?? '—' },
                  { key: 'models', label: '模型', children: `${executor.models.length} 个` },
                ]} />
                <div className="tag-row">{executor.capabilities.map((capability) => <Tag key={capability}>{capability}</Tag>)}</div>
                {validations.data?.find((item) => item.executor === executor.id) && <Descriptions
                  className="settings-card"
                  size="small"
                  column={1}
                  items={(() => {
                    const result = validations.data?.find((item) => item.executor === executor.id);
                    return [
                      { key: 'runtime', label: 'Runtime 自检', children: result?.status === 'passed' ? '通过' : '失败' },
                      { key: 'login', label: '授权状态', children: result?.loginStatus === 'configured' ? '已发现可用模型配置' : '未确认' },
                      { key: 'checked', label: '验证时间', children: result ? new Date(result.checkedAt).toLocaleString() : '—' },
                    ];
                  })()}
                />}
                {executor.id !== 'codex' && executor.capabilities.includes('structured-output') && <Button
                  className="settings-card"
                  disabled={executor.health !== 'available'}
                  loading={validate.isPending}
                  onClick={() => validate.mutate(executor.id)}
                >验证真实运行时</Button>}
              </Card>
            </Col>
          ))}
        </Row>
        <Card title="协调与执行" className="settings-card settings-panel">
          <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
            <Row gutter={20}>
              <Col xs={24} md={12}><Form.Item name="coordinatorExecutor" label="全局协调 CLI"><Select options={coordinatorOptions} /></Form.Item></Col>
              <Col xs={24} md={12}><Form.Item name="coordinatorModel" label="全局协调模型" rules={[{ required: true, message: '请选择或输入模型' }]}><AutoComplete options={(coordinatorInstallation?.models ?? []).map((model) => ({ label: model, value: model }))} placeholder={coordinatorExecutor === 'claude' ? '选择别名，或输入完整 Claude 模型 ID' : '选择已检测模型，或输入 provider/model'} /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="maxParallelTasks" label="最大并行任务数"><InputNumber min={1} max={8} className="full-width" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="retryLimit" label="自动修复重试次数"><InputNumber min={0} max={5} className="full-width" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="permissionMode" label="默认全托管模式" valuePropName="checked" getValueProps={(value) => ({ checked: value === 'managed' })} normalize={(checked) => checked ? 'managed' : 'standard'}><Switch /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="sessionTimeoutMs" label="单个 Session 超时（毫秒）"><InputNumber min={60_000} max={14_400_000} step={60_000} className="full-width" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="gateTimeoutMs" label="默认 Gate 超时（毫秒）"><InputNumber min={1_000} max={3_600_000} step={30_000} className="full-width" /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="networkPolicy" label="计划外联网"><Select options={[
                { label: '询问', value: 'ask' },
                { label: '始终拒绝', value: 'deny' },
              ]} /></Form.Item></Col>
              <Col xs={24} md={8}><Form.Item name="dependencyInstallPolicy" label="计划外安装依赖"><Select options={[
                { label: '询问', value: 'ask' },
                { label: '始终拒绝', value: 'deny' },
              ]} /></Form.Item></Col>
            </Row>
            <div className="settings-form-footer"><Button type="primary" htmlType="submit" loading={save.isPending}>保存设置</Button><Typography.Text type="secondary" className="mono-text">Workbench：{settings.data?.workbenchHome}</Typography.Text></div>
          </Form>
        </Card>
        <Card title="系统与存储" className="settings-card settings-panel">
          <Descriptions column={{ xs: 1, md: 2 }} items={[
            { key: 'version', label: '应用版本', children: diagnostics.data?.appVersion ?? health.data?.version ?? '检查中' },
            { key: 'daemon', label: '本地服务', children: <Badge status={health.data?.status === 'ready' ? 'success' : 'warning'} text={health.data?.status ?? '连接中'} /> },
            { key: 'database', label: 'SQLite', children: <Badge status={health.data?.database === 'ready' ? 'success' : 'warning'} text={health.data?.database ?? '检查中'} /> },
            { key: 'schema', label: '数据库 Schema', children: `${diagnostics.data?.databaseSchemaVersion ?? '—'} / ${diagnostics.data?.latestDatabaseSchemaVersion ?? '—'}` },
            { key: 'scheduler', label: 'Scheduler', children: health.data?.scheduler.running ? `运行中 · ${health.data.scheduler.activeJobs} 个任务` : '尚未启动' },
            { key: 'workbench', label: 'Workbench', children: <Typography.Text className="mono-text description-path" copyable>{settings.data?.workbenchHome ?? '—'}</Typography.Text> },
            { key: 'db-check', label: 'SQLite quick_check', children: diagnostics.data?.databaseCheck ?? '检查中' },
            { key: 'fts-files', label: '项目文件索引', children: `${diagnostics.data?.indexedProjectFiles ?? 0} 个文件` },
            { key: 'fts-knowledge', label: '知识检索索引', children: `${diagnostics.data?.indexedKnowledgeEntries ?? 0} 条` },
            { key: 'runtime', label: 'Runtime 任务目录', children: diagnostics.data?.runtimeTaskDirectories ?? 0 },
            { key: 'recovery', label: '恢复记录', children: diagnostics.data?.recoveryRecords ?? 0 },
            { key: 'space-failures', label: 'ProjectSpace 失败操作', children: diagnostics.data?.projectSpaceFailedOperations ?? 0 },
            { key: 'git', label: 'Git', children: diagnostics.data?.gitVersion ?? '未检测' },
            { key: 'daemon-log', label: '服务日志', children: <Typography.Text className="mono-text description-path" copyable>{diagnostics.data?.daemonLogPath ?? '加载中'}</Typography.Text> },
            { key: 'daemon-log-size', label: '服务日志大小', children: `${Math.round((diagnostics.data?.daemonLogBytes ?? 0) / 1024)} KB` },
            { key: 'migration-backup', label: '最近升级恢复点', children: diagnostics.data?.migrationRecoveryPoints[0]
              ? <Typography.Text className="mono-text description-path" copyable>{diagnostics.data.migrationRecoveryPoints[0].backupPath}</Typography.Text>
              : '尚未产生' },
          ]} />
        </Card>
      </Spin>
    </div>
  );
}
