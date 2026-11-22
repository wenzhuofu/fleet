// Gateway unit tests against a fake desk-node on localhost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolDefs } from '../src/defs.mjs';
import { createGateway } from '../src/gateway.mjs';
import { Machines } from '../src/machines.mjs';
import { parseShell } from '../src/oob.mjs';

const TOKEN = 'x'.repeat(40);
const tempDirs = new Set();
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function setup(handler, retryWindowMs = 1500, extraMachines = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-gw-'));
  tempDirs.add(dir);
  writeFileSync(path.join(dir, 'token'), TOKEN);
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const file = path.join(dir, 'machines.json');
    writeFileSync(file, JSON.stringify({
      default: 'pc',
      machines: {
        pc: { url: `http://127.0.0.1:${server.address().port}`, tokenFile: path.join(dir, 'token'), os: 'windows', defaultDir: 'D:\\git', ...extraMachines.pc },
        down: { url: 'http://127.0.0.1:1', tokenFile: path.join(dir, 'token'), ...extraMachines.down },
        vps: { local: true, os: 'linux' },
      },
    }));
    const machines = new Machines({ file, stateDir: dir });
    resolve({ dir, server, machines, gateway: createGateway({ machines, sid: 'S1', retryWindowMs }) });
  }));
}

const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString()); };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const errorOf = (r) => { assert.equal(r.isError, true); return JSON.parse(r.content[0].text); };

test('forwards with sid, defaultDir; machine arg is stripped; callId only for mutating calls', async () => {
  const seen = [];
  const { server, gateway } = await setup(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    const body = await readBody(req);
    seen.push(body);
    json(res, 200, { ok: true, text: `ran ${body.tool}` });
  });
  assert.deepEqual(await gateway.callTool('Read', { file_path: 'a.txt', machine: 'pc' }), { content: [{ type: 'text', text: 'ran Read' }] });
  await gateway.callTool('Bash', { command: 'ls' });
  await gateway.callTool('BashJob', { action: 'status', id: 'j' });
  await gateway.callTool('BashJob', { action: 'start', command: 'x' });
  server.closeAllConnections(); server.close();
  const { opId, ...first } = seen[0];
  assert.deepEqual(first, { tool: 'Read', args: { file_path: 'a.txt' }, sid: 'S1', defaultDir: 'D:\\git' });
  assert.match(opId, /^[0-9a-f-]{36}$/);
  assert.match(seen[1].callId, /^[0-9a-f-]{36}$/);
  assert.equal(seen[1].opId, seen[1].callId);
  assert.equal(seen[2].callId, undefined);
  assert.ok(seen[3].callId);
});

test('connection failures are retried with the same callId', async () => {
  const ids = [];
  let n = 0;
  const { server, gateway } = await setup(async (req, res) => {
    const body = await readBody(req);
    ids.push(body.callId);
    if (++n < 3) return req.socket.destroy();
    if (n === 3) return json(res, 502, {});
    json(res, 200, { ok: true, text: 'done' });
  }, 5000);
  const r = await gateway.callTool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' });
  server.closeAllConnections(); server.close();
  assert.equal(r.content[0].text, 'done');
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 1);
});

test('MACHINE_OFFLINE after the retry window, with last-seen time', async () => {
  const { server, gateway, machines, dir } = await setup((req, res) => json(res, 200, { ok: true, text: 'hi' }));
  writeFileSync(path.join(dir, 'last-seen.json'), JSON.stringify({ down: '2026-10-01T00:00:00.000Z' }));
  const t0 = Date.now();
  const e = errorOf(await gateway.callTool('Read', { file_path: 'a', machine: 'down' }));
  assert.ok(Date.now() - t0 >= 1000);
  assert.equal(e.code, 'MACHINE_OFFLINE');
  assert.match(e.message, /last seen 2026-10-01T00:00:00.000Z \(\d+ days ago\)/);
  assert.equal(e.next, 'Run Machines to re-check.');
  assert.doesNotMatch(e.next, /ssh/);
  await gateway.callTool('Read', { file_path: 'a' });
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'last-seen.json'), 'utf8')).pc);
  assert.ok(machines.lastSeen('pc'));
  server.closeAllConnections(); server.close();
});

