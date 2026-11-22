#!/usr/bin/env bash
# Phase 1: build on the VPS, copy to pc-home over the out-of-band SSH channel,
# extract to C:\desk-node\dev\<version>, and (re)start as a plain process.
# First run also creates C:\desk-node\data\{config.json,token} (current user only)
# and publishes 127.0.0.1:<port> to the tailnet with `tailscale serve`.
#   usage: deploy/node/dev-deploy.sh [machine] [defaultDir]
set -euo pipefail
machine=${1:-pc-home}
default_dir=${2:-D:/git}
default_dir=${default_dir//\\//}  # forward slashes survive the SSH command line
port=7801
repo=$(cd "$(dirname "$0")/../.." && pwd)
token_file=$HOME/.config/desk-fleet/tokens/$machine.token

tarball=$("$repo/deploy/node/build-release.sh" | tail -1)
name=$(basename "$tarball" .tar.gz)

if [ ! -s "$token_file" ]; then
  mkdir -p "$(dirname "$token_file")" && chmod 700 "$(dirname "$token_file")"
  (umask 077 && head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$token_file")
fi

ssh -o BatchMode=yes "$machine" "mkdir -p /c/desk-node/dev /c/desk-node/data && tar -C /c/desk-node/dev -xzf -" < "$tarball"

# Token: piped over SSH stdin, never on a command line or in a log.
ssh -o BatchMode=yes "$machine" 'cat > /c/desk-node/data/token' < "$token_file"
ssh -o BatchMode=yes "$machine" bash -s -- "$machine" "$default_dir" "$port" <<'EOF'
set -e
machine=$1 default_dir=$2 port=$3
cfg=/c/desk-node/data/config.json
if [ ! -f "$cfg" ]; then
  printf '{\n "machineId": "%s",\n "port": %s,\n "defaultDir": "%s"\n}\n' "$machine" "$port" "$default_dir" > "$cfg"
fi
# data dir: current user only (removes inherited ACEs, incl. Administrators/SYSTEM).
icacls 'C:\desk-node\data' /inheritance:r /grant:r "${USERNAME}:(OI)(CI)F" > /dev/null
EOF
ssh -o BatchMode=yes "$machine" "powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\desk-node\\dev\\$name\\deploy\\dev-start.ps1' -Release 'C:\\desk-node\\dev\\$name'"
# Commands with spaces in paths go over stdin (Windows OpenSSH mangles quoted command lines).
ssh -o BatchMode=yes "$machine" bash -s -- "$port" <<'EOF'
ts='/c/Program Files/Tailscale/tailscale.exe'
"$ts" serve --bg --http="$1" "http://127.0.0.1:$1" > /dev/null
"$ts" serve status
EOF
echo "deployed $name to $machine"
