import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/validate.js';

test('defaults are valid', () => { const { config, errors } = validateConfig({}); assert.deepEqual(errors, []); assert.equal(config.policy, 'FIFO'); });
test('accepts read-heavy and write-heavy presets', () => {
  assert.deepEqual(validateConfig({ readers: 95, writers: 5, ops: 1, policy: 'WRITER_PREF' }).errors, []);
  assert.deepEqual(validateConfig({ readers: 5, writers: 95, ops: 1 }).errors, []);
});
test('rejects more than 100 requests', () => assert.match(validateConfig({ readers: 60, writers: 60, ops: 1 }).errors[0], /at most 100/));
test('rejects more than 16 threads', () => assert.ok(validateConfig({ threads: 17 }).errors.length));
test('rejects empty workload', () => assert.match(validateConfig({ readers: 0, writers: 0 }).errors[0], /empty/));
test('rejects bad types, ranges and policies', () => {
  for (const bad of [{ readers: '5' }, { readers: 1.5 }, { writers: -1 }, { batch: 101 }, { policy: 'FIFO; rm -rf /' }, { cancelPct: 51 }, { ops: 0 }])
    assert.ok(validateConfig(bad).errors.length, JSON.stringify(bad));
});
test('rejects non-object bodies and drops unknown fields', () => {
  assert.ok(validateConfig(null).errors.length); assert.ok(validateConfig([]).errors.length);
  assert.equal('cmd' in validateConfig({ cmd: 'x' }).config, false);
});
test('scenario must be a known value; demos skip workload-size limits', () => {
  assert.ok(validateConfig({ scenario: 'rm -rf' }).errors.length);
  assert.deepEqual(validateConfig({ scenario: 'cancel', readers: 0, writers: 0 }).errors, []);
  assert.equal(validateConfig({}).config.scenario, 'none');
});
