---
description: How to use desk (remote engineering machines as Claude Code tools)
---
Explain briefly, in the user's language, using only this:

- desk gives Claude tools that act on remote engineering machines (Windows PCs running desk-node): Read, Write, Edit, Glob, Grep, Bash, Copy, plus BashJob and Machines (loaded on demand).
- Every tool takes an optional `machine`; without it the call goes to this directory's binding (`.desk.json`, set with `/desk:use <machine> [dir]`) or else the default machine in machines.json. Relative paths are relative to the bound folder.
- Commands: `/desk:status` (binding, on/off, machine health), `/desk:use <machine> [dir]`, `/desk:off` and `/desk:on` (per directory), `/desk:help`.
- Copy moves single files between the VPS and a machine (max 50 MiB towards the VPS). Big data stays on the machine; bring back only results.
- If desk tools are missing, run `/desk:status`; if desk is off here, `/desk:on`.
