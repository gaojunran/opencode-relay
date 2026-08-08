import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RelayLogger } from "./config.js";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
}

/** Run a git command (execFileSync, no shell concatenation); throws an Error with stderr on failure */
export function execGit(
  args: string[],
  opts: { cwd?: string } = {},
  logger?: RelayLogger,
): string {
  logger?.debug("git", `exec: ${args.join(" ")} (cwd: ${opts.cwd ?? process.cwd()})`);
  try {
    // stdio: ["ignore","pipe","pipe"] so git's stderr (e.g. "Preparing worktree...")
    // is captured instead of leaking to this process's stderr, which cc-connect reads
    // as an agent process error.
    const out = execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    logger?.debug("git", `output: ${out.length > 200 ? out.slice(0, 200) + "..." : out}`);
    return out;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const detail =
      typeof e.stderr === "string"
        ? e.stderr.trim()
        : (e.stderr?.toString().trim() ?? e.message ?? "git command failed");
    logger?.debug("git", `failure: ${detail}`);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

/** Unconditionally create an isolated worktree: git worktree add --no-checkout -b <branch> <dir> <baseRef>, then reset to materialize the working tree */
export function createWorktree(
  opts: {
    repoPath: string;
    worktreeDir: string;
    branch: string;
    /** Base ref the new branch is forked from; defaults to the main copy's HEAD */
    baseRef?: string;
  },
  logger?: RelayLogger,
): void {
  fs.mkdirSync(path.dirname(opts.worktreeDir), { recursive: true });
  const baseRef = opts.baseRef ?? "HEAD";
  execGit(
    ["worktree", "add", "--no-checkout", "-b", opts.branch, opts.worktreeDir, baseRef],
    { cwd: opts.repoPath },
    logger,
  );
  // After --no-checkout the worktree is empty (only .git); reset --hard materializes files
  // (aligned with the native flow in opencode worktree/index.ts:237)
  execGit(["reset", "--hard", baseRef], { cwd: opts.worktreeDir }, logger);
}

/** Current branch checked out in a worktree (empty string when detached); null when the dir is not a git worktree */
export function currentBranch(workdir: string, logger?: RelayLogger): string | null {
  try {
    const out = execGit(["branch", "--show-current"], { cwd: workdir }, logger);
    return out || null;
  } catch {
    return null;
  }
}

/** Parse `git worktree list --porcelain` output */
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

/** Find a directory in the repo's worktree list; returns null when not registered */
export function findWorktree(repoPath: string, worktreeDir: string): WorktreeEntry | null {
  const resolved = path.resolve(worktreeDir);
  return listWorktrees(repoPath).find((w) => path.resolve(w.path) === resolved) ?? null;
}

/** Reclaim a worktree dir (P3, reclaim inactive after 7 days): git worktree remove --force, then optionally delete the matching state file */
export function removeWorktree(repoPath: string, worktreeDir: string, logger?: RelayLogger): void {
  execGit(["worktree", "remove", "--force", worktreeDir], { cwd: repoPath }, logger);
  if (fs.existsSync(worktreeDir)) {
    // git worktree remove usually deletes the dir; fall back to rm for leftovers
    // (untracked files inside may remain even with --force)
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

/** List all worktree dirs under worktree_root (includes orphan dirs that exist but are not git-registered) */
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
