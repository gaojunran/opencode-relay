import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- 类型定义 ----------

export type LogLevel = "debug" | "info" | "warn" | "error";
export type EndOfSessionStrategy = "keep" | "push" | "cleanup";

export interface ProjectItem {
  id: string;
  name: string;
  repo_path: string;
  description?: string;
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface RelayConfig {
  general: { enabled: boolean; home: string; log_level: LogLevel };
  paths: { workspace_root: string; worktree_root: string; state_dir: string };
  projects: { items: ProjectItem[]; scan_dir?: string };
  worktree: { branch_prefix: string; end_of_session: EndOfSessionStrategy; remote: string; stale_days: number };
  inject: { enabled: boolean; template: string };
  guard: { enabled: boolean; reject_on_violation: boolean; deny_paths: string[]; allow_paths: string[] };
  permissions: { enabled: boolean; rules: PermissionRule[] };
  list: { include_description: boolean };
}

export interface RelayLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ---------- 日志 ----------

const LOG_THRESHOLD: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(level: string): RelayLogger {
  const threshold = LOG_THRESHOLD[level as LogLevel] ?? 1;
  const emit = (min: number, method: "log" | "warn" | "error", msg: string) => {
    if (threshold <= min) console[method](`[opencode-relay] ${msg}`);
  };
  return {
    debug: (m) => emit(0, "log", m),
    info: (m) => emit(1, "log", m),
    warn: (m) => emit(2, "warn", m),
    error: (m) => emit(3, "error", m),
  };
}

// ---------- 轻量 TOML 解析 ----------

type TomlTable = Record<string, unknown>;

/** 去除行内 # 注释（字符串内的 # 保留） */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"' || ch === "'") inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 按顶层逗号切分（忽略字符串、数组、行内表内部的逗号） */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += input[i + 1] ?? "";
        i++;
      } else if (ch === '"' || ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 解析行内值：字符串 / 数字 / 布尔 / 数组 / 行内表 */
function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0];
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const ch = v[i];
      if (ch === "\\" && i + 1 < v.length) {
        const next = v[i + 1];
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i++;
      } else if (ch === quote) {
        break;
      } else {
        out += ch;
      }
    }
    return out;
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]"));
    return splitTopLevel(inner).map((part) => parseValue(part));
  }
  if (v.startsWith("{")) {
    const inner = v.slice(1, v.lastIndexOf("}"));
    const table: TomlTable = {};
    for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      table[pair.slice(0, eq).trim()] = parseValue(pair.slice(eq + 1));
    }
    return table;
  }
  const num = Number(v);
  return Number.isNaN(num) ? v : num;
}

function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let section: TomlTable = root;
  let item: TomlTable | null = null;

  const ensureTable = (keys: string[]): TomlTable => {
    let cur: TomlTable = root;
    for (const key of keys) {
      const next = cur[key];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        cur[key] = {};
      }
      cur = cur[key] as TomlTable;
    }
    return cur;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[")) {
      const name = line.slice(2, line.indexOf("]]")).trim();
      const keys = name.split(".");
      const parent = ensureTable(keys.slice(0, -1));
      const last = keys[keys.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      const entry: TomlTable = {};
      (parent[last] as TomlTable[]).push(entry);
      item = entry;
      section = entry;
      continue;
    }
    if (line.startsWith("[")) {
      const name = line.slice(1, line.lastIndexOf("]")).trim();
      section = ensureTable(name.split("."));
      item = null;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1));
    if (item) item[key] = value;
    else section[key] = value;
  }
  return root;
}

// ---------- 配置映射 ----------

const DEFAULT_TEMPLATE =
  "当前项目: {project_name}（{project_id}），工作目录: {workdir}，分支: {branch}。bash 工具请用 workdir 参数，文件操作用绝对路径，不要直接修改主副本。";

