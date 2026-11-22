#!/usr/bin/env bash
# Health check of the fleet control centre on the VPS. Every check prints PASS / FAIL / SKIP
# and, on failure, the command that fixes it. Exit 0 when nothing failed.
#   kit/fleet-doctor.sh [fleet.conf] [--no-claude] [--machines]
#     --no-claude  skip the one claude -p check
#     --machines   also run kit/fleet-doctor.ps1 on every Windows machine in machines.json over its
#                  out-of-band ssh alias and summarise (the script is piped over ssh into a temp file that is deleted afterwards)
set -uo pipefail
KIT=$(cd "$(dirname "$0")" && pwd)
CONF=$KIT/fleet.conf; NO_CLAUDE=0; REMOTE=0
for a in "$@"; do case "$a" in --no-claude) NO_CLAUDE=1 ;; --machines) REMOTE=1 ;; *) CONF=$a ;; esac; done
[ -f "$CONF" ] && . "$CONF"
FLEET_HOME=${FLEET_HOME:-$HOME/fleet}; OPT_DIR=${OPT_DIR:-$HOME/opt}
ORCA_PORT=${ORCA_PORT:-6768}
REPO=$FLEET_HOME/desk-fleet; CLAUDE=$HOME/.local/bin/claude
MACHINES=${DESK_MACHINES:-$FLEET_HOME/machines.json}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; echo "     fix: $2"; fails=$((fails + 1)); }
skip() { echo "SKIP $1 ($2)"; }
check() { if eval "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1" "$3"; fi; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); $2" "$1" 2>/dev/null; }

echo "== disk"
root_used=$(df -P / | awk 'NR==2 {sub(/%/,"",$5); print $5}'); tmp_kb=$(find /tmp -mindepth 1 -maxdepth 1 -uid "$(id -u)" -exec du -sk -- {} + 2>/dev/null | awk '{n += $1} END {print n+0}')
[ -z "$root_used" ] || [ "$root_used" -le 70 ] || echo "WARN root filesystem ${root_used}% used; inspect with $REPO/deploy/vps/bin/fleet-tidy --dry-run"
[ "$tmp_kb" -le 1048576 ] || echo "WARN /tmp entries owned by $USER use $((tmp_kb / 1024)) MiB; inspect with $REPO/deploy/vps/bin/fleet-tidy --dry-run"

echo "== Claude CLI"
if [ -x "$CLAUDE" ]; then pass "CLI installed: $("$CLAUDE" --version 2>/dev/null | head -1)"; else fail "CLI installed" "curl -fsSL https://claude.ai/install.sh | bash"; fi

echo "== desk plugin"
check "desk plugin installed and enabled" "'$CLAUDE' plugin list 2>/dev/null | grep -A5 'desk@fleet' | grep -q 'Status: ✔ enabled'" "claude plugin marketplace add $REPO && claude plugin install desk@fleet --scope user"
check "machines.json is valid" "json '$MACHINES' 'assert isinstance(d[\"machines\"], dict)'" "cp $REPO/kit/templates/machines.json $MACHINES  # then edit @FLEET_HOME@"

