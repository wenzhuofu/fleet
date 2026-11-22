import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCopy } from './copy.mjs';
import { machinesFile, resolveBinding } from './binding.mjs';
import { Machines } from './machines.mjs';
const env = process.env, args = process.argv.slice(2), noBackup = args.includes('--no-backup');
const positional = args.filter((arg) => arg !== '--no-backup');
if (positional.length !== 2 || args.some((arg) => arg.startsWith('--') && arg !== '--no-backup')) {
  console.error('Usage: desk-copy <from> <to> [--no-backup]'); process.exitCode = 1;
} else {
  const stateDir = (env.DESK_STATE_DIR ?? '~/.local/state/desk-fleet').replace(/^~(?=$|\/)/, os.homedir());
  mkdirSync(stateDir, { recursive: true });
  const log = (line) => { try { appendFileSync(path.join(stateDir, 'gateway.log'), `${new Date().toISOString()} [${process.pid}] ${line}\n`); } catch { /* ignore */ } };
  const binding = resolveBinding({ env });
  const machines = new Machines({ file: machinesFile(env), stateDir, defaultMachine: binding.machine, defaultDir: binding.dir, defaultSource: binding.source, bindingProblem: binding.problem });
  const copy = createCopy({ machines, sid: env.CLAUDE_CODE_SESSION_ID || `desk-copy-${randomUUID()}`, log });
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try { console.log(await copy({ from: positional[0], to: positional[1], backup: !noBackup }, { signal: controller.signal, allowRelative: true })); }
  catch (error) { console.error(`${error.message}${error.next ? `; ${error.next}` : ''}`); process.exitCode = 1; }
}
