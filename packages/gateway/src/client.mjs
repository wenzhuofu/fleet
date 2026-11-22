// HTTP client for desk-node. Connection failures (and 502/503/504 from tailscale serve
// while the node is down) are retried with the same callId until the retry window closes;
// desk-node returns the cached or in-flight result for a callId it has already seen.
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { GatewayError } from './errors.mjs';

const TRANSIENT_STATUS = new Set([502, 503, 504]);
const MAX_RESPONSE = 64 * 1024 * 1024;
const CONNECT_TIMEOUT = 5000; // an offline tailnet peer drops SYNs instead of refusing

// Keep connections to the nodes open between model turns (Node's default agent drops idle
// sockets after 5 s; a new connection costs one tailnet round trip, ~300 ms to pc-home).
// desk-node keeps them for 120 s; close ours a little earlier.
const agents = { 'http:': new http.Agent({ keepAlive: true, timeout: 110000 }), 'https:': new https.Agent({ keepAlive: true, timeout: 110000 }) };

class Transient extends Error {}
/** The host itself did not answer (asleep, powered off, off the tailnet): no point retrying for long. */
class Unreachable extends Transient {}
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTDOWN']);

/** One request. Rejects with Transient for failures worth retrying. */
function request(url, { method = 'GET', token, body, timeoutMs }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let connected = false;
    const req = lib.request(u, {
      method,
      agent: agents[u.protocol],
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(); reject(new GatewayError('TOO_LARGE', 'Node response exceeds 64 MiB')); }
        else chunks.push(c);
      });
      res.on('error', (e) => reject(new Transient(e.message)));
      res.on('end', () => {
        if (TRANSIENT_STATUS.has(res.statusCode)) return reject(new Transient(`HTTP ${res.statusCode}`));
        if (res.statusCode === 401) return reject(new GatewayError('UNAUTHORIZED', 'desk-node rejected the token (401)', 'Check that the tokenFile in machines.json matches C:\\desk-node\\data\\token on the machine'));
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new GatewayError('BAD_RESPONSE', `desk-node returned HTTP ${res.statusCode} with a non-JSON body`)); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('socket', (socket) => {
      if (!socket.connecting) { connected = true; return; }
      const timer = setTimeout(() => req.destroy(new Unreachable('connect timeout')), CONNECT_TIMEOUT);
      socket.once('connect', () => { connected = true; clearTimeout(timer); });
      socket.once('close', () => clearTimeout(timer));
    });
    req.on('timeout', () => req.destroy(new GatewayError('NODE_TIMEOUT', `No response within ${Math.round(timeoutMs / 1000)} s`)));
    // A connection that dies after it was established (e.g. the tailnet path switched during a long
    // call) is retried with the same callId; only a host that never answered counts as unreachable.
    req.on('error', (e) => reject(e instanceof GatewayError || e instanceof Transient ? e : UNREACHABLE_CODES.has(e.code) && !connected ? new Unreachable(e.code) : new Transient(e.code ?? e.message)));
    req.end(payload);
  });
}

/**
 * Call with retries. Returns the parsed JSON body; throws GatewayError (MACHINE_OFFLINE after
 * the retry window). `onSeen` is called whenever the node answers.
 */
export async function callWithRetry(url, options, { retryWindowMs, onSeen, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = Date.now() + retryWindowMs;
  let lastError;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new GatewayError('CANCELLED', 'Cancelled by the client');
    try {
      const r = await request(url, options);
      onSeen?.();
      return r.json;
    } catch (error) {
      if (!(error instanceof Transient)) {
        if (error.code === 'UNAUTHORIZED' || error.code === 'BAD_RESPONSE') onSeen?.();
        throw error;
      }
      lastError = error.message;
      const left = deadline - Date.now();
      // Refused / 502 means the host is up and desk-node is restarting: keep retrying.
      // An unreachable host (sleeping PC) fails fast instead of hanging for the whole window.
      if (left <= 0 || error instanceof Unreachable) throw Object.assign(new GatewayError('MACHINE_OFFLINE', ''), { lastError, elapsedMs: Date.now() - deadline + retryWindowMs });
      await sleep(Math.min(250 * 2 ** attempt, 5000, left));
    }
  }
}

