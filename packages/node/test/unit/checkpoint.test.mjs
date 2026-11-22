// Checkpoints against a real temporary Git repository (runs wherever git is on PATH).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Checkpoints } from '../../src/checkpoint.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'desk-cp-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function repo() {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(path.join(dir, 'a.txt'), 'a1\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('create + restore: working tree back, user index/HEAD/ignored files untouched', async () => {
  const dir = repo();
  const cp = new Checkpoints({ git: 'git', dataDir: tmp(), backupDir: tmp() });
  writeFileSync(path.join(dir, 'a.txt'), 'a2 staged\n');
  git(dir, 'add', 'a.txt');                                   // user has something staged
  writeFileSync(path.join(dir, '中文 新文件.txt'), 'untracked\n'); // untracked file is captured
  const index0 = sha(path.join(dir, '.git/index')), head0 = git(dir, 'rev-parse', 'HEAD');
  const c1 = await cp.create(dir, 'sess-1', 'before edits');
  assert.equal(c1.ref, 'refs/desk/cp/sess-1/1');
  assert.equal(sha(path.join(dir, '.git/index')), index0);
  assert.equal((await cp.create(path.join(dir), 'sess-1')).skipped, true);

  writeFileSync(path.join(dir, 'a.txt'), 'a3 agent\n');
  git(dir, 'rm', '-q', '--cached', 'b.txt');                  // index changes are the user's business
  const index1 = sha(path.join(dir, '.git/index'));
  writeFileSync(path.join(dir, 'b.txt'), 'b changed\n');
  writeFileSync(path.join(dir, 'c.txt'), 'new\n');
  writeFileSync(path.join(dir, 'ignored.txt'), 'keep me\n');
  const plan = await cp.plan(dir, 'sess-1');
  assert.deepEqual(plan.toWrite.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(plan.toDelete, ['c.txt']);
  const r = await cp.restore(dir, 'sess-1', '1');
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a2 staged\n');
  assert.equal(readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b1\n');
  assert.equal(readFileSync(path.join(dir, '中文 新文件.txt'), 'utf8'), 'untracked\n');
  assert.equal(existsSync(path.join(dir, 'c.txt')), false);
  assert.equal(readFileSync(path.join(dir, 'ignored.txt'), 'utf8'), 'keep me\n');
  assert.equal(sha(path.join(dir, '.git/index')), index1);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head0);
  assert.equal(readFileSync(path.join(r.backup, 'a.txt'), 'utf8'), 'a3 agent\n');
});

test('sessions are separate; only the 20 newest are kept; non-git dir is a clear error', async () => {
  const dir = repo();
  const cp = new Checkpoints({ git: 'git', dataDir: tmp(), backupDir: tmp() });
  for (let i = 0; i < 22; i++) { writeFileSync(path.join(dir, 'a.txt'), `v${i}\n`); await cp.create(dir, 's/1'); }
  const { checkpoints } = await cp.list(dir, 's/1');
  assert.equal(checkpoints.length, 20);
  assert.equal(checkpoints[0].ref, 'refs/desk/cp/s_1/3');
  assert.equal(checkpoints.at(-1).ref, 'refs/desk/cp/s_1/22');
  assert.equal((await cp.list(dir, 'other')).checkpoints.length, 0);
  await assert.rejects(cp.restore(dir, 'other'), { code: 'NOT_FOUND' });
  await assert.rejects(cp.create(tmp(), 's'), { code: 'NOT_A_GIT_REPO' });
});
