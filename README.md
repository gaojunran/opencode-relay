# opencode-relay

[**中文**](README.zh-CN.md)

An [opencode](https://opencode.ai) plugin that turns a single persistent session into a multi-project development hub. The agent stays in one "home" session and switches between projects through an explicit `switch_project` tool. Every switch creates a dedicated git worktree per session, so multiple sessions can work on the same project in parallel without any locking.

> **Current status**: actively developed. `list_project`, `switch_project`, `register_project`, `leave_project`, worktree lifecycle, guard interception, smart path rewriting, `cd` escape blocking and cleanup are implemented and tested; cc-connect (WeCom/WeChat Work bridge) integration is planned.

## Why

- **One session, many projects**: no more creating a new session per project or juggling `/dir`. The agent calls `switch_project` and gets a real working directory back.
- **Parallel sessions, zero conflicts**: each switch creates an independent git worktree on a unique branch (`opencode/<sessionID>`). No shared working tree, no lock files. The main copy in `~/workspace/<project>` stays clean forever.
- **Agent-proof by design**: project paths are never exposed through `list_project`, so the agent cannot accidentally write to the main copy. A `tool.execute.before` hook hard-rejects any file/bash call that escapes the current worktree — including `cd` targets inside a bash command.
- **Forgiving, not just blocking**: relative paths are resolved against the project worktree (not the session directory) and rewritten to absolute paths automatically, so the agent can work naturally.
- **IM-friendly**: designed to sit behind cc-connect, which bridges WeCom conversations into fixed-home opencode sessions (`work_dir = home`, `mode = "yolo"`). The plugin does the project routing.

## Features

- `list_project` — returns only `{id, name}` (optionally `description`); repository paths stay hidden from the agent.
- `switch_project({project_id})` — unconditionally creates (or reuses) a dedicated git worktree and returns its path as the new working directory.
- `register_project({dir, id?, name?})` — registers a new project from any git repository path: validates it is a git repo, rejects duplicate remotes (already registered), moves the directory into the workspace root, and persists it in a dynamic registry.
- `leave_project()` — exits the current project and returns to the unbound state; the worktree is kept, so switching back to the same project reuses it.
- `cleanup_worktrees({dry_run})` — reaps worktrees inactive for `stale_days` (default 7); session history in the database is unaffected.
- Per-round context injection via `experimental.chat.system.transform` — before switching, injects the project list and a guide to call `switch_project`/`register_project`; after switching, injects the current project, workdir and branch.
- Smart path rewriting in `tool.execute.before` — relative paths resolve against the project worktree and are rewritten to absolute; bash without an explicit `workdir` defaults to the worktree; `cd` targets that escape the worktree (including bare `cd` and `cd ..`) are rejected with actionable messages.
- Hard guard via `tool.execute.before` — rejects bash `workdir` or file paths outside the current worktree (yolo-mode independent).
- End-of-session strategy via `dispose` — `keep` (default), `push` to a configured remote, or `cleanup` the worktree.
- Opt-out short-circuit — the plugin refuses to load when the session directory is outside `[general].home` (defaults to `$HOME`).
- Everything is config-driven through a single `config.toml` (`OPENCODE_RELAY_CONFIG` overrides the default path).

## Architecture

```
WeCom user/group
   │  WS bot
   ▼
cc-connect (v1.4.1, unmodified)
   ├─ work_dir = home                 fixed home session
   ├─ mode = "yolo"                   no permission prompts
   └─ one opencode session per IM key, resumed via --session
   ▼
opencode run (in-process server, spawned by cc-connect)
   └─ opencode-relay (this plugin)
        ├─ list_project()             ids/names only, no paths
        ├─ switch_project(id)         unconditional per-session worktree
        ├─ register_project(dir)      register a new git project into workspace
        ├─ leave_project()            exit project, back to unbound state
        ├─ system.transform           inject project list / current project each round
        ├─ tool.execute.before        hard guard + smart path rewriting + cd blocking
        ├─ dispose                    end-of-session: keep / push / cleanup
        └─ config:  ~/.config/opencode-relay/config.toml
             state: ~/.opencode/state/<sessionID>.json
   ▼
~/workspace/<project>                 clean main copy, never written by the agent
```

Session state lives in external files (`~/.opencode/state/<sessionID>.json`) because V2 opencode sessions expose no metadata channel. State is keyed per session, so multiple IM sessions never collide.

## Installation

### From npm (recommended)

Add the plugin to your opencode config (`~/.config/opencode/opencode.json`). opencode installs it automatically on startup — no manual `npm install`:

```json
{
  "plugin": ["opencode-relay-plugin"]
}
```

Then create the config file:

```bash
mkdir -p ~/.config/opencode-relay
cp config.example.toml ~/.config/opencode-relay/config.toml
# edit to match your projects
```

### From source

Clone or copy the plugin into opencode's user-level plugin directory, e.g. `~/.config/opencode/plugin/opencode-relay/`, then follow the config steps above.

### Bridge with cc-connect (optional)

Set `[projects.agent.options] work_dir = "<home>"` and `mode = "yolo"` in cc-connect's config. cc-connect needs no code changes.

## Configuration

See [config.example.toml](config.example.toml) for a fully commented example. All sections:

| Section | Purpose |
|---|---|
| `[general]` | `enabled`, `home` (default `$HOME`, opt-out boundary), `log_level` (`debug`/`info`/`warn`/`error`) |
| `[paths]` | `workspace_root` (clean main copies), `worktree_root`, `state_dir` |
| `[projects]` | explicit `items[]` (recommended) or `scan_dir` auto-scan for `.git` subdirectories |
| `[worktree]` | `branch_prefix` (default `opencode/`), `end_of_session`, `remote`, `stale_days` |
| `[inject]` | per-round context template with `{project_id}` `{project_name}` `{workdir}` `{branch}` placeholders |
| `[guard]` | `reject_on_violation`, extra `deny_paths` / `allow_paths` glob patterns |
| `[permissions]` | optional ruleset passthrough as a last-resort backstop (skipped under `yolo`) |
| `[list]` | include `description` in `list_project` output |

## Works well with

opencode-relay is designed to complement other opencode ecosystem plugins rather than replace them:

- **[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)** — agent/tooling tuning and workflow polish; relay adds project isolation on top.
- **[magic-context](https://github.com/cortexkit/magic-context)** — long-term project memory and session continuity; relay keeps the workspace safe while the agent works across projects.
- **[cc-connect](https://github.com/chenhg5/cc-connect)** — IM (WeCom/WeChat Work) bridge that drives a persistent home-directory session; relay turns that single session into per-project isolated worktrees, with the agent switching projects via `switch_project`.

All three load alongside relay through the same `plugin` array in your opencode config. Combined, they give you a persistent, memory-backed agent that safely works across multiple projects from one IM conversation.

## Development

```bash
cd plugin
bun install
bunx tsc --noEmit        # type check
bun run p3-test.ts       # multi-session worktree isolation e2e
bun run cleanup-test.ts  # stale worktree reaping
bun run e2e-test.ts      # plugin boot + guard behavior
```

Set `log_level = "debug"` to get detailed logs covering config loading, opt-out decisions, every git command, and every guard decision — enough to pinpoint issues from logs alone.

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — full design document (Chinese) with source-verified research on opencode hooks, worktree semantics and cc-connect integration.

## License

MIT