test('MACHINE_OFFLINE diagnostics distinguish ssh reachable, tailnet unreachable, and no ssh', async () => {
  for (const c of [
    { ssh: 'pc-home', probe: { ok: true, shell: 'Git Bash' }, message: /主机能 ssh，desk-node 不应答/, next: /Machines action=restart.*ssh pc-home.*Git Bash/s },
    { ssh: 'pc-home', probe: { ok: false, detail: 'Connection timed out' }, message: /主机经 tailnet 不可达/, next: /不要循环重试.*不要改用 ssh/ },
    { probe: null, message: /did not answer/, next: /^Run Machines to re-check\.$/ },
  ]) {
    const { server, machines } = await setup((req, res) => json(res, 200, { ok: true }), 0, { down: c.ssh ? { ssh: c.ssh, os: 'windows' } : {} });
    const checks = [];
    const gateway = createGateway({ machines, sid: 'S', retryWindowMs: 0, oob: async (m, options) => { checks.push({ alias: m.ssh, options }); return c.probe; } });
    const e = errorOf(await gateway.callTool('Read', { file_path: 'a', machine: 'down' }));
    server.closeAllConnections(); server.close();
    assert.equal(e.code, 'MACHINE_OFFLINE');
    assert.match(e.message, c.message);
    assert.match(e.next, c.next);
    if (c.ssh) {
      assert.equal(checks[0].alias, 'pc-home');
      assert.equal(checks[0].options.maxAgeMs, 60000);
    } else assert.equal(checks.length, 0);
  }
});

test('Machines restart requires confirmation when healthy and runs the configured ssh alias when offline', async () => {
  let healthyCalls = 0;
  const healthy = await setup((req, res) => json(res, 200, { ok: true, version: '0.6.0', pid: 100 + ++healthyCalls }), 0, { pc: { ssh: 'pc-home' } });
  let called = false;
  const healthyGateway = createGateway({ machines: healthy.machines, sid: 'S', sshExec: async () => { called = true; return { ok: true }; } });
  const refused = errorOf(await healthyGateway.callTool('Machines', { action: 'restart' }));
  assert.equal(refused.code, 'RESTART_CONFIRMATION_REQUIRED');
  assert.equal(called, false);
  const confirmed = await healthyGateway.callTool('Machines', { action: 'restart', confirm: true });
  healthy.server.closeAllConnections(); healthy.server.close();
  assert.equal(called, true);
  assert.match(confirmed.content[0].text, /pid 103, desk-node 0\.6\.0/);

  let healthCalls = 0, executed;
  const offline = await setup((req, res) => {
    if (req.url === '/health' && ++healthCalls === 1) return json(res, 503, {});
    if (req.url === '/health') return json(res, 200, { ok: true, version: '0.6.1', pid: 202 });
    json(res, 200, { ok: true });
  }, 0, { pc: { ssh: 'pc-home' } });
  const gateway = createGateway({ machines: offline.machines, sid: 'S', sshExec: async (...args) => { executed = args; return { ok: true, detail: 'restarted' }; } });
  const result = await gateway.callTool('Machines', { action: 'restart' });
  offline.server.closeAllConnections(); offline.server.close();
  assert.match(result.content[0].text, /pid 202, desk-node 0\.6\.1/);
  assert.deepEqual(executed, ['pc-home', 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/desk-node/current/deploy/service.ps1 restart', 60000]);

  const noSsh = await setup((req, res) => json(res, 200, { ok: true }), 0);
  const noSshGateway = createGateway({ machines: noSsh.machines, sid: 'S' });
  const missing = errorOf(await noSshGateway.callTool('Machines', { action: 'restart' }));
  noSsh.server.closeAllConnections(); noSsh.server.close();
  assert.equal(missing.code, 'SSH_NOT_CONFIGURED');
});

test('errors: node envelope, 401, unknown and local machine', async () => {
  let status = 200;
  const { server, gateway } = await setup(async (req, res) => {
    await readBody(req);
    if (status === 401) return json(res, 401, { ok: false });
    json(res, 200, { ok: false, error: { code: 'STALE_ETAG', message: 'changed', next: 'Read again' } });
  });
  assert.deepEqual(errorOf(await gateway.callTool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })), { code: 'STALE_ETAG', message: 'changed', next: 'Read again' });
  status = 401;
  assert.equal(errorOf(await gateway.callTool('Read', { file_path: 'a' })).code, 'UNAUTHORIZED');
  assert.equal(errorOf(await gateway.callTool('Read', { file_path: 'a', machine: 'nope' })).code, 'UNKNOWN_MACHINE');
  assert.equal(errorOf(await gateway.callTool('Read', { file_path: 'a', machine: 'vps' })).code, 'LOCAL_MACHINE');
  server.closeAllConnections(); server.close();
});

