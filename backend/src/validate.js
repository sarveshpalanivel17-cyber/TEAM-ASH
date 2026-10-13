const LIMITS = {
  readers: [0, 100], writers: [0, 100], ops: [1, 100], threads: [1, 16], batch: [0, 100],
  readMs: [0, 200], writeMs: [0, 200], cancelPct: [0, 50], seed: [0, 2147483647],
};
const DEFAULTS = { policy: 'FIFO', readers: 10, writers: 5, ops: 4, threads: 8, batch: 0, readMs: 5, writeMs: 10, cancelPct: 0, seed: 42, scenario: 'none' };
export const POLICIES = ['FIFO', 'WRITER_PREF'];
export const SCENARIOS = ['none', 'cancel', 'batch'];

/** Returns { config, errors }. config contains only whitelisted, integer/enum values. */
export function validateConfig(body) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { config: null, errors: ['Request body must be a JSON object'] };
  const config = { ...DEFAULTS };
  if (body.policy !== undefined) {
    if (!POLICIES.includes(body.policy)) errors.push(`policy must be one of ${POLICIES.join(', ')}`); else config.policy = body.policy;
  }
  if (body.scenario !== undefined) {
    if (!SCENARIOS.includes(body.scenario)) errors.push(`scenario must be one of ${SCENARIOS.join(', ')}`); else config.scenario = body.scenario;
  }
  for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(`${key} must be an integer`);
    else if (v < lo || v > hi) errors.push(`${key} must be between ${lo} and ${hi}`);
    else config[key] = v;
  }
  const total = (config.readers + config.writers) * config.ops;
  if (!errors.length && config.scenario !== 'none') return { config, errors };
  if (!errors.length && total < 1) errors.push('Workload is empty: need at least one reader or writer');
  if (!errors.length && total > 100) errors.push(`(readers + writers) * ops must be at most 100 requests, got ${total}`);
  return { config: errors.length ? null : config, errors };
}
