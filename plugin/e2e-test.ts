// P1 end-to-end verification script (throwaway): loads the plugin module directly and runs real git scenarios
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { resetConfig } from "./config.js"
import { createLogger } from "./config.js"

const R = `/tmp/relay-e2e-${Date.now()}`
const home = path.join(R, "home")
const configDir = path.join(home, ".config", "opencode-relay")
const workspaceRoot = path.join(home, "workspace")
const repoPath = path.join(workspaceRoot, "projA")
const worktreeRoot = path.join(home, ".opencode", "worktrees")
const stateDir = path.join(home, ".opencode", "state")
fs.mkdirSync(path.join(configDir), { recursive: true })
fs.mkdirSync(repoPath, { recursive: true })

// Create the main-copy git repo
execFileSync("git", ["init", "-q"], { cwd: repoPath })
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoPath })
execFileSync("git", ["config", "user.name", "t"], { cwd: repoPath })
fs.writeFileSync(path.join(repoPath, "README.md"), "hello projA\n")
// Commit project-level instructions and a skill so the worktree checkout carries them
fs.writeFileSync(
  path.join(repoPath, "AGENTS.md"),
  "# projA AGENTS\n\nThis project prefers TypeScript. Run tests with `bun test`.\n",
)
fs.mkdirSync(path.join(repoPath, ".opencode", "skills", "proj-build"), { recursive: true })
fs.writeFileSync(
  path.join(repoPath, ".opencode", "skills", "proj-build", "SKILL.md"),
  "---\nname: proj-build\ndescription: Build projA with bun build\n---\n\nRun `bun run build`.\n",
)
execFileSync("git", ["add", "."], { cwd: repoPath })
execFileSync("git", ["commit", "-qm", "init"], { cwd: repoPath })
// Create a dev branch one commit ahead of the default branch, so base_branch fork
// points become observable: a worktree forked from "dev" contains dev.txt, one forked
// from the default HEAD does not.
execFileSync("git", ["checkout", "-qb", "dev"], { cwd: repoPath })
fs.writeFileSync(path.join(repoPath, "dev.txt"), "dev marker\n")
execFileSync("git", ["add", "."], { cwd: repoPath })
execFileSync("git", ["commit", "-qm", "dev"], { cwd: repoPath })
execFileSync("git", ["checkout", "-q", "-"], { cwd: repoPath })

// Write the test config
const conf = `[general]
home = "${home}"
[paths]
workspace_root = "${workspaceRoot}"
worktree_root = "${worktreeRoot}"
state_dir = "${stateDir}"
[projects]
[[projects.items]]
id = "projA"
name = "projA"
repo_path = "${repoPath}"
# base_branch fork-point tests: same repo, different fork bases
[[projects.items]]
id = "projBase"
name = "projBase"
repo_path = "${repoPath}"
base_branch = "dev"
[[projects.items]]
id = "projBaseCmd"
name = "projBaseCmd"
repo_path = "${repoPath}"
base_branch = { command = "echo dev" }
[[projects.items]]
id = "projBaseFail"
name = "projBaseFail"
repo_path = "${repoPath}"
base_branch = { command = "exit 3" }
# fetch + semver base_branch tests
[[projects.items]]
id = "projSemver"
name = "projSemver"
repo_path = "${repoPath}"
base_branch = { command = "git for-each-ref refs/remotes/origin/ --format='%(refname:short)' | grep -E '^origin/v[0-9]+(\\\\.[0-9]+){1,2}$' | sort -V | tail -1" }
[[projects.items]]
id = "projNoFetch"
name = "projNoFetch"
repo_path = "${repoPath}"
base_branch = "dev"
fetch = false
[[projects.items]]
id = "projBaseCmd"
name = "projBaseCmd"
repo_path = "${repoPath}"
base_branch = { command = "echo dev" }
[[projects.items]]
id = "projBaseFail"
name = "projBaseFail"
repo_path = "${repoPath}"
base_branch = { command = "false" }
[worktree]
branch_prefix = "opencode/"
end_of_session = "keep"
on_switch = ["echo PROJ_ENV_VAR=from-on-switch", "echo SECOND_ENV_VAR=from-second-cmd"]
[inject]
enabled = true
template = "Current project: {project_name} ({project_id}), workdir: {workdir}, branch: {branch}."
[guard]
enabled = true
reject_on_violation = true
# The test environment itself lives under /tmp; keep allow_dirs empty here so the
# worktree boundary checks stay meaningful (allow_dirs is exercised separately below).
allow_dirs = []
`
fs.writeFileSync(path.join(configDir, "config.toml"), conf)
process.env.OPENCODE_RELAY_CONFIG = path.join(configDir, "config.toml")

