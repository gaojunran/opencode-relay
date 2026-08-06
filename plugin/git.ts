import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RelayLogger } from "./config.js";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
}

/** 执行 git 命令（execFileSync，无 shell 拼接）；失败时抛出带 stderr 的 Error */
export function execGit(
  args: string[],
  opts: { cwd?: string } = {},
  logger?: RelayLogger,
): string {
  logger?.debug(`[git] ${args.join(" ")} (cwd: ${opts.cwd ?? process.cwd()})`);
  try {
    const out = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8" }).trim();
    logger?.debug(`[git] 输出: ${out.length > 200 ? out.slice(0, 200) + "…" : out}`);
    return out;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const detail =
      typeof e.stderr === "string"
        ? e.stderr.trim()
        : (e.stderr?.toString().trim() ?? e.message ?? "git 命令执行失败");
    logger?.debug(`[git] 失败: ${detail}`);
    throw new Error(`git ${args[0]} 失败: ${detail}`);
  }
}

/** 无条件创建独立 worktree：git worktree add --no-checkout -b <branch> <dir> <repo HEAD>，随后 reset 物化工作区文件 */
export function createWorktree(
  opts: {
    repoPath: string;
    worktreeDir: string;
    branch: string;
  },
  logger?: RelayLogger,
): void {
  fs.mkdirSync(path.dirname(opts.worktreeDir), { recursive: true });
  execGit(
    ["worktree", "add", "--no-checkout", "-b", opts.branch, opts.worktreeDir, "HEAD"],
    { cwd: opts.repoPath },
    logger,
  );
  // --no-checkout 后工作区为空（仅 .git），reset --hard 物化文件（对齐 opencode worktree/index.ts:237 原生流程）
  execGit(["reset", "--hard", "HEAD"], { cwd: opts.worktreeDir }, logger);
}

/** 解析 git worktree list --porcelain 输出 */
export function listWorktrees(repoPath: string): WorktreeEntry[] {
  const out = execGit(["worktree", "list", "--porcelain"], { cwd: repoPath });
  if (!out) return [];
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\n+/)) {
    let entryPath: string | undefined;
    let branch: string | null = null;
    let head = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entryPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch "))
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
    }
    if (entryPath) entries.push({ path: entryPath, branch, head });
  }
  return entries;
}

/** 在 repoPath 的 worktree 列表中查找指定目录，未注册返回 null */
export function findWorktree(repoPath: string, worktreeDir: string): WorktreeEntry | null {
  const resolved = path.resolve(worktreeDir);
  return listWorktrees(repoPath).find((w) => path.resolve(w.path) === resolved) ?? null;
}

/** 回收 worktree 目录（P3，7 天不活跃清理）：git worktree remove --force，随后可同步删除对应 state 文件 */
export function removeWorktree(repoPath: string, worktreeDir: string, logger?: RelayLogger): void {
  execGit(["worktree", "remove", "--force", worktreeDir], { cwd: repoPath }, logger);
  if (fs.existsSync(worktreeDir)) {
    // git worktree remove 通常已删除目录；残留时兜底清理（--force 下目录内未跟踪文件可能残留）
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

/** 列出 worktree_root 下所有 worktree 目录（含已存在但 git 未注册的孤儿目录） */
export function findWorktreeDirs(worktreeRoot: string): { project: string; dir: string }[] {
  if (!fs.existsSync(worktreeRoot)) return [];
  const out: { project: string; dir: string }[] = [];
  for (const project of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projDir = path.join(worktreeRoot, project.name);
    for (const wt of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      out.push({ project: project.name, dir: path.join(projDir, wt.name) });
    }
  }
  return out;
}
