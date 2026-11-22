import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { uploadFile } from '../src/client.mjs';
import { createCopy, parseSide } from '../src/copy.mjs';
import { toolDefs } from '../src/defs.mjs';
import { createGateway } from '../src/gateway.mjs';
import { Machines } from '../src/machines.mjs';

const TOKEN = 'x'.repeat(40), sha = (b) => createHash('sha256').update(b).digest('hex');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-copy-')), tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, TOKEN);
  const files = new Map(), mode = { directories: new Set(), notFound: false, badHash: false, oversize: false, slow: false, putReply: '', getTruncatedError: false, puts: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), name = url.searchParams.get('path');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
    if (mode.notFound) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Use POST /rpc or GET /health' } });
    if (req.method === 'GET') {
      if (mode.getTruncatedError) { res.writeHead(404, { 'content-length': 100 }); res.write('{'); setTimeout(() => res.destroy(), 30); return; }
      if (mode.oversize) { res.writeHead(200, { 'content-length': 51 * 1048576, 'x-sha256': 'a'.repeat(64) }); res.flushHeaders(); return; }
      const body = files.get(name);
      if (!body) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'file missing' } });
      const headers = { 'content-length': body.length, 'x-sha256': mode.badHash ? '0'.repeat(64) : sha(body), 'content-type': 'application/octet-stream' };
      res.writeHead(200, headers);
      if (mode.slow) {
        res.write(Buffer.alloc(1024));
        const timer = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(1024)); }, 20);
        res.on('close', () => clearInterval(timer)); return;
      }
      return res.end(body);
    }
    if (req.method === 'PUT') {
      mode.puts++;
      if (mode.putReply) { res.writeHead(200, { 'content-length': 100 }); res.write('{'); if (mode.putReply === 'cut') setTimeout(() => res.destroy(), 30); return; }
      if (mode.directories.has(name)) return json(res, 400, { error: { code: 'IS_DIRECTORY', message: 'target is a directory' } });
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), digest = sha(body);
      if (digest !== req.headers['x-sha256']) return json(res, 400, { error: { code: 'SHA_MISMATCH', message: 'hash mismatch' } });
      const old = files.get(name);
      if (old && old.equals(body)) return json(res, 200, { ok: true, identical: true, path: name, size: body.length, sha256: digest });
      files.set(name, body);
      return json(res, 200, { ok: true, path: name, size: body.length, sha256: digest, ...(old && url.searchParams.get('backup') !== '0' ? { backup: 'C:/desk-node/outputs/copy-backups/old.bin' } : {}) });
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'route missing' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const machinesFile = path.join(dir, 'machines.json');
  writeFileSync(machinesFile, JSON.stringify({ default: 'pc-home', machines: {
    'pc-home': { url: `http://127.0.0.1:${server.address().port}`, tokenFile, os: 'windows', defaultDir: 'D:\\work' },
    vps: { local: true, os: 'linux' },
  } }));
  const machines = new Machines({ file: machinesFile, stateDir: dir }), backupDir = path.join(dir, 'backups');
  const logs = [], copy = createCopy({ machines, sid: 'S1', backupDir, log: (line) => logs.push(line) });
  const gateway = createGateway({ machines, sid: 'S1', retryWindowMs: 500, log: (line) => logs.push(line) });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, server, files, mode, machines, machinesFile, backupDir, logs, copy, gateway };
}

test('path parsing: machine absolute/relative, VPS absolute/home and vps alias', async (t) => {
  const { machines } = await setup(t);
  assert.equal(parseSide('pc-home:D:/x', machines).path, 'D:/x');
  assert.equal(parseSide('pc-home:relative/x', machines).path, 'relative/x');
  assert.equal(parseSide('/abs/x', machines).local, true);
  assert.equal(parseSide('~/x', machines).path, path.join(os.homedir(), 'x'));
  assert.equal(parseSide('vps:/x', machines).local, true);
  assert.throws(() => parseSide('unknown:/x', machines), { code: 'BAD_PATH' });
  assert.equal(parseSide('relative/x', machines, { allowRelative: true }).local, true);
  assert.throws(() => parseSide('unknown:/x', machines, { allowRelative: true }), { code: 'BAD_PATH' });
  if (process.platform !== 'win32') assert.throws(() => parseSide('D:/x', machines), { code: 'BAD_PATH' });
});

