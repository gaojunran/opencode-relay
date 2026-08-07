import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- Type definitions ----------

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
  general: { enabled: boolean; home: string; log_level: LogLevel; log_file: string };
  paths: { workspace_root: string; worktree_root: string; state_dir: string };
  projects: { items: ProjectItem[]; scan_dir?: string };
  worktree: { branch_prefix: string; end_of_session: EndOfSessionStrategy; remote: string; stale_days: number; on_switch: string };
  inject: { enabled: boolean; template: string; list_projects: boolean; agents_md: boolean; skills: boolean };
  guard: { enabled: boolean; reject_on_violation: boolean; deny_paths: string[]; allow_paths: string[]; allow_dirs: string[] };
  permissions: { enabled: boolean; rules: PermissionRule[] };
  list: { include_description: boolean };
}

export interface RelayLogger {
  debug(source: string, msg: string): void;
  info(source: string, msg: string): void;
  warn(source: string, msg: string): void;
  error(source: string, msg: string): void;
}

// ---------- Logging ----------

const LOG_THRESHOLD: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Escape a value for the logfmt format: values containing whitespace, quotes or '=' are
 *  double-quoted with backslash escapes (matches the logfmt spec). */
function logfmtValue(v: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Daily-rotated log file writer. Append-only, never throws (a failed log write must not
 *  break the plugin). Returns null when file logging is disabled (empty dir). */
function makeLogWriter(logDir: string): ((line: string) => void) | null {
  if (!logDir) return null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    return null;
  }
  return (line: string) => {
    const day = new Date().toISOString().slice(0, 10);
    try {
      fs.appendFileSync(path.join(logDir, `relay-${day}.log`), `${line}\n`, "utf8");
    } catch {
      // drop the write; logging must never affect plugin behavior
    }
  };
}

export function createLogger(level: string, logDir = ""): RelayLogger {
  const threshold = LOG_THRESHOLD[level as LogLevel] ?? 1;
  const writeFile = makeLogWriter(logDir);
  const emit = (min: number, name: LogLevel, method: "log" | "warn" | "error", source: string, msg: string) => {
    if (threshold <= min) {
      const line = `ts=${logfmtValue(new Date().toISOString())} level=${name} logger=${logfmtValue(source)} msg=${logfmtValue(msg)}`;
      console[method](line);
      writeFile?.(line);
    }
  };
  return {
    debug: (s, m) => emit(0, "debug", "log", s, m),
    info: (s, m) => emit(1, "info", "log", s, m),
    warn: (s, m) => emit(2, "warn", "warn", s, m),
    error: (s, m) => emit(3, "error", "error", s, m),
  };
}

// ---------- Lightweight TOML parser ----------

type TomlTable = Record<string, unknown>;

/** Strip inline # comments (a # inside a string is preserved) */
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

/** Split on top-level commas (ignores commas inside strings, arrays, and inline tables) */
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

/** Parse an inline value: string / number / boolean / array / inline table */
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

// ---------- Config mapping ----------

