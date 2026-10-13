import { spawn } from 'node:child_process';

/** Runs the real Java engine test suite (class `Tests`) and parses its PASS/FAIL lines. */
export class EngineTestRunner {
  constructor({ javaBin = 'java', classDir, timeoutMs = 120000 }) { Object.assign(this, { javaBin, classDir, timeoutMs }); this.running = false; this.last = null; }

  run() {
    if (this.running) return Promise.reject(Object.assign(new Error('Engine tests are already running'), { status: 409 }));
    this.running = true;
    const started = Date.now();
    return new Promise((resolve) => {
      let out = '', err = '', settled = false;
      const done = (extra) => {
        if (settled) return; settled = true; clearTimeout(timer); this.running = false;
        const tests = out.split('\n').map((l) => /^(PASS|FAIL) (.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[2], ok: m[1] === 'PASS' }));
        const failed = tests.filter((t) => !t.ok).length;
        const status = extra?.error ? 'error' : tests.length && !failed && /RESULT passed=\d+ failed=0/.test(out) ? 'passed' : tests.length ? 'failed' : 'error';
        this.last = { status, ranAt: new Date().toISOString(), durationMs: Date.now() - started, passed: tests.length - failed, failed, tests, error: extra?.error || (status === 'error' ? err.trim().slice(-500) || 'No test output' : null) };
        resolve(this.last);
      };
      let proc;
      try { proc = spawn(this.javaBin, ['-cp', this.classDir, 'Tests'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
      catch (e) { return done({ error: `Cannot launch Java: ${e.message}` }); }
      const timer = setTimeout(() => { proc.kill('SIGKILL'); done({ error: `Timed out after ${this.timeoutMs} ms` }); }, this.timeoutMs);
      proc.on('error', (e) => done({ error: `Cannot launch Java (${this.javaBin}): ${e.message}` }));
      proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      proc.on('close', () => done());
    });
  }
}