test('Copy definition is always loaded and has no machine selector', () => {
  const def = toolDefs('pc-home').find((item) => item.name === 'Copy');
  assert.ok(def); assert.equal(def._meta['anthropic/alwaysLoad'], true);
  assert.deepEqual(def.inputSchema.required, ['from', 'to']);
  assert.equal('machine' in def.inputSchema.properties, false);
  assert.ok(def.description.length <= 450);
});

test('Copy routes a local file through the fixed PUT contract and logs no paths', async (t) => {
  const { dir, files, gateway, logs } = await setup(t), source = path.join(dir, 'source.bin');
  writeFileSync(source, 'hello copy');
  const result = await gateway.callTool('Copy', { from: source, to: 'pc-home:D:/out.bin' });
  assert.match(result.content[0].text, /^Copied 10 bytes VPS → pc-home:D:\/out\.bin; sha256 [0-9a-f]{8}… verified$/);
  assert.equal(files.get('D:/out.bin').toString(), 'hello copy');
  assert.match(logs[0], /^copy direction=VPS->machine bytes=10 result=copied ms=\d+$/);
  assert.doesNotMatch(logs[0], /out\.bin|source\.bin/);
});

test('machine directory target preserves the source filename; remote identical copy skips', async (t) => {
  const { dir, files, mode, copy } = await setup(t), source = path.join(dir, 'report.txt');
  writeFileSync(source, 'report'); mode.directories.add('D:/reports');
  const first = await copy({ from: source, to: 'pc-home:D:/reports' });
  assert.equal(files.get('D:\\reports\\report.txt').toString(), 'report');
  assert.match(first, /Copied 6 bytes/);
  assert.match(await copy({ from: source, to: 'pc-home:D:/reports/' }), /^Identical 6 bytes/);
});

test('machine overwrite reports its backup; every Copy prunes expired VPS backups', async (t) => {
  const { dir, files, copy, backupDir } = await setup(t), source = path.join(dir, 'new.txt');
  writeFileSync(source, 'new'); files.set('D:/existing.txt', Buffer.from('old'));
  assert.match(await copy({ from: source, to: 'pc-home:D:/existing.txt' }), /previous version: C:\/desk-node\/outputs\/copy-backups/);
  assert.equal(files.get('D:/existing.txt').toString(), 'new');
  mkdirSync(backupDir); const expired = path.join(backupDir, 'expired.bin'); writeFileSync(expired, 'old');
  const old = new Date(Date.now() - 4 * 86400000); utimesSync(expired, old, old);
  await assert.rejects(copy({ from: source, to: path.join(dir, 'local.txt') }), { code: 'BAD_DIRECTION' });
  assert.equal(existsSync(expired), false);
});

test('machine download writes a temp file, backs up a changed target and skips identical bytes', async (t) => {
  const { dir, files, copy, backupDir } = await setup(t), target = path.join(dir, 'result.bin');
  files.set('D:/result.bin', Buffer.from('new version')); writeFileSync(target, 'old version');
  const first = await copy({ from: 'pc-home:D:/result.bin', to: target });
  assert.equal(readFileSync(target, 'utf8'), 'new version');
  assert.match(first, /previous version:/);
  const backups = readdirSync(backupDir); assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(backupDir, backups[0]), 'utf8'), 'old version');
  assert.match(await copy({ from: 'pc-home:D:/result.bin', to: target }), /^Identical 11 bytes/);
  assert.equal(readdirSync(backupDir).length, 1);
});

