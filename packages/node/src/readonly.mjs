// Read-only RPCs for fleet-ui's machine panel. Internal (not MCP tools): the gateway never
// exposes them, they take no callId and never trigger automatic checkpoints.
//   Fs  {action: 'stat' | 'read' | 'tree', path, encoding?, maxDepth?, maxEntries?, exclude?}
//   Git {cwd, args}   whitelisted read-only git subcommands; returns {code, stdout, stderr}
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DeskError } from './errors.mjs';

const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const GIT_TIMEOUT = 60000;
const slash = (p) => p.replaceAll('\\', '/');

function fsError(error, abs) {
  if (error instanceof DeskError) return error;
  if (error.code === 'ENOENT') return new DeskError('NOT_FOUND', `No such file or directory: ${slash(abs)}`);
  if (error.code === 'EACCES' || error.code === 'EPERM') return new DeskError('PERMISSION_DENIED', `Permission denied: ${slash(abs)}`);
  return new DeskError('FS_ERROR', `${error.code ?? 'error'}: ${error.message}`);
}

const kindOf = (st) => (st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file');

// Subcommands that only read. Some need their arguments checked as well (see allowed()).
const READ_SUBCOMMANDS = new Set(['status', 'diff', 'show', 'log', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'merge-base',
  'for-each-ref', 'show-ref', 'cat-file', 'describe', 'name-rev', 'check-ignore', 'blame', 'branch', 'symbolic-ref', 'remote',
  'config', 'stash', 'worktree']);
const BRANCH_WRITES = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u',
  '--set-upstream-to', '--unset-upstream', '--edit-description', '-t', '--track', '--no-track', '--create-reflog']);

/** Why `args` is not a read-only git invocation, or null when it is. */
export function rejectGitArgs(args) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string' || a.includes('\0'))) return 'args must be a non-empty array of strings';
  const [sub, ...rest] = args;
  if (!READ_SUBCOMMANDS.has(sub)) return `git ${sub} is not a read-only subcommand`;
  const dashdash = rest.indexOf('--');
  const opts = dashdash === -1 ? rest : rest.slice(0, dashdash);
  if (opts.some((a) => /^--output(=|$)/.test(a) || a === '--ext-diff' || /^--(exec|upload-pack|receive-pack)/.test(a))) return 'output, ext-diff and exec options are not allowed';
  const positional = opts.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'branch':
      if (opts.some((a) => BRANCH_WRITES.has(a.split('=')[0]))) return 'git branch may only list branches';
      if (positional.length && !opts.some((a) => ['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(a.split('=')[0]))) return 'git branch may only list branches';
      break;
    case 'symbolic-ref':
      if (positional.length > 1 || opts.some((a) => a === '-d' || a === '--delete' || a === '-m')) return 'git symbolic-ref may only read';
      break;
    case 'remote':
      if (positional.length && !['get-url', 'show'].includes(positional[0])) return 'git remote may only list remotes';
      if (positional[0] === 'show' && !opts.includes('-n')) return 'git remote show needs -n (no network)';
      break;
    case 'config':
      if (!opts.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a))) return 'git config may only read';
      break;
    case 'stash':
      if (!['list', 'show'].includes(positional[0])) return 'git stash may only list or show';
      break;
    case 'worktree':
      if (positional[0] !== 'list') return 'git worktree may only list';
      break;
    default:
  }
  return null;
}

/** Nearest directory at or above dir that has a .git entry (directory or worktree file). */
function repoRoot(dir) {
  for (let d = dir; ; d = path.win32.dirname(d)) {
    if (existsSync(path.win32.join(d, '.git'))) return d;
    if (path.win32.dirname(d) === d) return null;
  }
}

