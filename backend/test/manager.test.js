import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulationManager } from '../src/manager.js';
import { validateConfig } from '../src/validate.js';

const classDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../engine/out');
const mk = (o = {}) => new SimulationManager({ javaBin: process.env.JAVA_BIN || 'java', classDir, ...o });
const cfg = (o) => validateConfig(o).config;
const finished = (run) => new Promise((res) => (run.finishedAt ? res() : run.bus.once('done', res)));

test('runs a real Java simulation and reports passing checks', async () => {
  const m = mk(); const run = m.start(cfg({ readers: 6, writers: 3, ops: 2, policy: 'WRITER_PREF', batch: 3 }));
  await finished(run);
  assert.equal(run.status, 'completed');
  assert.equal(run.result.completed, 18);
  assert.equal(run.result.violations, 0);
  assert.ok(Object.values(run.result.checks).every(Boolean));
  assert.ok(run.result.maxConcurrentReaders <= 3);
  assert.ok(run.events.some((e) => e.type === 'GRANTED_WRITE'));
});

test('rejects overlapping runs and supports cancellation', async () => {
  const m = mk(); const run = m.start(cfg({ readers: 0, writers: 20, ops: 5, writeMs: 200 }));
  assert.throws(() => m.start(cfg({})), { status: 409 });
  m.cancel(run.id); await finished(run);
  assert.equal(run.status, 'cancelled');
  assert.throws(() => m.cancel(run.id), { status: 409 });
  assert.throws(() => m.get('nope'), { status: 404 });
});

test('reports launch failures instead of hanging', async () => {
  const m = mk({ javaBin: 'definitely-not-java' }); const run = m.start(cfg({}));
  await finished(run);
  assert.equal(run.status, 'failed'); assert.match(run.error, /Cannot launch Java/);
});

test('timeout stops long simulations', async () => {
  const m = mk({ timeoutMs: 300 }); const run = m.start(cfg({ readers: 0, writers: 20, ops: 5, writeMs: 200 }));
  await finished(run); assert.equal(run.status, 'timeout');
});

test('cancellation demo: cancelled writer is skipped and the reader behind it is admitted', async () => {
  const m = mk(); const run = m.start(cfg({ scenario: 'cancel' })); await finished(run);
  assert.equal(run.status, 'completed'); assert.equal(run.result.cancelled, 1); assert.equal(run.result.completed, 2);
  const types = run.events.filter((e) => e.type !== 'NOTE').map((e) => `${e.type}:${e.ticket}`);
  assert.ok(types.indexOf('GRANTED_READ:3') > types.indexOf('CANCELLED:2'));
  assert.ok(!types.includes('GRANTED_WRITE:2')); assert.ok(Object.values(run.result.checks).every(Boolean));
});

test('batching demo: batch limit 3 is enforced by the engine', async () => {
  const m = mk(); const run = m.start(cfg({ scenario: 'batch', batch: 3 })); await finished(run);
  assert.equal(run.result.completed, 8); assert.equal(run.result.maxConcurrentReaders, 3);
  const grants = run.events.filter((e) => e.type.startsWith('GRANTED')).map((e) => e.ticket);
  assert.deepEqual(grants, [1, 2, 3, 4, 5, 6, 7, 8]); assert.ok(Object.values(run.result.checks).every(Boolean));
});
