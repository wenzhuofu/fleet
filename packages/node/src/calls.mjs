// callId result cache (ported from v1 deskd/src/ledger.ts CallLedger; SQLite
// replaced by one JSON file per callId).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEEP_MS = 7 * 24 * 3600 * 1000;
const hash = (s) => createHash('sha256').update(s).digest('hex');

export function fingerprint(tool, args, sid) {
  return hash(JSON.stringify([tool, args, sid ?? null]));
}

export class CallCache {
  constructor(dir) {
    this.dir = dir;
    this.running = new Map();
    mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - KEEP_MS;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { /* ignore */ }
    }
  }

  file(callId) { return path.join(this.dir, hash(callId).slice(0, 40) + '.json'); }

  /** `fn` must resolve to a response envelope and never reject. */
  async run(callId, fp, fn) {
    const active = this.running.get(callId);
    if (active) return active.fp === fp ? active.promise : conflict();
    const file = this.file(callId);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = undefined; }
    if (record) {
      if (record.fp !== fp) return conflict();
      if (record.state === 'done') return { ...record.response, cached: true };
      return {
        ok: false,
        error: {
          code: 'CALL_OUTCOME_UNKNOWN',
          message: 'This callId started earlier but desk-node restarted before it finished; the outcome is unknown',
          next: 'Inspect the target (e.g. Read the file) to see whether it took effect, then retry with a new callId',
        },
      };
    }
    writeFileSync(file, JSON.stringify({ fp, state: 'started', at: new Date().toISOString() }), { mode: 0o600 });
    const promise = fn().then((response) => {
      writeFileSync(file, JSON.stringify({ fp, state: 'done', at: new Date().toISOString(), response }), { mode: 0o600 });
      return response;
    }).finally(() => this.running.delete(callId));
    this.running.set(callId, { fp, promise });
    return promise;
  }
}

function conflict() {
  return { ok: false, error: { code: 'CONFLICT', message: 'callId was reused for a different request', next: 'Use a new callId for a new request' } };
}
