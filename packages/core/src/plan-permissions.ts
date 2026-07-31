import type { TaskPlan } from '@yanxu/contracts';

type PlanCommandPolicy = Pick<TaskPlan, 'permissions' | 'qualityGates'>;

const safeCommandArgument = /^[A-Za-z0-9_./-]+$/;

function isSafeRelativeCommandPath(value: string): boolean {
  if (!safeCommandArgument.test(value) || value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '..' && segment !== '');
}

function npmPrefixes(plan: PlanCommandPolicy): { hasPrefixedGate: boolean; values: string[] } {
  let hasPrefixedGate = false;
  const values = plan.qualityGates.flatMap((gate) => {
    const argv = gate.commandArgv ?? gate.command.trim().split(/\s+/);
    if (argv[0] !== 'npm' || argv[1] !== '--prefix') return [];
    hasPrefixedGate = true;
    if (!argv[2] || !isSafeRelativeCommandPath(argv[2])) return [];
    return [argv[2]];
  });
  return { hasPrefixedGate, values: [...new Set(values)] };
}

function npmInstallPatterns(prefix: string | null): string[] {
  const commands = ['install', 'ci', 'i'];
  if (!prefix) {
    return commands.map((command) => `npm ${command}`);
  }
  return commands.flatMap((command) => [
    `npm --prefix ${prefix} ${command}`,
    `npm ${command} --prefix ${prefix}`,
    `cd ${prefix} && npm ${command}`,
  ]);
}

/**
 * Turns canonical, user-approved plan capabilities into concrete command rules.
 *
 * Command targets are derived from approved quality gates instead of using a
 * broad wildcard. A new subproject can install its own dependencies while
 * managed mode stays fail-closed everywhere else.
 */
export function commandPatternsForPlanPermissions(plan: PlanCommandPolicy): string[] {
  const permissions = new Set(plan.permissions);
  const patterns = new Set<string>();

  if (permissions.has('shell:npm_install')) {
    const prefixes = npmPrefixes(plan);
    for (const pattern of prefixes.hasPrefixedGate
      ? prefixes.values.flatMap((prefix) => npmInstallPatterns(prefix))
      : npmInstallPatterns(null)) {
      patterns.add(pattern);
    }
  }

  return [...patterns];
}
