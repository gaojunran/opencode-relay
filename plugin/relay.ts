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
  sanitizeSessionID,
  shortSessionID,
  writeSessionState,
  type SessionState,
} from "./state.js";
import { createWorktree, execGit, findWorktree, findWorktreeDirs, removeWorktree } from "./git.js";

const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

export default {
  id: "opencode-relay",
  server: async (input: PluginInput) => {
    const config = loadConfig();
    const log = createLogger(config.general.log_level);
    if (!config.general.enabled) {
      log.info("插件已禁用（general.enabled = false）");
      return {};
    }
    const sessionDir = path.resolve(input.directory);
    const home = path.resolve(config.general.home);
    if (!isInside(sessionDir, home)) {
      log.info(`[opt-out] 会话目录不在 home 内，跳过插件加载: 会话目录=${sessionDir}, home=${home}`);
      return {};
    }
    log.info(`插件启动，会话目录: ${sessionDir}（home: ${home}）`);
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

  // dispose 无参数（opencode plugin/index.ts:266 直接调用 hook.dispose?.()），
  // 用模块级变量记录最近一次工具调用所属会话，dispose 时据此定位 state
  let activeSessionID: string | undefined;

  return {
    tool: {
      list_project: tool({
        description:
          "列出当前可用的项目（返回 id 与 name，不暴露仓库路径），用于 switch_project 切换项目。",
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
          log.debug(`[list_project] 返回 ${result.length} 个项目`);
          return JSON.stringify(result, null, 2);
        },
      }),

      switch_project: tool({
        description:
          "将当前会话切换到指定项目：无条件创建（或复用）独立 git worktree 作为工作目录，返回 workdir 供 bash 的 workdir 参数使用。",
        args: {
          project_id: tool.schema.string().describe("项目 ID（来自 list_project）"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return switchProject(config, log, context.sessionID, args.project_id);
        },
      }),

      cleanup_worktrees: tool({
        description:
          "回收超过 stale_days 天不活跃的 worktree（git worktree remove --force + 同步删除状态文件）。会话历史保留在数据库，不受影响。",
        args: {
          dry_run: tool.schema.boolean().optional().describe("为 true 时只列出待回收项，不实际删除"),
        },
        execute: async (args, context): Promise<ToolResult> => {
          activeSessionID = context.sessionID;
          return cleanupStaleWorktrees(config, log, args.dry_run === true);
        },
      }),
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      const sessionID = hookInput.sessionID;
      if (!sessionID || !config.inject.enabled) return;
      const state = readSessionState(config, sessionID);
      if (!state) {
        log.debug(`[system.transform] 会话 ${sessionID} 无状态，跳过注入`);
        return;
      }
      const text = renderTemplate(config.inject.template, state);
      output.system.push(text);
      log.debug(
        `[system.transform] 会话 ${sessionID} 注入项目 ${state.project_id}，新增文本前 60 字符: ${text.slice(0, 60)}`,
      );
    },

    "tool.execute.before": async (hookInput, output) => {
      const { tool: toolName, sessionID } = hookInput;
      if (!toolName || !sessionID) return;
      const state = readSessionState(config, sessionID);
      if (!state) {
        log.debug(`[guard] 会话 ${sessionID} 无状态，跳过拦截`);
        return;
      }
      log.debug(`[guard] 工具 ${toolName}（会话 ${sessionID}）`);
      guardToolCall({ config, log, instanceDir, toolName, args: output.args ?? {}, state });
    },

    dispose: async () => {
      log.debug(`[dispose] activeSessionID=${activeSessionID ?? "（未设置）"}`);
      if (!activeSessionID) {
        log.info("[dispose] 无活动会话状态，跳过 end_of_session 处理");
        return;
      }
      const state = readSessionState(config, activeSessionID);
      log.debug(`[dispose] 会话 ${activeSessionID} state=${state ? JSON.stringify(state) : "null"}`);
      if (!state) {
        log.info(`[dispose] 会话 ${activeSessionID} 无项目状态，跳过`);
        return;
      }
      handleEndOfSession(config, log, activeSessionID, state);
    },
  };
}

/** 会话结束（dispose）时按 end_of_session 策略处理 worktree（4.9 节设计） */
function handleEndOfSession(
  config: RelayConfig,
  log: RelayLogger,
  sessionID: string,
  state: SessionState,
): void {
  const strategy = config.worktree.end_of_session;
  log.info(`[dispose] 会话 ${sessionID} end_of_session=${strategy} (project=${state.project_id}, branch=${state.worktree_branch})`);
  log.debug(`[dispose] 进入分支: end_of_session=${strategy}`);

  if (strategy === "keep") return;

  if (strategy === "cleanup") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn(`[dispose] 项目 ${state.project_id} 不在注册表，跳过 cleanup`);
      return;
    }
    log.debug(`[dispose] cleanup 分支: repo_path=${project.repo_path}, workdir=${state.workdir}`);
    try {
      removeWorktree(project.repo_path, state.workdir, log);
      log.info(`[dispose] 已清理 worktree: ${state.workdir}`);
    } catch (err) {
      log.error(`[dispose] worktree 清理失败: ${String(err)}`);
      log.debug(`[dispose] worktree 清理失败详情: ${String(err)}`);
    }
    return;
  }

  if (strategy === "push") {
    const project = findProject(config, state.project_id);
    if (!project) {
      log.warn(`[dispose] 项目 ${state.project_id} 不在注册表，跳过 push`);
      return;
    }
    const remote = config.worktree.remote;
    const branch = state.worktree_branch;
    log.debug(`[dispose] push 分支: remote=${remote}, branch=${branch}`);
    try {
      execGit(["push", "-u", remote, branch], { cwd: state.workdir });
      log.info(`[dispose] 已 push 分支 ${branch} -> ${remote}`);
    } catch (err) {
      // push 失败降级为 keep（4.9 节：失败保留 worktree 与分支，人工处理）
      log.warn(`[dispose] push 失败（${String(err)}），降级为 keep`);
      log.debug(`[dispose] push 失败详情: ${String(err)}`);
    }
  }
}

