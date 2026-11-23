#!/usr/bin/env python3
"""handoff: pass one task between agents on any machines (A -> B -> C -> A ...), through a Git hub.

Participants are named agent@machine, where machine is where the task's files live (Claude on a
VPS editing files on pc-home through desk is claude@pc-home). Exactly one participant owns a task.

What crosses over on each hop is deterministic state, not agent memory:
  files/   a snapshot of the task's working directory (secrets, build output and ignored files excluded)
  ledger/  state.json (owner, status, epoch, op id, sessions), task.md, log.md (one note per hop)
Each agent resumes its own native session when the task comes back; when it cannot, task.md, the
log and the snapshot diff are enough to continue.

Safety:
  - The hub's pre-receive hook is the authority: only the owner's machine (or a hub admin) may move
    a task, every transition raises the epoch by exactly 1, and history cannot be rewritten or deleted.
  - Snapshots live in a private Git directory (~/.handoff/repo.git); the project's own .git, branch,
    index and stash are never touched, and folders that are not Git repositories work the same way.
  - take never overwrites changes it did not write: if the working directory differs from the last
    state this machine synced, it stops.
  - Every operation has an op id, so retrying after a lost push response does not hand off twice.
  - Agents only write notes (.handoff/outbox.md). handoff itself snapshots, checks and pushes.

Machine setup:   handoff setup --machine <name> --hub <git url or path> [--root <dir for received tasks>]
Hub setup (once): handoff hub-init <path> --admins <machine,...>
SSH access for a machine (authorized_keys on the hub host):
  command="python3 <path>/hooks/handoff.py serve <machine> <hub path>",restrict ssh-ed25519 ...

Task commands (run on the machine that holds the files):
  start <task> --as <agent> [--dir D] [--title T]   create a task from a directory; you own it
  pass <task> <agent@machine> [--as <agent>]        snapshot, record outbox.md as the note, hand over
  take <task> [--as <agent>] [--dir D]              receive a task handed to you; prints what is new
  run <task> [--then <agent@machine>]               launch the owning agent (agents in config), then pass
  session <task> <id>                               record your agent session id (for resume)
  done <task> | cancel <task>                       finish or drop a task (cancel: owner or hub admin)
  reassign <task> <agent@machine>                   hub admin only: give a task to someone else
  inbox | list | status <task> | log <task> | diff <task> [from-epoch [to-epoch]] | doctor
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

PROTOCOL = 2
ZERO = '0' * 40
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
HOME = Path(os.environ.get('HANDOFF_HOME') or Path.home() / '.handoff').resolve()
REPO = HOME / 'repo.git'
VIEW = '.handoff'
PARTICIPANT = re.compile(r'^[a-z][a-z0-9_-]*@[a-z0-9][a-z0-9_.-]*$')
AGENT = re.compile(r'^[a-z][a-z0-9_-]*$')
TASK_ID = re.compile(r'^[a-z0-9][a-z0-9_.-]{0,63}$')
IDENT = {'GIT_AUTHOR_NAME': 'handoff', 'GIT_AUTHOR_EMAIL': 'handoff@invalid',
         'GIT_COMMITTER_NAME': 'handoff', 'GIT_COMMITTER_EMAIL': 'handoff@invalid'}
MAX_DIFF = 256 * 1024
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----'
                    rb'|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}'
                    rb'|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}')
EXCLUDES = """\
# handoff never snapshots these (add more in <dir>/.handoffignore; .gitignore files apply too)
/.handoff/
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
id_ecdsa*
.ssh/
.aws/
.netrc
.npmrc
.pypirc
*.kdbx
node_modules/
.venv/
venv/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.gradle/
.DS_Store
Thumbs.db
"""
AGENTS = {
    'codex': {
        'start': ['codex', 'exec', '--json', '-C', '{dir}', '-s', 'workspace-write', '-o', '{last}', '{prompt}'],
        'resume': ['codex', 'exec', 'resume', '{sid}', '--json', '-o', '{last}',
                   '-c', 'sandbox_mode="workspace-write"', '{prompt}'],
        'session': 'jsonl:thread_id',
    },
    'claude': {
        'start': ['claude', '-p', '--output-format', 'json', '{prompt}'],
        'resume': ['claude', '-p', '--output-format', 'json', '--resume', '{sid}', '{prompt}'],
        'session': 'json:session_id',
        'last': 'json:result',
    },
}
README = """\
# Handoff

This directory is one task passed between agents with `handoff`. Exactly one participant
(agent@machine) owns it; the others do not edit these files meanwhile. This folder is a view:
the hub holds the real state.

When you receive the task:
1. Read `task.md` (goal, acceptance, constraints) and the entries in `log.md` newer than your own
   last one; the newest is addressed to you.
2. Check what actually changed in `changes.diff` (the files since you last held the task; for
   other ranges, whoever started you can run `handoff diff <task> <a> <b>`). Trust the diff over
   the note. A transcript named in an entry is for looking things up, not for reading whole.
3. Work. Keep `task.md` current if the goal or constraints change.

