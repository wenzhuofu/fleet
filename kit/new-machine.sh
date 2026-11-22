#!/usr/bin/env bash
# VPS side of joining a Windows machine (see kit/README.md).
#   new-machine.sh start <name> [--serve-port 8450]
#       VPS key ~/.ssh/<name>; serves the desk-node package to the tailnet (local http.server on
#       127.0.0.1:<serve-port+10000> behind tailscale serve --https, tailnet only) and prints the
#       PowerShell commands for the machine.
#   new-machine.sh finish <name> --host <magicdns> --user <windows user> [--port 7801] [--dir D:\git]
#                         [--root C:/desk-node] [--profile daily|server] [--serve-port 8450]
#       stops the file serve; host key -> known_hosts; Host alias in ~/.ssh/config; checks
#       ssh <name> hostname; copies the token over ssh (cat, not scp); adds the machines.json entry;
#       checks /health.
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$KIT/.." && pwd)
FLEET_HOME=${FLEET_HOME:-$(cd "$REPO/.." && pwd)}
MACHINES=${DESK_MACHINES:-$FLEET_HOME/machines.json}
cmd=${1:-}; name=${2:-}; shift 2 || true
[[ "$name" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage: $0 start|finish <name> ...  (name: lowercase letters, digits, -)"; exit 2; }
SERVE_PORT=8450 HOST='' WUSER='' PORT=7801 DIR='D:\git' ROOT='C:/desk-node' PROFILE=daily
while [ $# -gt 0 ]; do
  case "$1" in
    --serve-port) SERVE_PORT=$2 ;; --host) HOST=$2 ;; --user) WUSER=$2 ;; --port) PORT=$2 ;;
    --dir) DIR=$2 ;; --root) ROOT=$2 ;; --profile) PROFILE=$2 ;; *) echo "unknown option $1"; exit 2 ;;
  esac; shift 2
done
KEY=$HOME/.ssh/$name
STAGE=$HOME/.cache/desk-fleet/join-$name
VPS_DNS=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')

