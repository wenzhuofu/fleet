// Git checkpoints (ported from v1 desk/tools/e-preview.mjs checkpoint / checkpointPlan /
// restoreCheckpoint). A checkpoint is a commit of the whole working tree (tracked + untracked,
// minus ignored files) built in a temporary index, so the user's index, HEAD and branches are
// never touched. Refs: refs/desk/cp/<sid>/<n>; the 20 newest per session are kept.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeskError } from './errors.mjs';

const KEEP = 20;
const IDENTITY = { GIT_AUTHOR_NAME: 'Desk Checkpoint', GIT_AUTHOR_EMAIL: 'desk-checkpoint@invalid', GIT_COMMITTER_NAME: 'Desk Checkpoint', GIT_COMMITTER_EMAIL: 'desk-checkpoint@invalid' };

export class Checkpoints {
  constructor({ git, dataDir, backupDir }) {
    this.git = git;
    this.noHooks = path.join(dataDir, 'no-hooks');
    this.backupDir = backupDir;
  }

  run(cwd, args, { env = {}, raw = false, allowFail = false, input } = {}) {
    const argv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', `core.hooksPath=${this.noHooks}`, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(this.git, argv, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (input !== undefined) child.stdin.end(input);
      const out = [], err = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
      child.on('error', (e) => reject(new DeskError('INTERNAL', `Cannot run git: ${e.message}`)));
      child.on('close', (code) => {
        const stdout = Buffer.concat(out);
        if (code !== 0 && !allowFail) return reject(new DeskError('GIT_FAILED', `git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim()}`));
        resolve(code !== 0 ? null : raw ? stdout : stdout.toString('utf8').trim());
      });
    });
  }

  async repo(dir) {
    await mkdir(this.noHooks, { recursive: true });
    const top = await this.run(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top === null) throw new DeskError('NOT_A_GIT_REPO', `Not inside a Git repository: ${dir}`, 'Checkpoints need a Git working tree; pass path inside one, or commit/copy files another way');
    const root = path.resolve(top);
    const gitDir = path.resolve(root, await this.run(root, ['rev-parse', '--git-dir']));
    const index = path.resolve(root, await this.run(root, ['rev-parse', '--git-path', 'index']));
    return { root, gitDir, index };
  }

  static owner(sid) {
    const s = String(sid).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '').slice(0, 64);
    return s || 'default';
  }

  async refs(root, owner) {
    const out = await this.run(root, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)', `refs/desk/cp/${owner}/`]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [ref, commit, date, subject] = line.split('\t');
      return { ref, n: Number(ref.split('/').pop()), commit, date, subject };
    }).sort((a, b) => a.n - b.n);
  }

  /** Snapshot the working tree. Returns {ref, ...} or {skipped} when nothing changed since the last one. */
  async create(dir, sid, note = '') {
    const { root, gitDir, index } = await this.repo(dir);
    const owner = Checkpoints.owner(sid);
    const tmp = path.join(gitDir, `desk-index-${randomUUID()}`);
    const head = await this.run(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
    try {
      // Start from a copy of the user's index (fast: unchanged files keep their stat data).
      try { await copyFile(index, tmp); } catch { if (head) await this.run(root, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: tmp } }); }
      const env = { GIT_INDEX_FILE: tmp };
      await this.run(root, ['add', '-A'], { env });
      const tree = await this.run(root, ['write-tree'], { env });
      const existing = await this.refs(root, owner);
      const last = existing.at(-1);
      if (last && (await this.run(root, ['rev-parse', `${last.ref}^{tree}`])) === tree) {
        return { skipped: true, ref: last.ref, root, text: `Working tree unchanged since ${last.ref}` };
      }
      const message = `desk checkpoint${note ? `: ${note}` : ''}`;
      const commit = await this.run(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { env: { ...env, ...IDENTITY } });
      const n = (last?.n ?? 0) + 1;
      const ref = `refs/desk/cp/${owner}/${n}`;
      await this.run(root, ['update-ref', ref, commit]);
      for (const old of existing.slice(0, Math.max(0, existing.length + 1 - KEEP))) await this.run(root, ['update-ref', '-d', old.ref]);
      return { ref, commit, root };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async list(dir, sid) {
    const { root } = await this.repo(dir);
    return { root, checkpoints: await this.refs(root, Checkpoints.owner(sid)) };
  }

  async resolveRef(root, owner, ref) {
    const all = await this.refs(root, owner);
    const want = ref === undefined || ref === null || ref === '' ? all.at(-1) : all.find((c) => c.ref === ref || String(c.n) === String(ref));
    if (!want) throw new DeskError('NOT_FOUND', all.length ? `No checkpoint ${ref} for this session` : 'This session has no checkpoints in this repository', 'Use action "checkpoints" to list them');
    return want;
  }

  /** What restoring would change: files rewritten from the checkpoint and files deleted. */
  async plan(dir, sid, ref) {
    const { root } = await this.repo(dir);
    const cp = await this.resolveRef(root, Checkpoints.owner(sid), ref);
    const expected = new Map(), skipped = [];
    for (const line of (await this.run(root, ['ls-tree', '-r', '-z', cp.commit], { raw: true })).toString('utf8').split('\0').filter(Boolean)) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
      if (!m) continue;
      if (m[2] !== 'blob' || m[1] === '120000') { skipped.push(m[4]); continue; } // submodules and symlinks are left alone
      expected.set(m[4], m[3]);
    }
    const present = (await this.run(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { raw: true })).toString('utf8').split('\0').filter(Boolean);
    const toDelete = [...new Set(present)].filter((p) => !expected.has(p) && !skipped.includes(p));
    // Compare through Git's clean filters (autocrlf etc.), so an unchanged CRLF file matches its LF blob.
    const exists = [], toWrite = [];
    for (const rel of expected.keys()) {
      if (await access(path.join(root, rel)).then(() => true, () => false)) exists.push(rel); else toWrite.push(rel);
    }
    const hashes = exists.length ? (await this.run(root, ['hash-object', '--stdin-paths'], { input: exists.join('\n') + '\n' })).split('\n') : [];
    exists.forEach((rel, i) => { if (hashes[i] !== expected.get(rel)) toWrite.push(rel); });
    return { root, checkpoint: cp, expected, toWrite, toDelete, skipped };
  }

  /** Restore the working tree to a checkpoint. Touched files are backed up first; on failure all are put back. */
  async restore(dir, sid, ref) {
    const p = await this.plan(dir, sid, ref);
    const abs = (rel) => {
      const full = path.resolve(p.root, rel);
      if (!full.toLowerCase().startsWith(p.root.toLowerCase() + path.sep)) throw new DeskError('BAD_PATH', `Path escapes the repository: ${rel}`);
      return full;
    };
    const payload = new Map();
    // --filters applies smudge/eol conversion, so files come back exactly as they were on disk.
    for (const rel of p.toWrite) payload.set(rel, await this.run(p.root, ['cat-file', '--filters', `${p.checkpoint.commit}:${rel}`], { raw: true }));
    const backup = path.join(this.backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    const originals = new Map();
    for (const rel of [...p.toWrite, ...p.toDelete]) {
      const file = abs(rel);
      try {
        const bytes = await readFile(file);
        originals.set(rel, bytes);
        await mkdir(path.dirname(path.join(backup, rel)), { recursive: true });
        await writeFile(path.join(backup, rel), bytes);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        originals.set(rel, null);
      }
    }
    const put = async (rel, bytes) => {
      const file = abs(rel);
      if (bytes === null) return rm(file, { force: true });
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.desk-restore-${randomUUID().slice(0, 8)}`;
      try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, file); } finally { await rm(temp, { force: true }); }
    };
    try {
      for (const rel of p.toWrite) await put(rel, payload.get(rel));
      for (const rel of p.toDelete) await put(rel, null);
    } catch (error) {
      for (const [rel, bytes] of originals) await put(rel, bytes).catch(() => {});
      throw new DeskError('RESTORE_FAILED', `Restore failed and was undone: ${error.message}`, `Backups of the touched files: ${backup}`);
    }
    return { ...p, backup: originals.size ? backup : null };
  }
}
