---
name: desk
description: Rules for working on remote engineering machines with the desk tools (mcp__plugin_desk_desk__*). Use whenever a task reads, edits, searches or runs commands on a machine such as pc-home, moves files between the VPS and a machine, or a desk tool reports an error.
---

# Working with desk

The desk tools act on a remote machine, not on the VPS. The built-in Read, Edit and Bash tools act on the VPS.

- **Where calls go.** Without `machine`, a call goes to this directory's binding (`.desk.json`, set with `/desk:use`) or else machines.json's default machine. Relative paths and Bash's default cwd are that machine's bound folder.
- **Keep the VPS light.** Build, test and analyse on the machine; bring back only small results. Do not copy repositories or big data to the VPS. Copy is for single files (max 50 MiB towards the VPS).
- **Read before writing.** Write and Edit need a Read of any part of the file first, and fail if it changed since. Read several files in one message (they run in parallel); Grep large files first, then Read a range.
- **Bash.** Each call is a fresh shell (Git Bash on Windows; `shell` selects cmd or powershell). cd and variables do not persist; processes still running 1 s after exit are killed: use BashJob for servers, watchers and long builds. Long output is summarized and archived: Grep or Read the archive instead of running the command again; pass `full: true` only when the whole output is needed.
- **Safety.** The machine's denyPaths and desk-node's own data are not reachable; do not try other routes to them. Before its first change to a Git repository in a session, desk takes a checkpoint; Machines `restore` (preview first, then `confirm: true`) undoes changes.
- **Errors.** Follow the error's `next`. MACHINE_OFFLINE with ssh also failing means the PC is asleep or off: tell the user instead of retrying. A working directory that does not exist fails with NOT_FOUND: check the binding with `/desk:status`.
- **Other agents.** To pass a task to an agent on this or another machine (Codex, Antigravity, Claude elsewhere) and get it back, possibly many times, use `/desk:handoff`. You are `claude@<machine where the files are>`. If a directory has `.handoff/`, run `handoff status <task>` (on that machine) before editing it: only the owner edits, and `handoff` refusing something protects work. Orca workers (`orca orchestration worker-start --on <machine>`) are an alternative for one-off parallel jobs.