function switchProject(
  config: RelayConfig,
  log: RelayLogger,
  sessionID: string,
  projectId: string,
): ToolResult {
  log.debug(`[switch_project] 入参: sessionID=${sessionID}, projectId=${projectId}`);
  const project = findProject(config, projectId);
  if (!project) {
    log.debug(`[switch_project] 项目未命中注册表: ${projectId}`);
    throw new Error(`项目不存在: ${projectId}，请先用 list_project 查看可用项目`);
  }

  const shortId = shortSessionID(sessionID);
  const worktreeDir = path.join(config.paths.worktree_root, project.id, shortId);
  const branch = `${config.worktree.branch_prefix}${shortId}`;

  const existing = readSessionState(config, sessionID);
  log.debug(`[switch_project] 已有状态: ${existing ? JSON.stringify(existing) : "null"}`);
  if (existing && existing.project_id === project.id && existing.workdir && fs.existsSync(existing.workdir)) {
    log.info(`[switch_project] 会话内复用已有 worktree: ${existing.workdir} (branch=${existing.worktree_branch})`);
    return successResult(existing);
  }

  if (fs.existsSync(worktreeDir)) {
    const registered = findWorktree(project.repo_path, worktreeDir);
    log.debug(
      `[switch_project] worktree 目录已存在，git 注册: ${registered ? `是 (branch=${registered.branch})` : "否"}`,
    );
    if (registered) {
      log.warn(`[switch_project] worktree 目录存在但状态缺失，复用已注册目录: ${worktreeDir} (branch=${registered.branch ?? branch})`);
      const state: SessionState = {
        project_id: project.id,
        project_name: project.name,
        workdir: worktreeDir,
        worktree_branch: registered.branch ?? branch,
      };
      const file = writeSessionState(config, sessionID, state);
      log.info(`[switch_project] 状态已写入: ${file}`);
      return successResult(state);
    }
    throw new Error(`worktree 目录已存在但未注册为 git worktree: ${worktreeDir}，请人工检查后清理`);
  }

  log.info(`[switch_project] 创建 worktree: git worktree add --no-checkout -b ${branch} ${worktreeDir} (HEAD @ ${project.repo_path})`);
  try {
    createWorktree({ repoPath: project.repo_path, worktreeDir, branch }, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[switch_project] worktree 创建失败: ${message}`);
    throw new Error(`创建 worktree 失败（${project.name}）: ${message}`);
  }
  log.info(`[switch_project] worktree 创建成功: ${worktreeDir} (branch=${branch})`);

  const state: SessionState = {
    project_id: project.id,
    project_name: project.name,
    workdir: worktreeDir,
    worktree_branch: branch,
  };
  const file = writeSessionState(config, sessionID, state);
  log.info(`[switch_project] 状态已写入: ${file}`);
  return successResult(state);
}

function successResult(state: SessionState): ToolResult {
  return {
    title: "项目已切换",
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
    log.debug(`[guard] bash workdir 解析: ${wd}（raw=${rawWorkdir ?? "缺省，取 instanceDir"}）`);
    if (!isInside(wd, allowed)) {
      violation = `bash workdir 超出当前项目工作目录: ${wd}（允许: ${allowed}）`;
    } else if (matchesDeny(config, wd, log)) {
      violation = `bash workdir 命中 deny 路径: ${wd}`;
    }
  } else if (FILE_TOOLS.has(toolName)) {
    const raw =
      typeof args.filepath === "string"
        ? args.filepath
        : typeof args.pattern === "string"
          ? args.pattern
          : undefined;
    if (raw) {
      const candidate = path.resolve(instanceDir, raw);
      log.debug(`[guard] ${toolName} 路径解析: ${raw} -> ${candidate}`);
      if (path.isAbsolute(raw) && !isInside(candidate, allowed)) {
        violation = `${toolName} 路径超出当前项目工作目录: ${raw}（允许: ${allowed}）`;
      } else if (path.isAbsolute(raw) && matchesDeny(config, candidate, log)) {
        violation = `${toolName} 路径命中 deny 路径: ${raw}`;
      }
    }
  }

  if (!violation) {
    log.debug(`[guard] 放行: ${toolName}（路径检查通过）`);
    return;
  }
  log.warn(`[guard] ${violation}`);
  if (config.guard.enabled && config.guard.reject_on_violation) {
    log.debug(
      `[guard] 拒绝执行（reject_on_violation=${config.guard.reject_on_violation}, enabled=${config.guard.enabled}）`,
    );
    throw new Error(`${violation}。请先调用 switch_project 切换到目标项目后再操作`);
  }
}

/** 判断候选路径是否命中 guard.deny_paths（allow_paths 优先放行） */
function matchesDeny(config: RelayConfig, candidate: string, log: RelayLogger): boolean {
  const resolved = path.resolve(candidate);
  for (const p of config.guard.allow_paths) {
    if (globMatch(resolved, p)) {
      log.debug(`[guard] allow_paths 命中，豁免: ${candidate} 匹配 ${p}`);
      return false;
    }
  }
  for (const p of config.guard.deny_paths) {
    if (globMatch(resolved, p)) {
      log.debug(`[guard] deny_paths 命中: ${candidate} 匹配 ${p}`);
      return true;
    }
  }
  log.debug(`[guard] deny/allow 均未命中: ${candidate}`);
  return false;
}

/** 轻量 glob 匹配：`/dir/**`（目录及其后代）与 `/dir`（目录本身及其下）两种形式 */
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

/** 回收超过 stale_days 天不活跃的 worktree（P3，4.8 节设计） */
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
    `[cleanup] 扫描到 ${worktrees.length} 个 worktree 目录（stale_days=${staleDays}, cutoff=${new Date(cutoff).toISOString()}）`,
  );
  if (worktrees.length === 0) return "没有需要回收的 worktree";

  const lines: string[] = [];
  let removed = 0;

  for (const wt of worktrees) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(wt.dir).mtimeMs;
    } catch {
      log.debug(`[cleanup] 目录不存在，跳过: ${wt.dir}`);
      continue; // 目录已不存在
    }
    if (mtimeMs > cutoff) {
      log.debug(`[cleanup] 活跃，跳过: ${wt.dir}（mtime=${new Date(mtimeMs).toISOString()}）`);
      continue; // 活跃，跳过
    }
    log.debug(`[cleanup] 不活跃，待回收: ${wt.dir}（mtime=${new Date(mtimeMs).toISOString()}）`);

    // 两步走：git worktree remove --force（清 git 元数据 + 目录）+ 同步删 state
    const project = findProject(config, wt.project);
    const stateFile = path.join(config.paths.state_dir, sanitizeSessionID(wt.dir.split(path.sep).pop() ?? "") + ".json");

    if (dryRun) {
      lines.push(`[dry-run] 待回收: ${wt.dir}（最后活动 ${new Date(mtimeMs).toISOString()}）`);
      continue;
    }

    try {
      if (project) {
        removeWorktree(project.repo_path, wt.dir, log);
      } else {
        // 项目不在注册表：仅清理目录（无 repo 可执行 git worktree remove）
        fs.rmSync(wt.dir, { recursive: true, force: true });
      }
      if (fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true });
      removed++;
      lines.push(`已回收: ${wt.dir}`);
    } catch (err) {
      log.debug(`[cleanup] 回收失败详情: ${wt.dir} (${String(err)})`);
      lines.push(`回收失败（跳过）: ${wt.dir} (${String(err)})`);
    }
  }

  const summary = `共回收 ${removed} 个不活跃 worktree${lines.length ? "\n" + lines.join("\n") : ""}`;
  log.info(`[cleanup] ${summary}`);
  return summary;
}

/** 前缀比较 + 路径分隔符边界，防止 /a/foo 与 /a/foobar 误判 */
function isInside(candidate: string, container: string): boolean {
  const resolved = path.resolve(candidate);
  const base = path.resolve(container);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}
