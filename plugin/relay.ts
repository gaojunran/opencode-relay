import type { Hooks, PluginInput, PluginModule, ToolResult } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import fs from "node:fs";
import path from "node:path";
import {
  createLogger,
  findProject,
  getProjectRegistry,
  loadConfig,
  type RelayConfig,
  type RelayLogger,
} from "./config.js";
import {
  readSessionState,
  removeSessionState,
  sanitizeSessionID,
  shortSessionID,
  writeSessionState,
  type SessionState,
} from "./state.js";
import { createWorktree, execGit, findWorktree, findWorktreeDirs, removeWorktree } from "./git.js";

const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "apply_patch"]);

export default {
  id: "opencode-relay",
  server: async (input: PluginInput) => {
    const config = loadConfig();
    const log = createLogger(config.general.log_level);
    if (!config.general.enabled) {
      log.info("Plugin disabled (general.enabled = false)");
      return {};
    }
    const sessionDir = path.resolve(input.directory);
    const home = path.resolve(config.general.home);
    if (!isInside(sessionDir, home)) {
      log.info(`[opt-out] Session directory outside home, skipping plugin load: sessionDir=${sessionDir}, home=${home}`);
      return {};
    }
    log.info(`Plugin started, session directory: ${sessionDir} (home: ${home})`);
    log.debug(
      `[config] log_level=${config.general.log_level} enabled=${config.general.enabled} home=${config.general.home} workspace_root=${config.paths.workspace_root} worktree_root=${config.paths.worktree_root} state_dir=${config.paths.state_dir} projects=${getProjectRegistry(config).length}`,
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

  // dispose receives no arguments (opencode plugin/index.ts:266 calls hook.dispose?.() directly),
  // so a module-level variable records the session of the most recent tool call for dispose.
  let activeSessionID: string | undefined;

  return {
    tool: {
      list_project: tool({
        description:
          "List the currently available projects (returns id and name, never exposes repo paths), used before switch_project.",
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
          log.debug(`[list_project] returning ${result.length} projects`);
          return JSON.stringify(result, null, 2);
        },
      }),

      switch_project: tool({
        description:
          "Switch the current session to the given project: unconditionally create (or reuse) an isolated git worktree as the working directory, and return the workdir for the bash workdir parameter.",
        args: {
          project_id: tool.schema.string().describe("Project ID (from list_project)"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return switchProject(config, log, context.sessionID, args.project_id);
        },
      }),

      cleanup_worktrees: tool({
        description:
          "Reclaim worktrees inactive for more than stale_days (git worktree remove --force + delete matching state file). Session history stays in the database and is unaffected.",
        args: {
          dry_run: tool.schema.boolean().optional().describe("When true, only list items to reclaim, do not delete"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return cleanupStaleWorktrees(config, log, args.dry_run === true);
        },
      }),

      leave_project: tool({
        description:
          "Leave the current project and return to the free state where no project is switched (guard no longer intercepts, system prompt shows the project list again). The worktree directory and branch are kept, so changes are not lost; switching to the same project again in this session reuses the original worktree.",
        args: {},
        execute: async (_args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          const state = readSessionState(config, context.sessionID);
          if (!state) {
            log.info(`[leave_project] session ${context.sessionID} has no project switched, nothing to leave`);
            return {
              title: "Not in a project",
              output: "This session has no project switched, no leave_project needed.",
            };
          }
          const removed = removeSessionState(config, context.sessionID);
          log.info(
            `[leave_project] session ${context.sessionID} left project ${state.project_id}, state removed: ${removed} (worktree kept: ${state.workdir}, branch=${state.worktree_branch})`,
          );
          return {
            title: "Left project",
            output: JSON.stringify(
              {
                left_project: state.project_id,
                workdir_preserved: state.workdir,
                branch_preserved: state.worktree_branch,
                note: "worktree and branch preserved, no changes lost; use cleanup_worktrees to reclaim",
              },
              null,
              2,
            ),
          };
        },
      }),
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      const sessionID = hookInput.sessionID;
      if (!sessionID || !config.inject.enabled) return;
      const state = readSessionState(config, sessionID);
      if (!state) {
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
            log.debug(`[system.transform] session ${sessionID} has no state, injected project list (${projects.length} projects)`);
          }
        } else {
          log.debug(`[system.transform] session ${sessionID} has no state, skipped injection`);
        }
        return;
      }
      const text = renderTemplate(config.inject.template, state);
      output.system.push(text);
      log.debug(
        `[system.transform] session ${sessionID} injected project ${state.project_id}, first 60 chars: ${text.slice(0, 60)}`,
      );
    },

    "tool.execute.before": async (hookInput, output) => {
      const { tool: toolName, sessionID } = hookInput;
      if (!toolName || !sessionID) return;
      const state = readSessionState(config, sessionID);
      if (!state) {
        log.debug(`[guard] session ${sessionID} has no state, skipping interception`);
        return;
      }
      log.debug(`[guard] tool ${toolName} (session ${sessionID})`);
      guardToolCall({ config, log, instanceDir, toolName, args: output.args ?? {}, state });
    },

    dispose: async () => {
      log.debug(`[dispose] activeSessionID=${activeSessionID ?? "(not set)"}`);
      if (!activeSessionID) {
        log.info("[dispose] no active session state, skipping end_of_session handling");
        return;
      }
      const state = readSessionState(config, activeSessionID);
      log.debug(`[dispose] session ${activeSessionID} state=${state ? JSON.stringify(state) : "null"}`);
      if (!state) {
        log.info(`[dispose] session ${activeSessionID} has no project state, skipping`);
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
  log.info(`[dispose] session ${sessionID} end_of_session=${strategy} (project=${state.project_id}, branch=${state.worktree_branch})`);
  log.debug(`[dispose] entering branch: end_of_session=${strategy}`);

  if (strategy === "keep") return;

  if (strategy === "cleanup") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn(`[dispose] project ${state.project_id} not in registry, skipping cleanup`);
      return;
    }
    log.debug(`[dispose] cleanup branch: repo_path=${project.repo_path}, workdir=${state.workdir}`);
    try {
      removeWorktree(project.repo_path, state.workdir, log);
      log.info(`[dispose] cleaned up worktree: ${state.workdir}`);
    } catch (err) {
      log.error(`[dispose] worktree cleanup failed: ${String(err)}`);
      log.debug(`[dispose] worktree cleanup failure detail: ${String(err)}`);
    }
    return;
  }

  if (strategy === "push") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn(`[dispose] project ${state.project_id} not in registry, skipping push`);
      return;
    }
    const remote = config.worktree.remote;
    const branch = state.worktree_branch;
    log.debug(`[dispose] push branch: remote=${remote}, branch=${branch}`);
    try {
      execGit(["push", "-u", remote, branch], { cwd: state.workdir });
      log.info(`[dispose] pushed branch ${branch} -> ${remote}`);
    } catch (err) {
      // On push failure, degrade to keep (section 4.9: keep worktree and branch for manual handling)
      log.warn(`[dispose] push failed (${String(err)}), degraded to keep`);
      log.debug(`[dispose] push failure detail: ${String(err)}`);
    }
  }
}