// Load the plugin
const mod = await import("./relay.ts")
const plugin = mod.default
const hooks = await plugin.server({ directory: home, project: { id: "relay-test", directory: home } } as any)

// 1. list_project
const listOut = await hooks.tool!.list_project!.execute({}, { sessionID: "ses_abc123xyz", directory: home } as any)
console.log("== list_project ==")
console.log(typeof listOut === "string" ? listOut : listOut.output)
if (JSON.stringify(listOut).includes(repoPath)) throw new Error("list_project leaked repo_path!")

// 2. switch_project first creation
const sw = await hooks.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
console.log("\n== switch_project first time ==")
const swObj = typeof sw === "string" ? JSON.parse(sw) : JSON.parse(sw.output)
console.log(JSON.stringify(swObj, null, 2))
const workdir = swObj.workdir
if (!fs.existsSync(workdir)) throw new Error("worktree dir does not exist")
if (!fs.existsSync(path.join(workdir, "README.md"))) throw new Error("worktree files not materialized!")
console.log("worktree files materialized: README.md exists ✓")

// 3. State file written (filename sanitized via sanitizeSessionID: underscore stripped)
const stateFile = path.join(stateDir, "sesabc123xyz.json")
if (!fs.existsSync(stateFile)) throw new Error("state file not written")
console.log("state file: " + stateFile)

// 4. Reuse within the session (second switch does not recreate)
fs.writeFileSync(path.join(workdir, "README.md"), "modified by agent\n")
const sw2 = await hooks.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
const sw2Obj = typeof sw2 === "string" ? JSON.parse(sw2) : JSON.parse(sw2.output)
console.log("\n== switch_project second time (reuse) ==")
console.log(JSON.stringify(sw2Obj, null, 2))
if (sw2Obj.workdir !== workdir) throw new Error("reuse failed: workdir changed")
if (!fs.readFileSync(path.join(workdir, "README.md"), "utf8").includes("modified")) throw new Error("reuse failed: workspace was reset")
console.log("reuse succeeded, workspace changes kept ✓")

