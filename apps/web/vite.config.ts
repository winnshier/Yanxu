import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:43121',
      '/health': 'http://127.0.0.1:43121',
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    // Route pages are lazy chunks. The remaining shared React/Ant runtime is
    // cached once by the local daemon and is currently about 708 kB minified
    // (232 kB gzip), so keep the warning boundary tied to that measured budget.
    chunkSizeWarningLimit: 750,
  },
});
