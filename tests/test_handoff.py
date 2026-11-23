"""handoff/handoff.sh in a throwaway Git repository, with a stub codex on PATH."""
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'handoff' / 'handoff.sh'

# Records its arguments, edits a file, writes a note and prints a thread id like codex exec --json.
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
        base = Path(self.tmp.name)
        self.repo, bindir = base / 'repo', base / 'bin'
        self.repo.mkdir(); bindir.mkdir()
        (bindir / 'codex').write_text(STUB); (bindir / 'codex').chmod(0o755)
        self.stub_log = base / 'codex-args'
        self.env = {**os.environ, 'PATH': f'{bindir}:{os.environ["PATH"]}', 'STUB_LOG': str(self.stub_log),
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        self.git('init', '-q')
        (self.repo / 'a.txt').write_text('one\n')
        self.git('add', '.')
        self.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, env=self.env, check=True, capture_output=True, text=True).stdout

    def h(self, *args, ok=True, **env):
        p = subprocess.run(['bash', str(SCRIPT), *args], cwd=self.repo, env={**self.env, **env}, capture_output=True, text=True)
        if ok: self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def log(self):
        return (self.repo / '.handoff' / 'log.md').read_text()

    def test_round_trip(self):
        self.h('init', 'claude')
        self.assertIn('/.handoff/', (self.repo / '.git' / 'info' / 'exclude').read_text())
        self.assertEqual(self.git('status', '--porcelain'), '')  # the ledger stays out of Git

        (self.repo / 'a.txt').write_text('two\n')
        (self.repo / 'new.txt').write_text('untracked\n')
        (self.repo / '.handoff' / 'outbox.md').write_text('### Next\nadd tests\n')
        self.h('session', 'claude', 'cl-1')
        out = self.h('pass', 'claude', 'codex').stdout
        self.assertIn('#1 claude → codex', out)
        self.assertIn('2 files changed', out)  # tracked edit and untracked file both snapshotted
        self.assertIn('git diff refs/handoff/0 refs/handoff/1', self.log())
        self.assertIn('claude session: cl-1', self.log())
        self.assertIn('add tests', self.log())
        self.assertEqual((self.repo / '.handoff' / 'outbox.md').read_text(), '')
        self.assertEqual(self.git('stash', 'list'), '')
        self.assertIn('a.txt', self.git('status', '--porcelain'))  # user's index untouched

        self.h('run', 'codex', 'claude', STUB_NOTE='did it')
        args = self.stub_log.read_text().splitlines()
        self.assertTrue(args[0].startswith('exec --json -C'), args[0])
        self.assertIn('after #0', args[0])
        self.assertIn('session_codex=th-123', (self.repo / '.handoff' / 'state').read_text())
        self.assertIn('#2 codex → claude', self.log())
        self.assertIn('did it', self.log())
        self.assertIn('Transcript: .handoff/runs/1-codex.jsonl', self.log())

        take = self.h('take', 'claude').stdout
        self.assertIn('claude last passed at #1', take)
        self.assertIn('git diff refs/handoff/1 refs/handoff/2', take)
        self.assertIn('work.txt', take)
        self.assertIn('## #2 codex → claude', take)
        self.assertNotIn('## #1', take)

        self.h('pass', 'claude', 'codex')
        self.h('run', 'codex', 'claude')  # no note: falls back to codex's last message
        args = self.stub_log.read_text().splitlines()
        self.assertTrue(args[1].startswith('exec resume th-123'), args[1])
        self.assertIn('after #2', args[1])
        self.assertIn('(codex wrote no note). Its last message:', self.log())
        self.assertIn('final answer', self.log())

    def test_guards(self):
        self.assertIn('no task here', self.h('pass', 'a', 'b', ok=False).stderr)
        self.h('init', 'claude')
        self.assertIn('already set up', self.h('init', 'claude', ok=False).stderr)
        self.assertIn('claude holds the task', self.h('pass', 'codex', 'claude', ok=False).stderr)
        self.assertIn('pass it to codex first', self.h('run', 'codex', 'claude', ok=False).stderr)
        self.assertIn('lowercase', self.h('pass', 'claude', 'Bad Name', ok=False).stderr)
        self.h('pass', 'codex', 'claude', HANDOFF_FORCE='1')

    def test_failed_run_still_hands_back(self):
        self.h('init', 'claude')
        self.h('pass', 'claude', 'codex')
        p = self.h('run', 'codex', 'claude', ok=False, STUB_RC='3')
        self.assertEqual(p.returncode, 3)
        self.assertIn('exited with code 3', self.log())
        self.assertIn('owner=claude', (self.repo / '.handoff' / 'state').read_text())


if __name__ == '__main__':
    unittest.main()
