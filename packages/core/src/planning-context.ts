import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Project } from '@yanxu/contracts';
import type { SqliteDatabase } from './database.js';

export interface PlanningFileExcerpt {
  path: string;
  score: number;
  excerpt: string;
}

export interface PlanningDirectoryContext {
  directoryId: string;
  displayName: string;
  fileCount: number;
  indexedFiles: string[];
  excerpts: PlanningFileExcerpt[];
  truncated: boolean;
  refreshedFiles?: number;
  indexedAt?: string;
}

const skippedDirectories = new Set([
  '.git', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv',
  'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor',
]);
const importantNames = new Set([
  'readme.md', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.json',
  'pyproject.toml', 'go.mod', 'cargo.toml', 'makefile', 'dockerfile',
  'openapi.yaml', 'openapi.yml',
]);
const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.graphql', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.md', '.mjs', '.mts',
  '.php', '.prisma', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift',
  '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml',
]);

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
  sample: string;
  score: number;
}

interface IndexedFileRow {
  directory_id: string;
  relative_path: string;
  size_bytes: number;
  modified_at_ms: number;
  sample: string;
  sample_hash: string;
  indexed_at: string;
}

interface PlanningContextOptions {
  maxFiles?: number;
  maxIndexedFiles?: number;
  maxCharacters?: number;
  maxExcerpts?: number;
}

export function buildPlanningContext(
  project: Project,
  query: string,
  options: PlanningContextOptions = {},
): PlanningDirectoryContext[] {
  const maxFiles = options.maxFiles ?? 2_500;
  const maxIndexedFiles = options.maxIndexedFiles ?? 500;
  const maxCharacters = options.maxCharacters ?? 64_000;
  const maxExcerpts = options.maxExcerpts ?? 18;
  const terms = searchTerms(query);
  let remainingCharacters = maxCharacters;

  return project.directories.map((directory) => {
    const discovered = discoverFiles(directory.realPath, maxFiles);
    const candidates = discovered.files
      .filter((path) => isTextFile(path) && !isSensitivePath(path))
      .map((absolutePath) => {
        const relativePath = normalizePath(relative(directory.realPath, absolutePath));
        const sample = readTextSample(absolutePath, 8_000);
        return {
          absolutePath,
          relativePath,
          sample,
          score: scoreFile(relativePath, sample, terms),
        } satisfies CandidateFile;
      })
      .filter((file) => file.sample.length > 0)
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

    const excerpts: PlanningFileExcerpt[] = [];
    for (const candidate of candidates.slice(0, maxExcerpts)) {
      if (remainingCharacters <= 0) break;
      const excerpt = candidate.sample.slice(0, Math.min(5_000, remainingCharacters));
      remainingCharacters -= excerpt.length;
      excerpts.push({ path: candidate.relativePath, score: candidate.score, excerpt });
    }
    return {
      directoryId: directory.id,
      displayName: directory.displayName,
      fileCount: discovered.files.length,
      indexedFiles: discovered.files
        .map((path) => normalizePath(relative(directory.realPath, path)))
        .filter((path) => !isSensitivePath(path))
        .sort()
        .slice(0, maxIndexedFiles),
      excerpts,
      truncated: discovered.truncated
        || discovered.files.length > maxIndexedFiles
        || candidates.length > excerpts.length,
    };
  });
}

