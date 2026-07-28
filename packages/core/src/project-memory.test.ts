import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project memory versioning', () => {
  it('keeps directory profiles and accepted knowledge as immutable versions with ProjectSpace operations', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-project-memory-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(directory);
    writeFileSync(join(directory, 'README.md'), '# Project\n');
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const project = store.createProject({ name: '记忆项目', directoryPath: directory });
    const linkedDirectory = project.directories[0];
    if (!linkedDirectory) throw new Error('directory missing');

    expect(store.listDirectoryProfiles(project.id)).toEqual([
      expect.objectContaining({ directoryId: linkedDirectory.id, version: 1, status: 'candidate' }),
    ]);
    const initialProfile = store.listDirectoryProfiles(project.id)[0];
    if (!initialProfile) throw new Error('initial profile missing');
    store.confirmDirectoryProfile(initialProfile.id);
    expect(store.listProjectSpaceOperations(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'succeeded', commitHash: expect.any(String) }),
    ]));

    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: { react: '^19.0.0' },
    }));
    const candidate = store.rescanDirectory(linkedDirectory.id);
    expect(candidate).toMatchObject({ version: 2, status: 'candidate' });
    expect(store.getProject(project.id).directories[0]?.stack).not.toContain('react');
    store.confirmDirectoryProfile(candidate.id);
    expect(store.getProject(project.id).directories[0]?.stack).toContain('react');
    expect(store.listDirectoryProfiles(project.id)).toEqual([
      expect.objectContaining({ version: 2, status: 'confirmed' }),
      expect.objectContaining({ version: 1, status: 'superseded' }),
    ]);

    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO knowledge_items(
        id, project_id, category, title, content, status, source_task_id,
        version, supersedes_id, created_at, updated_at
      ) VALUES ('knowledge_candidate', ?, 'decision', 'API 决策', '候选内容', 'candidate', NULL, 1, NULL, ?, ?)
    `).run(project.id, timestamp, timestamp);
    const accepted = store.reviewKnowledge('knowledge_candidate', 'accept', {
      content: '确认后的不可变内容',
    });

    expect(accepted).toMatchObject({
      status: 'active',
      version: 2,
      supersedesId: 'knowledge_candidate',
      content: '确认后的不可变内容',
    });
    expect(store.listKnowledge(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'knowledge_candidate', status: 'superseded', content: '候选内容' }),
      expect.objectContaining({ id: accepted.id, status: 'active', content: '确认后的不可变内容' }),
    ]));
    expect(store.searchKnowledge(project.id, '不可变')).toEqual([
      expect.objectContaining({ id: accepted.id }),
    ]);
    const revised = store.reviewKnowledge(accepted.id, 'accept', {
      title: 'API 决策（修订）',
      content: '修订后的当前有效内容',
    });
    expect(revised).toMatchObject({
      status: 'active',
      version: 3,
      supersedesId: accepted.id,
      content: '修订后的当前有效内容',
    });
    expect(store.listKnowledge(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: accepted.id, status: 'superseded' }),
      expect.objectContaining({ id: revised.id, status: 'active' }),
    ]));
    expect(store.searchKnowledge(project.id, '不可变')).toEqual([]);
    expect(store.searchKnowledge(project.id, '当前有效')).toEqual([
      expect.objectContaining({ id: revised.id }),
    ]);
    database.prepare(`
      INSERT INTO project_space_operations(
        id, project_id, task_id, operation, commit_hash, changed_files_json, status, error, created_at
      ) VALUES ('prepared_interrupted', ?, NULL, 'interrupted test', NULL, '[]', 'prepared', NULL, ?)
    `).run(project.id, new Date().toISOString());
    const restartedStore = new YanxuStore(database, workbench);
    expect(restartedStore.listProjectSpaceOperations(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'prepared_interrupted',
        status: 'failed',
        error: expect.stringContaining('提交完成前中断'),
      }),
    ]));
    database.close();
  });

  it('persists project permission boundaries and safely soft-removes directory associations', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-project-settings-'));
    temporaryDirectories.push(root);
    const firstDirectory = join(root, 'first');
    const secondDirectory = join(root, 'second');
    const workbench = join(root, 'workbench');
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const project = store.createProject({ name: '权限项目', directoryPath: firstDirectory });
    const linked = store.addProjectDirectory(project.id, secondDirectory);

    expect(store.updateProjectSettings(project.id, {
      description: '更新后的项目说明',
      permissionMode: 'managed',
      forbiddenPaths: ['.env', 'secrets/**', '.env'],
    })).toMatchObject({
      permissionMode: 'managed',
      forbiddenPaths: ['.env', 'secrets/**'],
    });
    expect(store.getProject(project.id).description).toBe('更新后的项目说明');

    expect(store.removeProjectDirectory(linked.id)).toEqual({
      removedDirectoryId: linked.id,
      projectId: project.id,
    });
    expect(store.getProject(project.id).directories.map((directory) => directory.id)).not.toContain(linked.id);
    const restored = store.addProjectDirectory(project.id, secondDirectory);
    expect(restored.id).toBe(linked.id);
    expect(store.getProject(project.id).directories).toHaveLength(2);
    database.close();
  });

  it('does not stage an unknown external file during a ProjectSpace milestone', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-projectspace-boundary-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(directory);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const project = store.createProject({ name: '边界项目', directoryPath: directory });
    const unknown = join(project.projectSpacePath, 'external-note.md');
    writeFileSync(unknown, 'This file was not created by Yanxu.\n');

    store.updateProjectSettings(project.id, {
      description: '触发受控 milestone',
      permissionMode: 'standard',
      forbiddenPaths: [],
    });

    const status = spawnSync('git', ['-C', project.projectSpacePath, 'status', '--porcelain=v1'], { encoding: 'utf8' });
    expect(status.stdout).toContain('?? external-note.md');
    const tracked = spawnSync('git', ['-C', project.projectSpacePath, 'ls-files', '--error-unmatch', 'external-note.md'], { encoding: 'utf8' });
    expect(tracked.status).not.toBe(0);
    database.close();
  });
});
