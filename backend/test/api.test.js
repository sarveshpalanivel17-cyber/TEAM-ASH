import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { SimulationManager } from '../src/manager.js';

const classDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../engine/out');
let server, base, manager;
before(async () => {
  manager = new SimulationManager({ javaBin: process.env.JAVA_BIN || 'java', classDir });
  server = createApp(manager).listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { manager.shutdown(); server.close(); });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('health', async () => { const j = await (await fetch(base + '/api/health')).json(); assert.equal(j.status, 'ok'); assert.equal(j.engineBuilt, true); });
test('invalid settings -> 400 with messages', async () => {
  const r = await post('/api/simulations', { readers: 500 }); assert.equal(r.status, 400); assert.ok((await r.json()).errors.length);
});
test('malformed JSON -> 400, unknown route -> 404, unknown run -> 404', async () => {
  assert.equal((await post('/api/simulations', '{bad')).status, 400);
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/api/simulations/xyz')).status, 404);
  assert.equal((await post('/api/simulations/xyz/cancel', {})).status, 404);
});
test('start, stream SSE to completion, fetch result', async () => {
  const r = await post('/api/simulations', { readers: 4, writers: 2, ops: 2 }); assert.equal(r.status, 202);
  const { id } = await r.json();
  const res = await fetch(`${base}/api/simulations/${id}/events`);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  let text = ''; for await (const chunk of res.body) text += Buffer.from(chunk).toString();
  assert.ok(text.includes('"type":"GRANTED_READ"')); assert.ok(text.includes('event: done'));
  const run = await (await fetch(`${base}/api/simulations/${id}`)).json();
  assert.equal(run.status, 'completed'); assert.equal(run.result.completed, 12);
});

test('pause/resume endpoints and 404/409 handling', async () => {
  assert.equal((await post('/api/simulations/xyz/pause', {})).status, 404);
  const { id } = await (await post('/api/simulations', { readers: 0, writers: 6, ops: 1, threads: 2, writeMs: 80 })).json();
  assert.equal((await post(`/api/simulations/${id}/pause`, {})).status, 200);
  assert.equal((await post(`/api/simulations/${id}/pause`, {})).status, 409);
  assert.equal((await post('/api/tests/engine', {})).status, 409); // simulation running
  assert.equal((await post(`/api/simulations/${id}/resume`, {})).status, 200);
  for (let i = 0; i < 50; i++) { const r = await (await fetch(`${base}/api/simulations/${id}`)).json(); if (r.status !== 'running') break; await new Promise((r2) => setTimeout(r2, 100)); }
});
test('engine tests endpoint: not_run, then passed', async () => {
  assert.equal((await (await fetch(base + '/api/tests/engine')).json()).status, 'not_run');
  const r = await (await post('/api/tests/engine', {})).json(); assert.equal(r.status, 'passed');
  assert.equal((await (await fetch(base + '/api/tests/engine')).json()).status, 'passed');
});
