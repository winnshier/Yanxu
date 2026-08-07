import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutablePath } from './probe.js';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('resolveExecutablePath', () => {
  it('finds a CLI installed under another NVM Node version', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'yanxu-probe-'));
    fixtures.push(userHome);
    const executable = join(userHome, '.nvm', 'versions', 'node', 'v18.20.4', 'bin', 'claude');
    mkdirSync(join(executable, '..'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nprintf "2.1.220 (Claude Code)\\n"\n');
    chmodSync(executable, 0o700);

    await expect(resolveExecutablePath('claude', {
      environment: { PATH: '/usr/bin:/bin' },
      userHome,
      useLoginShell: false,
    })).resolves.toBe(executable);
  });

  it('prefers the executable already available in the daemon PATH', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'yanxu-probe-'));
    fixtures.push(userHome);
    const pathDirectory = join(userHome, 'active-node', 'bin');
    const executable = join(pathDirectory, 'claude');
    mkdirSync(pathDirectory, { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o700);

    await expect(resolveExecutablePath('claude', {
      environment: { PATH: `${pathDirectory}:/usr/bin:/bin` },
      userHome,
      useLoginShell: false,
    })).resolves.toBe(executable);
  });
});
