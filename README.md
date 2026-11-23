# fleet / desk

**desk** turns remote engineering machines into Claude Code tools. Claude Code runs on a small control host (a VPS); each Windows PC runs **desk-node**; the desk plugin gives every Claude Code session on the VPS tools that act on those PCs — in any directory, with no per-project setup.

desk 把远程工程机变成 Claude Code 的工具：Claude Code 跑在一台控制机（VPS）上，每台 Windows 工程机跑 desk-node，装好 desk 插件后，VPS 上任意目录里的 Claude Code 会话都能直接读写、搜索、运行命令、传文件。

```
Claude Code (VPS, any directory)
   └─ desk plugin → desk gateway (stdio MCP, one per session)
         └─ tailnet HTTPS/HTTP + token → desk-node on each Windows PC
```

## Tools

| Tool | What it does |
|---|---|
| Read · Write · Edit | Files on the machine (encoding, BOM and line endings kept; Write/Edit need a Read of any part first) |
| Glob · Grep | Find files, ripgrep contents |
| Bash | Run a command (Git Bash, cmd or PowerShell); long output is summarized and archived |
| Copy | One file between the VPS and a machine, SHA-256 verified, previous target backed up (≤ 50 MiB towards the VPS) |
| BashJob *(on demand)* | Background jobs that survive restarts |
| Machines *(on demand)* | Status, OS, shell, RTT; Git checkpoints and restore; restart and upgrade desk-node |

Every tool takes an optional `machine`. Safety on the machine: `denyPaths` and desk-node's own data are unreachable; the first change a session makes to a Git repository is preceded by an automatic checkpoint.

## Commands

| Command | |
|---|---|
| `/desk:status` | This directory's binding, whether desk is on here, machine health |
| `/desk:use <machine> [dir]` | Bind this directory to a machine and folder (writes `./.desk.json`; applies immediately) |
| `/desk:off` · `/desk:on` | Turn desk off/on for this directory. Off denies the tools at once and stops loading the plugin in new sessions here, so its tool descriptions cost nothing |
| `/desk:handoff start · to codex · take · status` | Pass a task back and forth with an agent on the machine (see below) |
| `/desk:help` | Short usage guide |

Without a binding, calls go to the `default` machine in `machines.json` and its `defaultDir`. The same switches exist in a shell: `desk status | use <machine> [dir] | unbind | off | on`, and `desk-copy <from> <to>` for scripts.

## Handoff between agents

`/desk:handoff` passes one task in a Git repository on a machine between Claude (on the VPS) and an agent there (Codex for now), as many times as needed: A → B → A → …

- **Each agent resumes its own session** (`codex exec resume`, the Claude session you are in), so a returning agent still has its full context and only needs what changed while it was away.
- **One note per hop.** The outgoing agent writes a short note (done, state, tried and dropped, decisions, next) into `.handoff/outbox.md`; the script appends it to `.handoff/log.md` with who, when, which session and which snapshot range.
- **Snapshots, not summaries, for the facts.** Each hop commits the whole working tree to `refs/handoff/<n>` (the branch, index and stash are untouched), so the receiver checks the note against `git diff refs/handoff/<a> refs/handoff/<b>`.
- **Transcripts by reference.** Codex runs are saved under `.handoff/runs/`; entries point to them for lookups instead of passing them along.
- **One owner at a time**, recorded in `.handoff/state`; `.handoff/` is excluded from Git.

The machine side is a single Git Bash script, [handoff/handoff.sh](handoff/handoff.sh), copied into `.handoff/`; any agent can follow `.handoff/README.md`.

## Install

### 1. Control host (Ubuntu/Debian VPS)

Prerequisites: Tailscale (the VPS and the PCs on one tailnet), Node 24, Claude Code.

```sh
git clone https://github.com/wenzhuofu/fleet ~/fleet/desk-fleet
cd ~/fleet/desk-fleet && cp kit/fleet.conf.example kit/fleet.conf   # optional edits
kit/bootstrap-vps.sh kit/fleet.conf
```

Bootstrap installs Node 24 and Claude Code if missing, writes `~/fleet/machines.json`, installs the desk plugin from this checkout, puts `desk` and `desk-copy` on PATH, and runs `kit/fleet-doctor.sh`. It also installs the optional [Orca](https://github.com/stablyai/orca) server for desktop/phone access and a daily `/tmp` cleanup timer.

Only the plugin, on an existing Claude Code setup:

```sh
claude plugin marketplace add wenzhuofu/fleet
claude plugin install desk@fleet
```

The plugin needs Node 24 (`~/opt/node24/bin/node`, `node` on PATH, or `DESK_NODE`) and a `machines.json` (`DESK_MACHINES`, else `~/.config/desk-fleet/machines.json`, else `~/fleet/machines.json`).

### 2. A Windows machine

On the VPS run `kit/new-machine.sh start <name>` and follow the printed PowerShell steps (download, `join-machine.ps1`, then `kit/new-machine.sh finish …`). It installs desk-node as a scheduled task, publishes it on the tailnet, transfers its token and adds the machine to `machines.json`. Details: [kit/SETUP.md](kit/SETUP.md).

`machines.json`:

```json
{
  "default": "pc-home",
  "machines": {
    "pc-home": { "url": "http://<pc>.<tailnet>.ts.net:7801", "tokenFile": "~/.config/desk-fleet/tokens/pc-home.token",
                 "os": "windows", "defaultDir": "D:\\git", "ssh": "pc-home" },
    "vps": { "local": true, "os": "linux" }
  }
}
```

`ssh` (optional) is an out-of-band alias used for diagnostics and `Machines restart`.

## Repository

| Path | |
|---|---|
| `.claude-plugin/`, `commands/`, `skills/`, `bin/` | The Claude Code plugin and its launchers |
| `handoff/` | Machine-side script for `/desk:handoff` |
| `packages/gateway` | stdio MCP gateway: tool definitions, binding, forwarding, Copy |
| `packages/node` | desk-node (Windows service): files, search, commands, output archive, checkpoints, transfers |
| `deploy/node` | Windows build, install and service scripts |
| `kit` | Bootstrap, update, doctor and machine-join scripts |

Tests: `cd packages/gateway && node --test test/*.test.mjs`; `cd packages/node && npm ci && node --test test/unit/*.test.mjs`; `python3 -m unittest discover -s tests` (includes the handoff script, with a stub Codex).

Nothing secret lives in the repository: tokens stay in `~/.config/desk-fleet/tokens/` (0600) and on each machine under `C:\desk-node\data`.
