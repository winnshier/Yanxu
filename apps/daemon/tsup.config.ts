import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@yanxu\//],
  external: ['better-sqlite3', '@opencode-ai/sdk', '@opencode-ai/sdk/v2'],
});
