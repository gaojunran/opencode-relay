// P1 端到端验证脚本（throwaway）：直接加载插件模块，跑真实 git 场景
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { resetConfig } from "./config.js"

const R = `/tmp/relay-e2e-${Date.now()}`
const home = path.join(R, "home")
const configDir = path.join(home, ".config", "opencode-relay")
const workspaceRoot = path.join(home, "workspace")
const repoPath = path.join(workspaceRoot, "projA")
const worktreeRoot = path.join(home, ".opencode", "worktrees")
const stateDir = path.join(home, ".opencode", "state")
fs.mkdirSync(path.join(configDir), { recursive: true })
fs.mkdirSync(repoPath, { recursive: true })

// 造主副本 git 仓库
execFileSync("git", ["init", "-q"], { cwd: repoPath })
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoPath })
execFileSync("git", ["config", "user.name", "t"], { cwd: repoPath })
fs.writeFileSync(path.join(repoPath, "README.md"), "hello projA\n")
execFileSync("git", ["add", "."], { cwd: repoPath })
execFileSync("git", ["commit", "-qm", "init"], { cwd: repoPath })

// 写测试配置
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
[worktree]
branch_prefix = "opencode/"
end_of_session = "keep"
[inject]
enabled = true
template = "当前项目: {project_name}（{project_id}），工作目录: {workdir}，分支: {branch}。"
[guard]
enabled = true
reject_on_violation = true
`
fs.writeFileSync(path.join(configDir, "config.toml"), conf)
process.env.OPENCODE_RELAY_CONFIG = path.join(configDir, "config.toml")

// 加载插件
const mod = await import("./relay.ts")
const plugin = mod.default
const hooks = await plugin.server({ directory: home, project: { id: "relay-test", directory: home } } as any)

// 1. list_project
const listOut = await hooks.tool!.list_project!.execute({}, { sessionID: "ses_abc123xyz", directory: home } as any)
console.log("== list_project ==")
console.log(typeof listOut === "string" ? listOut : listOut.output)
if (JSON.stringify(listOut).includes(repoPath)) throw new Error("list_project 泄露了 repo_path!")

// 2. switch_project 首次创建
const sw = await hooks.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
console.log("\n== switch_project 首次 ==")
const swObj = typeof sw === "string" ? JSON.parse(sw) : JSON.parse(sw.output)
console.log(JSON.stringify(swObj, null, 2))
const workdir = swObj.workdir
if (!fs.existsSync(workdir)) throw new Error("worktree 目录不存在")
if (!fs.existsSync(path.join(workdir, "README.md"))) throw new Error("worktree 文件未物化!")
console.log("worktree 文件已物化: README.md 存在 ✓")

// 3. 状态文件已写（文件名经 sanitizeSessionID：去掉下划线）
const stateFile = path.join(stateDir, "sesabc123xyz.json")
if (!fs.existsSync(stateFile)) throw new Error("状态文件未写")
console.log("状态文件: " + stateFile)

// 4. 会话内复用（二次 switch 不重建）
fs.writeFileSync(path.join(workdir, "README.md"), "modified by agent\n")
const sw2 = await hooks.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
const sw2Obj = typeof sw2 === "string" ? JSON.parse(sw2) : JSON.parse(sw2.output)
console.log("\n== switch_project 二次（复用）==")
console.log(JSON.stringify(sw2Obj, null, 2))
if (sw2Obj.workdir !== workdir) throw new Error("复用失败: workdir 变了")
if (!fs.readFileSync(path.join(workdir, "README.md"), "utf8").includes("modified")) throw new Error("复用失败: 工作区被重置")
console.log("复用成功，工作区改动保留 ✓")

// 5. tool.execute.before 拦截
console.log("\n== guard 拦截测试 ==")
// 5a. bash workdir 越界
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c1" }, { args: { command: "ls", workdir: "/etc" } })
  throw new Error("bash 越界未被拦截!")
} catch (e) {
  console.log("bash /etc 越界 → 拒绝 ✓: " + (e as Error).message.slice(0, 60))
}
// 5b. bash workdir 缺省（home）越界
try {
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c2" }, { args: { command: "ls" } })
  throw new Error("bash 缺省 workdir 越界未被拦截!")
} catch (e) {
  console.log("bash 缺省 workdir（home）→ 拒绝 ✓")
}
// 5c. read 绝对路径越界
try {
  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c3" }, { args: { filePath: "/etc/passwd" } })
  throw new Error("read 越界未被拦截!")
} catch (e) {
  console.log("read /etc/passwd → 拒绝 ✓")
}
// 5c2. write 绝对路径越界（参数名 filePath 大写 P）
try {
  await hooks["tool.execute.before"]!({ tool: "write", sessionID: "ses_abc123xyz", callID: "c9" }, { args: { filePath: "/etc/pwned.txt", content: "x" } })
  throw new Error("write 越界未被拦截!")
} catch (e) {
  console.log("write /etc/pwned.txt → 拒绝 ✓")
}
// 5c3. edit 相对路径越界（解析到 instanceDir=home，主副本在 home 下）
try {
  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "ses_abc123xyz", callID: "c10" }, { args: { filePath: path.join(workspaceRoot, "projA", "README.md") } })
  throw new Error("edit 主副本越界未被拦截!")
} catch (e) {
  console.log("edit 主副本路径 → 拒绝 ✓")
}
// 5c4. apply_patch 越界（patchText 内 Update File 指向 home 外）
try {
  await hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "ses_abc123xyz", callID: "c11" }, { args: { patchText: "*** Begin Patch\n*** Update File: /etc/passwd\n@@ context\n*** End Patch" } })
  throw new Error("apply_patch 越界未被拦截!")
} catch (e) {
  console.log("apply_patch /etc/passwd → 拒绝 ✓")
}
// 5c5. grep 搜索目录越界
try {
  await hooks["tool.execute.before"]!({ tool: "grep", sessionID: "ses_abc123xyz", callID: "c12" }, { args: { pattern: "x", path: "/etc" } })
  throw new Error("grep path 越界未被拦截!")
} catch (e) {
  console.log("grep path=/etc → 拒绝 ✓")
}
// 5d. 工作目录内放行
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c4" }, { args: { command: "ls", workdir } })
console.log("bash workdir=worktree → 放行 ✓")
await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c5" }, { args: { filePath: path.join(workdir, "README.md") } })
console.log("read worktree 内绝对路径 → 放行 ✓")
await hooks["tool.execute.before"]!({ tool: "write", sessionID: "ses_abc123xyz", callID: "c13" }, { args: { filePath: path.join(workdir, "new.txt"), content: "x" } })
console.log("write worktree 内绝对路径 → 放行 ✓")

// 5e. deny_paths 追加层：worktree 内但命中 deny 的路径被拒绝
// 5f. worktree 内非 deny 路径放行（验证 deny 不误伤）
const denyDir = path.join(workdir, "secret")
fs.mkdirSync(denyDir, { recursive: true })
// 配置在 server() 调用时读取，需写入含 deny_paths 的新配置并重新加载插件
const conf2 = conf + `deny_paths = ["${denyDir}/**"]\n`
fs.writeFileSync(path.join(configDir, "config.toml"), conf2)
resetConfig()
const hooks2 = await plugin.server({ directory: home, project: { id: "relay-test", directory: home } } as any)
// 5e: worktree 内但命中 deny → 拒绝
try {
  await hooks2["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c7" }, { args: { filePath: path.join(denyDir, "x.txt") } })
  throw new Error("deny 未生效")
} catch (e) {
  console.log(`read worktree 内 deny 子目录 → 拒绝 ✓: ${(e as Error).message.slice(0, 55)}`)
}
// 5f: worktree 内非 deny → 放行
await hooks2["tool.execute.before"]!({ tool: "read", sessionID: "ses_abc123xyz", callID: "c8" }, { args: { filePath: path.join(workdir, "README.md") } })
console.log("read worktree 内非 deny → 放行 ✓")

// 6. system.transform 注入
const sysOut: { system: string[] } = { system: [] }
await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut)
console.log("\n== system.transform ==")
console.log(sysOut.system[0])
if (!sysOut.system[0].includes("projA") || !sysOut.system[0].includes(workdir)) throw new Error("注入内容不完整")

// 7. 未切项目的会话不拦截
await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_other", callID: "c6" }, { args: { command: "ls", workdir: "/etc" } })
console.log("\n未切项目会话不拦截 ✓")

// 7b. 未切项目会话：system.transform 注入项目清单引导 switch
const sysOut2: { system: string[] } = { system: [] }
await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_other", model: {} as any }, sysOut2)
console.log("\n== system.transform 未切项目（清单引导）==")
console.log(sysOut2.system[0])
if (!sysOut2.system[0].includes("projA")) throw new Error("未切项目会话未注入项目清单!")
if (!sysOut2.system[0].includes("switch_project")) throw new Error("清单注入缺少 switch 引导!")
console.log("未切项目会话注入项目清单 + switch 引导 ✓")

// 8. leave_project：切回未切状态，guard 恢复放行、system.transform 恢复清单引导、worktree 保留可复用
console.log("\n== leave_project ==")
const lp = await hooks2.tool!.leave_project!.execute({}, { sessionID: "ses_abc123xyz", directory: home } as any)
const lpOut = typeof lp === "string" ? JSON.parse(lp) : JSON.parse(lp.output)
console.log(JSON.stringify(lpOut, null, 2))
if (lpOut.left_project !== "projA") throw new Error("leave_project 返回项目不正确")
if (!fs.existsSync(workdir)) throw new Error("leave_project 不应删除 worktree!")
console.log("leave_project 返回 + worktree 保留 ✓")
// 8a. 退出后 guard 放行（无状态会话不拦截）
await hooks2["tool.execute.before"]!({ tool: "bash", sessionID: "ses_abc123xyz", callID: "c14" }, { args: { command: "ls", workdir: "/etc" } })
console.log("leave 后 bash /etc → 放行（恢复无状态）✓")
// 8b. 退出后 system.transform 恢复清单引导
const sysOut3: { system: string[] } = { system: [] }
await hooks2["experimental.chat.system.transform"]!({ sessionID: "ses_abc123xyz", model: {} as any }, sysOut3)
if (!sysOut3.system[0].includes("switch_project")) throw new Error("leave 后未恢复清单引导!")
console.log("leave 后 system.transform 恢复清单引导 ✓")
// 8c. 同会话再 switch 复用原 worktree（state 缺失但有注册目录）
const sw3 = await hooks2.tool!.switch_project!.execute({ project_id: "projA" }, { sessionID: "ses_abc123xyz", directory: home } as any)
const sw3Obj = typeof sw3 === "string" ? JSON.parse(sw3) : JSON.parse(sw3.output)
if (sw3Obj.workdir !== workdir) throw new Error("leave 后再 switch 未复用原 worktree!")
console.log("leave 后再 switch → 复用原 worktree ✓")

console.log("\n✅ P1 全部验证通过")
// 清理
fs.rmSync(R, { recursive: true, force: true })
console.log("测试环境已清理")
