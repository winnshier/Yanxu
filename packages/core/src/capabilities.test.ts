import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { discoverLocalCapabilities, resolveLocalCredentialEnvironment } from './capabilities.js';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];
const openCode: ExecutorInstallation = {
  id: 'opencode', name: 'OpenCode', command: 'opencode', path: '/tmp/opencode', version: 'test',
  health: 'available', capabilities: ['structured-output'], models: ['test/model'],
  lastCheckedAt: new Date().toISOString(), error: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('capability registry', () => {
  it('discovers OpenCode and Claude Code skills and MCP definitions without executing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-capability-discovery-'));
    roots.push(root);
    const openCodeSkill = join(root, '.config', 'opencode', 'skills', 'frontend-review');
    const claudeSkill = join(root, '.claude', 'skills', 'api-review');
    mkdirSync(openCodeSkill, { recursive: true });
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(openCodeSkill, 'SKILL.md'), '---\nname: frontend-review\ndescription: Review frontend code.\n---\n# Frontend review\n');
    writeFileSync(join(claudeSkill, 'SKILL.md'), '---\nname: api-review\ndescription: Review API code.\n---\n# API review\n');
    const localSecret = 'local-token-that-must-not-be-persisted';
    writeFileSync(join(root, '.config', 'opencode', 'opencode.json'), JSON.stringify({
      mcp: {
        context: { type: 'local', command: ['node', 'server.mjs'], environment: { API_TOKEN: localSecret } },
        referenced: { type: 'local', command: ['node', 'referenced.mjs'], environment: { API_TOKEN: '$TEST_API_TOKEN' } },
      },
    }));
    const result = discoverLocalCapabilities([], root);
    expect(result.sourceErrors).toEqual([]);
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', name: 'frontend-review', parseStatus: 'valid' }),
      expect.objectContaining({ kind: 'skill', name: 'api-review', parseStatus: 'valid' }),
      expect.objectContaining({ kind: 'mcp', name: 'context', runtimeHealth: 'unchecked' }),
      expect.objectContaining({ kind: 'mcp', name: 'referenced', credentialRefs: ['TEST_API_TOKEN'], runtimeHealth: 'unchecked' }),
    ]));
    const context = result.capabilities.find((item) => item.name === 'context');
    expect(context).toBeDefined();
    expect(context?.security).toMatchObject({ containsLiteralSecrets: false, localCredentialBindings: 1 });
    expect(JSON.stringify(context)).not.toContain(localSecret);
    const resolved = resolveLocalCredentialEnvironment(context?.manifest.localCredentialBindings);
    expect(resolved.missing).toEqual([]);
    expect(Object.values(resolved.environment)).toEqual([localSecret]);
    const referenced = result.capabilities.find((item) => item.name === 'referenced');
    expect(referenced?.security.localCredentialBindings).toBe(0);
  });

  it('still blocks a third-party skill that embeds a literal credential', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-capability-secret-skill-'));
    roots.push(root);
    const skillRoot = join(root, 'unsafe-skill');
    const workbench = join(root, 'workbench');
    mkdirSync(skillRoot);
    writeFileSync(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: unsafe-skill',
      'description: Contains an unsafe credential.',
      '---',
      'api_key = "third-party-literal-secret"',
      '',
    ].join('\n'));
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const capability = store.importLocalSkill(skillRoot);
    expect(capability.security).toMatchObject({ containsLiteralSecrets: true, localCredentialBindings: 0 });
    expect(() => store.installCapability(capability.id)).toThrow('疑似明文凭据');
    database.close();
  });

  it('imports, installs, locks, freezes and projects a skill into an isolated task runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-capability-flow-'));
    roots.push(root);
    const skillRoot = join(root, 'react-review');
    const projectRoot = join(root, 'project');
    const workbench = join(root, 'workbench');
    mkdirSync(skillRoot);
    mkdirSync(projectRoot);
    writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: react-review\ndescription: Review React changes.\nlicense: MIT\n---\n# React review\n');
    writeFileSync(join(skillRoot, 'reference.md'), '# Checklist\n');
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);

    let capability = store.importLocalSkill(skillRoot);
    expect(capability.lifecycleStatus).toBe('imported');
    expect(existsSync(capability.managedPath ?? '')).toBe(true);
    capability = store.installCapability(capability.id);
    expect(capability.lifecycleStatus).toBe('installed');

    const agent = store.createAgent({
      name: '研发', roleId: 'development', executor: 'opencode', model: 'test/model', permissionMode: 'managed',
      defaultCapabilityIds: [capability.id],
    }, openCode);
    expect(agent.defaultCapabilityIds).toEqual([capability.id]);
    const team = store.createTeam({ name: '能力测试团队', memberIds: [agent.id] });
    const project = store.createProject({ name: '能力测试项目', directoryPath: projectRoot });
    store.updateProjectCapability(project.id, capability.id, { enabled: true });
    expect(readFileSync(join(project.projectSpacePath, 'capabilities', 'lock.json'), 'utf8')).toContain(capability.contentHash);

    let task = store.createTask({
      projectId: project.id, teamId: team.id, title: '检查 React 改动', description: '使用项目能力完成评审。',
      expectedOutput: '可追溯的 React 评审结论',
    });
    task = store.submitTask(task.id, task.stateVersion);
    task = store.saveComposedPlan(task.id, {
      goal: '完成评审', scope: ['项目目录'], nonScope: ['远程发布'], successCriteria: ['形成结论'],
      assumptions: [], risks: [], questions: [], permissions: [], qualityGates: [],
      steps: [{
        id: 'review', position: 0, unitKey: 'work-unit', agentId: agent.id,
        title: '评审 React 改动', description: '按项目 Skill 检查。', inputs: [], expectedOutput: '评审结论',
        directoryIds: [project.directories[0]!.id], requiredCapabilities: ['React 评审'], capabilityIds: [capability.id],
        verification: ['核对检查项'], mode: 'read_only', requiresIndependentSession: false,
      }],
    });
    task = store.commandTask(task.id, 'confirm', task.stateVersion);
    expect(store.getRunSnapshot(task.id)?.capabilities).toEqual([
      expect.objectContaining({ capabilityId: capability.id, contentHash: capability.contentHash, name: 'react-review' }),
    ]);
    const runtimeDirectory = join(root, 'runtime');
    const projection = store.prepareTaskCapabilityProjection(task.id, 'opencode', runtimeDirectory);
    expect(projection.skillNames).toEqual(['react-review']);
    expect(existsSync(join(projection.configDirectory, 'skills', 'react-review', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(readFileSync(projection.configPath, 'utf8'))).toMatchObject({
      permission: { skill: { '*': 'deny', 'react-review': 'allow' } },
    });
    expect(store.listTaskCapabilitySnapshots(task.id)[0]?.status).toBe('projected');

    const secondSkillRoot = join(root, 'api-review');
    mkdirSync(secondSkillRoot);
    writeFileSync(join(secondSkillRoot, 'SKILL.md'), '---\nname: api-review\ndescription: Review API changes.\n---\n# API review\n');
    const secondCapability = store.installCapability(store.importLocalSkill(secondSkillRoot).id);
    store.updateProjectCapability(project.id, secondCapability.id, { enabled: true });
    let secondTask = store.createTask({
      projectId: project.id, teamId: team.id, title: '检查 API 改动', description: '使用另一个项目能力完成评审。',
      expectedOutput: '可追溯的 API 评审结论',
    });
    secondTask = store.submitTask(secondTask.id, secondTask.stateVersion);
    secondTask = store.saveComposedPlan(secondTask.id, {
      goal: '完成 API 评审', scope: ['项目目录'], nonScope: [], successCriteria: ['形成结论'],
      assumptions: [], risks: [], questions: [], permissions: [], qualityGates: [],
      steps: [{
        id: 'api-review', position: 0, unitKey: 'work-unit', agentId: agent.id,
        title: '评审 API 改动', description: '按项目 Skill 检查。', inputs: [], expectedOutput: 'API 评审结论',
        directoryIds: [project.directories[0]!.id], requiredCapabilities: ['API 评审'], capabilityIds: [secondCapability.id],
        verification: ['核对检查项'], mode: 'read_only', requiresIndependentSession: false,
      }],
    });
    secondTask = store.commandTask(secondTask.id, 'confirm', secondTask.stateVersion);
    const secondProjection = store.prepareTaskCapabilityProjection(secondTask.id, 'opencode', join(root, 'runtime-2'));
    expect(existsSync(join(secondProjection.configDirectory, 'skills', 'api-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(secondProjection.configDirectory, 'skills', 'react-review'))).toBe(false);
    expect(existsSync(join(projection.configDirectory, 'skills', 'api-review'))).toBe(false);
    store.refreshProjectSpaceState(project.id);
    database.close();

    const restoredWorkbench = join(root, 'restored-workbench');
    const restoredDatabase = openDatabase(join(restoredWorkbench, 'system', 'app.db'));
    const restoredStore = new YanxuStore(restoredDatabase, restoredWorkbench);
    restoredStore.restoreProjectSpace(project.projectSpacePath);
    expect(restoredStore.listProjectCapabilities(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: capability.id, enabled: true, lockedHash: capability.contentHash }),
      expect.objectContaining({ capabilityId: secondCapability.id, enabled: true, lockedHash: secondCapability.contentHash }),
    ]));
    expect(restoredStore.listTaskCapabilitySnapshots(task.id)).toEqual([
      expect.objectContaining({ capabilityId: capability.id, status: 'frozen', projectionPath: null }),
    ]);
    restoredDatabase.close();
  });

  it('imports a ZIP as reviewable drafts without running bundled scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-capability-zip-'));
    roots.push(root);
    const sourceRoot = join(root, 'zip-review');
    const archivePath = join(root, 'zip-review.zip');
    const workbench = join(root, 'workbench');
    mkdirSync(sourceRoot);
    writeFileSync(join(sourceRoot, 'SKILL.md'), '---\nname: zip-review\ndescription: Review an imported ZIP.\n---\n# ZIP review\n');
    writeFileSync(join(sourceRoot, 'script.sh'), '#!/bin/sh\necho should-not-run\n', { mode: 0o755 });
    const archive = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', sourceRoot, archivePath]);
    expect(archive.status).toBe(0);
    const database = openDatabase(join(workbench, 'system', 'app.db'));
    const store = new YanxuStore(database, workbench);
    const imported = store.importZipSkills(archivePath);
    expect(imported).toEqual([
      expect.objectContaining({ name: 'zip-review', lifecycleStatus: 'imported', source: expect.objectContaining({ type: 'zip' }) }),
    ]);
    expect(imported[0]?.security.scripts).toContain('script.sh');
    expect(readFileSync(join(imported[0]!.managedPath!, 'script.sh'), 'utf8')).toContain('should-not-run');
    database.close();
  });
});
