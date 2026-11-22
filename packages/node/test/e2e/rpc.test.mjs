// End-to-end tests against a running desk-node over the tailnet. Run from the VPS:
//   DESK_URL=http://<pc>.<tailnet>.ts.net:7801 DESK_TOKEN_FILE=~/.config/desk-fleet/tokens/pc-home.token \
//   DESK_SANDBOX=D:/fleet-sandbox node --test test/e2e/*.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';

const URL_BASE = process.env.DESK_URL;
const TOKEN = readFileSync(process.env.DESK_TOKEN_FILE.replace(/^~/, process.env.HOME), 'utf8').trim();
const NODE_HOME = process.env.DESK_NODE_HOME ?? 'C:/desk-node';
const SANDBOX = `${process.env.DESK_SANDBOX ?? 'D:/fleet-sandbox'}/e2e-${Date.now()}`;
const DIR = `${SANDBOX}/中文目录`;
const FILE = `${DIR}/文件 一.md`;

async function rpc(tool, args, { sid = 'e2e', callId, defaultDir } = {}) {
  const res = await fetch(`${URL_BASE}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args, sid, ...(callId ? { callId } : {}), ...(defaultDir ? { defaultDir } : {}) }),
  });
  assert.equal(res.status, 200);
  return res.json();
}
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r; };
const err = (r, code) => { assert.equal(r.ok, false, r.text); assert.equal(r.error.code, code, JSON.stringify(r.error)); return r; };
const bash = async (command, extra = {}) => ok(await rpc('Bash', { command, cwd: SANDBOX, ...extra }));

after(async () => { await rpc('Bash', { command: `rm -rf '${SANDBOX}'` }); });

test('auth: missing or wrong token is 401; health reports identity', async () => {
  assert.equal((await fetch(`${URL_BASE}/health`)).status, 401);
  assert.equal((await fetch(`${URL_BASE}/health`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${URL_BASE}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}x` }, body: '{}' })).status, 401);
  const h = await (await fetch(`${URL_BASE}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(h.ok, true);
  for (const key of ['machineId', 'version', 'os', 'uptimeSec', 'defaultDir']) assert.ok(h[key] !== undefined, key);
});

test('file transfer: authenticated PUT and GET preserve binary bytes and SHA-256', async () => {
  const file = `${SANDBOX}/中文目录/传输.bin`, bytes = Buffer.from([0, 1, 2, 255, 0, 128, 65]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const query = `path=${encodeURIComponent(file)}&defaultDir=${encodeURIComponent(SANDBOX)}&sid=file-e2e&backup=1`;
  assert.equal((await fetch(`${URL_BASE}/file?${query}`, { method: 'PUT', headers: { 'x-sha256': sha }, body: bytes })).status, 401);
  const put = await fetch(`${URL_BASE}/file?${query}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'x-sha256': sha }, body: bytes });
  assert.equal(put.status, 200);
  const uploaded = await put.json();
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.sha256, sha);
  assert.equal(uploaded.size, bytes.length);
  const get = await fetch(`${URL_BASE}/file?path=${encodeURIComponent(file)}&defaultDir=${encodeURIComponent(SANDBOX)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/octet-stream');
  assert.equal(get.headers.get('x-sha256'), sha);
  assert.equal(Number(get.headers.get('content-length')), bytes.length);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test('Write / Read with Chinese paths and every path spelling', async () => {
  const w = ok(await rpc('Write', { file_path: FILE, content: '第一行\n第二行 alpha\n第三行 beta\n' }));
  assert.match(w.text, /created/);
  const winPath = FILE.replaceAll('/', '\\');
  const msysPath = '/' + FILE[0].toLowerCase() + FILE.slice(2);
  for (const p of [FILE, winPath, msysPath]) {
    const r = ok(await rpc('Read', { file_path: p }));
    assert.match(r.text, /^\s+1\t第一行$/m, p);
    assert.equal(r.data.path, FILE);
    assert.equal(r.data.encoding, 'utf8');
  }
  const rel = ok(await rpc('Read', { file_path: 'desk-fleet/README.md', limit: 1 }));
  assert.equal(rel.data.path, 'desk-fleet/README.md');
});

test('ETag rules: READ_REQUIRED and STALE_ETAG', async () => {
  err(await rpc('Edit', { file_path: FILE, old_string: 'alpha', new_string: 'ALPHA' }, { sid: 'fresh' }), 'READ_REQUIRED');
  ok(await rpc('Read', { file_path: FILE }, { sid: 'stale' }));
  await bash(`echo '外部修改' >> '${FILE}'`);
  err(await rpc('Edit', { file_path: FILE, old_string: 'alpha', new_string: 'ALPHA' }, { sid: 'stale' }), 'STALE_ETAG');
  ok(await rpc('Read', { file_path: FILE }, { sid: 'stale' }));
  ok(await rpc('Edit', { file_path: FILE, old_string: 'alpha', new_string: 'ALPHA' }, { sid: 'stale' }));
  err(await rpc('Edit', { file_path: FILE, old_string: '行', new_string: 'X' }, { sid: 'stale' }), 'EDIT_AMBIGUOUS');
  assert.match(ok(await rpc('Read', { file_path: FILE })).text, /第二行 ALPHA[\s\S]*外部修改/);
});

test('concurrent edits to one file are serialized; none lost', async () => {
  const f = `${SANDBOX}/concurrent.txt`;
  ok(await rpc('Write', { file_path: f, content: 'a\nb\nc\nd\ne\nf\ng\nh\n' }, { sid: 'conc' }));
  const results = await Promise.all('abcdefgh'.split('').map((ch) => rpc('Edit', { file_path: f, old_string: `${ch}\n`, new_string: `${ch.toUpperCase()}\n` }, { sid: 'conc' })));
  results.forEach(ok);
  assert.match(ok(await rpc('Read', { file_path: f })).text, /A\n[\s\S]*H$/);
});

test('GBK file: read decodes, edit keeps GBK and CRLF', async () => {
  const f = `${SANDBOX}/gbk.txt`;
  await bash(`printf '\\xd6\\xd0\\xce\\xc4\\r\\nabc\\r\\n' > '${f}'`);
  const r = ok(await rpc('Read', { file_path: f }));
  assert.equal(r.data.encoding, 'gb18030');
  assert.match(r.text, /中文/);
  ok(await rpc('Edit', { file_path: f, old_string: 'abc', new_string: '版本' }));
  assert.equal((await bash(`od -An -tx1 '${f}' | tr -d ' \\n'`)).text, 'd6d0cec40d0ab0e6b1be0d0a');
});

test('Read images: attached as base64, oversized ones return a hint', async () => {
  await bash(`mkdir -p img && echo iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGP4z8AARww4OQD1MQv1NXv7ggAAAABJRU5ErkJggg== | base64 -d > img/red.png && head -c 4000000 /dev/zero > img/big.png && printf '\\x89PNG\\r\\n\\x1a\\n\\0\\0\\0\\rIHDR\\0\\0\\x23\\x28\\0\\0\\0\\x10' > img/wide.png`);
  const r = ok(await rpc('Read', { file_path: `${SANDBOX}/img/red.png` }));
  assert.equal(r.image.mimeType, 'image/png');
  assert.equal(r.image.data, 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGP4z8AARww4OQD1MQv1NXv7ggAAAABJRU5ErkJggg==');
  assert.match(r.text, /4x3/);
  const big = ok(await rpc('Read', { file_path: `${SANDBOX}/img/big.png` }));
  assert.equal(big.image, undefined);
  assert.match(big.text, /^Image not attached: .*over the 3.75 MiB limit/);
  assert.match(ok(await rpc('Read', { file_path: `${SANDBOX}/img/wide.png` })).text, /9000x16, over 8000 px/);
});

test('defaultDir per request: relative paths and display follow it', async () => {
  const r = ok(await rpc('Read', { file_path: '中文目录/文件 一.md', limit: 1 }, { defaultDir: SANDBOX }));
  assert.equal(r.data.path, '中文目录/文件 一.md');
  assert.equal((await rpc('Bash', { command: 'pwd -W' }, { defaultDir: SANDBOX })).text, SANDBOX);
});

test('blocked paths: desk-node data and token', async () => {
  for (const p of [`${NODE_HOME}/data/token`, `${NODE_HOME}\\data\\config.json`, `${NODE_HOME}/data`]) err(await rpc('Read', { file_path: p }), 'PATH_BLOCKED');
  err(await rpc('Write', { file_path: `${NODE_HOME}/data/x.txt`, content: 'x' }), 'PATH_BLOCKED');
});

test('Glob and Grep', async () => {
  const g = ok(await rpc('Glob', { pattern: '**/*.md', path: SANDBOX }));
  assert.match(g.text, /中文目录\/文件 一\.md/);
  const files = ok(await rpc('Grep', { pattern: '第二行', path: SANDBOX }));
  assert.match(files.text, /文件 一\.md/);
  const content = ok(await rpc('Grep', { pattern: 'alpha', path: SANDBOX, output_mode: 'content', '-i': true }));
  assert.match(content.text, /文件 一\.md:2:第二行 ALPHA/);
  assert.equal(ok(await rpc('Grep', { pattern: 'no-such-text-xyz', path: SANDBOX })).text, 'No matches found');
});

test('Bash: UTF-8 environment, exit codes, GBK output converted to UTF-8', async () => {
  const r = await bash('echo 你好; echo "$LANG"; pwd -W');
  assert.match(r.text, /^你好\nC\.UTF-8\n/);
  assert.equal(r.data.exitCode, 0);
  const fail = await bash('echo bad >&2; exit 3');
  assert.equal(fail.data.exitCode, 3);
  assert.match(fail.text, /bad\n\[exit code 3\]/);
  assert.equal((await bash("printf '\\xd6\\xd0\\xce\\xc4\\n'")).text, '中文');
  assert.match((await bash('cmd.exe //d //c ver')).text, /Microsoft Windows \[版本 /);
  assert.equal((await bash('echo 中文 & ver >nul', { shell: 'cmd' })).text.trim(), '中文');
  assert.equal((await bash("Write-Output '中文'", { shell: 'powershell' })).text.trim(), '中文');
  assert.equal((await bash('python -c "print(\'中文\')" 2>/dev/null || echo 中文')).text.trim().split('\n').pop(), '中文');
});

test('Bash: output cleaning, 30000-char bound with one-line archive footer', async () => {
  assert.equal((await bash("printf '\\033[31mred\\033[0m\\n10%%\\r100%%\\n'")).text, 'red\n100%');
  const big = await bash("for i in $(seq 1 6000); do echo \"line $i 0123456789\"; done");
  assert.equal(big.data.truncated, true);
  assert.ok(big.text.length <= 30000);
  assert.match(big.text, /^line 1 /);
  assert.match(big.text, /line 6000 0123456789\n\[desk-node: 6000 lines, .*; shown 1-20, 5941-6000; full output: .+\]$/);
  const archived = ok(await rpc('Read', { file_path: big.data.archive, offset: 6000, limit: 1 }));
  assert.match(archived.text, /line 6000/);
});

test('Bash: timeout kills the process', async () => {
  const r = await bash('sleep 20; echo never', { timeout: 1500 });
  assert.equal(r.data.timedOut, true);
  assert.doesNotMatch(r.text, /never/);
});

test('Bash: whole process tree is killed on timeout and leftovers do not block', async () => {
  const t0 = Date.now();
  const r = await bash('cmd.exe //d //c "ping -n 30 127.0.0.1 >nul"; echo never', { timeout: 2000 });
  assert.equal(r.data.timedOut, true);
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const bg = await bash('sleep 30 & echo started');
  assert.ok(Date.now() - t1 < 8000, `took ${Date.now() - t1} ms`);
  assert.match(bg.text, /started[\s\S]*terminated/);
  assert.equal((await bash('tasklist //FI "IMAGENAME eq PING.EXE" | grep -ci ping || true')).text.trim(), '0');
});

test('callId: retries return the cached result; reuse with different input conflicts', async () => {
  const callId = randomUUID();
  const a = ok(await rpc('Bash', { command: 'echo $RANDOM$RANDOM', cwd: SANDBOX }, { callId }));
  const b = ok(await rpc('Bash', { command: 'echo $RANDOM$RANDOM', cwd: SANDBOX }, { callId }));
  assert.equal(a.text, b.text);
  assert.equal(b.cached, true);
  err(await rpc('Bash', { command: 'echo other', cwd: SANDBOX }, { callId }), 'CONFLICT');
  const writeId = randomUUID(), f = `${SANDBOX}/once.txt`;
  ok(await rpc('Write', { file_path: f, content: '1' }, { callId: writeId }));
  ok(await rpc('Write', { file_path: f, content: '1' }, { callId: writeId }));
});

test('BashJob: start, wait, output, stop, list', async () => {
  const s = ok(await rpc('BashJob', { action: 'start', command: 'for i in 1 2 3; do echo "步骤 $i"; sleep 1; done', cwd: SANDBOX }));
  const id = s.data.id;
  assert.equal(s.data.state, 'running');
  const done = ok(await rpc('BashJob', { action: 'status', id, wait_ms: 20000 }));
  assert.equal(done.data.state, 'exited');
  assert.equal(done.data.exitCode, 0);
  assert.match(done.text, /步骤 3/);
  const out = ok(await rpc('BashJob', { action: 'output', id }));
  assert.match(out.text, /步骤 1\n步骤 2\n步骤 3/);
  const long = ok(await rpc('Bash', { command: 'cmd.exe //d //c "ping -n 120 127.0.0.1 >nul"', cwd: SANDBOX, run_in_background: true }));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ok(await rpc('BashJob', { action: 'stop', id: long.data.id })).data.state, 'stopped');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await bash('tasklist //FI "IMAGENAME eq PING.EXE" | grep -ci ping || true')).text.trim(), '0');
  const list = ok(await rpc('BashJob', { action: 'list' }));
  assert.ok(list.data.jobs.some((j) => j.id === id));
  err(await rpc('BashJob', { action: 'status', id: 'nope' }), 'NOT_FOUND');
});

test('Checkpoint: create/restore in a Git repo; user index, HEAD, CRLF and ignored files kept', async () => {
  const repo = `${SANDBOX}/cp-repo`;
  await bash(`mkdir -p '${repo}' && cd '${repo}' && git init -q && git config core.autocrlf true && printf 'one\\r\\ntwo\\r\\n' > crlf.txt && echo b1 > 文件b.txt && echo ignored.txt > .gitignore && git add . && git -c user.name=t -c user.email=t@t commit -qm init && echo staged >> 文件b.txt && git add 文件b.txt && echo untracked > new1.txt`);
  const state = async () => (await bash(`cd '${repo}' && sha256sum .git/index | cut -c1-16 && git rev-parse HEAD && git diff --cached --name-only`)).text;
  const before = await state();
  const c = ok(await rpc('Checkpoint', { action: 'create', path: repo, note: 'e2e' }, { sid: 'cp-e2e' }));
  assert.match(c.text, /refs\/desk\/cp\/cp-e2e\/1/);
  assert.equal(await state(), before);
  await bash(`cd '${repo}' && printf 'changed\\n' > crlf.txt && rm 文件b.txt && echo junk > new2.txt && echo keep > ignored.txt`);
  const preview = ok(await rpc('Checkpoint', { action: 'restore', path: repo }, { sid: 'cp-e2e' }));
  assert.match(preview.text, /rewrite 2 file\(s\) and delete 1/);
  assert.equal((await bash(`cat '${repo}/new2.txt'`)).text, 'junk');
  ok(await rpc('Checkpoint', { action: 'restore', path: repo, confirm: true }, { sid: 'cp-e2e' }));
  assert.equal((await bash(`cd '${repo}' && od -An -c crlf.txt | tr -s ' ' && cat 文件b.txt new1.txt ignored.txt; test -e new2.txt || echo gone`)).text, ' o n e \\r \\n t w o \\r \\n\nb1\nstaged\nuntracked\nkeep\ngone');
  assert.equal(await state(), before);
  assert.match(ok(await rpc('Checkpoint', { action: 'list', path: repo }, { sid: 'cp-e2e' })).text, /^1 .*desk checkpoint: e2e$/m);
  assert.match(ok(await rpc('Checkpoint', { action: 'list', path: repo }, { sid: 'other' })).text, /No checkpoints/);
  err(await rpc('Checkpoint', { action: 'create', path: SANDBOX }, { sid: 'cp-e2e' }), 'NOT_A_GIT_REPO');
});

test('automatic checkpoint before the first change per session and repo', async () => {
  const repo = `${SANDBOX}/auto-repo`;
  await bash(`mkdir -p '${repo}/sub' && cd '${repo}' && git init -q && echo base > a.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm init`);
  const first = ok(await rpc('Write', { file_path: `${repo}/sub/new.txt`, content: 'x\n' }, { sid: 'auto-1' }));
  assert.match(first.text, /checkpoint 1 of .*auto-repo taken before this session's first change/);
  assert.doesNotMatch(ok(await rpc('Write', { file_path: `${repo}/sub/new2.txt`, content: 'y\n' }, { sid: 'auto-1' })).text, /checkpoint/);
  assert.match(ok(await rpc('Bash', { command: 'echo hi', cwd: repo }, { sid: 'auto-2' })).text, /^hi\n\[desk-node: checkpoint 1 of/);
  assert.doesNotMatch(ok(await rpc('Bash', { command: 'echo hi', cwd: SANDBOX }, { sid: 'auto-2' })).text, /checkpoint/); // not a repo
  const list = ok(await rpc('Checkpoint', { action: 'list', path: repo }, { sid: 'auto-1' }));
  assert.match(list.text, /auto, before the first change in this session/);
  // the checkpoint was taken before the first write: restoring removes sub/new.txt
  assert.match(ok(await rpc('Checkpoint', { action: 'restore', path: repo }, { sid: 'auto-1' })).text, /delete 2\b[\s\S]*sub\/new\.txt/);
});

test('Fs and Git: read-only RPCs for fleet-ui, no checkpoints', async () => {
  const repo = `${SANDBOX}/ro-repo`;
  await bash(`mkdir -p '${repo}/子目录/node_modules/x' && cd '${repo}' && git init -q && printf 'one\\r\\ntwo\\r\\n' > crlf.txt && echo 中文 > 子目录/文件.md && git add . && git -c user.name=t -c user.email=t@t commit -qm init && echo changed >> crlf.txt && echo new > untracked.txt`);
  const st = ok(await rpc('Fs', { action: 'stat', path: `${repo}/crlf.txt` }, { sid: 'ro' }));
  assert.equal(st.data.type, 'file');
  const read = ok(await rpc('Fs', { action: 'read', path: `${repo}/crlf.txt` }, { sid: 'ro' }));
  assert.equal(read.data.content, 'one\r\ntwo\r\nchanged\n');
  assert.equal(Buffer.from(ok(await rpc('Fs', { action: 'read', path: `${repo}/子目录/文件.md`, encoding: 'base64' })).data.content, 'base64').toString(), '中文\n');
  const tree = ok(await rpc('Fs', { action: 'tree', path: repo, exclude: ['.git', 'node_modules'] }, { sid: 'ro' })).data.tree;
  assert.deepEqual(tree.map((n) => n.name), ['子目录', 'crlf.txt', 'untracked.txt']);
  assert.deepEqual(tree[0].children.map((n) => n.name), ['文件.md']);
  assert.match(tree[0].children[0].path, /^D:\/.*\/ro-repo\/子目录\/文件\.md$/);
  err(await rpc('Fs', { action: 'tree', path: repo, maxEntries: 2 }), 'TREE_TOO_LARGE');
  err(await rpc('Fs', { action: 'read', path: repo }), 'IS_DIRECTORY');
  err(await rpc('Fs', { action: 'stat', path: `${repo}/missing` }), 'NOT_FOUND');
  const status = ok(await rpc('Git', { cwd: repo, args: ['status', '--porcelain'] }, { sid: 'ro' })).data;
  assert.equal(status.code, 0);
  assert.equal(status.stdout, ' M crlf.txt\n?? untracked.txt\n');
  assert.match(ok(await rpc('Git', { cwd: repo, args: ['diff', '--', 'crlf.txt'] })).data.stdout, /\+changed/);
  assert.notEqual(ok(await rpc('Git', { cwd: repo, args: ['rev-parse', '--verify', 'nope'] })).data.code, 0);
  err(await rpc('Git', { cwd: repo, args: ['commit', '-m', 'x'] }), 'NOT_READ_ONLY');
  err(await rpc('Git', { cwd: repo, args: ['diff', '--output=out.txt'] }), 'NOT_READ_ONLY');
  // read-only: no checkpoint refs and an unchanged working tree
  assert.equal((await bash(`cd '${repo}' && git for-each-ref refs/desk | wc -l && git status --porcelain | wc -l`)).text, '0\n2');
});

test('errors are structured {code, message, next}', async () => {
  const r = err(await rpc('Nope', {}), 'UNKNOWN_TOOL');
  assert.ok(r.error.message && r.error.next);
  err(await rpc('Read', { file_path: `${SANDBOX}/missing.txt` }), 'NOT_FOUND');
  err(await rpc('Read', { file_path: '\\\\server\\share\\x' }), 'BAD_PATH');
});
