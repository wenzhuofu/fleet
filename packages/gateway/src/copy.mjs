import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { getFile, putFile } from './client.mjs';
import { GatewayError } from './errors.mjs';
const MiB = 1048576, MAX_UP = 300 * MiB, MAX_DOWN = 50 * MiB, BACKUP_MAX = 200 * MiB;
const BACKUP_DIR = path.join(os.homedir(), '.local/state/desk-fleet/copy-backups');
const hashFile = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256'); createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
function localPath(raw, relative) {
  const p = (raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw).replace(/\\+$/, path.sep);
  if (!path.isAbsolute(p) && !(process.platform === 'win32' && path.win32.isAbsolute(p)) && !relative)
    throw new GatewayError('BAD_PATH', `VPS path must start with / or ~/: ${raw}`, 'For a machine path, prefix its configured name, e.g. pc-home:D:/x');
  return path.resolve(p);
}
export function parseSide(value, machines, { allowRelative = false } = {}) {
  const i = value.indexOf(':'), name = i > 0 ? value.slice(0, i) : '', entries = machines.config().machines;
  if (name === 'vps' || (Object.hasOwn(entries, name) && entries[name].local)) return { local: true, path: localPath(value.slice(i + 1), allowRelative), hint: /[\\/]$/.test(value), label: 'VPS' };
  if (Object.hasOwn(entries, name)) return { local: false, machine: machines.get(name), path: value.slice(i + 1), hint: /[\\/]$/.test(value), label: name };
  return { local: true, path: localPath(value, allowRelative && i < 0), hint: /[\\/]$/.test(value), label: 'VPS' };
}
function blocked(file) {
  const p = path.resolve(file), home = os.homedir();
  const roots = [path.join(home, '.config/desk-fleet'), path.join(home, '.ssh')];
  const inside = (target, root) => { const r = path.relative(root, target); return !r || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
  if (roots.some((root) => inside(p, root))) return true;
  let ancestor = p;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const actual = path.resolve(realpathSync(ancestor), path.relative(ancestor, p));
  return roots.some((root) => inside(actual, root) || existsSync(root) && inside(actual, realpathSync(root)));
}
const baseName = (s) => (s.local ? path : s.machine.os === 'windows' ? path.win32 : path.posix).basename(s.path);
const remoteJoin = (s, name) => (s.machine.os === 'windows' ? path.win32 : path.posix).join(s.path.replace(/\\+$/, '/'), name);
const localTarget = (s, name) => s.hint || (existsSync(s.path) && lstatSync(s.path).isDirectory()) ? path.join(s.path, name) : s.path;
function fileUrl(m, p, sid, backup) {
  const u = new URL('/file', m.url); u.searchParams.set('path', p);
  if (m.defaultDir) u.searchParams.set('defaultDir', m.defaultDir);
  if (sid) u.searchParams.set('sid', sid);
  if (backup !== undefined) u.searchParams.set('backup', backup ? '1' : '0');
  return u;
}
function prune(dir) {
  if (!existsSync(dir)) return;
  const now = Date.now(), files = readdirSync(dir).map((n) => { const f = path.join(dir, n), s = lstatSync(f); return s.isFile() ? { f, size: s.size, time: s.mtimeMs } : null; }).filter(Boolean).sort((a, b) => a.time - b.time);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) if (now - f.time > 259200000 || total > BACKUP_MAX) { unlinkSync(f.f); total -= f.size; }
}
function backupLocal(file, dir) {
  const s = lstatSync(file);
  if (!s.isFile()) throw new GatewayError('IS_DIRECTORY', `Target is not a file: ${file}`);
  if (s.size > BACKUP_MAX) throw new GatewayError('BACKUP_TOO_LARGE', 'Existing file exceeds the 200 MiB backup limit; use --no-backup');
  mkdirSync(dir, { recursive: true }); prune(dir);
  const out = path.join(dir, `${new Date().toISOString().replace(/:/g, '-')}-${randomBytes(4).toString('hex')}-${path.basename(file)}`);
  copyFileSync(file, out); prune(dir); return out;
}
const line = (r, from, to) => `${r.identical ? 'Identical' : 'Copied'} ${r.size.toLocaleString('en-US')} bytes ${from} → ${to}; sha256 ${r.sha.slice(0, 8)}… verified${r.backup ? `; previous version: ${r.backup}` : ''}`;

