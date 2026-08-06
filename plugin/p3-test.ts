// P3 专项验证：多会话状态隔离 + end_of_session dispose 策略
// 运行: bun run p3-test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, resetConfig } from "./config.js";
import { listWorktrees, removeWorktree } from "./git.js";
import { readSessionState } from "./state.js";

async function main() {
  const T = path.join(os.tmpdir(), `relay-p3-${Date.now()}`);
  const home = path.join(T, "home");
  const repoDir = path.join(T, "projA");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir });

  const configDir = path.join(T, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const conf = `[general]
home = "${home}"
[paths]
workspace_root = "${T}"
worktree_root = "${home}/.opencode/worktrees"
state_dir = "${home}/.opencode/state"
[projects]
[[projects.items]]
id = "projA"
name = "projA"
repo_path = "${repoDir}"
[worktree]
branch_prefix = "opencode/"
end_of_session = "cleanup"
remote = "origin"
stale_days = 7
[inject]
enabled = true
template = "当前项目: {project_id}，工作目录: {workdir}，分支: {branch}"
[guard]
enabled = true
reject_on_violation = true
deny_paths = []
allow_paths = []
[permissions]
enabled = false
rules = []
[list]
include_description = false
`;
  fs.writeFileSync(path.join(configDir, "config.toml"), conf);
  process.env.OPENCODE_RELAY_CONFIG = path.join(configDir, "config.toml");

  resetConfig();
  const { default: plugin } = await import("./relay.ts");
  const hooks = await plugin.server({ directory: home } as never);

  let failed = 0;
  function ok(name: string) {
    console.log(`✓ ${name}`);
  }
  function fail(name: string, why: string) {
    console.log(`✗ ${name}: ${why}`);
    failed++;
  }

  const ctxA = { sessionID: "ses_aaa111", directory: home } as never;
  const ctxB = { sessionID: "ses_bbb222", directory: home } as never;
  const tools = hooks.tool!;

  // ---- 1. 两个会话各自 switch 到 projA，产生独立 worktree 与 state ----
  const r1 = await tools.switch_project.execute({ project_id: "projA" }, ctxA);
  if (!JSON.stringify(r1).includes("projA")) return fail("会话A switch_project", String(r1));
  const s1 = readSessionState(loadConfig(), "ses_aaa111");

  const r2 = await tools.switch_project.execute({ project_id: "projA" }, ctxB);
  if (!JSON.stringify(r2).includes("projA")) return fail("会话B switch_project", String(r2));
  const s2 = readSessionState(loadConfig(), "ses_bbb222");

  if (!s1 || !s2) return fail("会话状态读取", `s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
  if (s1.workdir === s2.workdir) fail("两会话 workdir 隔离", `相同: ${s1.workdir}`);
  else ok("多会话 workdir 隔离（各会话独立 worktree）");
  if (s1.worktree_branch === s2.worktree_branch) fail("两会话分支隔离", s1.worktree_branch);
  else ok(`多会话分支隔离 (${s1.worktree_branch} vs ${s2.worktree_branch})`);

  // 会话A 复用自己已创建的 worktree，不受会话B 影响
  const r1again = await tools.switch_project.execute({ project_id: "projA" }, ctxA);
  if (!JSON.stringify(r1again).includes("projA")) return fail("会话A 复用调用", String(r1again));
  const s1b = readSessionState(loadConfig(), "ses_aaa111");
  if (s1b?.workdir !== s1.workdir) fail("会话A 复用自身 worktree", `${s1b?.workdir} != ${s1.workdir}`);
  else ok("会话A 复用自身 worktree（不受会话B 干扰）");

  // ---- 2. dispose 前检查 worktree 数量（listWorktrees 含主目录条目），验证 cleanup 分支的删除能力 ----
  const wtsBefore = listWorktrees(repoDir);
  if (wtsBefore.length !== 3) fail("dispose 前 worktree 数（应为主目录 + 2 会话）", `got ${wtsBefore.length}`);
  else ok(`dispose 前 3 个条目存在 (${wtsBefore.map((w) => w.branch).join(", ")})`);

  // 模拟 handleEndOfSession 的 cleanup 分支：删除会话B 的 worktree + 同步删 state
  try {
    removeWorktree(repoDir, s2.workdir);
    const stateFile = path.join(loadConfig().paths.state_dir, "sesbbb222.json");
    if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
    ok(`cleanup 分支: worktree 已删除 (${s2.workdir})`);
  } catch (e) {
    fail("cleanup 分支删除 worktree", String(e));
  }

  const wtsAfter = listWorktrees(repoDir);
  if (wtsAfter.length !== 2) fail("cleanup 后 worktree 数（应为主目录 + 会话A）", `got ${wtsAfter.length}`);
  else ok("cleanup 后剩 2 个条目（会话B 的已回收，会话A 的保留）");

  // ---- 3. dispose hook 自身可被调用且不抛错 ----
  try {
    await hooks.dispose?.();
    ok("dispose hook 可安全调用");
  } catch (e) {
    fail("dispose hook", String(e));
  }

  if (failed > 0) {
    console.log(`\n✗ P3 验证失败 ${failed} 项`);
    process.exitCode = 1;
  } else {
    console.log("\n✅ P3 验证全部通过");
  }
  fs.rmSync(T, { recursive: true, force: true });
}

await main();
