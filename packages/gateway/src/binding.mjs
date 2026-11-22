// Which machine and directory a session works on by default, and where machines.json is.
//   1. DESK_DEFAULT_MACHINE (+ DESK_DEFAULT_DIR) in the environment, when set;
//   2. else the nearest .desk.json at or above the session's directory: {"machine": "...", "dir": "..."}
//      (written by /desk:use; any VPS directory can be bound this way);
//   3. else machines.json's "default" machine and that machine's defaultDir.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BINDING_FILE = '.desk.json';

/** {machine, dir, source} for the session, or {} when nothing binds it. A broken .desk.json is reported, not ignored. */
export function resolveBinding({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.DESK_DEFAULT_MACHINE) {
    return { machine: env.DESK_DEFAULT_MACHINE, dir: env.DESK_DEFAULT_DIR, source: env.DESK_DEFAULT_DIR !== undefined ? 'DESK_DEFAULT_MACHINE/DESK_DEFAULT_DIR' : 'DESK_DEFAULT_MACHINE' };
  }
  if (env.DESK_DEFAULT_DIR !== undefined) return { dir: env.DESK_DEFAULT_DIR, source: 'DESK_DEFAULT_DIR' };
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, BINDING_FILE);
    if (existsSync(file)) {
      let data;
      try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { source: file, problem: `${file} is not valid JSON: ${error.message}` }; }
      if (!data || typeof data.machine !== 'string' || !data.machine) return { source: file, problem: `${file} needs a "machine" string` };
      if (data.dir !== undefined && typeof data.dir !== 'string') return { source: file, problem: `${file}: "dir" must be a string` };
      return { machine: data.machine, dir: data.dir, source: file };
    }
    if (path.dirname(dir) === dir) return {};
  }
}

/** DESK_MACHINES, else ~/.config/desk-fleet/machines.json when it exists, else ~/fleet/machines.json. */
export function machinesFile(env = process.env) {
  if (env.DESK_MACHINES) return env.DESK_MACHINES;
  const own = path.join(os.homedir(), '.config', 'desk-fleet', 'machines.json');
  return existsSync(own) ? own : path.join(os.homedir(), 'fleet', 'machines.json');
}
