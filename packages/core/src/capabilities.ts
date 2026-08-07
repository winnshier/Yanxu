import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type {
  CapabilityCommandStatus,
  CapabilityKind,
  CapabilityParseStatus,
  CapabilityRuntimeHealth,
  CapabilitySecuritySummary,
  CapabilitySource,
  ExecutorType,
  ProjectDirectory,
} from '@yanxu/contracts';

const maximumFiles = 1_000;
const maximumFileBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 20 * 1024 * 1024;
const scriptExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.sh', '.bash', '.zsh', '.py', '.rb', '.pl']);
const secretNamePattern = /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i;
const environmentReferencePattern = /(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*))/g;

export interface LocalCredentialBinding {
  reference: string;
  sourcePath: string;
  sourceShape: 'opencode' | 'claude' | 'claude_state';
  capabilityName: string;
  scopeSuffix: string | null;
  valuePath: Array<string | number>;
}

export interface LocalCredentialResolution {
  environment: Record<string, string>;
  missing: Array<{ reference: string; reason: string }>;
}

export interface DiscoveredCapability {
  originKey: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  source: CapabilitySource;
  version: string;
  contentHash: string;
  compatibility: ExecutorType[];
  parseStatus: CapabilityParseStatus;
  parseError: string | null;
  commandStatus: CapabilityCommandStatus;
  runtimeHealth: CapabilityRuntimeHealth;
  credentialRefs: string[];
  manifest: Record<string, unknown>;
  security: CapabilitySecuritySummary;
}

export interface LocalCapabilityScanResult {
  capabilities: DiscoveredCapability[];
  sourceErrors: Array<{ source: string; message: string }>;
}

interface SkillSource {
  root: string;
  source: CapabilitySource;
}

interface McpConfigSource {
  path: string;
  source: CapabilitySource;
  shape: 'opencode' | 'claude' | 'claude_state';
}

export function discoverLocalCapabilities(
  projectDirectories: ProjectDirectory[] = [],
  userHome = homedir(),
): LocalCapabilityScanResult {
  const capabilities: DiscoveredCapability[] = [];
  const sourceErrors: Array<{ source: string; message: string }> = [];
  const skillSources: SkillSource[] = [
    {
      root: join(userHome, '.config', 'opencode', 'skills'),
      source: source('opencode', 'global', 'opencode', join(userHome, '.config', 'opencode', 'skills')),
    },
    {
      root: join(userHome, '.claude', 'skills'),
      source: source('claude', 'global', 'claude', join(userHome, '.claude', 'skills')),
    },
    {
      root: join(userHome, '.agents', 'skills'),
      source: source('opencode', 'global', 'opencode', join(userHome, '.agents', 'skills')),
    },
  ];
  const mcpSources: McpConfigSource[] = [
    ...['opencode.json', 'opencode.jsonc'].map((file) => ({
      path: join(userHome, '.config', 'opencode', file),
      source: source('opencode', 'global', 'opencode', join(userHome, '.config', 'opencode', file)),
      shape: 'opencode' as const,
    })),
    {
      path: join(userHome, '.claude.json'),
      source: source('claude', 'global', 'claude', join(userHome, '.claude.json')),
      shape: 'claude_state',
    },
  ];
  const customOpenCodeDirectory = process.env.OPENCODE_CONFIG_DIR;
  if (customOpenCodeDirectory) {
    const customSkills = join(customOpenCodeDirectory, 'skills');
    skillSources.push({
      root: customSkills,
      source: source('opencode', 'global', 'opencode', customSkills),
    });
    for (const file of ['opencode.json', 'opencode.jsonc']) {
      const path = join(customOpenCodeDirectory, file);
      mcpSources.push({ path, source: source('opencode', 'global', 'opencode', path), shape: 'opencode' });
    }
  }
  const customOpenCodeConfig = process.env.OPENCODE_CONFIG;
  if (customOpenCodeConfig) {
    mcpSources.push({
      path: customOpenCodeConfig,
      source: source('opencode', 'global', 'opencode', customOpenCodeConfig),
      shape: 'opencode',
    });
  }

  for (const directory of projectDirectories) {
    const projectRoot = directory.gitRootPath ?? directory.realPath;
    for (const [relativePath, executor] of [
      ['.opencode/skills', 'opencode'],
      ['.claude/skills', 'claude'],
      ['.agents/skills', 'opencode'],
    ] as const) {
      const root = join(projectRoot, relativePath);
      skillSources.push({ root, source: source(executor, 'project', executor, root) });
    }
    for (const file of ['opencode.json', 'opencode.jsonc']) {
      const path = join(projectRoot, file);
      mcpSources.push({ path, source: source('opencode', 'project', 'opencode', path), shape: 'opencode' });
    }
    const claudeMcpPath = join(projectRoot, '.mcp.json');
    mcpSources.push({ path: claudeMcpPath, source: source('claude', 'project', 'claude', claudeMcpPath), shape: 'claude' });
  }

  discoverInstalledClaudePlugins(userHome, skillSources, mcpSources, sourceErrors);

  for (const entry of uniqueBy(skillSources, (item) => `${item.source.type}:${item.root}`)) {
    if (!existsSync(entry.root)) continue;
    try {
      for (const path of findSkillEntries(entry.root)) {
        capabilities.push(inspectSkill(path, { ...entry.source, ref: path }));
      }
    } catch (error) {
      sourceErrors.push({ source: entry.root, message: errorMessage(error) });
    }
  }

  for (const entry of uniqueBy(mcpSources, (item) => `${item.shape}:${item.path}`)) {
    if (!existsSync(entry.path)) continue;
    try {
      capabilities.push(...inspectMcpConfig(entry));
    } catch (error) {
      sourceErrors.push({ source: entry.path, message: errorMessage(error) });
    }
  }

  return {
    capabilities: uniqueBy(capabilities, (item) => item.originKey),
    sourceErrors,
  };
}

