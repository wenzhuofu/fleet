// Command execution: foreground Bash and detached BashJob.
// Commands are written to a script file and run by the chosen shell with a
// UTF-8 environment (LANG=C.UTF-8, chcp 65001 for cmd, PYTHONIOENCODING=utf-8).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DeskError } from './errors.mjs';
import { createJob, jobFor, openJob } from './winjob.mjs';

const IS_WIN = process.platform === 'win32';
export const SHELLS = ['bash', 'cmd', 'powershell'];

export function childEnv() {
  return {
    ...process.env,
    LANG: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never', // Git Credential Manager must not open (possibly invisible) dialogs
  };
}

/** Write the command to a script file; returns [executable, args, scriptPath]. */
function prepare(shell, command, dir, id, bash) {
  mkdirSync(dir, { recursive: true });
  if (shell === 'bash') {
    const script = path.join(dir, `${id}.sh`);
    writeFileSync(script, command + '\n', { mode: 0o600 });
    return [bash, ['--noprofile', '--norc', script.replaceAll('\\', '/')], script];
  }
  if (shell === 'cmd') {
    const script = path.join(dir, `${id}.cmd`);
    writeFileSync(script, `@echo off\r\nchcp 65001 >nul\r\n${command.replace(/\r?\n/g, '\r\n')}\r\n`, { mode: 0o600 });
    return ['cmd.exe', ['/d', '/c', script], script];
  }
  if (shell === 'powershell') {
    const script = path.join(dir, `${id}.ps1`);
    const body = "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n$ProgressPreference = 'SilentlyContinue'\r\n"
      + command.replace(/\r?\n/g, '\r\n') + '\r\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n';
    writeFileSync(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]), { mode: 0o600 });
    return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], script];
  }
  throw new DeskError('BAD_REQUEST', `Unknown shell: ${shell}`, `Use one of ${SHELLS.join(', ')}`);
}

/** Fallback when no job handle is available: Windows tree kill plus the MSYS process group. */
export function killTree(pid, { bash, msysPgid } = {}) {
  if (!IS_WIN) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } return; }
  if (bash && msysPgid) spawnSync(path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'kill.exe'), ['-9', '--', `-${msysPgid}`], { windowsHide: true });
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
}

