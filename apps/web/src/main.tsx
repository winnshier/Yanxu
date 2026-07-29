import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App.js';
import { queryClient } from './lib/query-client.js';
import './styles/global.css';

const preloadReloadKey = 'yanxu:preload-reload-entry';
window.addEventListener('vite:preloadError', (event) => {
  const entryScript = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? window.location.href;
  if (window.sessionStorage.getItem(preloadReloadKey) === entryScript) return;
  event.preventDefault();
  window.sessionStorage.setItem(preloadReloadKey, entryScript);
  window.location.reload();
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#4169e1',
          colorInfo: '#4169e1',
          colorSuccess: '#1f9d72',
          colorWarning: '#d88a2c',
          colorError: '#d34c4c',
          borderRadius: 10,
          fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Button: { controlHeight: 38, fontWeight: 600 },
          Card: { headerFontSize: 15 },
          Menu: { itemBorderRadius: 8 },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