async function upload(from, to, backup, sid, machines, signal) {
  const s = lstatSync(from.path);
  if (!s.isFile()) throw new GatewayError('NOT_FILE', `Source is not a regular file: ${from.path}`);
  if (s.size > MAX_UP) throw new GatewayError('TOO_LARGE', 'VPS → machine is limited to 300 MiB');
  const sha = await hashFile(from.path), size = lstatSync(from.path).size, name = baseName(from), send = (p) => putFile(fileUrl(to.machine, p, sid, backup), { token: machines.token(to.machine), file: from.path, sha256: sha, signal });
  if (size > MAX_UP) throw new GatewayError('TOO_LARGE', 'VPS → machine is limited to 300 MiB');
  let target = to.hint ? remoteJoin(to, name) : to.path, reply;
  try { reply = await send(target); } catch (e) { if (e.code !== 'IS_DIRECTORY' || to.hint) throw e; target = remoteJoin(to, name); reply = await send(target); }
  if (reply.sha256 !== sha || reply.size !== size) throw new GatewayError('SHA_MISMATCH', '节点返回的大小或 SHA-256 与本机文件不一致');
  return { size, sha, identical: Boolean(reply.identical), backup: reply.backup, path: reply.path ?? target };
}
async function download(from, to, backup, backupDir, machines, signal) {
  const { headers, stream } = await getFile(fileUrl(from.machine, from.path), { token: machines.token(from.machine), signal });
  const size = Number(headers['content-length']), sha = headers['x-sha256']; if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(sha ?? '')) { stream.destroy(); throw new GatewayError('BAD_RESPONSE', '节点返回了无效的文件大小或 SHA-256'); }
  if (size > MAX_DOWN) { stream.destroy(); throw new GatewayError('TOO_LARGE', '机器 → VPS 超过 50 MiB；请在工程机上处理，只把结果传回 VPS'); }
  const target = localTarget(to, baseName(from));
  if (blocked(target)) { stream.destroy(); throw new GatewayError('PATH_BLOCKED', 'VPS Copy cannot access ~/.config/desk-fleet/ or ~/.ssh/'); }
  if (existsSync(target) && lstatSync(target).isFile() && await hashFile(target) === sha) { stream.destroy(); return { size, sha, identical: true, path: target }; }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.desk-${randomBytes(4).toString('hex')}.tmp`), h = createHash('sha256'); let received = 0;
  try {
    await pipeline(stream, new Transform({ transform(c, _e, cb) { received += c.length; h.update(c); cb(null, c); } }), createWriteStream(tmp, { flags: 'wx' }), { signal });
    if (received !== size || h.digest('hex') !== sha) throw new GatewayError('SHA_MISMATCH', '传输期间文件被修改，请重试');
    if (blocked(target)) throw new GatewayError('PATH_BLOCKED', 'VPS Copy cannot access ~/.config/desk-fleet/ or ~/.ssh/');
    const previous = existsSync(target) && backup ? backupLocal(target, backupDir) : undefined;
    renameSync(tmp, target); return { size, sha, identical: false, backup: previous, path: target };
  } catch (e) { if (signal?.aborted) throw new GatewayError('CANCELLED', 'Cancelled by the client'); throw e; }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function createCopy({ machines, sid, log = () => {}, backupDir = BACKUP_DIR }) {
  return async (args, { signal, allowRelative = false } = {}) => {
    const t = Date.now(); let direction = 'unknown';
    try {
      prune(backupDir);
      const from = parseSide(args.from, machines, { allowRelative }), to = parseSide(args.to, machines, { allowRelative });
      if (from.local === to.local) throw new GatewayError('BAD_DIRECTION', from.local ? 'Both paths are on the VPS; use cp' : 'Both paths are remote; copy in two steps via the VPS');
      direction = from.local ? 'VPS->machine' : 'machine->VPS';
      if (from.local && blocked(from.path) || to.local && blocked(to.path)) throw new GatewayError('PATH_BLOCKED', 'VPS Copy cannot access ~/.config/desk-fleet/ or ~/.ssh/');
      const r = from.local ? await upload(from, to, args.backup !== false, sid, machines, signal) : await download(from, to, args.backup !== false, backupDir, machines, signal);
      const src = from.local ? 'VPS' : `${from.label}:${from.path}`, dst = to.local ? `VPS:${r.path}` : `${to.label}:${r.path}`;
      log(`copy direction=${direction} bytes=${r.size} result=${r.identical ? 'identical' : 'copied'} ms=${Date.now() - t}`); return line(r, src, dst);
    } catch (e) { log(`copy direction=${direction} result=error ms=${Date.now() - t}`); throw e; }
  };
}
