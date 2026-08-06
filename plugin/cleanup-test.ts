// P3a 专项验证：stale worktree 检测与回收（4.8 节设计）
// 创建一旧一新两个 worktree，验证 cleanupStaleWorktrees 只回收旧的、保留新的，且 state 同步删除
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
  // 准备测试仓库
  fs.mkdirSync(repoPath, { recursive: true });
  run(`cd ${repoPath} && git init -q && git config user.email t@t && git config user.name t && echo hello > README.md && git add . && git commit -qm init`);

  // 创建新旧两个 worktree
  const oldDir = path.join(worktreeRoot, "sesold123");
  const newDir = path.join(worktreeRoot, "sesnew456");
  createWorktree({ repoPath, worktreeDir: oldDir, branch: "opencode/sesold123" });
  createWorktree({ repoPath, worktreeDir: newDir, branch: "opencode/sesnew456" });

  // 把旧 worktree 的 mtime 改成 8 天前（模拟不活跃）
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldDir, new Date(cutoff), new Date(cutoff));

  // 写两个 state 文件（模拟会话状态）
  const oldState = path.join(stateDir, "sesold123.json");
  const newState = path.join(stateDir, "sesnew456.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(oldState, JSON.stringify({ project_id: "projA", workdir: oldDir }));
  fs.writeFileSync(newState, JSON.stringify({ project_id: "projA", workdir: newDir }));

  // 配置：stale_days = 7
  const config = {
    paths: { worktree_root: path.join(base, "home", ".opencode", "worktrees"), state_dir: stateDir },
    projects: { items: [{ id: "projA", name: "projA", repo_path: repoPath }], scan_dir: "" },
    worktree: { stale_days: 7, branch_prefix: "opencode/", end_of_session: "keep", remote: "origin" },
  } as any;
  const log = { debug: () => {}, info: (...a: unknown[]) => console.log("[relay]", ...a), warn: () => {}, error: () => {} } as any;

  console.log("== 清理前 worktree 数 ==");
  console.log(findWorktreeDirs(config.paths.worktree_root).length, "个");

  // dry-run
  console.log("\n== dry-run ==");
  const dry = cleanupStaleWorktrees(config, log, true);
  console.log(dry);
  const afterDry = findWorktreeDirs(config.paths.worktree_root).length;
  console.log("dry-run 后仍", afterDry, "个（不删）✓", afterDry === 2 ? "" : "FAIL");

  // 正式清理
  console.log("\n== 正式清理 ==");
  const res = cleanupStaleWorktrees(config, log, false);
  console.log(res);
  const after = findWorktreeDirs(config.paths.worktree_root).length;
  console.log("清理后", after, "个");
  if (after !== 1) throw new Error(`应剩 1 个（新的），实际 ${after}`);

  // 验证：旧的被删（目录 + git 元数据 + state），新的保留
  if (fs.existsSync(oldDir)) throw new Error("旧 worktree 目录未删除!");
  if (fs.existsSync(oldState)) throw new Error("旧 state 文件未删除!");
  if (!fs.existsSync(newDir)) throw new Error("新 worktree 被误删!");
  if (!fs.existsSync(newState)) throw new Error("新 state 被误删!");
  const registered = findWorktreeDirs(config.paths.worktree_root).map((w) => w.dir);
  if (registered.includes(oldDir)) throw new Error("旧 worktree git 注册未清除!");

  // git worktree list 只剩主仓库
  const list = require("node:child_process").execSync(`git -C ${repoPath} worktree list --porcelain`, { encoding: "utf8" });
  if (!list.includes("sesnew456")) throw new Error("新 worktree 未在 git 注册表中!");
  if (list.includes("sesold123")) throw new Error("旧 worktree 仍在 git 注册表!");

  console.log("\n✅ P3a cleanup 验证全部通过：仅回收 8 天不活跃的旧 worktree，新 worktree 与 state 保留，git 元数据清理干净");
} finally {
  try {
    require("node:child_process").execSync(`rm -rf ${base}`);
  } catch {}
}