test('images become MCP image content; Machines reports status', async () => {
  const { server, gateway } = await setup(async (req, res) => {
    if (req.url === '/health') return json(res, 200, { ok: true, version: '0.1.0', os: 'Windows_NT', uptimeSec: 60, defaultDir: 'D:\\git' });
    await readBody(req);
    json(res, 200, { ok: true, text: 'Image: a.png', image: { mimeType: 'image/png', data: 'AAAA' } });
  });
  const r = await gateway.callTool('Read', { file_path: 'a.png' });
  assert.deepEqual(r.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
  const m = (await gateway.callTool('Machines', {})).content[0].text;
  assert.match(m, /^pc \(default\): online, Windows_NT, dir D:\\git, desk-node 0.1.0, up 1 min; rtt \d+ ms/m);
  assert.match(m, /^down: OFFLINE.*rtt \d+ ms/m);
  assert.match(m, /^vps: this host.*rtt 0 ms/m);
  server.closeAllConnections(); server.close();
});

test('tool definitions: 9 tools, 7 always loaded, compact', () => {
  const defs = toolDefs('pc-home');
  assert.deepEqual(defs.map((d) => d.name), ['Copy', 'Machines', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashJob']);
  assert.deepEqual(defs.filter((d) => d._meta?.['anthropic/alwaysLoad']).map((d) => d.name), ['Copy', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(defs.filter((d) => !d._meta?.['anthropic/alwaysLoad']).map((d) => d.name), ['Machines', 'BashJob']);
  assert.equal(defs.find((d) => d.name === 'Bash').inputSchema.properties.full.type, 'boolean');
  // ~4 chars per token for this English JSON. The always-loaded tools are sent every turn.
  const size = (list) => JSON.stringify(list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
  assert.ok(size(defs) < 5000, `${size(defs)} chars`);
  const always = defs.filter((d) => d._meta?.['anthropic/alwaysLoad']);
  assert.ok(size(always) < 3400, `${size(always)} always-loaded chars`);
  for (const d of defs) for (const [k, v] of Object.entries(d.inputSchema.properties)) assert.ok(['string', 'integer', 'boolean'].includes(v.type), `${d.name}.${k}`);
  assert.equal(defs.find((d) => d.name === 'Read').inputSchema.properties.offset.type, 'integer');
});

test('stdio MCP: initialize, tools/list, tools/call', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-gw-'));
  tempDirs.add(dir);
  writeFileSync(path.join(dir, 'machines.json'), JSON.stringify({ default: 'vps', machines: { vps: { local: true } } }));
  const main = path.relative(process.cwd(), fileURLToPath(new URL('../src/main.mjs', import.meta.url)));
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, DESK_MACHINES: path.join(dir, 'machines.json'), DESK_STATE_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'Read', arguments: { file_path: 'x' } } });
  send({ id: 4, method: 'nope' });
  for (let i = 0; i < 50 && lines.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
  child.stdin.end();
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(byId[1].result.protocolVersion, '2025-06-18');
  assert.equal(byId[2].result.tools.length, 9);
  assert.equal(JSON.parse(byId[3].result.content[0].text).code, 'LOCAL_MACHINE');
  assert.equal(byId[4].error.code, -32601);
  await new Promise((r) => child.on('exit', r));
  assert.match(readFileSync(path.join(dir, 'gateway.log'), 'utf8'), /sid=sess-1 \(claude session\)/);
});

test('unreachable host fails fast instead of waiting out the retry window', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-gw-'));
  writeFileSync(path.join(dir, 'token'), TOKEN);
  writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ default: 'asleep', machines: { asleep: { url: 'http://10.255.255.1:7801', tokenFile: path.join(dir, 'token') } } }));
  const gateway = createGateway({ machines: new Machines({ file: path.join(dir, 'm.json'), stateDir: dir }), sid: 's', retryWindowMs: 30000 });
  const t0 = Date.now();
  const e = errorOf(await gateway.callTool('Bash', { command: 'x' }));
  assert.equal(e.code, 'MACHINE_OFFLINE');
  assert.match(e.message, /connect timeout/);
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
});

