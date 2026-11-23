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
| `/desk:handoff start · to · take · run · inbox · status` | Pass a task between agents on any machines and take it back (see below) |
| `/desk:help` | Short usage guide |

Without a binding, calls go to the `default` machine in `machines.json` and its `defaultDir`. The same switches exist in a shell: `desk status | use <machine> [dir] | unbind | off | on`, and `desk-copy <from> <to>` for scripts.

## Handoff between agents

`handoff` passes one task between participants named `agent@machine` — Claude, Codex, Antigravity or anything else, on any machine, in any direction: `claude@pc-home → codex@pc-home → agy@pc-work → claude@vps → …`. The machine is where the task's files live, so Claude on the VPS working on pc-home through desk is `claude@pc-home`.

- **The ledger is the source of truth, not agent memory.** Each hop is one commit on the hub: a snapshot of the task's files plus `state.json` (owner, status, epoch, op id, sessions), `task.md` and `log.md` (one note per hop). An agent that resumes its own session (`codex exec resume`, `claude --resume`) keeps its context and only needs what changed; one that cannot can continue from the ledger.
- **Agents only write notes.** They read `.handoff/` (README, task, log, `changes.diff`: the files changed since they last held the task) and write `.handoff/outbox.md`. `handoff` does the snapshots, checks and pushes, so agents need no CLI, network or credentials, and sandboxed agents work.
- **The hub is the authority.** A pre-receive hook lets only the owner's machine (or a hub admin) move a task, requires every transition to raise the epoch by one, and refuses force-pushes and deletes. Every operation has an op id, so retrying after a lost push response does not hand off twice.
- **It never overwrites work.** Snapshots use a private Git directory (`~/.handoff/repo.git`): the project's own `.git`, branch, index and stash are untouched, and plain folders work too. `take` stops if the directory has changes it did not sync, or if a new directory is not empty.
- **It keeps things out.** `.env*`, keys, credentials files, `node_modules`, virtualenvs and caches are never snapshotted (add more in `.handoffignore`; `.gitignore` applies too); new content is scanned for private keys and tokens, and per-file and total sizes are capped.
- **Launching is optional.** `handoff run` starts or resumes an agent from a launcher (built in: codex, claude; others in `~/.handoff/config.json`) and hands the task back when it stops. Without a launcher, the user opens the agent and tells it to take the handoff.

```sh
handoff start fix-login --as claude --dir D:/git/app      # you own it; fill .handoff/task.md
handoff pass fix-login codex@pc-home --as claude          # note from .handoff/outbox.md
handoff take fix-login --as codex && handoff run fix-login --then claude@pc-home
handoff inbox                                            # on any machine: tasks waiting there
handoff take fix-login --as claude                        # prints what is new; .handoff/changes.diff
```

Setup: one hub, e.g. on the VPS: `handoff hub-init ~/handoff/hub.git --admins vps`. Each machine: `handoff setup --machine <name> --hub <url> --root <dir for received tasks>`; a remote machine reaches the hub with its own SSH key restricted in `authorized_keys` to `command="python3 ~/handoff/hub.git/hooks/handoff.py serve <machine> ~/handoff/hub.git",restrict`, which also fixes its identity. Needs Python 3 and Git. The client is the single file [handoff/handoff.py](handoff/handoff.py).

Not yet: leases and heartbeats for long runs, a runner that picks up tasks automatically, and parallel work on one task.

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
| `handoff/` | The `handoff` client and hub hook (`/desk:handoff`) |
| `packages/gateway` | stdio MCP gateway: tool definitions, binding, forwarding, Copy |
| `packages/node` | desk-node (Windows service): files, search, commands, output archive, checkpoints, transfers |
| `deploy/node` | Windows build, install and service scripts |
| `kit` | Bootstrap, update, doctor and machine-join scripts |

Tests: `cd packages/gateway && node --test test/*.test.mjs`; `cd packages/node && npm ci && node --test test/unit/*.test.mjs`; `python3 -m unittest discover -s tests` (includes handoff: three simulated machines, a real hub and a stub Codex).

Nothing secret lives in the repository: tokens stay in `~/.config/desk-fleet/tokens/` (0600) and on each machine under `C:\desk-node\data`.
