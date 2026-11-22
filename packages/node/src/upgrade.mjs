// desk-node upgrader. Started by the Upgrade tool through WMI, so it is not a child of the
// node process (or of its scheduled task) and survives the restart it triggers. It runs with
// the old release's node.exe and scripts, which stay in place while `current` moves.
//   node upgrade.mjs --home C:\desk-node --package <tar.gz> --version <v> --id <id>
// Steps: install → switch current → restart → health check (version + one Read) within
// HEALTH_MS → on failure switch back, restart and re-check. Writes logs\upgrade.log and
// logs\upgrade-<id>.json ({id, from, to, result, seconds, error}).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeOutput } from './output.mjs';

// HEALTH_MS counts from the switch, so a broken release is rolled back well inside 60 s.
const HEALTH_MS = 40000, ROLLBACK_HEALTH_MS = 15000;
const { values: opt } = parseArgs({ options: { home: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, id: { type: 'string' } } });
const home = opt.home;
const deployDir = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'deploy');
const logs = path.join(home, 'logs');
const lock = path.join(logs, 'upgrade.lock');
const t0 = Date.now();
const log = (line) => appendFileSync(path.join(logs, 'upgrade.log'), `${new Date().toISOString()} [${opt.id}] ${line}\n`);
// PowerShell writes errors in the OEM code page (CP936); decode like command output.
function ps(script, ...args) {
  try {
    return decodeOutput(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(deployDir, script), ...args], { windowsHide: true, timeout: 120000 })).trim();
  } catch (error) {
    const detail = decodeOutput(Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)])).trim().split(/\r?\n/)[0];
    throw new Error(`${script} ${args.join(' ')}: ${detail || error.message}`);
  }
}
const tryPs = (...args) => { try { log(ps(...args)); } catch (error) { log(`warning: ${error.message}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function currentVersion() {
  try { return path.basename(readlinkSync(path.join(home, 'current')).replace(/[\\/]+$/, '')); } catch { return null; }
}

async function healthy(version, budgetMs) {
  const token = readFileSync(path.join(home, 'data', 'token'), 'utf8').trim();
  const { port = 7801 } = JSON.parse(readFileSync(path.join(home, 'data', 'config.json'), 'utf8'));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;
  let last = 'no answer';
  for (const until = Date.now() + budgetMs; Date.now() < until; await sleep(1000)) {
    try {
      const h = await (await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(3000) })).json();
      if (h.version !== version) { last = `health reports ${h.version}`; continue; }
      const r = await (await fetch(`${base}/rpc`, { method: 'POST', headers, signal: AbortSignal.timeout(5000), body: JSON.stringify({ tool: 'Read', args: { file_path: path.join(home, 'current', 'VERSION') }, sid: 'upgrader' }) })).json();
      if (r.ok && r.text.includes(version)) return { ok: true };
      last = `Read failed: ${JSON.stringify(r.error ?? r.text)}`;
    } catch (error) { last = error.cause?.code ?? error.message; }
  }
  return { ok: false, reason: last };
}

const KEEP_RELEASES = 3;
/** Keep the current release, the one we came from and the newest others: KEEP_RELEASES in all. */
function pruneReleases(keep) {
  const dir = path.join(home, 'releases');
  const others = readdirSync(dir).filter((v) => !keep.includes(v))
    .map((v) => ({ v, t: statSync(path.join(dir, v)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { v } of others.slice(Math.max(0, KEEP_RELEASES - keep.length))) {
    try { rmSync(path.join(dir, v), { recursive: true, force: true }); log(`removed old release ${v}`); }
    catch (error) { log(`warning: cannot remove release ${v}: ${error.message}`); }
  }
}

const result = { id: opt.id, from: currentVersion(), to: opt.version, result: 'failed', error: null };
let switched = false;
try {
  log(`upgrade ${result.from} -> ${opt.version} from ${opt.package}`);
  log(ps('install.ps1', '-Package', opt.package, '-Root', home));
  if (result.from === opt.version) throw new Error(`${opt.version} is already current`);
  log(ps('switch.ps1', '-Version', opt.version, '-Root', home));
  switched = true;
  const switchedAt = Date.now();
  // A restart error (e.g. the new node dies at once) is judged by the health check below.
  tryPs('service.ps1', 'restart');
  const h = await healthy(opt.version, Math.max(5000, HEALTH_MS - (Date.now() - switchedAt)));
  if (!h.ok) throw new Error(`health check failed within ${HEALTH_MS / 1000} s: ${h.reason}`);
  result.result = 'upgraded';
  log(`healthy on ${opt.version}`);
} catch (error) {
  result.error = error.message;
  log(`error: ${error.message}`);
  // Any failure after switching rolls back, whatever its cause.
  if (switched) {
    log(`rolling back to ${result.from}`);
    try {
      if (!result.from) throw new Error('no previous version to roll back to');
      log(ps('switch.ps1', '-Version', result.from, '-Root', home));
      tryPs('service.ps1', 'restart');
      result.rolledBackAfter = Math.round((Date.now() - t0) / 1000);
      const back = await healthy(result.from, ROLLBACK_HEALTH_MS);
      if (!back.ok) throw new Error(back.reason);
      result.result = 'rolled_back';
      log(`rolled back, healthy on ${result.from}`);
    } catch (rollbackError) {
      result.result = 'rollback_failed';
      log(`ROLLBACK FAILED: ${rollbackError.message}; recover over ssh (docs/runbooks/node-recovery.md)`);
    }
  }
}
// After a rollback the failed release is removed; then keep KEEP_RELEASES (current + previous first).
try {
  if (result.result === 'rolled_back') { rmSync(path.join(home, 'releases', opt.version), { recursive: true, force: true }); log(`removed failed release ${opt.version}`); }
  if (['upgraded', 'rolled_back'].includes(result.result)) pruneReleases([...new Set([currentVersion(), result.from].filter(Boolean))]);
} catch (error) {
  log(`warning: pruning releases failed: ${error.message}`);
}
result.seconds = Math.round((Date.now() - t0) / 1000);
writeFileSync(path.join(logs, `upgrade-${opt.id}.json`), JSON.stringify(result, null, 1));
rmSync(lock, { force: true });
log(`done: ${result.result} in ${result.seconds} s`);
