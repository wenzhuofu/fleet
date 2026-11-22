// BashJob across a desk-node restart. Needs DESK_RESTART_CMD, a shell command that restarts
// the node (phase 1: ssh pc-home "powershell ... dev-start.ps1 -Release ...").
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const URL_BASE = process.env.DESK_URL;
const TOKEN = readFileSync(process.env.DESK_TOKEN_FILE.replace(/^~/, process.env.HOME), 'utf8').trim();
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const rpc = async (tool, args) => (await fetch(`${URL_BASE}/rpc`, { method: 'POST', headers, body: JSON.stringify({ tool, args }) })).json();
const health = async () => (await fetch(`${URL_BASE}/health`, { headers })).json();
const pings = async () => (await rpc('Bash', { command: 'tasklist //FI "IMAGENAME eq PING.EXE" | grep -ci ping || true' })).text.trim();

test('BashJob state, output and stop survive a desk-node restart', { skip: !process.env.DESK_RESTART_CMD }, async () => {
  const a = (await rpc('BashJob', { action: 'start', command: 'for i in $(seq 1 40); do echo "重启 $i"; sleep 1; done' })).data.id;
  const b = (await rpc('BashJob', { action: 'start', command: 'cmd.exe //d //c "ping -n 120 127.0.0.1 >nul"' })).data.id;
  const before = (await health()).pid;
  execSync(process.env.DESK_RESTART_CMD, { stdio: 'ignore' });
  for (let i = 0; i < 30 && (await health().catch(() => ({}))).pid === before; i++) await new Promise((r) => setTimeout(r, 500));
  assert.notEqual((await health()).pid, before, 'desk-node did not restart');
  assert.equal((await rpc('BashJob', { action: 'status', id: a })).data.state, 'running');
  const done = await rpc('BashJob', { action: 'status', id: a, wait_ms: 60000 });
  assert.equal(done.data.state, 'exited');
  assert.match(done.text, /重启 40/);
  assert.equal((await rpc('BashJob', { action: 'stop', id: b })).data.state, 'stopped');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await pings(), '0');
});
