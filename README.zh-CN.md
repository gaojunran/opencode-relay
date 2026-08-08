# opencode-relay

[**English**](README.md)

**一个常驻会话，多个项目，零冲突。**

opencode-relay 是一个 [opencode](https://opencode.ai) 插件，把单个 home 会话变成多项目开发中心。Agent 从不离开会话、也从不直接碰主副本：每次 `switch_project` 都给它一个专属 git worktree，主副本永远保持干净，工具层守卫让它物理上无法越界。

专为 IM 驱动的 Agent 设计（cc-connect 桥接企微对话，`work_dir = home`、`mode = "yolo"`），在任何 opencode 会话中同样可用。

## 核心能力

### 1. 不离开会话即可切换项目

Agent 调用 `switch_project({project_id})` 就能拿到真实的工作目录。无需新开会话、无需 `/dir`、无需折腾 cwd。

- `list_project` — 只返回 id/name；**仓库路径对 Agent 不可见**
- `switch_project` — 无条件为每个会话创建（或复用）专属 worktree
- `register_project({dir})` — 从任意 git 仓库注册新项目：校验仓库、拒绝重复 remote、移入 workspace
- `leave_project` — 回到未绑定状态；worktree 保留，再次进入时复用

### 2. 主副本不可触碰

workspace 根（`~/workspace/<project>`）是干净基线，Agent **永远不会写入**。隔离在工具层强制，而非靠提示词：

- 每次切换创建独立 worktree，分支唯一（`opencode/<sessionID>`）——无共享工作区、无锁文件，多会话并行零冲突
- `tool.execute.before` 守卫拒绝所有逃逸当前 worktree 的 bash/文件调用——**包括 bash 命令内的 `cd` 目标**——yolo 模式下依然生效
- workspace 根在任何会话状态下都被 deny，即使尚未切换项目

### 3. 宽容而非只会拦截

守卫优先修正调用而非拒绝，Agent 可以自然地工作：

- 相对文件路径按 **worktree** 解析（而非会话目录）并自动改写为绝对路径
- `bash` 未显式 `workdir` 时默认落在 worktree 内
- 逃逸 worktree 的 `cd` 目标（裸 `cd`、`cd ..`、`/etc` 等）带提示拒绝
- 额外的 `deny_paths`/`allow_paths` glob 与 `allow_dirs`（如 `/tmp`）可调可达范围

### 4. 项目上下文随切换恢复

因为会话目录从不改变，per-directory 的加载（AGENTS.md、skills、环境变量 hook）会静默失效。relay 把它恢复回来：

- 每轮 `system.transform` 注入当前项目、工作目录与分支；未绑定状态则注入项目清单并引导 switch/register
- 切换后注入 worktree 根的 **AGENTS.md**（或 CLAUDE.md/CONTEXT.md）
- 列出项目 **skills**，供 Agent 用 skill 工具加载
- 可选的 `on_switch` 命令数组（如 `["mise env", "direnv export bash"]`）dump 环境变量，合并后经 `shell.env` 注入每次 bash 调用

### 5. 子代理默认安全

task 派生的子代理拿到干净上下文和独立 sessionID。relay 让它们继承父会话的项目状态、但**无法修改**它：

- guard、上下文注入、环境变量在子代理内按**父会话的 worktree** 生效
- `switch_project` / `leave_project` / `register_project` / `cleanup_worktrees` 对**子代理会话一律拒绝**
- 子代理活跃期间父会话不能切换项目——不产生孤儿 worktree，并行子代理之间无状态竞态

## 工作原理

```
企微用户/群
   │  WS 智能机器人
   ▼
cc-connect（零改动）
   ├─ work_dir = home                 固定 home 会话
   ├─ mode = "yolo"                   无权限打扰
   └─ 每个 IM 会话键独立 opencode session，--session 续接
   ▼
opencode run（cc-connect spawn 的 in-process server）
   └─ opencode-relay（本插件）
        ├─ switch_project(id)         无条件 per-session worktree
        ├─ register_project(dir)      注册新 git 项目进 workspace
        ├─ leave_project()            退出项目，回到未绑定状态
        ├─ system.transform           每轮注入项目清单 / 当前项目
        ├─ tool.execute.before        硬拦截 + 路径改写 + cd 拦截
        ├─ shell.env                  每次 bash 恢复项目环境（on_switch）
        ├─ dispose                    会话结束：keep / push / cleanup
        └─ 配置: ~/.config/opencode-relay/config.toml
            状态: ~/.opencode/state/<sessionID>.json
   ▼
~/workspace/<project>                 干净主副本，Agent 永不直接写
```

会话状态按 sessionID 存于外部文件，多个 IM 会话互不串台。会话结束默认 `keep`；`push` 自动推送当前分支（可在结束前改成语义化分支名），`cleanup` 删除 worktree。`cleanup_worktrees` 在 `stale_days` 后回收不活跃 worktree——数据库中的会话历史不受影响。

## 安装

### 通过 npm 安装（推荐）

在 opencode 配置（`~/.config/opencode/opencode.json`）中声明插件。opencode 启动时自动安装，无需手动 `npm install`：

```json
{
  "plugin": ["opencode-relay-plugin"]
}
```

然后创建配置文件：

```bash
mkdir -p ~/.config/opencode-relay
cp config.example.toml ~/.config/opencode-relay/config.toml
# 按你的项目修改
```

### 从源码安装

将插件克隆或复制到 opencode 用户级插件目录，例如 `~/.config/opencode/plugin/opencode-relay/`（按你的 opencode 版本确认加载路径），然后按上述步骤创建配置。

### 对接 cc-connect（可选）

在 cc-connect 配置中设置 `work_dir = "<home>"` 和 `mode = "yolo"`，并把插件加入 opencode 的 `plugin` 数组。cc-connect 无需任何代码改动。

## 配置

完整带注释的示例见 [config.example.toml](config.example.toml)。所有配置节：

| 节 | 用途 |
|---|---|
| `[general]` | `enabled`、`home`（默认 `$HOME`，opt-out 边界）、`log_level`、`log_file`（logfmt、按天轮转） |
| `[paths]` | `workspace_root`（干净主副本）、`worktree_root`、`state_dir` |
| `[projects]` | 显式 `items[]`（推荐）或 `scan_dir` 自动扫描含 `.git` 的子目录 |
| `[worktree]` | `branch_prefix`、`end_of_session`（keep/push/cleanup）、`remote`、`stale_days`、`on_switch`（命令数组） |
| `[inject]` | 模板（占位符 `{project_id}` `{project_name}` `{workdir}` `{branch}`）、`list_projects`、`agents_md`、`skills` |
| `[guard]` | `reject_on_violation`、`deny_paths` / `allow_paths` glob、`allow_dirs`（默认 `["/tmp"]`） |
| `[permissions]` | 可选权限规则兜底（`yolo` 下被跳过） |
| `[list]` | `list_project` 是否返回 `description` |

日志以 logfmt 输出（`ts= level= logger= msg=`），可对接标准工具链（`grep 'logger=guard'`、jq、vector）。

## 搭配使用

opencode-relay 旨在与 opencode 生态中的其他插件互补，而不是替代它们：

- **[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)** — Agent 与工具链调优、工作流打磨；relay 在其之上提供项目隔离。
- **[magic-context](https://github.com/cortexkit/magic-context)** — 长期项目记忆与会话连续性；relay 在 Agent 跨项目工作时保障工作区安全。
- **[cc-connect](https://github.com/chenhg5/cc-connect)** — IM（企业微信）桥接，驱动常驻 home 目录会话；relay 把这条单一会话变成按项目隔离的独立 worktree。

三者与 relay 一样通过 opencode 配置中的同一个 `plugin` 数组加载。组合起来，你就能得到一条持久、带记忆、能在多个项目间安全工作、且只需一次 IM 对话的 Agent。

## 开发

```bash
cd plugin
bun install
bunx tsc --noEmit        # 类型检查
bun run p3-test.ts       # 多会话 worktree 隔离 e2e
bun run cleanup-test.ts  # 不活跃 worktree 回收
bun run e2e-test.ts      # 插件启动 + guard 行为
```

设置 `log_level = "debug"` 可获得详细日志：配置加载、opt-out 判定、每条 git 命令、每次 guard 拦截，出问题凭日志即可定位。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 完整设计文档，含 opencode hooks、worktree 语义、cc-connect 集成的源码实证调研。

## License

MIT
