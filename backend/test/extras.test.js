import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../src/ratelimit.js';
import { EngineTestRunner } from '../src/engineTests.js';
import { SimulationManager } from '../src/manager.js';
import { validateConfig } from '../src/validate.js';

const classDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../engine/out');
const javaBin = process.env.JAVA_BIN || 'java';

test('rate limiter blocks after max and resets after the window', () => {
  let t = 0; const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  const call = () => { const r = { code: 200, h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } }; let nexted = false; rl({ ip: '1.2.3.4' }, r, () => { nexted = true; }); return { r, nexted }; };
  assert.ok(call().nexted); assert.ok(call().nexted);
  const blocked = call(); assert.equal(blocked.nexted, false); assert.equal(blocked.r.code, 429); assert.ok(blocked.r.h['Retry-After']);
  t = 1500; assert.ok(call().nexted); rl.stop();
});

test('engine test runner executes the real Java suite', async () => {
  const runner = new EngineTestRunner({ javaBin, classDir });
  const r = await runner.run();
  assert.equal(r.status, 'passed'); assert.equal(r.failed, 0); assert.ok(r.passed >= 17);
  assert.ok(r.tests.every((t) => t.ok));
});

test('engine test runner reports a missing Java instead of hanging', async () => {
  const r = await new EngineTestRunner({ javaBin: 'definitely-not-java', classDir }).run();
  assert.equal(r.status, 'error'); assert.match(r.error, /Cannot launch Java/);
});

test('pause stops new work, resume finishes the run', async () => {
  const m = new SimulationManager({ javaBin, classDir });
  const run = m.start(validateConfig({ readers: 0, writers: 10, ops: 2, threads: 2, writeMs: 100 }).config);
  m.setPaused(run.id, true);
  assert.throws(() => m.setPaused(run.id, true), { status: 409 });
  await new Promise((r) => setTimeout(r, 700)); const n = run.events.length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(run.events.length, n, 'no events while paused'); assert.equal(run.status, 'running');
  assert.ok(run.events.some((e) => e.type === 'PAUSED'));
  m.setPaused(run.id, false);
  await new Promise((res) => (run.finishedAt ? res() : run.bus.once('done', res)));
  assert.equal(run.status, 'completed'); assert.equal(run.result.completed, 20);
  assert.throws(() => m.setPaused(run.id, true), { status: 409 });
});
