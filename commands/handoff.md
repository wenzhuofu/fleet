---
description: Pass a task back and forth between you and an agent on a machine (e.g. Codex), through a ledger in the repository
argument-hint: start [title] | to codex | take | status
---
Handoff passes one task between you (Claude, on the VPS) and an agent on the engineering machine, in one Git repository there. Each agent keeps and resumes its own session; what crosses over is a short note per hop and a snapshot of the working tree, so the receiver reads only what changed. The machine-side script is `.handoff/handoff.sh` in the repository (its header documents every subcommand); the ledger is `.handoff/` (kept out of Git).

The repository is the bound folder (Bash's default cwd; check with `/desk:status`) unless the user names another; pass `cwd` to desk Bash accordingly. Your agent name is `claude`. Arguments: `$ARGUMENTS`

**start [title]** — set the task up here:
1. Copy `${CLAUDE_PLUGIN_ROOT}/handoff/handoff.sh` to `<machine>:<repo>/.handoff/handoff.sh` with desk Copy.
2. desk Bash: `bash .handoff/handoff.sh init claude`, then `bash .handoff/handoff.sh session claude <id>`, where `<id>` is `$CLAUDE_CODE_SESSION_ID` from the VPS Bash tool.
3. Fill `.handoff/task.md` (Read, then Write) from the conversation: goal, acceptance criteria, constraints, context. Keep it short; it is read on every hop.

**to codex** — hand the task over (run `start` first if `.handoff/` does not exist yet; with an existing `handoff.sh`, Copy it again so it is current):
1. Write your note into `.handoff/outbox.md` with the template in `.handoff/README.md` (Done, State, Tried and dropped, Decisions, Next). Say exactly where Codex should stop and hand back. Name files, commands and the decisions behind them; it cannot read this conversation.
2. desk Bash: `bash .handoff/handoff.sh pass claude codex`.
3. desk BashJob (load it with ToolSearch if needed): `bash .handoff/handoff.sh run codex claude` in the repository. It starts Codex (or resumes its earlier session), and when Codex stops it records Codex's note and hands the task back to you. Tell the user it is running; do not edit the repository until it hands back.

**take** — receive the task back (when the job has finished, or the user says so):
1. desk Bash: `bash .handoff/handoff.sh take claude`. It prints the new log entries and the files changed since you last passed.
2. Check the changes against the note: `git diff refs/handoff/<a> refs/handoff/<b>` as printed (stat first, then the files that matter). Grep the transcript under `.handoff/runs/` only to answer a specific question.
3. Report to the user in a few lines: what Codex did, whether it holds up, open questions, and what you propose next. Then continue the task yourself or hand it over again.

**status** — desk Bash: `bash .handoff/handoff.sh status`, and summarize it.

Rules: only the owner edits the working tree. Do not edit `log.md` or `state` by hand. If a run failed, the log entry says so and you hold the task again. With no arguments, show the usage line above and the current `status` if a ledger exists.
