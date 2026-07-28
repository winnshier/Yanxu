import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProjectSpacePaths {
  root: string;
  requirements: string;
  plans: string;
  reports: string;
  knowledge: string;
}

export function ensureProjectSpace(workbenchHome: string, projectId: string, name: string, description: string): ProjectSpacePaths {
  const root = join(workbenchHome, 'projects', projectId);
  const paths = {
    root,
    requirements: join(root, 'requirements'),
    plans: join(root, 'plans'),
    reports: join(root, 'reports'),
    knowledge: join(root, 'knowledge'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });

  if (!existsSync(join(root, '.git'))) {
    spawnSync('git', ['init', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Yanxu'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'yanxu@local'], { encoding: 'utf8' });
    writeAtomic(join(root, 'README.md'), `# ${name}\n\n${description || '由研序管理的本地项目空间。'}\n`);
    writeAtomic(join(root, 'project.json'), `${JSON.stringify({ id: projectId, name, description }, null, 2)}\n`);
    commitProjectSpace(root, 'chore: initialize project space');
  }
  return paths;
}

export function writeVersionedArtifact(root: string, relativePath: string, content: string): { path: string; hash: string } {
  const target = join(root, relativePath);
  writeAtomic(target, content);
  return { path: target, hash: createHash('sha256').update(content).digest('hex') };
}

export function commitProjectSpace(
  root: string,
  message: string,
  allowedPaths?: string[],
): { commitHash: string; changedFiles: string[] } {
  const relativePaths = [...new Set((allowedPaths ?? ['.']).map((path) => {
    const candidate = isAbsolute(path) ? relative(root, path) : path;
    if (candidate === '..' || candidate.startsWith('../') || isAbsolute(candidate)) {
      throw new Error(`Refusing to stage a path outside ProjectSpace: ${path}`);
    }
    return candidate || '.';
  }))];
  runGit(root, ['add', '--', ...relativePaths]);
  const staged = runGit(root, ['diff', '--cached', '--name-only']);
  const changedFiles = staged.stdout.split('\n').filter(Boolean);
  runGit(root, ['commit', '--allow-empty', '-m', message]);
  const commitHash = runGit(root, ['rev-parse', 'HEAD']).stdout;
  return { commitHash, changedFiles };
}

function writeAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
}

function runGit(root: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed in ProjectSpace.`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