test('Machines checkpoint actions map to the node Checkpoint tool', async () => {
  const seen = [];
  const { server, gateway } = await setup(async (req, res) => {
    const body = await readBody(req);
    seen.push(body);
    json(res, 200, { ok: true, text: `cp ${body.args.action}` });
  });
  assert.equal((await gateway.callTool('Machines', { action: 'checkpoint', path: 'repo' })).content[0].text, 'cp create');
  await gateway.callTool('Machines', { action: 'checkpoints', path: 'repo' });
  await gateway.callTool('Machines', { action: 'restore', path: 'repo', ref: '2', confirm: true });
  server.closeAllConnections(); server.close();
  assert.deepEqual(seen.map((b) => [b.tool, b.args.action, Boolean(b.callId)]), [['Checkpoint', 'create', true], ['Checkpoint', 'list', false], ['Checkpoint', 'restore', true]]);
  assert.deepEqual(seen[2].args, { action: 'restore', path: 'repo', ref: '2', confirm: true });
});

test('Machines upgrade: upload with sha256, start, poll, report rollback as an error', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'desk-repo-')), dist = path.join(repo, 'dist');
  mkdirSync(path.join(repo, 'packages', 'node'), { recursive: true });
  mkdirSync(dist);
  writeFileSync(path.join(repo, 'packages', 'node', 'package.json'), '{"version":"9.9.9"}');
  writeFileSync(path.join(dist, 'desk-node-9.9.9.tar.gz'), 'package bytes');
  let uploaded = null, polls = 0;
  const { server, machines } = await setup(async (req, res) => {
    if (req.url === '/health') return json(res, 200, { ok: true, version: '1.0.0' });
    if (req.method === 'PUT') { const c = []; for await (const x of req) c.push(x); uploaded = { url: req.url, sha: req.headers['x-sha256'], body: Buffer.concat(c).toString() }; return json(res, 200, { ok: true }); }
    const body = await readBody(req);
    if (body.args.action === 'start') return json(res, 200, { ok: true, data: { id: 'u1' } });
    if (++polls < 2) return json(res, 200, { ok: true, data: { state: 'running' } });
    json(res, 200, { ok: true, data: { state: 'done', result: 'rolled_back', from: '1.0.0', to: '9.9.9', seconds: 45, error: 'health check failed' } });
  });
  const gateway = createGateway({ machines, sid: 'S1', distDir: dist });
  const e = errorOf(await gateway.callTool('Machines', { action: 'upgrade' }));
  server.closeAllConnections(); server.close();
  assert.equal(uploaded.url, '/upload/desk-node-9.9.9.tar.gz');
  assert.equal(uploaded.body, 'package bytes');
  assert.equal(uploaded.sha, createHash('sha256').update('package bytes').digest('hex'));
  assert.equal(e.code, 'UPGRADE_ROLLED_BACK');
  assert.match(e.message, /rolled_back \(1.0.0 -> 9.9.9/);
});

