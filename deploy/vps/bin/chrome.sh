#!/usr/bin/env bash
# Chrome for the single VPS VNC desktop. The unit should end after its last
# browser window closes, even when Chrome keeps background helpers running.
set -euo pipefail

/usr/bin/google-chrome-stable \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-mode \
  --disable-dev-shm-usage \
  about:blank &
chrome_pid=$!

cleanup() {
  kill -TERM "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

seen_window=0
missing_checks=0
start_seconds=$SECONDS
while kill -0 "$chrome_pid" 2>/dev/null; do
  # Match the actual browser window, not Chrome's hidden helper window.
  # Do not use --onlyvisible: minimizing a window should not end the app.
  if xdotool search --class '^Google-chrome$' >/dev/null 2>&1; then
    seen_window=1
    missing_checks=0
  elif (( seen_window )); then
    ((missing_checks += 1))
    if (( missing_checks >= 2 )); then break; fi
  elif (( SECONDS - start_seconds >= 30 )); then
    # Also handle a window that opened and closed before the first poll.
    break
  fi
  sleep 2
done
