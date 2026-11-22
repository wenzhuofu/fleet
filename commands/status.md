---
description: Show which machine and directory desk works on here, whether desk is on, and machine health
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/desk:*), mcp__plugin_desk_desk__Machines
---
Run `${CLAUDE_PLUGIN_ROOT}/bin/desk status`, then call the desk Machines tool (action list; load it with ToolSearch first if it is deferred). Reply with a short summary: on/off here, the binding (machine:dir and where it comes from), and each machine's state. If a machine is offline, say what its error's `next` says; do not retry in a loop.
