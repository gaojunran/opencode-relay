import type { Hooks, PluginInput, PluginModule, ToolResult } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createLogger,
  findProject,
  getProjectRegistry,
  loadConfig,
  readDynamicProjects,
  writeDynamicProjects,
  type ProjectItem,
  type RelayConfig,
  type RelayLogger,
} from "./config.js";
import {
  readSessionState,
  removeSessionState,
  sanitizeSessionID,
  worktreeSessionID,
  writeSessionState,
  type SessionState,
} from "./state.js";
import { createWorktree, currentBranch, execGit, findWorktree, findWorktreeDirs, removeWorktree } from "./git.js";

const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "apply_patch"]);

// Fixed guidance injected into the system prompt on every turn (stateful or not)
const PROJECT_GUIDE =
  "When you want to explore, analyze, or develop a project, always use switch_project. If the existing projects do not include the one you want to enter, register it first with register_project.";

export default {
  id: "opencode-relay",
  server: async (input: PluginInput) => {
    const config = loadConfig();
    const log = createLogger(config.general.log_level, config.general.log_file);
    if (!config.general.enabled) {
      log.info("plugin", "Plugin disabled (general.enabled = false)");
      return {};
    }
    const sessionDir = path.resolve(input.directory);
    const home = path.resolve(config.general.home);
    if (!isInside(sessionDir, home)) {
      log.info("opt-out", `Session directory outside home, skipping plugin load: sessionDir=${sessionDir}, home=${home}`);
      return {};
    }
    log.info("plugin", `Plugin started, session directory: ${sessionDir} (home: ${home})`);
    log.debug("config", 
      `log_level=${config.general.log_level} enabled=${config.general.enabled} home=${config.general.home} workspace_root=${config.paths.workspace_root} worktree_root=${config.paths.worktree_root} state_dir=${config.paths.state_dir} projects=${getProjectRegistry(config).length}`,
    );
    return buildHooks({ config, log, instanceDir: input.directory });
  },
} satisfies PluginModule;

