// Out-of-band channel check for Machines: `ssh <alias> 'echo "$0 %OS%"'` (machines.json "ssh"),
// at most every 30 min per machine; the last result is cached in <stateDir>/oob.json and
// shared by all gateway processes. Never run per tool call.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const OOB_MAX_AGE_MS = 30 * 60 * 1000;

export function parseShell(output, machineOs) {
  const s = String(output).toLowerCase();
  return s.includes('bash') ? (machineOs === 'windows' ? 'Git Bash' : 'bash') : s.includes('windows_nt') ? 'cmd' : 'powershell';
}

export function runSsh(alias, command, timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    let timer, settled = false;
    const finish = (ok, detail) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, detail, output: out.trim(), rttMs: Date.now() - started }); };
    timer = setTimeout(() => { child.kill(); finish(false, `timed out after ${timeoutMs} ms`); }, timeoutMs);
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? out.trim() : (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 200)));
  });
}

const probeSsh = async (alias, machineOs) => {
  const r = await runSsh(alias, 'echo "$0 %OS%"');
  return { ...r, shell: r.ok ? parseShell(r.output, machineOs) : undefined };
};

export function createOobCheck({ stateDir, run = probeSsh, maxAgeMs = OOB_MAX_AGE_MS }) {
  const file = path.join(stateDir, 'oob.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  /** Last result for machine m ({at, ok, detail} or null); checks again when older than maxAgeMs and `check` is set. */
  return async function oob(m, { check = true, maxAgeMs: age = maxAgeMs } = {}) {
    if (!m.ssh) return null;
    const last = read()[m.name] ?? null;
    if (!check || (last && Date.now() - Date.parse(last.at) < age)) return last;
    const started = Date.now(), r = await run(m.ssh, m.os);
    const result = { ...r, rttMs: r.rttMs ?? Date.now() - started, at: new Date().toISOString() };
    try {
      const all = read();
      all[m.name] = result;
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 1));
      renameSync(tmp, file);
    } catch { /* best effort */ }
    return result;
  };
}
