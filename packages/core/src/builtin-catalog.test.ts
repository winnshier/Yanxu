import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinRoles, builtinSkills } from '@yanxu/builtins';
import { openDatabase } from './database.js';
import { YanxuStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('builtin Agent and Skill catalog', () => {
  it('ships only the agreed 11 roles and 39 installed skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-builtin-catalog-'));
    roots.push(root);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const store = new YanxuStore(database, root);

    expect(builtinRoles).toHaveLength(11);
    expect(new Set(builtinRoles.map((role) => role.id)).size).toBe(11);
    expect(builtinRoles.map((role) => role.id)).not.toEqual(expect.arrayContaining([
      'product', 'development', 'testing', 'review',
    ]));
    expect(builtinSkills).toHaveLength(39);
    expect(builtinSkills.filter((skill) => skill.pack === 'common')).toHaveLength(17);
    expect(builtinSkills.filter((skill) => skill.pack === 'development')).toHaveLength(22);

    const capabilities = store.listCapabilities().filter((capability) => capability.source.type === 'builtin');
    expect(capabilities).toHaveLength(39);
    expect(capabilities.every((capability) => capability.lifecycleStatus === 'installed')).toBe(true);
    expect(capabilities.every((capability) => capability.compatibility.join(',') === 'opencode,claude')).toBe(true);
    for (const capability of capabilities) {
      expect(capability.managedPath).not.toBeNull();
      const entry = join(capability.managedPath!, 'SKILL.md');
      expect(existsSync(entry)).toBe(true);
      expect(readFileSync(entry, 'utf8')).toContain(`name: ${capability.name}`);
    }
    const capabilityIds = new Set(capabilities.map((capability) => capability.id));
    for (const role of builtinRoles) {
      expect(role.capabilityIds.length).toBeGreaterThan(0);
      expect(role.capabilityIds.every((capabilityId) => capabilityIds.has(capabilityId))).toBe(true);
    }
    database.close();
  });

  it('moves existing people off the removed four-role catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'yanxu-builtin-role-migration-'));
    roots.push(root);
    const database = openDatabase(join(root, 'system', 'app.db'));
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO agent_profiles(
        id, name, role_id, executor, model, parameters_json, default_capability_ids_json,
        permission_mode, status, created_at, updated_at
      ) VALUES ('legacy-agent', '旧研发人员', 'development', 'opencode', 'test/model', '{}', '[]',
        'standard', 'active', ?, ?)
    `).run(timestamp, timestamp);

    const store = new YanxuStore(database, root);
    const agent = store.getAgent('legacy-agent');
    const replacement = builtinRoles.find((role) => role.id === 'implementation-worker')!;
    expect(agent.roleId).toBe('implementation-worker');
    expect(agent.defaultCapabilityIds).toEqual(replacement.capabilityIds);
    database.close();
  });
});