// 5. tool.execute.before interception
console.log("\n== guard interception tests ==")
// 5a. bash workdir out of bounds
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c1" }, { args: { command: "ls", workdir: "/etc" } })
  throw new Error("bash out-of-bounds not intercepted!")
} catch (e) {
  console.log("bash /etc out of bounds → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// 5b. bash without workdir: cannot probe intent, so the workdir is auto-set to the worktree (allowed)
{
  const output: { args: Record<string, unknown> } = { args: { command: "ls" } }
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c2" }, output)
  if (output.args.workdir !== workdir) throw new Error("bash without workdir was not defaulted to the worktree")
  console.log("bash without workdir → auto-set to worktree, allowed ✓")
}
// 5b2. read relative path inside the worktree is resolved against the worktree and rewritten to absolute
{
  const output: { args: Record<string, unknown> } = { args: { filePath: "README.md" } }
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c2b" }, output)
  if (output.args.filePath !== path.join(workdir, "README.md")) {
    throw new Error(`read relative path not rewritten: ${output.args.filePath}`)
  }
  console.log("read relative path → resolved against worktree & rewritten ✓")
}
// 5b3. read relative path escaping the worktree is rejected
try {
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c2c" }, { args: { filePath: "../../etc/passwd" } })
  throw new Error("read escaping relative path not intercepted!")
} catch (e) {
  console.log("read escaping relative path → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// 5c. read absolute path out of bounds
try {
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c3" }, { args: { filePath: "/etc/passwd" } })
  throw new Error("read out-of-bounds not intercepted!")
} catch (e) {
  console.log("read /etc/passwd → rejected ✓")
}
// 5c2. write absolute path out of bounds (param name filePath with capital P)
try {
  await hooks["tool.execute.before"]!({ tool: "write", sessionID: "ses_abc123xyz", callID: "c9" }, { args: { filePath: "/etc/pwned.txt", content: "x" } })
  throw new Error("write out-of-bounds not intercepted!")
} catch (e) {
  console.log("write /etc/pwned.txt → rejected ✓")
}
// 5c3. edit relative path out of bounds (resolved to instanceDir=home, main copy is under home)
try {
  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "ses_abc123xyz", callID: "c10" }, { args: { filePath: path.join(workspaceRoot, "projA", "README.md") } })
  throw new Error("edit main-copy path not intercepted!")
} catch (e) {
  console.log("edit main-copy path → rejected ✓")
}
// 5c4. apply_patch out of bounds (Update File inside patchText points outside home)
try {
  await hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "ses_abc123xyz", callID: "c11" }, { args: { patchText: "*** Begin Patch\n*** Update File: /etc/passwd\n@@ context\n*** End Patch" } })
  throw new Error("apply_patch out-of-bounds not intercepted!")
} catch (e) {
  console.log("apply_patch /etc/passwd → rejected ✓")
}
// 5c5. grep search dir out of bounds
try {
  await hooks["tool.execute.before"]!({ tool: "grep", sessionID: "ses_abc123xyz", callID: "c12" }, { args: { pattern: "x", path: "/etc" } })
  throw new Error("grep path out-of-bounds not intercepted!")
} catch (e) {
  console.log("grep path=/etc → rejected ✓")
}
// 5d. In-workdir operations pass
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c4" }, { args: { command: "ls", workdir } })
console.log("bash workdir=worktree → allowed ✓")
await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c5" }, { args: { filePath: path.join(workdir, "README.md") } })
console.log("read absolute path inside worktree → allowed ✓")
await hooks["tool.execute.before"]!({ tool: "write", sessionID: "ses_abc123xyz", callID: "c13" }, { args: { filePath: path.join(workdir, "new.txt"), content: "x" } })
console.log("write absolute path inside worktree → allowed ✓")
// 5d2. bash cd escapes: absolute path out of worktree → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c14" }, { args: { command: "cd /etc && ls", workdir } })
  throw new Error("bash cd escape not intercepted!")
} catch (e) {
  console.log("bash cd /etc → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// 5d3. bash cd escapes: relative path resolving out of worktree → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c15" }, { args: { command: "cd .. && ls", workdir } })
  throw new Error("bash cd .. escape not intercepted!")
} catch (e) {
  console.log("bash cd .. → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// 5d4. bash bare cd (returns home) → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c16" }, { args: { command: "cd && pwd", workdir } })
  throw new Error("bash bare cd not intercepted!")
} catch (e) {
  console.log("bash bare cd → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// 5d5. bash cd to a subdir inside the worktree → allowed
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c17" }, { args: { command: "cd src && ls", workdir } })
console.log("bash cd src (inside worktree) → allowed ✓")

// 5e. deny_paths additional layer: a path inside the worktree but matching deny is rejected
// 5f. a non-deny path inside the worktree passes (verifies deny does not over-trigger)
const denyDir = path.join(workdir, "secret")
fs.mkdirSync(denyDir, { recursive: true })
// Config is read at server() time; write a new config with deny_paths and reload the plugin
const conf2 = conf + `deny_paths = ["${denyDir}/**"]\n`
fs.writeFileSync(path.join(configDir, "config.toml"), conf2)
resetConfig()
const hooks2 = await plugin.server({ directory: home, project: { id: "relay-test", directory: home } } as any)
// 5e: inside worktree but matching deny → rejected
try {
  await hooks2["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c7" }, { args: { filePath: path.join(denyDir, "x.txt") } })
  throw new Error("deny not effective")
} catch (e) {
  console.log(`read inside worktree but matching deny dir → rejected ✓: ${(e as Error).message.slice(0, 55)}`)
}
// 5f: inside worktree, not matching deny → allowed
await hooks2["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c8" }, { args: { filePath: path.join(workdir, "README.md") } })
console.log("read inside worktree, non-deny → allowed ✓")

