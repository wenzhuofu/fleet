// Pure-logic tests; run on any platform: node --test test/unit/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { CallCache } from '../../src/calls.mjs';
import { KeyedLock, writeAtomic, currentTag } from '../../src/files.mjs';
import { boundText, cleanOutput, cleanText, clipLine, decodeOutput, pruneOutputs, summarizeOutput } from '../../src/output.mjs';
import { runForeground } from '../../src/exec.mjs';
import { probeImage } from '../../src/image.mjs';
import { Paths } from '../../src/paths.mjs';
import { grepLines } from '../../src/search.mjs';
import { decode, edit, encode, etag, formatRead, ReadState } from '../../src/text.mjs';

const tempDirs = new Set();
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-node-')); tempDirs.add(dir); return dir; };
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

test('paths: accepts D:\\x, D:/x, /d/x and relative; displays relative inside default dir', () => {
  const p = new Paths({ defaultDir: 'D:\\git', blocked: ['C:\\desk-node\\data'] });
  for (const input of ['D:\\git\\a\\b.txt', 'D:/git/a/b.txt', '/d/git/a/b.txt', 'a/b.txt', 'a\\b.txt', './a/../a/b.txt', 'd:/GIT/a/b.txt']) {
    assert.equal(p.display(p.resolve(input)).toLowerCase(), 'a/b.txt', input);
  }
  assert.equal(p.display(p.resolve('/c/Users/x')), 'C:/Users/x');
  assert.equal(p.display(p.resolve('D:/git')), '.');
  assert.equal(p.display(p.resolve('/d')), 'D:/');
  assert.equal(p.display(p.resolve('D:\\git\\中文目录\\文件.md')), '中文目录/文件.md');
  assert.equal(p.display(p.resolve('../远程vps/x')), 'D:/远程vps/x');
  for (const bad of ['\\\\server\\share', '//?/C:/x', 'D:foo', '/tmp/x', '', 'a\0b']) assert.throws(() => p.resolve(bad), bad);
  assert.equal(p.isBlocked(p.resolve('C:/desk-node/data/token')), true);
  assert.equal(p.isBlocked(p.resolve('c:/DESK-NODE/data')), true);
  assert.equal(p.isBlocked(p.resolve('C:/desk-node/database')), false);
  assert.equal(p.isBlocked(p.resolve('C:/desk-node/outputs/x.log')), false);
});

test('text: encoding detection and round trip keep BOM, EOL and GBK', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a, 0x61, 0x0d, 0x0a]); // "中文\r\na\r\n"
  const f = decode(gbk);
  assert.equal(f.kind, 'gb18030');
  assert.equal(f.eol, 'CRLF');
  assert.equal(f.text, '中文\na\n');
  assert.deepEqual(encode(f.text, f), gbk);
  assert.deepEqual([...encode('中文改\n', f)], [0xd6, 0xd0, 0xce, 0xc4, 0xb8, 0xc4, 0x0d, 0x0a]);
  assert.throws(() => encode('😀', f), /ENCODING|cannot be encoded/);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')]);
  assert.deepEqual(encode(decode(bom).text, decode(bom)), bom);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中\r\n', 'utf16le')]);
  assert.deepEqual(encode(decode(u16).text, decode(u16)), u16);
  assert.throws(() => decode(Buffer.from([0x61, 0, 0x62])), (e) => e.code === 'BINARY');
  assert.match(etag(Buffer.from('a')), /^sha256:[0-9a-f]{64}$/);
});

test('text: edit semantics', () => {
  assert.deepEqual(edit('a b a', 'b', 'c'), { text: 'a c a', replacements: 1 });
  assert.throws(() => edit('a b a', 'a', 'c'), (e) => e.code === 'EDIT_AMBIGUOUS');
  assert.deepEqual(edit('a b a', 'a', 'c', true), { text: 'c b c', replacements: 2 });
  assert.throws(() => edit('x', 'y', 'z'), (e) => e.code === 'EDIT_NO_MATCH');
  assert.throws(() => edit('x', 'x', 'x'), (e) => e.code === 'EDIT_NOOP');
});

