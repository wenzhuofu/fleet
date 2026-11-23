#!/usr/bin/env bash
# desk handoff: pass one task back and forth between agents (Claude, Codex, ...) in one Git repository.
#
# Each agent keeps its own native session and resumes it when the task comes back; what crosses over
# is a short note per hop plus a snapshot of the working tree, so the receiver reads only what changed.
# Everything lives in <repo>/.handoff/ (kept out of Git via .git/info/exclude):
#   task.md     goal, acceptance, constraints (written once by whoever starts the task)
#   log.md      one entry per handoff, appended by this script (newest last)
#   outbox.md   the outgoing agent's note; this script moves it into log.md on "pass"
#   state       owner, sequence number, agents' session ids
#   runs/       raw transcripts of agent runs started by "run" (read on demand, never passed whole)
# Snapshots are commits of the whole working tree under refs/handoff/<n>; the user's branch,
# index and stash are not touched.
#
# Usage (run anywhere inside the repository; Git Bash on Windows):
#   handoff.sh init <owner>              set up .handoff/, snapshot #0, <owner> holds the task
#   handoff.sh session <agent> <id>      record an agent's session id (for resume)
#   handoff.sh pass <from> <to>          snapshot, move outbox.md into log.md, <to> holds the task
#   handoff.sh run <agent> <back>        start or resume <agent> on the task, then pass it to <back>
#   handoff.sh take <agent>              what is new for <agent>: entries and changes since its last pass
#   handoff.sh status                    owner, sequence, sessions, changes since the last snapshot
# Agents for "run": codex.
set -euo pipefail

H=.handoff
die() { echo "handoff: $*" >&2; exit 1; }
root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a Git repository"
cd "$root"
STATE=$H/state

get() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | tail -n 1 || true; }
put() {
  touch "$STATE"
  { grep -v "^$1=" "$STATE" || true; echo "$1=$2"; } > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
need_setup() { [ -f "$STATE" ] || die "no task here; start with: handoff.sh init <owner>"; }
name_ok() { [[ $1 =~ ^[a-z][a-z0-9_-]*$ ]] || die "agent names are lowercase words (claude, codex, ...): $1"; }

# Commit the whole working tree (tracked and untracked, minus ignored files) as refs/handoff/<n>.
snap() {
  local n=$1 idx tree parent commit
  idx=$(mktemp)
  cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"
  GIT_INDEX_FILE=$idx git add -A
  tree=$(GIT_INDEX_FILE=$idx git write-tree)
  rm -f "$idx"
  parent=$(git rev-parse -q --verify refs/handoff/last || true)
  commit=$(GIT_AUTHOR_NAME=desk-handoff GIT_AUTHOR_EMAIL=desk-handoff@invalid \
           GIT_COMMITTER_NAME=desk-handoff GIT_COMMITTER_EMAIL=desk-handoff@invalid \
           git commit-tree "$tree" ${parent:+-p "$parent"} -m "handoff #$n")
  git update-ref "refs/handoff/$n" "$commit"
  git update-ref refs/handoff/last "$commit"
  echo "$commit"
}

write_readme() {
  cat > $H/README.md <<'EOF'
# Handoff protocol

One task is passed between agents here. Exactly one agent holds it at a time (`owner` in `state`);
the others do not edit the working tree meanwhile.

When you receive the task:
1. Read `task.md` (goal, acceptance, constraints).
2. Read the entries in `log.md` newer than your own last one; the newest is addressed to you.
3. Check what actually changed: each entry names `git diff refs/handoff/<a> refs/handoff/<b>`.
   Trust the diff over the note. A transcript path in an entry is for looking things up (grep it),
   not for reading whole.

When you stop (done, blocked, a question for the user, or a stopping point the entry asked for),
write your note into `outbox.md` with this template, then end your turn. Do not edit `log.md` or
`state`, and do not commit unless `task.md` says so: the handoff script records your changes.

    ### Done
    ### State
    What works, what does not, how to verify.
    ### Tried and dropped
    ### Decisions
    ### Next
    What the receiver should do next; questions for the user.
EOF
}

cmd_init() {
  local owner=${1:-}; [ -n "$owner" ] || die "usage: handoff.sh init <owner>"; name_ok "$owner"
  [ -f "$STATE" ] && die "already set up here (owner $(get owner), #$(get seq)); see: handoff.sh status"
  mkdir -p $H/runs
  local ex; ex=$(git rev-parse --git-path info/exclude)
  mkdir -p "$(dirname "$ex")"
  grep -qxF "/$H/" "$ex" 2>/dev/null || echo "/$H/" >> "$ex"
  write_readme
  [ -f $H/task.md ] || cat > $H/task.md <<'EOF'
# Task

## Goal

## Acceptance
- [ ]

## Constraints

## Context
EOF
  [ -f $H/log.md ] || printf '# Handoff log\n\nAppended by handoff.sh, newest last.\n' > $H/log.md
  : > $H/outbox.md
  put seq 0; put owner "$owner"; put "last_$owner" 0
  local c; c=$(snap 0)
  echo "set up $root/$H; $owner holds the task; snapshot #0 ${c:0:9}"
  echo "next: write $H/task.md"
}

cmd_session() {
  need_setup; local agent=${1:-} id=${2:-}
  [ -n "$agent" ] && [ -n "$id" ] || die "usage: handoff.sh session <agent> <id>"; name_ok "$agent"
  put "session_$agent" "$id"; echo "$agent session: $id"
}

cmd_pass() {
  need_setup; local from=${1:-} to=${2:-}
  [ -n "$from" ] && [ -n "$to" ] || die "usage: handoff.sh pass <from> <to>"; name_ok "$from"; name_ok "$to"
  local owner; owner=$(get owner)
  [ "$owner" = "$from" ] || [ "${HANDOFF_FORCE:-}" = 1 ] || die "$owner holds the task, not $from (HANDOFF_FORCE=1 to override)"
  local prev n c stat body sess
  prev=$(get seq); n=$((prev + 1))
  c=$(snap "$n")
  stat=$(git diff --shortstat "refs/handoff/$prev" "$c" | sed 's/^ *//'); [ -n "$stat" ] || stat="no file changes"
  body=$(cat $H/outbox.md 2>/dev/null || true)
  [ -n "${body//[[:space:]]/}" ] || body=${HANDOFF_FALLBACK:-"(no note written)"}
  sess=$(get "session_$from")
  {
    printf '\n## #%s %s → %s · %s\n\n' "$n" "$from" "$to" "$(date '+%Y-%m-%d %H:%M')"
    printf -- '- Changes: `git diff refs/handoff/%s refs/handoff/%s` (%s)\n' "$prev" "$n" "$stat"
    [ -z "$sess" ] || printf -- '- %s session: %s\n' "$from" "$sess"
    [ -z "${HANDOFF_TRANSCRIPT:-}" ] || printf -- '- Transcript: %s\n' "$HANDOFF_TRANSCRIPT"
    printf '\n%s\n' "$body"
  } >> $H/log.md
  : > $H/outbox.md
  put seq "$n"; put owner "$to"; put "last_$from" "$n"
  echo "#$n $from → $to ($stat)"
}

cmd_take() {
  need_setup; local me=${1:-}; [ -n "$me" ] || die "usage: handoff.sh take <agent>"; name_ok "$me"
  local owner n since; owner=$(get owner); n=$(get seq); since=$(get "last_$me"); since=${since:-0}
  [ "$owner" = "$me" ] || echo "note: $owner holds the task, not $me"
  echo "latest #$n; $me last passed at #$since"
  if [ "$since" -lt "$n" ]; then
    echo "changes since then: git diff refs/handoff/$since refs/handoff/$n"
    git diff --stat "refs/handoff/$since" "refs/handoff/$n" | tail -n 25
  fi
  echo
  awk -v since="$since" '/^## #[0-9]+ / { n = substr($2, 2) + 0; show = (n > since) } show' $H/log.md
}

cmd_status() {
  need_setup
  echo "repo: $root"
  echo "owner: $(get owner) · latest #$(get seq)"
  sed -n 's/^session_\([^=]*\)=/session \1: /p' "$STATE"
  local changed untracked
  changed=$(git diff --shortstat refs/handoff/last 2>/dev/null | sed 's/^ *//')
  untracked=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')
  echo "since snapshot #$(get seq): ${changed:-no changes to tracked files}; $untracked untracked file(s) in the tree"
}

run_codex() {
  local prompt=$1 out=$2 last=$3 sid rc=0
  command -v codex >/dev/null || die "codex is not on PATH"
  sid=$(get session_codex)
  if [ -n "$sid" ]; then
    codex exec resume "$sid" --json -o "$last" -c 'sandbox_mode="workspace-write"' "$prompt" < /dev/null > "$out" || rc=$?
  else
    codex exec --json -C "$root" -s workspace-write -o "$last" "$prompt" < /dev/null > "$out" || rc=$?
    sid=$(sed -n 's/.*"thread_id" *: *"\([^"]*\)".*/\1/p' "$out" | head -n 1)
    [ -z "$sid" ] || put session_codex "$sid"
  fi
  return $rc
}

cmd_run() {
  need_setup; local agent=${1:-} back=${2:-}
  [ -n "$agent" ] && [ -n "$back" ] || die "usage: handoff.sh run <agent> <back>"; name_ok "$agent"; name_ok "$back"
  local owner n since from out last prompt rc=0
  owner=$(get owner); [ "$owner" = "$agent" ] || die "$owner holds the task; pass it to $agent first"
  n=$(get seq); since=$(get "last_$agent"); since=${since:-0}
  from=$(awk '/^## #[0-9]+ / { f = $3 } END { print f }' $H/log.md)
  write_readme
  out=$H/runs/$n-$agent.jsonl; last=$H/runs/$n-$agent.last.md
  prompt="You are taking over a task handed to you by ${from:-another agent} through .handoff/ in this repository.
1. Read .handoff/README.md (the protocol) and .handoff/task.md.
2. Read the entries in .handoff/log.md after #$since; the newest, #$n, is addressed to you.
3. See what changed since you last worked on it: git diff refs/handoff/$since refs/handoff/$n
Then do the work. When you finish or need to stop, write your note for $back into .handoff/outbox.md using the template in README.md and end your turn. Do not edit log.md or state, and do not commit unless task.md says so."
  echo "#$n: running $agent (transcript $out)"
  case $agent in
    codex) run_codex "$prompt" "$out" "$last" || rc=$? ;;
    *) die "unknown agent $agent (supported: codex)" ;;
  esac
  local fallback="($agent wrote no note"
  [ "$rc" = 0 ] || fallback+="; it exited with code $rc"
  fallback+="). Its last message:"$'\n\n'"$(cat "$last" 2>/dev/null || echo '(none)')"
  HANDOFF_FALLBACK=$fallback HANDOFF_TRANSCRIPT=$out cmd_pass "$agent" "$back"
  return "$rc"
}

case ${1:-} in
  init) shift; cmd_init "$@" ;;
  session) shift; cmd_session "$@" ;;
  pass) shift; cmd_pass "$@" ;;
  run) shift; cmd_run "$@" ;;
  take) shift; cmd_take "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