// 5g. allow_dirs: a dedicated config with allow_dirs=["/tmp"] allows /tmp outside the worktree
const conf3 = conf2.replace("allow_dirs = []", 'allow_dirs = ["/tmp"]')
fs.writeFileSync(path.join(configDir, "config.toml"), conf3)
resetConfig()
const hooks3 = await plugin.server({ directory: home, project: { id: "relay-test", directory: home } } as any)
await hooks3["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c18" }, { args: { command: "ls", workdir: "/tmp" } })
console.log("bash workdir=/tmp (allow_dirs) → allowed ✓")
await hooks3["tool.execute.before"]!({ tool: "write", sessionID: "ses_abc123xyz", callID: "c19" }, { args: { filePath: "/tmp/relay-e2e-tmp.txt", content: "x" } })
console.log("write /tmp file (allow_dirs) → allowed ✓")
await hooks3["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c20" }, { args: { command: "cd /tmp && ls", workdir } })
console.log("bash cd /tmp (allow_dirs) → allowed ✓")

// 5h. Stateless session (no project switched): free in home, but the main copy is still denied.
// The default deny set (workspace_root/**) must apply even without a session state.
const statelessSid = "ses_fresh_nostate"
// bash workdir pointing at the main copy → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: statelessSid, callID: "c21" }, { args: { command: "ls", workdir: repoPath } })
  throw new Error("stateless bash workdir into main copy not intercepted!")
} catch (e) {
  console.log("stateless bash workdir=main copy → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// read a file in the main copy → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: statelessSid, callID: "c22" }, { args: { filePath: path.join(repoPath, "README.md") } })
  throw new Error("stateless read of main copy not intercepted!")
} catch (e) {
  console.log("stateless read main copy → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// write into the main copy → rejected
try {
  await hooks["tool.execute.before"]!({ tool: "write", sessionID: statelessSid, callID: "c23" }, { args: { filePath: path.join(repoPath, "pwn.txt"), content: "x" } })
  throw new Error("stateless write into main copy not intercepted!")
} catch (e) {
  console.log("stateless write main copy → rejected ✓: " + (e as Error).message.slice(0, 60))
}
// free in home: bash workdir anywhere in home (outside the main copy) → allowed
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: statelessSid, callID: "c24" }, { args: { command: "ls", workdir: home } })
console.log("stateless bash workdir=home → allowed ✓")
// read a home file outside the main copy → allowed
await hooks["tool.execute.before"]!({ tool: "read", sessionID: statelessSid, callID: "c25" }, { args: { filePath: path.join(home, "notes.txt") } })
console.log("stateless read home file → allowed ✓")

// 6. system.transform injection
const sysOut: { system: string[] } = { system: [] }
await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut)
console.log("\n== system.transform ==")
console.log(sysOut.system[0])
if (!sysOut.system[0].includes("projA") || !sysOut.system[0].includes(workdir)) throw new Error("injected content incomplete")

// 7. Sessions without a switched project are not intercepted
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_other", callID: "c6" }, { args: { command: "ls", workdir: "/etc" } })
console.log("\nsessions without a switched project are not intercepted ✓")

// 7b. Sessions without a switched project: system.transform injects the project list to guide switch
const sysOut2: { system: string[] } = { system: [] }
await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_other", model: {} as any }, sysOut2)
console.log("\n== system.transform no-project (list guidance) ==")
console.log(sysOut2.system[0])
const sysOut2Text = sysOut2.system.join("\n")
if (!sysOut2Text.includes("projA")) throw new Error("no-project session did not get the project list!")
if (!sysOut2Text.includes("switch_project")) throw new Error("list injection missing switch guidance!")
console.log("no-project session got project list + switch guidance ✓")

