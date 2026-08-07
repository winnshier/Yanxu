import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export const defaultMaximumLogBytes = 20 * 1024 * 1024;

export function rotateLogFile(
  path: string,
  maximumBytes = defaultMaximumLogBytes,
  retainedFiles = 3,
): boolean {
  if (!existsSync(path) || statSync(path).size < maximumBytes) return false;
  if (retainedFiles <= 0) {
    rmSync(path, { force: true });
    return true;
  }
  rmSync(`${path}.${retainedFiles}`, { force: true });
  for (let index = retainedFiles - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
  return true;
}