function switchProject(
  config: RelayConfig,
  log: RelayLogger,
  sessionID: string,
  projectId: string,
): ToolResult {
  log.debug(`[switch_project] input: sessionID=${sessionID}, projectId=${projectId}`);
  const project = findProject(config, projectId);
  if (!project) {
    log.debug(`[switch_project] project not in registry: ${projectId}`);
    throw new Error(`Project not found: ${projectId}, run list_project to see available projects`);
  }

  const shortId = shortSessionID(sessionID);
  const worktreeDir = path.join(config.paths.worktree_root, project.id, shortId);
  const branch = `${config.worktree.branch_prefix}${shortId}`;

  const existing = readSessionState(config, sessionID);
  log.debug(`[switch_project] existing state: ${existing ? JSON.stringify(existing) : "null"}`);
  if (existing && existing.project_id === project.id && existing.workdir && fs.existsSync(existing.workdir)) {
    log.info(`[switch_project] reusing existing worktree in session: ${existing.workdir} (branch=${existing.worktree_branch})`);
    return successResult(existing);
  }

  if (fs.existsSync(worktreeDir)) {
    const registered = findWorktree(project.repo_path, worktreeDir);
    log.debug(
      `[switch_project] worktree dir exists, git registered: ${registered ? `yes (branch=${registered.branch})` : "no"}`,
    );
    if (registered) {
      log.warn(`[switch_project] worktree dir exists but state is missing, reusing registered dir: ${worktreeDir} (branch=${registered.branch ?? branch})`);
      const state: SessionState = {
        project_id: project.id,
        project_name: project.name,
        workdir: worktreeDir,
        worktree_branch: registered.branch ?? branch,
      };
      const file = writeSessionState(config, sessionID, state);
      log.info(`[switch_project] state written: ${file}`);
      return successResult(state);
    }
    throw new Error(`worktree dir exists but is not a registered git worktree: ${worktreeDir}, inspect and clean it manually`);
  }

  log.info(`[switch_project] creating worktree: git worktree add --no-checkout -b ${branch} ${worktreeDir} (HEAD @ ${project.repo_path})`);
  try {
    createWorktree({ repoPath: project.repo_path, worktreeDir, branch }, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[switch_project] worktree creation failed: ${message}`);
    throw new Error(`Failed to create worktree (${project.name}): ${message}`);
  }
  log.info(`[switch_project] worktree created: ${worktreeDir} (branch=${branch})`);

  const state: SessionState = {
    project_id: project.id,
    project_name: project.name,
    workdir: worktreeDir,
    worktree_branch: branch,
  };
  const file = writeSessionState(config, sessionID, state);
  log.info(`[switch_project] state written: ${file}`);
  return successResult(state);
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

function renderTemplate(template: string, state: SessionState): string {
  return template
    .replaceAll("{project_id}", state.project_id)
    .replaceAll("{project_name}", state.project_name)
    .replaceAll("{workdir}", state.workdir)
    .replaceAll("{branch}", state.worktree_branch);
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
    const wd = rawWorkdir ? path.resolve(instanceDir, rawWorkdir) : instanceDir;
    log.debug(`[guard] bash workdir resolved: ${wd} (raw=${rawWorkdir ?? "defaulted to instanceDir"})`);
    if (!isInside(wd, allowed)) {
      violation = `bash workdir outside the current project working dir: ${wd} (allowed: ${allowed})`;
    } else if (matchesDeny(config, wd, log)) {
      violation = `bash workdir matches a deny path: ${wd}`;
    }
  } else if (FILE_TOOLS.has(toolName)) {
    // Parameter names verified against opencode 1.18.11: read/write/edit=filePath; glob/grep=path (search dir);
    // apply_patch=patchText (paths inside *** Add/Delete/Update/Move lines, possibly multiple)
    const candidates = fileToolPaths(toolName, args);
    for (const raw of candidates) {
      const candidate = path.resolve(instanceDir, raw);
      log.debug(`[guard] ${toolName} path resolved: ${raw} -> ${candidate}`);
      if (!isInside(candidate, allowed)) {
        violation = `${toolName} path outside the current project working dir: ${raw} (allowed: ${allowed})`;
        break;
      }
      if (matchesDeny(config, candidate, log)) {
        violation = `${toolName} path matches a deny path: ${raw}`;
        break;
      }
    }
  }

  if (!violation) {
    log.debug(`[guard] allowed: ${toolName} (path check passed)`);
    return;
  }
  log.warn(`[guard] ${violation}`);
  if (config.guard.enabled && config.guard.reject_on_violation) {
    log.debug(
      `[guard] rejecting execution (reject_on_violation=${config.guard.reject_on_violation}, enabled=${config.guard.enabled})`,
    );
    throw new Error(`${violation}. Call switch_project to switch to the target project first`);
  }
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

/** Whether a candidate path hits guard.deny_paths (allow_paths take precedence) */
function matchesDeny(config: RelayConfig, candidate: string, log: RelayLogger): boolean {
  const resolved = path.resolve(candidate);
  for (const p of config.guard.allow_paths) {
    if (globMatch(resolved, p)) {
      log.debug(`[guard] allow_paths hit, exempted: ${candidate} matches ${p}`);
      return false;
    }
  }
  for (const p of config.guard.deny_paths) {
    if (globMatch(resolved, p)) {
      log.debug(`[guard] deny_paths hit: ${candidate} matches ${p}`);
      return true;
    }
  }
  log.debug(`[guard] no deny/allow match: ${candidate}`);
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
  log.debug(
    `[cleanup] scanned ${worktrees.length} worktree dirs (stale_days=${staleDays}, cutoff=${new Date(cutoff).toISOString()})`,
  );
  if (worktrees.length === 0) return "no worktrees to reclaim";

  const lines: string[] = [];
  let removed = 0;

  for (const wt of worktrees) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(wt.dir).mtimeMs;
    } catch {
      log.debug(`[cleanup] dir missing, skipping: ${wt.dir}`);
      continue; // dir no longer exists
    }
    if (mtimeMs > cutoff) {
      log.debug(`[cleanup] active, skipping: ${wt.dir} (mtime=${new Date(mtimeMs).toISOString()})`);
      continue; // active, skip
    }
    log.debug(`[cleanup] inactive, to reclaim: ${wt.dir} (mtime=${new Date(mtimeMs).toISOString()})`);

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
      log.debug(`[cleanup] reclaim failure detail: ${wt.dir} (${String(err)})`);
      lines.push(`reclaim failed (skipped): ${wt.dir} (${String(err)})`);
    }
  }

  const summary = `reclaimed ${removed} inactive worktrees${lines.length ? "\n" + lines.join("\n") : ""}`;
  log.info(`[cleanup] ${summary}`);
  return summary;
}

/** Prefix comparison with a path separator boundary, so /a/foo and /a/foobar are not confused */
function isInside(candidate: string, container: string): boolean {
  const resolved = path.resolve(candidate);
  const base = path.resolve(container);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}
