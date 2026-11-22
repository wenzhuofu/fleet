// HTTP RPC: POST /rpc {tool, args, callId?, sid?}; GET /health. Bearer token on every request.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { fingerprint } from './calls.mjs';
import { DeskError, toErrorEnvelope } from './errors.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_UPLOAD = 300 * 1024 * 1024;
const fileStatus = (code) => ({ BAD_REQUEST: 400, BAD_PATH: 400, IS_DIRECTORY: 400, SHA_MISMATCH: 400, PATH_BLOCKED: 403, PATH_DENIED: 403, ACCESS_DENIED: 403, NOT_FOUND: 404, TOO_LARGE: 413, FILE_LOCKED: 423, FILE_BUSY: 423 })[code] ?? 500;

export function createRpcServer({ token, tools, calls, config, version, runtime = null, log, incomingDir }) {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const send = (res, status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  };
  const started = Date.now();
  const running = new Map(); // opId -> AbortController of a call in progress
  const earlyCancels = new Map(); // opId -> time: a cancel that arrived before its call
  const rememberCancel = (opId) => {
    const now = Date.now();
    for (const [k, t] of earlyCancels) if (now - t > 60000) earlyCancels.delete(k);
    if (earlyCancels.size < 1000) earlyCancels.set(opId, now);
  };
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('too large'); chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
  };

  const server = createServer(async (req, res) => {
    if (!authorized(req)) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' } });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        machineId: config.machineId,
        version,
        runtime,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        hostname: os.hostname(),
        uptimeSec: Math.round((Date.now() - started) / 1000),
        defaultDir: config.defaultDir,
        denyPaths: config.denyPaths ?? [],
        node: process.version,
        pid: process.pid,
        tools: tools.names,
      });
    }
    if (url.pathname === '/file' && (req.method === 'PUT' || req.method === 'GET')) {
      const t0 = Date.now(); let size = 0;
      try {
        if (req.method === 'PUT') {
          const b = url.searchParams.get('backup');
          if (b !== '0' && b !== '1') throw new DeskError('BAD_REQUEST', 'backup must be 1 or 0');
          const result = await tools.transfer.upload(req, { path: url.searchParams.get('path'), defaultDir: url.searchParams.get('defaultDir') ?? undefined, sid: url.searchParams.get('sid') ?? 'default', backup: b !== '0' });
          size = result.size;
          log(`file PUT ${size} bytes ok ms=${Date.now() - t0}`);
          return send(res, 200, { ok: true, ...result });
        }
        const file = await tools.transfer.download({ path: url.searchParams.get('path'), defaultDir: url.searchParams.get('defaultDir') ?? undefined });
        size = file.size;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'x-sha256': file.sha256 });
        await pipeline(file.stream, res);
        log(`file GET ${size} bytes ok ms=${Date.now() - t0}`);
        return;
      } catch (error) {
        const failure = toErrorEnvelope(error);
        log(`file ${req.method} ${size || Number(req.headers['content-length'] ?? 0)} bytes ${failure.code} ms=${Date.now() - t0}`);
        if (res.headersSent) { res.destroy(error); return; }
        req.resume();
        return send(res, fileStatus(failure.code), { ok: false, error: failure });
      }
    }
    // PUT /upload/<desk-node-x.tar.gz> with x-sha256: release packages for the Upgrade tool.
    const upload = /^\/upload\/(desk-node-[\w.+-]+\.tar\.gz)$/.exec(url.pathname);
    if (req.method === 'PUT' && upload) {
      const expectedSha = String(req.headers['x-sha256'] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedSha)) return send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'x-sha256 header required' } });
      await mkdir(incomingDir, { recursive: true });
      const final = path.join(incomingDir, upload[1]), part = `${final}.${randomUUID().slice(0, 8)}.part`;
      const hash = createHash('sha256');
      let size = 0;
      try {
        await pipeline(req, async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > MAX_UPLOAD) throw new Error('upload exceeds 300 MiB');
            hash.update(chunk);
            yield chunk;
          }
        }, createWriteStream(part, { mode: 0o600 }));
        const got = hash.digest('hex');
        if (got !== expectedSha) throw new Error(`sha256 mismatch (got ${got})`);
        await rename(part, final);
      } catch (error) {
        await rm(part, { force: true });
        return send(res, 400, { ok: false, error: { code: 'UPLOAD_FAILED', message: error.message } });
      }
      log(`upload ${upload[1]} ${size} bytes`);
      return send(res, 200, { ok: true, path: final, size });
    }
    // POST /cancel {opId}: abort that call if it is still running (else ignored).
    if (req.method === 'POST' && url.pathname === '/cancel') {
      let opId;
      try { opId = JSON.parse(await readBody(req)).opId; } catch { opId = undefined; }
      if (typeof opId !== 'string' || !opId || opId.length > 200) return send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be {opId: string}' } });
      const ac = running.get(opId);
      if (ac) ac.abort();
      else rememberCancel(opId);
      log(`cancel opId=${opId} ${ac ? 'aborted' : 'not running'}`);
      return send(res, 200, { ok: true, cancelled: Boolean(ac) });
    }
    if (req.method !== 'POST' || url.pathname !== '/rpc') return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Use POST /rpc, GET /health, or GET/PUT /file' } });

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, { ok: false, error: { code: 'TOO_LARGE', message: 'Request body exceeds 16 MiB' } });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    const { tool, args = {}, callId, opId, sid = 'default', defaultDir } = body ?? {};
    const badId = (v) => v !== undefined && (typeof v !== 'string' || !v || v.length > 200);
    if (typeof tool !== 'string' || typeof args !== 'object' || args === null || badId(callId) || badId(opId) || typeof sid !== 'string' || (defaultDir !== undefined && typeof defaultDir !== 'string')) {
      return send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be {tool: string, args: object, callId?: string, opId?: string, sid?: string, defaultDir?: string}' } });
    }
    const t0 = Date.now();
    // opId: the caller's handle for POST /cancel. A retry of the same call keeps the first controller.
    const ac = new AbortController();
    if (opId && earlyCancels.has(opId)) ac.abort();
    if (opId && !running.has(opId)) running.set(opId, ac);
    const ctl = (opId && running.get(opId)) || ac;
    const run = () => tools.dispatch(tool, args, { sid, defaultDir, signal: ctl.signal });
    let result;
    try {
      result = callId ? await calls.run(callId, fingerprint(tool, { args, defaultDir }, sid), run) : await run();
    } finally {
      if (opId && running.get(opId) === ac) running.delete(opId);
    }
    log(`rpc tool=${tool} callId=${callId ?? '-'} ok=${result.ok}${result.ok ? '' : ` code=${result.error.code}`}${result.cached ? ' cached' : ''}${ctl.signal.aborted ? ' cancelled' : ''} ms=${Date.now() - t0}`);
    return send(res, 200, result);
  });
  // Node ends any request still in progress after 300 s (requestTimeout) with a 408, which cuts
  // off a large PUT /file over a slow tailnet path. Idle sockets are still bounded by the
  // gateway's socket timeout and keepAliveTimeout.
  server.requestTimeout = 0;
  return server;
}