export function inspectSkillDirectory(path: string): DiscoveredCapability {
  const resolved = resolve(path);
  const entry = lstatSync(resolved).isDirectory() ? join(resolved, 'SKILL.md') : resolved;
  return inspectSkill(entry, source('local_directory', 'managed', null, entry));
}

function discoverInstalledClaudePlugins(
  userHome: string,
  skills: SkillSource[],
  mcps: McpConfigSource[],
  errors: Array<{ source: string; message: string }>,
): void {
  const registryPath = join(userHome, '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(registryPath)) return;
  try {
    const parsed = parseJsonConfig(readFileSync(registryPath, 'utf8')) as { plugins?: Record<string, unknown> };
    const plugins = parsed.plugins ?? parsed;
    for (const [pluginId, rawEntries] of Object.entries(plugins)) {
      const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
      for (const rawEntry of entries) {
        if (!isRecord(rawEntry) || typeof rawEntry.installPath !== 'string') continue;
        const installPath = rawEntry.installPath;
        const pluginVersion = typeof rawEntry.version === 'string' ? rawEntry.version : null;
        const pluginSource = source('claude', 'plugin', 'claude', installPath, pluginVersion);
        skills.push({ root: join(installPath, 'skills'), source: pluginSource });
        const mcpPath = join(installPath, '.mcp.json');
        mcps.push({ path: mcpPath, source: { ...pluginSource, ref: mcpPath }, shape: 'claude' });
        // Some plugins place a single SKILL.md at the package root.
        if (existsSync(join(installPath, 'SKILL.md'))) skills.push({ root: installPath, source: pluginSource });
        void pluginId;
      }
    }
  } catch (error) {
    errors.push({ source: registryPath, message: errorMessage(error) });
  }
}

function inspectSkill(entryPath: string, skillSource: CapabilitySource): DiscoveredCapability {
  const root = dirname(entryPath);
  const emptySecurity = securitySummary();
  try {
    const content = readFileSync(entryPath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const name = stringValue(frontmatter.name) || basename(root);
    const description = stringValue(frontmatter.description);
    const inventory = inventoryDirectory(root);
    const security = analyzeSkillSecurity(root, inventory.files, content);
    const contentHash = hashInventory(root, inventory.files);
    const compatibility = parseSkillCompatibility(frontmatter.compatibility);
    const validationError = validateSkillName(name, basename(root))
      ?? (!description ? 'SKILL.md 缺少 description。' : null);
    return discovered({
      kind: 'skill',
      name,
      description,
      source: { ...skillSource, ref: entryPath },
      version: skillSource.version ?? contentHash.slice(0, 12),
      contentHash,
      compatibility,
      parseStatus: validationError ? 'invalid' : 'valid',
      parseError: validationError,
      commandStatus: 'not_applicable',
      runtimeHealth: 'not_applicable',
      credentialRefs: extractEnvironmentReferences(content),
      manifest: {
        format: 'agent-skill',
        entryFile: 'SKILL.md',
        name,
        description,
        license: stringValue(frontmatter.license) || null,
        compatibility: stringValue(frontmatter.compatibility) || null,
        allowedTools: stringValue(frontmatter['allowed-tools']) || null,
        metadata: isRecord(frontmatter.metadata) ? frontmatter.metadata : {},
        files: inventory.files,
        totalBytes: inventory.totalBytes,
        contentPreview: stripFrontmatter(content).slice(0, 2_000),
      },
      security,
    });
  } catch (error) {
    const contentHash = sha256(`${entryPath}:${errorMessage(error)}`);
    return discovered({
      kind: 'skill',
      name: basename(root) || 'invalid-skill',
      description: '',
      source: { ...skillSource, ref: entryPath },
      version: skillSource.version ?? contentHash.slice(0, 12),
      contentHash,
      compatibility: ['opencode', 'claude'],
      parseStatus: 'invalid',
      parseError: errorMessage(error),
      commandStatus: 'not_applicable',
      runtimeHealth: 'not_applicable',
      credentialRefs: [],
      manifest: { format: 'agent-skill', entryFile: 'SKILL.md', files: [] },
      security: emptySecurity,
    });
  }
}

function inspectMcpConfig(entry: McpConfigSource): DiscoveredCapability[] {
  const parsed = parseJsonConfig(readFileSync(entry.path, 'utf8'));
  const definitions = extractMcpDefinitions(parsed, entry.shape);
  return definitions.map(({ name, config, scopeSuffix }) => inspectMcpDefinition(
    name,
    config,
    { ...entry.source, ref: scopeSuffix ? `${entry.path}#${scopeSuffix}` : entry.path },
    {
      sourcePath: entry.path,
      sourceShape: entry.shape,
      capabilityName: name,
      scopeSuffix,
    },
  ));
}

function inspectMcpDefinition(
  name: string,
  raw: unknown,
  mcpSource: CapabilitySource,
  locator?: Omit<LocalCredentialBinding, 'reference' | 'valuePath'>,
): DiscoveredCapability {
  const config = isRecord(raw) ? raw : {};
  const type = normalizeMcpType(config.type, config.url);
  const normalizedCommand = normalizeCommandWithPaths(config.command, config.args);
  const command = normalizedCommand.values;
  const url = typeof config.url === 'string' ? config.url : null;
  const environmentContainer = isRecord(config.environment) ? 'environment' : isRecord(config.env) ? 'env' : 'environment';
  const environment = isRecord(config.environment) ? config.environment : isRecord(config.env) ? config.env : {};
  const headers = isRecord(config.headers) ? config.headers : {};
  const localSource = Boolean(locator && (mcpSource.type === 'opencode' || mcpSource.type === 'claude'));
  const localCredentialBindings: LocalCredentialBinding[] = [];
  let unsafeLiteralDetected = false;
  const protectLiteral = (value: string, valuePath: Array<string | number>, fallbackReference: string): string => {
    if (extractEnvironmentReferences(value).length > 0) return value;
    if (localSource && locator) {
      const reference = localCredentialReference(locator, valuePath);
      localCredentialBindings.push({ ...locator, reference, valuePath });
      return `{env:${reference}}`;
    }
    unsafeLiteralDetected = true;
    return `{env:${fallbackReference}}`;
  };
  const discoveredCredentialRefs = [...new Set([
    ...Object.values(environment).flatMap((value) => extractEnvironmentReferences(String(value))),
    ...Object.values(headers).flatMap((value) => extractEnvironmentReferences(String(value))),
    ...(url ? extractEnvironmentReferences(url) : []),
  ])];
  const safeEnvironment = Object.fromEntries(Object.entries(environment).map(([key, rawValue]) => {
    const value = String(rawValue);
    return [key, secretNamePattern.test(key) && value.length > 0
      ? protectLiteral(value, [environmentContainer, key], `YANXU_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`)
      : value];
  }));
  const safeHeaders = Object.fromEntries(Object.entries(headers).map(([key, rawValue]) => {
    const value = String(rawValue);
    return [key, secretNamePattern.test(key) && value.length > 0
      ? protectLiteral(value, ['headers', key], `YANXU_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`)
      : value];
  }));
  const safeCommand = command.map((value, index) => index > 0 && secretNamePattern.test(command[index - 1] ?? '')
    ? protectLiteral(value, normalizedCommand.paths[index] ?? ['command', index], 'YANXU_MCP_SECRET')
    : value);
  const literalUrlCredential = hasLiteralUrlCredential(url);
  const safeUrl = literalUrlCredential && url
    ? protectLiteral(url, ['url'], 'YANXU_MCP_URL')
    : sanitizeUrl(url);
  const containsLiteralSecrets = unsafeLiteralDetected;
  const parseError = type === 'local' && safeCommand.length === 0
    ? '本地 MCP 缺少 command。'
    : type === 'remote' && !safeUrl
      ? '远程 MCP 缺少有效 URL。'
      : type === null ? 'MCP type 不受支持。' : null;
  const commandStatus = type === 'local' && safeCommand[0]
    ? (resolveExecutable(safeCommand[0]) ? 'available' : 'missing')
    : type === 'remote' ? 'not_applicable' : 'unchecked';
  const configuration = {
    type,
    ...(type === 'local' ? { command: safeCommand } : {}),
    ...(type === 'remote' && safeUrl ? { url: safeUrl } : {}),
    ...(Object.keys(safeEnvironment).length ? { environment: safeEnvironment } : {}),
    ...(Object.keys(safeHeaders).length ? { headers: safeHeaders } : {}),
    disabled: config.disabled === true || config.enabled === false,
  };
  const credentialRefs = [...new Set([
    ...discoveredCredentialRefs,
    ...localCredentialBindings.map((binding) => binding.reference),
    ...extractEnvironmentReferences(JSON.stringify(configuration)),
  ])];
  const contentHash = sha256(JSON.stringify({ name, configuration, sourceVersion: mcpSource.version }));
  const networkHosts = url ? hostnameOf(url) : [];
  return discovered({
    kind: 'mcp',
    name,
    description: `MCP ${type === 'local' ? '本地服务' : type === 'remote' ? '远程服务' : '服务'} ${name}`,
    source: mcpSource,
    version: mcpSource.version ?? contentHash.slice(0, 12),
    contentHash,
    compatibility: parseError ? [] : ['opencode', 'claude'],
    parseStatus: parseError ? 'invalid' : 'valid',
    parseError,
    commandStatus,
    runtimeHealth: parseError ? 'unhealthy' : 'unchecked',
    credentialRefs,
    manifest: { format: 'mcp', configuration, localCredentialBindings },
    security: {
      files: [mcpSource.ref.split('#')[0] ?? mcpSource.ref],
      scripts: [],
      executableFiles: [],
      networkHosts,
      environmentKeys: Object.keys(environment),
      headerKeys: Object.keys(headers),
      localCredentialBindings: localCredentialBindings.length,
      containsLiteralSecrets,
    },
  });
}

export function resolveLocalCredentialEnvironment(rawBindings: unknown): LocalCredentialResolution {
  const bindings = parseLocalCredentialBindings(rawBindings);
  const environment: Record<string, string> = {};
  const missing: LocalCredentialResolution['missing'] = [];
  const documents = new Map<string, unknown>();
  for (const binding of bindings) {
    try {
      let parsed = documents.get(binding.sourcePath);
      if (parsed === undefined) {
        parsed = parseJsonConfig(readFileSync(binding.sourcePath, 'utf8'));
        documents.set(binding.sourcePath, parsed);
      }
      const definition = extractMcpDefinitions(parsed, binding.sourceShape)
        .find((item) => item.name === binding.capabilityName && item.scopeSuffix === binding.scopeSuffix);
      if (!definition) {
        missing.push({ reference: binding.reference, reason: '来源配置中已找不到对应 MCP 定义' });
        continue;
      }
      const rawValue = valueAtPath(definition.config, binding.valuePath);
      if (rawValue === undefined || rawValue === null || String(rawValue).length === 0) {
        missing.push({ reference: binding.reference, reason: '来源配置中的凭据值为空或已移除' });
        continue;
      }
      const expanded = expandEnvironmentReferences(String(rawValue));
      if (expanded.missing.length > 0) {
        missing.push({ reference: binding.reference, reason: `来源引用的环境变量不可用：${expanded.missing.join('、')}` });
        continue;
      }
      environment[binding.reference] = expanded.value;
    } catch {
      missing.push({ reference: binding.reference, reason: '本机来源配置无法读取或解析' });
    }
  }
  return { environment, missing };
}

function discovered(input: Omit<DiscoveredCapability, 'originKey'>): DiscoveredCapability {
  return {
    ...input,
    originKey: sha256(JSON.stringify({
      kind: input.kind,
      sourceType: input.source.type,
      sourceScope: input.source.scope,
      sourceExecutor: input.source.executor,
      sourceRef: input.source.ref,
      name: input.name,
    })),
  };
}

function extractMcpDefinitions(
  parsed: unknown,
  shape: McpConfigSource['shape'],
): Array<{ name: string; config: unknown; scopeSuffix: string | null }> {
  if (!isRecord(parsed)) return [];
  if (shape === 'claude_state') {
    const result: Array<{ name: string; config: unknown; scopeSuffix: string | null }> = [];
    for (const [name, config] of Object.entries(recordValue(parsed.mcpServers))) {
      result.push({ name, config, scopeSuffix: `user:${name}` });
    }
    for (const [projectPath, projectValue] of Object.entries(recordValue(parsed.projects))) {
      const project = recordValue(projectValue);
      for (const [name, config] of Object.entries(recordValue(project.mcpServers))) {
        result.push({ name, config, scopeSuffix: `local:${sha256(projectPath).slice(0, 12)}:${name}` });
      }
    }
    return result;
  }
  const container = shape === 'opencode'
    ? recordValue(recordValue(parsed.mcp).servers ?? parsed.mcp)
    : recordValue(parsed.mcpServers);
  return Object.entries(container)
    .filter(([name]) => name !== 'servers')
    .map(([name, config]) => ({ name, config, scopeSuffix: name }));
}

function findSkillEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 8 || entries.length >= maximumFiles) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') && depth > 0) continue;
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isFile() && item.name === 'SKILL.md') entries.push(path);
      else if (item.isDirectory()) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return entries;
}

