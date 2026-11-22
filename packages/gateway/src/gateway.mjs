// Tool calls: validate `machine`, forward to that machine's desk-node, and turn the reply
// into MCP content. Mutating calls carry a callId so retries are idempotent on the node.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callWithRetry, uploadFile } from './client.mjs';
import { createCopy } from './copy.mjs';
import { GatewayError, toEnvelope } from './errors.mjs';
import { createOobCheck, runSsh } from './oob.mjs';

const NODE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashJob']);
const MAX_TEXT = 100000; // safety net; desk-node already bounds output to 30,000 chars
const HEALTH_TIMEOUT = 4000;

const isMutating = (tool, args) => ['Write', 'Edit', 'Bash'].includes(tool)
  || (tool === 'BashJob' && ['start', 'stop'].includes(args.action))
  || (tool === 'Checkpoint' && args.action !== 'list')
  || (tool === 'Upgrade' && args.action === 'start');
const CHECKPOINT_ACTIONS = { checkpoint: 'create', checkpoints: 'list', restore: 'restore' };
const UPGRADE_WAIT_MS = 180000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** Time to wait for the node's answer: the tool's own limit plus a margin. */
function callTimeout(tool, args) {
  const margin = 60000;
  if (tool === 'Bash' && !args.run_in_background) return Math.min(Math.max(Number(args.timeout) || 120000, 1000), 600000) + margin;
  if (tool === 'BashJob') return Math.min(Number(args.wait_ms) || 0, 300000) + margin;
  return 120000;
}

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function bound(text) {
  if (text.length <= MAX_TEXT) return text;
  const head = Math.floor(MAX_TEXT * 0.2);
  return `${text.slice(0, head)}\n… [desk-gateway: ${text.length - MAX_TEXT} chars omitted] …\n${text.slice(text.length - (MAX_TEXT - head))}`;
}

const errorResult = (envelope) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] });

