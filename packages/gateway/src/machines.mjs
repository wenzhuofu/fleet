// machines.json (re-read when it changes, so edits apply without restarting the session):
// {
//   "default": "pc-home",
//   "machines": {
//     "pc-home": { "url": "http://<pc>.<tailnet>.ts.net:7801", "tokenFile": "~/.config/desk-fleet/tokens/pc-home.token",
//                  "os": "windows", "defaultDir": "D:\\git", "ssh": "pc-home", "note": "..." },
//     "vps": { "local": true, "os": "linux", "defaultDir": "/home/me/fleet", "note": "..." }
//   }
// }
// The last time each machine answered is kept in a small state file for MACHINE_OFFLINE messages.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayError } from './errors.mjs';

const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

/** Directory shapes desk-node accepts as an absolute default dir (paths.mjs resolve): D:\x, D:/x, /d/x; POSIX nodes: /x. */
export function validDefaultDir(dir, nodeOs) {
  if (typeof dir !== 'string' || !dir || dir.length > 260 || /[\u0000-\u001f\u007f]/.test(dir)) return false;
  if (nodeOs && nodeOs !== 'windows') return dir.startsWith('/') && !dir.startsWith('//');
  return /^[A-Za-z]:([\\/]|$)/.test(dir) || /^\/[A-Za-z](\/|$)/.test(dir);
}

export class Machines {
  constructor({ file, stateDir, defaultMachine, defaultDir, defaultSource = 'DESK_DEFAULT_MACHINE/DESK_DEFAULT_DIR', bindingProblem = null }) {
    this.file = expand(file);
    this.stateDir = expand(stateDir);
    this.seenFile = path.join(this.stateDir, 'last-seen.json');
    this.envDefault = defaultMachine;
    this.envDefaultDir = defaultDir; // undefined = not set; '' counts as set (and invalid)
    this.source = defaultSource; // where the default machine/dir came from (.desk.json path or env), for messages
    this.bindingProblem = bindingProblem;
    this.cache = null;
    this.tokens = new Map();
    this.seenWritten = new Map();
  }

  /** Apply a binding from resolveBinding() (re-read on every call, so /desk:use takes effect at once). */
  setBinding(b) {
    this.envDefault = b.machine;
    this.envDefaultDir = b.dir;
    this.source = b.source ?? this.source;
    this.bindingProblem = b.problem ?? null;
  }

  config() {
    const mtime = statSync(this.file).mtimeMs;
    if (this.cache?.mtime !== mtime) {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.cache = { mtime, machines: raw.machines ?? {}, default: raw.default };
    }
    return this.cache;
  }

  get defaultName() {
    return this.envDefault || this.config().default || Object.keys(this.config().machines).find((n) => !this.config().machines[n].local);
  }

  /** Why the session's binding (.desk.json or DESK_DEFAULT_*) cannot be used, or null. Never falls back to another machine or directory. */
  envProblem() {
    if (this.bindingProblem) return this.bindingProblem;
    const { machines } = this.config();
    const machine = this.envDefault;
    const entry = machine && Object.hasOwn(machines, machine) ? machines[machine] : undefined;
    if (machine && !entry) return `${this.source}: machine ${machine} is not in machines.json`;
    if (this.envDefaultDir === undefined) return null;
    if (!machine) return `${this.source}: a directory is set without a machine`;
    if (entry.local) return `${this.source}: ${machine} is this host; bind a remote machine`;
    if (!validDefaultDir(this.envDefaultDir, entry.os)) return `${this.source}: dir is not an absolute path on ${machine} (use D:\\dir, D:/dir or /d/dir): ${JSON.stringify(this.envDefaultDir)}`;
    return null;
  }

  /** The default dir calls to `name` run with: the binding's dir for the bound machine, else the machines.json value. */
  effectiveDefaultDir(name) {
    const m = this.config().machines[name];
    return this.envDefaultDir !== undefined && name === this.envDefault ? this.envDefaultDir : m?.defaultDir;
  }

  list() {
    return Object.entries(this.config().machines).map(([name, m]) => ({ name, ...m }));
  }

  /** Resolve the `machine` argument to a remote machine entry. */
  get(name = this.defaultName) {
    const { machines } = this.config();
    const m = Object.hasOwn(machines, name) ? machines[name] : undefined;
    if (!m) throw new GatewayError('UNKNOWN_MACHINE', `Unknown machine: ${name}`, `Use one of: ${Object.keys(machines).join(', ')}`);
    if (m.local) throw new GatewayError('LOCAL_MACHINE', `${name} is this host`, 'Use the built-in Read/Write/Edit/Glob/Grep/Bash tools for it');
    if (!m.url || !m.tokenFile) throw new GatewayError('BAD_CONFIG', `machines.json entry ${name} needs url and tokenFile`);
    if (this.bindingProblem || (this.envDefaultDir !== undefined && (!this.envDefault || name === this.envDefault))) {
      const problem = this.envProblem();
      if (problem) throw new GatewayError('BAD_CONFIG', problem, 'Fix it with /desk:use <machine> [dir] (rewrites .desk.json), or remove the file');
    }
    return { name, ...m, defaultDir: this.effectiveDefaultDir(name) };
  }

  token(m) {
    const file = expand(m.tokenFile);
    const mtime = statSync(file).mtimeMs;
    const hit = this.tokens.get(file);
    if (hit?.mtime === mtime) return hit.token;
    const token = readFileSync(file, 'utf8').trim();
    this.tokens.set(file, { mtime, token });
    return token;
  }

  lastSeen(name) {
    try { return JSON.parse(readFileSync(this.seenFile, 'utf8'))[name] ?? null; } catch { return null; }
  }

  /** Record a successful contact (written at most every 30 s per machine). */
  seen(name) {
    const now = Date.now();
    if (now - (this.seenWritten.get(name) ?? 0) < 30000) return;
    this.seenWritten.set(name, now);
    try {
      let all = {};
      try { all = JSON.parse(readFileSync(this.seenFile, 'utf8')); } catch { /* first write */ }
      all[name] = new Date(now).toISOString();
      mkdirSync(path.dirname(this.seenFile), { recursive: true });
      const tmp = `${this.seenFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 1));
      renameSync(tmp, this.seenFile);
    } catch { /* best effort */ }
  }
}