When you stop (done, blocked, a question for the user, or a stopping point the entry asked for),
write your note into `outbox.md` with this template, then end your turn. Do not edit `log.md` or
`state.json`, and do not commit unless `task.md` says so: `handoff pass` records everything.

    ### Done
    ### Verified
    Tests run and their results; what is still unverified.
    ### State
    What works, what does not.
    ### Tried and dropped
    ### Decisions
    ### Next
    What the receiver should do next; questions for the user; any external action left half done.
"""
TASK_TEMPLATE = """\
# Task: {title}

## Goal

## Acceptance
- [ ]

## Constraints

## Context
"""


class Fail(Exception):
    pass


def now():
    return datetime.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z')


def git(*args, gd=REPO, wt=None, index=None, data=None, check=True, env=None, raw=False, cwd=None):
    cmd = ['git']
    if gd is not None:
        cmd += ['--git-dir', str(gd)]
    if wt is not None:
        cmd += ['--work-tree', str(wt)]
    e = {**os.environ, **(env or {})}
    if index is not None:
        e['GIT_INDEX_FILE'] = str(index)
    p = subprocess.run(cmd + [str(a) for a in args], input=data, capture_output=True, env=e, cwd=cwd)
    if check and p.returncode:
        raise Fail(f"git {args[0]} failed: {p.stderr.decode('utf-8', 'replace').strip()}")
    return p if raw else p.stdout.decode('utf-8', 'replace').strip()


# ---------- configuration and local records ----------

def config():
    f = HOME / 'config.json'
    if not f.exists():
        raise Fail(f'no {f}; run: handoff setup --machine <name> --hub <url>')
    c = json.loads(f.read_text('utf-8'))
    c.setdefault('agents', {})
    return c


def hub_is_local(c):
    return not re.match(r'^[\w.-]+@?[\w.-]*:(?!\\|/)', c['hub']) and '://' not in c['hub']


def record_file(tid):
    return HOME / 'tasks' / f'{tid}.json'


def load_record(tid):
    f = record_file(tid)
    return json.loads(f.read_text('utf-8')) if f.exists() else None


def save_record(tid, rec):
    f = record_file(tid)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix('.tmp')
    tmp.write_text(json.dumps(rec, indent=2), 'utf-8')
    os.replace(tmp, f)


def index_file(tid):
    (HOME / 'tasks').mkdir(parents=True, exist_ok=True)
    return HOME / 'tasks' / f'{tid}.index'


def check_task_id(tid):
    if not TASK_ID.match(tid):
        raise Fail(f'task ids are lowercase words, digits, - _ . (max 64): {tid}')


def check_participant(p):
    if not PARTICIPANT.match(p):
        raise Fail(f'participants are agent@machine in lowercase, e.g. codex@pc-home: {p}')


def machine_of(p):
    return p.split('@', 1)[1]


def agent_of(p):
    return p.split('@', 1)[0]


# ---------- hub access ----------

def fetch():
    git('fetch', '--quiet', '--prune', 'hub', '+refs/tasks/*:refs/hub/tasks/*')


def tip(tid):
    return git('rev-parse', '-q', '--verify', f'refs/hub/tasks/{tid}^{{commit}}', check=False) or None


def state_at(commit):
    return json.loads(git('show', f'{commit}:ledger/state.json'))


def ledger_file(commit, name):
    return git('show', f'{commit}:ledger/{name}', raw=True).stdout.decode('utf-8', 'replace')


def files_tree(commit):
    return git('rev-parse', f'{commit}:files')


def push(c, tid, commit, op):
    """Push one transition; after a failure, the push counts as done if the hub's tip carries our op id."""
    env = {}
    if hub_is_local(c):
        env['HANDOFF_PUSHER'] = os.environ.get('HANDOFF_PUSHER') or c['machine']
    git('update-ref', f'refs/pending/{tid}', commit)
    p = git('push', '--quiet', 'hub', f'{commit}:refs/tasks/{tid}', env=env, check=False, raw=True)
    lost = os.environ.get('HANDOFF_TEST_LOSE_PUSH_RESULT') == '1'
    if p.returncode == 0 and not lost:
        fetch()
        git('update-ref', '-d', f'refs/pending/{tid}')
        return
    try:
        fetch()
    except Fail:
        pass
    t = tip(tid)
    if t and state_at(t).get('op') == op:
        git('update-ref', '-d', f'refs/pending/{tid}')
        return
    err = p.stderr.decode('utf-8', 'replace').strip()
    reasons = [l.split('handoff:', 1)[1].strip() for l in err.splitlines() if 'handoff:' in l]
    raise Fail('the hub did not accept this change: ' + ('; '.join(reasons) or err or 'unknown error')
               + f'. Nothing in the working directory was lost; the attempted snapshot is refs/pending/{tid}.')


# ---------- snapshots ----------

