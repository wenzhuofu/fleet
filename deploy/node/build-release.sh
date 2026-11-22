#!/usr/bin/env bash
# Build a desk-node release on the VPS: dist/desk-node-<version>.tar.gz
#   app/      package.json + src/ (from packages/node)
#   node/     portable node.exe (Node 24, win-x64)
#   bin/      rg.exe (ripgrep, win-x64)
#   deploy/   Windows-side helper scripts
# Artifacts are downloaded once into ~/.cache/desk-fleet and verified by SHA-256.
set -euo pipefail
NODE_VERSION=v24.22.1
RG_VERSION=15.2.0
RG_SHA256=71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5

repo=$(cd "$(dirname "$0")/../.." && pwd)
cache=${DESK_CACHE:-$HOME/.cache/desk-fleet}
mkdir -p "$cache"
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$repo/packages/node/package.json")
# DESK_VERSION overrides the version (drills: build 0.4.1 from the same tree); DESK_BROKEN=1 builds a
# release whose main.mjs throws at startup, for the rollback drill.
version=${DESK_VERSION:-$version}

node_zip=node-$NODE_VERSION-win-x64.zip
rg_zip=ripgrep-$RG_VERSION-x86_64-pc-windows-msvc.zip
[ -f "$cache/$node_zip" ] || curl -fsSL -o "$cache/$node_zip" "https://nodejs.org/dist/$NODE_VERSION/$node_zip"
[ -f "$cache/SHASUMS256-$NODE_VERSION.txt" ] || curl -fsSL -o "$cache/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
(cd "$cache" && grep " $node_zip\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum -c --quiet -)
[ -f "$cache/$rg_zip" ] || curl -fsSL -o "$cache/$rg_zip" "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/$rg_zip"
echo "$RG_SHA256  $cache/$rg_zip" | sha256sum -c --quiet -

out=$repo/dist
stage=$out/desk-node-$version
rm -rf "$stage" && mkdir -p "$stage"/{app,node,bin,deploy}
cp "$repo/packages/node/package.json" "$repo/packages/node/package-lock.json" "$stage/app/"
# Windows build of dependencies (koffi ships its native binary as @koromix/koffi-win32-x64).
PATH=${NODE24_BIN:-$HOME/opt/node24/bin}:$PATH npm ci --prefix "$stage/app" --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
cp -r "$repo/packages/node/src" "$stage/app/src"
python3 - "$stage/app/package.json" "$version" <<'EOF2'
import json, sys
d = json.load(open(sys.argv[1])); d['version'] = sys.argv[2]
open(sys.argv[1], 'w').write(json.dumps(d, indent=2) + '\n')
EOF2
if [ "${DESK_BROKEN:-}" = 1 ]; then
  printf "throw new Error('desk-node %s is broken on purpose (rollback drill)');\n" "$version" > "$stage/app/src/main.mjs"
fi
cp "$repo"/deploy/node/*.ps1 "$stage/deploy/"
cp "$repo"/kit/join-machine.ps1 "$repo"/kit/fleet-doctor.ps1 "$stage/deploy/"
python3 - "$cache/$node_zip" "$stage/node/node.exe" "$cache/$rg_zip" "$stage/bin/rg.exe" <<'EOF'
import sys, zipfile
def pick(zip_path, suffix, dest):
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(suffix))
        with z.open(name) as src, open(dest, 'wb') as dst:
            dst.write(src.read())
pick(sys.argv[1], '/node.exe', sys.argv[2])
pick(sys.argv[3], '/rg.exe', sys.argv[4])
EOF
git -C "$repo" rev-parse HEAD > "$stage/COMMIT"
echo "$version" > "$stage/VERSION"
# Identity of what lives in node/ and bin/. Releases with the same RUNTIME share the runtime, so an
# upgrade between them only needs the app package (install.ps1 links node/ and bin/ from a release that has it).
echo "node-$NODE_VERSION-win-x64_rg-$RG_VERSION" > "$stage/RUNTIME"
tar -C "$out" -czf "$out/desk-node-$version.tar.gz" "desk-node-$version"
tar -C "$out" --exclude="desk-node-$version/node" --exclude="desk-node-$version/bin" -czf "$out/desk-node-$version-app.tar.gz" "desk-node-$version"
echo "full $(du -h "$out/desk-node-$version.tar.gz" | cut -f1), app-only $(du -h "$out/desk-node-$version-app.tar.gz" | cut -f1)" >&2
echo "$out/desk-node-$version.tar.gz"