echo "== desk-gateway"
tool_counts=$(cd "$HOME" && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | timeout 15 env DESK_MACHINES="$MACHINES" "$REPO/bin/desk-gateway" 2>/dev/null \
  | python3 -c "import json,sys
for l in sys.stdin:
  m=json.loads(l)
  if m.get('id')==2:
    ts=m['result']['tools']; print(len(ts), sum(1 for t in ts if t.get('_meta',{}).get('anthropic/alwaysLoad')), int(any(t['name']=='Copy' for t in ts)))")
read -r tool_total always_load has_copy <<< "$tool_counts"
expected_total=8; expected_always_load=6
if [ "$has_copy" = 1 ]; then expected_total=9; expected_always_load=7; fi
[ "${tool_total:-}" = "$expected_total" ] && [ "${always_load:-}" = "$expected_always_load" ] \
  && pass "gateway lists $tool_total desk tools ($always_load alwaysLoad)" \
  || fail "gateway tools/list (got '${tool_counts:-nothing}')" "check Node 24 ($REPO/bin/desk-node24) and $MACHINES"
if [ $NO_CLAUDE = 1 ]; then skip "desk tools visible in the first turn" "--no-claude"
elif [ ! -s "$HOME/.claude/.credentials.json" ]; then skip "desk tools visible in the first turn" "not logged in: run claude once"
else
  init=$(cd "$HOME" && timeout 120 "$CLAUDE" -p "Reply OK." --max-turns 1 --output-format stream-json --verbose 2>/dev/null | python3 -c "import json,sys
for l in sys.stdin:
  try: e=json.loads(l)
  except ValueError: continue
  if e.get('type')=='system' and e.get('subtype')=='init': print(sum(1 for t in e.get('tools',[]) if t.startswith('mcp__plugin_desk_desk__'))); break")
  [ "$init" = "$expected_total" ] && pass "desk tools visible in the first turn (claude -p init)" || fail "desk tools in the first turn (got '${init:-none}')" "claude plugin list  # desk@fleet must be enabled; then check ~/.claude/settings.json enabledPlugins"
fi

echo "== Orca"
check "orca service active" "systemctl --user is-active orca" "systemctl --user restart orca; journalctl --user -u orca -n 50"
mem=$(systemctl --user show orca -p MemoryMax --value 2>/dev/null)
[ -n "$mem" ] && [ "$mem" != infinity ] && pass "orca memory limit $((mem / 1048576)) MiB" || fail "orca has no memory limit" "set MemoryMax in ~/.config/systemd/user/orca.service"
TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
check "Orca web client at http://$TS_IP:$ORCA_PORT (tailnet)" "curl -fsS -o /dev/null --max-time 10 http://$TS_IP:$ORCA_PORT/web-index.html" "journalctl --user -u orca -n 50"
check "Orca refuses public peers" "systemctl --user cat orca | grep -q -- '--refuse-public'" "add --refuse-public to ExecStart in ~/.config/systemd/user/orca.service"
settings_hooks=$(json "$HOME/.claude/settings.json" 'print(len(d.get("hooks", {})))')
echo "INFO Claude global hooks: ${settings_hooks:-0} event(s) in ~/.claude/settings.json (Orca: Settings -> Agents -> Agent status hooks)"

echo "== tailscale and exposure"
check "tailscale running" "tailscale status" "sudo tailscale up"
if st=$(tailscale serve status --json 2>/dev/null); then
  echo "$st" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(1 if d.get('AllowFunnel') and any(d['AllowFunnel'].values()) else 0)" \
    && pass "no Funnel (serve is tailnet only)" || fail "Funnel is enabled" "tailscale funnel reset"
else skip "serve config" "only the tailscale operator can read it"; fi
# Orca must listen on all interfaces for pairing; it refuses public peers itself (checked above).
pub=$(ss -ltnpH 2>/dev/null | awk '/users:/ {print $4}' | grep -vE '^(127\.|\[::1\]|100\.|\[fd7a:)' | grep -vE "^(0\.0\.0\.0|\*|\[::\]):$ORCA_PORT\$" | sort -u | tr '\n' ' ')
[ -z "$pub" ] && pass "no process of $USER listens on a public address" || fail "$USER's processes listen publicly on: $pub" "bind them to 127.0.0.1 or the tailnet address"

echo "== machines"
python3 - "$MACHINES" <<'PY' > "${TMPDIR:-/tmp}/fleet-doctor.$$"
import json, sys
for n, m in json.load(open(sys.argv[1]))['machines'].items():
    if not m.get('local'): print(n, m.get('url', ''), m.get('tokenFile', ''), m.get('ssh', ''))
PY
if [ ! -s "${TMPDIR:-/tmp}/fleet-doctor.$$" ]; then skip "machines" "none in machines.json yet: kit/new-machine.sh start <name>"; fi
while read -r name url tokfile alias; do
  tf=${tokfile/#\~/$HOME}
  [ -f "$tf" ] && [ "$(stat -c %a "$tf")" = 600 ] && pass "$name: token file 0600" || fail "$name: token file $tokfile missing or not 0600" "chmod 600 $tokfile"
  hdr=$(mktemp); chmod 600 "$hdr"; printf 'authorization: Bearer %s\n' "$(cat "$tf" 2>/dev/null)" > "$hdr"  # not on the command line
  ver=$(curl -fsS --max-time 8 -H @"$hdr" "$url/health" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null); rm -f "$hdr"
  [ -n "$ver" ] && pass "$name: desk-node $ver online at $url" || fail "$name: desk-node not reachable at $url (normal if the PC is off)" "ssh ${alias:-$name} 'powershell -NoProfile -File C:/desk-node/current/deploy/service.ps1 start'"
  if [ -z "$alias" ]; then fail "$name: no out-of-band ssh alias" "add \"ssh\": \"$name\" to machines.json and a Host entry in ~/.ssh/config"
  else
    h=$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 "$alias" hostname 2>/dev/null)
    [ -n "$h" ] && pass "$name: out-of-band ssh $alias -> $h" || fail "$name: out-of-band ssh $alias failed" "on $name run kit/fleet-doctor.ps1 (sshd can disappear after Windows updates)"
  fi
done < "${TMPDIR:-/tmp}/fleet-doctor.$$"
rm -f "${TMPDIR:-/tmp}/fleet-doctor.$$"

summary=()
if [ $REMOTE = 1 ]; then
  echo; echo "== Windows machines (fleet-doctor.ps1 over ssh)"
  python3 - "$MACHINES" <<'PY' > "${TMPDIR:-/tmp}/fleet-doctor.m.$$"
import json, sys
for n, m in json.load(open(sys.argv[1]))['machines'].items():
    if not m.get('local'): print(n, m.get('ssh', ''))
PY
  while read -r name alias; do
    [ -n "$alias" ] || { echo "FAIL $name: no ssh alias"; fails=$((fails + 1)); summary+=("$name: no ssh alias"); continue; }
    # The script goes over ssh's stdin into a temp file (long -EncodedCommand lines get cut off) and is deleted afterwards.
    out=$(timeout 90 ssh -o BatchMode=yes -o ConnectTimeout=8 "$alias" 'f=$(mktemp --suffix=.ps1) && cat > "$f" && powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(cygpath -w "$f")"; rc=$?; rm -f "$f"; exit $rc' < "$KIT/fleet-doctor.ps1" 2>&1); rc=$?
    echo "--- $name"; echo "$out" | tr -d '\r'
    if [ $rc -eq 0 ]; then summary+=("$name: all checks passed"); else fails=$((fails + 1)); summary+=("$name: FAILED (exit $rc) - $(echo "$out" | grep -c '^FAIL') check(s)"); fi
  done < "${TMPDIR:-/tmp}/fleet-doctor.m.$$"
  rm -f "${TMPDIR:-/tmp}/fleet-doctor.m.$$"
fi

echo; [ $fails = 0 ] && echo "all checks passed" || echo "$fails check(s) failed"
for l in "${summary[@]}"; do echo "  $l"; done
exit $(( fails > 0 ))
