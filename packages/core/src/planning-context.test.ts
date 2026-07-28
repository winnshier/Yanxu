import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { buildIndexedPlanningContext, buildPlanningContext } from './planning-context.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('planning context retrieval', () => {
  it('returns a bounded relevant project map without dependencies or sensitive files', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-planning-context-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Order service\n\nExports order data.\n');
    writeFileSync(join(root, 'src', 'order-export.ts'), 'export function exportOrders() { return \"csv\"; }\n');
    writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, '.env'), 'SECRET=hidden\n');
    writeFileSync(join(root, 'node_modules', 'ignored', 'index.js'), 'secret dependency source\n');
    const project: Project = {
      id: 'project',
      name: '订单系统',
      description: '',
      projectSpacePath: join(root, '.project-space'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskSummary: { active: 0, attention: 0, delivered: 0, archived: 0 },
      directories: [{
        id: 'directory',
        projectId: 'project',
        displayName: 'order-service',
        selectedPath: root,
        realPath: root,
        gitRootPath: root,
        gitInitialized: true,
        currentBranch: 'main',
        isDirty: false,
        contentTypes: ['代码'],
        stack: ['typescript'],
        commands: { test: 'pnpm test' },
        localBranches: ['main'],
        scannedAt: new Date().toISOString(),
      }],
    };

    const [context] = buildPlanningContext(project, '实现 order export CSV', {
      maxCharacters: 1_000,
      maxExcerpts: 2,
    });
    expect(context?.indexedFiles).toContain('src/order-export.ts');
    expect(context?.indexedFiles).not.toContain('.env');
    expect(context?.indexedFiles.some((path) => path.includes('node_modules'))).toBe(false);
    expect(context?.excerpts[0]?.path).toBe('src/order-export.ts');
    expect(context?.excerpts.reduce((sum, excerpt) => sum + excerpt.excerpt.length, 0)).toBeLessThanOrEqual(1_000);
  });

  it('reuses persisted samples and refreshes only changed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-planning-index-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Indexed project\n');
    writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = \"first\";\n');
    const database = openDatabase(join(root, 'app.db'));
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO projects(id, name, description, project_space_path, created_at, updated_at)
      VALUES ('project-indexed', 'Indexed', '', ?, ?, ?)
    `).run(join(root, '.project-space'), timestamp, timestamp);
    database.prepare(`
      INSERT INTO project_directories(
        id, project_id, display_name, selected_path, real_path, git_root_path,
        git_initialized, current_branch, is_dirty, content_types_json, stack_json,
        commands_json, scanned_at
      ) VALUES ('directory-indexed', 'project-indexed', 'indexed', ?, ?, ?, 1, 'main', 0, '["代码"]', '["typescript"]', '{}', ?)
    `).run(root, root, root, timestamp);
    const project: Project = {
      id: 'project-indexed',
      name: 'Indexed',
      description: '',
      projectSpacePath: join(root, '.project-space'),
      createdAt: timestamp,
      updatedAt: timestamp,
      taskSummary: { active: 0, attention: 0, delivered: 0, archived: 0 },
      directories: [{
        id: 'directory-indexed',
        projectId: 'project-indexed',
        displayName: 'indexed',
        selectedPath: root,
        realPath: root,
        gitRootPath: root,
        gitInitialized: true,
        currentBranch: 'main',
        isDirty: false,
        contentTypes: ['代码'],
        stack: ['typescript'],
        commands: {},
        localBranches: ['main'],
        scannedAt: timestamp,
      }],
    };

    try {
      const [first] = buildIndexedPlanningContext(database, project, 'feature', { maxExcerpts: 2 });
      expect(first?.refreshedFiles).toBeGreaterThanOrEqual(2);
      const initial = database.prepare(`
        SELECT sample_hash, indexed_at FROM project_file_index
        WHERE directory_id = ? AND relative_path = ?
      `).get('directory-indexed', 'src/feature.ts') as { sample_hash: string; indexed_at: string };

      const [second] = buildIndexedPlanningContext(database, project, 'feature', { maxExcerpts: 2 });
      const unchanged = database.prepare(`
        SELECT sample_hash, indexed_at FROM project_file_index
        WHERE directory_id = ? AND relative_path = ?
      `).get('directory-indexed', 'src/feature.ts') as { sample_hash: string; indexed_at: string };
      expect(second?.refreshedFiles).toBe(0);
      expect(unchanged).toEqual(initial);

      writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = \"second-version\";\n');
      const [third] = buildIndexedPlanningContext(database, project, 'feature second-version', { maxExcerpts: 2 });
      const changed = database.prepare(`
        SELECT sample_hash, sample FROM project_file_index
        WHERE directory_id = ? AND relative_path = ?
      `).get('directory-indexed', 'src/feature.ts') as { sample_hash: string; sample: string };
      expect(third?.refreshedFiles).toBe(1);
      expect(changed.sample_hash).not.toBe(initial.sample_hash);
      expect(changed.sample).toContain('second-version');
      expect(third?.excerpts[0]?.path).toBe('src/feature.ts');
    } finally {
      database.close();
    }
  });

  it('retrieves Chinese requirements and the same contract symbol across project directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-cross-directory-context-'));
    temporaryDirectories.push(root);
    const frontend = join(root, 'frontend');
    const backend = join(root, 'backend');
    mkdirSync(join(frontend, 'src'), { recursive: true });
    mkdirSync(join(backend, 'docs'), { recursive: true });
    writeFileSync(join(frontend, 'src', 'order-contract.ts'), 'export interface OrderContract { orderId: string }\n');
    writeFileSync(join(backend, 'docs', '订单契约.md'), '# 订单契约\n\n后端响应必须满足 OrderContract。\n');
    const timestamp = new Date().toISOString();
    const directory = (id: string, path: string): Project['directories'][number] => ({
      id,
      projectId: 'cross-project',
      displayName: id,
      selectedPath: path,
      realPath: path,
      gitRootPath: path,
      gitInitialized: true,
      currentBranch: 'main',
      isDirty: false,
      contentTypes: ['代码', '文档'],
      stack: ['typescript'],
      commands: {},
      localBranches: ['main'],
      scannedAt: timestamp,
    });
    const project: Project = {
      id: 'cross-project',
      name: '跨目录订单项目',
      description: '',
      projectSpacePath: join(root, 'project-space'),
      createdAt: timestamp,
      updatedAt: timestamp,
      taskSummary: { active: 0, attention: 0, delivered: 0, archived: 0 },
      directories: [directory('frontend', frontend), directory('backend', backend)],
    };

    const context = buildPlanningContext(project, '修改订单契约 OrderContract');
    expect(context.find((item) => item.directoryId === 'frontend')?.excerpts[0]?.path).toBe('src/order-contract.ts');
    expect(context.find((item) => item.directoryId === 'backend')?.excerpts[0]?.path).toBe('docs/订单契约.md');
  });
});