test('cancel: an aborted call sends POST /cancel with its opId; the node answers the call', async () => {
  const cancels = [];
  let finish;
  const { server, gateway } = await setup(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/cancel') { cancels.push(body.opId); json(res, 200, { ok: true, cancelled: true }); finish?.(); return; }
    await new Promise((r) => { finish = r; });
    json(res, 200, { ok: true, text: 'x\n[desk-node: cancelled by the caller after 1.0 s; ...]', data: { cancelled: true } });
  });
  const ac = new AbortController();
  const pending = gateway.callTool('Bash', { command: 'sleep 60' }, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  const r = await pending;
  server.closeAllConnections(); server.close();
  assert.equal(cancels.length, 1);
  assert.match(cancels[0], /^[0-9a-f-]{36}$/);
  assert.match(r.content[0].text, /cancelled by the caller/);
});

test('repeat detection: the same truncated result again is replaced by a pointer', async () => {
  let n = 0;
  const { server, gateway } = await setup(async (req, res) => {
    await readBody(req);
    n++;
    const archive = `C:/desk-node/outputs/a${n}.log`;
    json(res, 200, { ok: true, text: `line 1\n… [desk-node: lines 21-500 omitted]\n[desk-node: output has 500 lines, 20.0 KB; full text: ${archive}. No need to re-run]`, data: { truncated: true, archive } });
  });
  const a = await gateway.callTool('Bash', { command: 'git log', description: 'one' });
  const b = await gateway.callTool('Bash', { command: 'git log', description: 'two' });
  const c = await gateway.callTool('Bash', { command: 'git log --stat' });
  server.closeAllConnections(); server.close();
  assert.match(a.content[0].text, /^line 1/);
  assert.match(b.content[0].text, /same result as call #1/);
  assert.match(b.content[0].text, /a2\.log/);
  assert.doesNotMatch(b.content[0].text, /^line 1/);
  assert.match(c.content[0].text, /^line 1/);
});

test('stdio MCP: notifications/cancelled aborts the call and suppresses its response; stdin close cancels the rest', async () => {
  const { serveStdio } = await import('../src/mcp.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(), output = new PassThrough();
  const aborted = [];
  const lines = [];
  output.on('data', (c) => lines.push(...c.toString().split('\n').filter(Boolean)));
  const done = serveStdio({ name: 't', version: '0', tools: () => [], input, output, closeGraceMs: 1000,
    callTool: (name, _a, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted.push(name); resolve({ content: [] }); })) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'A' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'B' } }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user' } }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(aborted, ['A']);
  input.end();
  await done;
  assert.deepEqual(aborted, ['A', 'B']);
  assert.deepEqual(lines, []);
});