/** Job that kills the whole process tree; falls back to killTree if the job cannot be created. */
function contain(pid, killOnClose) {
  try { return jobFor(pid, { killOnClose }); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const HEAD_CAP = 8 * 1024 * 1024, TAIL_CAP = 24 * 1024 * 1024;
const EXIT_GRACE_MS = 1000;

/**
 * Run a command in the foreground; resolves with combined stdout+stderr bytes.
 * Aborting `signal` (the caller cancelled) terminates the whole process tree.
 */
export function runForeground({ command, shell = 'bash', cwd, timeoutMs, tmpDir, bash, signal }) {
  const id = randomUUID();
  const [exe, args, script] = prepare(shell, command, tmpDir, id, bash);
  return new Promise((resolve) => {
    const head = [], tail = [];
    let headBytes = 0, tailBytes = 0, dropped = 0, timedOut = false, cancelled = false;
    const started = Date.now();
    const push = (chunk) => {
      if (headBytes < HEAD_CAP) { head.push(chunk); headBytes += chunk.length; return; }
      tail.push(chunk); tailBytes += chunk.length;
      while (tailBytes > TAIL_CAP) { const c = tail.shift(); tailBytes -= c.length; dropped += c.length; }
    };
    let child;
    try {
      child = spawn(exe, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN });
    } catch (error) {
      unlinkSync(script);
      resolve({ output: Buffer.from(String(error.message)), exitCode: null, timedOut: false, spawnError: true });
      return;
    }
    const job = child.pid ? contain(child.pid, true) : null;
    const kill = () => (job ? job.terminate() : killTree(child.pid));
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let done = false, leftovers = false, exitCode = null, grace;
    const finish = (spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      job?.close(); // kill-on-close: nothing the command started outlives it
      child.stdout.destroy();
      child.stderr.destroy();
      try { unlinkSync(script); } catch { /* ignore */ }
      const parts = [...head];
      if (dropped) parts.push(Buffer.from(`\n[desk-node: ${dropped} bytes dropped from the middle of the output]\n`));
      parts.push(...tail);
      if (leftovers) parts.push(Buffer.from('\n[desk-node: processes left running by the command were terminated; use BashJob for long-running processes]\n'));
      resolve({ output: Buffer.concat(parts), exitCode, timedOut, cancelled, ms: Date.now() - started, spawnError });
    };
    child.on('error', (error) => { push(Buffer.from(`desk-node: failed to start ${exe}: ${error.message}\n`)); finish(true); });
    // Background processes inherit the pipes and would keep 'close' from firing; give
    // them a short grace after the shell exits, then terminate them.
    child.on('exit', (code) => { exitCode = code; grace = setTimeout(() => { leftovers = !timedOut && !cancelled; kill(); finish(false); }, EXIT_GRACE_MS); });
    child.on('close', () => finish(false));
  });
}

/** Detached background jobs whose state survives desk-node restarts. */
export class Jobs {
  constructor({ metaDir, logDir, bash }) {
    this.handles = new Map(); // id -> job handle (lost on restart; then killTree is used)
    this.metaDir = metaDir;
    this.logDir = logDir;
    this.bash = bash;
    mkdirSync(metaDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
  }

  paths(id) {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(id ?? '')) throw new DeskError('BAD_REQUEST', 'Invalid job id');
    return {
      meta: path.join(this.metaDir, `${id}.json`),
      exit: path.join(this.metaDir, `${id}.exit`),
      pgid: path.join(this.metaDir, `${id}.pgid`),
      log: path.join(this.logDir, `${id}.log`),
    };
  }

  start({ command, shell = 'bash', cwd }) {
    const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
    const p = this.paths(id);
    const [exe, args] = prepare(shell, command, this.metaDir, id, this.bash);
    // Bash wrapper records the exit code on disk, so status survives desk-node restarts.
    const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    const exitTmp = (p.exit + '.tmp').replaceAll('\\', '/');
    const wrapper = path.join(this.metaDir, `${id}.run.sh`);
    writeFileSync(wrapper, `echo $$ > ${q(p.pgid.replaceAll('\\', '/'))}\n${shell === 'bash' ? '' : 'MSYS_NO_PATHCONV=1 '}${[exe, ...args].map(q).join(' ')}\nrc=$?\necho $rc > ${q(exitTmp)} && mv -f ${q(exitTmp)} ${q(p.exit.replaceAll('\\', '/'))}\n`, { mode: 0o600 });
    const log = openSync(p.log, 'w', 0o600); // not 'a': MSYS cannot write to append-only handles
    // Named job without kill-on-close. The wrapper inherits a handle to it, which keeps the
    // job (and its name) alive across desk-node restarts so `stop` can still reopen it.
    let job = null;
    try { job = createJob({ killOnClose: false, name: `desk-node-job-${id}` }); job?.inheritable(true); } catch { job = null; }
    let child;
    try {
      child = spawn(this.bash, ['--noprofile', '--norc', wrapper.replaceAll('\\', '/')], {
        cwd, env: childEnv(), windowsHide: true, detached: true, stdio: ['ignore', log, log],
      });
    } finally {
      closeSync(log);
      job?.inheritable(false);
    }
    child.unref();
    if (job) {
      try { job.assign(child.pid); this.handles.set(id, job); } catch { job.close(); }
    }
    const meta = { id, command, shell, cwd, pid: child.pid, startedAt: new Date().toISOString(), log: p.log };
    writeFileSync(p.meta, JSON.stringify(meta, null, 1), { mode: 0o600 });
    return meta;
  }

  meta(id) {
    const p = this.paths(id);
    if (!existsSync(p.meta)) throw new DeskError('NOT_FOUND', `No such job: ${id}`, 'Use BashJob {"action":"list"}');
    return JSON.parse(readFileSync(p.meta, 'utf8'));
  }

  status(id) {
    const meta = this.meta(id), p = this.paths(id);
    if (existsSync(p.exit)) {
      const code = Number.parseInt(readFileSync(p.exit, 'utf8'), 10);
      return { ...meta, state: meta.stoppedAt ? 'stopped' : 'exited', exitCode: Number.isNaN(code) ? null : code };
    }
    if (meta.stoppedAt) return { ...meta, state: 'stopped', exitCode: null };
    return { ...meta, state: alive(meta.pid) ? 'running' : 'lost', exitCode: null };
  }

  stop(id) {
    const meta = this.meta(id);
    const before = this.status(id);
    if (before.state !== 'running') return before;
    const job = this.handles.get(id) ?? openJob(`desk-node-job-${id}`), pgidFile = this.paths(id).pgid;
    if (job) job.terminate();
    else killTree(meta.pid, { bash: this.bash, msysPgid: existsSync(pgidFile) ? readFileSync(pgidFile, 'utf8').trim() : undefined });
    job?.close();
    this.handles.delete(id);
    meta.stoppedAt = new Date().toISOString();
    writeFileSync(this.paths(id).meta, JSON.stringify(meta, null, 1), { mode: 0o600 });
    return this.status(id);
  }

  list(limit = 20) {
    return readdirSync(this.metaDir)
      .filter((n) => n.endsWith('.json'))
      .sort().reverse().slice(0, limit)
      .map((n) => { try { return this.status(n.slice(0, -5)); } catch { return null; } })
      .filter(Boolean);
  }

  readLog(id) {
    const p = this.paths(id);
    this.meta(id);
    return existsSync(p.log) ? readFileSync(p.log) : Buffer.alloc(0);
  }
}
