// desk: everyday switches for the desk plugin, run in the project (session) directory.
//   desk status               this directory's binding and whether desk is on here
//   desk use <machine> [dir]  bind this directory: write ./.desk.json
//   desk unbind               remove ./.desk.json (machines.json's default applies again)
//   desk off | on             turn desk off / on for this directory (.claude/settings.local.json)
// "off" denies every desk tool at once (Claude Code reloads permissions live) and disables the
// plugin for new sessions here, so its tool descriptions are no longer sent.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BINDING_FILE, machinesFile, resolveBinding } from './binding.mjs';
import { Machines, validDefaultDir } from './machines.mjs';

export const PLUGIN_ID = 'desk@fleet';
export const TOOL_PREFIX = 'mcp__plugin_desk_desk';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Turn desk on or off in <dir>/.claude/settings.local.json, keeping everything else in the file. */
export function setEnabled(dir, on) {
  const file = path.join(dir, '.claude', 'settings.local.json');
  const data = readJson(file);
  data.enabledPlugins = { ...(data.enabledPlugins ?? {}) };
  const deny = (data.permissions?.deny ?? []).filter((r) => r !== TOOL_PREFIX);
  if (on) delete data.enabledPlugins[PLUGIN_ID];
  else { data.enabledPlugins[PLUGIN_ID] = false; deny.push(TOOL_PREFIX); }
  if (!Object.keys(data.enabledPlugins).length) delete data.enabledPlugins;
  data.permissions = { ...(data.permissions ?? {}), deny };
  if (!deny.length) delete data.permissions.deny;
  if (!Object.keys(data.permissions).length) delete data.permissions;
  writeJson(file, data);
  return file;
}

export function isOff(dir) {
  const data = readJson(path.join(dir, '.claude', 'settings.local.json'));
  return data.enabledPlugins?.[PLUGIN_ID] === false || (data.permissions?.deny ?? []).includes(TOOL_PREFIX);
}

export function run(argv, { cwd = process.cwd(), env = process.env, out = console.log } = {}) {
  const [cmd = 'status', ...rest] = argv;
  const machines = () => new Machines({ file: machinesFile(env), stateDir: path.join(cwd, '.desk-unused') });
  if (cmd === 'use') {
    const [machine, dir] = rest;
    if (!machine) throw new Error('usage: desk use <machine> [dir]');
    const m = machines().config().machines[machine];
    if (!m) throw new Error(`unknown machine ${machine}; known: ${Object.keys(machines().config().machines).join(', ')}`);
    if (m.local) throw new Error(`${machine} is this host; desk works on remote machines`);
    if (dir !== undefined && !validDefaultDir(dir, m.os)) throw new Error(`not an absolute path on ${machine}: ${dir} (use D:\\dir, D:/dir or /d/dir)`);
    const file = path.join(cwd, BINDING_FILE);
    writeJson(file, dir === undefined ? { machine } : { machine, dir });
    out(`bound ${cwd} -> ${machine}${dir ? `:${dir}` : ` (its default dir ${m.defaultDir ?? '-'})`}; applies to desk calls from now on`);
    return 0;
  }
  if (cmd === 'unbind') {
    const file = path.join(cwd, BINDING_FILE);
    if (existsSync(file)) { rmSync(file); out(`removed ${file}`); } else out(`no ${BINDING_FILE} in ${cwd}`);
    return 0;
  }
  if (cmd === 'off' || cmd === 'on') {
    const file = setEnabled(cwd, cmd === 'on');
    out(cmd === 'off'
      ? `desk is off in ${cwd}: its tools are denied now, and new sessions here do not load the plugin (${file})`
      : `desk is on in ${cwd}; start a new session (or /mcp → reconnect) if its tools are not listed (${file})`);
    return 0;
  }
  if (cmd === 'status') {
    const b = resolveBinding({ env, cwd });
    const def = machines().defaultName;
    out(`desk: ${isOff(cwd) ? 'OFF in this directory (desk on to enable)' : 'on'}`);
    out(b.problem ? `binding: PROBLEM ${b.problem}` : b.machine ? `binding: ${b.machine}${b.dir ? `:${b.dir}` : ''} (from ${b.source})` : `binding: none; default machine ${def}`);
    out(`machines: ${machinesFile(env)}`);
    return 0;
  }
  throw new Error(`unknown command ${cmd}; use status, use, unbind, off or on`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (error) { console.error(`desk: ${error.message}`); process.exitCode = 1; }
}
