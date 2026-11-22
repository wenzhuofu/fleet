import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectGitArgs } from '../../src/readonly.mjs';

test('Git RPC accepts the read-only invocations fleet-ui makes', () => {
  for (const args of [
    ['status', '--porcelain'], ['status', '--porcelain=v1', '-z'], ['diff', 'HEAD', '--', 'a.txt'], ['show', 'HEAD:a.txt'],
    ['log', '--pretty=format:%H', '-n', '10'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['symbolic-ref', '--short', 'HEAD'], ['branch', '-a'], ['branch', '--list', 'feat*'], ['remote'], ['remote', '-v'],
    ['remote', 'get-url', 'origin'], ['ls-files', '--others', '--exclude-standard', '-z'], ['merge-base', '--', 'main', 'HEAD'],
    ['config', '--get', 'remote.origin.url'], ['stash', 'list'], ['worktree', 'list', '--porcelain'],
    ['diff', '--', '--output=x'], // after -- it is a path
  ]) assert.equal(rejectGitArgs(args), null, args.join(' '));
});

test('Git RPC rejects anything that writes or runs programs', () => {
  for (const args of [
    [], ['commit', '-m', 'x'], ['add', '.'], ['checkout', 'main'], ['reset', '--hard'], ['push'], ['fetch'], ['pull'],
    ['branch', 'new'], ['branch', '-D', 'x'], ['branch', '--set-upstream-to=origin/main'], ['symbolic-ref', 'HEAD', 'refs/heads/x'],
    ['remote', 'add', 'o', 'u'], ['remote', 'show', 'origin'], ['config', 'user.name', 'x'], ['stash'], ['stash', 'pop'],
    ['worktree', 'add', 'x'], ['diff', '--output=x'], ['log', '--output', 'x'], ['diff', '--ext-diff'], ['-c', 'x=y', 'status'],
    ['update-ref', '-d', 'x'], ['status', 'a\0b'],
  ]) assert.notEqual(rejectGitArgs(args), null, args.join(' '));
});