const DEFAULT_TEMPLATE =
  "Current project: {project_name} ({project_id}), workdir: {workdir}, branch: {branch}. File tool relative paths resolve against the workdir; bash without an explicit workdir runs in the workdir. Never modify the main copy.";

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

  // The main copy lives under workspace_root; it is a clean baseline that the agent must never
  // touch directly (worktrees are the only legal working copies). Denying it must hold in every
  // session state, so it is baked into the default deny set below (users may still allow_paths it).
  const workspaceRoot = expandHome(asString(paths.workspace_root, path.join(home, "workspace")));
  const defaultDeny = [`${workspaceRoot}/**`];

  const items: ProjectItem[] = [];
  for (const t of asArray(projects.items).map((v) => asTable(v))) {
    const id = asString(t.id, "");    if (!id) continue;
    const repoPath = asString(t.repo_path, "");
    if (!repoPath) {
      console.warn(`[opencode-relay] project "${id}" is missing repo_path, ignored from registry`);
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
      log_file: expandHome(asString(general.log_file, "")),
    },
    paths: {
      workspace_root: workspaceRoot,
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
      on_switch: typeof worktree.on_switch === "string" ? worktree.on_switch : "",
    },
    inject: {
      enabled: asBoolean(inject.enabled, true),
      template: asString(inject.template, DEFAULT_TEMPLATE),
      list_projects: asBoolean(inject.list_projects, true),
      agents_md: asBoolean(inject.agents_md, true),
      skills: asBoolean(inject.skills, true),
    },
    guard: {
      enabled: asBoolean(guard.enabled, true),
      reject_on_violation: asBoolean(guard.reject_on_violation, true),
      // The main copy is denied by default in every session state (the core promise of the
      // plugin); user patterns are appended. allow_paths take precedence via matchesDeny.
      deny_paths: [
        ...defaultDeny,
        ...asArray(guard.deny_paths).filter((v): v is string => typeof v === "string"),
      ],
      allow_paths: asArray(guard.allow_paths).filter((v): v is string => typeof v === "string"),
      // Directories where the guard does not enforce the worktree boundary (e.g. temp dirs).
      // Defaults to ["/tmp"] when the key is absent; an explicit empty array disables this.
      allow_dirs:
        guard.allow_dirs === undefined
          ? ["/tmp"]
          : asArray(guard.allow_dirs)
              .filter((v): v is string => typeof v === "string")
              .map(expandHome),
    },
    permissions: { enabled: asBoolean(permissions.enabled, false), rules },
    list: { include_description: asBoolean(list.include_description, true) },
  };
}

// ---------- Loading (read once at startup, module-level cache) ----------

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
      `[opencode-relay] ${code === "ENOENT" ? "config file not found" : "failed to read config"}, using defaults: ${file} (${String(err)})`,
    );
    return buildConfig({});
  }
  try {
    return buildConfig(parseToml(text));
  } catch (err) {
    console.warn(`[opencode-relay] failed to parse config, using defaults: ${file} (${String(err)})`);
    return buildConfig({});
  }
}

export function loadConfig(): RelayConfig {
  if (!cachedConfig) cachedConfig = readConfigFromDisk();
  return cachedConfig;
}

/** Test helper: clear the module-level cache so the next loadConfig() re-reads disk */
export function resetConfig(): void {
  cachedConfig = null;
}

// ---------- Project registry ----------

const DYNAMIC_PROJECTS_FILE = "projects.json";

/** Read dynamically registered projects from state_dir/projects.json; returns [] when the file is missing or malformed */
export function readDynamicProjects(config: RelayConfig): ProjectItem[] {
  const file = path.join(config.paths.state_dir, DYNAMIC_PROJECTS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      .filter((v) => typeof v.id === "string" && typeof v.repo_path === "string")
      .map((v) => ({
        id: v.id as string,
        name: typeof v.name === "string" ? (v.name as string) : (v.id as string),
        repo_path: v.repo_path as string,
        description: typeof v.description === "string" ? (v.description as string) : undefined,
      }));
  } catch {
    return [];
  }
}

/** Persist the dynamic project registry to state_dir/projects.json */
export function writeDynamicProjects(config: RelayConfig, items: ProjectItem[]): void {
  const file = path.join(config.paths.state_dir, DYNAMIC_PROJECTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

/** Explicit items and dynamic registrations merged, deduped by id (explicit wins); scan scan_dir only when both are empty */
export function getProjectRegistry(config: RelayConfig): ProjectItem[] {
  const merged = new Map<string, ProjectItem>();
  for (const p of [...config.projects.items, ...readDynamicProjects(config)]) {
    if (!merged.has(p.id)) merged.set(p.id, p);
  }
  if (merged.size > 0) return [...merged.values()];
  const scanDir = config.projects.scan_dir;
  if (!scanDir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[opencode-relay] failed to scan project dir: ${scanDir} (${String(err)})`);
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
