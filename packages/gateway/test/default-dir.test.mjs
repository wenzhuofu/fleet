// A session's binding (.desk.json, or DESK_DEFAULT_MACHINE + DESK_DEFAULT_DIR) ties one machine to a directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.mjs';
import { Machines, validDefaultDir } from '../src/machines.mjs';

const TOKEN = 'x'.repeat(40);
const tempDirs = new Set();
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString()); };
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const errorOf = (r) => { assert.equal(r.isError, true); return JSON.parse(r.content[0].text); };

/** Two machines (pc, pc2) served by one fake node that records every /rpc body. */
async function setup(env = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/health') return json(res, { ok: true, version: '0.5.7', os: 'Windows_NT', uptimeSec: 60, defaultDir: 'D:\\node-default' });
    seen.push(await readBody(req));
    json(res, { ok: true, text: 'done' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-gw-dd-'));
  tempDirs.add(dir);
  writeFileSync(path.join(dir, 'token'), TOKEN);
  const url = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(dir, 'machines.json');
  writeFileSync(file, JSON.stringify({
    default: 'pc',
    machines: {
      pc: { url, tokenFile: path.join(dir, 'token'), os: 'windows', defaultDir: 'D:\\git' },
      pc2: { url, tokenFile: path.join(dir, 'token'), os: 'windows', defaultDir: 'D:\\two' },
      vps: { local: true, os: 'linux', defaultDir: '/home/agent/fleet' },
    },
  }));
  const machines = new Machines({ file, stateDir: dir, defaultMachine: env.machine, defaultDir: env.dir });
  const gateway = createGateway({ machines, sid: 'S1', retryWindowMs: 500 });
  return { seen, machines, gateway, dir, close: () => { server.closeAllConnections(); server.close(); } };
}

test('not set: unchanged behaviour, machines.json defaultDir is forwarded', async () => {
  const t = await setup();
  await t.gateway.callTool('Bash', { command: 'pwd' });
  await t.gateway.callTool('Bash', { command: 'pwd', machine: 'pc2' });
  assert.deepEqual(t.seen.map((b) => b.defaultDir), ['D:\\git', 'D:\\two']);
  assert.equal(t.machines.envProblem(), null);
  t.close();
});

test('machine + dir: overrides only the bound machine, whether implicit or explicit', async () => {
  const t = await setup({ machine: 'pc2', dir: 'D:\\fleet-sandbox\\x' });
  await t.gateway.callTool('Read', { file_path: 'a.txt' }); // implicit: the bound default machine
  await t.gateway.callTool('Read', { file_path: 'a.txt', machine: 'pc2' });
  await t.gateway.callTool('Read', { file_path: 'a.txt', machine: 'pc' }); // another machine keeps its own dir
  assert.deepEqual(t.seen.map((b) => b.defaultDir), ['D:\\fleet-sandbox\\x', 'D:\\fleet-sandbox\\x', 'D:\\git']);
  t.close();
});

test('retries of a mutating call keep one callId and the overridden dir', async () => {
  const t = await setup({ machine: 'pc', dir: 'D:/work/a' });
  await t.gateway.callTool('Write', { file_path: 'a.txt', content: 'x' });
  assert.equal(t.seen[0].defaultDir, 'D:/work/a');
  assert.ok(t.seen[0].callId);
  t.close();
});

test('dir without machine fails closed for every remote machine', async () => {
  const t = await setup({ dir: 'D:\\x' });
  for (const machine of [undefined, 'pc', 'pc2']) {
    const e = errorOf(await t.gateway.callTool('Read', { file_path: 'a', machine }));
    assert.equal(e.code, 'BAD_CONFIG');
    assert.match(e.message, /a directory is set without a machine/);
  }
  assert.equal(t.seen.length, 0);
  t.close();
});

test('invalid dir fails closed for the bound machine only; no fallback to machines.json', async () => {
  for (const dir of ['', 'relative\\path', '\\\\server\\share', 'D:x', '/rooted/no/drive', 'D:\\a\u0000b', 'C'.repeat(300)]) {
    const t = await setup({ machine: 'pc', dir });
    const e = errorOf(await t.gateway.callTool('Bash', { command: 'pwd' }));
    assert.equal(e.code, 'BAD_CONFIG', JSON.stringify(dir));
    assert.equal(errorOf(await t.gateway.callTool('Bash', { command: 'pwd', machine: 'pc' })).code, 'BAD_CONFIG');
    await t.gateway.callTool('Bash', { command: 'pwd', machine: 'pc2' }); // the other machine is unaffected
    assert.deepEqual(t.seen.map((b) => b.defaultDir), ['D:\\two']);
    t.close();
  }
});

test('unknown or local bound machine: error, never the machines.json default', async () => {
  let t = await setup({ machine: 'ghost', dir: 'D:\\x' });
  assert.equal(errorOf(await t.gateway.callTool('Read', { file_path: 'a' })).code, 'UNKNOWN_MACHINE');
  assert.equal(t.seen.length, 0);
  t.close();
  t = await setup({ machine: 'ghost' }); // machine alone, unknown
  assert.equal(errorOf(await t.gateway.callTool('Read', { file_path: 'a' })).code, 'UNKNOWN_MACHINE');
  t.close();
  t = await setup({ machine: 'vps', dir: '/home/agent' });
  assert.equal(errorOf(await t.gateway.callTool('Read', { file_path: 'a' })).code, 'LOCAL_MACHINE');
  assert.match(t.machines.envProblem(), /this host/);
  t.close();
});

test('Machines output marks the override and lists configuration errors', async () => {
  let t = await setup({ machine: 'pc2', dir: 'D:\\fleet-sandbox\\x' });
  let text = (await t.gateway.callTool('Machines', {})).content[0].text;
  assert.match(text, /^pc2 \(default\): online, Windows_NT, dir D:\\fleet-sandbox\\x \(from DESK_DEFAULT_MACHINE\/DESK_DEFAULT_DIR; machines.json: D:\\two\)/m);
  assert.match(text, /^pc: online, Windows_NT, dir D:\\git,/m);
  assert.doesNotMatch(text, /CONFIG ERROR/);
  t.close();
  t = await setup({ machine: 'pc', dir: 'nope' });
  text = (await t.gateway.callTool('Machines', {})).content[0].text;
  assert.match(text, /^CONFIG ERROR: DESK_DEFAULT_MACHINE\/DESK_DEFAULT_DIR: dir is not an absolute path on pc/);
  t.close();
});

test('validDefaultDir accepts what desk-node resolves and rejects the rest', () => {
  for (const ok of ['D:\\a', 'd:/a/b', 'D:\\', 'D:', '/d/git/x', '/d']) assert.equal(validDefaultDir(ok, 'windows'), true, ok);
  for (const bad of ['', 'a\\b', '\\\\h\\s', '//h/s', 'D:x', '/tmp/x', 'D:\\a\nb', undefined, 5]) assert.equal(validDefaultDir(bad, 'windows'), false, String(bad));
  assert.equal(validDefaultDir('/srv/x', 'linux'), true);
  assert.equal(validDefaultDir('D:\\x', 'linux'), false);
});

test('stdio gateway process: log shows the binding; a bad binding is reported at startup and on calls', async () => {
  const t = await setup({});
  const run = async (env) => {
    const main = path.relative(process.cwd(), fileURLToPath(new URL('../src/main.mjs', import.meta.url)));
    const child = spawn(process.execPath, [main], {
      env: { ...process.env, DESK_MACHINES: path.join(t.dir, 'machines.json'), DESK_STATE_DIR: t.dir, CLAUDE_CODE_SESSION_ID: 'sess-dd', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = [];
    child.stdout.setEncoding('utf8').on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'Read', arguments: { file_path: 'x' } } });
    for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    return lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  };
  const good = await run({ DESK_DEFAULT_MACHINE: 'pc2', DESK_DEFAULT_DIR: 'D:\\sandbox' });
  assert.notEqual(good.result.isError, true); // reached the fake node
  assert.equal(good.result.content[0].text, 'done');
  const bad = await run({ DESK_DEFAULT_MACHINE: 'pc2', DESK_DEFAULT_DIR: 'oops' });
  assert.equal(JSON.parse(bad.result.content[0].text).code, 'BAD_CONFIG');
  const log = readFileSync(path.join(t.dir, 'gateway.log'), 'utf8');
  assert.match(log, /default machine=pc2 dir=D:\\sandbox \(DESK_DEFAULT_MACHINE\/DESK_DEFAULT_DIR\)/);
  assert.match(log, /default machine=pc2 dir=oops \(DESK_DEFAULT_MACHINE\/DESK_DEFAULT_DIR\) CONFIG ERROR: DESK_DEFAULT_MACHINE\/DESK_DEFAULT_DIR: dir is not an absolute path/);
  assert.equal(t.seen.at(-1).defaultDir, 'D:\\sandbox');
  t.close();
});