const VALID_END_OF_SESSION: readonly string[] = ["keep", "push", "cleanup"];

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asTable(v: unknown): TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as TomlTable) : {};
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildConfig(raw: TomlTable): RelayConfig {
  const home = os.homedir();
  const general = asTable(raw.general);
  const paths = asTable(raw.paths);
  const projects = asTable(raw.projects);
  const worktree = asTable(raw.worktree);
  const inject = asTable(raw.inject);
  const guard = asTable(raw.guard);
  const permissions = asTable(raw.permissions);
  const list = asTable(raw.list);

  const items: ProjectItem[] = [];
  for (const t of asArray(projects.items).map((v) => asTable(v))) {
    const id = asString(t.id, "");
    if (!id) continue;
    const repoPath = asString(t.repo_path, "");
    if (!repoPath) {
      console.warn(`[opencode-relay] 项目 "${id}" 缺少 repo_path，已从注册表忽略`);
      continue;
    }
    items.push({
      id,
      name: asString(t.name, id),
      repo_path: repoPath,
      description: typeof t.description === "string" ? t.description : undefined,
    });
  }

  const endOfSession = asString(worktree.end_of_session, "keep");
  const rules: PermissionRule[] = [];
  for (const t of asArray(permissions.rules).map((v) => asTable(v))) {
    const effect = t.effect;
    if (
      typeof t.action === "string" &&
      typeof t.resource === "string" &&
      (effect === "allow" || effect === "deny" || effect === "ask")
    ) {
      rules.push({ action: t.action, resource: t.resource, effect });
    }
  }

  return {
    general: {
      enabled: asBoolean(general.enabled, true),
      home: expandHome(asString(general.home, home)),
      log_level: asString(general.log_level, "info") as LogLevel,
    },
    paths: {
      workspace_root: expandHome(asString(paths.workspace_root, path.join(home, "workspace"))),
      worktree_root: expandHome(asString(paths.worktree_root, path.join(home, ".opencode", "worktrees"))),
      state_dir: expandHome(asString(paths.state_dir, path.join(home, ".opencode", "state"))),
    },
    projects: {
      items,
      scan_dir: typeof projects.scan_dir === "string" ? expandHome(projects.scan_dir) : undefined,
    },
    worktree: {
      branch_prefix: asString(worktree.branch_prefix, "opencode/"),
      end_of_session: (VALID_END_OF_SESSION.includes(endOfSession)
        ? endOfSession
        : "keep") as EndOfSessionStrategy,
      remote: asString(worktree.remote, "origin"),
      stale_days: typeof worktree.stale_days === "number" ? worktree.stale_days : 7,
    },
    inject: {
      enabled: asBoolean(inject.enabled, true),
      template: asString(inject.template, DEFAULT_TEMPLATE),
    },
    guard: {
      enabled: asBoolean(guard.enabled, true),
      reject_on_violation: asBoolean(guard.reject_on_violation, true),
      deny_paths: asArray(guard.deny_paths).filter((v): v is string => typeof v === "string"),
      allow_paths: asArray(guard.allow_paths).filter((v): v is string => typeof v === "string"),
    },
    permissions: { enabled: asBoolean(permissions.enabled, false), rules },
    list: { include_description: asBoolean(list.include_description, true) },
  };
}

// ---------- 加载（启动时读一次，模块级缓存） ----------

let cachedConfig: RelayConfig | null = null;

function configPath(): string {
  return (
    process.env.OPENCODE_RELAY_CONFIG ??
    path.join(os.homedir(), ".config", "opencode-relay", "config.toml")
  );
}

function readConfigFromDisk(): RelayConfig {
  const file = configPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.warn(
      `[opencode-relay] ${code === "ENOENT" ? "配置文件不存在" : "读取配置失败"}，使用默认配置: ${file} (${String(err)})`,
    );
    return buildConfig({});
  }
  try {
    return buildConfig(parseToml(text));
  } catch (err) {
    console.warn(`[opencode-relay] 解析配置失败，使用默认配置: ${file} (${String(err)})`);
    return buildConfig({});
  }
}

export function loadConfig(): RelayConfig {
  if (!cachedConfig) cachedConfig = readConfigFromDisk();
  return cachedConfig;
}

/** 测试辅助：清空模块级缓存，让下一次 loadConfig() 重读磁盘 */
export function resetConfig(): void {
  cachedConfig = null;
}

// ---------- 项目注册表 ----------

/** 显式 items 优先；为空时按 scan_dir 扫描含 .git 的子目录 */
export function getProjectRegistry(config: RelayConfig): ProjectItem[] {
  if (config.projects.items.length > 0) return config.projects.items;
  const scanDir = config.projects.scan_dir;
  if (!scanDir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[opencode-relay] 扫描项目目录失败: ${scanDir} (${String(err)})`);
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(scanDir, e.name, ".git")))
    .map((e) => ({ id: e.name, name: e.name, repo_path: path.join(scanDir, e.name) }));
}

export function findProject(config: RelayConfig, projectId: string): ProjectItem | undefined {
  return getProjectRegistry(config).find((p) => p.id === projectId);
}
