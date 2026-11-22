import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KeyedLock } from '../../src/files.mjs';
import { DeskError } from '../../src/errors.mjs';
import { createTransfer } from '../../src/transfer.mjs';

function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desk-transfer-'));
  const blocked = path.join(root, 'blocked'), denied = path.join(root, 'denied'), outputsDir = path.join(root, 'outputs');
  const paths = {
    async check(input) {
      const abs = path.resolve(root, input);
      if (abs === blocked || abs.startsWith(`${blocked}${path.sep}`)) throw new DeskError('PATH_BLOCKED', 'blocked');
      if (abs === denied || abs.startsWith(`${denied}${path.sep}`)) throw new DeskError('PATH_DENIED', 'denied');
      return abs;
    },
    display: (abs) => path.relative(root, abs).split(path.sep).join('/') || '.',
  };
  const checkpoints = [];
  const transfer = createTransfer({ locks: new KeyedLock(), autoCheckpoint: async (...args) => { checkpoints.push(args); return ''; }, pathsFor: () => paths, outputsDir, ...options });
  return { root, blocked, denied, outputsDir, checkpoints, transfer };
}
const request = (bytes, sha = createHash('sha256').update(bytes).digest('hex')) => {
  const stream = Readable.from([bytes]);
  stream.headers = { 'content-length': String(bytes.length), 'x-sha256': sha };
  return stream;
};
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('upload creates files, backs up replaced bytes, and skips identical content', async () => {
  const f = fixture(), target = path.join(f.root, 'workspace', '中文目录', '文件.bin');
  try {
    const old = Buffer.from([0, 1, 2, 255]), next = Buffer.from([255, 0, 9, 8, 7]);
    assert.equal((await f.transfer.upload(request(old), { path: target, sid: 'transfer' })).identical, false);
    const replaced = await f.transfer.upload(request(next), { path: target, sid: 'transfer' });
    assert.equal(replaced.identical, false);
    assert.deepEqual(readFileSync(path.join(f.root, replaced.backup)), old);
    assert.deepEqual(readFileSync(target), next);
    const same = await f.transfer.upload(request(next), { path: target, sid: 'transfer' });
    assert.equal(same.identical, true);
    assert.equal(same.backup, undefined);
    assert.equal(f.checkpoints[0][0], 'transfer');
    assert.equal(f.checkpoints[0][1], path.dirname(target));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('upload rejects a SHA mismatch and removes its temporary file', async () => {
  const f = fixture(), target = path.join(f.root, 'workspace', 'bad.bin'), bytes = Buffer.from('wrong hash');
  try {
    await assert.rejects(f.transfer.upload(request(bytes, '0'.repeat(64)), { path: target }), (e) => e.code === 'SHA_MISMATCH');
    assert.deepEqual(readdirSync(path.dirname(target)), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('upload and download enforce blocked and denied paths and reject directories', async () => {
  const f = fixture(), dir = path.join(f.root, 'workspace', 'folder');
  try {
    await assert.rejects(f.transfer.upload(request(Buffer.from('x')), { path: f.blocked }), (e) => e.code === 'PATH_BLOCKED');
    await assert.rejects(f.transfer.upload(request(Buffer.from('x')), { path: f.denied }), (e) => e.code === 'PATH_DENIED');
    await assert.rejects(f.transfer.download({ path: f.blocked }), (e) => e.code === 'PATH_BLOCKED');
    mkdirSync(dir, { recursive: true });
    await assert.rejects(f.transfer.upload(request(Buffer.from('x')), { path: dir }), (e) => e.code === 'IS_DIRECTORY');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('upload enforces an injectable byte limit', async () => {
  const f = fixture({ maxBytes: 3 });
  try {
    await assert.rejects(f.transfer.upload(request(Buffer.from('four')), { path: path.join(f.root, 'large.bin') }), (e) => e.code === 'TOO_LARGE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('download returns a streaming body with its SHA-256 and blocks denied paths', async () => {
  const f = fixture(), target = path.join(f.root, 'workspace', '中文.bin'), bytes = Buffer.from([0, 255, 1, 2, 3]);
  try {
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes);
    const file = await f.transfer.download({ path: target });
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await collect(file.stream), bytes);
    await assert.rejects(f.transfer.download({ path: f.denied }), (e) => e.code === 'PATH_DENIED');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rename failures caused by Windows file locks return FILE_LOCKED', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture({ renameFile: async () => { const e = new Error('locked'); e.code = 'EPERM'; throw e; } });
  const target = path.join(f.root, 'locked.bin'), old = Buffer.from('old');
  try {
    writeFileSync(target, old);
    await assert.rejects(f.transfer.upload(request(Buffer.from('new')), { path: target, backup: false }), (e) => e.code === 'FILE_LOCKED');
    assert.deepEqual(readFileSync(target), old);
    assert.deepEqual(readdirSync(f.root).filter((name) => name.includes('.desk-')), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('backup pruning removes expired files and retains recent backups', async () => {
  const f = fixture(), dir = path.join(f.outputsDir, 'copy-backups'), old = path.join(dir, 'old.bin'), recent = path.join(dir, 'recent.bin');
  try {
    mkdirSync(dir, { recursive: true }); writeFileSync(old, 'old'); writeFileSync(recent, 'recent');
    const then = Date.now() / 1000 - 8 * 86400; utimesSync(old, then, then);
    const result = await f.transfer.prune();
    assert.equal(result.removed, 1);
    assert.equal(result.freed, 3);
    assert.equal(readdirSync(dir).includes('old.bin'), false);
    assert.equal(readdirSync(dir).includes('recent.bin'), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
