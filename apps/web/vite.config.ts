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
  },
});
