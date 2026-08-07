import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorInstallation } from '@yanxu/contracts';
import { openDatabase } from './database.js';
import { discoverRoleTemplates } from './roles.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('external RoleTemplate discovery', () => {
  it('recognizes Claude, OpenCode, GitHub and prompt-role definitions without activating them', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-roles-'));
    roots.push(root);
    writeRole(root, '.claude/agents/reviewer.md', `---
name: Evidence Reviewer
description: Reviews delivery evidence independently.
tools: [Read, Grep]
skills: [security-review]
---
Review the actual diff and gate evidence. Report blocking findings with exact locations.
`);
    writeRole(root, '.opencode/agents/developer.md', `---
description: Implements approved work units.
---
Implement the approved change in the isolated workspace and verify the actual Git diff.
`);
    writeRole(root, '.github/agents/planner.agent.md', `---
name: Planner
description: Converts requirements into executable plans.
---
Create a bounded implementation plan with explicit verification checkpoints.
`);
    writeRole(root, 'agents/docs.md', 'Maintain concise project documentation and verify every referenced path before completion.');
    writeRole(root, 'AGENTS.md', '# Repository instructions\nAlways run the project checks.');

    const roles = discoverRoleTemplates(root, {
      type: 'github', scope: 'managed', executor: null, ref: 'https://github.com/example/roles', version: 'abc123',
    });
    expect(roles).toHaveLength(5);
    expect(roles.find((role) => role.name === 'Evidence Reviewer')).toMatchObject({
      format: 'claude-subagent', compatibility: ['claude'], parseStatus: 'valid', dependencyNames: ['security-review'],
    });
    expect(roles.find((role) => role.format === 'opencode-agent')?.compatibility).toEqual(['opencode']);
    expect(roles.find((role) => role.format === 'github-agent-profile')?.compatibility).toEqual(['opencode', 'claude']);
    expect(roles.find((role) => role.format === 'project-instructions')?.parseStatus).toBe('view_only');
  });

  it('keeps imported roles as drafts until review and then allows a compatible AI person', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-role-store-'));
    roots.push(root);
    const source = join(root, 'source');
    writeRole(source, '.claude/agents/reviewer.md', `---
name: External Reviewer
description: Reviews a delivery independently.
---
Read the actual task evidence and report every blocking issue with an exact location.
`);
    const database = openDatabase(join(root, 'yanxu.db'));
    const store = new YanxuStore(database, join(root, 'home'));
    const [draft] = store.importLocalRoleTemplates(source);
    expect(draft).toMatchObject({ lifecycleStatus: 'draft', compatibility: ['claude'] });
    expect(() => store.createAgent({
      name: 'Reviewer', roleId: draft!.id, executor: 'claude', model: 'claude-sonnet-custom', permissionMode: 'standard',
    }, availableClaude())).toThrow(/审查并安装/);
    const installed = store.installRoleTemplate(draft!.id);
    expect(installed.lifecycleStatus).toBe('installed');
    const agent = store.createAgent({
      name: 'Reviewer', roleId: installed.id, executor: 'claude', model: 'claude-sonnet-custom', permissionMode: 'standard',
    }, availableClaude());
    expect(agent).toMatchObject({ roleId: installed.id, executor: 'claude', model: 'claude-sonnet-custom' });
    database.close();
  });
});

function writeRole(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function availableClaude(): ExecutorInstallation {
  return {
    id: 'claude', name: 'Claude Code', command: 'claude', path: '/tmp/claude', version: 'test', health: 'available',
    capabilities: ['sessions', 'structured-output', 'permissions', 'abort'], models: ['sonnet', 'opus', 'haiku'],
    lastCheckedAt: new Date().toISOString(), error: null,
  };
}