function buildHooks(opts: {
  config: RelayConfig;
  log: RelayLogger;
  instanceDir: string;
}): Hooks {
  const { config, log, instanceDir } = opts;

  // Subagent sessions are separate sessions with their own sessionID, linked to the parent
  // via the DB parent_id column. parentID is only observable through the event hook (exp-6:
  // tool.execute.before / system.transform inputs carry only the subagent's own sessionID).
  // We map child -> root parent so subagent tool calls inherit the parent's project state
  // (same worktree, no orphan worktrees, guard consistent, dispose handles the parent once).
  const parentMap = new Map<string, string>();

  const resolveSessionID = (sessionID: string): string => {
    let current = sessionID;
    const seen = new Set<string>();
    while (parentMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentMap.get(current)!;
    }
    return current;
  };

  // dispose receives no arguments (opencode plugin/index.ts:266 calls hook.dispose?.() directly),
  // so a module-level variable records the session of the most recent tool call for dispose.
  let activeSessionID: string | undefined;

  return {
    tool: {
      list_project: tool({
        description: "List the available projects. Call this before switching projects.",
        args: {},
        execute: async (): Promise<ToolResult> => {
          const projects = getProjectRegistry(config);
          const withDescription = config.list.include_description;
          const result = projects.map((p) => {
            const entry: { id: string; name: string; description?: string } = {
              id: p.id,
              name: p.name,
            };
            if (withDescription && p.description) entry.description = p.description;
            return entry;
          });
          log.debug("list_project", `returning ${result.length} projects`);
          return JSON.stringify(result, null, 2);
        },
      }),

      switch_project: tool({
        description: "Switch the current session to the given project and return its working directory.",
        args: {
          project_id: tool.schema.string().describe("Project ID (from list_project)"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = resolveSessionID(context.sessionID);
          return switchProject(config, log, activeSessionID, args.project_id);
        },
      }),

      register_project: tool({
        description:
          "Register a new project from a git repository at the given path, then switch to it. Use this when the existing projects do not include the one you want to enter.",
        args: {
          dir: tool.schema.string().describe("Path to the git repository to register"),
          id: tool.schema.string().optional().describe("Project ID (defaults to the directory basename)"),
          name: tool.schema.string().optional().describe("Project name (defaults to the ID)"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return registerProject(config, log, args);
        },
      }),

      cleanup_worktrees: tool({
        description: "Clean up stale project workspaces that have been inactive for more than stale_days.",
        args: {
          dry_run: tool.schema.boolean().optional().describe("When true, only list items to reclaim, do not delete"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return cleanupStaleWorktrees(config, log, args.dry_run === true);
        },
      }),

      leave_project: tool({
        description: "Leave the current project and return to the free state. Your changes are preserved.",
        args: {},
        execute: async (_args, context): Promise<ToolResult> => {
          const sessionID = resolveSessionID(context.sessionID);
          activeSessionID = sessionID;
          const state = readSessionState(config, sessionID);
          if (!state) {
            log.info("leave_project", `session ${sessionID} has no project switched, nothing to leave`);
            return {
              title: "Not in a project",
              output: "This session has no project switched, no leave_project needed.",
            };
          }
          const removed = removeSessionState(config, sessionID);
          log.info("leave_project", 
            `session ${sessionID} left project ${state.project_id}, state removed: ${removed} (worktree kept: ${state.workdir}, branch=${liveBranch(state, log)})`,
          );
          return {
            title: "Left project",
            output: JSON.stringify(
              {
                left_project: state.project_id,
                workdir_preserved: state.workdir,
                branch_preserved: liveBranch(state, log),
                note: "worktree and branch preserved, no changes lost; use cleanup_worktrees to reclaim",
              },
              null,
              2,
            ),
          };
        },
      }),
    },

    // Track subagent sessions: task-created subagents are separate sessions linked to the
    // parent via the DB parent_id. The session.created event is the only hook that exposes
    // parentID (exp-6: tool.execute.before / system.transform inputs carry only the subagent's
    // own sessionID), so we maintain a child -> parent map here for resolveSessionID.
    event: async ({ event }) => {
      if (event.type !== "session.created") return;
      const props = event.properties as { info?: { id?: string; parentID?: string } };
      const info = props?.info;
      if (!info?.id || !info?.parentID) return;
      parentMap.set(info.id, info.parentID);
      log.debug("event", `subagent session ${info.id} -> parent ${info.parentID}`);
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      const sessionID = hookInput.sessionID ? resolveSessionID(hookInput.sessionID) : undefined;
      if (!sessionID || !config.inject.enabled) return;
      const state = readSessionState(config, sessionID);
      if (!state) {
        output.system.push(PROJECT_GUIDE);
        if (config.inject.list_projects) {
          const projects = getProjectRegistry(config);
          if (projects.length > 0) {
            const lines = projects.map((p) => {
              const desc = p.description ? ` (${p.description})` : "";
              return `- ${p.id}: ${p.name}${desc}`;
            });
            output.system.push(
              `Available projects (call switch_project({project_id}) to switch to the target project, see ids below):\n${lines.join("\n")}`,
            );
            log.debug("system.transform", `session ${sessionID} has no state, injected project list (${projects.length} projects)`);
          }
        } else {
          log.debug("system.transform", `session ${sessionID} has no state, skipped injection`);
        }
        log.debug("system.transform", `session ${sessionID} has no state, injected project guide`);
        return;
      }
      const text = renderTemplate(config.inject.template, state, log);
      output.system.push(text);
      output.system.push(PROJECT_GUIDE);
      if (config.inject.agents_md) {
        const instructions = readProjectInstructions(state.workdir);
        if (instructions) {
          output.system.push(
            `Project instructions (from the current worktree, ${path.basename(findAgentsMd(state.workdir) ?? "")}):\n${instructions}`,
          );
          log.debug("system.transform", `session ${sessionID} injected worktree instructions (${instructions.length} chars)`);
        } else {
          log.debug("system.transform", `session ${sessionID} no instruction file in worktree, skipped AGENTS.md injection`);
        }
      }
      if (config.inject.skills) {
        const skills = listProjectSkills(state.workdir);
        if (skills.length > 0) {
          output.system.push(
            `Project skills available in this worktree (load them with the skill tool when relevant):\n${skills.map((s) => `- ${s}`).join("\n")}`,
          );
          log.debug("system.transform", `session ${sessionID} injected ${skills.length} project skills`);
        }
      }
      log.debug("system.transform", 
        `session ${sessionID} injected project ${state.project_id}, first 60 chars: ${text.slice(0, 60)}`,
      );
    },

    "tool.execute.before": async (hookInput, output) => {
      const { tool: toolName } = hookInput;
      const sessionID = hookInput.sessionID ? resolveSessionID(hookInput.sessionID) : undefined;
      if (!toolName || !sessionID) return;
      log.debug("guard", 
        `tool ${toolName} (session ${sessionID}) args=${truncate(JSON.stringify(output.args ?? {}), 1200)}`,
      );
      const state = readSessionState(config, sessionID);
      if (!state) {
        // No project switched yet: the agent is free in home, but the deny set (main copy by
        // default) still applies. Only the worktree boundary check is skipped, because there
        // is no worktree to bound against (fix: previously this skipped all interception).
        guardDenyOnly({ config, log, instanceDir, toolName, args: output.args ?? {} });
        return;
      }
      guardToolCall({ config, log, instanceDir, toolName, args: output.args ?? {}, state });
    },

    // Inject the project env (captured by on_switch) into every bash invocation. The bash tool
    // spawns a fresh process per call (exp-4: shell -c, non-login, no rc), so process-wide env
    // would not survive; this hook runs before every spawn (shell.ts:416-426).
    "shell.env": async (hookInput, output) => {
      const sessionID = hookInput.sessionID ? resolveSessionID(hookInput.sessionID) : undefined;
      if (!sessionID) return;
      const state = readSessionState(config, sessionID);
      if (!state || Object.keys(state.env).length === 0) return;
      const count = Object.keys(state.env).length;
      log.debug("shell.env", `session ${sessionID} injecting ${count} env vars from project ${state.project_id}`);
      Object.assign(output.env, state.env);
    },

    // Record the assistant text parts as they stream to completion (exp-2: this is the only
    // hook that directly exposes the generated LLM text; output.text holds the complete text).
    "experimental.text.complete": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;
      log.debug("llm", 
        `session ${sessionID} assistant text: ${truncate(output.text, 4000)}`,
      );
    },

    // Record tool execution results so a failure can be traced from the guard decision
    // through the actual execution output.
    "tool.execute.after": async (hookInput, output) => {
      const { tool: toolName, sessionID } = hookInput;
      if (!toolName || !sessionID) return;
      log.debug("tool.after", 
        `${toolName} (session ${sessionID}) title=${output.title ?? ""} output=${truncate(output.output ?? "", 800)}`,
      );
    },

    // Record the incoming user message for debugging the conversation flow.
    "chat.message": async (hookInput, output) => {
      const { sessionID } = hookInput;
      if (!sessionID) return;
      const text = output.parts
        ?.filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .filter(Boolean)
        .join("\n");
      if (text) log.debug("chat.message", `session ${sessionID}: ${truncate(text, 1000)}`);
    },

    dispose: async () => {
      log.debug("dispose", `activeSessionID=${activeSessionID ?? "(not set)"}`);
      if (!activeSessionID) {
        log.info("dispose", "no active session state, skipping end_of_session handling");
        return;
      }
      const state = readSessionState(config, activeSessionID);
      log.debug("dispose", `session ${activeSessionID} state=${state ? JSON.stringify(state) : "null"}`);
      if (!state) {
        log.info("dispose", `session ${activeSessionID} has no project state, skipping`);
        return;
      }
      handleEndOfSession(config, log, activeSessionID, state);
    },
  };
}

/** On session end (dispose), handle the worktree per the end_of_session strategy (section 4.9 design) */
function handleEndOfSession(
  config: RelayConfig,
  log: RelayLogger,
  sessionID: string,
  state: SessionState,
): void {
  const strategy = config.worktree.end_of_session;
  log.info("dispose", `session ${sessionID} end_of_session=${strategy} (project=${state.project_id}, branch=${liveBranch(state, log)})`);
  log.debug("dispose", `entering branch: end_of_session=${strategy}`);

  if (strategy === "keep") return;

  if (strategy === "cleanup") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn("dispose", `project ${state.project_id} not in registry, skipping cleanup`);
      return;
    }
    log.debug("dispose", `cleanup branch: repo_path=${project.repo_path}, workdir=${state.workdir}`);
    try {
      removeWorktree(project.repo_path, state.workdir, log);
      log.info("dispose", `cleaned up worktree: ${state.workdir}`);
    } catch (err) {
      log.error("dispose", `worktree cleanup failed: ${String(err)}`);
      log.debug("dispose", `worktree cleanup failure detail: ${String(err)}`);
    }
    return;
  }

  if (strategy === "push") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn("dispose", `project ${state.project_id} not in registry, skipping push`);
      return;
    }
    const remote = config.worktree.remote;
    // Prefer the branch currently checked out in the worktree (the agent may have renamed it,
    // e.g. `git branch -m opencode/sesXXX feat/xxx`, or created a new semantic branch); fall
    // back to the branch recorded at switch time.
    const branch = currentBranch(state.workdir, log) ?? state.worktree_branch;
    log.debug("dispose", `push branch: remote=${remote}, branch=${branch}`);
    try {
      execGit(["push", "-u", remote, branch], { cwd: state.workdir });
      log.info("dispose", `pushed branch ${branch} -> ${remote}`);
    } catch (err) {
      // On push failure, degrade to keep (section 4.9: keep worktree and branch for manual handling)
      log.warn("dispose", `push failed (${String(err)}), degraded to keep`);
      log.debug("dispose", `push failure detail: ${String(err)}`);
    }
  }
}

