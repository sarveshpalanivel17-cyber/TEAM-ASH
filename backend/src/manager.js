import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class SimulationManager {
  constructor({ javaBin = 'java', classDir, timeoutMs = 60000, maxRuns = 20, maxEvents = 5000 }) {
    Object.assign(this, { javaBin, classDir, timeoutMs, maxRuns, maxEvents });
    this.runs = new Map();
  }

  get active() { return [...this.runs.values()].find((r) => r.status === 'running'); }
  get(id) { const r = this.runs.get(id); if (!r) throw new HttpError(404, 'Simulation not found'); return r; }
  list() { return [...this.runs.values()].map((r) => this.summary(r)).reverse(); }

  summary(r) {
    return { id: r.id, status: r.status, paused: Boolean(r.paused), config: r.config, startedAt: r.startedAt, finishedAt: r.finishedAt, eventCount: r.events.length, error: r.error, result: r.result };
  }

  /** Only one simulation may run at a time; config must already be validated. */
  start(config) {
    if (this.active) throw new HttpError(409, 'A simulation is already running; cancel it or wait for it to finish');
    const run = { id: randomUUID(), config, status: 'running', startedAt: Date.now(), finishedAt: null, events: [], result: null, error: null, bus: new EventEmitter(), proc: null };
    run.bus.setMaxListeners(50);
    this.runs.set(run.id, run);
    this.prune();
    const args = ['-cp', this.classDir, 'osh.Simulator', ...Object.entries(config).map(([k, v]) => `${k}=${v}`)];
    let buf = '', stderr = '';
    try { run.proc = spawn(this.javaBin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch (e) { this.finish(run, 'failed', `Cannot launch Java: ${e.message}`); return run; }
    run.proc.stdin.on('error', () => {});
    run.proc.on('error', (e) => this.finish(run, 'failed', `Cannot launch Java (${this.javaBin}): ${e.message}`));
    run.proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    run.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { this.onLine(run, buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    run.proc.on('close', (code) => {
      if (buf.trim()) this.onLine(run, buf);
      if (run.status !== 'running') return this.finish(run, run.status, run.error);
      if (code === 0 && run.result) this.finish(run, 'completed');
      else if (run.result) this.finish(run, 'completed', 'Simulation finished but one or more checks failed (see checks panel)');
      else this.finish(run, 'failed', run.error || stderr.trim() || `Java exited with code ${code}`);
    });
    run.remaining = this.timeoutMs; this.arm(run);
    return run;
  }

  arm(run) {
    run.armedAt = Date.now(); clearTimeout(run.timer);
    run.timer = setTimeout(() => this.stop(run, 'timeout', `Timed out after ${this.timeoutMs} ms of running time`), run.remaining);
  }

  /** Pause/resume the workload (the Java driver stops issuing new requests). Paused time does not count toward the timeout. */
  setPaused(id, paused) {
    const run = this.get(id);
    if (run.status !== 'running') throw new HttpError(409, `Simulation is not running (status: ${run.status})`);
    if (run.paused === paused) throw new HttpError(409, paused ? 'Simulation is already paused' : 'Simulation is not paused');
    run.paused = paused;
    if (paused) { run.remaining -= Date.now() - run.armedAt; clearTimeout(run.timer); } else this.arm(run);
    run.proc.stdin.write(paused ? 'pause\n' : 'resume\n');
    return run;
  }

  onLine(run, line) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'SUMMARY') run.result = ev;
    else if (ev.type === 'ERROR' && !run.error) run.error = ev.message;
    if (run.events.length < this.maxEvents) { run.events.push(ev); run.bus.emit('event', ev, run.events.length - 1); }
  }

  stop(run, status, error = null) {
    if (run.status !== 'running') return false;
    run.status = status; run.error = error;
    run.proc?.kill('SIGKILL');
    return true;
  }

  cancel(id) {
    const run = this.get(id);
    if (!this.stop(run, 'cancelled', 'Cancelled by user')) throw new HttpError(409, `Simulation is not running (status: ${run.status})`);
    return run;
  }

  finish(run, status, error = null) {
    if (run.finishedAt) return;
    clearTimeout(run.timer);
    run.status = status; run.error = error ?? run.error; run.finishedAt = Date.now();
    run.bus.emit('done', this.summary(run));
  }

  prune() {
    for (const [id, r] of this.runs) { if (this.runs.size <= this.maxRuns) break; if (r.status !== 'running') this.runs.delete(id); }
  }

  shutdown() { for (const r of this.runs.values()) this.stop(r, 'cancelled', 'Server shutting down'); }
}
