import { describe, expect, it } from 'vitest';
import type { Capability } from '@yanxu/contracts';
import { groupCapabilities, selectedCapabilityForGroup } from './capability-groups.js';

function capability(
  id: string,
  sourceType: Capability['source']['type'],
  lifecycleStatus: Capability['lifecycleStatus'],
  kind: Capability['kind'] = 'skill',
): Capability {
  return {
    id,
    originKey: id,
    kind,
    name: 'source-verification',
    description: 'Verify sources.',
    source: { type: sourceType, scope: 'managed', executor: null, ref: `/skills/${id}`, version: null },
    version: '1.0.0',
    contentHash: id,
    compatibility: ['opencode', 'claude'],
    lifecycleStatus,
    parseStatus: 'valid',
    parseError: null,
    commandStatus: 'not_applicable',
    runtimeHealth: 'not_applicable',
    credentialRefs: [],
    manifest: {},
    managedPath: null,
    security: {
      files: [], scripts: [], executableFiles: [], networkHosts: [], environmentKeys: [], headerKeys: [],
      localCredentialBindings: 0, containsLiteralSecrets: false,
    },
    lastDiscoveredAt: '2026-08-10T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

describe('capability source grouping', () => {
  it('deduplicates a logical Skill while preserving selectable sources', () => {
    const groups = groupCapabilities([
      capability('builtin', 'builtin', 'installed'),
      capability('opencode', 'opencode', 'discovered'),
      capability('claude', 'claude', 'discovered'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.variants).toHaveLength(3);
    expect(selectedCapabilityForGroup(groups[0]!).id).toBe('builtin');
    expect(selectedCapabilityForGroup(groups[0]!, 'claude').id).toBe('claude');
  });

  it('does not combine an MCP with a same-name Skill', () => {
    const groups = groupCapabilities([
      capability('skill', 'builtin', 'installed'),
      capability('mcp', 'opencode', 'installed', 'mcp'),
    ]);
    expect(groups).toHaveLength(2);
  });
});