/**
 * Parse a command dump (e.g. `mise env` / `direnv export bash` output) into an env map.
 * Accepts both `export KEY=VALUE` and bare `KEY=VALUE` lines; strips quotes and trailing `;`.
 */
export function parseEnvDump(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim().replace(/;+$/, "");
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

/**
 * Run the configured on_switch command in the worktree and capture its env dump.
 * {{dir}} is replaced with the worktree path. Failures are logged and swallowed so a
 * misconfigured command never blocks the switch.
 */
export function runOnSwitch(
  config: RelayConfig,
  log: RelayLogger,
  workdir: string,
): Record<string, string> {
  const cmd = config.worktree.on_switch;
  if (!cmd) return {};
  const expanded = cmd.replace(/\{\{dir\}\}/g, workdir);
  log.info("on_switch", `running in ${workdir}: ${expanded}`);
  const res = spawnSync(expanded, {
    cwd: workdir,
    shell: true,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (res.error) {
    log.error("on_switch", `spawn failed: ${res.error.message}`);
    return {};
  }
  if (res.status !== 0) {
    log.warn("on_switch", `command exited ${res.status}: ${truncate((res.stderr || res.stdout || "").slice(0, 500), 500)}`);
    return {};
  }
  const env = parseEnvDump(res.stdout ?? "");
  log.debug("on_switch", `captured ${Object.keys(env).length} env vars`);
  return env;
}

function switchProject(
  config: RelayConfig,
  log: RelayLogger,
  sessionID: string,
  projectId: string,
): ToolResult {
  log.debug("switch_project", `input: sessionID=${sessionID}, projectId=${projectId}`);
  const project = findProject(config, projectId);
  if (!project) {
    log.debug("switch_project", `project not in registry: ${projectId}`);
    throw new Error(`Project not found: ${projectId}, run list_project to see available projects`);
  }

  const shortId = worktreeSessionID(sessionID);
  const worktreeDir = path.join(config.paths.worktree_root, project.id, shortId);
  const branch = `${config.worktree.branch_prefix}${shortId}`;

  const existing = readSessionState(config, sessionID);
  log.debug("switch_project", `existing state: ${existing ? JSON.stringify(existing) : "null"}`);
  if (existing && existing.project_id === project.id && existing.workdir && fs.existsSync(existing.workdir)) {
    log.info("switch_project", `reusing existing worktree in session: ${existing.workdir} (branch=${liveBranch(existing, log)})`);
    return successResult(existing);
  }

  if (fs.existsSync(worktreeDir)) {
    const registered = findWorktree(project.repo_path, worktreeDir);
    log.debug("switch_project", 
      `worktree dir exists, git registered: ${registered ? `yes (branch=${registered.branch})` : "no"}`,
    );
    if (registered) {
      log.warn("switch_project", `worktree dir exists but state is missing, reusing registered dir: ${worktreeDir} (branch=${registered.branch ?? branch})`);
      const env = runOnSwitch(config, log, worktreeDir);
      const state: SessionState = {
        project_id: project.id,
        project_name: project.name,
        workdir: worktreeDir,
        worktree_branch: registered.branch ?? branch,
        env,
      };
      const file = writeSessionState(config, sessionID, state);
      log.info("switch_project", `state written: ${file}`);
      return successResult(state);
    }
    throw new Error(`worktree dir exists but is not a registered git worktree: ${worktreeDir}, inspect and clean it manually`);
  }

  log.info("switch_project", `creating worktree: git worktree add --no-checkout -b ${branch} ${worktreeDir} (HEAD @ ${project.repo_path})`);
  try {
    createWorktree({ repoPath: project.repo_path, worktreeDir, branch }, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("switch_project", `worktree creation failed: ${message}`);
    throw new Error(`Failed to create worktree (${project.name}): ${message}`);
  }
  log.info("switch_project", `worktree created: ${worktreeDir} (branch=${branch})`);

  const env = runOnSwitch(config, log, worktreeDir);
  const state: SessionState = {
    project_id: project.id,
    project_name: project.name,
    workdir: worktreeDir,
    worktree_branch: branch,
    env,
  };
  const file = writeSessionState(config, sessionID, state);
  log.info("switch_project", `state written: ${file}`);
  return successResult(state);
}

function registerProject(
  config: RelayConfig,
  log: RelayLogger,
  args: { dir: string; id?: string; name?: string },
): ToolResult {
  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Not a directory or does not exist: ${args.dir}`);
  }
  try {
    execGit(["rev-parse", "--is-inside-work-tree"], { cwd: dir }, log);
  } catch (err) {
    throw new Error(`Not a git repository: ${args.dir} (${err instanceof Error ? err.message : String(err)})`);
  }

  const id = args.id ?? path.basename(dir);
  const name = args.name ?? id;

  const newRemotes = collectRemoteUrls(dir, log);
  if (newRemotes.length > 0) {
    for (const existing of getProjectRegistry(config)) {
      for (const url of collectRemoteUrls(existing.repo_path, log)) {
        if (newRemotes.includes(url)) {
          throw new Error(`Project ${id} is already registered (same remote: ${url})`);
        }
      }
    }
  }

  const targetDir = path.join(config.paths.workspace_root, id);
  if (fs.existsSync(targetDir)) {
    throw new Error(`Target location already exists: ${targetDir}`);
  }

  fs.mkdirSync(config.paths.workspace_root, { recursive: true });
  moveDir(dir, targetDir, log);

  const entry: ProjectItem = { id, name, repo_path: targetDir };
  writeDynamicProjects(config, [...readDynamicProjects(config).filter((p) => p.id !== id), entry]);
  log.info("register_project", `registered ${id}: ${targetDir} (moved from ${dir})`);

  return {
    title: "Project registered",
    output: JSON.stringify({ id, name, repo_path: targetDir }, null, 2),
  };
}

/** Collect all remote URLs of a git repo (empty when the repo has no remotes or cannot be inspected) */
function collectRemoteUrls(repoDir: string, log: RelayLogger): string[] {
  if (!fs.existsSync(repoDir)) return [];
  try {
    const names = execGit(["remote"], { cwd: repoDir }, log);
    if (!names.trim()) return [];
    return names
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => execGit(["remote", "get-url", name], { cwd: repoDir }, log).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Move a directory; on cross-device EXDEV, fall back to copy + delete */
function moveDir(src: string, dest: string, log: RelayLogger): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      log.debug("register_project", `EXDEV on rename, copying instead: ${src} -> ${dest}`);
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

function successResult(state: SessionState): ToolResult {
  return {
    title: "Project switched",
    output: JSON.stringify(
      {
        workdir: state.workdir,
        project_id: state.project_id,
        project_name: state.project_name,
        branch: state.worktree_branch,
      },
      null,
      2,
    ),
  };
}

const MAX_AGENTS_MD_CHARS = 12000;

/** Find the instruction file at the worktree root, mirroring opencode's precedence (instruction.ts:60-68). */
function findAgentsMd(workdir: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    const file = path.join(workdir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Read the worktree-root instruction file, capped to keep the injection bounded. */
function readProjectInstructions(workdir: string): string | null {
  const file = findAgentsMd(workdir);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.length > MAX_AGENTS_MD_CHARS ? `${raw.slice(0, MAX_AGENTS_MD_CHARS)}\n...[truncated]` : raw;
  } catch {
    return null;
  }
}

/** List project skills shipped in the worktree (.opencode/skills or .opencode/skill, mirroring OPENCODE_SKILL_PATTERN). */
function listProjectSkills(workdir: string): string[] {
  const skills: string[] = [];
  for (const dirName of ["skills", "skill"]) {
    const root = path.join(workdir, ".opencode", dirName);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md"))) {
        skills.push(entry.name);
      }
    }
  }
  return skills;
}

/** Resolve the branch shown to the agent: the worktree's current branch, falling back to the state record. */
function liveBranch(state: SessionState, log: RelayLogger): string {
  return currentBranch(state.workdir, log) ?? state.worktree_branch;
}

function renderTemplate(template: string, state: SessionState, log: RelayLogger): string {
  return template
    .replaceAll("{project_id}", state.project_id)
    .replaceAll("{project_name}", state.project_name)
    .replaceAll("{workdir}", state.workdir)
    .replaceAll("{branch}", liveBranch(state, log));
}

function guardToolCall(opts: {
  config: RelayConfig;
  log: RelayLogger;
  instanceDir: string;
  toolName: string;
  args: Record<string, unknown>;
  state: SessionState;
}): void {
  const { config, log, instanceDir, toolName, args, state } = opts;
  const allowed = state.workdir;

  let violation: string | null = null;

  if (toolName === "bash") {
    const rawWorkdir = typeof args.workdir === "string" ? args.workdir : undefined;
    // No workdir: we cannot probe the agent's intent, so default the execution dir to the project
    // worktree (the shared reference means this rewrite takes effect on the real call).
    if (!rawWorkdir) {
      args.workdir = allowed;
      log.debug("guard", `bash without workdir, defaulted to project worktree: ${allowed}`);
    } else {
      const wd = path.resolve(instanceDir, rawWorkdir);
      log.debug("guard", `bash workdir resolved: ${wd} (raw=${rawWorkdir})`);
      if (!isInside(wd, allowed) && !isInAllowDirs(wd, config.guard.allow_dirs)) {
        violation = `bash workdir outside the current project working dir: ${wd} (allowed: ${allowed})`;
      } else if (matchesDeny(config, wd, log)) {
        violation = `bash workdir matches a deny path: ${wd}`;
      }
    }
    // cd is statically resolvable: a bare cd returns home, and a cd target outside the worktree
    // is an escape attempt regardless of the agent's intent (allow_dirs still apply).
    if (!violation && typeof args.command === "string") {
      const cdViolation = checkCdEscape(args.command, allowed, config.guard.allow_dirs, log);
      if (cdViolation) violation = cdViolation;
    }
  } else if (FILE_TOOLS.has(toolName)) {
    // Parameter names verified against opencode 1.18.5: read/write/edit=filePath; glob/grep=path (search dir);
    // apply_patch=patchText (paths inside *** Add/Delete/Update/Move lines, possibly multiple)
    const candidates = fileToolPaths(toolName, args);
    for (const raw of candidates) {
      // Resolve relative paths against the project worktree (not the session dir=home), and rewrite
      // the tool arg to the absolute path when the agent's intent is correct (inside the worktree).
      const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(allowed, raw);
      log.debug("guard", `${toolName} path resolved: ${raw} -> ${candidate}`);
      if (!isInside(candidate, allowed) && !isInAllowDirs(candidate, config.guard.allow_dirs)) {
        violation = `${toolName} path outside the current project working dir: ${raw} (allowed: ${allowed})`;
        break;
      }
      if (matchesDeny(config, candidate, log)) {
        violation = `${toolName} path matches a deny path: ${raw}`;
        break;
      }
      if (!path.isAbsolute(raw)) {
        // Shared reference: rewriting args.* takes effect on the real tool call.
        if (toolName === "read" || toolName === "write" || toolName === "edit") {
          args.filePath = candidate;
        } else if (toolName === "glob" || toolName === "grep") {
          args.path = candidate;
        }
        log.debug("guard", `${toolName} rewrote relative path to absolute: ${candidate}`);
      }
    }
    // glob/grep without an explicit path default to the worktree as the search root
    // (opencode would otherwise search the session dir=home, which is unverifiable intent).
    if ((toolName === "glob" || toolName === "grep") && typeof args.path !== "string") {
      args.path = allowed;
      log.debug("guard", `${toolName} without path, defaulted search root to worktree: ${allowed}`);
    }
  }

  if (!violation) {
    log.debug("guard", `allowed: ${toolName} (path check passed)`);
    return;
  }
  log.warn("guard", `${violation}`);
  if (config.guard.enabled && config.guard.reject_on_violation) {
    log.debug("guard", 
      `rejecting execution (reject_on_violation=${config.guard.reject_on_violation}, enabled=${config.guard.enabled})`,
    );
    throw new Error(`${violation}. Call switch_project to switch to the target project first`);
  }
}

/**
 * Check a bash command for cd escapes: a bare cd returns home, and any cd target that resolves
 * outside the project worktree is an escape attempt (relative targets resolve against the worktree).
 * Returns a violation message, or null when no cd escape is found.
 */
function checkCdEscape(command: string, worktree: string, allowDirs: string[], log: RelayLogger): string | null {
  // Match `cd` invocations: bare cd, cd <path>, cd <path> followed by &&, ;, | or end.
  // Use word boundaries to avoid matching e.g. `scd`; stop the path at shell metacharacters.
  const cdRe = /\bcd(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(command)) !== null) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target) {
      log.debug("guard", `bash bare cd (returns home) in: ${command}`);
      return `bash cd without an argument returns home, outside the project worktree (allowed: ${worktree})`;
    }
    const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(worktree, target);
    log.debug("guard", `bash cd target resolved: ${target} -> ${candidate}`);
    if (!isInside(candidate, worktree) && !isInAllowDirs(candidate, allowDirs)) {
      return `bash cd escapes the project worktree: ${target} -> ${candidate} (allowed: ${worktree})`;
    }
  }
  return null;
}

function isInAllowDirs(candidate: string, allowDirs: string[]): boolean {
  return allowDirs.some((dir) => isInside(candidate, dir));
}

/** Extract the path arguments of file tools (parameter names verified against opencode 1.18.11) */
function fileToolPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === "apply_patch") {
    return typeof args.patchText === "string" ? extractPatchPaths(args.patchText) : [];
  }
  if (toolName === "glob" || toolName === "grep") {
    // The search-dir argument for glob/grep is path; when omitted the search root is the session
    // directory (home), leaving no explicit path to validate.
    return typeof args.path === "string" ? [args.path] : [];
  }
  return typeof args.filePath === "string" ? [args.filePath] : [];
}

/** Extract all target paths from an apply_patch patchText (*** Add/Delete/Update File / Move to lines) */
function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    const trimmed = line.trim();
    for (const marker of ["*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:"]) {
      if (trimmed.startsWith(marker)) {
        const p = trimmed.slice(marker.length).trim();
        if (p) paths.push(p);
        break;
      }
    }
  }
  return paths;
}

/**
 * Stateless guard: no project is switched yet, so there is no worktree boundary to enforce.
 * Only the deny set (main copy by default + user patterns) applies: the agent may work freely
 * in home, but must not touch the main copy directly.
 */
function guardDenyOnly(opts: {
  config: RelayConfig;
  log: RelayLogger;
  instanceDir: string;
  toolName: string;
  args: Record<string, unknown>;
}): void {
  const { config, log, instanceDir, toolName, args } = opts;

  let violation: string | null = null;

  if (toolName === "bash") {
    const rawWorkdir = typeof args.workdir === "string" ? args.workdir : undefined;
    if (rawWorkdir) {
      const wd = path.resolve(instanceDir, rawWorkdir);
      log.debug("guard", `stateless bash workdir resolved: ${wd} (raw=${rawWorkdir})`);
      if (matchesDeny(config, wd, log)) {
        violation = `bash workdir matches a deny path: ${wd}`;
      }
    }
    if (!violation && typeof args.command === "string") {
      const cdViolation = checkCdDeny(args.command, instanceDir, config, log);
      if (cdViolation) violation = cdViolation;
    }
  } else if (FILE_TOOLS.has(toolName)) {
    const candidates = fileToolPaths(toolName, args);
    for (const raw of candidates) {
      const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(instanceDir, raw);
      log.debug("guard", `stateless ${toolName} path resolved: ${raw} -> ${candidate}`);
      if (matchesDeny(config, candidate, log)) {
        violation = `${toolName} path matches a deny path: ${raw}`;
        break;
      }
    }
  }

  if (!violation) {
    log.debug("guard", `stateless allowed: ${toolName} (no deny match)`);
    return;
  }
  log.warn("guard", `stateless: ${violation}`);
  if (config.guard.enabled && config.guard.reject_on_violation) {
    log.debug("guard", 
      `stateless rejecting execution (reject_on_violation=${config.guard.reject_on_violation}, enabled=${config.guard.enabled})`,
    );
    throw new Error(`${violation}. Call switch_project to switch to the target project first`);
  }
}

/**
 * Check a bash command for cd targets that hit the deny set (stateless variant: bare cd back to
 * home is legal, because home is the free zone; only deny hits are violations).
 */
function checkCdDeny(command: string, instanceDir: string, config: RelayConfig, log: RelayLogger): string | null {
  const cdRe = /\bcd(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(command)) !== null) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target) {
      log.debug("guard", `stateless bash bare cd (returns home), allowed`);
      continue;
    }
    const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(instanceDir, target);
    log.debug("guard", `stateless bash cd target resolved: ${target} -> ${candidate}`);
    if (matchesDeny(config, candidate, log)) {
      return `bash cd target matches a deny path: ${target} -> ${candidate}`;
    }
  }
  return null;
}

/** Whether a candidate path hits guard.deny_paths (allow_paths take precedence) */
function matchesDeny(config: RelayConfig, candidate: string, log: RelayLogger): boolean {
  const resolved = path.resolve(candidate);
  for (const p of config.guard.allow_paths) {
    if (globMatch(resolved, p)) {
      log.debug("guard", `allow_paths hit, exempted: ${candidate} matches ${p}`);
      return false;
    }
  }
  for (const p of config.guard.deny_paths) {
    if (globMatch(resolved, p)) {
      log.debug("guard", `deny_paths hit: ${candidate} matches ${p}`);
      return true;
    }
  }
  log.debug("guard", `no deny/allow match: ${candidate}`);
  return false;
}

/** Lightweight glob match: `/dir/**` (the dir and its descendants) and `/dir` (the dir itself and below) */
function globMatch(candidate: string, pattern: string): boolean {
  const resolved = path.resolve(expandTilde(pattern));
  const base = resolved.endsWith("/**") ? resolved.slice(0, -3) : resolved;
  return isInside(candidate, base);
}

function expandTilde(p: string): string {
  if (p === "~") return process.env.HOME ?? "/";
  if (p.startsWith("~/")) return `${process.env.HOME ?? "/"}${p.slice(1)}`;
  return p;
}

/** Reclaim worktrees inactive for more than stale_days (P3, section 4.8 design) */
export function cleanupStaleWorktrees(
  config: RelayConfig,
  log: RelayLogger,
  dryRun: boolean,
): string {
  const worktreeRoot = config.paths.worktree_root;
  const staleDays = config.worktree.stale_days;
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  const worktrees = findWorktreeDirs(worktreeRoot);
  log.debug("cleanup", 
    `scanned ${worktrees.length} worktree dirs (stale_days=${staleDays}, cutoff=${new Date(cutoff).toISOString()})`,
  );
  if (worktrees.length === 0) return "no worktrees to reclaim";

  const lines: string[] = [];
  let removed = 0;

  for (const wt of worktrees) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(wt.dir).mtimeMs;
    } catch {
      log.debug("cleanup", `dir missing, skipping: ${wt.dir}`);
      continue; // dir no longer exists
    }
    if (mtimeMs > cutoff) {
      log.debug("cleanup", `active, skipping: ${wt.dir} (mtime=${new Date(mtimeMs).toISOString()})`);
      continue; // active, skip
    }
    log.debug("cleanup", `inactive, to reclaim: ${wt.dir} (mtime=${new Date(mtimeMs).toISOString()})`);

    // Two steps: git worktree remove --force (clears git metadata + dir) + delete matching state file
    const project = findProject(config, wt.project);
    const stateFile = path.join(config.paths.state_dir, sanitizeSessionID(wt.dir.split(path.sep).pop() ?? "") + ".json");

    if (dryRun) {
      lines.push(`[dry-run] to reclaim: ${wt.dir} (last active ${new Date(mtimeMs).toISOString()})`);
      continue;
    }

    try {
      if (project) {
        removeWorktree(project.repo_path, wt.dir, log);
      } else {
        // Project not in registry: only clean the dir (no repo available for git worktree remove)
        fs.rmSync(wt.dir, { recursive: true, force: true });
      }
      if (fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true });
      removed++;
      lines.push(`reclaimed: ${wt.dir}`);
    } catch (err) {
      log.debug("cleanup", `reclaim failure detail: ${wt.dir} (${String(err)})`);
      lines.push(`reclaim failed (skipped): ${wt.dir} (${String(err)})`);
    }
  }

  const summary = `reclaimed ${removed} inactive worktrees${lines.length ? "\n" + lines.join("\n") : ""}`;
  log.info("cleanup", `${summary}`);
  return summary;
}

/** Resolve symlinks, falling back to the nearest existing ancestor so non-existent paths (e.g. a file being written) still compare correctly. /home -> /data/home aliases must not break the worktree boundary. */
function realpathBest(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const dir = path.dirname(p);
    if (dir === p) return path.resolve(p);
    return path.join(realpathBest(dir), path.basename(p));
  }
}

/** Prefix comparison with a path separator boundary, so /a/foo and /a/foobar are not confused */
function isInside(candidate: string, container: string): boolean {
  const resolved = realpathBest(candidate);
  const base = realpathBest(container);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

/** Cap a string for debug logging; appends the total length when truncated */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}... (total ${s.length} chars)`;
}
