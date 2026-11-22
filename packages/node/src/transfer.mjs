import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DeskError } from './errors.mjs';

const MAX_BYTES = 300 * 1024 * 1024, BACKUP_AGE = 7 * 86400000, BACKUP_BYTES = 1024 ** 3;
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createTransfer({ locks, autoCheckpoint, pathsFor, outputsDir, maxBytes = MAX_BYTES, renameFile = rename }) {
  const backupDir = path.join(outputsDir, 'copy-backups');
  async function upload(req, { path: input, defaultDir, sid = 'default', backup = true }) {
    const paths = pathsFor(defaultDir), abs = await paths.check(input);
    const length = Number(req.headers['content-length']), sha = req.headers['x-sha256'];
    if (!Number.isSafeInteger(length) || length < 0) throw new DeskError('BAD_REQUEST', 'content-length header required');
    if (length > maxBytes) throw new DeskError('TOO_LARGE', 'Upload exceeds 300 MiB');
    if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new DeskError('BAD_REQUEST', 'x-sha256 must be 64 lowercase hex characters');
    const before = await stat(abs).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (before?.isDirectory()) throw new DeskError('IS_DIRECTORY', `Path is a directory: ${paths.display(abs)}`);
    const note = await autoCheckpoint(sid, path.dirname(abs), paths);
    return locks.run(abs.toLowerCase(), async () => {
      await mkdir(path.dirname(abs), { recursive: true });
      const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.desk-${randomUUID().slice(0, 8)}.tmp`);
      const hash = createHash('sha256'); let size = 0;
      try {
        await pipeline(req, async function* (source) {
          for await (const chunk of source) { size += chunk.length; if (size > maxBytes) throw new DeskError('TOO_LARGE', 'Upload exceeds 300 MiB'); hash.update(chunk); yield chunk; }
        }, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        if (size !== length) throw new DeskError('BAD_REQUEST', 'Request body does not match content-length');
        const got = hash.digest('hex');
        if (got !== sha) throw new DeskError('SHA_MISMATCH', 'Uploaded file SHA-256 does not match x-sha256');
        const current = await stat(abs).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
        if (current?.isDirectory()) throw new DeskError('IS_DIRECTORY', `Path is a directory: ${paths.display(abs)}`);
        if (current && await hashFile(abs) === got) return { path: paths.display(abs), size, sha256: got, identical: true, ...(note ? { note } : {}) };
        let previous;
        if (current && backup) {
          await mkdir(backupDir, { recursive: true });
          previous = path.join(backupDir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}-${path.basename(abs)}`);
          await copyFile(abs, previous, constants.COPYFILE_EXCL);
        }
        try { await renameFile(temp, abs); }
        catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') throw new DeskError('FILE_LOCKED', `File is locked: ${paths.display(abs)}`); throw e; }
        return { path: paths.display(abs), size, sha256: got, identical: false, ...(previous ? { backup: paths.display(previous) } : {}), ...(note ? { note } : {}) };
      } finally { await unlink(temp).catch(() => {}); }
    });
  }
  async function download({ path: input, defaultDir }) {
    const paths = pathsFor(defaultDir), abs = await paths.check(input), info = await stat(abs);
    if (info.isDirectory()) throw new DeskError('IS_DIRECTORY', `Path is a directory: ${paths.display(abs)}`);
    if (!info.isFile()) throw new DeskError('BAD_PATH', 'Path is not a regular file');
    if (info.size > maxBytes) throw new DeskError('TOO_LARGE', 'File exceeds 300 MiB');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(abs)) { size += chunk.length; if (size > maxBytes) throw new DeskError('TOO_LARGE', 'File exceeds 300 MiB'); hash.update(chunk); }
    const file = await open(abs, 'r');
    return { size, sha256: hash.digest('hex'), stream: file.createReadStream() };
  }
  async function prune() {
    const files = [];
    for (const entry of await readdir(backupDir, { withFileTypes: true }).catch(() => [])) if (entry.isFile()) {
      const file = path.join(backupDir, entry.name), info = await stat(file).catch(() => null);
      if (info?.isFile()) files.push({ file, size: info.size, mtime: info.mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0), removed = 0, freed = 0;
    for (const f of files) if (f.mtime < Date.now() - BACKUP_AGE || total > BACKUP_BYTES) {
      try { await unlink(f.file); removed++; freed += f.size; total -= f.size; } catch { /* in use or gone */ }
    }
    return { removed, freed, total };
  }
  return { upload, download, prune };
}