test('text: ReadState enforces READ_REQUIRED and STALE_ETAG per session', () => {
  const r = new ReadState();
  assert.throws(() => r.require('s', 'D:\\a', 't1'), (e) => e.code === 'READ_REQUIRED');
  r.record('s', 'D:\\A', 't1');
  r.require('s', 'd:\\a', 't1');
  assert.throws(() => r.require('s', 'D:\\a', 't2'), (e) => e.code === 'STALE_ETAG');
  assert.throws(() => r.require('other', 'D:\\a', 't1'), (e) => e.code === 'READ_REQUIRED');
});

test('text: formatRead numbers lines and pages', () => {
  const v = formatRead('a\nb\nc\n', 2, 1);
  assert.equal(v.text.split('\n')[0], '     2\tb');
  assert.match(v.text, /continue with offset=3/);
  assert.equal(formatRead('').text, '(file exists but is empty)');
});

test('output: GBK bytes decode to UTF-8; mixed lines decode independently', () => {
  assert.equal(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  const mixed = Buffer.concat([Buffer.from('utf8 中文\n'), Buffer.from([0xb0, 0xe6, 0xb1, 0xbe, 0x0a])]); // "版本"
  assert.equal(decodeOutput(mixed), 'utf8 中文\n版本\n');
});

test('output: strips ANSI, collapses carriage returns, drops control chars', () => {
  assert.equal(cleanText('\x1b[31mred\x1b[0m\r\n10%\r50%\r100%\nok\x07\x1b]0;title\x07'), 'red\n100%\nok');
  assert.equal(cleanOutput(Buffer.from('a\r\n')), 'a\n');
});

test('output: bounds to 30000 chars keeping 20% head / 80% tail and archives', async () => {
  const text = 'H'.repeat(20000) + 'M'.repeat(20000) + 'T'.repeat(20000);
  let archived;
  const r = await boundText(text, async (full) => { archived = full; return 'C:/desk-node/outputs/x.log'; });
  assert.equal(r.truncated, true);
  assert.equal(archived, text);
  assert.ok(r.text.length <= 30000);
  const [head, tail] = r.text.split(/\n\n… \[desk-node:.*\] …\n\n/);
  assert.ok(Math.abs(head.length / (head.length + tail.length) - 0.2) < 0.01);
  assert.match(r.text, /full output: C:\/desk-node\/outputs\/x\.log/);
  assert.deepEqual(await boundText('short', () => { throw new Error('no archive'); }), { text: 'short', truncated: false });
});

test('calls: same callId returns cached result; different input conflicts; unfinished is unknown', async () => {
  const dir = tmp();
  let runs = 0;
  const c = new CallCache(dir);
  const fn = async () => ({ ok: true, text: String(++runs) });
  const [a, b] = await Promise.all([c.run('id1', 'fp', fn), c.run('id1', 'fp', fn)]);
  assert.equal(a.text, '1');
  assert.equal(b.text, '1');
  const again = await new CallCache(dir).run('id1', 'fp', fn);
  assert.equal(again.text, '1');
  assert.equal(again.cached, true);
  assert.equal((await c.run('id1', 'other', fn)).error.code, 'CONFLICT');
  writeFileSync(c.file('id2'), JSON.stringify({ fp: 'fp', state: 'started' }));
  assert.equal((await c.run('id2', 'fp', fn)).error.code, 'CALL_OUTCOME_UNKNOWN');
  assert.equal(runs, 1);
});

test('files: atomic write checks expected etag; keyed lock serializes', async () => {
  const file = path.join(tmp(), 'sub', 'a.txt');
  await writeAtomic(file, Buffer.from('one'), null);
  assert.equal(readFileSync(file, 'utf8'), 'one');
  await assert.rejects(writeAtomic(file, Buffer.from('two'), null), (e) => e.code === 'STALE_ETAG');
  await writeAtomic(file, Buffer.from('two'), await currentTag(file));
  assert.equal(readFileSync(file, 'utf8'), 'two');
  const lock = new KeyedLock(), order = [];
  await Promise.all([1, 2, 3].map((i) => lock.run('k', async () => { order.push(`s${i}`); await new Promise((r) => setTimeout(r, 5)); order.push(`e${i}`); })));
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2', 's3', 'e3']);
});

test('paths: withDefault keeps the blocked list', () => {
  const p = new Paths({ defaultDir: 'D:\\git', blocked: ['C:\\desk-node\\data'] }).withDefault('D:/work');
  assert.equal(p.display(p.resolve('a.txt')), 'a.txt');
  assert.equal(p.resolve('a.txt'), 'D:\\work\\a.txt');
  assert.equal(p.isBlocked(p.resolve('C:/desk-node/data/token')), true);
});

test('paths: denyPaths', async () => {
  const p = new Paths({ defaultDir: 'D:\\git', blocked: ['C:\\desk-node\\data'], denied: ['D:/git/secret', '/e/私有/', 'd:\\Vault\\'] });
  assert.deepEqual(p.denied, ['D:\\git\\secret', 'E:\\私有', 'D:\\Vault']);
  for (const x of ['secret', 'secret/a.txt', 'D:/GIT/Secret/x', '/e/私有/文件.md', 'D:/vault']) assert.equal(p.blockedBy(p.resolve(x)), 'denied', x);
  for (const x of ['secrets/a.txt', 'D:/git', 'E:/私有2/x', 'D:/vaults']) assert.equal(p.blockedBy(p.resolve(x)), null, x);
  assert.equal(p.blockedBy(p.resolve('C:/desk-node/data/token')), 'internal');
  await assert.rejects(p.check('secret/a.txt'), (e) => e.code === 'PATH_DENIED');
  await assert.rejects(p.check('C:/desk-node/data/token'), (e) => e.code === 'PATH_BLOCKED');
  assert.equal(p.withDefault('D:/work').blockedBy(p.resolve('D:/git/secret/x')), 'denied');
  assert.deepEqual(p.deniedWithin('D:\\git'), ['D:\\git\\secret']);
  assert.deepEqual(p.deniedWithin('D:\\git\\secret\\sub'), []);
  assert.deepEqual(p.deniedWithin('D:\\'), ['D:\\git\\secret', 'D:\\Vault']);
  for (const bad of ['relative/x', '/tmp/x']) assert.throws(() => new Paths({ defaultDir: 'D:/git', denied: [bad] }), bad);
});

test('grep output: blocked and denied files dropped by exact path', () => {
  const p = new Paths({ defaultDir: 'D:\\git', denied: ['D:/git/secret'] });
  assert.deepEqual(grepLines(p, 'a.txt\0secret/x.txt\0secrets/y.txt\0', true), ['a.txt', 'secrets/y.txt']);
  const content = 'a.txt\x003:hit\n--\nsecret/x.txt\x001:hit\nsecret/x.txt\x002-ctx\n--\nb.txt\x009:hit\n';
  assert.deepEqual(grepLines(p, content, false), ['a.txt:3:hit', '--', 'b.txt:9:hit']);
  assert.deepEqual(grepLines(p, 'D:/git/secret/x\x002\nD:/other/x\x001\n', false), ['D:/other/x:1']);
});

test('image: type and size from headers', () => {
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(probeImage(png), { mimeType: 'image/png', width: 640, height: 480 });
  const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
  assert.deepEqual(probeImage(gif), { mimeType: 'image/gif', width: 32, height: 16 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(probeImage(jpg), { mimeType: 'image/jpeg', width: 400, height: 300 });
  const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'latin1'); webp.write('WEBPVP8X', 8, 'latin1'); webp.writeUIntLE(9999, 24, 3); webp.writeUIntLE(99, 27, 3);
  assert.deepEqual(probeImage(webp), { mimeType: 'image/webp', width: 10000, height: 100 });
  assert.equal(probeImage(Buffer.from('not an image')), null);
});

test('output summary: short passes; long becomes head + key lines + tail with one-line footer', async () => {
  const archived = [];
  const archive = async (t) => { archived.push(t); return 'C:/desk-node/outputs/x.log'; };
  assert.deepEqual(await summarizeOutput('a\nb', archive), { text: 'a\nb', truncated: false });
  assert.equal(archived.length, 0);
  const lines = Array.from({ length: 3000 }, (_, i) => `step ${i + 1}`);
  lines[999] = 'src/a.c:12: error: expected ;'; lines[1999] = 'src/a.c:12: error: expected ;'; lines[1499] = 'Traceback (most recent call last):';
  lines[2] = 'warning in the head (not repeated)';
  const r = await summarizeOutput(lines.join('\n'), archive);
  const out = r.text.split('\n');
  assert.equal(r.truncated, true);
  assert.equal(archived[0], lines.join('\n'));
  assert.deepEqual(out.slice(0, 20), lines.slice(0, 20));
  assert.match(out[20], /lines 21-2940 omitted; 2 of them match/);
  assert.equal(out[21], 'L1000: src/a.c:12: error: expected ;');
  assert.equal(out[22], 'L1500: Traceback (most recent call last):');
  assert.deepEqual(out.slice(24, 84), lines.slice(2940));
  assert.equal(out.at(-1), '[desk-node: 3000 lines, 28.3 KB; shown 1-20, 2941-3000, 2 matching lines; full output: C:/desk-node/outputs/x.log]');
  assert.doesNotMatch(out.at(-1), /No need to re-run/);
  assert.equal(out.length, 20 + 1 + 2 + 1 + 60 + 1);
});

test('output v2: long lines are clipped at 500 chars with the omitted length; key lines capped at 20', async () => {
  assert.equal(clipLine('x'.repeat(501)), `${'x'.repeat(500)}… [+1 chars]`);
  const r = await summarizeOutput(`ok\n${'y'.repeat(7000)}\nend`, async () => 'A.log');
  assert.match(r.text, /^ok\ny{500}… \[\+6500 chars\]\nend\n\[desk-node: 3 lines, .* KB; shown 1-3; full output: A\.log\]$/);
  const many = Array.from({ length: 500 }, (_, i) => (i > 30 && i < 400 ? `FAIL test ${i}` : `ok ${i}`)).join('\n');
  const m = await summarizeOutput(many, async () => 'A.log');
  assert.equal(m.text.split('\n').filter((l) => /^L\d+: FAIL/.test(l)).length, 20);
});

test('output summary: a 600-character Chinese line passes through unchanged', async () => {
  const line = '中'.repeat(600);
  let archived = false;
  const result = await summarizeOutput(line, async () => { archived = true; return 'A.log'; });
  assert.deepEqual(result, { text: line, truncated: false });
  assert.equal(archived, false);
});

test('output retention: older than 7 days or over the size cap, oldest first; kept files survive', async () => {
  const { utimesSync } = await import('node:fs');
  const dir = tmp();
  const mk = (name, size, daysOld) => { const f = path.join(dir, name); writeFileSync(f, 'x'.repeat(size)); const t = Date.now() / 1000 - daysOld * 86400; utimesSync(f, t, t); return f; };
  mk('old.log', 10, 8); const keep = mk('keep.log', 10, 9); mk('a.log', 100, 3); mk('b.log', 100, 2); mk('c.log', 100, 1); mk('note.txt', 10, 30);
  const r = await pruneOutputs([dir], { maxBytes: 250, keep: (f) => f === keep });
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(dir).sort(), ['b.log', 'c.log', 'keep.log', 'note.txt']);
  assert.equal(r.removed, 2);
});

test('runForeground: aborting the signal terminates the command and its children', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const r = await runForeground({ command: `(sleep 5; echo child > ${dir}/child.txt) & sleep 5; echo finished > ${dir}/f.txt`, cwd: dir, timeoutMs: 20000, tmpDir: dir, bash: '/bin/bash', signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  await new Promise((res) => setTimeout(res, 5500));
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(`${dir}/f.txt`), false);
  assert.equal(existsSync(`${dir}/child.txt`), false);
});
