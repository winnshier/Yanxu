import { useEffect, useMemo, useState } from 'react';
import { Badge, Layout, Menu, Typography } from 'antd';
import {
  ApartmentOutlined, AppstoreOutlined, CalendarOutlined, DashboardOutlined, FolderOpenOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  SettingOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowEvent } from '@yanxu/contracts';
import { api, ensureSession } from '../lib/api.js';

const { Sider, Content } = Layout;

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000, retry: 1 });
  const selectedKey = useMemo(() => {
    const segment = location.pathname.split('/')[1];
    return segment ? `/${segment}` : '/';
  }, [location.pathname]);

  useEffect(() => {
    let stream: EventSource | null = null;
    let disposed = false;
    void ensureSession().then(() => {
      if (disposed) return;
      stream = new EventSource('/api/events/stream');
      stream.onmessage = (message) => {
        if (typeof message.data !== 'string') return;
        const event = JSON.parse(message.data) as WorkflowEvent;
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        void queryClient.invalidateQueries({ queryKey: ['tasks'] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        void queryClient.invalidateQueries({ queryKey: ['capabilities'] });
        void queryClient.invalidateQueries({ queryKey: ['schedules'] });
        if (event.aggregateType === 'task') {
          void queryClient.invalidateQueries({ queryKey: ['task', event.aggregateId] });
          void queryClient.invalidateQueries({ queryKey: ['task-plans', event.aggregateId] });
          void queryClient.invalidateQueries({ queryKey: ['task-events', event.aggregateId] });
          void queryClient.invalidateQueries({ queryKey: ['task-evidence', event.aggregateId] });
          void queryClient.invalidateQueries({ queryKey: ['task-capabilities', event.aggregateId] });
        }
        if (event.aggregateType === 'project') {
          void queryClient.invalidateQueries({ queryKey: ['project-capabilities', event.aggregateId] });
        }
      };
    });
    return () => {
      disposed = true;
      stream?.close();
    };
  }, [queryClient]);

  const primaryItems = [
    { key: '/', icon: <DashboardOutlined />, label: '调度台' },
    { key: '/projects', icon: <FolderOpenOutlined />, label: '项目' },
    { key: '/tasks', icon: <UnorderedListOutlined />, label: '任务' },
    { key: '/schedules', icon: <CalendarOutlined />, label: '定时任务' },
  ];
  const organizationItems = [
    { key: '/team', icon: <ApartmentOutlined />, label: 'AI 团队' },
  ];
  const configurationItems = [
    { key: '/capabilities', icon: <AppstoreOutlined />, label: '能力中心' },
    { key: '/settings', icon: <SettingOutlined />, label: '设置' },
  ];
  const menuItems = [
    { type: 'group' as const, label: '工作区', children: primaryItems },
    { type: 'group' as const, label: '编排', children: organizationItems },
    { type: 'group' as const, label: '配置', children: configurationItems },
  ];
  return (
    <Layout className="app-layout">
      <Sider className="app-sider" width={232} collapsedWidth={76} collapsed={collapsed} trigger={null}>
        <div className="brand">
          <div className="brand-mark">序</div>
          {!collapsed && <div><Typography.Text className="brand-name">研序</Typography.Text><span className="brand-subtitle">YANXU</span></div>}
        </div>
        <Menu
          mode="inline"
          theme="light"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => { void navigate(key); }}
        />
        <div className="sider-footer">
          {!collapsed && <Badge status={health.data?.status === 'ready' ? 'success' : 'warning'} text={health.data?.status === 'ready' ? '本地服务运行中' : '本地服务连接中'} />}
          <button className="collapse-button" type="button" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>
      </Sider>
      <Layout className="app-main-layout">
        <Content className="app-content"><Outlet /></Content>
      </Layout>
    </Layout>
  );
}
