// desk-gateway: stdio MCP server started by Claude Code, one process per CLI session.
// Environment:
//   DESK_MACHINES          machines.json (default ~/.config/desk-fleet/machines.json if present, else ~/fleet/machines.json)
//   DESK_DEFAULT_MACHINE   overrides the session's binding (see binding.mjs: nearest .desk.json above the cwd)
//   DESK_DEFAULT_DIR       default directory on DESK_DEFAULT_MACHINE (only valid together with it)
//   DESK_STATE_DIR         log and last-seen state (default ~/.local/state/desk-fleet)
//   DESK_RETRY_WINDOW_MS   how long to retry an unreachable node (default 30000)
// The read-state id sent to desk-node is the Claude session id when Claude Code provides it
// (CLAUDE_CODE_SESSION_ID), otherwise an id generated for this process.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolDefs } from './defs.mjs';
import { createGateway } from './gateway.mjs';
import { machinesFile, resolveBinding } from './binding.mjs';
import { Machines } from './machines.mjs';
import { serveStdio } from './mcp.mjs';

const env = process.env;
const stateDir = (env.DESK_STATE_DIR ?? '~/.local/state/desk-fleet').replace(/^~(?=$|\/)/, os.homedir());
mkdirSync(stateDir, { recursive: true });
const logFile = path.join(stateDir, 'gateway.log');
const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`); } catch { /* ignore */ } };

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const sid = env.CLAUDE_CODE_SESSION_ID || `gw-${randomUUID()}`;
const binding = resolveBinding({ env });
const machines = new Machines({ file: machinesFile(env), stateDir, defaultMachine: binding.machine, defaultDir: binding.dir, defaultSource: binding.source, bindingProblem: binding.problem });
const gateway = createGateway({ machines, sid, retryWindowMs: Number(env.DESK_RETRY_WINDOW_MS ?? 30000), log });

log(`start desk-gateway ${pkg.version} sid=${sid} (${env.CLAUDE_CODE_SESSION_ID ? 'claude session' : 'generated'})`);
try {
  const problem = machines.envProblem();
  log(`default machine=${machines.defaultName} dir=${machines.effectiveDefaultDir(machines.defaultName) ?? '-'}${binding.source ? ` (${binding.source})` : ''}${problem ? ` CONFIG ERROR: ${problem}` : ''}`);
} catch (error) { log(`default machine unknown: ${error.message}`); }
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error}`));
const server = serveStdio({
  name: 'desk-gateway',
  version: pkg.version,
  tools: () => toolDefs(machines.defaultName),
  // The binding is re-read before each call: `desk use` / editing .desk.json applies without a restart.
  callTool: (...args) => { machines.setBinding(resolveBinding({ env })); return gateway.callTool(...args); },
  log,
});
// Claude Code ends its MCP servers with a signal when it exits: cancel running calls first.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { log(`got ${signal}`); server.shutdown(signal).then(() => process.exit(0)); });
}
await server;
log('stdin closed, exiting');
process.exit(0);
