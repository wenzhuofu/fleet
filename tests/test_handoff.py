"""handoff/handoff.py: three simulated machines sharing a local hub (with its pre-receive hook), and a stub codex."""
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'handoff' / 'handoff.py'

# Records its arguments, edits a file, writes a note, prints a thread id like `codex exec --json`.
STUB = textwrap.dedent('''\
    #!/usr/bin/env bash
    echo "$*" | tr '\\n' ' ' >> "$STUB_LOG"; echo >> "$STUB_LOG"
    last=
    while [ $# -gt 0 ]; do [ "$1" = -o ] && { last=$2; shift; }; shift; done
    echo "codex was here" >> work.txt
    [ -n "${STUB_NOTE:-}" ] && printf '### Done\\n%s\\n' "$STUB_NOTE" > .handoff/outbox.md
    echo '{"type":"thread.started","thread_id":"th-123"}'
    echo "final answer" > "$last"
    exit "${STUB_RC:-0}"
''')


class Handoff(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        bindir = self.base / 'bin'
        bindir.mkdir()
        (bindir / 'codex').write_text(STUB)
        (bindir / 'codex').chmod(0o755)
        self.stub_log = self.base / 'codex-args'
        self.env = {**os.environ, 'PATH': f'{bindir}:{os.environ["PATH"]}', 'STUB_LOG': str(self.stub_log),
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        self.env.pop('HANDOFF_PUSHER', None)
        self.hub = self.base / 'hub.git'
        self.run_ok(['python3', SCRIPT, 'hub-init', self.hub, '--admins', 'vps'])
        for m in ('pc-a', 'pc-b', 'vps'):
            self.h(m, 'setup', '--machine', m, '--hub', str(self.hub), '--root', str(self.base / f'{m}-tasks'))
        # The project on pc-a: a Git repository with a commit, an edit, an untracked file and things to keep out.
        self.proj = self.base / 'proj'
        self.proj.mkdir()
        self.git(self.proj, 'init', '-q')
        (self.proj / 'a.txt').write_text('one\n')
        (self.proj / '.gitignore').write_text('build/\n')
        self.git(self.proj, 'add', '.')
        self.git(self.proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
        (self.proj / 'a.txt').write_text('two\n')
        (self.proj / 'new.txt').write_text('untracked\n')
        (self.proj / '.env').write_text('TOKEN=x\n')
        (self.proj / 'node_modules').mkdir()
        (self.proj / 'node_modules' / 'dep.js').write_text('x')
        (self.proj / 'build').mkdir()
        (self.proj / 'build' / 'out.bin').write_text('x')

    def run_ok(self, cmd, **kw):
        p = subprocess.run([str(c) for c in cmd], env=self.env, capture_output=True, text=True, **kw)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout

    def h(self, machine, *args, ok=True, cwd=None, **env):
        e = {**self.env, 'HANDOFF_HOME': str(self.base / f'home-{machine}'), **env}
        p = subprocess.run(['python3', str(SCRIPT), *map(str, args)], env=e, capture_output=True, text=True, cwd=cwd)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p

    def note(self, wd, text):
        (Path(wd) / '.handoff' / 'outbox.md').write_text(text)

    def hub_state(self, tid='t1'):
        return json.loads(subprocess.run(['git', '--git-dir', str(self.hub), 'show', f'refs/tasks/{tid}:ledger/state.json'],
                                         capture_output=True, text=True, check=True).stdout)

    def start(self):
        self.h('pc-a', 'start', 't1', '--as', 'claude', '--dir', self.proj, '--title', 'fix it', '--session', 'cl-1')

    def test_cross_machine_round_trip(self):
        before = (self.git(self.proj, 'status', '--porcelain'), self.git(self.proj, 'rev-parse', 'HEAD'),
                  self.git(self.proj, 'for-each-ref'), self.git(self.proj, 'stash', 'list'))
        self.start()
        self.note(self.proj, '### Next\nadd tests\n')
        out = self.h('pc-a', 'pass', 't1', 'codex@pc-b').stdout
        self.assertIn('#2 t1 → codex@pc-b', out)
        self.assertIn('on pc-b: handoff take t1', out)
        st = self.hub_state()
        self.assertEqual((st['owner'], st['status'], st['epoch']), ('codex@pc-b', 'open', 2))

        self.assertIn('take it here', self.h('pc-b', 'inbox').stdout)
        self.assertIn('nothing for this machine', self.h('pc-a', 'inbox').stdout)
        out = self.h('pc-b', 'take', 't1').stdout
        wd = self.base / 'pc-b-tasks' / 't1'
        self.assertIn('add tests', out)
        self.assertEqual((wd / 'a.txt').read_text(), 'two\n')
        self.assertEqual((wd / 'new.txt').read_text(), 'untracked\n')
        for kept_out in ('.env', 'node_modules', 'build', '.git'):
            self.assertFalse((wd / kept_out).exists(), kept_out)
        self.assertEqual(self.hub_state()['status'], 'active')

        (wd / 'a.txt').write_text('three\n')
        (wd / 'new.txt').unlink()
        (wd / 'test_a.py').write_text('ok\n')
        self.note(wd, '### Done\nwrote tests\n')
        self.h('pc-b', 'pass', 't1', 'claude@pc-a')

        out = self.h('pc-a', 'take', 't1').stdout
        self.assertIn('wrote tests', out)
        self.assertIn('changes since you passed at #2', out)
        diff = (self.proj / '.handoff' / 'changes.diff').read_text()
        self.assertIn('since claude@pc-a passed at #2', diff)
        self.assertIn('-two\n+three', diff)
        self.assertNotIn('.handoff', self.git(self.proj, 'status', '--porcelain'))
        self.assertIn('has not held this task before', (wd / '.handoff' / 'changes.diff').read_text())
        self.assertNotIn('add tests', out)  # only entries after its own pass
        self.assertEqual((self.proj / 'a.txt').read_text(), 'three\n')
        self.assertFalse((self.proj / 'new.txt').exists())
        self.assertTrue((self.proj / 'test_a.py').exists())
        self.assertEqual((self.proj / '.env').read_text(), 'TOKEN=x\n')  # excluded files are left alone
        self.assertTrue((self.proj / 'build' / 'out.bin').exists())
        # The project's own Git state is untouched apart from the files themselves.
        self.assertEqual(self.git(self.proj, 'rev-parse', 'HEAD'), before[1])
        self.assertEqual(self.git(self.proj, 'for-each-ref'), before[2])
        self.assertEqual(self.git(self.proj, 'stash', 'list'), before[3])
        self.assertIn('a.txt', self.git(self.proj, 'status', '--porcelain'))
        log = self.h('pc-a', 'log', 't1').stdout
        self.assertIn('## #2 claude@pc-a → codex@pc-b', log)
        self.assertIn('claude@pc-a session: cl-1', log)
        self.assertIn('-two\n+three', self.h('pc-a', 'diff', 't1', '3', '5').stdout)

    def test_take_never_overwrites_unsynced_work(self):
        self.start()
        self.h('pc-a', 'pass', 't1', 'codex@pc-b')
        self.h('pc-b', 'take', 't1')
        (self.base / 'pc-b-tasks' / 't1' / 'a.txt').write_text('from b\n')
        self.h('pc-b', 'pass', 't1', 'claude@pc-a')
        (self.proj / 'a.txt').write_text('edited on a meanwhile\n')
        p = self.h('pc-a', 'take', 't1', ok=False)
        self.assertIn('has changes this machine did not sync', p.stderr)
        self.assertEqual((self.proj / 'a.txt').read_text(), 'edited on a meanwhile\n')
        self.assertEqual(self.hub_state()['status'], 'open')
        other = self.base / 'elsewhere'
        self.h('pc-a', 'take', 't1', '--dir', other)
        self.assertEqual((other / 'a.txt').read_text(), 'from b\n')
        # A non-empty unrelated directory is refused too.
        self.h('pc-a', 'pass', 't1', 'codex@pc-b')
        busy = self.base / 'busy'
        busy.mkdir()
        (busy / 'x').write_text('x')
        self.assertIn('not empty', self.h('pc-b', 'take', 't1', '--dir', busy, ok=False).stderr)

    def test_hub_is_the_authority(self):
        self.start()
        self.h('pc-a', 'pass', 't1', 'codex@pc-b')
        # pc-a no longer owns t1; forge its pass anyway from a copy of its state by pretending to be pc-a...
        self.h('pc-b', 'take', 't1')
        # ...and as pc-b impersonating nobody: a third machine cannot take or pass someone else's task.
        self.assertIn('held by codex@pc-b', self.h('vps', 'take', 't1', ok=False).stderr)
        # The hook rejects a push from the wrong machine even if the client is fooled.
        p = self.h('pc-b', 'pass', 't1', 'claude@pc-a', ok=False, HANDOFF_PUSHER='pc-a')
        self.assertIn('pc-a cannot move t1', p.stderr)
        self.assertIn('Nothing in the working directory was lost', p.stderr)
        gd = str(self.base / 'home-pc-b' / 'repo.git')
        p = subprocess.run(['git', '--git-dir', gd, 'push', 'hub', ':refs/tasks/t1'], env={**self.env, 'HANDOFF_PUSHER': 'pc-b'},
                           capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        p = subprocess.run(['git', '--git-dir', gd, 'push', 'hub', 'HEAD:refs/heads/x'], env={**self.env, 'HANDOFF_PUSHER': 'pc-b'},
                           capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.hub_state()['owner'], 'codex@pc-b')

    def test_lost_push_result_is_not_a_second_handoff(self):
        self.start()
        self.h('pc-a', 'pass', 't1', 'codex@pc-b', HANDOFF_TEST_LOSE_PUSH_RESULT='1')
        self.assertEqual(self.hub_state()['epoch'], 2)
        self.assertIn('held by codex@pc-b', self.h('pc-a', 'pass', 't1', 'codex@pc-b', ok=False).stderr)

    def test_secrets_and_size(self):
        self.start()
        (self.proj / 'notes.txt').write_text('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n')
        p = self.h('pc-a', 'pass', 't1', 'codex@pc-b', ok=False)
        self.assertIn('possible secrets in: notes.txt', p.stderr)
        self.assertEqual(self.hub_state()['owner'], 'claude@pc-a')
        (self.proj / '.handoffignore').write_text('notes.txt\n')
        cfg = self.base / 'home-pc-a' / 'config.json'
        c = json.loads(cfg.read_text())
        c['max_file_mb'] = 0
        cfg.write_text(json.dumps(c))
        self.assertIn('files over max_file_mb', self.h('pc-a', 'pass', 't1', 'codex@pc-b', ok=False).stderr)
        c['max_file_mb'] = 20
        cfg.write_text(json.dumps(c))
        self.h('pc-a', 'pass', 't1', 'codex@pc-b')

    def test_run_codex_resumes_its_session(self):
        self.start()
        self.h('pc-a', 'pass', 't1', 'codex@pc-a')
        self.h('pc-a', 'take', 't1', '--as', 'codex')
        self.h('pc-a', 'run', 't1', STUB_NOTE='did it')
        args = self.stub_log.read_text().splitlines()
        self.assertTrue(args[0].startswith('exec --json -C'), args[0])
        st = self.hub_state()
        self.assertEqual((st['owner'], st['status']), ('claude@pc-a', 'open'))
        self.assertEqual(st['sessions']['codex@pc-a'], 'th-123')
        out = self.h('pc-a', 'take', 't1', '--as', 'claude').stdout
        self.assertIn('did it', out)
        self.assertIn('work.txt', out)
        self.h('pc-a', 'pass', 't1', 'codex@pc-a')
        self.h('pc-a', 'take', 't1', '--as', 'codex')
        p = self.h('pc-a', 'run', 't1', ok=False, STUB_RC='3')  # no note, failing exit: still handed back
        self.assertEqual(p.returncode, 3)
        args = self.stub_log.read_text().splitlines()
        self.assertTrue(args[1].startswith('exec resume th-123'), args[1])
        log = self.h('pc-a', 'log', 't1').stdout
        self.assertIn('exited with code 3', log)
        self.assertIn('final answer', log)
        self.assertEqual(self.hub_state()['owner'], 'claude@pc-a')

    def test_plain_folder_and_admin(self):
        plain = self.base / 'notes'
        plain.mkdir()
        (plain / 'draft.md').write_text('hi\n')
        self.h('pc-a', 'start', 'n1', '--as', 'claude', '--dir', plain)
        self.h('pc-a', 'pass', 'n1', 'agy@pc-b')
        self.assertIn('cannot move n1', self.h('pc-b', 'reassign', 'n1', 'codex@pc-b', ok=False).stderr)
        self.h('vps', 'reassign', 'n1', 'codex@pc-b')
        self.h('pc-b', 'take', 'n1')
        self.assertEqual((self.base / 'pc-b-tasks' / 'n1' / 'draft.md').read_text(), 'hi\n')
        self.h('pc-b', 'done', 'n1')
        self.assertEqual(self.hub_state('n1')['status'], 'done')
        self.assertIn('is done', self.h('vps', 'cancel', 'n1', ok=False).stderr)
        self.assertNotIn('n1', self.h('pc-a', 'list').stdout)
        self.assertIn('n1', self.h('pc-a', 'list', '--all').stdout)


if __name__ == '__main__':
    unittest.main()
