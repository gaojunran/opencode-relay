# opencode-relay

[**中文**](README.zh-CN.md)

**One persistent session, many projects, zero conflicts.**

opencode-relay is an [opencode](https://opencode.ai) plugin that turns a single home session into a multi-project development hub. The agent never leaves its session and never touches a main copy: every `switch_project` gives it a dedicated git worktree, the main copy stays clean forever, and a tool-level guard makes it physically impossible to escape.

It is designed for IM-driven agents (WeCom/WeChat Work via cc-connect, `work_dir = home`, `mode = "yolo"`), but works the same in any opencode session.

## Core capabilities

### 1. Switch projects without leaving the session

The agent calls `switch_project({project_id})` and gets a real working directory back. No new session, no `/dir`, no cwd gymnastics.

- `list_project` — ids/names only; **repository paths stay invisible to the agent**
- `switch_project` — unconditionally creates (or reuses) a dedicated worktree per session
- `register_project({dir})` — registers any git repository: validates it, rejects duplicate remotes, moves it into the workspace
- `leave_project` — back to the unbound state; the worktree is kept and reused on re-entry

### 2. The main copy is untouchable

The workspace root (`~/workspace/<project>`) is a clean baseline that the agent **never** writes to. Isolation is enforced at the tool layer, not by prompting:

- Every switch creates an independent worktree with a unique branch (`opencode/<sessionID>`) — no shared working tree, no lock files, parallel sessions conflict-free
- A `tool.execute.before` guard rejects any file/bash call that escapes the current worktree — **including inside `cd` targets** — and works under `yolo` mode
- The workspace root is denied in every session state, even before any project is switched

### 3. Forgiving, not just blocking

The guard prefers fixing the call over rejecting it, so the agent works naturally:

- Relative file paths are resolved **against the worktree** (not the session directory) and rewritten to absolute automatically
- `bash` without an explicit `workdir` defaults to the worktree
- `cd` targets that escape the worktree (bare `cd`, `cd ..`, `/etc`, ...) are rejected with actionable messages
- Extra `deny_paths`/`allow_paths` globs and `allow_dirs` (e.g. `/tmp`) tune what stays reachable

### 4. Project context follows the switch

Because the session directory never changes, per-directory loading (AGENTS.md, skills, env hooks) would silently break. relay restores it:

- Each round, `system.transform` injects the current project, workdir and branch — or the project list + a guide to switch/register when unbound
- The worktree-root **AGENTS.md** (or CLAUDE.md/CONTEXT.md) is injected after switching
- Project **skills** are listed so the agent can load them
- Optional `on_switch` commands (an array, e.g. `["mise env", "direnv export bash"]`) dump env vars that are merged and injected into every `bash` call via `shell.env`

### 5. Subagent-safe by default

Task-spawned subagents get a clean context and their own sessionID. relay makes them inherit the parent's project state without being able to mutate it:

- Guard, context injection and env work inside subagents against the **parent's** worktree
- `switch_project` / `leave_project` / `register_project` / `cleanup_worktrees` are **rejected for subagent sessions**
- The parent cannot switch projects while a subagent is still active — no orphan worktrees, no state races between parallel subagents

## How it works

```
WeCom user/group
   │  WS bot
   ▼
cc-connect (unmodified)
   ├─ work_dir = home                 fixed home session
   ├─ mode = "yolo"                   no permission prompts
   └─ one opencode session per IM key, resumed via --session
   ▼
opencode run (in-process server, spawned by cc-connect)
   └─ opencode-relay (this plugin)
        ├─ switch_project(id)         unconditional per-session worktree
        ├─ register_project(dir)      register a new git project into workspace
        ├─ leave_project()            exit project, back to unbound state
        ├─ system.transform           inject project list / current project each round
        ├─ tool.execute.before        hard guard + path rewriting + cd blocking
        ├─ shell.env                  restore project env (on_switch) per bash call
        ├─ dispose                    end-of-session: keep / push / cleanup
        └─ config:  ~/.config/opencode-relay/config.toml
             state: ~/.opencode/state/<sessionID>.json
   ▼
~/workspace/<project>                 clean main copy, never written by the agent
```

Session state lives in external files keyed per sessionID, so multiple IM sessions never collide. End-of-session is `keep` by default; `push` auto-pushes the current branch (so you can rename it to something semantic before finishing) and `cleanup` removes the worktree. `cleanup_worktrees` reaps stale worktrees after `stale_days` — session history in the database is unaffected.

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

Set `work_dir = "<home>"` and `mode = "yolo"` in cc-connect's config, and add the plugin to opencode's `plugin` array. cc-connect needs no code changes.

## Configuration

See [config.example.toml](config.example.toml) for a fully commented example. All sections:

| Section | Purpose |
|---|---|
| `[general]` | `enabled`, `home` (default `$HOME`, opt-out boundary), `log_level`, `log_file` (logfmt, daily-rotated) |
| `[paths]` | `workspace_root` (clean main copies), `worktree_root`, `state_dir` |
| `[projects]` | explicit `items[]` (recommended; per-item `base_branch` fork point — the main copy is checked out to it after each fork — `fetch` remotes before worktree creation (default on), `on_switch` project-level env commands) or `scan_dir` auto-scan for `.git` subdirectories |
| `[worktree]` | `branch_prefix`, `end_of_session` (keep/push/cleanup), `remote`, `stale_days`, `on_switch` (command array), `checkout_main_copy` (check out the main copy to the base ref after each fork, default true) |
| `[inject]` | template with `{project_id}` `{project_name}` `{workdir}` `{branch}`, `list_projects`, `agents_md`, `skills` |
| `[guard]` | `reject_on_violation`, `deny_paths` / `allow_paths` globs, `allow_dirs` (default `["/tmp"]`) |
| `[permissions]` | optional ruleset passthrough as a last-resort backstop (skipped under `yolo`) |
| `[list]` | include `description` in `list_project` output |

Logs are emitted as logfmt (`ts= level= logger= msg=`) so they compose with standard tooling (`grep 'logger=guard'`, jq, vector).

## Works well with

opencode-relay complements other opencode ecosystem plugins rather than replacing them:

- **[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)** — agent/tooling tuning and workflow polish; relay adds project isolation on top.
- **[magic-context](https://github.com/cortexkit/magic-context)** — long-term project memory and session continuity; relay keeps the workspace safe while the agent works across projects.
- **[cc-connect](https://github.com/chenhg5/cc-connect)** — IM (WeCom/WeChat Work) bridge that drives a persistent home-directory session; relay turns that single session into per-project isolated worktrees.

All three load alongside relay through the same `plugin` array. Combined, they give you a persistent, memory-backed agent that safely works across multiple projects from one IM conversation.

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

## Known Limitations

- **Branch checked out by another worktree fails to switch**: git worktrees enforce that a branch can be checked out by only one worktree at a time. A manual `git checkout <branch>` fails whenever that branch is currently checked out by any worktree — even an inactive one. This is a hard git constraint, not a plugin bug. A future improvement is planned so that at least inactive worktrees do not block the switch.

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — full design document (Chinese) with source-verified research on opencode hooks, worktree semantics and cc-connect integration.

## License

MIT
