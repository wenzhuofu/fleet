import assert from 'node:assert/strict';
import test from 'node:test';
import { createRpcServer } from '../../src/server.mjs';

test('server: no total request time limit, so slow large uploads are not cut off with 408', () => {
  const server = createRpcServer({ token: 'x'.repeat(32), tools: { names: [] }, calls: {}, config: {}, version: '0', log: () => {}, incomingDir: '.' });
  assert.equal(server.requestTimeout, 0);
});
