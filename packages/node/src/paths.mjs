// Path normalization (ported in spirit from v1 workspace-win/src/mcp-path.ts):
// accept D:\x, D:/x, /d/x and relative paths; print relative paths inside the
// default directory and D:/x absolute paths elsewhere.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { DeskError } from './errors.mjs';

const win = path.win32;
const lower = (p) => p.toLowerCase();

export class Paths {
  /**
   * blocked: desk-node's own data and credential files.
   * denied: config.json denyPaths, directories the owner keeps out of reach of the
   * file tools, Fs/Git, and as a Bash/BashJob working directory (not a sandbox: a
   * command can still name a denied path).
   */
  constructor({ defaultDir, blocked = [], denied = [] }) {
    this.defaultDir = win.resolve(defaultDir);
    this.blocked = blocked.map((p) => win.resolve(p));
    this.denied = denied.map((p) => {
      const abs = this.resolve(p, 'C:\\');
      if (!/^[a-zA-Z]:/.test(p.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/'))) throw new Error(`denyPaths entries must be absolute: ${p}`);
      return abs.replace(/\\$/, '');
    });
  }

  /** Same blocked and denied lists, different default directory. */
  withDefault(defaultDir) {
    const p = new Paths({ defaultDir });
    p.blocked = this.blocked;
    p.denied = this.denied;
    return p;
  }

  /** Normalize user input to an absolute Windows path (no filesystem access). */
  resolve(input, base = this.defaultDir) {
    if (typeof input !== 'string' || input === '') throw new DeskError('BAD_REQUEST', 'Path must be a non-empty string');
    if (input.includes('\0')) throw new DeskError('BAD_PATH', 'Path contains a NUL character');
    let p = input;
    const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (msys) p = `${msys[1]}:${msys[2] ?? '/'}`;
    if (/^[\\/]{2}/.test(p)) throw new DeskError('BAD_PATH', 'UNC and device paths are not supported', 'Use a local drive path such as D:/dir/file');
    if (/^[a-zA-Z]:$/.test(p)) p += '\\';
    if (/^[a-zA-Z]:(?![\\/])/.test(p)) throw new DeskError('BAD_PATH', 'Drive-relative paths are not supported', 'Use D:/dir/file');
    if (/^[\\/]/.test(p)) throw new DeskError('BAD_PATH', `Rooted path without a drive letter: ${input}`, 'Use D:/dir/file, /d/dir/file, or a path relative to the default directory');
    const abs = win.resolve(base, p);
    return abs[0].toUpperCase() + abs.slice(1);
  }

  /** Display form: relative (forward slashes) inside defaultDir, otherwise D:/x. */
  display(abs) {
    if (lower(abs) === lower(this.defaultDir)) return '.';
    const rel = win.relative(this.defaultDir, abs);
    if (rel && !rel.startsWith('..') && !win.isAbsolute(rel)) return rel.replaceAll('\\', '/');
    return abs.replaceAll('\\', '/');
  }

  isBlocked(abs) {
    return this.blockedBy(abs) !== null;
  }

  /** 'internal' (desk-node data), 'denied' (denyPaths) or null. */
  blockedBy(abs) {
    const under = (b) => { const a = lower(abs); return a === lower(b) || a.startsWith(lower(b).replace(/\\$/, '') + '\\'); };
    if (this.blocked.some(under)) return 'internal';
    if (this.denied.some(under)) return 'denied';
    return null;
  }

  /** Denied paths inside dir (or dir itself inside one): a Git repository rooted there would expose them. */
  deniedWithin(dir) {
    const d = lower(dir).replace(/\\$/, '') + '\\';
    return this.denied.filter((x) => (lower(x) + '\\').startsWith(d));
  }

  /** Resolve and reject blocked paths, including via junctions/symlinks of existing ancestors. */
  async check(input, base) {
    const abs = this.resolve(input, base);
    if (this.isBlocked(abs)) throw blockedError(abs, this.blockedBy(abs));
    let probe = abs, rest = '';
    for (;;) {
      try {
        const real = win.join(await realpath(probe), rest);
        if (this.isBlocked(real)) throw blockedError(abs, this.blockedBy(real));
        break;
      } catch (error) {
        if (error instanceof DeskError) throw error;
        const parent = win.dirname(probe);
        if (parent === probe) break;
        rest = win.join(win.basename(probe), rest);
        probe = parent;
      }
    }
    return abs;
  }
}

function blockedError(abs, by) {
  if (by === 'denied') {
    return new DeskError('PATH_DENIED', `Path is in this machine's denyPaths and not accessible: ${abs}`, 'The machine owner keeps this directory out of reach; do not try to access it another way');
  }
  return new DeskError('PATH_BLOCKED', `desk-node data and credential files are not accessible: ${abs}`);
}