test('out-of-band check: caches for 30 min, refreshes after 60 s on offline checks, and shows shell', async () => {
  const { createOobCheck } = await import('../src/oob.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-oob-'));
  tempDirs.add(dir);
  let runs = 0;
  const oob = createOobCheck({ stateDir: dir, run: async (alias) => { runs++; return { ok: alias === 'good', detail: alias === 'good' ? 'Fu' : 'Connection timed out' }; } });
  assert.equal(await oob({ name: 'x' }), null);
  assert.equal((await oob({ name: 'pc', ssh: 'good' })).ok, true);
  assert.equal((await oob({ name: 'pc', ssh: 'good' })).ok, true);
  assert.equal(runs, 1);
  const old = JSON.parse(readFileSync(path.join(dir, 'oob.json'), 'utf8'));
  old.pc.at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  writeFileSync(path.join(dir, 'oob.json'), JSON.stringify(old));
  await oob({ name: 'pc', ssh: 'good' });
  assert.equal(runs, 2);
  old.pc.at = new Date(Date.now() - 61000).toISOString();
  writeFileSync(path.join(dir, 'oob.json'), JSON.stringify(old));
  await oob({ name: 'pc', ssh: 'good' }, { maxAgeMs: 60000 });
  assert.equal(runs, 3);
  const { server, machines } = await setup((req, res) => json(res, 200, { ok: true, machineId: 'pc', version: '9', os: 'Windows', uptimeSec: 60, pid: 7 }));
  const gw = createGateway({ machines, sid: 'S', oob: async (m) => (m.name === 'pc' ? { at: new Date().toISOString(), ok: true, shell: 'Git Bash', detail: 'bash', rttMs: 4 } : null) });
  const r = await gw.callTool('Machines', {});
  server.closeAllConnections(); server.close();
  assert.match(r.content[0].text, /pc \(default\): online.*rtt \d+ ms; ssh ok \(Git Bash\) \d+ s ago/);
});

test('out-of-band shell parser identifies Git Bash, cmd, and PowerShell', () => {
  assert.equal(parseShell('bash %OS%', 'windows'), 'Git Bash');
  assert.equal(parseShell('bash %OS%', 'linux'), 'bash');
  assert.equal(parseShell('$0 Windows_NT', 'windows'), 'cmd');
  assert.equal(parseShell('$0 %OS%', 'windows'), 'powershell');
});

test('Machines upgrade: app-only package when the node already has the build\'s runtime, full otherwise', async () => {
  for (const [nodeRuntime, expected] of [['node-v24-win-x64_rg-1', '/upload/desk-node-9.9.9-app.tar.gz'], ['node-v22-win-x64_rg-1', '/upload/desk-node-9.9.9.tar.gz'], [undefined, '/upload/desk-node-9.9.9.tar.gz']]) {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'desk-repo-')), dist = path.join(repo, 'dist');
    tempDirs.add(repo);
    mkdirSync(path.join(repo, 'packages', 'node'), { recursive: true });
    mkdirSync(path.join(dist, 'desk-node-9.9.9'), { recursive: true });
    writeFileSync(path.join(repo, 'packages', 'node', 'package.json'), '{"version":"9.9.9"}');
    writeFileSync(path.join(dist, 'desk-node-9.9.9', 'RUNTIME'), 'node-v24-win-x64_rg-1\n');
    writeFileSync(path.join(dist, 'desk-node-9.9.9.tar.gz'), 'full');
    writeFileSync(path.join(dist, 'desk-node-9.9.9-app.tar.gz'), 'app');
    let uploaded = null, startArgs = null;
    const { server, machines } = await setup(async (req, res) => {
      if (req.url === '/health') return json(res, 200, { ok: true, version: '1.0.0', runtime: nodeRuntime });
      if (req.method === 'PUT') { for await (const x of req); uploaded = req.url; return json(res, 200, { ok: true }); }
      const body = await readBody(req);
      if (body.args.action === 'start') { startArgs = body.args; return json(res, 200, { ok: true, data: { id: 'u1' } }); }
      json(res, 200, { ok: true, data: { state: 'done', result: 'upgraded', from: '1.0.0', to: '9.9.9', seconds: 12 } });
    });
    const gateway = createGateway({ machines, sid: 'S1', distDir: dist });
    await gateway.callTool('Machines', { action: 'upgrade' });
    server.closeAllConnections(); server.close();
    assert.equal(uploaded, expected, `node runtime ${nodeRuntime}`);
    assert.equal(startArgs.package, expected.split('/').pop());
  }
});
