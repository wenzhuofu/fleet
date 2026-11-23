---
description: Pass a task between agents on any machines (Claude, Codex, Antigravity, ...) and take it back, through the handoff hub
argument-hint: start <task> [title] | to <agent@machine> | take [task] | run | inbox | status | done
---
handoff passes one task between participants named `agent@machine`, where machine is where the task's files live. You are `claude@<machine>` for files on an engineering machine you reach with desk (e.g. `claude@pc-home`), or `claude@vps` for files here. The `handoff` command (on PATH on every set-up machine; `handoff --help`) does all bookkeeping: snapshots, the log, ownership and the hub. You only write notes and do the work. Arguments: `$ARGUMENTS`

Where to run `handoff`: for files on a machine, with desk Bash on that machine, `cwd` = the task's directory (the bound folder unless the user names another); for files on the VPS, with the VPS Bash tool. Always pass `--as claude` to start, pass and take.

**start <task> [title]**: `handoff start <task> --as claude --dir <dir> --title "<title>" --session <id>` (`<id>` is `$CLAUDE_CODE_SESSION_ID` from the VPS Bash tool). Task ids are short lowercase words. Then fill `<dir>/.handoff/task.md` (Read, then Write) from the conversation: goal, acceptance criteria, constraints, context. Keep it short; every receiver reads it.

**to <agent@machine>**: hand the task over.
1. Write your note in `<dir>/.handoff/outbox.md` with the template in `.handoff/README.md`. The receiver cannot read this conversation: name files, commands, decisions and exactly where to stop and hand back.
2. `handoff pass <task> <agent@machine> --as claude`.
3. If the receiver is an agent on the same machine with a launcher (codex), start it there with desk BashJob: `handoff take <task> --as <agent> && handoff run <task> --then claude@<machine>`, in the task directory. It resumes that agent's own session if it has one, and hands the task back when the agent stops. Otherwise tell the user who has it and that they run `handoff take <task>` there (or open that agent and say "take the handoff").
Do not edit the task's files until it comes back.

**take [task]**: `handoff inbox` if no task is named, then `handoff take <task> --as claude` (with `--dir` for a new directory on this machine). It prints the new log entries; `.handoff/changes.diff` has the file changes since you last passed. Check them against the note (stat first, then the files that matter; grep a transcript only for a specific question). Report in a few lines: what was done, whether it holds, open questions, what you propose. Then continue or hand over again.

**run**: for a task you hold for another agent on this machine (after `take --as <agent>`), as in step 3 above.

**inbox**, **status <task>**, **log <task>**, **done <task>**, **cancel <task>**: run the same `handoff` subcommand and summarize. `reassign` and cancelling someone else's task work only from a hub admin machine (the VPS).

If `handoff` refuses (someone else holds the task, the directory has changes it did not sync, possible secrets, the hub moved), report its message and do not work around it: it protects work. With no arguments, show the usage line above and `handoff inbox`.