if [ "$cmd" = start ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "desk-fleet VPS -> $name" -f "$KEY"
  version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/packages/node/package.json")
  pkg=$REPO/dist/desk-node-$version.tar.gz
  [ -f "$pkg" ] || "$REPO/deploy/node/build-release.sh" >/dev/null
  rm -rf "$STAGE" && mkdir -p "$STAGE" && cp "$pkg" "$STAGE/"
  # A local file server behind tailscale serve (an operator may proxy, but not serve a path).
  [ -f "$STAGE.pid" ] && kill "$(cat "$STAGE.pid")" 2>/dev/null || true
  setsid python3 -m http.server $((SERVE_PORT + 10000)) --bind 127.0.0.1 --directory "$STAGE" >/dev/null 2>&1 < /dev/null &
  echo $! > "$STAGE.pid"
  tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$((SERVE_PORT + 10000))" >/dev/null
  P=desk-node-$version
  cat <<EOF
Package served to the tailnet at https://$VPS_DNS:$SERVE_PORT/ until 'finish'.

On the Windows machine (prerequisites: Git for Windows, Tailscale logged in to the same tailnet):

# 1. normal PowerShell: download and unpack the scripts
New-Item -ItemType Directory -Force C:\\desk-node\\incoming | Out-Null
\$ProgressPreference = 'SilentlyContinue'   # PowerShell 5.1 downloads are very slow with the progress bar
Invoke-WebRequest https://$VPS_DNS:$SERVE_PORT/$P.tar.gz -OutFile C:\\desk-node\\incoming\\$P.tar.gz -UseBasicParsing
tar -xzf C:\\desk-node\\incoming\\$P.tar.gz -C C:\\desk-node\\incoming $P/deploy

# 2. ELEVATED PowerShell (Run as administrator): sshd, firewall, DefaultShell, VPS key
powershell -NoProfile -ExecutionPolicy Bypass -File C:\\desk-node\\incoming\\$P\\deploy\\join-machine.ps1 -Admin -VpsKey '$(cat "$KEY.pub")'

# 3. normal PowerShell (the account desk-node runs as; -Profile server: elevated, asks for the password)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\\desk-node\\incoming\\$P\\deploy\\join-machine.ps1 -Package C:\\desk-node\\incoming\\$P.tar.gz -Profile daily -MachineName $name -DefaultDir D:\\git

# 4. back here: run the 'new-machine.sh finish ...' line that step 3 prints.
EOF
  exit 0
fi

[ "$cmd" = finish ] || { echo "usage: $0 start|finish <name> ..."; exit 2; }
[ -n "$HOST" ] && [ -n "$WUSER" ] || { echo "finish needs --host <magicdns> --user <windows user>"; exit 2; }
tailscale serve --https="$SERVE_PORT" off >/dev/null 2>&1 || true
[ -f "$STAGE.pid" ] && kill "$(cat "$STAGE.pid")" 2>/dev/null || true
rm -rf "$STAGE" "$STAGE.pid"
touch "$HOME/.ssh/known_hosts"
if ! ssh-keygen -F "$HOST" >/dev/null; then
  ssh-keyscan -t ed25519 "$HOST" 2>/dev/null >> "$HOME/.ssh/known_hosts"
  echo "host key: $(ssh-keygen -lf <(ssh-keygen -F "$HOST" | grep -v '^#') | awk '{print $2}')  (compare: on $name, as admin: ssh-keygen -lf C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub)"
fi
grep -q "^Host $name\$" "$HOME/.ssh/config" 2>/dev/null || printf 'Host %s\n  HostName %s\n  User %s\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$name" "$HOST" "$WUSER" "$KEY" >> "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"
echo "out-of-band: ssh $name -> $(ssh -o BatchMode=yes -o ConnectTimeout=8 "$name" hostname)"
# Token over ssh with cat: the scp of older OpenSSH clients (e.g. Ubuntu 22.04) uses the legacy protocol
# that Windows OpenSSH does not serve reliably. DefaultShell is Git Bash, hence /c/... paths.
tokens=$HOME/.config/desk-fleet/tokens; mkdir -p "$tokens" && chmod 700 "$tokens"
msys=$(echo "$ROOT" | sed -E 's#^([A-Za-z]):#/\L\1#; s#\\#/#g')
(umask 077; ssh -o BatchMode=yes "$name" "cat '$msys/data/token'" > "$tokens/$name.token.tmp")
[ "$(wc -c < "$tokens/$name.token.tmp")" -ge 32 ] || { rm -f "$tokens/$name.token.tmp"; echo "token copy failed"; exit 1; }
mv "$tokens/$name.token.tmp" "$tokens/$name.token"
echo "token: $tokens/$name.token (0600, not shown)"
python3 - "$MACHINES" "$name" "http://$HOST:$PORT" "$DIR" "$PROFILE" <<'PY'
import json, os, sys
path, name, url, d, profile = sys.argv[1:]
m = json.load(open(path)) if os.path.exists(path) else {'default': None, 'machines': {}}
m['machines'][name] = {'url': url, 'tokenFile': f'~/.config/desk-fleet/tokens/{name}.token', 'os': 'windows', 'defaultDir': d, 'ssh': name, 'note': f'{profile} 配置'}
if not m.get('default'): m['default'] = name
real = os.path.realpath(path); tmp = real + '.tmp'  # machines.json may be a symlink into the repo
open(tmp, 'w').write(json.dumps(m, indent=2, ensure_ascii=False) + '\n'); os.replace(tmp, real)
print(f'machines.json: {name} -> {url}' + (' (default)' if m['default'] == name else ''))
PY
hdr=$(mktemp); chmod 600 "$hdr"; printf 'authorization: Bearer %s\n' "$(cat "$tokens/$name.token")" > "$hdr"
v=$(curl -fsS --max-time 8 -H @"$hdr" "http://$HOST:$PORT/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' || true); rm -f "$hdr"
[ -n "$v" ] && echo "desk-node $v online. Done: Machines lists $name in new Claude sessions." || { echo "desk-node not reachable at http://$HOST:$PORT (check tailscale serve on $name)"; exit 1; }
