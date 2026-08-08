# opencode-relay 设计文档

云端多项目开发 Agent：企微 IM 对话，经 cc-connect 接入固定 home 的 opencode 会话，Agent 在会话内通过 `switch_project` 切换到项目的独立 worktree 工作，主副本保存在 `~/workspace` 下保持干净。最终成品是一个 opencode 插件。

- 项目名: opencode-relay
- 版本: v0.6（配置化：config.toml 驱动路径/注册表/策略）
- 日期: 2026-08-06
- 状态: 待实现（P1/P2/P3 见 [实现阶段](#6-实现阶段)）

---

## 1. 背景与目标

用户已有大量基建基于 OpenCode。需要一个云端 Agent：

1. **IM 接入**：首期企业微信（WebSocket 智能机器人，无需公网 URL）。企微接入层用现成的 cc-connect，不自己写。
2. **Coding 能力**：不是聊天助手，需要完整工具链（bash/read/write/edit），执行体是 opencode。
3. **固定 home 常驻会话**：默认 IM 会话开在 home 目录，Agent 通过提示词 + 工具在会话内切换项目目录，不需要多会话接力。
4. **对话前拦截**：消息进 LLM 前执行固定操作（注入当前项目上下文等），由 opencode 插件 hook 实现。
5. **并发防护**：多个会话同时工作时，同一项目不冲突。**每次 `switch_project` 无条件创建独立 git worktree**，各会话物理隔离，零共享，无需锁。主副本 `~/workspace/<project>` 永远干净。项目清单不暴露实际目录。
6. **防绕过**：Agent 尝试绕过限制时（用错目录、直连主副本），被工具层拦截。
7. **最终成品是一个 opencode 插件**：项目切换、上下文注入、worktree 管理、拦截全部在插件内完成；cc-connect 只做企微到 opencode 的桥接，零改动。

### 架构决策（已确认）

| 决策点 | 结论 |
|---|---|
| 最终成品 | **一个 opencode 插件**（TS/JS，跑在 opencode 会话内） |
| IM 桥接层 | **cc-connect（v1.4.1，Go 二进制，零改动）**：企微 WS 接入 + 会话续接 |
| 会话模型 | 固定 `work_dir = home`，每 IM 会话键独立 opencode session，历史隔离 |
| 项目切换 | Agent 调用插件 `switch_project({project_id})` 工具 + bash `workdir` 参数，会话身份和 home 目录不变 |
| 项目清单 | **不暴露实际目录**：`list_project` 只返回 `{id, name}`，工作目录仅 switch 成功后作为返回值给出 |
| 并发防护 | **无条件 git worktree**：每次 switch 创建独立 worktree（分支 `opencode/<session>`），零锁零冲突 |
| 主副本 | `~/workspace/<project>` 保留为干净基线，Agent 永不直接写主副本 |
| 上下文注入 | 插件 `experimental.chat.system.transform` 每轮注入"当前项目是 X" |
| 防绕过 | 插件 `tool.execute.before` 硬拦截 + `permissions` 规则兜底 |
| 对话前拦截 | 插件 hook（system.transform / chat.message），cc-connect 不参与 |
| 权限 | cc-connect `mode = "yolo"`，opencode 内部权限永不触发企微审批流 |
| 接力（fork/move-session） | **不需要**。常驻 home 会话 + 会话内切 worktree，历史自然保留 |

---

## 2. 调研结论摘要（源码实证）

以下结论全部来自源码核实，实现时如需细节可直接查这些位置。

### 2.1 为什么用 cc-connect（而不是自建 bridge）

- **零改动够用**：`work_dir` 可配置为固定 home（`config.example.toml:1689`），每 IM 会话键（`interactiveKey`）有独立 opencode session（`engine.go:3887`），互不干扰；会话续接靠 `AgentSessionID` + `--session`（`session.go:92,171-172`）。
- **项目切换完全下沉到 opencode 插件侧**：cc-connect spawn 的 `opencode run` 是 in-process server（`run.ts:8-11`），插件正常加载（`registry.ts:194-199`），与 cc-connect 无关。
- **权限零打扰**：opencode adapter 的 `RespondPermission` 是 no-op（`agent/opencode/session.go:510-512`），企微审批流永不触发；配 `mode = "yolo"` 彻底零打扰（`config.example.toml:1690`）。
- **cc-connect 无 worktree 概念**（全仓 grep 零结果）：worktree 管理完全在 opencode 侧实现。

### 2.2 opencode 工具与插件能力（本项目插件的实现基础）

- **bash cwd 语义**：每次 bash 调用是独立进程，从会话 directory 启动（`tool/shell.ts:612-614`），`cd` 只在该次调用内生效，跨消息必然丢失。官方提示词要求用 `workdir` 参数切目录（`shell/prompt.ts:227-228,260-261`）。**"切换到项目 X 并保持"的正确用法 = 每次 bash 调用带 `workdir="/abs/path/X"`**。
- **workdir 无范围硬约束**：V2 bash 工具（`core/src/tool/bash.ts:129`）对 workdir 任意绝对路径放行，超出实例时走 `external_directory` 权限断言（`:130-137`）；无"必须在工作区内"的强制校验。**软约束靠权限规则 + 插件拦截**。
- **自定义工具注册**：插件 `tool` 对象（`plugin/src/index.ts:226-228`）→ `tool/registry.ts:194-199`；工具 execute 收到 `PluginToolContext`（含 `directory`，`registry.ts:143-148`）。
- **每轮注入 system prompt**：`experimental.chat.system.transform`（`plugin/src/index.ts:291-296`），触发点 `session/llm/request.ts:69-73`，**每次 LLM 请求必触发**，往 `output.system` push 一行即可。
- **防绕过拦截点**：`tool.execute.before`（`plugin/src/index.ts:266-269`）在工具执行前可改 `output.args` 或抛错拒绝。**注意：`permission.ask` hook（`plugin/index.ts:261`）在 v1.18.5 无任何触发点，是死接口，不能依赖。**
- **CLI run 与 server 插件加载一致**：run 模式走 in-process server（`run.ts:906,944`），插件在 server 侧加载（`plugin/index.ts:110-120`）。
- **external_directory 门控**：home 会话访问 home 下任意子目录直接放行（`external-directory.ts:15-45` + `instance-context.ts:18-24` 的 `containsPath`）；read/write/glob 接受绝对路径（`read.ts:234-237`）。只有 home 之外才触发授权。

### 2.3 worktree 能力（本项目并发防护的锚点）

- **完整内置服务**：`packages/opencode/src/worktree/index.ts`（623 行），接口 `makeWorktreeInfo / createFromInfo / create / list / remove / reset`（:119-126）。
  - 创建（:216-221）：`git worktree add --no-checkout -b opencode/<name> <dir>`（或 `--detach`），目录固定为 `Global.Path.data/worktree/<projectID>/<name>`（:208）；随后 `git reset --hard`（:237）、boot 新实例（:250-265）、发 `WorktreeEvent.Ready`（:268-276）。
  - worktree 是**独立物理目录**（opencode 数据目录下），源 instance.directory 不变。
  - 删除（:388-449）：`store.disposeDirectory` + `git worktree remove --force` + `git branch -D`；重置（:525-611）：`git reset --hard <default branch>` + `git clean -ffdx`。
  - 创建时登记进 **project sandbox 白名单**（`project.addSandbox`，:228；实现 project.ts:417-432，写入 `ProjectTable.sandboxes`），`containsPath` 判定放行（instance-context.ts:18-24）。
- **HTTP 端点**（groups/experimental.ts:90-102,176-223）：`GET/POST/DELETE /experimental/worktree`、`POST /experimental/worktree/reset`；事件 `worktree.ready` / `worktree.failed`。
- **openchamber 的 worktree 是自研实现，不走 opencode 端点**：`server/lib/git/service.js:3890` 的 `createWorktree` 直接 `git worktree add`（:3800-3830），带自己的 worktreeRoot 管理（`getOpenCodeDataPath()/worktree/<projectID>`，:1484）与 bootstrap 状态机。
- **webui 展示的是纯 git 元数据**：`GET /api/git/worktrees`（routes.js:1020-1029）→ `getWorktrees`（service.js:3539）→ `git worktree list --porcelain`（:3550），**不按 worktreeRoot 过滤、不区分创建者**。插件用 `git worktree add` 创建的 worktree 同样出现在 openchamber webui 列表（head/name/branch/path 字段齐全）。

### 2.4 worktree 生命周期（无锁，天然隔离）

- **插件无 session 开始/结束 hook**。Hooks 全集（plugin/src/index.ts:222-335）里生命周期相关只有 `dispose`（:223，实例销毁/插件卸载 finalizer）；session-event 全集无 `session.ended/deleted`。
- **`event` hook 按 `event.location?.directory === ctx.directory` 过滤**（plugin/index.ts:252），只收本实例目录事件。
- **无锁设计下的生命周期**：不再需要锁释放（每会话独立 worktree，天然隔离）。worktree 清理靠 `dispose` hook（opencode run 进程结束 = cc-connect 会话回收，engine.go:3887-3917 有会话复用/回收逻辑）：dispose 时按需清理本会话创建的 worktree（或保留分支供用户合并）。

### 2.5 权限规则与配置

- **Ruleset**：agent 配置 `permissions: { action, resource, effect: "allow"|"deny"|"ask" }[]`（core/src/config.ts:60、schema/src/permission.ts:54-64），resource 支持 `*` glob（core/src/util/wildcard.ts）。决策 `evaluate`（core/src/permission.ts:76-86）findLast 匹配，无匹配默认 ask；无 agent 权限默认 deny all（:15）。
- **yolo/auto 模式**（run.ts:252,274）：跳过权限阻塞。**注意：yolo 下权限规则兜底失效，插件拦截仍生效。**
- **V2 会话无 metadata 存储通道**（schema/src/session.ts:19-44 无 metadata；session.update 只支持 archived，handlers/session.ts:200-201）：**会话状态必须用外部文件**（`<config.state_dir>/<sessionID>.json`，默认 `~/.opencode/state/`）。

### 2.6 上下文迁移实证（存档：为什么本设计不需要）

前几轮调研过的接力原语，本设计（常驻 home 会话）不再需要，但结论存档备查：

- fork：`POST /session/{id}/fork?directory=target`，完整克隆历史，跨仓库可行。但实测 **fork 的 directory 参数被忽略**，新会话永远落在源会话目录（`session.ts:697-698`）。绕过：fork + 改 DB `directory` 一行（实测可行）。
- MoveSession：仅限同 project，跨仓库 400（实测确认）。
- **结论**：若未来要真接力，最干净路径是改 opencode 一行（`session.ts:697`）。本设计不涉及。
- 另一个实证：serve 的消息读取兼容 V1 表（CLI 会话历史 openchamber UI 可见），此前"V1/V2 互不可见"的结论是错的。

---

## 3. 总体架构

```
企微用户/群
   │  WS 智能机器人
   ▼
cc-connect（v1.4.1，零改动）
   ├─ [projects.agent.options] work_dir = "/home/<user>"  固定 home
   ├─ mode = "yolo"                                       零权限打扰
   ├─ 每 IM 会话键 → 独立 opencode session（--session 续接）
   ▼
opencode run（in-process server，cc-connect spawn）
   └─ 本项目插件（最终成品）
        ├─ tool: list_project()                            只返回 {id, name}
        ├─ tool: switch_project({project_id})              无条件建 worktree，返回工作目录
        ├─ tool: leave_project()                           删除会话状态，恢复无状态（worktree 保留）
        ├─ tool: cleanup_worktrees({dry_run})              回收 stale 不活跃 worktree
        ├─ hook: system.transform                          每轮注入"当前项目"
        ├─ hook: tool.execute.before                       防绕过硬拦截
        ├─ hook: dispose                                   worktree 生命周期收尾
        └─ 配置: ~/.config/opencode-relay/config.toml（示例见 config.example.toml）
             状态: ~/.opencode/state/<sessionID>.json
   ▼
~/workspace/<project>（主副本，干净基线，Agent 不直接写）
```

分层职责：

- **cc-connect**：企微接入 + 会话路由 + `--session` 续接 + `--dir home`。零改动，黑盒使用。
- **本项目插件**：项目清单（不暴露路径）、无条件 worktree 切换、当前项目注入、防绕过拦截、worktree 生命周期。这是我们要交付的全部代码。
- **Agent 行为约定**：bash 调用带 `workdir`（来自 switch_project 返回值）；文件操作用绝对路径（工作目录内）；主副本 `~/workspace/<project>` 永不直接写。

---

## 4. 组件设计（核心章节）

### 4.1 配置文件与项目注册表

```
~/.config/opencode-relay/config.toml       全部可配置（路径/注册表/策略/防绕过）
  [general]    enabled / home（默认 $HOME）/ log_level / log_file（可选日志目录，按天切分 `<dir>/relay-<日期>.log`，tee 到 console）
  [paths]      workspace_root / worktree_root / state_dir
  [projects]   items[] 或 scan_dir 自动扫描
  [worktree]   branch_prefix / end_of_session / remote
  [inject]     注入开关与模板
  [guard]      防绕过开关与 deny/allow 模式
  [permissions] 权限兜底规则（可选）
  [list]       list_project 展示开关

~/.opencode/state/<sessionID>.json         当前项目状态（按 session 隔离，多会话不串台）
  { "project_id": "projA", "workdir": "<worktree_dir>", "worktree_branch": "opencode/<session>" }
```

配置加载：插件启动时读取一次，可用环境变量 `OPENCODE_RELAY_CONFIG` 覆盖路径。项目注册表两种来源二选一：显式 `[[projects.items]]`（推荐，list_project 只暴露 id/name）或 `scan_dir` 自动扫描（收集含 .git 的子目录）。状态落外部文件（V2 会话无 metadata 通道，见 2.5）。完整示例见 `config.example.toml`。

**opt-out 短路（启动时）**：`[general].home`（默认 `$HOME`，不取会话目录）是插件的生效范围。插件加载时若会话 directory 不在 home 内（`isInside(sessionDir, home)` 不成立），直接返回空 hooks，不注册任何工具与拦截逻辑，日志打 `[opt-out]`。这样只有 home 常驻会话会加载插件；在 home 之外手动开会话不受插件约束。

### 4.2 list_project 工具（不暴露实际目录）

```
tool.list_project()
→ [ { "id": "projA", "name": "projA" }, ... ]
```

**绝不返回 `repo_path`**。Agent 只能拿到项目 ID/名称，工作目录只有 switch 成功后才以返回值给出。这样 Agent 没有"主副本真实路径"可用于绕过（见 5.3 边界说明）。

### 4.3 switch_project 工具（无条件 worktree）

```
tool.switch_project({ project_id: string })
```

1. 查配置注册表 `[projects]` → `repo_path`（主副本位置）。
2. **无条件创建独立 git worktree**：
   - `git worktree add --no-checkout -b <branch_prefix><sessionID 全量 sanitized> <worktree_dir> <base_ref>`
   - worktree_dir 约定：`<config.worktree_root>/<project_id>/<sessionID 全量 sanitized>`（默认 home 内，免 external_directory 授权）。
   - 分支名 `<branch_prefix><sessionID 全量 sanitized>`（默认 `opencode/` 前缀）天然唯一（会话 ID 唯一），多会话同项目各自独立分支，零冲突。
   - **base_ref（`[projects].items[].base_branch`，项目级）**：缺省/空 = 主副本当前 HEAD；字符串（如 `"main"`）直接作 ref；`{ command = "git ..." }` 在主副本 cwd 执行、取 stdout 首行作 ref，失败降级 HEAD。三种形态均实测（e2e-test 12 号场景）。
   - **fetch（`[projects].items[].fetch`，默认 true）**：创建 worktree 前在主副本执行 `git fetch --all --prune`（60s 超时），保证 `base_branch` 的远程 refs 是最新的（如按 `origin/v*` semver 选基底）；失败仅记 warn 降级用本地 refs，绝不阻塞 switch。`fetch = false` 跳过。e2e-test 13 号场景实测：清空本地 origin refs 后 switch，`base_branch = { command = "… | sort -V | tail -1" }` 经 fetch 拉回远程并选出最大 v 分支。
3. 写 `<config.state_dir>/<sessionID>.json`，返回工作目录：
   ```
   → { "workdir": "<worktree_dir>", "project_id": "projA" }
   ```
4. Agent 感知不到 worktree：语义就是"这是我的工作目录，用 workdir 参数"。主副本 `<config.workspace_root>/<project>` 不在任何返回路径中。

**会话内多次切换**：同一 session 再次 switch 到已建过 worktree 的项目 → 复用已有 worktree（读 state_dir 状态），不重复创建；切到新项目 → 新建 worktree。

**worktree 分支与归并**（P3 完善）：
- 分支 `<branch_prefix><sessionID 全量 sanitized>` 承载本会话全部改动。
- 会话结束（dispose）时：按 `[worktree].end_of_session` 配置执行 `keep`（默认，保留分支 + worktree 供手动 review/merge）、`push`（自动 `git push <remote> <branch>` 并提示开 PR）或 `cleanup`（删除 worktree 目录，分支保留）。
- 主副本 `<workspace_root>/<project>` 保持干净，是长期可信基线。

### 4.3b leave_project 工具（退出项目，恢复无状态）

```
tool.leave_project()
```

与 `switch_project` 对称的逆操作，让 Agent 自主回到"未切换项目"的自由状态（guard 不拦截、system.transform 恢复项目清单引导）。**worktree 目录与分支保留，改动不丢失**；同会话再次 `switch_project` 到该项目会复用原 worktree（目录存在但状态缺失时的复用逻辑见 4.3 第 1 步）。需要物理回收时由 `cleanup_worktrees` 按 stale_days 处理。

### 4.4 system.transform hook（每轮注入）

**两种形态**（同一 hook，按会话是否已切项目分流）：

1. **未切项目（无状态）→ 注入项目清单引导**：把 `list_project` 的结果（项目 id/name/description 列表）注入 system prompt，并附"请调用 switch_project 切换"的引导，让 Agent 一开始就知道有哪些项目可选。由 `[inject].list_projects`（默认 `true`）控制；项目注册表为空时跳过。
2. **已切项目（有状态）→ 注入当前项目上下文**：注入模板渲染结果（`{project_id}`/`{project_name}`/`{workdir}`/`{branch}`）。
3. **已切项目 → 注入 worktree 根指令文件**（`[inject].agents_md`，默认 `true`）：读取 worktree 根的 `AGENTS.md`（优先级 AGENTS.md → CLAUDE.md → CONTEXT.md，与 opencode `instruction.ts:60-68` 一致）注入 system prompt（上限 12000 字符）。背景（exp-4 源码实证）：opencode 的指令加载只从会话目录向上 `findUp`（`instruction.ts:126`），worktree 是子目录永远不会被扫到；read 联动只在模型读文件时按需附加。插件在 worktree 根直接读并稳定注入，恢复项目级指令。
4. **已切项目 → 注入项目 skill 清单**（`[inject].skills`，默认 `true`）：扫描 worktree 的 `.opencode/skills` / `.opencode/skill` 下的 `SKILL.md`（与 `OPENCODE_SKILL_PATTERN` 一致），把 skill 名列表注入 system prompt，引导模型用 skill 工具加载。opencode 的 skill 发现同样只向上扫 + 固定 `~/.opencode`（`skill/index.ts:205-208`），worktree 内技能默认不可见。

```ts
hook: { experimental: { chat: { system: { transform: async ({sessionID}, output) => {
  const cur = await readCurrent(sessionID);
  if (cur && inject.enabled) {
    const text = renderTemplate(inject.template, {
      project_id: cur.project_id,
      project_name: cur.project_name,
      workdir: cur.workdir,
      branch: cur.worktree_branch,
    });
    output.system.push(text);
  }
} } } } }
```

默认模板（`[inject].template` 可覆盖）：
```
当前项目: {project_name}（{project_id}），工作目录: {workdir}，分支: {branch}。
bash 工具请用 workdir="{workdir}" 参数，文件操作请用绝对路径。
不要直接修改 {workspace_root} 下的项目主副本。
```

触发点 `session/llm/request.ts:69-73`，每轮必触发，状态变化下一轮立即生效。

### 4.4b shell.env hook（项目环境注入）与 on_switch 命令

**背景（exp-4 源码实证）**：bash 工具每次调用是独立进程（`shell -c`，非 login 不读 rc，`tool/shell.ts:293-310`），继承 opencode 进程 env（`shellEnv`: `{...process.env, ...hook注入}`，`:416-426`）。opencode 无任何 direnv/mise 集成。因此"进入目录才激活的工具链环境"（mise fnox、.envrc 等）在 worktree 里默认不生效。

**机制**：
1. `[worktree].on_switch`（默认空数组）配置命令数组，顺序执行；`switch_project` 创建/复用 worktree 后在 worktree 内逐条执行，`{{dir}}` 替换为 worktree 路径，每条 stdout 按 `KEY=VALUE` / `export KEY=VALUE` 行解析（`parseEnvDump`，兼容 `mise env` / `direnv export bash` 输出）合并进会话状态 `state.env`（后者覆盖同名 key）。任一条失败仅记日志，绝不阻塞 switch。
2. `shell.env` hook（opencode 现存 API，`plugin/src/index.ts:270-273`）每次 bash spawn 前触发：按 sessionID 读 `state.env` 合并进 `output.env`。效果 = 每次 bash 调用都带项目环境（弥补 bash 独立进程无跨调用状态的缺口）。

```ts
hook: { shell: { env: async ({sessionID}, output) => {
  const state = readSessionState(config, sessionID);
  if (state?.env) Object.assign(output.env, state.env);
} } }
```

典型配置：`on_switch = ["mise env", "direnv export bash"]`（stdout 直接是 export 行，`parseEnvDump` 兼容；字符串形式如 `on_switch = "mise env"` 仍兼容，自动视为单元素数组）。

### 4.4c 子代理会话（task 派生的子会话：继承上下文但禁改项目状态）

opencode 的 `task` 工具创建的子代理是**独立 session**（独立 sessionID，DB 用 `parent_id` 关联父会话，见 task.ts:156-172、session.ts:522）。它继承父会话的 directory 并复用同一插件实例（server() 按 directory 只初始化一次），但**不继承上下文**——子代理是干净上下文。

**问题**：插件按 sessionID 隔离 state。子代理是新的 sessionID，若它调用 switch_project 会创建**自己的 worktree**（父会话不知道的孤儿目录/分支）；多个子代理并行各自 switch 会互相污染状态。

**方案：读路径归并到根父会话，写路径对子代理关闭**：

```ts
const parentMap = new Map<string, string>();        // childID -> parentID
const childLastActive = new Map<string, number>();  // childID -> 最近活动时间戳
const resolveSessionID = (id) => {  // 沿 parentMap 递归到根父会话（读路径用）
  let cur = id, seen = new Set();
  while (parentMap.has(cur) && !seen.has(cur)) { seen.add(cur); cur = parentMap.get(cur)!; }
  return cur;
};

hook: { event: async ({ event }) => {
  // session.created 建立 child→parent；任何子代理会话事件刷新活动时间戳
  if (event.type === "session.created" && event.properties.info?.parentID) {
    parentMap.set(event.properties.info.id, event.properties.info.parentID);
  }
  if (parentMap.has(event.properties.sessionID)) childLastActive.set(event.properties.sessionID, Date.now());
} }
```

- **读路径（继承）**：`tool.execute.before` 的 guard、`system.transform` 注入、`shell.env` 先 `resolveSessionID()` 到根父会话——子代理在父会话 worktree 内干活、guard 边界一致、注入父会话当前项目上下文（而非项目清单）。
- **写路径（禁止）**：`switch_project` / `leave_project` / `register_project` / `cleanup_worktrees` 对子代理会话**直接拒绝**（返回 "Subagent sessions cannot ..."）；`list_project` 只读放行。
- **父代理保护**：父会话调 `switch_project` 时若有**活跃子代理**（`childLastActive` 在 60 秒窗口内，`SUBAGENT_ACTIVE_WINDOW_MS`）则拒绝，提示等待子代理完成。

效果：子代理只干活不改状态，不产生孤儿 worktree，并行子代理不会互相污染；父会话在子代理活跃期间不能切换项目，保证状态一致性。

注意（exp-6 实证）：`parentID` 不进 `tool.execute.before`/`system.transform` 的 input，只有 `event` hook 的 `session.created`（properties.info 含完整 SessionInfo）或 SDK `session.get()` 能拿到；`dispose` 按实例触发不按会话，不能依赖它清理子代理状态。子代理与父会话共享插件实例，不要在 server() 里做按会话初始化。活跃判断用活动时间戳近似（opencode 无"子代理任务结束"事件：task 不删子代理会话、无 session.deleted，见 task.ts 无 delete 调用），窗口内的子代理视为运行中。

### 4.5 tool.execute.before hook（防绕过硬拦截）

```ts
hook: { tool: { execute: { before: async ({tool, sessionID}, output) => {
  const state = readSessionState(sessionID);
  if (!state) return;                     // 未切项目，不限制
  const allowed = state.workdir;
  if (tool === "bash") {
    const wd = input.workdir ? resolve(instanceDir, input.workdir) : instanceDir;
    if (!isInside(wd, allowed)) {
      if (guard.reject_on_violation) output.error = "工作目录超出当前项目，请先 switch_project";
      else log.warn("bash workdir 越界", { wd, allowed });
    }
  }
  if (["read","write","edit","glob","grep","apply_patch"].includes(tool)) {
    for (const p of fileToolPaths(tool, args)) {   // 参数名按 opencode 实证：filePath / path / patchText
      const c = resolve(instanceDir, p);           // 相对路径也解析后检查（落在 home=主副本即拒绝）
      if (!isInside(c, allowed)) {
        if (guard.reject_on_violation) output.error = "路径超出当前项目";
        else log.warn("路径越界", { p, allowed });
      }
    }
  }
} } } }
```

- `[guard].reject_on_violation = true` 拒绝（默认）；`false` 仅记录日志不拦截（宽松模式）。
- 拒绝时给出明确指引（"请先 switch_project"），Agent 自我纠正。
- 这是防绕过的最强位置（`tool.execute.before` 是活接口；`permission.ask` 是死接口不能用）。

### 4.6 权限规则兜底（配置层，可选加固）

即使插件被禁用，权限层兜底。配置在 `config.toml` 的 `[permissions].rules`（透传给 opencode agent permissions），默认关闭（`enabled = false`）。注意 yolo 模式会跳过整个权限层，此兜底仅在非 yolo 时有效：

```toml
[permissions]
enabled = true
rules = [
  { action = "*",  resource = "*",                effect = "ask" },      # 兜底
  { action = "bash", resource = "*",              effect = "allow" },
  { action = "read", resource = "<worktree_root>/**", effect = "allow" },
  { action = "read", resource = "<workspace_root>/**", effect = "deny" },   # 主副本禁写
  { action = "write", resource = "<workspace_root>/**", effect = "deny" },
  { action = "external_directory", resource = "*", effect = "ask" },
]
```

`<worktree_root>` / `<workspace_root>` 由插件按 `[paths]` 配置渲染（配置里写 `{worktree_root}` / `{workspace_root}` 占位符亦可）。

### 4.7 部署

- 插件放 opencode 用户级全局插件目录（实现时验证 `plugin/loader.ts` 加载路径）。
- 配置文件放 `~/.config/opencode-relay/config.toml`（示例见仓库 `config.example.toml`），环境变量 `OPENCODE_RELAY_CONFIG` 可覆盖路径。
- cc-connect 配置：`[projects.agent.options] work_dir = "<config.home>"`、`mode = "yolo"`。零代码改动。
- 主副本布局：`<workspace_root>/<project>` 为项目主 git 仓库（干净基线），由管理员/用户维护。

### 4.8 worktree 清理（P3，7 天不活跃回收）

**背景（实证）**：会话历史存储在 SQLite DB（V1 message/part 表），与 worktree 目录完全独立。实测 `git worktree remove --force` 删除源码目录后，会话历史完整保留（消息数不变）。因此回收 worktree 不会丢失任何对话，会话随时可恢复（下次 `switch_project` 重建 worktree）。

**触发方式**：定时任务（opencode 插件无内置 cron，用 `setInterval` 或 cc-connect cron 调用管理接口）。建议独立于会话生命周期运行，低频（每日一次）。

**回收算法**（按 worktree 目录 mtime 或 state 文件记录的最后活动时间筛 7 天不活跃）：

```
for each worktree in <worktree_root>/<project>/*:
    if mtime(worktree) > 7 天前:  continue        # 活跃，跳过
    git -C <repo> worktree remove --force <worktree>
    rm state/<sessionID>.json                     # 同步清状态，防复用指向已删目录
```

**关键约束**：
1. **清理必须两步走**：`git worktree remove --force`（清 git 元数据 + 目录）+ 同步删除对应 state 文件。只删目录会留 git 注册残影；只删 state 会留孤儿 worktree。
2. **活跃判定**：worktree 目录 mtime 会随 Agent 操作更新（bash/read/write 都写文件）；state 文件可作为辅助信号。7 天阈值可配置（`[worktree] stale_days = 7`）。
3. **不清理主副本**：`<workspace_root>/<project>` 是干净基线，不在回收范围。
4. **并发安全**：回收与 `switch_project` 可能竞态（会话恰好在 resume）。对策：回收前检查 state 文件是否仍指向该 worktree；会话 resume 时 `switch_project` 复用逻辑发现 workdir 不存在则自动重建（幂等）。

**归并衔接**：回收前若分支有未归并改动（7 天内分支应有 push/PR 提示已完成，见 4.9），回收即丢弃该 worktree 分支；有保留价值的分支应已 push 到远程，本地 worktree 可安全删除。

### 4.9 分支归并（P3，会话结束策略）

**背景**：会话的改动全部落在 `<branch_prefix><sessionID 全量 sanitized>` 分支（worktree 内），主副本保持干净。会话结束（`dispose` hook）时按 `[worktree].end_of_session` 决定分支去向。

**三种策略**（`end_of_session`，默认 `keep`）：

| 策略 | 行为 | 适用 |
|---|---|---|
| `keep` | 保留 worktree + 分支，仅日志记录 | 默认；用户手动 review/merge |
| `push` | `git push -u <remote> <branch>`（仅推送，不创建 PR） | 自动化收尾 |
| `cleanup` | `git worktree remove --force`（分支保留在 git 元数据） | 丢弃型会话 |

**push 策略细节**：
1. `dispose` 时读 `<config.state_dir>/<sessionID>.json`，取 `project_id` + `workdir`。
2. 在 worktree 目录执行 `git push -u <remote> <branch>`（remote 取 `[worktree].remote`，默认 `origin`）。仓库无远程或 push 失败：降级为 `keep` 并记录日志，不丢失任何改动。
3. push 成功后仅记录日志；不创建 PR、不生成提示文本（决策：推送即达，PR 由用户/Git 平台侧自行创建）。
4. 归并后 worktree 按 `keep`/`cleanup` 策略继续（push 只负责远程归并，不隐含清理）。

**与 4.8 清理的关系**：7 天回收只动本地 worktree 目录；若分支已 push（`end_of_session=push` 或手动），回收是安全的。未 push 的分支回收即丢失（预期行为，文档 4.8 已标注）。

**多会话隔离**：每会话独立 state 文件 + 独立分支 + 独立 worktree，dispose 只处理本会话的 state 与 worktree，互不干扰。这是 P3 的验证目标之一。

---

## 5. 防绕过分析与边界

### 5.1 威胁模型

Agent 不是恶意攻击者，而是"会犯错、可能被提示误导"的协作者。防护目标是**防止误操作造成的项目污染与主副本破坏**，不是对抗刻意对抗的敌手。

### 5.2 三层防线（从内到外）

1. **提示词约束**（最弱）：system.transform 每轮注入"当前项目 + 必须用 workdir + 不要碰主副本"，纠正 Agent 的无意识路径误用。
2. **插件硬拦截**（主防线）：`tool.execute.before` 校验 bash workdir / 文件操作路径是否在当前 worktree 内，越界即拒绝。未切项目（无 state）时 worktree 边界无定义，但**默认 deny 集（`workspace_root/**` 主副本）在任何状态下都生效**——Agent 在 home 内自由活动，却碰不到主副本，必须 `switch_project` 才能合法进入项目。这是活接口，yolo 模式下依然生效。
3. **权限规则兜底**（最后防线）：permissions Ruleset 对 worktree allow、主副本 deny、其余 ask。注意 yolo 会跳过，属可选加固。

### 5.3 诚实的边界（做不到的）

- **无法绝对防绕过**：Agent 有 bash 全权限，可以 `cd` 到任意路径、直接 `git` 操作主副本、改配置文件。任何"限制"对全权限 shell 都是软约束。
- **主副本靠工具层 deny + 软约束双层保护**：插件默认 deny 集含 `workspace_root/**`，无状态（未切项目）与已切项目时均生效——read/write/edit/apply_patch/bash workdir/cd 目标命中主副本即被拦截。缓解：worktree 分支与主副本分开后，主副本损坏可用 git 恢复；权限规则 deny 主副本（非 yolo 下有效）属 P3 加固。
- **list_project 不暴露路径的价值**：不是"防 Agent"，而是**减少无意识误用**——Agent 根本不知道主副本路径，只能通过 switch_project 拿到合法 worktree 目录。
- **worktree 分支归属**：分支命名依赖 sessionID 唯一性（天然保证）；但用户需理解"每个会话一个分支"，避免误把多个会话改动合到同一分支。

---

## 6. 实现阶段

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| **P1** | 插件骨架：`list_project`（只返回 id/name）+ `switch_project`（注册表 + 无条件 worktree + current 状态）+ `system.transform` 注入 + `tool.execute.before` workdir 校验 | `opencode run` 里手动切项目，确认 worktree 创建、注入与拦截生效 |
| **P2** | cc-connect 桥接验证：`work_dir = home` + `mode = "yolo"`，企微消息驱动切换；并发验证（两个企微会话切同一项目，各自独立 worktree 分支） | 企微对话中两会话切同一项目，验证隔离与互不干扰 |
| **P3** | worktree 生命周期完善（会话内复用、dispose 清理/保留策略、**7 天不活跃回收**，见 4.8）+ 分支归并（push + PR 提示，见 4.9）+ 主副本 deny 加固 + 多会话状态隔离验证 | 会话回收后 worktree 按策略处理；7 天不活跃 worktree 被回收且历史保留；分支可归并 |

每阶段独立可验证，P1 是地基。

---

## 7. 已知限制与风险

1. **bash cd 不跨消息**：进程级状态，跨消息必然丢失；正确形态就是 workdir 参数 + 状态注入。不要试图让 cd 保持。
2. **状态与工作目录脱钩**：switch_project 只声明状态，Agent 必须遵守 workdir 约定；不遵守时 tool.execute.before 拦截兜底。
3. **防绕过的软约束本质**：全权限 bash 下无法绝对防绕过，防护目标是防误操作（见 5.3）。
4. **yolo 全局无 per-session 权限**：cc-connect agent 级全局配置（`config.example.toml:1690`），多项目共用同一开放权限。
5. **V2 会话无 metadata**：会话状态必须落外部文件，需处理并发写与清理。
6. **worktree 创建成本**：每次新建 worktree 是完整 checkout，大仓库首次切换有成本；会话内复用已有 worktree 缓解。
7. **worktree 分支归并**：会话结束后的分支合并回主仓库是开放项（P3），需设计 merge/push + PR 策略。
8. **插件分发**：需确认用户级全局插件目录加载路径（`plugin/loader.ts`）。
9. **不再需要接力**：常驻 home 会话方案已消解 fork/move-session 复杂度；若未来要真接力，改 `session.ts:697` 一行（见 2.6）。

---

## 8. 关键技术参考

- cc-connect 源码：`/tmp/opencode/cc-connect-src`（v1.4.1，GitHub chenhg5/cc-connect，MIT）
  - work_dir/mode 配置：`config.example.toml:1688-1690`
  - opencode adapter：`agent/opencode/`（session.go:92,159-192,510-512 / opencode.go:463-482）
  - 会话隔离与回收：`core/engine.go:3887,3893-3917`
- opencode 源码：`/tmp/opencode/src`（v1.18.5）
  - 工具注册：`packages/opencode/src/tool/registry.ts:194-199`
  - bash workdir 语义：`packages/opencode/src/tool/shell.ts:612-614`、`shell/prompt.ts:227-228`；V2 bash：`packages/core/src/tool/bash.ts:129-149`
  - system.transform：`packages/opencode/src/plugin/index.ts:291-296`、`session/llm/request.ts:69-73`
  - tool.execute.before：`plugin/index.ts:266-269`
  - worktree 服务：`packages/opencode/src/worktree/index.ts:119-126,216-221,388-449`；端点 `groups/experimental.ts:90-102,176-223`
  - sandbox 登记：`project.ts:417-432`；containsPath：`instance-context.ts:18-24`
  - 权限规则：`packages/core/src/permission.ts:76-86`、`schema/src/permission.ts:54-64`
  - external_directory：`tool/external-directory.ts:15-45`
  - 插件加载：`plugin/index.ts:110-120`、`plugin/loader.ts`
  - fork 落点：`session/session.ts:697-698`
- openchamber 源码：`node_modules/@openchamber/web/server/lib/git/`
  - worktree 自研实现：`service.js:1484,3773-3850,3890,3980`；列表：`getWorktrees` 3539、`listWorktreeEntries` 1494
  - 端点：`routes.js:1020-1120`（GET/POST/DELETE /api/git/worktrees、validate、preview、bootstrap-status）