export function createGateway({ machines, sid, retryWindowMs = 30000, log = () => {}, call = callWithRetry, sshExec = runSsh, distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist'), oob = createOobCheck({ stateDir: machines.stateDir }) }) {
  const copy = createCopy({ machines, sid, log });
  const offline = async (m, error) => {
    const seen = machines.lastSeen(m.name);
    const last = `last seen ${seen ? `${seen} (${ago(seen)})` : 'never'}`;
    const failed = `${error.lastError}, gave up after ${Math.round(error.elapsedMs / 1000)} s`;
    if (!m.ssh) return new GatewayError('MACHINE_OFFLINE', `${m.name} did not answer at ${m.url} (${failed}); ${last}`, 'Run Machines to re-check.');
    const out = await oob(m, { maxAgeMs: 60000 });
    return out?.ok
      ? new GatewayError('MACHINE_OFFLINE', `${m.name}: 主机能 ssh，desk-node 不应答 at ${m.url} (${failed}); ${last}`, `Use Machines action=restart. Log in with ssh ${m.ssh}; its shell is ${out.shell ?? 'unknown'}.`)
      : new GatewayError('MACHINE_OFFLINE', `${m.name}: 主机经 tailnet 不可达 (${m.url}; desk-node: ${failed}; ssh: ${out?.detail ?? 'unknown'}); ${last}`, '告诉用户主机经 tailnet 不可达；不要循环重试，也不要改用 ssh。');
  };

  /**
   * Every call carries an opId; when `signal` aborts (the client cancelled the tool call or
   * exited), POST /cancel {opId} makes the node terminate it. The node then answers the
   * original request with a "cancelled" result; a call that already ended ignores the cancel.
   */
  async function forward(tool, args, signal) {
    const { machine, ...rest } = args;
    const m = machines.get(machine || undefined);
    const callId = isMutating(tool, rest) ? randomUUID() : undefined;
    const opId = callId ?? randomUUID();
    const body = { tool, args: rest, sid, opId, ...(m.defaultDir ? { defaultDir: m.defaultDir } : {}), ...(callId ? { callId } : {}) };
    const onAbort = () => {
      call(`${m.url}/cancel`, { method: 'POST', token: machines.token(m), body: { opId }, timeoutMs: 5000 }, { retryWindowMs: 3000 })
        .then((r) => log(`cancel tool=${tool} machine=${m.name} opId=${opId} ${r.cancelled ? 'aborted on the node' : 'already finished'}`),
          (e) => log(`cancel tool=${tool} machine=${m.name} opId=${opId} failed: ${e.message}`));
    };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await call(`${m.url}/rpc`, { method: 'POST', token: machines.token(m), body, timeoutMs: callTimeout(tool, rest), signal },
        { retryWindowMs, onSeen: () => machines.seen(m.name) });
    } catch (error) {
      if (error.code === 'MACHINE_OFFLINE') throw await offline(m, error);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function health(m) {
    const t0 = Date.now();
    try {
      const h = await call(`${m.url}/health`, { token: machines.token(m), timeoutMs: HEALTH_TIMEOUT }, { retryWindowMs: 0, onSeen: () => machines.seen(m.name) });
      return { ...h, online: true, rttMs: Date.now() - t0 };
    } catch (error) {
      return { online: false, error: error.code === 'MACHINE_OFFLINE' ? error.lastError : toEnvelope(error).message, rttMs: Date.now() - t0 };
    }
  }

  async function restart(args) {
    const m = machines.get(args.machine || undefined);
    if (!m.ssh) throw new GatewayError('SSH_NOT_CONFIGURED', `${m.name} has no ssh alias`, 'Add ssh to this machine in machines.json.');
    const before = await health(m);
    if (before.online && !args.confirm) throw new GatewayError('RESTART_CONFIRMATION_REQUIRED', `${m.name} is healthy (pid ${before.pid}, desk-node ${before.version}); pass confirm: true to restart.`, 'Use Machines action=restart with confirm: true only when you intend to restart it.');
    const command = 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/desk-node/current/deploy/service.ps1 restart';
    const result = await sshExec(m.ssh, command, 60000);
    if (!result.ok) throw new GatewayError('SSH_FAILED', `Restart on ${m.name} via ssh ${m.ssh} failed: ${result.detail}`, 'Check SSH access and the node service before retrying.');
    const until = Date.now() + 30000;
    let after;
    do {
      after = await health(m);
      if (after.online && after.pid && (!before.online || after.pid !== before.pid)) break;
      await sleep(1000);
    } while (Date.now() < until);
    if (!after?.online || !after.pid || (before.online && after.pid === before.pid)) throw new GatewayError('RESTART_TIMEOUT', `${m.name} did not report a new PID within 30 s after restart.`, 'Check the node service before retrying.');
    return { content: [{ type: 'text', text: `Restarted ${m.name}: pid ${after.pid}, desk-node ${after.version}` }] };
  }

  const nodeResult = (r) => {
    if (!r.ok) throw new GatewayError(r.error.code, r.error.message, r.error.next);
    return r;
  };

  /** Upload a release from dist/ and run the node's upgrader; waits for its result. */
  async function upgrade(args) {
    const m = machines.get(args.machine || undefined);
    let version = args.version;
    // Default: the version in the repo's packages/node/package.json (what build-release.sh builds).
    version ||= JSON.parse(readFileSync(path.join(distDir, '..', 'packages', 'node', 'package.json'), 'utf8')).version;
    let name = `desk-node-${version}.tar.gz`, file = path.join(distDir, name);
    try { statSync(file); } catch { throw new GatewayError('NOT_FOUND', `No build ${file}`, `Build it: DESK_VERSION=${version} deploy/node/build-release.sh`); }
    const before = await health(m);
    if (!before.online) throw new GatewayError('MACHINE_OFFLINE', `${m.name} is offline (${before.error})`);
    if (before.version === version) return { content: [{ type: 'text', text: `${m.name} already runs desk-node ${version}` }] };
    // Same runtime (node.exe, rg.exe) as the build: send only the app (~3 MB instead of ~37 MB).
    let wanted = null;
    try { wanted = readFileSync(path.join(distDir, `desk-node-${version}`, 'RUNTIME'), 'utf8').trim(); } catch { /* no RUNTIME: full package */ }
    const slim = `desk-node-${version}-app.tar.gz`;
    if (wanted && before.runtime === wanted) {
      try { statSync(path.join(distDir, slim)); name = slim; file = path.join(distDir, slim); } catch { /* full package */ }
    }
    log(`upgrade ${m.name} ${before.version} -> ${version}: ${name === slim ? 'app-only' : 'full'} package (${wanted ?? 'no RUNTIME'}, node has ${before.runtime ?? 'none'})`);
    const t0 = Date.now();
    await uploadFile(`${m.url}/upload/${name}`, { token: machines.token(m), file, sha256: await sha256File(file) });
    const { data: { id } } = nodeResult(await forward('Upgrade', { machine: m.name, action: 'start', package: name, version }));
    let st;
    for (const until = Date.now() + UPGRADE_WAIT_MS; Date.now() < until; await sleep(2000)) {
      // The node is down while it restarts (and longer if it rolls back): keep polling.
      try { st = nodeResult(await forward('Upgrade', { machine: m.name, action: 'status', id })).data; }
      catch (error) { if (error.code !== 'MACHINE_OFFLINE') throw error; continue; }
      if (st.state === 'done') break;
    }
    if (st?.state !== 'done') throw new GatewayError('UPGRADE_TIMEOUT', `Upgrade ${id} on ${m.name} gave no result in ${UPGRADE_WAIT_MS / 1000} s`, `Check C:\\desk-node\\logs\\upgrade.log (Read), or ssh ${m.name}`);
    const after = await health(m);
    const now = after.online ? `now running ${after.version}` : `node offline after upgrade (${after.error})`;
    const text = `Upgrade ${id} on ${m.name}${name === slim ? ' (app-only package)' : ''}: ${st.result} (${st.from} -> ${st.to}, ${st.seconds} s on the node, ${Math.round((Date.now() - t0) / 1000)} s total); ${now}.${st.error ? `\nReason: ${st.error}` : ''}\nLog: C:/desk-node/logs/upgrade.log`;
    return st.result === 'upgraded' && after.version === version ? { content: [{ type: 'text', text }] } : errorResult({ code: st.result === 'rolled_back' ? 'UPGRADE_ROLLED_BACK' : 'UPGRADE_FAILED', message: text });
  }

  async function machinesTool(args) {
    const action = args.action ?? 'list';
    if (action === 'upgrade') return upgrade(args);
    if (action === 'restart') return restart(args);
    if (Object.hasOwn(CHECKPOINT_ACTIONS, action)) {
      const r = await forward('Checkpoint', { machine: args.machine, action: CHECKPOINT_ACTIONS[action], path: args.path, ref: args.ref, confirm: args.confirm });
      return r.ok ? { content: [{ type: 'text', text: r.text }] } : errorResult(r.error);
    }
    if (action !== 'list') throw new GatewayError('BAD_REQUEST', `Unknown Machines action: ${action}`, 'Use list, checkpoint, checkpoints, restore, restart or upgrade');
    const def = machines.defaultName;
    const problem = machines.envProblem();
    const rows = await Promise.all(machines.list().map(async (m) => {
      const mark = m.name === def ? ' (default)' : '';
      const note = m.note ? ` — ${m.note}` : '';
      const dirNote = (dir) => (m.name === machines.envDefault && machines.envDefaultDir !== undefined ? `${dir} (from ${machines.source}${m.defaultDir ? `; machines.json: ${m.defaultDir}` : ''})` : dir);
      if (m.local) return `${m.name}${mark}: this host, ${m.os ?? ''}, dir ${m.defaultDir ?? '~'}; rtt 0 ms; use built-in tools${note}`;
      const [h, o] = await Promise.all([health(m), oob(m)]);
      const ssh = o ? `; ssh ${o.ok ? `ok${o.shell ? ` (${o.shell})` : ''}` : `FAILED (${o.detail})`} ${ago(o.at)}` : '';
      if (!h.online) {
        const seen = machines.lastSeen(m.name);
        return `${m.name}${mark}: OFFLINE (${h.error}); rtt ${h.rttMs} ms; last seen ${seen ? ago(seen) : 'never'}${ssh}${note}`;
      }
      const up = h.uptimeSec < 7200 ? `${Math.round(h.uptimeSec / 60)} min` : `${Math.round(h.uptimeSec / 3600)} h`;
      const deny = h.denyPaths?.length ? `, denyPaths ${h.denyPaths.join(' ')}` : '';
      return `${m.name}${mark}: online, ${h.os}, dir ${dirNote(machines.effectiveDefaultDir(m.name) ?? h.defaultDir)}${deny}, desk-node ${h.version}, up ${up}; rtt ${h.rttMs} ms${ssh}${note}`;
    }));
    return { content: [{ type: 'text', text: [...(problem ? [`CONFIG ERROR: ${problem}`] : []), ...rows].join('\n') }] };
  }

  // Repeat detection: the same Bash/BashJob/Read call returning the same truncated result
  // again gets a short pointer to the earlier call instead of the whole text.
  let callNo = 0;
  const recent = new Map(); // tool+machine+args -> { n, hash }
  const REPEATABLE = new Set(['Bash', 'BashJob', 'Read']);
  function repeatOf(name, machine, args, r, n) {
    if (!REPEATABLE.has(name) || !r.data?.truncated) return null;
    const { description, machine: _m, ...rest } = args;
    const key = JSON.stringify([name, machine, rest]);
    const text = r.data.archive ? (r.text ?? '').replaceAll(r.data.archive, '<archive>') : (r.text ?? '');
    const hash = createHash('sha256').update(text).digest('hex');
    const prev = recent.get(key);
    recent.delete(key);
    recent.set(key, { n, hash });
    if (recent.size > 100) recent.delete(recent.keys().next().value);
    if (prev?.hash !== hash) return null;
    const footer = (r.text ?? '').split('\n').slice(-3).filter((l) => l.startsWith('[desk-node:')).join('\n');
    return `[desk-gateway: same result as call #${prev.n} in this session (${name}, truncated output); not repeated here. Do not run it again for the same output.]\n${footer}`;
  }

  /** MCP tools/call handler; never throws. */
  async function callTool(name, args = {}, { signal } = {}) {
    const t0 = Date.now();
    const n = ++callNo;
    let result, machine = args.machine || '';
    try {
      if (name === 'Copy') result = { content: [{ type: 'text', text: await copy(args, { signal }) }] };
      else if (name === 'Machines') result = await machinesTool(args);
      else if (!NODE_TOOLS.has(name)) throw new GatewayError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
      else {
        machine = machine || machines.defaultName;
        const r = await forward(name, args, signal);
        if (!r.ok) result = errorResult(r.error);
        else {
          const repeat = repeatOf(name, machine, args, r, n);
          const content = [{ type: 'text', text: repeat ?? bound(r.text ?? '') }];
          if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
          result = { content };
        }
      }
    } catch (error) {
      result = errorResult(toEnvelope(error));
    }
    const code = result.isError ? ` code=${JSON.parse(result.content[0].text).code}` : '';
    log(`call #${n} tool=${name} machine=${machine || '-'} ok=${!result.isError}${code}${signal?.aborted ? ' cancelled' : ''} ms=${Date.now() - t0}`);
    return result;
  }

  return { callTool, health };
}
