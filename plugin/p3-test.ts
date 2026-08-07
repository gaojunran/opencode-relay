// P3 dedicated verification: multi-session state isolation + end_of_session dispose strategies
// Run: bun run p3-test.ts
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
template = "Current project: {project_id}, workdir: {workdir}, branch: {branch}"
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

  // ---- 1. Both sessions switch to projA, producing isolated worktrees and states ----
  const r1 = await tools.switch_project.execute({ project_id: "projA" }, ctxA);
  if (!JSON.stringify(r1).includes("projA")) return fail("session A switch_project", String(r1));
  const s1 = readSessionState(loadConfig(), "ses_aaa111");

  const r2 = await tools.switch_project.execute({ project_id: "projA" }, ctxB);
  if (!JSON.stringify(r2).includes("projA")) return fail("session B switch_project", String(r2));
  const s2 = readSessionState(loadConfig(), "ses_bbb222");

  if (!s1 || !s2) return fail("session state read", `s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
  if (s1.workdir === s2.workdir) fail("two-session workdir isolation", `same: ${s1.workdir}`);
  else ok("multi-session workdir isolation (each session has its own worktree)");
  if (s1.worktree_branch === s2.worktree_branch) fail("two-session branch isolation", s1.worktree_branch);
  else ok(`multi-session branch isolation (${s1.worktree_branch} vs ${s2.worktree_branch})`);

  // Session A reuses its own created worktree, unaffected by session B
  const r1again = await tools.switch_project.execute({ project_id: "projA" }, ctxA);
  if (!JSON.stringify(r1again).includes("projA")) return fail("session A reuse call", String(r1again));
  const s1b = readSessionState(loadConfig(), "ses_aaa111");
  if (s1b?.workdir !== s1.workdir) fail("session A reuses its own worktree", `${s1b?.workdir} != ${s1.workdir}`);
  else ok("session A reuses its own worktree (unaffected by session B)");

  // ---- 2. Before dispose, check the worktree count (listWorktrees includes the main-dir entry), verifying the cleanup branch can delete ----
  const wtsBefore = listWorktrees(repoDir);
  if (wtsBefore.length !== 3) fail("worktree count before dispose (should be main dir + 2 sessions)", `got ${wtsBefore.length}`);
  else ok(`3 entries exist before dispose (${wtsBefore.map((w) => w.branch).join(", ")})`);

  // Simulate the cleanup branch of handleEndOfSession: delete session B's worktree + its state file
  try {
    removeWorktree(repoDir, s2.workdir);
    const stateFile = path.join(loadConfig().paths.state_dir, "sesbbb222.json");
    if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
    ok(`cleanup branch: worktree removed (${s2.workdir})`);
  } catch (e) {
    fail("cleanup branch delete worktree", String(e));
  }

  const wtsAfter = listWorktrees(repoDir);
  if (wtsAfter.length !== 2) fail("worktree count after cleanup (should be main dir + session A)", `got ${wtsAfter.length}`);
  else ok("2 entries after cleanup (session B reclaimed, session A kept)");

  // ---- 3. The dispose hook itself can be invoked without throwing ----
  try {
    await hooks.dispose?.();
    ok("dispose hook can be safely invoked");
  } catch (e) {
    fail("dispose hook", String(e));
  }

  // ---- 4. Push strategy: after renaming the branch inside the worktree, dispose pushes the CURRENT branch ----
  const bareDir = path.join(T, "bare.git");
  execFileSync("git", ["init", "--bare", "-q", bareDir]);
  execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: repoDir });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: repoDir });

  const conf2 = conf.replace('end_of_session = "cleanup"', 'end_of_session = "push"');
  fs.writeFileSync(path.join(configDir, "config2.toml"), conf2);
  process.env.OPENCODE_RELAY_CONFIG = path.join(configDir, "config2.toml");
  resetConfig();
  const hooks2 = await plugin.server({ directory: home } as never);
  const ctxC = { sessionID: "ses_ccc333", directory: home } as never;
  const r3 = await hooks2.tool!.switch_project.execute({ project_id: "projA" }, ctxC);
  if (!JSON.stringify(r3).includes("projA")) return fail("session C switch_project", String(r3));
  const s3 = readSessionState(loadConfig(), "ses_ccc333");
  if (!s3) return fail("session C state", "missing");
  ok(`session C switched (${s3.workdir})`);

  const oldBranch = s3.worktree_branch;
  const newBranch = "feat/add-auth";
  execFileSync("git", ["branch", "-m", newBranch], { cwd: s3.workdir });
  ok(`branch renamed in worktree (${oldBranch} -> ${newBranch})`);

  await hooks2.dispose?.();
  const remoteBranches = execFileSync("git", ["ls-remote", "--heads", bareDir], { encoding: "utf8" });
  if (remoteBranches.includes(`refs/heads/${newBranch}`) && !remoteBranches.includes(`refs/heads/${oldBranch}`)) {
    ok(`dispose push pushed the renamed branch, not the recorded one (${newBranch})`);
  } else {
    fail("dispose push current branch", `remote has: ${remoteBranches.trim() || "(empty)"}`);
  }

  if (failed > 0) {
    console.log(`\n✗ P3 verification failed ${failed} items`);
    process.exitCode = 1;
  } else {
    console.log("\n✅ P3 all verifications passed");
  }
  fs.rmSync(T, { recursive: true, force: true });
}

await main();