function inventoryDirectory(root: string): { files: string[]; totalBytes: number } {
  const files: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 12) throw new Error('能力目录层级超过 12 层。');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maximumFiles) throw new Error(`能力文件数量超过 ${maximumFiles} 个。`);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (/(^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx)|id_rsa|credentials\.json)$/i.test(relativePath)) {
        throw new Error(`能力目录包含敏感文件：${relativePath}`);
      }
      const stats = lstatSync(path);
      if (stats.size > maximumFileBytes) throw new Error(`能力文件超过 2MB：${relative(root, path)}`);
      totalBytes += stats.size;
      if (totalBytes > maximumTotalBytes) throw new Error('能力目录总大小超过 20MB。');
      files.push(relativePath);
    }
  };
  visit(root, 0);
  files.sort();
  return { files, totalBytes };
}

function hashInventory(root: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

function analyzeSkillSecurity(root: string, files: string[], skillContent: string): CapabilitySecuritySummary {
  const scripts = files.filter((file) => file.split('/').includes('scripts') || scriptExtensions.has(extname(file).toLowerCase()));
  const executableFiles = files.filter((file) => (lstatSync(join(root, file)).mode & 0o111) !== 0);
  const searchable = files.filter((file) => ['.md', '.txt', '.json', '.jsonc', '.yaml', '.yml'].includes(extname(file).toLowerCase()))
    .slice(0, 100)
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('\n');
  const allText = `${skillContent}\n${searchable}`;
  return {
    files,
    scripts,
    executableFiles,
    networkHosts: hostnameOf(allText),
    environmentKeys: extractEnvironmentReferences(allText),
    headerKeys: [],
    localCredentialBindings: 0,
    containsLiteralSecrets: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'][^{$][^"']{7,}["']/i.test(allText),
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (end < 0) throw new Error('SKILL.md frontmatter 没有结束标记。');
  const result: Record<string, unknown> = {};
  let activeObject: Record<string, unknown> | null = null;
  for (const rawLine of lines.slice(1, end + 1)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const nested = /^\s+([^:#]+):\s*(.*)$/.exec(rawLine);
    if (nested && activeObject) {
      activeObject[nested[1]!.trim()] = parseScalar(nested[2] ?? '');
      continue;
    }
    const match = /^([^:#]+):\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2] ?? '';
    if (!value.trim()) {
      activeObject = {};
      result[key] = activeObject;
    } else {
      activeObject = null;
      result[key] = parseScalar(value);
    }
  }
  return result;
}

function parseScalar(value: string): string | boolean | number | null {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const match = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(content.replaceAll('\r\n', '\n'));
  return match ? content.slice(match[0].length) : content;
}

function validateSkillName(name: string, directoryName: string): string | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return 'Skill name 必须使用小写字母、数字和单连字符。';
  if (name.length > 64) return 'Skill name 不能超过 64 个字符。';
  if (directoryName !== name) return `Skill name“${name}”与目录“${directoryName}”不一致。`;
  return null;
}

function parseSkillCompatibility(value: unknown): ExecutorType[] {
  const text = stringValue(value).toLowerCase();
  if (!text) return ['opencode', 'claude'];
  const result: ExecutorType[] = [];
  if (text.includes('opencode')) result.push('opencode');
  if (text.includes('claude')) result.push('claude');
  return result.length ? result : ['opencode', 'claude'];
}

function parseJsonConfig(content: string): unknown {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(content));
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    const next = input[index + 1];
    if (lineComment) {
      if (character === '\n') { lineComment = false; result += character; }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; result += character; continue; }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    result += character;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

function normalizeMcpType(value: unknown, url: unknown): 'local' | 'remote' | null {
  if (value === 'local' || value === 'stdio') return 'local';
  if (value === 'remote' || value === 'http' || value === 'streamable-http' || value === 'sse') return 'remote';
  if (typeof url === 'string') return 'remote';
  return null;
}

function normalizeCommandWithPaths(
  command: unknown,
  args: unknown,
): { values: string[]; paths: Array<Array<string | number>> } {
  const commandParts = Array.isArray(command)
    ? command.filter((item): item is string => typeof item === 'string')
    : typeof command === 'string' ? [command] : [];
  const argumentParts = Array.isArray(args) ? args.filter((item): item is string => typeof item === 'string') : [];
  const commandPaths = commandParts.map((_, index): Array<string | number> =>
    Array.isArray(command) ? ['command', index] : ['command']);
  const argumentPaths = argumentParts.map((_, index): Array<string | number> => ['args', index]);
  return { values: [...commandParts, ...argumentParts], paths: [...commandPaths, ...argumentPaths] };
}

function sanitizeUrl(value: string | null): string | null {
  if (!value) return null;
  if (extractEnvironmentReferences(value).length > 0) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (secretNamePattern.test(key)) parsed.searchParams.set(key, `{env:YANXU_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}}`);
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function hasLiteralUrlCredential(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (username && extractEnvironmentReferences(username).length === 0) return true;
    if (password && extractEnvironmentReferences(password).length === 0) return true;
    return [...parsed.searchParams.entries()].some(([key, content]) =>
      secretNamePattern.test(key) && extractEnvironmentReferences(content).length === 0 && content.length > 0);
  } catch {
    return false;
  }
}

function localCredentialReference(
  locator: Omit<LocalCredentialBinding, 'reference' | 'valuePath'>,
  valuePath: Array<string | number>,
): string {
  return `YANXU_LOCAL_CREDENTIAL_${sha256(JSON.stringify({ ...locator, valuePath })).slice(0, 20).toUpperCase()}`;
}

function parseLocalCredentialBindings(value: unknown): LocalCredentialBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): LocalCredentialBinding[] => {
    if (!isRecord(item)
      || typeof item.reference !== 'string'
      || typeof item.sourcePath !== 'string'
      || !['opencode', 'claude', 'claude_state'].includes(String(item.sourceShape))
      || typeof item.capabilityName !== 'string'
      || !(item.scopeSuffix === null || typeof item.scopeSuffix === 'string')
      || !Array.isArray(item.valuePath)
      || !item.valuePath.every((part) => typeof part === 'string' || Number.isInteger(part))) return [];
    return [{
      reference: item.reference,
      sourcePath: item.sourcePath,
      sourceShape: item.sourceShape as LocalCredentialBinding['sourceShape'],
      capabilityName: item.capabilityName,
      scopeSuffix: item.scopeSuffix,
      valuePath: item.valuePath as Array<string | number>,
    }];
  });
}

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function expandEnvironmentReferences(value: string): { value: string; missing: string[] } {
  const missing = new Set<string>();
  environmentReferencePattern.lastIndex = 0;
  const expanded = value.replace(environmentReferencePattern, (_match, openCodeName, claudeName, shellName) => {
    const name = String(openCodeName ?? claudeName ?? shellName ?? '');
    const resolved = process.env[name];
    if (resolved === undefined) {
      missing.add(name);
      return '';
    }
    return resolved;
  });
  return { value: expanded, missing: [...missing] };
}

function extractEnvironmentReferences(value: string): string[] {
  const result: string[] = [];
  environmentReferencePattern.lastIndex = 0;
  for (const match of value.matchAll(environmentReferencePattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) result.push(name);
  }
  return [...new Set(result)];
}

function resolveExecutable(command: string): string | null {
  if (command.includes('/')) return existsSync(resolve(command)) ? resolve(command) : null;
  for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hostnameOf(value: string): string[] {
  const result: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s)\]}>"']+/g)) {
    try { result.push(new URL(match[0]).hostname); } catch { /* Ignore malformed URLs in prose. */ }
  }
  return [...new Set(result)];
}

function securitySummary(): CapabilitySecuritySummary {
  return {
    files: [], scripts: [], executableFiles: [], networkHosts: [], environmentKeys: [], headerKeys: [],
    localCredentialBindings: 0, containsLiteralSecrets: false,
  };
}

function source(
  type: CapabilitySource['type'],
  scope: CapabilitySource['scope'],
  executor: ExecutorType | null,
  ref: string,
  version: string | null = null,
): CapabilitySource {
  return { type, scope, executor, ref, version };
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
