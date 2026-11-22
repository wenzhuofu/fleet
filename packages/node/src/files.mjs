// File access: bounded reads, atomic writes with an ETag re-check, and
// per-file write serialization (reads are never serialized).
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DeskError } from './errors.mjs';
import { decode, etag } from './text.mjs';

const MAX_BYTES = 64 * 1024 * 1024;

export async function readText(abs) {
  const before = await stat(abs);
  if (before.isDirectory()) throw new DeskError('IS_DIRECTORY', `Path is a directory: ${abs}`, 'Use Glob, or Bash with ls');
  if (before.size > MAX_BYTES) throw new DeskError('TOO_LARGE', 'File exceeds the 64 MiB read limit', 'Use Bash (head/tail/grep) to inspect it');
  const bytes = await readFile(abs);
  const after = await stat(abs);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new DeskError('STALE_ETAG', 'File changed during read; retry');
  return { bytes, format: decode(bytes), etag: etag(bytes) };
}

/** Current ETag, or null when the file does not exist. */
export async function currentTag(abs) {
  try { return etag(await readFile(abs)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Write via temp file + rename; fails with STALE_ETAG if the file changed from `expected`. */
export async function writeAtomic(abs, bytes, expected) {
  const dir = path.dirname(abs);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(abs)}.desk-${randomUUID().slice(0, 8)}.tmp`);
  try {
    const fh = await open(temp, 'wx', 0o600);
    try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
    if (await currentTag(abs) !== expected) throw new DeskError('STALE_ETAG', 'File changed before the write could be applied', 'Call Read on this file again, then retry');
    await rename(temp, abs);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Serialize async work per key (lower-cased absolute path). */
export class KeyedLock {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
