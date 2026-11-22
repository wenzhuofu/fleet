#!/usr/bin/env bash
# Fast-forward desk-fleet, refresh the user units, and install the Orca version fleet.conf names.
# Usage: kit/update.sh [fleet.conf]
# Nothing running is restarted: new Claude sessions pick up the new desk plugin on their own; a new
# Orca version is installed next to the old one and takes effect when orca.service restarts
# (that ends the Claude sessions running inside it, so the script only prints the command).
set -Eeuo pipefail

KIT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DESK_FLEET_DIR=$(cd -- "$KIT_DIR/.." && pwd)
CONF=${1:-$KIT_DIR/fleet.conf}
case "$CONF" in -h|--help) echo "Usage: $0 [fleet.conf]"; exit 0 ;; esac
[ ! -f "$CONF" ] || . "$CONF"
FLEET_HOME=${FLEET_HOME:-$HOME/fleet}
OPT_DIR=${OPT_DIR:-$HOME/opt}
ORCA_VERSION=${ORCA_VERSION:-1.4.268}
ORCA_DEB_SHA256=${ORCA_DEB_SHA256:-ce08aa4bb05972ee3acc89f6c97ce6140c84014a14b0c7e70fe6ece1b40b28a7}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [[ -n $(git -C "$DESK_FLEET_DIR" status --porcelain) ]]; then
  echo "Refusing to update a dirty worktree: $DESK_FLEET_DIR" >&2; git -C "$DESK_FLEET_DIR" status --short >&2; exit 1
fi
OLD=$(git -C "$DESK_FLEET_DIR" rev-parse --short HEAD)
echo "== 1/3 pull desk-fleet"
git -C "$DESK_FLEET_DIR" pull --ff-only
echo "desk-fleet $OLD -> $(git -C "$DESK_FLEET_DIR" rev-parse --short HEAD)"
# The desk plugin is read from this checkout; refresh the marketplace entry so its version shows.
"$HOME/.local/bin/claude" plugin marketplace update fleet >/dev/null 2>&1 || echo "note: claude plugin marketplace update fleet failed"

echo "== 2/3 Orca $ORCA_VERSION"
orca_dir=$OPT_DIR/orca-desktop-$ORCA_VERSION
if [ ! -x "$orca_dir/opt/Orca/resources/bin/orca-ide" ]; then
  deb=$HOME/.cache/desk-fleet/orca-ide_${ORCA_VERSION}_amd64.deb
  mkdir -p "$(dirname "$deb")"
  curl -fsSL -o "$deb" "https://github.com/stablyai/orca/releases/download/v$ORCA_VERSION/orca-ide_${ORCA_VERSION}_amd64.deb"
  echo "$ORCA_DEB_SHA256  $deb" | sha256sum -c --quiet -
  rm -rf "$orca_dir.tmp" && mkdir -p "$orca_dir.tmp" && dpkg-deb -x "$deb" "$orca_dir.tmp" && mv "$orca_dir.tmp" "$orca_dir" && rm -f "$deb"
fi
if [ "$(readlink -f "$OPT_DIR/orca")" != "$(readlink -f "$orca_dir")" ]; then
  ln -sfn "$orca_dir" "$OPT_DIR/orca"
  echo "Orca $ORCA_VERSION installed. When no session is running: systemctl --user restart orca"
  echo "Then remove the previous version under $OPT_DIR/orca-desktop-*."
else
  echo "Orca $ORCA_VERSION already current"
fi

echo "== 3/3 refresh fleet-tidy units"
TPL=$DESK_FLEET_DIR/kit/templates
for u in fleet-tidy.service fleet-tidy.timer; do
  sed -e "s|@FLEET_REPO@|$DESK_FLEET_DIR|g" "$TPL/$u" > "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
echo "Done. orca.service is not touched by this script; re-run kit/bootstrap-vps.sh to re-render it."
