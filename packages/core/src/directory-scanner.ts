import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectDirectory } from '@yanxu/contracts';
import { DomainError } from './errors.js';

interface ScanInput {
  id: string;
  projectId: string;
  selectedPath: string;
  initializeGit?: boolean;
}

function git(path: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function parsePackageJson(path: string): { stack: string[]; commands: Record<string, string> } {
  try {
    const raw = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...raw.dependencies, ...raw.devDependencies };
    const stack = ['react', 'vue', 'next', 'vite', 'typescript', 'fastify', 'express', 'nestjs']
      .filter((name) => name in all);
    const runner = existsSync(join(path, 'pnpm-lock.yaml'))
      ? (name: string) => `pnpm ${name}`
      : existsSync(join(path, 'yarn.lock'))
        ? (name: string) => `yarn ${name}`
        : existsSync(join(path, 'bun.lock')) || existsSync(join(path, 'bun.lockb'))
          ? (name: string) => `bun run ${name}`
          : (name: string) => `npm run ${name}`;
    return { stack, commands: Object.fromEntries(Object.keys(raw.scripts ?? {}).map((name) => [name, runner(name)])) };
  } catch {
    return { stack: [], commands: {} };
  }
}

export function scanProjectDirectory(input: ScanInput): ProjectDirectory {
  if (!existsSync(input.selectedPath) || !lstatSync(input.selectedPath).isDirectory()) {
    throw new DomainError('DIRECTORY_NOT_FOUND', '选择的项目目录不存在或不是文件夹。', 422);
  }

  const realPath = realpathSync(input.selectedPath);
  let gitRootPath = git(realPath, ['rev-parse', '--show-toplevel']);
  if (!gitRootPath && input.initializeGit) {
    const initialized = spawnSync('git', ['init', '-b', 'main', realPath], { encoding: 'utf8', timeout: 10_000 });
    if (initialized.status !== 0) {
      throw new DomainError('GIT_INIT_FAILED', initialized.stderr.trim() || '无法初始化本地 Git。', 422);
    }
    gitRootPath = realPath;
  }
  if (gitRootPath && input.initializeGit && !git(gitRootPath, ['rev-parse', '--verify', 'HEAD'])) {
    const add = spawnSync('git', [
      '-C', gitRootPath, 'add', '-A', '--', '.',
      ':(exclude).env', ':(exclude).env.*', ':(exclude)*.pem', ':(exclude)*.key', ':(exclude)id_rsa*', ':(exclude).DS_Store',
      ':(exclude)**/.env', ':(exclude)**/.env.*', ':(exclude)**/*.pem', ':(exclude)**/*.key',
      ':(exclude)**/id_rsa*', ':(exclude)**/.DS_Store',
    ], { encoding: 'utf8', timeout: 30_000 });
    if (add.status !== 0) throw new DomainError('GIT_INITIAL_COMMIT_FAILED', add.stderr.trim() || '无法创建本地 Git 初始快照。', 422);
    const commit = spawnSync('git', [
      '-C', gitRootPath, '-c', 'user.name=Yanxu', '-c', 'user.email=yanxu@local',
      'commit', '--allow-empty', '-m', 'chore: initialize local project',
    ], { encoding: 'utf8', timeout: 30_000 });
    if (commit.status !== 0) throw new DomainError('GIT_INITIAL_COMMIT_FAILED', commit.stderr.trim() || '无法创建本地 Git 初始提交。', 422);
  }

  const names = new Set(readdirSync(realPath).slice(0, 500));
  const contentTypes: string[] = [];
  if (names.has('package.json') || names.has('src')) contentTypes.push('代码');
  if (names.has('README.md') || names.has('docs')) contentTypes.push('文档');
  if (names.has('design') || names.has('assets')) contentTypes.push('设计/资源');
  if (contentTypes.length === 0) contentTypes.push(names.size === 0 ? '空目录' : '通用目录');

  const packageInfo = names.has('package.json') ? parsePackageJson(realPath) : { stack: [], commands: {} };
  const stack = [...packageInfo.stack];
  const commands = { ...packageInfo.commands };
  if (names.has('pyproject.toml') || names.has('requirements.txt')) stack.push('python');
  if (names.has('pyproject.toml') || names.has('requirements.txt')) {
    const pythonConfiguration = ['pyproject.toml', 'requirements.txt', 'pytest.ini', 'mypy.ini', 'ruff.toml']
      .filter((name) => names.has(name)).map((name) => readFileSync(join(realPath, name), 'utf8')).join('\n');
    if (names.has('tests') || names.has('pytest.ini') || /pytest/i.test(pythonConfiguration)) commands.test ??= 'python -m pytest';
    if (names.has('ruff.toml') || /\[tool\.ruff/i.test(pythonConfiguration)) commands.lint ??= 'python -m ruff check .';
    if (names.has('mypy.ini') || /\[tool\.mypy/i.test(pythonConfiguration)) commands.typecheck ??= 'python -m mypy .';
  }
  if (names.has('go.mod')) {
    stack.push('go');
    commands.test ??= 'go test ./...';
    commands.build ??= 'go build ./...';
  }
  if (names.has('Cargo.toml')) {
    stack.push('rust');
    commands.test ??= 'cargo test';
    commands.lint ??= 'cargo clippy -- -D warnings';
    commands.build ??= 'cargo build';
  }
  if (names.has('Makefile')) {
    const makefile = readFileSync(join(realPath, 'Makefile'), 'utf8');
    for (const target of ['typecheck', 'lint', 'test', 'build']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile)) commands[target] ??= `make ${target}`;
    }
  }

  return {
    id: input.id,
    projectId: input.projectId,
    displayName: basename(realPath),
    selectedPath: input.selectedPath,
    realPath,
    gitRootPath,
    gitInitialized: Boolean(gitRootPath),
    currentBranch: gitRootPath ? git(gitRootPath, ['branch', '--show-current']) || null : null,
    isDirty: gitRootPath ? Boolean(git(gitRootPath, ['status', '--porcelain'])) : false,
    contentTypes,
    stack: [...new Set(stack)],
    commands,
    localBranches: gitRootPath ? (git(gitRootPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']) ?? '').split('\n').filter(Boolean) : [],
    scannedAt: new Date().toISOString(),
  };
}