// 8. leave_project: back to no-project state, guard allows again, system.transform shows list again, worktree kept and reusable
console.log("\n== leave_project ==")
const lp = await hooks2.tool!.leave_project!.execute({}, { sessionID: "ses_abc123xyz", directory: home } as any)
const lpOut = typeof lp === "string" ? JSON.parse(lp) : JSON.parse(lp.output)
console.log(JSON.stringify(lpOut, null, 2))
if (lpOut.left_project !== "projA") throw new Error("leave_project returned wrong project")
if (!fs.existsSync(workdir)) throw new Error("leave_project should not delete the worktree!")
console.log("leave_project result + worktree preserved ✓")
// 8a. After leaving, guard allows (no-state session is not intercepted)
await hooks2["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c14" }, { args: { command: "ls", workdir: "/etc" } })
console.log("after leave, bash /etc → allowed (back to no-state) ✓")
// 8b. After leaving, system.transform restores list guidance
const sysOut3: { system: string[] } = { system: [] }
await hooks2["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut3)
if (!sysOut3.system.join("\n").includes("switch_project")) throw new Error("after leave, list guidance not restored!")
console.log("after leave, system.transform restores list guidance ✓")
// 8c. Switching again in the same session reuses the original worktree (state missing but dir registered)
const sw3 = await hooks2.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
const sw3Obj = typeof sw3 === "string" ? JSON.parse(sw3) : JSON.parse(sw3.output)
if (sw3Obj.workdir !== workdir) throw new Error("after leave, switch did not reuse the original worktree!")
console.log("after leave, switch → reused original worktree ✓")

// 9. register_project
console.log("\n== register_project ==")
const remoteRepo = path.join(R, "remote.git")
execFileSync("git", ["init", "--bare", "-q", remoteRepo])
const extRepo = path.join(R, "ext-repo")
fs.mkdirSync(extRepo, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: extRepo })
execFileSync("git", ["config", "user.email", "t@t"], { cwd: extRepo })
execFileSync("git", ["config", "user.name", "t"], { cwd: extRepo })
fs.writeFileSync(path.join(extRepo, "README.md"), "hello ext\n")
execFileSync("git", ["add", "."], { cwd: extRepo })
execFileSync("git", ["commit", "-qm", "init"], { cwd: extRepo })
execFileSync("git", ["branch", "-M", "main"], { cwd: extRepo })
execFileSync("git", ["remote", "add", "origin", remoteRepo], { cwd: extRepo })
execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: extRepo })

// 9a. register an external repo: moved into workspace_root, correct id returned
const reg = await hooks2.tool!.register_project!.execute({ dir: extRepo }, { sessionID: "ses_abc123xyz", directory: home } as any)
const regOut = typeof reg === "string" ? JSON.parse(reg) : JSON.parse(reg.output)
console.log(JSON.stringify(regOut, null, 2))
if (regOut.id !== "ext-repo") throw new Error("register_project returned wrong id")
if (regOut.repo_path !== path.join(workspaceRoot, "ext-repo")) throw new Error("register_project did not move into workspace_root")
if (!fs.existsSync(regOut.repo_path)) throw new Error("registered repo not found at target")
if (fs.existsSync(extRepo)) throw new Error("source dir not moved after registration")
console.log("external repo registered and moved into workspace_root ✓")

// 9b. a clone sharing the same remote must be rejected as a duplicate
const cloneRepo = path.join(R, "clone-repo")
execFileSync("git", ["clone", "-q", remoteRepo, cloneRepo])
let dupMsg = ""
try {
  await hooks2.tool!.register_project!.execute({ dir: cloneRepo }, { sessionID: "ses_abc123xyz", directory: home } as any)
} catch (e) {
  dupMsg = (e as Error).message
}
if (!dupMsg.includes("already registered")) throw new Error("duplicate remote registration was not rejected: " + dupMsg)
console.log("duplicate remote registration rejected ✓: " + dupMsg.slice(0, 70))

