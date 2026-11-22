---
description: Bind this directory to a machine and folder (writes ./.desk.json)
argument-hint: <machine> [dir]
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/desk:*)
---
Run `${CLAUDE_PLUGIN_ROOT}/bin/desk use $ARGUMENTS` in the current directory and report its one-line result. Quote a Windows path that contains spaces or backslashes, e.g. `use pc-home 'D:\work dir'`. With no arguments, run `${CLAUDE_PLUGIN_ROOT}/bin/desk status` instead and show the usage `/desk:use <machine> [dir]`. From now on, relative paths and Bash's default cwd in desk tools refer to that folder.