/** Stream a file to desk-node. */
export function putFile(url, { token, file, sha256, timeoutMs = 300000, signal, contentType = 'application/octet-stream', failureCode = 'FILE_UPLOAD_FAILED' }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const size = statSync(file).size, source = createReadStream(file);
    let settled = false, response;
    const finish = (fn, value) => { if (!settled) { settled = true; signal?.removeEventListener('abort', abort); fn(value); } };
    const fail = (e) => {
      if (settled) return;
      finish(reject, e instanceof GatewayError ? e : new GatewayError(failureCode, e.code ?? e.message));
      source.destroy(); response?.destroy(); req.destroy();
    };
    const abort = () => fail(new GatewayError('CANCELLED', 'Cancelled by the client'));
    const req = lib.request(u, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'x-sha256': sha256, 'content-type': contentType, 'content-length': size },
      timeout: timeoutMs,
    }, (res) => {
      response = res;
      const chunks = [];
      source.destroy(); if (!req.writableEnded) req.end();
      res.on('aborted', () => fail(new Error('response aborted')));
      res.on('error', fail);
      res.on('close', () => { if (!res.complete) fail(new Error('response truncated')); });
      res.on('data', (c) => { if (Buffer.concat(chunks).length < 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep {} */ }
        if (res.statusCode === 200 && body.ok) return finish(resolve, body);
        if (unsupportedFileEndpoint(u, res, body)) return finish(reject, new GatewayError('COPY_UNSUPPORTED', '该机器的 desk-node 版本不支持 Copy，需要升级'));
        finish(reject, new GatewayError(body.error?.code ?? failureCode, body.error?.message ?? `file upload failed with HTTP ${res.statusCode}`, body.error?.next));
      });
    });
    req.on('timeout', () => req.destroy(new GatewayError(failureCode, 'upload timed out')));
    req.on('error', fail);
    source.on('error', fail);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    source.pipe(req);
  });
}

const unsupportedFileEndpoint = (u, res, body) => res.statusCode === 404 && u.pathname === '/file' && /^Use POST \/rpc\b/.test(body.error?.message ?? '');

/** GET a streamed file from desk-node. The caller owns and must consume or destroy the stream. */
export function getFile(url, { token, timeoutMs = 300000, signal } = {}) {
  const u = new URL(url), lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value, keepAbort = false) => { if (!settled) { settled = true; if (!keepAbort) signal?.removeEventListener('abort', abort); fn(value); } };
    const abort = () => { finish(reject, new GatewayError('CANCELLED', 'Cancelled by the client')); req.destroy(); };
    const fail = (e) => {
      if (settled) return;
      finish(reject, e instanceof GatewayError ? e : new GatewayError('FILE_DOWNLOAD_FAILED', e.code ?? e.message));
      req.destroy();
    };
    const req = lib.request(u, { headers: { authorization: `Bearer ${token}` }, timeout: timeoutMs }, (res) => {
      res.on('aborted', () => fail(new Error('response aborted')));
      res.on('error', fail);
      res.on('close', () => { signal?.removeEventListener('abort', abort); if (!res.complete) fail(new Error('response truncated')); });
      if (res.statusCode === 200) {
        signal?.addEventListener('abort', abort, { once: true });
        return finish(resolve, { headers: res.headers, stream: res }, true);
      }
      const chunks = [];
      res.on('data', (c) => { if (Buffer.concat(chunks).length < 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep {} */ }
        if (unsupportedFileEndpoint(u, res, body)) return finish(reject, new GatewayError('COPY_UNSUPPORTED', '该机器的 desk-node 版本不支持 Copy，需要升级'));
        finish(reject, new GatewayError(body.error?.code ?? 'FILE_DOWNLOAD_FAILED', body.error?.message ?? `file download failed with HTTP ${res.statusCode}`, body.error?.next));
      });
    });
    req.on('timeout', () => req.destroy(new GatewayError('FILE_DOWNLOAD_FAILED', 'file download timed out')));
    req.on('error', fail);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    req.end();
  });
}

/** PUT a release package to desk-node with its SHA-256. */
export function uploadFile(url, options) {
  return putFile(url, { ...options, contentType: 'application/gzip', failureCode: 'UPLOAD_FAILED' });
}
