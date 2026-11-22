"""fleet-tidy cleanup rules against an isolated fake /tmp tree."""
import importlib.machinery
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('fleet_tidy', str(ROOT / 'deploy/vps/bin/fleet-tidy'))
tidy = importlib.util.module_from_spec(importlib.util.spec_from_loader('fleet_tidy', loader))
loader.exec_module(tidy)
DAY = 86400


class FleetTidy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tmp, self.backups = self.root / 'tmp', self.root / 'backups'
        self.tmp.mkdir(); self.backups.mkdir()
        self.log = self.root / 'gateway.log'
        self.uid, self.now = self.tmp.stat().st_uid, 2_000_000_000

    def old_file(self, path, age, size=1):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('wb') as f: f.truncate(size)
        os.utime(path, (self.now - age, self.now - age))
        return path

    def old_tree(self, path, age):
        path.mkdir(parents=True)
        self.old_file(path / 'output', age)
        os.utime(path, (self.now - age, self.now - age))
        return path

    def clean(self, **kwargs):
        return tidy.run(self.tmp, self.backups, self.log, self.uid, self.now, **kwargs)

    def test_known_tmp_prefixes_and_two_day_age(self):
        expected = {self.old_file(self.tmp / (p + 'old'), 3 * DAY) for p in tidy.PREFIXES}
        expected.add(self.old_file(self.tmp / 'claude-skill-old.zip', 3 * DAY))
        expected.add(self.old_tree(self.tmp / 'desk-gw-old-dir', 3 * DAY))
        self.old_tree(self.tmp / 'claude-skill-folder.zip', 3 * DAY)
        self.old_file(self.tmp / 'unknown-old', 3 * DAY)
        self.old_file(self.tmp / 'fleet-fs-recent', DAY)
        result = self.clean(dry_run=True)
        self.assertEqual(set(result['actions']), expected)

    def test_active_names_and_sockets_are_never_removed(self):
        self.old_tree(self.tmp / 'fleet-fs-tmux', 3 * DAY)
        (self.tmp / 'fleet-fs-tmux' / 'tmux-live').mkdir()
        os.utime(self.tmp / 'fleet-fs-tmux' / 'tmux-live', (self.now - 3 * DAY,) * 2)
        os.utime(self.tmp / 'fleet-fs-tmux', (self.now - 3 * DAY,) * 2)
        systemd_dir = self.old_tree(self.tmp / 'fleet-fs-systemd', 3 * DAY)
        (systemd_dir / 'systemd-private').mkdir()
        os.utime(systemd_dir / 'systemd-private', (self.now - 3 * DAY,) * 2)
        os.utime(systemd_dir, (self.now - 3 * DAY,) * 2)
        socket_dir = self.tmp / 'desk-gw-socket'; socket_dir.mkdir()
        socket_path = self.old_file(socket_dir / 'active.sock', 3 * DAY)
        os.utime(socket_dir, (self.now - 3 * DAY,) * 2)
        real_lstat = Path.lstat
        def socket_lstat(path):
            s = real_lstat(path)
            return SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=s.st_uid, st_mtime=s.st_mtime, st_size=s.st_size) if path == socket_path else s
        with patch.object(Path, 'lstat', socket_lstat): result = self.clean(dry_run=True)
        self.assertNotIn(self.tmp / 'fleet-fs-tmux', result['actions'])
        self.assertNotIn(systemd_dir, result['actions'])
        self.assertNotIn(socket_dir, result['actions'])

    def test_claude_task_outputs_only_after_seven_idle_days(self):
        root = self.tmp / f'claude-{self.uid}' / 'project'
        old = self.old_tree(root / 'old-session', 8 * DAY)
        recent = self.old_tree(root / 'recent-session', DAY)
        result = self.clean(dry_run=True)
        self.assertIn(old, result['actions'])
        self.assertNotIn(recent, result['actions'])

    def test_copy_backups_expire_and_trim_to_size_limit(self):
        expired = self.old_file(self.backups / 'expired', 4 * DAY, 8)
        oldest = self.old_file(self.backups / 'oldest', 2 * DAY, 8)
        newest = self.old_file(self.backups / 'newest', int(1.5 * DAY), 8)
        with patch.object(tidy, 'BACKUP_LIMIT', 10): result = self.clean(dry_run=True)
        self.assertIn(expired, result['actions'])
        self.assertIn(oldest, result['actions'])
        self.assertNotIn(newest, result['actions'])

    def test_dry_run_lists_without_deleting_or_rotating(self):
        candidate = self.old_file(self.tmp / 'desk-gw-old', 3 * DAY)
        content = b'x' * (5 * 1024 * 1024 + 1)
        self.log.write_bytes(content)
        result = self.clean(dry_run=True)
        self.assertIn(candidate, result['actions'])
        self.assertTrue(result['rotate'])
        self.assertEqual(result['removed'], 0)
        self.assertEqual(candidate.read_bytes(), b'\0')
        self.assertEqual(self.log.read_bytes(), content)

    def test_large_gateway_log_rotates_to_one_backup(self):
        content = b'x' * (5 * 1024 * 1024 + 1)
        self.log.write_bytes(content)
        result = self.clean()
        self.assertEqual(result['rotated'], 1)
        self.assertEqual((self.root / 'gateway.log.1').read_bytes(), content)
        self.assertEqual(self.log.read_bytes(), b'')

    def test_recent_log_backup_is_preserved(self):
        self.log.write_bytes(b'x' * (5 * 1024 * 1024 + 1))
        old = self.root / 'gateway.log.1'; old.write_bytes(b'keep')
        os.utime(old, (self.now - DAY // 2,) * 2)
        result = self.clean()
        self.assertEqual(result['rotated'], 0)
        self.assertEqual(old.read_bytes(), b'keep')
        self.assertGreater(self.log.stat().st_size, 5 * 1024 * 1024)


if __name__ == '__main__': unittest.main()
