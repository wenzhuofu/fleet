#!/usr/bin/env bash
# Smoke test after every Claude Code CLI upgrade (real ~/fleet config), one claude -p run:
#   1. the always-loaded desk tools (Write, Bash) are visible in the first turn;
#   2. Machines (deferred) loads through ToolSearch and lists pc-home online;
#   3. full-auto: mcp__plugin_desk_desk__Write succeeds without a permission prompt/denial;
#   plus the out-of-band channel: ssh pc-home hostname.
# pc-home must be online. Usage: deploy/vps/bin/smoke.sh   (exit 0 = pass)
set -euo pipefail
CLAUDE=${CLAUDE:-$HOME/.local/bin/claude}

desk_check() {
local oob=0
if timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=5 pc-home hostname >/dev/null 2>&1; then echo "PASS out-of-band ssh pc-home"; else echo "FAIL out-of-band ssh pc-home"; oob=1; fi
file="D:/fleet-sandbox/smoke/smoke-$(date +%Y%m%d%H%M%S).txt"
out=$(mktemp)
prompt="Smoke test. Do exactly these tool calls in order, then reply DONE:
1) mcp__plugin_desk_desk__Write file_path=$file content=smoke
2) mcp__plugin_desk_desk__Bash command: rm -f $file && echo removed
3) load mcp__plugin_desk_desk__Machines with ToolSearch, then call it with no arguments."
cd "$HOME/fleet"
"$CLAUDE" -p "$prompt" --output-format stream-json --verbose --max-turns 8 > "$out" 2>&1 || true
python3 - "$out" <<'PY'
import json, sys
events = []
for line in open(sys.argv[1], encoding='utf-8'):
    try: events.append(json.loads(line))
    except ValueError: pass
uses, results, denials, init_tools = [], {}, [], []
for e in events:
    if e.get('type') == 'system' and e.get('subtype') == 'init': init_tools = e.get('tools', [])
    if e.get('type') == 'result': denials = e.get('permission_denials') or []
    for c in (e.get('message') or {}).get('content') or []:
        if not isinstance(c, dict): continue
        if c.get('type') == 'tool_use': uses.append((c['id'], c['name']))
        if c.get('type') == 'tool_result':
            t = c.get('content'); t = t if isinstance(t, str) else ' '.join(x.get('text', '') for x in t or [])
            results[c['tool_use_id']] = (bool(c.get('is_error')), t)
def res(name):
    return next((results.get(i) for i, n in uses if n == name), None)
checks = []
names = [n for _, n in uses]
checks.append(('desk tools registered at start', 'mcp__plugin_desk_desk__Write' in init_tools and 'mcp__plugin_desk_desk__Bash' in init_tools))
checks.append(('first tool call is Write (always loaded, no ToolSearch)', bool(names) and names[0] == 'mcp__plugin_desk_desk__Write'))
m = res('mcp__plugin_desk_desk__Machines')
checks.append(('Machines lists pc-home online', bool(m) and not m[0] and 'pc-home' in m[1] and 'online' in m[1]))
w = res('mcp__plugin_desk_desk__Write')
checks.append(('Write succeeded without prompt', bool(w) and not w[0] and not any('Write' in d.get('tool_name', '') for d in denials)))
b = res('mcp__plugin_desk_desk__Bash')
checks.append(('cleanup', bool(b) and 'removed' in b[1]))
for name, ok in checks: print(('PASS ' if ok else 'FAIL ') + name)
if denials: print('permission denials:', [d.get('tool_name') for d in denials])
if not all(ok for _, ok in checks):
    print('tool calls:', names); sys.exit(1)
PY
local r=$?
rm -f "$out"
[ "$oob" = 0 ] && return $r || return 1
}

echo "claude $("$CLAUDE" --version)"
desk_check