export function buildIndexedPlanningContext(
  database: SqliteDatabase,
  project: Project,
  query: string,
  options: PlanningContextOptions = {},
): PlanningDirectoryContext[] {
  const maxFiles = options.maxFiles ?? 2_500;
  const maxIndexedFiles = options.maxIndexedFiles ?? 500;
  const maxCharacters = options.maxCharacters ?? 64_000;
  const maxExcerpts = options.maxExcerpts ?? 18;
  const terms = searchTerms(query);
  let remainingCharacters = maxCharacters;

  return project.directories.map((directory) => {
    const discovered = discoverFiles(directory.realPath, maxFiles);
    const existingRows = database.prepare(`
      SELECT * FROM project_file_index WHERE directory_id = ?
    `).all(directory.id) as IndexedFileRow[];
    const existing = new Map(existingRows.map((row) => [row.relative_path, row]));
    const currentPaths = new Set<string>();
    const refreshedAt = new Date().toISOString();
    let refreshedFiles = 0;

    database.transaction(() => {
      const upsert = database.prepare(`
        INSERT INTO project_file_index(
          directory_id, relative_path, size_bytes, modified_at_ms, sample, sample_hash, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(directory_id, relative_path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          modified_at_ms = excluded.modified_at_ms,
          sample = excluded.sample,
          sample_hash = excluded.sample_hash,
          indexed_at = excluded.indexed_at
      `);
      const removeIndex = database.prepare(`
        DELETE FROM project_file_index WHERE directory_id = ? AND relative_path = ?
      `);
      const removeSearch = database.prepare(`
        DELETE FROM project_file_fts WHERE directory_id = ? AND relative_path = ?
      `);
      const addSearch = database.prepare(`
        INSERT INTO project_file_fts(directory_id, relative_path, sample) VALUES (?, ?, ?)
      `);

      for (const absolutePath of discovered.files) {
        const relativePath = normalizePath(relative(directory.realPath, absolutePath));
        if (!isTextFile(relativePath) || isSensitivePath(relativePath)) continue;
        currentPaths.add(relativePath);
        let stats: ReturnType<typeof statSync>;
        try {
          stats = statSync(absolutePath);
        } catch {
          continue;
        }
        const previous = existing.get(relativePath);
        if (previous
          && previous.size_bytes === stats.size
          && previous.modified_at_ms === stats.mtimeMs) {
          continue;
        }
        const sample = readTextSample(absolutePath, 8_000);
        removeSearch.run(directory.id, relativePath);
        if (!sample) {
          removeIndex.run(directory.id, relativePath);
          continue;
        }
        const sampleHash = createHash('sha256').update(sample).digest('hex');
        upsert.run(directory.id, relativePath, stats.size, stats.mtimeMs, sample, sampleHash, refreshedAt);
        addSearch.run(directory.id, relativePath, sample);
        refreshedFiles += 1;
      }
      for (const row of existingRows) {
        if (currentPaths.has(row.relative_path)) continue;
        removeSearch.run(directory.id, row.relative_path);
        removeIndex.run(directory.id, row.relative_path);
      }
    })();

    const indexedRows = database.prepare(`
      SELECT * FROM project_file_index WHERE directory_id = ? ORDER BY relative_path
    `).all(directory.id) as IndexedFileRow[];
    const candidates = indexedRows.map((row) => ({
      absolutePath: join(directory.realPath, row.relative_path),
      relativePath: row.relative_path,
      sample: row.sample,
      score: scoreFile(row.relative_path, row.sample, terms),
    } satisfies CandidateFile)).sort((a, b) =>
      b.score - a.score || a.relativePath.localeCompare(b.relativePath));
    const excerpts: PlanningFileExcerpt[] = [];
    for (const candidate of candidates.slice(0, maxExcerpts)) {
      if (remainingCharacters <= 0) break;
      const excerpt = candidate.sample.slice(0, Math.min(5_000, remainingCharacters));
      remainingCharacters -= excerpt.length;
      excerpts.push({ path: candidate.relativePath, score: candidate.score, excerpt });
    }
    return {
      directoryId: directory.id,
      displayName: directory.displayName,
      fileCount: discovered.files.length,
      indexedFiles: indexedRows.map((row) => row.relative_path).slice(0, maxIndexedFiles),
      excerpts,
      truncated: discovered.truncated
        || indexedRows.length > maxIndexedFiles
        || candidates.length > excerpts.length,
      refreshedFiles,
      indexedAt: refreshedAt,
    };
  });
}

function discoverFiles(root: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const queue = [root];
  let truncated = false;
  while (queue.length > 0 && files.length < limit) {
    const directory = queue.shift();
    if (!directory) break;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) queue.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  if (queue.length > 0) truncated = true;
  return { files, truncated };
}

function readTextSample(path: string, limit: number): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(limit);
    const length = readSync(descriptor, buffer, 0, limit, 0);
    const sample = buffer.subarray(0, length);
    if (sample.includes(0)) return '';
    return sample.toString('utf8');
  } catch {
    return '';
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function isTextFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  const name = normalizePath(path).split('/').at(-1)?.toLowerCase() ?? '';
  return textExtensions.has(extension) || importantNames.has(name);
}

function scoreFile(path: string, sample: string, terms: string[]): number {
  const normalizedPath = path.toLowerCase();
  const normalizedSample = sample.toLowerCase();
  const name = normalizedPath.split('/').at(-1) ?? normalizedPath;
  let score = importantNames.has(name) ? 40 : normalizedPath.startsWith('docs/') ? 20 : 1;
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 30;
    if (normalizedSample.includes(term)) score += 8;
  }
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(normalizedPath)) score += 4;
  return score;
}

function searchTerms(input: string): string[] {
  const normalized = input.toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_-]{2,}/g) ?? []);
  const chinese = normalized.replace(/[^\u3400-\u9fff]/g, '');
  for (let index = 0; index < chinese.length - 1; index += 1) {
    terms.add(chinese.slice(index, index + 2));
  }
  return [...terms].slice(0, 80);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isSensitivePath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  return /(^|\/)\.env(?:\.|$)/.test(normalized)
    || /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(normalized)
    || /\.(pem|key|p12|pfx|jks)$/.test(normalized)
    || /(^|\/)(credentials|secrets?)(?:\.|\/|$)/.test(normalized);
}
