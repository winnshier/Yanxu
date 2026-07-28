import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DomainError } from '@yanxu/core';

export interface FolderSelectionRecord {
  token: string;
  displayPath: string;
  expiresAt: string;
}

export class FolderSelectionRegistry {
  private readonly selections = new Map<string, { path: string; expiresAt: number }>();

  constructor(private readonly ttlMilliseconds = 5 * 60_000) {}

  issue(path: string): FolderSelectionRecord {
    const resolvedPath = realpathSync(path);
    if (!statSync(resolvedPath).isDirectory()) {
      throw new DomainError('FOLDER_SELECTION_NOT_DIRECTORY', '所选内容不是文件夹。', 422);
    }
    this.prune();
    const token = randomUUID();
    const expiresAt = Date.now() + this.ttlMilliseconds;
    this.selections.set(token, { path: resolvedPath, expiresAt });
    return { token, displayPath: resolvedPath, expiresAt: new Date(expiresAt).toISOString() };
  }

  resolve(token: string, consume = true): string {
    this.prune();
    const selection = this.selections.get(token);
    if (!selection) {
      throw new DomainError('FOLDER_SELECTION_INVALID', '文件夹选择已失效，请重新选择。', 422);
    }
    if (consume) this.selections.delete(token);
    return selection.path;
  }

  private prune(): void {
    const timestamp = Date.now();
    for (const [token, selection] of this.selections) {
      if (selection.expiresAt <= timestamp) this.selections.delete(token);
    }
  }
}

export interface FileSelectionRecord {
  token: string;
  displayPath: string;
  fileName: string;
  size: number;
  expiresAt: string;
}

export class FileSelectionRegistry {
  private readonly selections = new Map<string, { path: string; expiresAt: number }>();

  constructor(
    private readonly ttlMilliseconds = 5 * 60_000,
    private readonly maximumBytes = 10 * 1024 * 1024,
  ) {}

  issue(path: string): FileSelectionRecord {
    const resolvedPath = realpathSync(path);
    const statistics = statSync(resolvedPath);
    if (!statistics.isFile()) {
      throw new DomainError('FILE_SELECTION_NOT_FILE', '所选内容不是普通文件。', 422);
    }
    if (statistics.size > this.maximumBytes) {
      throw new DomainError('FILE_SELECTION_TOO_LARGE', '单个附件不能超过 10 MB。', 422, {
        size: statistics.size,
        maximumBytes: this.maximumBytes,
      });
    }
    this.prune();
    const token = randomUUID();
    const expiresAt = Date.now() + this.ttlMilliseconds;
    this.selections.set(token, { path: resolvedPath, expiresAt });
    return {
      token,
      displayPath: resolvedPath,
      fileName: basename(resolvedPath),
      size: statistics.size,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  resolve(token: string, consume = true): string {
    this.prune();
    const selection = this.selections.get(token);
    if (!selection) {
      throw new DomainError('FILE_SELECTION_INVALID', '附件选择已失效，请重新选择。', 422);
    }
    if (consume) this.selections.delete(token);
    return selection.path;
  }

  private prune(): void {
    const timestamp = Date.now();
    for (const [token, selection] of this.selections) {
      if (selection.expiresAt <= timestamp) this.selections.delete(token);
    }
  }
}

export function chooseFolder(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new DomainError('PLATFORM_UNSUPPORTED', '第一期文件夹选择器仅支持 macOS。', 501));
      return;
    }
    const script = [
      'set chosenFolder to choose folder with prompt "选择要关联到研序的项目目录"',
      'POSIX path of chosenFolder',
    ];
    const child = spawn('/usr/bin/osascript', script.flatMap((line) => ['-e', line]), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim().replace(/\/$/, ''));
      else if (stderr.includes('User canceled')) reject(new DomainError('FOLDER_PICKER_CANCELLED', '已取消选择文件夹。', 400));
      else reject(new DomainError('FOLDER_PICKER_FAILED', stderr.trim() || '无法打开文件夹选择器。', 500));
    });
  });
}

export function chooseFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new DomainError('PLATFORM_UNSUPPORTED', '第一期文件选择器仅支持 macOS。', 501));
      return;
    }
    const script = [
      'set chosenFile to choose file with prompt "选择要附加到任务的文件"',
      'POSIX path of chosenFile',
    ];
    const child = spawn('/usr/bin/osascript', script.flatMap((line) => ['-e', line]), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else if (stderr.includes('User canceled')) reject(new DomainError('FILE_PICKER_CANCELLED', '已取消选择附件。', 400));
      else reject(new DomainError('FILE_PICKER_FAILED', stderr.trim() || '无法打开文件选择器。', 500));
    });
  });
}
