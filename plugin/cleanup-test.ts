// P3a dedicated verification: stale worktree detection and reclaim (section 4.8 design)
// Creates one old and one new worktree, verifying cleanupStaleWorktrees reclaims only the old one,
// keeps the new one, and deletes the matching state file.
import { createWorktree, findWorktreeDirs } from "./git.ts";
import { cleanupStaleWorktrees } from "./relay.ts";
import fs from "node:fs";
import path from "node:path";

const base = `/tmp/relay-cleanup-${Date.now()}`;
const home = path.join(base, "home");
const repoPath = path.join(base, "projA");
const worktreeRoot = path.join(base, "home", ".opencode", "worktrees", "projA");
const stateDir = path.join(base, "home", ".opencode", "state");

function run(cmd: string): void {
  const { execSync } = require("node:child_process");
  execSync(cmd, { stdio: "pipe" });
}

try {
  // Prepare the test repo
  fs.mkdirSync(repoPath, { recursive: true });
  run(`cd ${repoPath} && git init -q && git config user.email t@t && git config user.name t && echo hello > README.md && git add . && git commit -qm init`);

  // Create an old and a new worktree
  const oldDir = path.join(worktreeRoot, "sesold123");
  const newDir = path.join(worktreeRoot, "sesnew456");
  createWorktree({ repoPath, worktreeDir: oldDir, branch: "opencode/sesold123" });
  createWorktree({ repoPath, worktreeDir: newDir, branch: "opencode/sesnew456" });

  // Set the old worktree mtime to 8 days ago (simulating inactivity)
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldDir, new Date(cutoff), new Date(cutoff));

  // Write two state files (simulating session states)
  const oldState = path.join(stateDir, "sesold123.json");
  const newState = path.join(stateDir, "sesnew456.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(oldState, JSON.stringify({ project_id: "projA", workdir: oldDir }));
  fs.writeFileSync(newState, JSON.stringify({ project_id: "projA", workdir: newDir }));

  // Config: stale_days = 7
  const config = {
    paths: { worktree_root: path.join(base, "home", ".opencode", "worktrees"), state_dir: stateDir },
    projects: { items: [{ id: "projA", name: "projA", repo_path: repoPath }], scan_dir: "" },
    worktree: { stale_days: 7, branch_prefix: "opencode/", end_of_session: "keep", remote: "origin" },
  } as any;
  const log = { debug: () => {}, info: (...a: unknown[]) => console.log("[relay]", ...a), warn: () => {}, error: () => {} } as any;

  console.log("== worktree count before cleanup ==");
  console.log(findWorktreeDirs(config.paths.worktree_root).length, "worktrees");

  // dry-run
  console.log("\n== dry-run ==");
  const dry = cleanupStaleWorktrees(config, log, true);
  console.log(dry);
  const afterDry = findWorktreeDirs(config.paths.worktree_root).length;
  console.log(`after dry-run still ${afterDry} worktrees (nothing deleted) ✓`, afterDry === 2 ? "" : "FAIL");

  // Actual cleanup
  console.log("\n== actual cleanup ==");
  const res = cleanupStaleWorktrees(config, log, false);
  console.log(res);
  const after = findWorktreeDirs(config.paths.worktree_root).length;
  console.log(`after cleanup ${after} worktrees`);
  if (after !== 1) throw new Error(`expected 1 (the new one), got ${after}`);

  // Verify: the old one is deleted (dir + git metadata + state), the new one is kept
  if (fs.existsSync(oldDir)) throw new Error("old worktree dir not deleted!");
  if (fs.existsSync(oldState)) throw new Error("old state file not deleted!");
  if (!fs.existsSync(newDir)) throw new Error("new worktree wrongly deleted!");
  if (!fs.existsSync(newState)) throw new Error("new state wrongly deleted!");
  const registered = findWorktreeDirs(config.paths.worktree_root).map((w) => w.dir);
  if (registered.includes(oldDir)) throw new Error("old worktree git registration not cleared!");

  // git worktree list only has the main repo
  const list = require("node:child_process").execSync(`git -C ${repoPath} worktree list --porcelain`, { encoding: "utf8" });
  if (!list.includes("sesnew456")) throw new Error("new worktree not in git registry!");
  if (list.includes("sesold123")) throw new Error("old worktree still in git registry!");

  console.log("\n✅ P3a cleanup verification passed: only the 8-day-inactive old worktree reclaimed, new worktree and states kept, git metadata cleaned");
} finally {
  try {
    require("node:child_process").execSync(`rm -rf ${base}`);
  } catch {}
}
