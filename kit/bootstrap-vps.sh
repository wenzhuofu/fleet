#!/usr/bin/env bash
# Deploy the fleet control centre on a fresh Ubuntu/Debian VPS as a normal user.
#   kit/bootstrap-vps.sh [fleet.conf]
# Root-only prerequisites are checked first; if any is missing the script prints the exact
# commands for an admin and stops (exit 2). Everything else runs as this user, is idempotent
# and can be re-run. Names, ports and paths come from fleet.conf (see fleet.conf.example).
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd)
SRC_REPO=$(cd "$KIT/.." && pwd)
CONF=${1:-$KIT/fleet.conf}
[ -f "$CONF" ] && . "$CONF"
FLEET_HOME=${FLEET_HOME:-$HOME/fleet}
OPT_DIR=${OPT_DIR:-$HOME/opt}
DESK_FLEET_REPO=${DESK_FLEET_REPO:-$SRC_REPO}
NODE24_VERSION=${NODE24_VERSION:-v24.22.1}
ORCA_VERSION=${ORCA_VERSION:-1.4.268}
ORCA_DEB_SHA256=${ORCA_DEB_SHA256:-ce08aa4bb05972ee3acc89f6c97ce6140c84014a14b0c7e70fe6ece1b40b28a7}
ORCA_PORT=${ORCA_PORT:-6768}
ORCA_MEMORY_HIGH=${ORCA_MEMORY_HIGH:-2200M}
ORCA_MEMORY_MAX=${ORCA_MEMORY_MAX:-2800M}
ORCA_TERMINAL_MEMORY_MAX=${ORCA_TERMINAL_MEMORY_MAX:-1200M}
FLEET_REPO=$FLEET_HOME/desk-fleet
mkdir -p "$HOME/.cache/desk-fleet"
T0=$(date +%s)
step() { printf '\n== %s (%ss)\n' "$*" $(( $(date +%s) - T0 )); }