def tree_of(tid, wd):
    """Tree of wd as handoff sees it (private index; the project's own Git state is untouched)."""
    if not wd.exists():
        return EMPTY_TREE
    idx = index_file(tid)
    idx.parent.mkdir(parents=True, exist_ok=True)
    ignore = (wd / '.handoffignore').as_posix()
    ex = ('-c', f'core.excludesFile={ignore}')
    git(*ex, 'add', '-A', '.', wt=wd, index=idx, cwd=wd)
    # Files excluded after they were first seen leave the snapshot too.
    stale = git(*ex, 'ls-files', '-z', '--cached', '--ignored', '--exclude-standard', wt=wd, index=idx, cwd=wd, raw=True).stdout
    if stale.strip(b'\0'):
        git(*ex, 'rm', '-q', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul', wt=wd, index=idx, cwd=wd, data=stale)
    return git('write-tree', index=idx)


def check_snapshot(c, prev, tree, allow_secrets=False):
    max_file = int(c.get('max_file_mb', 20)) * 1024 * 1024
    max_total = int(c.get('max_total_mb', 200)) * 1024 * 1024
    total, big = 0, []
    for line in git('ls-tree', '-r', '-l', tree).splitlines():
        meta, path = line.split('\t', 1)
        size = meta.split()[3]
        if size != '-':
            total += int(size)
            if int(size) > max_file:
                big.append(f'{path} ({int(size) // 1048576} MiB)')
    if big:
        raise Fail('files over max_file_mb: ' + ', '.join(big[:10]) + '; exclude them in .handoffignore')
    if total > max_total:
        raise Fail(f'snapshot is {total // 1048576} MiB, over max_total_mb; exclude build output or data in .handoffignore')
    if allow_secrets:
        return
    changed = git('diff-tree', '-r', '--no-renames', '--diff-filter=AM', prev or EMPTY_TREE, tree).splitlines()
    blobs = {l.split()[3]: l.split('\t', 1)[1] for l in changed if l.startswith(':')}
    if not blobs:
        return
    out = git('cat-file', '--batch', data=''.join(f'{b}\n' for b in blobs).encode(), raw=True).stdout
    hits, pos = [], 0
    while pos < len(out):
        nl = out.index(b'\n', pos)
        sha, _, size = out[pos:nl].decode().split()
        body = out[nl + 1: nl + 1 + int(size)]
        pos = nl + 2 + int(size)
        if SECRET.search(body):
            hits.append(blobs[sha])
    if hits:
        raise Fail('possible secrets in: ' + ', '.join(hits[:10]) +
                   '; exclude them in .handoffignore, or pass --allow-secrets if they are not secrets')


def restore(tid, wd, base, new):
    """Move wd from tree `base` (verified to be its current content) to tree `new`."""
    idx = index_file(tid)
    wd.mkdir(parents=True, exist_ok=True)
    if base == new:
        return
    if base == EMPTY_TREE:
        git('read-tree', new, index=idx)
        git('checkout-index', '-a', '-f', wt=wd, index=idx, cwd=wd)
        return
    git('update-index', '-q', '--refresh', wt=wd, index=idx, check=False, cwd=wd)
    git('read-tree', '-m', '-u', base, new, wt=wd, index=idx, cwd=wd)


def diffstat(a, b):
    return git('diff', '--stat=100', a, b) or '(no file changes)'


def shortstat(a, b):
    return git('diff', '--shortstat', a, b).strip() or 'no file changes'


def make_commit(files, ledger, parent, message):
    entries = []
    for name, text in sorted(ledger.items()):
        h = git('hash-object', '-w', '--stdin', data=text.encode('utf-8'))
        entries.append(f'100644 blob {h}\t{name}\n')
    lt = git('mktree', data=''.join(entries).encode())
    root = git('mktree', data=f'040000 tree {files}\tfiles\n040000 tree {lt}\tledger\n'.encode())
    return git('commit-tree', root, '-m', message, *(['-p', parent] if parent else []), env=IDENT)


def ledger_of(state, task_md, log_md):
    return {'state.json': json.dumps(state, indent=2, ensure_ascii=False) + '\n', 'task.md': task_md, 'log.md': log_md}


def write_view(wd, commit, me=None):
    """The agent-facing copy of the ledger. Agents need no handoff CLI and no hub access to use it."""
    v = wd / VIEW
    (v / 'runs').mkdir(parents=True, exist_ok=True)
    (v / '.gitignore').write_text('*\n', 'utf-8')  # keeps the view out of the project's git status
    (v / 'README.md').write_text(README, 'utf-8')
    for name in ('task.md', 'log.md', 'state.json'):
        (v / name).write_text(ledger_file(commit, name), 'utf-8')
    (v / 'outbox.md').touch()
    if me:
        st = state_at(commit)
        lp = st.get('last_pass', {}).get(me)
        if lp:
            d = git('diff', lp['tree'], files_tree(commit), raw=True).stdout
            head = f"# Changes to the files since {me} passed at #{lp['epoch']} (now #{st['epoch']})\n"
            if len(d) > MAX_DIFF:
                d = d[:MAX_DIFF] + b'\n[... cut; the full diff: handoff diff ' + f"{st['task']} {lp['epoch']}".encode() + b']\n'
            (v / 'changes.diff').write_bytes(head.encode() + (d or b'(no file changes)\n'))
        else:
            (v / 'changes.diff').write_text(f'# {me} has not held this task before: read task.md and the whole log.\n', 'utf-8')


def entries_after(log_md, epoch):
    out, show = [], False
    for line in log_md.splitlines(keepends=True):
        m = re.match(r'^## #(\d+) ', line)
        if m:
            show = int(m.group(1)) > epoch
        if show:
            out.append(line)
    return ''.join(out)


def news_for(state, commit, me):
    lp = state.get('last_pass', {}).get(me)
    since, tree = (lp['epoch'], lp['tree']) if lp else (0, None)
    lines = [f"{state['task']}: owner {state['owner']}, {state['status']}, epoch {state['epoch']}"]
    if tree:
        lines.append(f"changes since you passed at #{since}: handoff diff {state['task']} {since}")
        lines.append(diffstat(tree, files_tree(commit)))
    lines.append('')
    lines.append(entries_after(ledger_file(commit, 'log.md'), since).rstrip() or '(no new log entries)')
    return '\n'.join(lines)


# ---------- task commands ----------

def me_for(c, state, as_agent):
    me = state['owner']
    if machine_of(me) != c['machine']:
        raise Fail(f"{state['task']} is held by {me}, not by anyone on {c['machine']}")
    if as_agent and agent_of(me) != as_agent:
        raise Fail(f"{state['task']} is held by {me}, not {as_agent}@{c['machine']}")
    return me


def current(tid):
    fetch()
    t = tip(tid)
    if not t:
        raise Fail(f'no task {tid} on the hub; see: handoff list')
    return t, state_at(t)


def cmd_start(a):
    c = config()
    check_task_id(a.task)
    if not AGENT.match(a.as_agent):
        raise Fail(f'agent names are lowercase words: {a.as_agent}')
    me = f"{a.as_agent}@{c['machine']}"
    check_participant(me)
    fetch()
    if tip(a.task) or load_record(a.task):
        raise Fail(f'task {a.task} already exists')
    wd = Path(a.dir or os.getcwd()).resolve()
    if not wd.is_dir():
        raise Fail(f'not a directory: {wd}')
    v = wd / VIEW
    v.mkdir(exist_ok=True)
    task_md = (v / 'task.md').read_text('utf-8') if (v / 'task.md').exists() else TASK_TEMPLATE.format(title=a.title or a.task)
    index_file(a.task).unlink(missing_ok=True)
    files = tree_of(a.task, wd)
    check_snapshot(c, None, files, a.allow_secrets)
    head = git('rev-parse', '-q', '--verify', 'HEAD', gd=wd / '.git', check=False) if (wd / '.git').exists() else ''
    op = uuid.uuid4().hex
    state = {'protocol': PROTOCOL, 'task': a.task, 'title': a.title or a.task, 'owner': me, 'status': 'active',
             'epoch': 1, 'op': op, 'sessions': {me: a.session} if a.session else {}, 'last_pass': {},
             'source': {'machine': c['machine'], 'dir': str(wd), 'commit': head or None}}
    log_md = (f"# Handoff log: {a.task}\n\nAppended by handoff, newest last.\n\n## #1 start · {me} · {now()}\n\n"
              f"- Directory: {c['machine']}:{wd}" + (f' (Git HEAD {head[:12]})' if head else '') + '\n')
    commit = make_commit(files, ledger_of(state, task_md, log_md), None, f'{a.task} #1 start by {me}')
    push(c, a.task, commit, op)
    save_record(a.task, {'workdir': str(wd), 'last_tree': files, 'last_commit': commit, 'sessions': state['sessions']})
    write_view(wd, commit)
    print(f'started {a.task}: {me} owns it; files {wd}; next: fill {v / "task.md"}')


def do_pass(c, tid, to, as_agent=None, fallback=None, transcript=None, allow_secrets=False, status='open'):
    if to:
        check_participant(to)
    t, st = current(tid)
    me = me_for(c, st, as_agent)
    if st['status'] != 'active':
        raise Fail(f"{tid} is {st['status']}; take it first")
    rec = load_record(tid)
    if not rec:
        raise Fail(f'this machine has no working copy of {tid}; take it first')
    if rec['last_commit'] != t:
        raise Fail(f'the hub moved {tid} since this machine last synced it; see: handoff status {tid}')
    wd = Path(rec['workdir'])
    prev = files_tree(t)
    files = tree_of(tid, wd)
    check_snapshot(c, prev, files, allow_secrets)
    v = wd / VIEW
    outbox = (v / 'outbox.md').read_text('utf-8') if (v / 'outbox.md').exists() else ''
    note = outbox if outbox.strip() else (fallback or '(no note written)')
    task_md = (v / 'task.md').read_text('utf-8') if (v / 'task.md').exists() else ledger_file(t, 'task.md')
    epoch = st['epoch'] + 1
    sessions = {**st.get('sessions', {}), **rec.get('sessions', {})}
    head = f'## #{epoch} {me} → {to}' if status == 'open' else f'## #{epoch} {status} · {me}'
    entry = [f'\n{head} · {now()}\n\n',
             f"- Changes: {shortstat(prev, files)}; `handoff diff {tid} {st['epoch']} {epoch}`\n"]
    if sessions.get(me):
        entry.append(f'- {me} session: {sessions[me]}\n')
    if transcript:
        entry.append(f"- Transcript: {c['machine']}:{transcript}\n")
    entry.append(f'\n{note.strip()}\n')
    op = uuid.uuid4().hex
    new = {**st, 'status': status, 'epoch': epoch, 'op': op, 'sessions': sessions,
           'last_pass': {**st.get('last_pass', {}), me: {'epoch': epoch, 'tree': files}}}
    if status == 'open':
        new.update(owner=to, prev_owner=me)
    log_md = ledger_file(t, 'log.md') + ''.join(entry)
    commit = make_commit(files, ledger_of(new, task_md, log_md), t, f'{tid} #{epoch} {me} -> {to or status}')
    push(c, tid, commit, op)
    (v / 'outbox.md').write_text('', 'utf-8')
    rec.update(last_tree=files, last_commit=commit, sessions=sessions)
    save_record(tid, rec)
    write_view(wd, commit)
    return epoch, shortstat(prev, files)


def cmd_pass(a):
    c = config()
    epoch, stat = do_pass(c, a.task, a.to, a.as_agent, allow_secrets=a.allow_secrets)
    print(f'#{epoch} {a.task} → {a.to} ({stat})')
    if machine_of(a.to) != c['machine']:
        print(f'on {machine_of(a.to)}: handoff take {a.task}')


def cmd_take(a):
    c = config()
    t, st = current(a.task)
    me = me_for(c, st, a.as_agent)
    rec = load_record(a.task)
    if st['status'] == 'active':
        if rec and rec['last_commit'] == t:
            print(news_for(st, t, me))
            return
        raise Fail(f'{a.task} is already active for {me} elsewhere on this machine state; see: handoff status {a.task}')
    if st['status'] != 'open':
        raise Fail(f"{a.task} is {st['status']}")
    if a.dir:
        wd = Path(a.dir).resolve()
    elif rec:
        wd = Path(rec['workdir'])
    elif c.get('root'):
        wd = Path(c['root']) / a.task
    else:
        raise Fail('no --dir given and no "root" in config')
    same = bool(rec) and Path(rec['workdir']) == wd
    if not same:
        index_file(a.task).unlink(missing_ok=True)
    new_files = files_tree(t)
    cur = tree_of(a.task, wd)
    if same:
        if cur != rec['last_tree']:
            raise Fail(f'{wd} has changes this machine did not sync:\n{diffstat(rec["last_tree"], cur)}\n'
                       f'Move or undo them first (handoff does not overwrite work), or take into another --dir.')
        base = cur
    elif cur in (EMPTY_TREE, new_files):
        base = cur
    else:
        raise Fail(f'{wd} is not empty and does not match the task; pass an empty or new --dir')
    restore(a.task, wd, base, new_files)
    op = uuid.uuid4().hex
    new = {**st, 'status': 'active', 'epoch': st['epoch'] + 1, 'op': op,
           'taken': {'by': me, 'dir': f"{c['machine']}:{wd}", 'at': now()}}
    commit = make_commit(new_files, ledger_of(new, ledger_file(t, 'task.md'), ledger_file(t, 'log.md')), t,
                         f"{a.task} #{new['epoch']} taken by {me}")
    push(c, a.task, commit, op)
    sessions = {**st.get('sessions', {}), **((rec or {}).get('sessions', {}))}
    save_record(a.task, {'workdir': str(wd), 'last_tree': new_files, 'last_commit': commit, 'sessions': sessions})
    write_view(wd, commit, me)
    print(f'took {a.task} into {wd}')
    print(news_for(new, commit, me))


def cmd_session(a):
    config()
    rec = load_record(a.task) or {}
    if not rec:
        raise Fail(f'this machine has no working copy of {a.task}')
    t, st = current(a.task)
    rec.setdefault('sessions', {})[st['owner']] = a.id
    save_record(a.task, rec)
    print(f"{st['owner']} session: {a.id} (recorded on the next pass)")


def fill(argv, values):
    return [re.sub(r'\{(\w+)\}', lambda m: str(values.get(m.group(1), m.group(0))), x) for x in argv]


def extract(spec, path):
    kind, key = spec.split(':', 1)
    text = Path(path).read_text('utf-8', 'replace') if Path(path).exists() else ''
    if kind == 'jsonl':
        for line in text.splitlines():
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get(key):
                return str(obj[key])
    elif kind == 'json':
        for chunk in reversed(text.strip().splitlines()):
            try:
                obj = json.loads(chunk)
            except ValueError:
                continue
            if isinstance(obj, dict) and key in obj:
                return str(obj[key])
    return None


def cmd_run(a):
    c = config()
    t, st = current(a.task)
    me = me_for(c, st, None)
    if st['status'] != 'active':
        raise Fail(f"{a.task} is {st['status']}; take it first")
    agent = agent_of(me)
    launcher = c['agents'].get(agent) or AGENTS.get(agent)
    if not launcher:
        raise Fail(f'no launcher for {agent} in config; let the user start it, then use pass')
    then = a.then or st.get('prev_owner')
    if not then:
        raise Fail('nobody to hand back to; pass --then <agent@machine>')
    check_participant(then)
    rec = load_record(a.task)
    if not rec or rec['last_commit'] != t:
        raise Fail(f'this machine is not in sync with {a.task}; see: handoff status {a.task}')
    wd = Path(rec['workdir'])
    write_view(wd, t, me)
    sid = rec.get('sessions', {}).get(me) or st.get('sessions', {}).get(me)
    since = st.get('last_pass', {}).get(me, {}).get('epoch', 0)
    runs = wd / VIEW / 'runs'
    out, last = runs / f"{st['epoch']}-{agent}.log", runs / f"{st['epoch']}-{agent}.last.md"
    prompt = (f"You are {me}. You have been handed task {a.task} by {st.get('prev_owner') or 'another agent'}.\n"
              f"1. Read .handoff/README.md (the protocol), then .handoff/task.md.\n"
              f"2. Read the entries in .handoff/log.md after #{since}; the newest is addressed to you.\n"
              f"3. .handoff/changes.diff shows what changed in the files since you last held it.\n"
              f"Then do the work. When you finish or need to stop, write your note for {then} into "
              f".handoff/outbox.md using the template in README.md and end your turn. Do not edit log.md or "
              f"state.json, and do not commit unless task.md says so.")
    argv = fill(launcher['resume' if sid else 'start'], {'dir': wd, 'last': last, 'sid': sid, 'prompt': prompt})
    exe = shutil.which(argv[0])
    if not exe:
        raise Fail(f'{argv[0]} is not on PATH')
    print(f"#{st['epoch']} {a.task}: running {me}{' (resuming ' + sid + ')' if sid else ''}; transcript {out}", flush=True)
    with open(out, 'wb') as f:
        rc = subprocess.run([exe, *argv[1:]], cwd=wd, stdin=subprocess.DEVNULL, stdout=f).returncode
    if not sid and launcher.get('session'):
        sid = extract(launcher['session'], out)
        if sid:
            rec = load_record(a.task)
            rec.setdefault('sessions', {})[me] = sid
            save_record(a.task, rec)
    lastmsg = extract(launcher['last'], out) if launcher.get('last') else (last.read_text('utf-8', 'replace') if last.exists() else None)
    fallback = f"({me} wrote no note{'; it exited with code ' + str(rc) if rc else ''}). Its last message:\n\n{(lastmsg or '(none)').strip()}"
    epoch, stat = do_pass(c, a.task, then, fallback=fallback, transcript=str(out))
    print(f'#{epoch} {a.task} → {then} ({stat})')
    return rc


def cmd_finish(a, status):
    c = config()
    epoch, stat = do_pass(c, a.task, None, status=status, allow_secrets=getattr(a, 'allow_secrets', False))
    print(f'#{epoch} {a.task} {status} ({stat})')


def admin_transition(a, status, to=None):
    c = config()
    t, st = current(a.task)
    if st['status'] in ('done', 'cancelled'):
        raise Fail(f"{a.task} is {st['status']}")
    epoch = st['epoch'] + 1
    op = uuid.uuid4().hex
    new = {**st, 'epoch': epoch, 'op': op, 'status': status}
    if to:
        check_participant(to)
        new.update(owner=to, prev_owner=st['owner'])
    what = f'reassigned to {to}' if to else status
    log_md = ledger_file(t, 'log.md') + f"\n## #{epoch} {what} by hub admin on {c['machine']} · {now()}\n\n" \
             f"- Was: {st['owner']} ({st['status']}). Work that {st['owner']} did not pass is not included.\n"
    commit = make_commit(files_tree(t), ledger_of(new, ledger_file(t, 'task.md'), log_md), t, f'{a.task} #{epoch} {what}')
    push(c, a.task, commit, op)
    print(f'#{epoch} {a.task} {what}')


def cmd_cancel(a):
    c = config()
    _, st = current(a.task)
    rec = load_record(a.task)
    if machine_of(st['owner']) == c['machine'] and st['status'] == 'active' and rec and rec['last_commit'] == tip(a.task):
        cmd_finish(a, 'cancelled')
    else:
        admin_transition(a, 'cancelled')


def all_tasks():
    fetch()
    out = []
    for line in git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/hub/tasks/').splitlines():
        sha, ref = line.split()
        out.append((ref.rsplit('/', 1)[1], sha, state_at(sha)))
    return out


def cmd_list(a, inbox=False):
    c = config()
    rows = all_tasks()
    shown = 0
    for tid, _, st in rows:
        mine = machine_of(st['owner']) == c['machine']
        if inbox and not (mine and st['status'] in ('open', 'active')):
            continue
        if not inbox and not a.all and st['status'] in ('done', 'cancelled'):
            continue
        hint = {'open': '  ← take it here', 'active': '  ← active here'}.get(st['status'], '') if mine else ''
        print(f"{tid:24} {st['status']:9} #{st['epoch']:<3} {st['owner']:24} {st.get('title', '')}{hint}")
        shown += 1
    if not shown:
        print('nothing for this machine' if inbox else 'no tasks')


def cmd_status(a):
    c = config()
    t, st = current(a.task)
    print(f"{a.task}: {st.get('title', '')}\nowner {st['owner']} · {st['status']} · epoch {st['epoch']}")
    for p, s in st.get('sessions', {}).items():
        print(f'session {p}: {s}')
    if st.get('taken'):
        print(f"taken by {st['taken']['by']} into {st['taken']['dir']} at {st['taken']['at']}")
    rec = load_record(a.task)
    if rec:
        wd = Path(rec['workdir'])
        cur = tree_of(a.task, wd)
        sync = 'in sync with the hub' if rec['last_commit'] == t else 'BEHIND the hub (someone moved the task)'
        print(f'here: {wd}, {sync}; local changes since last sync: {shortstat(rec["last_tree"], cur)}')
    last = entries_after(ledger_file(t, 'log.md'), st['epoch'] - 2).strip()
    print('\nlatest entry:\n' + (last.split('\n## ')[-1] if last else '(none)'))


def cmd_log(a):
    config()
    t, _ = current(a.task)
    print(ledger_file(t, 'log.md'))


def epochs(t):
    out = {}
    for sha in git('rev-list', t).splitlines():
        out.setdefault(state_at(sha)['epoch'], sha)
    return out


def cmd_diff(a):
    config()
    t, st = current(a.task)
    ep = epochs(t)
    frm = int(a.frm) if a.frm is not None else max(1, st['epoch'] - 1)
    to = int(a.to) if a.to is not None else st['epoch']
    if frm not in ep or to not in ep:
        raise Fail(f"epochs run from 1 to {st['epoch']}")
    print(git('diff', *(['--stat=100'] if a.stat else []), files_tree(ep[frm]), files_tree(ep[to])) or '(no file changes)')


def cmd_setup(a):
    HOME.mkdir(parents=True, exist_ok=True)
    f = HOME / 'config.json'
    c = json.loads(f.read_text('utf-8')) if f.exists() else {}
    c['machine'] = a.machine
    c['hub'] = a.hub
    if a.root:
        c['root'] = a.root
    c.setdefault('agents', {})
    c.setdefault('max_file_mb', 20)
    c.setdefault('max_total_mb', 200)
    if not re.match(r'^[a-z0-9][a-z0-9_.-]*$', a.machine):
        raise Fail(f'machine names are lowercase: {a.machine}')
    f.write_text(json.dumps(c, indent=2), 'utf-8')
    if not REPO.exists():
        git('init', '--quiet', '--bare', str(REPO), gd=None)
    for k, v in (('core.autocrlf', 'false'), ('core.quotepath', 'false'), ('gc.auto', '0')):
        git('config', k, v)
    git('remote', 'remove', 'hub', check=False)
    git('remote', 'add', 'hub', a.hub)
    (REPO / 'info').mkdir(exist_ok=True)
    (REPO / 'info' / 'exclude').write_text(EXCLUDES, 'utf-8')
    fetch()
    print(f'{a.machine}: config {f}; hub {a.hub} reachable')


def cmd_doctor(a):
    c = config()
    print(f"machine {c['machine']}, hub {c['hub']}, root {c.get('root', '-')}")
    print(f"git {git('--version', gd=None)}; python {sys.version.split()[0]}")
    fetch()
    print(f'hub reachable; {len(all_tasks())} task(s)')
    for name in sorted(set(AGENTS) | set(c['agents'])):
        exe = (c['agents'].get(name) or AGENTS[name])['start'][0]
        print(f"agent {name}: {shutil.which(exe) or 'not on PATH'}")


# ---------- hub side ----------

def cmd_hub_init(a):
    hub = Path(a.path).expanduser().resolve()
    if not (hub / 'HEAD').exists():
        git('init', '--quiet', '--bare', str(hub), gd=None)
    for k, v in (('receive.denyNonFastForwards', 'true'), ('receive.denyDeletes', 'true'),
                 ('handoff.admins', a.admins), ('gc.auto', '0')):
        git('config', k, v, gd=hub)
    shutil.copyfile(__file__, hub / 'hooks' / 'handoff.py')
    hook = hub / 'hooks' / 'pre-receive'
    hook.write_text('#!/bin/sh\nexec python3 "$(dirname "$0")/handoff.py" hook\n')
    hook.chmod(0o755)
    print(f'hub {hub}; admins {a.admins}')


def hook_check(old, new, ref, pusher, admins):
    if not ref.startswith('refs/tasks/') or not TASK_ID.match(ref[len('refs/tasks/'):]):
        return 'only refs/tasks/<task> may be pushed'
    tid = ref[len('refs/tasks/'):]
    if new == ZERO:
        return 'tasks cannot be deleted'
    try:
        ns = json.loads(git('show', f'{new}:ledger/state.json', gd=None))
        git('rev-parse', f'{new}:files', gd=None)
    except (Fail, ValueError):
        return 'not a handoff commit'
    if ns.get('protocol') != PROTOCOL or ns.get('task') != tid or not PARTICIPANT.match(ns.get('owner', '')):
        return 'bad state.json'
    if ns.get('status') not in ('open', 'active', 'done', 'cancelled'):
        return f"unknown status {ns.get('status')}"
    parents = git('rev-list', '--parents', '-n', '1', new, gd=None).split()[1:]
    if old == ZERO:
        if parents or ns['epoch'] != 1 or ns['status'] != 'active':
            return 'a new task starts at epoch 1, active, with no history'
        if machine_of(ns['owner']) != pusher:
            return f"{pusher} cannot start a task owned by {ns['owner']}"
        return None
    if parents != [old]:
        return 'push exactly one transition on top of the current state (fetch first)'
    os_ = json.loads(git('show', f'{old}:ledger/state.json', gd=None))
    if ns['epoch'] != os_['epoch'] + 1:
        return f"epoch must go from {os_['epoch']} to {os_['epoch'] + 1}"
    if ns.get('op') == os_.get('op'):
        return 'repeated operation id'
    is_admin = pusher in admins
    owner_ok = machine_of(os_['owner']) == pusher
    a, b = os_['status'], ns['status']
    if a in ('done', 'cancelled'):
        return f'{tid} is {a}'
    if owner_ok and a == 'active' and b == 'open' and ns['owner'] != os_['owner']:
        return None  # pass
    if owner_ok and a == 'open' and b == 'active' and ns['owner'] == os_['owner']:
        return None  # take
    if owner_ok and b == 'cancelled' and ns['owner'] == os_['owner']:
        return None
    if owner_ok and a == 'active' and b == 'done' and ns['owner'] == os_['owner']:
        return None
    if is_admin and b == 'cancelled' and ns['owner'] == os_['owner']:
        return None
    if is_admin and b == 'open' and ns['owner'] != os_['owner']:
        return None  # reassign
    who = 'the hub admin' if is_admin else pusher
    return f"{who} cannot move {tid} from {a} ({os_['owner']}) to {b} ({ns['owner']})"


def cmd_hook(a):
    pusher = os.environ.get('HANDOFF_PUSHER', '')
    admins = set(filter(None, git('config', '--get', 'handoff.admins', gd=None, check=False).split(',')))
    if not pusher:
        print('handoff: unknown pusher (connect through handoff serve)', file=sys.stderr)
        return 1
    bad = False
    for line in sys.stdin.read().splitlines():
        old, new, ref = line.split()
        why = hook_check(old, new, ref, pusher, admins)
        if why:
            print(f'handoff: {ref}: {why}', file=sys.stderr)
            bad = True
    return 1 if bad else 0


def cmd_serve(a):
    """SSH forced command: let one machine talk to the hub, and nothing else."""
    cmd = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    verb = cmd.split(' ', 1)[0]
    if verb not in ('git-upload-pack', 'git-receive-pack'):
        print('handoff: this key only serves the handoff hub', file=sys.stderr)
        return 1
    os.environ['HANDOFF_PUSHER'] = a.machine
    os.execvp('git-shell', ['git-shell', '-c', f"{verb} '{Path(a.hub).expanduser()}'"])


# ---------- main ----------

def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(prog='handoff', description=__doc__.split('\n\n')[0])
    sub = p.add_subparsers(dest='cmd', required=True)

    def task_cmd(name, **kw):
        s = sub.add_parser(name, **kw)
        s.add_argument('task')
        return s

    s = task_cmd('start'); s.add_argument('--as', dest='as_agent', required=True); s.add_argument('--dir')
    s.add_argument('--title'); s.add_argument('--session'); s.add_argument('--allow-secrets', action='store_true')
    s = task_cmd('pass'); s.add_argument('to'); s.add_argument('--as', dest='as_agent'); s.add_argument('--allow-secrets', action='store_true')
    s = task_cmd('take'); s.add_argument('--as', dest='as_agent'); s.add_argument('--dir')
    s = task_cmd('run'); s.add_argument('--then')
    s = task_cmd('session'); s.add_argument('id')
    s = task_cmd('done'); s.add_argument('--allow-secrets', action='store_true')
    task_cmd('cancel')
    s = task_cmd('reassign'); s.add_argument('to')
    task_cmd('status'); task_cmd('log')
    s = task_cmd('diff'); s.add_argument('frm', nargs='?'); s.add_argument('to', nargs='?'); s.add_argument('--stat', action='store_true')
    sub.add_parser('inbox')
    s = sub.add_parser('list'); s.add_argument('--all', action='store_true')
    sub.add_parser('doctor')
    s = sub.add_parser('setup'); s.add_argument('--machine', required=True); s.add_argument('--hub', required=True); s.add_argument('--root')
    s = sub.add_parser('hub-init'); s.add_argument('path'); s.add_argument('--admins', required=True)
    sub.add_parser('hook')
    s = sub.add_parser('serve'); s.add_argument('machine'); s.add_argument('hub')
    a = p.parse_args(argv)
    try:
        r = {
            'start': cmd_start, 'pass': cmd_pass, 'take': cmd_take, 'run': cmd_run, 'session': cmd_session,
            'done': lambda a: cmd_finish(a, 'done'), 'cancel': cmd_cancel,
            'reassign': lambda a: admin_transition(a, 'open', a.to),
            'status': cmd_status, 'log': cmd_log, 'diff': cmd_diff,
            'inbox': lambda a: cmd_list(a, inbox=True), 'list': cmd_list, 'doctor': cmd_doctor,
            'setup': cmd_setup, 'hub-init': cmd_hub_init, 'hook': cmd_hook, 'serve': cmd_serve,
        }[a.cmd](a)
        return r if isinstance(r, int) else 0
    except Fail as e:
        print(f'handoff: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
