import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Paths } from '../../src/paths.mjs';
import { createTools } from '../../src/tools.mjs';

test('Bash full and BashJob output bypass the summary', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-node-tools-'));
  const work = path.join(dir, 'work'), dataDir = path.join(dir, 'data');
  mkdirSync(work); mkdirSync(dataDir);
  // This test exercises output handling, not the node's Windows path syntax.
  // Keep the real Windows adapter there; use native fixture paths on Linux CI.
  const paths = process.platform === 'win32' ? new Paths({ defaultDir: work }) : {
    defaultDir: work, check: async (input) => path.resolve(work, input), display: (file) => file,
  };
  const tools = createTools({
    paths, home: dir, dataDir, outputsDir: path.join(dir, 'outputs'),
    bash: process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', git: 'git', rg: 'rg',
  });
  const ctx = { sid: 'd3-test' };
  const command = 'for i in {1..130}; do echo line-$i; done';
  try {
    const summarized = await tools.dispatch('Bash', { command }, ctx);
    assert.equal(summarized.ok, true, JSON.stringify(summarized.error));
    assert.equal(summarized.data.truncated, true);
    assert.match(summarized.text, /\[desk-node: 130 lines/);

    const full = await tools.dispatch('Bash', { command, full: true }, ctx);
    assert.equal(full.data.truncated, false);
    assert.equal(full.text.split('\n').filter((line) => /^line-\d+$/.test(line)).length, 130);
    assert.doesNotMatch(full.text, /\[desk-node:/);

    const capped = await tools.dispatch('Bash', { command: 'for i in {1..10}; do printf "%04000d\\n" "$i"; done', full: true }, ctx);
    assert.equal(capped.data.truncated, true);
    assert.ok(capped.text.length <= 30000);
    assert.match(capped.text, /full output: /);
    assert.ok(capped.data.archive);

    const started = await tools.dispatch('BashJob', { action: 'start', command }, ctx);
    const id = /Started job ([^ ]+)/.exec(started.text)?.[1];
    assert.ok(id);
    const status = await tools.dispatch('BashJob', { action: 'status', id, wait_ms: 30000 }, ctx);
    assert.match(status.text, /\[desk-node: 130 lines/);
    const output = await tools.dispatch('BashJob', { action: 'output', id }, ctx);
    assert.equal(output.text.split('\n').filter((line) => /^line-\d+$/.test(line)).length, 130);
    assert.doesNotMatch(output.text, /\[desk-node: lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bash and BashJob: a missing working directory is NOT_FOUND, not a shell spawn error', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-node-tools-'));
  const work = path.join(dir, 'gone'), dataDir = path.join(dir, 'data');
  mkdirSync(dataDir);
  const paths = process.platform === 'win32' ? new Paths({ defaultDir: work }) : {
    defaultDir: work, check: async (input) => path.resolve(work, input), display: (file) => file,
  };
  const tools = createTools({ paths, home: dir, dataDir, outputsDir: path.join(dir, 'outputs'), bash: process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', git: 'git', rg: 'rg' });
  try {
    for (const [tool, args] of [['Bash', { command: 'pwd' }], ['BashJob', { action: 'start', command: 'pwd' }]]) {
      const r = await tools.dispatch(tool, args, { sid: 'cwd-test' });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'NOT_FOUND');
      assert.match(r.error.message, /Working directory does not exist/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