test('machine download to a directory preserves the filename; bad hash leaves original intact and removes temp', async (t) => {
  const { dir, files, mode, copy } = await setup(t), out = path.join(dir, 'out');
  mkdirSync(out); files.set('D:/note.txt', Buffer.from('note'));
  await copy({ from: 'pc-home:D:/note.txt', to: `${out}${path.sep}` });
  assert.equal(readFileSync(path.join(out, 'note.txt'), 'utf8'), 'note');
  const target = path.join(dir, 'keep.bin'); writeFileSync(target, 'keep'); mode.badHash = true;
  await assert.rejects(copy({ from: 'pc-home:D:/note.txt', to: target }), { code: 'SHA_MISMATCH' });
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('Copy rejects both-local, both-remote and protected VPS paths', async (t) => {
  const { dir, copy } = await setup(t), ssh = path.join(os.homedir(), '.ssh', 'id_ed25519');
  const config = path.join(os.homedir(), '.config', 'desk-fleet', 'token');
  await assert.rejects(copy({ from: path.join(dir, 'a'), to: path.join(dir, 'b') }), { code: 'BAD_DIRECTION' });
  await assert.rejects(copy({ from: 'pc-home:a', to: 'pc-home:b' }), { code: 'BAD_DIRECTION' });
  await assert.rejects(copy({ from: ssh, to: 'pc-home:D:/x' }), { code: 'PATH_BLOCKED' });
  await assert.rejects(copy({ from: 'pc-home:D:/x', to: path.join(os.homedir(), '.ssh', 'copy') }), { code: 'PATH_BLOCKED' });
  await assert.rejects(copy({ from: config, to: 'pc-home:D:/x' }), { code: 'PATH_BLOCKED' });
  await assert.rejects(copy({ from: 'pc-home:D:/x', to: config }), { code: 'PATH_BLOCKED' });
});

test('Copy protects real paths through directory links for both sources and nonexistent targets', async (t) => {
  const { dir, files, mode, copy } = await setup(t);
  const home = path.join(dir, 'fake-home'), ssh = path.join(home, '.ssh'), alias = path.join(dir, 'alias');
  const normal = path.join(dir, 'normal'), key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME', old = process.env[key];
  mkdirSync(ssh, { recursive: true }); mkdirSync(normal);
  writeFileSync(path.join(ssh, 'fixture.txt'), 'synthetic-only');
  writeFileSync(path.join(normal, 'fixture.txt'), 'normal');
  symlinkSync(ssh, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env[key] = home;
  try {
    assert.equal(os.homedir(), home);
    await assert.rejects(copy({ from: path.join(ssh, 'fixture.txt'), to: 'pc-home:D:/bad' }), { code: 'PATH_BLOCKED' });
    await assert.rejects(copy({ from: path.join(alias, 'fixture.txt'), to: 'pc-home:D:/bad' }), { code: 'PATH_BLOCKED' });
    assert.equal(mode.puts, 0);
    files.set('D:/remote.txt', Buffer.from('remote'));
    await assert.rejects(copy({ from: 'pc-home:D:/remote.txt', to: path.join(ssh, 'new.txt') }), { code: 'PATH_BLOCKED' });
    await assert.rejects(copy({ from: 'pc-home:D:/remote.txt', to: path.join(alias, 'new.txt') }), { code: 'PATH_BLOCKED' });
    assert.equal(existsSync(path.join(ssh, 'new.txt')), false);
    assert.equal(readFileSync(path.join(ssh, 'fixture.txt'), 'utf8'), 'synthetic-only');
    await copy({ from: path.join(normal, 'fixture.txt'), to: 'pc-home:D:/safe' });
    assert.equal(files.get('D:/safe').toString(), 'normal');
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});

test('PUT response truncation, post-header cancellation, and GET error truncation settle promptly', async (t) => {
  const { dir, mode, copy, machines } = await setup(t), source = path.join(dir, 'source.txt');
  writeFileSync(source, 'safe data');
  const within = async (promise) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request remained pending')), 800); })]); }
    finally { clearTimeout(timer); }
  };
  mode.putReply = 'cut';
  await assert.rejects(within(copy({ from: source, to: 'pc-home:D:/cut' })), { code: 'FILE_UPLOAD_FAILED' });
  const m = machines.get('pc-home');
  await assert.rejects(within(uploadFile(`${m.url}/file`, { token: machines.token(m), file: source, sha256: sha(Buffer.from('safe data')) })), { code: 'UPLOAD_FAILED' });
  mode.putReply = 'hang';
  const controller = new AbortController();
  const pending = within(copy({ from: source, to: 'pc-home:D:/cancel' }, { signal: controller.signal }));
  await new Promise((resolve) => setTimeout(resolve, 80)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  mode.putReply = '';
  mode.getTruncatedError = true;
  const target = path.join(dir, 'not-written.txt');
  await assert.rejects(within(copy({ from: 'pc-home:D:/missing', to: target })), { code: 'FILE_DOWNLOAD_FAILED' });
  assert.equal(existsSync(target), false);
});

test('machine-to-VPS rejects 51 MiB before creating a destination', async (t) => {
  const { dir, mode, copy } = await setup(t), target = path.join(dir, 'large.bin'); mode.oversize = true;
  await assert.rejects(copy({ from: 'pc-home:D:/large.bin', to: target }), { code: 'TOO_LARGE', message: /工程机上处理/ });
  assert.equal(readdirSync(dir).includes('large.bin'), false);
});

test('old desk-node 404 explains that Copy requires an upgrade', async (t) => {
  const { dir, mode, copy } = await setup(t), source = path.join(dir, 'source');
  writeFileSync(source, 'x'); mode.notFound = true;
  await assert.rejects(copy({ from: source, to: 'pc-home:D:/x' }), { code: 'COPY_UNSUPPORTED', message: /升级/ });
  await assert.rejects(copy({ from: 'pc-home:D:/x', to: path.join(dir, 'download') }), { code: 'COPY_UNSUPPORTED', message: /升级/ });
});

test('new desk-node missing files preserve NOT_FOUND instead of suggesting an upgrade', async (t) => {
  const { dir, copy } = await setup(t), target = path.join(dir, 'missing.bin');
  await assert.rejects(copy({ from: 'pc-home:D:/missing.bin', to: target }), { code: 'NOT_FOUND', message: /file missing/ });
});

test('aborting a download removes the partial temp file', async (t) => {
  const { dir, files, mode, copy } = await setup(t), controller = new AbortController(), target = path.join(dir, 'partial.bin');
  mode.slow = true; files.set('D:/slow.bin', Buffer.alloc(1048576));
  const pending = copy({ from: 'pc-home:D:/slow.bin', to: target }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 80)); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(readdirSync(dir).some((n) => n.endsWith('.tmp')), false);
  assert.equal(readdirSync(dir).includes('partial.bin'), false);
});

test('desk-copy CLI returns zero on success, honors --no-backup and returns one on usage error', async (t) => {
  const { dir, machinesFile, files } = await setup(t), source = path.join(dir, 'cli.txt');
  writeFileSync(source, 'cli');
  const cli = fileURLToPath(new URL('../src/copy-cli.mjs', import.meta.url)), env = { ...process.env, DESK_MACHINES: machinesFile, DESK_STATE_DIR: path.join(dir, 'cli-state') };
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env }); let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const ok = await run([source, 'pc-home:D:/cli.txt']);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /^Copied 3 bytes/);
  files.set('D:/cli-no-backup.txt', Buffer.from('old'));
  const noBackup = await run([source, 'pc-home:D:/cli-no-backup.txt', '--no-backup']);
  assert.equal(noBackup.status, 0, noBackup.stderr); assert.doesNotMatch(noBackup.stdout, /previous version:/);
  assert.equal(files.get('D:/cli-no-backup.txt').toString(), 'cli');
  const bad = await run([]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage: desk-copy/);
});
