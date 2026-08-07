import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { AppShell } from './AppShell.js';

const DashboardPage = lazy(() => import('../pages/DashboardPage.js').then((module) => ({ default: module.DashboardPage })));
const ProjectsPage = lazy(() => import('../pages/ProjectsPage.js').then((module) => ({ default: module.ProjectsPage })));
const ProjectDetailPage = lazy(() => import('../pages/ProjectDetailPage.js').then((module) => ({ default: module.ProjectDetailPage })));
const TasksPage = lazy(() => import('../pages/TasksPage.js').then((module) => ({ default: module.TasksPage })));
const TaskDetailPage = lazy(() => import('../pages/TaskDetailPage.js').then((module) => ({ default: module.TaskDetailPage })));
const TeamPage = lazy(() => import('../pages/TeamPage.js').then((module) => ({ default: module.TeamPage })));
const CapabilityCenterPage = lazy(() => import('../pages/CapabilityCenterPage.js').then((module) => ({ default: module.CapabilityCenterPage })));
const SettingsPage = lazy(() => import('../pages/SettingsPage.js').then((module) => ({ default: module.SettingsPage })));

export function App() {
  return (
    <Suspense fallback={<div className="route-loading"><Spin size="large" /></div>}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="capabilities" element={<CapabilityCenterPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