export function createReadOnlyTools({ git, dataDir }) {
  const noHooks = path.join(dataDir, 'no-hooks');
  const str = (v, name) => { if (typeof v !== 'string' || !v) throw new DeskError('BAD_REQUEST', `${name} must be a non-empty string`); return v; };

  async function tree(root, { maxDepth, maxEntries, exclude, paths }) {
    let budget = maxEntries;
    async function walk(dir, depth) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return []; throw fsError(error, dir); }
      const nodes = [];
      for (const entry of entries) {
        const abs = path.win32.join(dir, entry.name);
        if (exclude.has(entry.name) && entry.isDirectory()) continue;
        if (paths.isBlocked(abs)) continue;
        if (--budget < 0) throw new DeskError('TREE_TOO_LARGE', `More than ${maxEntries} entries under ${slash(root)}`, 'Choose a narrower directory');
        const node = { name: entry.name, path: slash(abs), type: entry.isDirectory() ? 'directory' : 'file', size: 0, modified: null };
        try {
          const st = await lstat(abs);
          node.size = st.size;
          node.modified = st.mtime.toISOString();
          if (st.isSymbolicLink()) node.isSymlink = true;
        } catch { /* keep the entry without metadata */ }
        if (node.type === 'directory' && depth < maxDepth) node.children = await walk(abs, depth + 1);
        nodes.push(node);
      }
      return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    }
    return walk(root, 0);
  }

  const tools = {};

  tools.Fs = async (a, { paths }) => {
    const abs = await paths.check(str(a.path, 'path'));
    const action = a.action ?? 'stat';
    if (action === 'stat') {
      try {
        const st = await lstat(abs);
        return { text: `${kindOf(st)} ${st.size}`, data: { path: slash(abs), type: kindOf(st), size: st.size, modified: st.mtime.toISOString(), isSymlink: st.isSymbolicLink() } };
      } catch (error) { throw fsError(error, abs); }
    }
    if (action === 'read') {
      let st;
      try { st = await stat(abs); } catch (error) { throw fsError(error, abs); }
      if (st.isDirectory()) throw new DeskError('IS_DIRECTORY', `Path is a directory: ${slash(abs)}`);
      if (st.size > MAX_READ_BYTES) throw new DeskError('TOO_LARGE', `File exceeds ${MAX_READ_BYTES / 1048576} MiB`);
      const bytes = await readFile(abs).catch((error) => { throw fsError(error, abs); });
      const encoding = a.encoding === 'base64' ? 'base64' : 'utf8';
      return { text: `${bytes.length} bytes`, data: { path: slash(abs), size: bytes.length, encoding, content: bytes.toString(encoding) } };
    }
    if (action === 'tree') {
      try { if (!(await stat(abs)).isDirectory()) throw new DeskError('NOT_A_DIRECTORY', `Not a directory: ${slash(abs)}`); }
      catch (error) { throw fsError(error, abs); }
      const maxDepth = Math.min(Math.max(Number.isInteger(a.maxDepth) ? a.maxDepth : 10, 0), 20);
      const maxEntries = Math.min(Math.max(Number.isInteger(a.maxEntries) ? a.maxEntries : 10000, 1), 50000);
      const exclude = new Set(Array.isArray(a.exclude) ? a.exclude.filter((x) => typeof x === 'string') : []);
      const nodes = await tree(abs, { maxDepth, maxEntries, exclude, paths });
      return { text: `${nodes.length} top-level entries`, data: { path: slash(abs), tree: nodes } };
    }
    throw new DeskError('BAD_REQUEST', `Unknown Fs action: ${action}`, 'Use stat, read or tree');
  };

  tools.Git = async (a, { paths }) => {
    const cwd = await paths.check(str(a.cwd, 'cwd'));
    // git can show any file of the repository (show HEAD:x, log -p), so a repository that
    // contains a denied path is refused as a whole.
    const root = repoRoot(cwd);
    const inside = root ? paths.deniedWithin(root) : [];
    if (inside.length) throw new DeskError('PATH_DENIED', `Repository ${slash(root)} contains a denied path: ${inside.map(slash).join(', ')}`);
    const why = rejectGitArgs(a.args);
    if (why) throw new DeskError('NOT_READ_ONLY', why);
    await mkdir(noHooks, { recursive: true });
    const [sub, ...rest] = a.args;
    const extra = ['diff', 'show', 'log'].includes(sub) ? ['--no-ext-diff'] : [];
    const argv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', `core.hooksPath=${noHooks}`, sub, ...extra, ...rest];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C.UTF-8' };
    delete env.GIT_EXTERNAL_DIFF;
    return new Promise((resolve, reject) => {
      const child = spawn(git, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [], err = [];
      let size = 0;
      const timer = setTimeout(() => child.kill(), GIT_TIMEOUT);
      const take = (list) => (c) => { size += c.length; if (size > MAX_GIT_OUTPUT) child.kill(); else list.push(c); };
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      child.on('error', (e) => { clearTimeout(timer); reject(new DeskError('INTERNAL', `Cannot run git: ${e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (size > MAX_GIT_OUTPUT) return reject(new DeskError('TOO_LARGE', 'git output exceeds 64 MiB'));
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        resolve({ text: `git ${sub}: exit ${code}`, data: { code: code ?? -1, stdout, stderr } });
      });
    });
  };

  return tools;
}
