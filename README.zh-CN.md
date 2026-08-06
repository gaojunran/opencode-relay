# opencode-relay

一个 [opencode](https://opencode.ai) 插件，把一个常驻会话变成多项目开发中心。Agent 停留在一个"home"会话中，通过显式的 `switch_project` 工具切换项目。每次切换都会为当前会话创建一个独立的 git worktree，多个会话可以零锁并行工作在同一项目上。

> **当前状态**：活跃开发中。`list_project`、`switch_project`、worktree 生命周期、防绕过拦截与清理已实现并通过测试；cc-connect（企微桥接）集成已规划。

## 为什么

- **一个会话，多个项目**：不用为每个项目开新会话、也不用折腾 `/dir`。Agent 调用 `switch_project` 就能拿到真实的工作目录。
- **多会话零冲突**：每次切换创建独立的 git worktree，分支唯一（`opencode/<sessionID>`）。无共享工作区、无锁文件。`~/workspace/<project>` 主副本永远干净。
- **设计上防误操作**：`list_project` 从不暴露项目路径，Agent 无法无意中写主副本；`tool.execute.before` 硬拦截所有逃逸当前 worktree 的 bash/文件操作（yolo 模式下依然生效）。
- **IM 友好**：为对接 cc-connect 设计——cc-connect 把企微对话桥接为固定 home 的 opencode 会话（`work_dir = home`、`mode = "yolo"`），项目路由完全由本插件承担。

## 功能

- `list_project` — 只返回 `{id, name}`（可选 `description`）；仓库路径对 Agent 不可见。
- `switch_project({project_id})` — 无条件创建（或复用）专属 git worktree，返回其路径作为新工作目录。
- `cleanup_worktrees({dry_run})` — 回收超过 `stale_days`（默认 7 天）不活跃的 worktree；数据库中的会话历史不受影响。
- 每轮上下文注入（`experimental.chat.system.transform`）— 提醒 Agent 当前项目、工作目录与分支。
- 硬拦截（`tool.execute.before`）— 拒绝超出当前 worktree 的 bash `workdir` 或文件路径（与 yolo 模式无关）。
- 会话结束策略（`dispose`）— `keep`（默认）/ `push` 到配置的 remote / `cleanup` 删除 worktree。
- opt-out 短路 — 会话目录不在 `[general].home`（默认 `$HOME`）内时插件拒绝加载。
- 全配置驱动 — 单一 `config.toml`（可用 `OPENCODE_RELAY_CONFIG` 覆盖默认路径）。

## 架构

```
企微用户/群
   │  WS 智能机器人
   ▼
cc-connect（v1.4.1，零改动）
   ├─ work_dir = home                 固定 home 会话
   ├─ mode = "yolo"                   无权限打扰
   └─ 每个 IM 会话键独立 opencode session，--session 续接
   ▼
opencode run（cc-connect spawn 的 in-process server）
   └─ opencode-relay（本插件）
        ├─ list_project()             只有 id/name，无路径
        ├─ switch_project(id)         无条件 per-session worktree
        ├─ system.transform           每轮注入当前项目
        ├─ tool.execute.before        防逃逸硬拦截
        ├─ dispose                    会话结束：keep / push / cleanup
        └─ 配置: ~/.config/opencode-relay/config.toml
            状态: ~/.opencode/state/<sessionID>.json
   ▼
~/workspace/<project>                 干净主副本，Agent 永不直接写
```

会话状态保存在外部文件（`~/.opencode/state/<sessionID>.json`），因为 V2 opencode 会话没有 metadata 通道。状态按会话隔离，多个 IM 会话互不串台。

## 安装

1. 将插件克隆或复制到 opencode 用户级插件目录，例如 `~/.config/opencode/plugin/opencode-relay/`（按你的 opencode 版本确认加载路径）。
2. 创建配置文件：

```bash
mkdir -p ~/.config/opencode-relay
cp config.example.toml ~/.config/opencode-relay/config.toml
# 按你的项目修改
```

3. （可选）对接 cc-connect：在其配置中设置 `[projects.agent.options] work_dir = "<home>"` 和 `mode = "yolo"`。cc-connect 无需任何代码改动。

## 配置

完整带注释的示例见 [config.example.toml](config.example.toml)。所有配置节：

| 节 | 用途 |
|---|---|
| `[general]` | `enabled`、`home`（默认 `$HOME`，opt-out 边界）、`log_level`（`debug`/`info`/`warn`/`error`） |
| `[paths]` | `workspace_root`（干净主副本）、`worktree_root`、`state_dir` |
| `[projects]` | 显式 `items[]`（推荐）或 `scan_dir` 自动扫描含 `.git` 的子目录 |
| `[worktree]` | `branch_prefix`（默认 `opencode/`）、`end_of_session`、`remote`、`stale_days` |
| `[inject]` | 每轮上下文模板，占位符 `{project_id}` `{project_name}` `{workdir}` `{branch}` |
| `[guard]` | `reject_on_violation`、额外 `deny_paths` / `allow_paths` glob 模式 |
| `[permissions]` | 可选权限规则兜底（`yolo` 下被跳过） |
| `[list]` | `list_project` 是否返回 `description` |

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
