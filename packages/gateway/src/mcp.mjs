// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping,
// tools/list, tools/call. Tool calls run concurrently. notifications/cancelled aborts the
// call's signal (and its response is not sent); when stdin closes (the client exited or
// was killed) every call still running is aborted and given a few seconds to wind down;
// `.shutdown(why)` on the returned promise does the same (main.mjs calls it on SIGTERM).
import { createInterface } from 'node:readline';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function serveStdio({ name, version, tools, callTool, input = process.stdin, output = process.stdout, log = () => {}, closeGraceMs = 5000 }) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const handlers = {
    initialize: (p) => ({
      protocolVersion: SUPPORTED.includes(p?.protocolVersion) ? p.protocolVersion : SUPPORTED[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name, version },
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: tools() }),
    'tools/call': (p, signal) => callTool(p?.name, p?.arguments ?? {}, { signal }),
  };
  const inflight = new Map(); // request id -> { ac, done }

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (msg.id === undefined || msg.id === null) { // notifications (initialized, cancelled, ...)
      const call = msg.method === 'notifications/cancelled' ? inflight.get(msg.params?.requestId) : undefined;
      if (call) { log(`mcp request ${msg.params.requestId} cancelled by the client${msg.params.reason ? `: ${msg.params.reason}` : ''}`); call.ac.abort(); }
      return;
    }
    const handler = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : undefined;
    if (!handler) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    const ac = new AbortController();
    let finished;
    inflight.set(msg.id, { ac, done: new Promise((r) => { finished = r; }) });
    try {
      const result = await handler(msg.params, ac.signal);
      if (!ac.signal.aborted) send({ id: msg.id, result });
    } catch (error) {
      log(`mcp ${msg.method} failed: ${error.message}`);
      if (!ac.signal.aborted) send({ id: msg.id, error: { code: -32603, message: error.message } });
    } finally {
      inflight.delete(msg.id);
      finished();
    }
  });
  /** Cancel every call still running and wait for them (at most closeGraceMs). */
  const shutdown = async (why) => {
    if (!inflight.size) return;
    log(`${why} with ${inflight.size} call(s) running: cancelling them`);
    const pending = [...inflight.values()];
    for (const call of pending) call.ac.abort();
    await Promise.race([Promise.all(pending.map((c) => c.done)), new Promise((r) => setTimeout(r, closeGraceMs))]);
  };
  const done = new Promise((resolve) => rl.on('close', () => shutdown('stdin closed').then(resolve)));
  return Object.assign(done, { shutdown });
}
