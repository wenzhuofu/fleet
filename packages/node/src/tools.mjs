// Tool dispatch (structure ported from v1 deskd/src/workspace.ts execute()).
// Each tool returns {text, data}; errors become {code, message, next}.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DeskError, toErrorEnvelope } from './errors.mjs';
import { currentTag, KeyedLock, readText, writeAtomic } from './files.mjs';
import { archiver, boundText, cleanOutput, pruneOutputs, summarizeOutput } from './output.mjs';
import { runForeground, Jobs, SHELLS } from './exec.mjs';
import { runGlob, runGrep } from './search.mjs';
import { Checkpoints } from './checkpoint.mjs';
import { IMAGE_EXTENSIONS, readImage } from './image.mjs';
import { createReadOnlyTools } from './readonly.mjs';
import { readUpgrade, startUpgrade } from './upgrader.mjs';
import { edit, encode, etag, formatRead, ReadState } from './text.mjs';
import { createTransfer } from './transfer.mjs';

const DEFAULT_TIMEOUT = 120000, MAX_TIMEOUT = 600000, MAX_WRITE_CHARS = 10 * 1024 * 1024;
const NEW_FILE = { kind: 'utf8', bom: Buffer.alloc(0), eol: 'LF' };

export function createTools({ paths: basePaths, home, dataDir, outputsDir, bash, rg, git }) {
  const checkpoints = new Checkpoints({ git, dataDir, backupDir: `${outputsDir}/restore-backups` });
  const reads = new ReadState();
  const locks = new KeyedLock();
  const pathsByDir = new Map();
  // The gateway sends each machine's default directory (machines.json); config.json is the fallback.
  const pathsFor = (dir) => {
    if (!dir) return basePaths;
    if (!pathsByDir.has(dir)) pathsByDir.set(dir, basePaths.withDefault(dir));
    return pathsByDir.get(dir);
  };
  const jobs = new Jobs({ metaDir: `${dataDir}/jobs`, logDir: `${outputsDir}/jobs`, bash });
  const str = (v, name) => { if (typeof v !== 'string') throw new DeskError('BAD_REQUEST', `${name} must be a string`); return v; };
  // spawn() reports a missing cwd as ENOENT of the shell itself, which reads like "Git Bash is not installed".
  const workDir = async (paths, input) => {
    const cwd = await paths.check(input ?? paths.defaultDir);
    if (!(await stat(cwd).then((st) => st.isDirectory(), () => false))) {
      throw new DeskError('NOT_FOUND', `Working directory does not exist: ${paths.display(cwd)}`, 'Pass an existing cwd, or fix the default folder (desk: /desk:status, /desk:use)');
    }
    return cwd;
  };
  const shellOf = (s) => { if (s !== undefined && !SHELLS.includes(s)) throw new DeskError('BAD_REQUEST', `shell must be one of ${SHELLS.join(', ')}`); return s ?? 'bash'; };

  // Automatic checkpoint before the first change a session makes to each Git repository.
  // Covers Write/Edit (the file's repo) and Bash/BashJob (the cwd's repo). A failure does not
  // block the change; it is reported in the result instead.
  const autoDone = new Map(); // `${sid}\0${root}` -> Promise<note>
  const rootCache = new Map(); // dir -> {root, at}
  async function repoRoot(dir) {
    const hit = rootCache.get(dir);
    if (hit && Date.now() - hit.at < 60000) return hit.root;
    let probe = dir;
    while (!(await stat(probe).then((st) => st.isDirectory(), () => false))) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const root = await checkpoints.repo(probe).then((r) => r.root, (e) => { if (e.code === 'NOT_A_GIT_REPO') return null; throw e; });
    rootCache.set(dir, { root, at: Date.now() });
    return root;
  }
  async function autoCheckpoint(sid, dir, paths) {
    try {
      const root = await repoRoot(dir);
      if (!root) return '';
      const key = `${sid}\0${root.toLowerCase()}`;
      if (!autoDone.has(key)) {
        autoDone.set(key, checkpoints.create(root, sid, 'auto, before the first change in this session').then(
          (r) => (r.skipped ? '' : `\n[desk-node: checkpoint ${r.ref.split('/').pop()} of ${paths.display(root)} taken before this session's first change there; Machines action restore can bring it back]`),
          (e) => { autoDone.delete(key); return `\n[desk-node: automatic checkpoint of ${paths.display(root)} failed: ${e.message}]`; }));
        return await autoDone.get(key);
      }
      await autoDone.get(key);
      return '';
    } catch (error) {
      return `\n[desk-node: automatic checkpoint skipped: ${error.message}]`;
    }
  }

  const transfer = createTransfer({ locks, autoCheckpoint, pathsFor, outputsDir });

  async function write(sid, abs, makeText) {
    return locks.run(abs.toLowerCase(), async () => {
      const before = await currentTag(abs);
      let old = null;
      if (before !== null) {
        reads.require(sid, abs, before);
        old = await readText(abs);
        if (old.etag !== before) throw new DeskError('STALE_ETAG', 'File changed during the write; read it again');
      }
      const { text, extra } = makeText(old?.format.text ?? null);
      if (text.length > MAX_WRITE_CHARS) throw new DeskError('TOO_LARGE', 'Content exceeds 10 MiB characters');
      const bytes = encode(text, old?.format ?? NEW_FILE);
      await writeAtomic(abs, bytes, before);
      const after = etag(bytes);
      reads.record(sid, abs, after);
      return { created: before === null, etag: after, encoding: (old?.format ?? NEW_FILE).kind, ...extra };
    });
  }

  const tools = {
    async Read(a, { sid, paths }) {
      const abs = await paths.check(str(a.file_path, 'file_path'));
      if (IMAGE_EXTENSIONS.test(abs)) {
        const image = await readImage(abs, paths.display(abs));
        if (image) return image;
      }
      const file = await readText(abs);
      const view = formatRead(file.format.text, a.offset ?? 1, a.limit ?? 2000);
      reads.record(sid, abs, file.etag);
      return { text: view.text, data: { path: paths.display(abs), etag: file.etag, encoding: file.format.kind, eol: file.format.eol, totalLines: view.totalLines, numLines: view.numLines, truncated: view.truncated } };
    },

    async Write(a, { sid, paths }) {
      const abs = await paths.check(str(a.file_path, 'file_path'));
      const content = str(a.content, 'content');
      const note = await autoCheckpoint(sid, path.dirname(abs), paths);
      const r = await write(sid, abs, () => ({ text: content }));
      return { text: (r.created ? `File created successfully at: ${paths.display(abs)}` : `The file ${paths.display(abs)} has been updated.`) + note, data: { path: paths.display(abs), ...r } };
    },

    async Edit(a, { sid, paths }) {
      const abs = await paths.check(str(a.file_path, 'file_path'));
      const oldString = str(a.old_string, 'old_string'), newString = str(a.new_string, 'new_string');
      const note = await autoCheckpoint(sid, path.dirname(abs), paths);
      const r = await write(sid, abs, (old) => {
        if (old === null) throw new DeskError('NOT_FOUND', `File does not exist: ${paths.display(abs)}`, 'Use Write to create it');
        const result = edit(old, oldString, newString, Boolean(a.replace_all));
        return { text: result.text, extra: { replacements: result.replacements } };
      });
      return { text: `The file ${paths.display(abs)} has been updated (${r.replacements} replacement${r.replacements > 1 ? 's' : ''}).${note}`, data: { path: paths.display(abs), ...r } };
    },

    Glob: (a, { paths, signal }) => runGlob(paths, a, signal),
    Grep: async (a, { paths, signal }) => {
      const r = await runGrep(paths, rg, a, signal);
      const bounded = await boundText(r.text, archiver(outputsDir, (f) => paths.display(f)));
      return { text: bounded.text, data: { ...r.data, truncated: bounded.truncated, archive: bounded.archive } };
    },

    async Bash(a, meta) {
      const { paths } = meta;
      const command = str(a.command, 'command');
      const shell = shellOf(a.shell);
      const cwd = await workDir(paths, a.cwd);
      if (a.run_in_background) return tools.BashJob({ action: 'start', command, shell, cwd: a.cwd }, meta);
      const note = await autoCheckpoint(meta.sid, cwd, paths);
      const timeoutMs = Math.min(Math.max(Number(a.timeout ?? DEFAULT_TIMEOUT), 1000), MAX_TIMEOUT);
      const r = await runForeground({ command, shell, cwd, timeoutMs, tmpDir: `${dataDir}/tmp`, bash, signal: meta.signal });
      let text = cleanOutput(r.output).replace(/\n+$/, '');
      if (r.cancelled) text += `\n[desk-node: cancelled by the caller after ${(r.ms / 1000).toFixed(1)} s; the command and every process it started were terminated]`;
      else if (r.timedOut) text += `\n[desk-node: command timed out after ${timeoutMs} ms and was killed]`;
      else if (r.exitCode !== 0) text += `\n[exit code ${r.exitCode}]`;
      text = text.replace(/^\n/, ''); // no output, just a note
      const archive = archiver(outputsDir, (f) => paths.display(f));
      const shown = a.full ? await boundText(text, archive) : await summarizeOutput(text, archive);
      const bounded = a.full ? shown : await boundText(shown.text, async () => shown.archive);
      return { text: (bounded.text || '(no output)') + note, data: { exitCode: r.exitCode, timedOut: r.timedOut, cancelled: r.cancelled, truncated: shown.truncated || bounded.truncated, archive: shown.archive } };
    },

    async BashJob(a, { sid, paths, signal }) {
      const action = a.action ?? 'status';
      if (action === 'start') {
        const command = str(a.command, 'command');
        const cwd = await workDir(paths, a.cwd);
        const note = await autoCheckpoint(sid, cwd, paths);
        const job = jobs.start({ command, shell: shellOf(a.shell), cwd });
        const summary = summaryFor(paths);
        return { text: `Started job ${job.id} (pid ${job.pid}). Log: ${paths.display(job.log)}\nCheck with BashJob {"action":"status","id":"${job.id}"}${note}`, data: summary(job, 'running') };
      }
      if (action === 'list') {
        const list = jobs.list(Number.isInteger(a.limit) ? a.limit : 20);
        const summary = summaryFor(paths);
        return { text: list.map((j) => `${j.id}  ${j.state}${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''}  ${j.command.slice(0, 80).replace(/\s+/g, ' ')}`).join('\n') || 'No jobs', data: { jobs: list.map((j) => summary(j)) } };
      }
      const id = str(a.id, 'id');
      const summary = summaryFor(paths);
      if (action === 'stop') { const s = jobs.stop(id); return { text: `Job ${id}: ${s.state}`, data: summary(s) }; }
      if (action === 'status' || action === 'output') {
        let s = jobs.status(id);
        const waitMs = Math.min(Number(a.wait_ms ?? 0), 300000);
        for (const until = Date.now() + waitMs; s.state === 'running' && Date.now() < until && !signal?.aborted;) {
          await new Promise((r) => setTimeout(r, 500));
          s = jobs.status(id);
        }
        const log = cleanOutput(jobs.readLog(id)).replace(/\n+$/, '');
        const header = `Job ${id}: ${s.state}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}; log: ${paths.display(s.log)}`;
        // The job log is its own archive (line numbers match it).
        const shown = action === 'output' ? { text: log } : await summarizeOutput(log, async () => paths.display(s.log));
        const bounded = await boundText(shown.text, async () => paths.display(s.log));
        const waited = signal?.aborted && s.state === 'running' ? '\n[desk-node: wait cancelled by the caller; the job keeps running]' : '';
        return { text: `${header}\n${bounded.text}`.trimEnd() + waited, data: summary(s) };
      }
      throw new DeskError('BAD_REQUEST', `Unknown BashJob action: ${action}`, 'Use start, status, output, stop or list');
    },
  };

  // Not exposed as MCP tools: the gateway calls these for Machines actions.
  tools.Checkpoint = async (a, { sid, paths }) => {
    const dir = await paths.check(a.path ?? paths.defaultDir);
    const action = a.action ?? 'create';
    if (action === 'create') {
      const r = await checkpoints.create(dir, sid, typeof a.note === 'string' ? a.note.slice(0, 200) : '');
      return { text: r.skipped ? `${r.text} (${paths.display(r.root)})` : `Checkpoint ${r.ref} created in ${paths.display(r.root)}`, data: { ref: r.ref, skipped: Boolean(r.skipped), root: paths.display(r.root) } };
    }
    if (action === 'list') {
      const r = await checkpoints.list(dir, sid);
      const lines = r.checkpoints.map((c) => `${c.n}  ${c.date}  ${c.subject}`);
      return { text: lines.length ? `Checkpoints of this session in ${paths.display(r.root)}:\n${lines.join('\n')}` : `No checkpoints of this session in ${paths.display(r.root)}`, data: { checkpoints: r.checkpoints } };
    }
    if (action === 'restore') {
      const show = (list) => list.slice(0, 50).join(', ') + (list.length > 50 ? ` … (+${list.length - 50})` : '');
      if (a.confirm !== true) {
        const p = await checkpoints.plan(dir, sid, a.ref);
        return { text: `Restoring ${p.checkpoint.ref} in ${paths.display(p.root)} would rewrite ${p.toWrite.length} file(s) and delete ${p.toDelete.length}.\nRewrite: ${show(p.toWrite) || '-'}\nDelete: ${show(p.toDelete) || '-'}\nCall again with confirm: true to apply (Git index, HEAD and ignored files are not touched).`, data: { ref: p.checkpoint.ref, toWrite: p.toWrite, toDelete: p.toDelete } };
      }
      const r = await checkpoints.restore(dir, sid, a.ref);
      return { text: `Restored ${r.checkpoint.ref} in ${paths.display(r.root)}: ${r.toWrite.length} file(s) rewritten, ${r.toDelete.length} deleted.${r.backup ? ` Previous versions saved in ${paths.display(r.backup)}` : ''}`, data: { ref: r.checkpoint.ref, rewritten: r.toWrite, deleted: r.toDelete, backup: r.backup && paths.display(r.backup) } };
    }
    throw new DeskError('BAD_REQUEST', `Unknown Checkpoint action: ${action}`, 'Use create, list or restore');
  };
  tools.Upgrade = async (a) => {
    if (a.action === 'status') return readUpgrade(home, str(a.id, 'id'));
    return startUpgrade({ home, packageName: str(a.package, 'package'), version: str(a.version, 'version') });
  };

  // Read-only RPCs for fleet-ui (Fs, Git); also not MCP tools, never mutating.
  Object.assign(tools, createReadOnlyTools({ git, dataDir }));

  const summaryFor = (paths) => (j, state = j.state) => {
    return { id: j.id, state, exitCode: j.exitCode ?? null, pid: j.pid, startedAt: j.startedAt, stoppedAt: j.stoppedAt, log: paths.display(j.log) };
  };

  /** Run one RPC; never throws. */
  async function dispatch(tool, args, { sid, defaultDir, signal }) {
    const fn = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
    if (!fn) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${tool}`, next: `Use one of ${Object.keys(tools).join(', ')}` } };
    try {
      const r = await fn(args ?? {}, { sid, paths: pathsFor(defaultDir), signal });
      return { ok: true, text: r.text, data: r.data, ...(r.image ? { image: r.image } : {}) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  }

  /** Archive and copy-backup retention: 7 days, 1 GB each. */
  async function prune() {
    const running = new Set(jobs.list(10000).filter((j) => j.state === 'running').map((j) => path.resolve(j.log).toLowerCase()));
    const [outputs, backups] = await Promise.all([pruneOutputs([outputsDir, `${outputsDir}/jobs`], { keep: (f) => running.has(path.resolve(f).toLowerCase()) }), transfer.prune()]);
    return { removed: outputs.removed + backups.removed, freed: outputs.freed + backups.freed, total: outputs.total + backups.total };
  }

  return { dispatch, prune, names: Object.keys(tools), transfer };
}
