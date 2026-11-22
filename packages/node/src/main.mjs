// desk-node entry point.
// Layout (DESK_NODE_HOME, default C:\desk-node):
//   data\config.json   {machineId, port, defaultDir, denyPaths?, bash?, git?, rg?}
//   incoming\          uploaded release packages (PUT /upload)
//   data\token         bearer token (current user only)
//   data\...           call cache, job metadata, temp scripts (blocked from file tools)
//   outputs\           archived full outputs and job logs (readable; kept 7 days / 1 GB)
//   logs\desk-node.log
// Release layout: <release>\app\src\main.mjs, <release>\node\node.exe, <release>\bin\rg.exe
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallCache } from './calls.mjs';
import { Paths } from './paths.mjs';
import { createRpcServer } from './server.mjs';
import { createTools } from './tools.mjs';

const home = process.env.DESK_NODE_HOME ?? 'C:\\desk-node';
const dataDir = path.join(home, 'data');
const outputsDir = path.join(home, 'outputs');
const logDir = path.join(home, 'logs');
const tokenFile = path.join(dataDir, 'token');
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.dirname(appDir);

mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'desk-node.log');
const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const config = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
const token = readFileSync(tokenFile, 'utf8').trim();
if (token.length < 32) throw new Error('data/token must contain at least 32 characters');
const { version } = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
let runtime = null; // identity of node\ and bin\ in this release (see deploy/node/build-release.sh)
try { runtime = readFileSync(path.join(releaseDir, 'RUNTIME'), 'utf8').trim(); } catch { /* releases before 0.5.7 */ }

const paths = new Paths({ defaultDir: config.defaultDir, blocked: [dataDir, tokenFile], denied: config.denyPaths ?? [] });
config.defaultDir = paths.defaultDir;
const bash = config.bash ?? 'C:\\Program Files\\Git\\bin\\bash.exe';
const tools = createTools({
  paths,
  home,
  dataDir,
  outputsDir,
  bash,
  git: config.git ?? path.join(path.dirname(path.dirname(bash)), 'cmd', 'git.exe'),
  rg: config.rg ?? path.join(releaseDir, 'bin', 'rg.exe'),
});
const calls = new CallCache(path.join(dataDir, 'calls'));
const server = createRpcServer({ token, tools, calls, config, version, runtime, log, incomingDir: path.join(home, 'incoming') });
const port = config.port ?? 7801;

server.keepAliveTimeout = 120000; // the gateway reuses connections between model turns
server.headersTimeout = 125000;
server.listen(port, '127.0.0.1', () => log(`desk-node ${version} listening on 127.0.0.1:${port} machine=${config.machineId} pid=${process.pid}`));
server.on('error', (error) => { log(`server error: ${error.message}`); process.exit(1); });
// Archive retention: at start and hourly.
const prune = () => tools.prune().then((r) => { if (r.removed) log(`pruned ${r.removed} archived outputs (${r.freed} bytes); ${r.total} bytes kept`); }, (e) => log(`prune failed: ${e.message}`));
void prune();
setInterval(prune, 3600 * 1000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { log(`stopping on ${signal}`); server.close(() => process.exit(0)); });