// 9c. PROJECT_GUIDE injection: both no-state and stateful outputs carry the guide
const sysOut4: { system: string[] } = { system: [] }
await hooks2["experimental.chat.system.transform"]!({ sessionID: "ses_fresh", model: {} as any }, sysOut4)
const guideNoState = sysOut4.system.join("\n")
if (!guideNoState.includes("always use switch_project")) throw new Error("no-state injection missing switch guidance!")
if (!guideNoState.includes("register_project")) throw new Error("no-state injection missing register_project guidance!")
console.log("no-state injection contains project guide ✓")
const sysOut5: { system: string[] } = { system: [] }
await hooks2["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut5)
const guideStateful = sysOut5.system.join("\n")
if (!guideStateful.includes("always use switch_project") || !guideStateful.includes("register_project")) throw new Error("stateful injection missing project guide!")
console.log("stateful injection contains project guide ✓")

// 9d. on_switch env capture + shell.env injection + worktree AGENTS.md/skill injection
console.log("\n== on_switch env + shell.env + AGENTS.md/skill injection ==")
// The test worktree was created after AGENTS.md/.opencode/skills were committed, so the
// worktree checkout carries them. After 8c the session state was rewritten by switchProject,
// which runs on_switch and stores its env dump in state.env.
const stateAfterSwitch = JSON.parse(fs.readFileSync(path.join(stateDir, "sesabc123xyz.json"), "utf8"))
if (!stateAfterSwitch.env || stateAfterSwitch.env.PROJ_ENV_VAR !== "from-on-switch" || stateAfterSwitch.env.SECOND_ENV_VAR !== "from-second-cmd") {
  throw new Error(`on_switch env not captured: ${JSON.stringify(stateAfterSwitch.env)}`)
}
console.log("on_switch env captured in session state ✓")
// shell.env hook injects the captured env on every bash spawn
const envOut: { env: Record<string, string> } = { env: {} }
await hooks2["shell.env"]!({ sessionID: "ses_abc123xyz", cwd: workdir, callID: "c31" }, envOut)
if (envOut.env.PROJ_ENV_VAR !== "from-on-switch" || envOut.env.SECOND_ENV_VAR !== "from-second-cmd") throw new Error("shell.env did not inject on_switch env!")
console.log("shell.env injects project env ✓")
// system.transform injects worktree AGENTS.md content
const sysOut6: { system: string[] } = { system: [] }
await hooks2["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut6)
const injectedText = sysOut6.system.join("\n")
if (!injectedText.includes("projA AGENTS")) throw new Error("worktree AGENTS.md not injected into system prompt!")
console.log("worktree AGENTS.md injected into system prompt ✓")
if (!injectedText.includes("proj-build")) throw new Error("project skill not injected into system prompt!")
console.log("project skill injected into system prompt ✓")

// 10. Debug logging hooks are registered and callable without throwing
// (experimental.text.complete / tool.execute.after / chat.message)
await hooks["experimental.text.complete"]!({ sessionID: "ses_abc123xyz", messageID: "m1", partID: "p1" }, { text: "hello from the model" })
console.log("experimental.text.complete callable ✓")
await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c30", args: { command: "ls" } }, { title: "ls", output: "README.md\nsrc", metadata: {} })
console.log("tool.execute.after callable ✓")
await hooks["chat.message"]!({ sessionID: "ses_abc123xyz", messageID: "m2" }, { message: {} as any, parts: [{ id: "p2", sessionID: "ses_abc123xyz", messageID: "m2", type: "text", text: "explain the codebase" }] })

// 9d. log_file writes to a daily-rotated file and keeps console tee
{
  const logDir = path.join(R, "logs")
  const logger = createLogger("debug", logDir)
  logger.info("plugin", "log-file test line")
  const files = fs.readdirSync(logDir)
  const day = new Date().toISOString().slice(0, 10)
  const logFile = path.join(logDir, `relay-${day}.log`)
  const content = fs.readFileSync(logFile, "utf8")
  const logfmtRe = /^ts=.* level=info logger=plugin msg="log-file test line"$/
  if (!files.some((f) => f.startsWith("relay-")) || !logfmtRe.test(content.trim()))
    throw new Error(`log_file did not write a logfmt entry, got: ${content.trim()}`)
  console.log("log_file daily file + console tee (logfmt) ✓")
}
console.log("chat.message callable ✓")

// 11. Subagent sessions cannot mutate project state; they inherit the parent's context
// (exp-6: task-created subagents are separate sessions linked via the DB parent_id; only the
// session.created event exposes parentID. State-mutating tools reject subagent calls, and the
// parent cannot switch while a subagent is active. Read path (guard/system.transform) still
// resolves to the root parent so subagents work inside the parent's worktree.)
{
  // Simulate the session.created event for a subagent of ses_abc123xyz
  await hooks.event!({
    event: {
      id: "evt-sub",
      type: "session.created",
      properties: { info: { id: "ses_child001", parentID: "ses_abc123xyz" } },
    },
  } as any)
  // Subagent switch_project must be rejected (parent-only)
  const swSub = await hooks.tool!.switch_project!.execute(
    { project_id: "projA" },
    { sessionID: "ses_child001", directory: home } as any,
  )
  const swSubText = typeof swSub === "string" ? swSub : swSub.output
  if (!swSubText.includes("Subagent sessions cannot switch")) throw new Error("subagent switch_project was not rejected!")
  console.log("subagent switch_project rejected ✓")
  // Subagent leave_project must be rejected
  const lvSub = await hooks.tool!.leave_project!.execute({}, { sessionID: "ses_child001", directory: home } as any)
  const lvSubText = typeof lvSub === "string" ? lvSub : lvSub.output
  if (!lvSubText.includes("Subagent sessions cannot leave")) throw new Error("subagent leave_project was not rejected!")
  console.log("subagent leave_project rejected ✓")
  // Parent cannot switch while a subagent is active (activity window)
  const swPar = await hooks.tool!.switch_project!.execute(
    { project_id: "projA" },
    { sessionID: "ses_abc123xyz", directory: home } as any,
  )
  const swParText = typeof swPar === "string" ? swPar : swPar.output
  if (!swParText.includes("Cannot switch projects while subagents are active")) throw new Error(`parent switch was not blocked by active subagent! got: ${swParText}`)
  console.log("parent switch blocked while subagent active ✓")
  // Subagent system.transform inherits the parent project context (not the project list)
  const sysSub: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_child001", model: {} as any }, sysSub)
  if (!sysSub.system.join("\n").includes("projA")) throw new Error("subagent did not inherit parent project context!")
  console.log("subagent system.transform inherits parent context ✓")
  // Subagent guard enforces the parent worktree boundary
  let subRejected = false
  try {
    await hooks["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses_child001", callID: "c40" },
      { args: { command: "ls", workdir: "/etc" } },
    )
  } catch {
    subRejected = true
  }
  if (!subRejected) throw new Error("subagent guard did not enforce parent worktree boundary!")
  console.log("subagent guard enforces parent worktree boundary ✓")
}

// 12. base_branch: worktrees fork from the configured base ref instead of the main copy's HEAD.
// projBase uses a plain string ("dev"), projBaseCmd uses a command whose stdout is the ref,
// projBaseFail uses a failing command that must fall back to HEAD. The dev branch contains
// dev.txt; the default HEAD does not, so the fork point is observable via dev.txt presence.
console.log("\n== base_branch fork point ==")
{
  const wtBase = await hooks.tool!.switch_project!.execute(
    { project_id: "projBase" },
    { sessionID: "ses_base1", directory: home } as any,
  )
  const baseOut = typeof wtBase === "string" ? JSON.parse(wtBase) : JSON.parse((wtBase as any).output)
  if (!fs.existsSync(path.join(baseOut.workdir, "dev.txt"))) throw new Error("base_branch string 'dev' did not fork from dev branch!")
  console.log("base_branch string forks from dev ✓")

  const wtCmd = await hooks.tool!.switch_project!.execute(
    { project_id: "projBaseCmd" },
    { sessionID: "ses_base2", directory: home } as any,
  )
  const cmdOut = typeof wtCmd === "string" ? JSON.parse(wtCmd) : JSON.parse((wtCmd as any).output)
  if (!fs.existsSync(path.join(cmdOut.workdir, "dev.txt"))) throw new Error("base_branch command did not fork from dev branch!")
  console.log("base_branch command forks from dev ✓")

  const wtFail = await hooks.tool!.switch_project!.execute(
    { project_id: "projBaseFail" },
    { sessionID: "ses_base3", directory: home } as any,
  )
  const failOut = typeof wtFail === "string" ? JSON.parse(wtFail) : JSON.parse((wtFail as any).output)
  if (fs.existsSync(path.join(failOut.workdir, "dev.txt"))) throw new Error("base_branch failing command should fall back to HEAD (no dev.txt)!")
  console.log("base_branch failing command falls back to HEAD ✓")
}

// 13. fetch (default on) + semver base_branch: a command that picks the largest
// v-prefixed semver origin branch. The remote refs are removed locally to prove the
// switch-time fetch pulled them, and the worktree must fork from origin/v2.0.0.
console.log("\n== fetch + semver base_branch ==")
{
  const semverRemote = path.join(R, "semver-remote.git")
  execFileSync("git", ["init", "--bare", "-q", semverRemote])
  execFileSync("git", ["remote", "add", "origin", semverRemote], { cwd: repoPath })
  execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: repoPath })
  for (const v of ["v1.2.0", "v1.10.0", "v2.0.0"]) {
    execFileSync("git", ["checkout", "-qb", v], { cwd: repoPath })
    fs.writeFileSync(path.join(repoPath, `${v}.txt`), `${v} marker\n`)
    execFileSync("git", ["add", "."], { cwd: repoPath })
    execFileSync("git", ["commit", "-qm", v], { cwd: repoPath })
    execFileSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${v}`], { cwd: repoPath })
    execFileSync("git", ["checkout", "-q", "-"], { cwd: repoPath })
    execFileSync("git", ["branch", "-D", v], { cwd: repoPath })
  }
  // Simulate a stale main copy: drop every remote-tracking ref so the semver command
  // can only succeed if the switch-time fetch restored them.
  execFileSync("git", ["remote", "set-head", "origin", "-d"], { cwd: repoPath })
  const staleRefs = execFileSync("git", ["for-each-ref", "refs/remotes/origin/", "--format=%(refname)"], { cwd: repoPath, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
  for (const ref of staleRefs) execFileSync("git", ["update-ref", "-d", ref], { cwd: repoPath })
  const originRefsBefore = execFileSync("git", ["for-each-ref", "refs/remotes/origin/", "--format=%(refname:short)"], { cwd: repoPath, encoding: "utf8" }).trim()
  if (originRefsBefore) throw new Error("expected zero origin refs before switch, got: " + originRefsBefore)

  const wtSemver = await hooks.tool!.switch_project!.execute(
    { project_id: "projSemver" },
    { sessionID: "ses_semver1", directory: home } as any,
  )
  const semverOut = typeof wtSemver === "string" ? JSON.parse(wtSemver) : JSON.parse((wtSemver as any).output)
  if (!fs.existsSync(path.join(semverOut.workdir, "v2.0.0.txt"))) throw new Error("semver base_branch did not fork from origin/v2.0.0!")
  if (fs.existsSync(path.join(semverOut.workdir, "v1.10.0.txt"))) throw new Error("semver base_branch wrongly forked from a smaller version!")
  console.log("fetch + semver base_branch forks from largest v branch (origin/v2.0.0) ✓")

  // fetch=false project must skip the fetch entirely and still work off local refs.
  const wtNoFetch = await hooks.tool!.switch_project!.execute(
    { project_id: "projNoFetch" },
    { sessionID: "ses_nofetch1", directory: home } as any,
  )
  const noFetchOut = typeof wtNoFetch === "string" ? JSON.parse(wtNoFetch) : JSON.parse((wtNoFetch as any).output)
  if (!fs.existsSync(path.join(noFetchOut.workdir, "dev.txt"))) throw new Error("fetch=false project did not fork from local dev branch!")
  console.log("fetch=false skips fetch, uses local refs ✓")
}

console.log("\n✅ P1 all verifications passed")
// Cleanup
fs.rmSync(R, { recursive: true, force: true })
console.log("test environment cleaned up")