# ---------- 0. root prerequisites (printed, never run here) ----------
step "0. prerequisites"
missing=()
for c in git python3 curl xz dpkg-deb; do command -v $c >/dev/null || missing+=("$c"); done
ts_ok=1; command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1 || ts_ok=0
linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)
if [ ${#missing[@]} -gt 0 ] || [ $ts_ok = 0 ] || [ "$linger" != yes ]; then
  echo "Needs an admin first (run these as root / with sudo, then re-run this script):"
  [ ${#missing[@]} -gt 0 ] && echo "  sudo apt-get update && sudo apt-get install -y git python3 curl ca-certificates xz-utils"
  [ $ts_ok = 0 ] && echo "  curl -fsSL https://tailscale.com/install.sh | sudo sh && sudo tailscale up      # log in; this VPS joins the tailnet"
  [ "$linger" != yes ] && echo "  sudo loginctl enable-linger $USER        # user services (Orca) run without a login"
  exit 2
fi
ORCA_ADDRESS=${ORCA_ADDRESS:-$(tailscale ip -4 | head -1)}
echo "ok: tools, tailscale ($ORCA_ADDRESS), linger"
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

# ---------- 1. Node runtime for desk-gateway (verified against nodejs.org SHASUMS) ----------
step "1. Node $NODE24_VERSION (gateway)"
name=node-$NODE24_VERSION-linux-x64 cache=$HOME/.cache/desk-fleet
mkdir -p "$OPT_DIR"
if [ ! -x "$OPT_DIR/$name/bin/node" ]; then
  curl -fsSL -o "$cache/$name.tar.xz" "https://nodejs.org/dist/$NODE24_VERSION/$name.tar.xz"
  curl -fsSL -o "$cache/SHASUMS256-$NODE24_VERSION.txt" "https://nodejs.org/dist/$NODE24_VERSION/SHASUMS256.txt"
  (cd "$cache" && grep " $name.tar.xz\$" "SHASUMS256-$NODE24_VERSION.txt" | sha256sum -c --quiet -)
  tar -C "$OPT_DIR" -xJf "$cache/$name.tar.xz" && rm -f "$cache/$name.tar.xz"
fi
ln -sfn "$OPT_DIR/$name" "$OPT_DIR/node24"
echo "node24 -> $("$OPT_DIR/node24/bin/node" --version)"

# ---------- 2. Fresh Claude CLI binary; no account or project settings are restored ----------
step "2. Claude CLI"
if [ ! -x "$HOME/.local/bin/claude" ]; then curl -fsSL https://claude.ai/install.sh | bash -s stable; fi
grep -q 'local/bin' "$HOME/.profile" 2>/dev/null || printf '\n# fleet: claude, desk, desk-copy\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"
echo "claude $("$HOME/.local/bin/claude" --version 2>/dev/null | head -1)"

# ---------- 3. sources ----------
step "3. desk-fleet source"
mkdir -p "$FLEET_HOME"
if [ ! -d "$FLEET_REPO/.git" ]; then git clone -q "$DESK_FLEET_REPO" "$FLEET_REPO"; else git -C "$FLEET_REPO" pull -q --ff-only || echo "warning: $FLEET_REPO not fast-forwarded"; fi
echo "desk-fleet $(git -C "$FLEET_REPO" rev-parse --short HEAD)"

# ---------- 4. machines.json and the desk plugin ----------
step "4. desk plugin (any directory can be used as a workspace)"
render() {  # render <template> <dest>: @VARS@ -> values
  sed -e "s|@FLEET_HOME@|$FLEET_HOME|g" -e "s|@FLEET_REPO@|$FLEET_REPO|g" -e "s|@OPT_DIR@|$OPT_DIR|g" \
      -e "s|@ORCA_PORT@|$ORCA_PORT|g" -e "s|@ORCA_ADDRESS@|$ORCA_ADDRESS|g" \
      -e "s|@ORCA_MEMORY_HIGH@|$ORCA_MEMORY_HIGH|g" -e "s|@ORCA_MEMORY_MAX@|$ORCA_MEMORY_MAX|g" \
      -e "s|@ORCA_TERMINAL_MEMORY_MAX@|$ORCA_TERMINAL_MEMORY_MAX|g" "$1" > "$2.tmp"
  mv "$2.tmp" "$2"
}
TPL=$FLEET_REPO/kit/templates
[ -e "$FLEET_HOME/machines.json" ] || render "$TPL/machines.json" "$FLEET_HOME/machines.json"
mkdir -p "$HOME/.config/desk-fleet/tokens" && chmod 700 "$HOME/.config/desk-fleet" "$HOME/.config/desk-fleet/tokens"
# The plugin is installed from this checkout (a local marketplace), so `git pull` updates it.
"$HOME/.local/bin/claude" plugin marketplace add "$FLEET_REPO" >/dev/null 2>&1 || "$HOME/.local/bin/claude" plugin marketplace update fleet >/dev/null
"$HOME/.local/bin/claude" plugin install desk@fleet --scope user >/dev/null 2>&1 || true
# Auto-allow only the read-only desk tools; keep anything already in the user's settings.
python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
allow = d.setdefault('permissions', {}).setdefault('allow', [])
for t in ('Read', 'Glob', 'Grep'):
    r = f'mcp__plugin_desk_desk__{t}'
    if r not in allow: allow.append(r)
os.makedirs(os.path.dirname(p), exist_ok=True)
tmp = p + '.tmp'; json.dump(d, open(tmp, 'w'), indent=2); os.replace(tmp, p)
PY
echo "desk plugin: $("$HOME/.local/bin/claude" plugin list 2>/dev/null | grep -A5 'desk@fleet' | grep -o 'Status: .*')"

# ---------- 5. terminal commands ----------
step "5. desk / desk-copy on PATH"
mkdir -p "$HOME/.local/bin"
# rm first: older setups made these symlinks into the repo, and writing through one overwrites the script.
for c in desk desk-copy handoff; do rm -f "$HOME/.local/bin/$c"; ln -s "$FLEET_REPO/bin/$c" "$HOME/.local/bin/$c"; done
rm -f "$HOME/.local/bin/fleet-workspace"
echo "~/.local/bin/desk, ~/.local/bin/desk-copy, ~/.local/bin/handoff"

# ---------- 6. Orca (desktop package, run headless as `orca-ide serve`; no sudo, no Electron window) ----------
step "6. Orca $ORCA_VERSION and user services"
orca_dir=$OPT_DIR/orca-desktop-$ORCA_VERSION
if [ ! -x "$orca_dir/opt/Orca/resources/bin/orca-ide" ]; then
  deb=$cache/orca-ide_${ORCA_VERSION}_amd64.deb
  curl -fsSL -o "$deb" "https://github.com/stablyai/orca/releases/download/v$ORCA_VERSION/orca-ide_${ORCA_VERSION}_amd64.deb"
  echo "$ORCA_DEB_SHA256  $deb" | sha256sum -c --quiet -
  mkdir -p "$orca_dir.tmp" && dpkg-deb -x "$deb" "$orca_dir.tmp" && mv "$orca_dir.tmp" "$orca_dir" && rm -f "$deb"
fi
ln -sfn "$orca_dir" "$OPT_DIR/orca"
mkdir -p "$HOME/.config/systemd/user"
render "$TPL/orca.service" "$HOME/.config/systemd/user/orca.service"
render "$TPL/fleet-tidy.service" "$HOME/.config/systemd/user/fleet-tidy.service"; render "$TPL/fleet-tidy.timer" "$HOME/.config/systemd/user/fleet-tidy.timer"
systemctl --user daemon-reload
systemctl --user enable --now -q orca
systemctl --user enable --now -q fleet-tidy.timer
for i in $(seq 1 60); do journalctl --user -u orca --since "-2min" -o cat 2>/dev/null | grep -q "Orca server ready" && break; sleep 1; done
echo "orca: $(systemctl --user is-active orca), ws://$ORCA_ADDRESS:$ORCA_PORT (tailnet only)"

step "7. checks"
"$FLEET_REPO/kit/fleet-doctor.sh" "$CONF" || true
ORCA="$OPT_DIR/orca/opt/Orca/resources/bin/orca-ide"
cat <<EOF

Done in $(( $(date +%s) - T0 )) s. Next:
  1. claude                      # once, in a terminal: log in with your own Claude account, then /exit
     then, in any directory:     /desk:use <machine> [dir]   (or just use the default machine)
  2. pair a desktop or browser:  $ORCA pair --address $ORCA_ADDRESS
     pair the phone app:         $ORCA pair --mobile --address $ORCA_ADDRESS
  3. add a Windows machine:      $FLEET_REPO/kit/new-machine.sh start <name>
  4. health:                     $FLEET_REPO/kit/fleet-doctor.sh
EOF
