#!/usr/bin/env bash
# Start, stop or show the VPS remote browser (desk-browser-* system services; noVNC on 127.0.0.1:6091).
# Uses the sudoers rule that lets agent run exactly `systemctl start|stop desk-browser-<unit>.service`.
#   browser.sh start|stop|status      (exit 0 = done / all running for status)
set -euo pipefail
UNITS=(vnc window-manager web chrome)   # start order; window-manager, web and chrome bind to vnc
unit() { echo "desk-browser-$1.service"; }
all_active() { for u in "${UNITS[@]}"; do systemctl is-active --quiet "$(unit "$u")" || return 1; done; }
status() {
  for u in "${UNITS[@]}"; do printf '%-36s %s\n' "$(unit "$u")" "$(systemctl is-active "$(unit "$u")" || true)"; done
  if curl -fs -o /dev/null --max-time 3 http://127.0.0.1:6091/vnc.html; then echo 'noVNC 127.0.0.1:6091: ok'; else echo 'noVNC 127.0.0.1:6091: not answering'; fi
}
case "${1:-status}" in
  start)
    for u in "${UNITS[@]}"; do systemctl is-active --quiet "$(unit "$u")" || sudo -n /usr/bin/systemctl start "$(unit "$u")"; done
    for _ in $(seq 20); do curl -fs -o /dev/null --max-time 2 http://127.0.0.1:6091/vnc.html && break; sleep 0.5; done
    status ;;
  stop)
    for ((i = ${#UNITS[@]} - 1; i >= 0; i--)); do sudo -n /usr/bin/systemctl stop "$(unit "${UNITS[i]}")"; done
    status || true ;;
  status) status; all_active ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
