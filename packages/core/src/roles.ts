import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import type { CapabilitySource, ExecutorType } from '@yanxu/contracts';

export interface DiscoveredRoleTemplate {
  originKey: string;
  name: string;
  description: string;
  instructions: string;
  responsibilities: string[];
  dependencyNames: string[];
  defaultPermissions: string[];
  compatibility: ExecutorType[];
  source: CapabilitySource;
  version: string;
  contentHash: string;
  parseStatus: 'valid' | 'incompatible' | 'view_only';
  parseError: string | null;
  format: string;
  entryPath: string;
}

const maximumRoleFiles = 500;
const maximumRoleBytes = 1024 * 1024;

export function discoverRoleTemplates(rootPath: string, source: CapabilitySource): DiscoveredRoleTemplate[] {
  const root = resolve(rootPath);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const roleFiles = collectMarkdownFiles(root)
    .filter((path) => classifyRoleFile(relative(root, path).replaceAll('\\', '/')) !== null)
    .slice(0, maximumRoleFiles);
  return roleFiles.map((path) => inspectRoleTemplate(root, path, source));
}

function inspectRoleTemplate(root: string, entryPath: string, source: CapabilitySource): DiscoveredRoleTemplate {
  const relativePath = relative(root, entryPath).replaceAll('\\', '/');
  const classification = classifyRoleFile(relativePath);
  const content = readFileSync(entryPath, 'utf8');
  if (Buffer.byteLength(content) > maximumRoleBytes) throw new Error(`角色文件超过 ${maximumRoleBytes} 字节：${relativePath}`);
  const { attributes, body } = parseFrontmatter(content);
  const filename = basename(entryPath, extname(entryPath)).replace(/\.agent$/i, '');
  const name = stringValue(attributes.name) || humanize(filename);
  const description = stringValue(attributes.description) || firstParagraph(body).slice(0, 500);
  const responsibilities = stringList(attributes.responsibilities);
  const dependencies = [...new Set([
    ...stringList(attributes.skills),
    ...stringList(attributes.mcpServers),
    ...stringList(attributes['mcp-servers']),
  ])];
  const defaultPermissions = [...new Set([
    ...stringList(attributes.tools),
    ...stringList(attributes.permissions),
    ...stringList(attributes['allowed-tools']),
  ])];
  const contentHash = sha256(content);
  const isInstructionFile = classification?.format === 'project-instructions';
  const compatibility = classification?.compatibility ?? [];
  const hasPrompt = body.trim().length >= 20;
  const parseStatus = isInstructionFile
    ? 'view_only'
    : compatibility.length === 0
      ? 'incompatible'
      : hasPrompt ? 'valid' : 'incompatible';
  const parseError = isInstructionFile
    ? '这是项目级指令文件，不会自动转换为人员角色；可查看并手动改写为角色。'
    : hasPrompt ? null : '角色文件缺少可执行的提示词正文。';
  const sourceWithEntry = { ...source, ref: `${source.ref}${source.ref.includes('#') ? '/' : '#'}${relativePath}` };
  return {
    originKey: sha256(JSON.stringify({
      sourceType: sourceWithEntry.type,
      sourceRef: sourceWithEntry.ref,
      name,
      format: classification?.format,
    })),
    name,
    description,
    instructions: body.trim(),
    responsibilities: responsibilities.length ? responsibilities : inferResponsibilities(body),
    dependencyNames: dependencies,
    defaultPermissions,
    compatibility,
    source: sourceWithEntry,
    version: source.version ?? contentHash.slice(0, 12),
    contentHash,
    parseStatus,
    parseError,
    format: classification?.format ?? 'unknown',
    entryPath,
  };
}

function classifyRoleFile(path: string): { format: string; compatibility: ExecutorType[] } | null {
  const normalized = path.toLowerCase();
  if (normalized === 'agents.md' || normalized === 'claude.md') {
    return { format: 'project-instructions', compatibility: normalized === 'claude.md' ? ['claude'] : ['opencode', 'claude'] };
  }
  if (/^(?:.*\/)?\.claude\/agents\/[^/]+\.md$/.test(normalized)) {
    return { format: 'claude-subagent', compatibility: ['claude'] };
  }
  if (/^(?:.*\/)?\.opencode\/agents\/[^/]+\.md$/.test(normalized)) {
    return { format: 'opencode-agent', compatibility: ['opencode'] };
  }
  if (/^(?:.*\/)?\.github\/agents\/[^/]+\.agent\.md$/.test(normalized)) {
    return { format: 'github-agent-profile', compatibility: ['opencode', 'claude'] };
  }
  if (/^(?:.*\/)?agents\/[^/]+\.md$/.test(normalized)) {
    return { format: 'prompt-role', compatibility: ['opencode', 'claude'] };
  }
  return null;
}

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        visit(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
      if (files.length >= maximumRoleFiles) return;
    }
  };
  visit(root);
  return files;
}

function parseFrontmatter(content: string): { attributes: Record<string, unknown>; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return { attributes: {}, body: content };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match?.[1]) return { attributes: {}, body: content };
  const attributes: Record<string, unknown> = {};
  let activeList: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem?.[1] && activeList) {
      const current = Array.isArray(attributes[activeList]) ? attributes[activeList] as unknown[] : [];
      current.push(unquote(listItem[1].trim()));
      attributes[activeList] = current;
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair?.[1]) continue;
    const key = pair[1];
    const raw = pair[2]?.trim() ?? '';
    if (!raw) {
      attributes[key] = [];
      activeList = key;
    } else {
      attributes[key] = parseScalar(raw);
      activeList = null;
    }
  }
  return { attributes, body: content.slice(match[0].length) };
}

function parseScalar(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean);
  }
  return unquote(value);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function firstParagraph(body: string): string {
  return body.replace(/^#+\s+.*$/m, '').split(/\r?\n\s*\r?\n/).map((item) => item.trim()).find(Boolean) ?? '';
}

function inferResponsibilities(body: string): string[] {
  return body.split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
