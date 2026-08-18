import type { Capability } from '@yanxu/contracts';

export interface CapabilityGroup {
  key: string;
  kind: Capability['kind'];
  name: string;
  variants: Capability[];
}

export function groupCapabilities(capabilities: Capability[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const capability of capabilities) {
    const key = `${capability.kind}:${capability.name.toLocaleLowerCase()}`;
    const group = groups.get(key) ?? { key, kind: capability.kind, name: capability.name, variants: [] };
    group.variants.push(capability);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      variants: [...group.variants].sort((left, right) =>
        Number(right.lifecycleStatus === 'installed') - Number(left.lifecycleStatus === 'installed')
        || Number(right.source.type === 'builtin') - Number(left.source.type === 'builtin')
        || right.updatedAt.localeCompare(left.updatedAt)),
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

export function selectedCapabilityForGroup(
  group: CapabilityGroup,
  selectedCapabilityId?: string,
): Capability {
  return group.variants.find((capability) => capability.id === selectedCapabilityId)
    ?? group.variants.find((capability) => capability.lifecycleStatus === 'installed')
    ?? group.variants.find((capability) => capability.source.type === 'builtin')
    ?? group.variants[0]!;
}

export function installedCapabilityForGroup(group: CapabilityGroup): Capability | undefined {
  return group.variants.find((capability) => capability.lifecycleStatus === 'installed');
}
