import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveBinding } from '../src/binding.mjs';
import { Machines } from '../src/machines.mjs';

test('binding: nearest .desk.json above the cwd; env overrides; nothing means machines.json default', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desk-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'proj'), deep = path.join(project, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  assert.deepEqual(resolveBinding({ env: {}, cwd: deep }), {});
  writeFileSync(path.join(project, '.desk.json'), JSON.stringify({ machine: 'pc-home', dir: 'D:\\项目 目录' }));
  assert.deepEqual(resolveBinding({ env: {}, cwd: deep }), { machine: 'pc-home', dir: 'D:\\项目 目录', source: path.join(project, '.desk.json') });
  assert.equal(resolveBinding({ env: { DESK_DEFAULT_MACHINE: 'lab' }, cwd: deep }).machine, 'lab');
  writeFileSync(path.join(deep, '.desk.json'), '{ broken');
  assert.match(resolveBinding({ env: {}, cwd: deep }).problem, /not valid JSON/);
});

test('binding: a bad .desk.json is reported on every call, never silently replaced by the default machine', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desk-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'm.json'), JSON.stringify({ default: 'pc', machines: { pc: { url: 'http://127.0.0.1:1', tokenFile: path.join(root, 't'), os: 'windows' } } }));
  const file = path.join(root, '.desk.json');
  writeFileSync(file, JSON.stringify({ machine: 'nope', dir: 'D:/x' }));
  const b = resolveBinding({ env: {}, cwd: root });
  const m = new Machines({ file: path.join(root, 'm.json'), stateDir: root, defaultMachine: b.machine, defaultDir: b.dir, defaultSource: b.source, bindingProblem: b.problem });
  assert.match(m.envProblem(), /machine nope is not in machines.json/);
  assert.ok(m.envProblem().startsWith(file));
  const broken = new Machines({ file: path.join(root, 'm.json'), stateDir: root, bindingProblem: 'bad file' });
  assert.throws(() => broken.get('pc'), { code: 'BAD_CONFIG', message: 'bad file' });
});
