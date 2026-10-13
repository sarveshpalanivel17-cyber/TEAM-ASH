import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

export const fmt = (n, d = 1) => (typeof n === 'number' ? n.toFixed(d) : '—');

export function downloadCsv(name, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

/** Derives all chart/summary data from the real event stream. */
export function deriveStats(events) {
  const wait = { R: [], W: [] }; let done = 0, rDone = 0, wDone = 0, cancelled = 0;
  const queue = [], thr = [];
  const step = Math.max(1, Math.floor(events.length / 300));
  events.forEach((e, i) => {
    if (e.waitMs !== undefined) wait[e.kind].push(e.waitMs);
    if (e.type === 'READ_COMPLETED') { done++; rDone++; }
    if (e.type === 'WRITE_COMPLETED') { done++; wDone++; }
    if (e.type === 'CANCELLED') cancelled++;
    if (i % step === 0 || i === events.length - 1) { queue.push({ t: Math.round(e.t), queue: e.queueLen }); thr.push({ t: Math.round(e.t), completed: done }); }
  });
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const max = (a) => (a.length ? Math.max(...a) : 0);
  return {
    queue, thr,
    waits: [{ name: 'Readers', avg: avg(wait.R), max: max(wait.R) }, { name: 'Writers', avg: avg(wait.W), max: max(wait.W) }],
    counts: [{ name: 'Reads', value: rDone }, { name: 'Writes', value: wDone }, { name: 'Cancelled', value: cancelled }],
  };
}

export function Card({ title, children, right, id }) {
  return (
    <section id={id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-slate-100 uppercase">{title}</h2>{right}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }) => <div className="text-sm text-slate-500 border border-dashed border-slate-800 rounded-lg p-6 text-center">{children}</div>;
const btn = 'rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed';
export const Btn = ({ kind = 'ghost', className = '', ...p }) => (
  <button {...p} className={`${btn} ${kind === 'primary' ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400' : kind === 'danger' ? 'bg-rose-600 text-white hover:bg-rose-500' : 'border border-slate-700 hover:bg-slate-800'} ${className}`} />
);

const PRESETS = {
  'Read-heavy (95R / 5W)': { readers: 95, writers: 5, ops: 1 },
  'Write-heavy (5R / 95W)': { readers: 5, writers: 95, ops: 1 },
  'Balanced (10R / 10W x2)': { readers: 10, writers: 10, ops: 2 },
};

export function ConfigPanel({ config, setConfig, busy, paused, onStart, onCancel, onPause, onReset, onCompare }) {
  const total = (config.readers + config.writers) * config.ops;
  const bad = total < 1 || total > 100;
  const num = (key, label, min, max, hint) => (
    <label className="block text-xs text-slate-400">{label}
      <input type="number" min={min} max={max} value={config[key]} disabled={busy}
        onChange={(e) => setConfig({ ...config, [key]: e.target.value === '' ? 0 : Math.trunc(Number(e.target.value)) })} />
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
  return (
    <Card title="Simulation configuration">
      <div className="flex flex-wrap gap-2 mb-3">
        {Object.entries(PRESETS).map(([name, p]) => <Btn key={name} disabled={busy} onClick={() => setConfig({ ...config, ...p })} className="text-xs">{name}</Btn>)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs text-slate-400 col-span-2">Scheduling policy
          <select value={config.policy} disabled={busy} onChange={(e) => setConfig({ ...config, policy: e.target.value })}>
            <option value="FIFO">FIFO (strict arrival order)</option>
            <option value="WRITER_PREF">Writer preference</option>
          </select>
        </label>
        {num('readers', 'Readers (clients)', 0, 100)}
        {num('writers', 'Writers (clients)', 0, 100)}
        {num('ops', 'Operations per client', 1, 100, 'workload size')}
        {num('threads', 'Worker threads', 1, 16, 'max 16')}
        {num('batch', 'Reader batch limit', 0, 100, '0 = unlimited')}
        {num('cancelPct', 'Cancel % of requests', 0, 50, 'cancelled while waiting')}
        {num('readMs', 'Read time (ms)', 0, 200)}
        {num('writeMs', 'Write time (ms)', 0, 200)}
      </div>
      <p className={`mt-3 text-xs ${bad ? 'text-rose-400' : 'text-slate-400'}`}>
        Total logical requests: <b>{total}</b> {bad && '(must be 1–100)'}
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        <Btn kind="primary" disabled={busy || bad} onClick={onStart}>{busy ? (paused ? 'Paused' : 'Running…') : 'Start'}</Btn>
        <Btn disabled={!busy} onClick={() => onPause(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
        <Btn kind="danger" disabled={!busy} onClick={onCancel}>Cancel</Btn>
        <Btn disabled={busy} onClick={onReset}>Reset</Btn>
        <Btn disabled={busy || bad} onClick={onCompare} className="ml-auto">Compare FIFO vs Writer-pref</Btn>
      </div>
    </Card>
  );
}

export function QueueViz({ events, status }) {
  const last = events[events.length - 1];
  if (!last) return <Card title="Live queue & status"><Empty>No activity yet. Start a simulation to watch the ticket queue.</Empty></Card>;
  const queue = last.queue ? last.queue.split(',') : [];
  return (
    <Card title="Live queue & status" right={<span className="text-xs text-slate-400">{status}</span>}>
      <div className="grid grid-cols-3 gap-3 mb-3 text-center">
        <Stat label="Active readers" value={last.activeReaders} />
        <Stat label="Writer active" value={last.writerActive ? 'yes' : 'no'} />
        <Stat label="Waiting" value={queue.length} />
      </div>
      <div className="min-h-[3rem] flex flex-wrap gap-1.5 mb-3">
        {queue.length === 0 && <span className="text-sm text-slate-500">Queue empty</span>}
        {queue.map((q) => (
          <span key={q} className={`px-2 py-1 rounded text-xs font-mono border ${q[0] === 'W' ? 'border-amber-500/60 text-amber-300 bg-amber-500/10' : 'border-cyan-500/60 text-cyan-300 bg-cyan-500/10'}`}>{q}</span>
        ))}
      </div>
      {last.kind === '-'
        ? <p className="text-xs text-slate-300">{last.text}</p>
        : <p className="text-xs text-slate-400">Latest event: <span className="font-mono text-slate-200">{last.type}</span> · ticket {last.kind}{last.ticket} · t={fmt(last.t, 0)} ms</p>}
    </Card>
  );
}

export const Stat = ({ label, value, sub }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
    <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    <div className="text-lg font-semibold text-slate-100">{value}</div>
    {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
  </div>
);

export function EventLog({ events }) {
  const [kind, setKind] = useState('all'); const [type, setType] = useState('all'); const [ticket, setTicket] = useState('');
  const types = useMemo(() => [...new Set(events.map((e) => e.type))], [events]);
  const rows = events.filter((e) => (kind === 'all' || e.kind === kind) && (type === 'all' || e.type === type) && (!ticket || String(e.ticket) === ticket));
  const exportCsv = () => downloadCsv('osh006-events.csv', [['t_ms', 'type', 'ticket', 'kind', 'queue', 'queueLen', 'activeReaders', 'writerActive', 'waitMs'], ...rows.map((e) => [e.t, e.type, e.ticket, e.kind, e.queue, e.queueLen, e.activeReaders, e.writerActive, e.waitMs ?? ''])]);
  return (
    <Card title="Live event log" id="log" right={<Btn disabled={!rows.length} onClick={exportCsv} className="text-xs">Download CSV</Btn>}>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All</option><option value="R">Readers</option><option value="W">Writers</option></select>
        <select value={type} onChange={(e) => setType(e.target.value)}><option value="all">All types</option>{types.map((t) => <option key={t}>{t}</option>)}</select>
        <input placeholder="Ticket #" value={ticket} onChange={(e) => setTicket(e.target.value.replace(/\D/g, ''))} />
      </div>
      {rows.length === 0 ? <Empty>{events.length ? 'No events match the filters.' : 'Events appear here as the Java engine emits them.'}</Empty> : (
        <div className="max-h-72 overflow-auto rounded-lg border border-slate-800">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-slate-900 text-slate-400"><tr><th className="text-left p-1.5">t (ms)</th><th className="text-left p-1.5">event</th><th className="text-left p-1.5">ticket</th><th className="text-left p-1.5">queue</th></tr></thead>
            <tbody>
              {rows.slice(-300).reverse().map((e, i) => (
                <tr key={i} className="border-t border-slate-800/70">
                  <td className="p-1.5 text-slate-500">{fmt(e.t, 1)}</td>
                  <td className={`p-1.5 ${e.kind === '-' ? 'text-cyan-300' : ''} ${e.type === 'CANCELLED' || e.type === 'ERROR' ? 'text-rose-400' : e.type.startsWith('GRANTED') ? 'text-emerald-400' : ''}`}>{e.kind === '-' ? `${e.type === 'NOTE' ? '' : e.type + ': '}${e.text}` : e.type}</td>
                  <td className="p-1.5">{e.kind === '-' ? '' : `${e.kind}${e.ticket}`}</td>
                  <td className="p-1.5 text-slate-400 truncate max-w-[10rem]">{e.queue || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500 mt-2">Showing the latest 300 of {rows.length} matching events ({events.length} total).</p>
    </Card>
  );
}

const tip = { contentStyle: { background: '#0f172a', border: '1px solid #1e293b', fontSize: 12 } };
const axis = { stroke: '#64748b', fontSize: 11 };

export function Charts({ stats, hasData }) {
  const box = (title, chart) => (
    <Card title={title}>{hasData ? <div className="h-56">{chart}</div> : <Empty>Run a simulation to populate this chart.</Empty>}</Card>
  );
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {box('Waiting times (ms)', <ResponsiveContainer><BarChart data={stats.waits}><CartesianGrid stroke="#1e293b" /><XAxis dataKey="name" {...axis} /><YAxis {...axis} /><Tooltip {...tip} /><Legend /><Bar dataKey="avg" name="Average" fill="#22d3ee" isAnimationActive={false} /><Bar dataKey="max" name="Maximum" fill="#3b82f6" isAnimationActive={false} /></BarChart></ResponsiveContainer>)}
      {box('Throughput: completed operations over time', <ResponsiveContainer><LineChart data={stats.thr}><CartesianGrid stroke="#1e293b" /><XAxis dataKey="t" {...axis} unit="ms" /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} /><Line dataKey="completed" stroke="#22d3ee" dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer>)}
      {box('Queue length over time', <ResponsiveContainer><LineChart data={stats.queue}><CartesianGrid stroke="#1e293b" /><XAxis dataKey="t" {...axis} unit="ms" /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} /><Line dataKey="queue" stroke="#3b82f6" dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer>)}
      {box('Reader / writer completion', <ResponsiveContainer><BarChart data={stats.counts}><CartesianGrid stroke="#1e293b" /><XAxis dataKey="name" {...axis} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} /><Bar dataKey="value" name="Operations" fill="#22d3ee" isAnimationActive={false} /></BarChart></ResponsiveContainer>)}
    </div>
  );
}

const CHECKS = {
  noReaderWriterOverlap: 'No reader/writer overlap (measured inside every critical section)',
  lockReleasedAndQueueEmpty: 'Lock released and queue empty at the end',
  allRequestsAccounted: 'Every request completed, was cancelled, or reported an error',
  policyOrderRespected: 'Policy order respected (FIFO grant order / no reader admitted past a waiting writer)',
  batchLimitRespected: 'Reader batch limit never exceeded',
};

export function ChecksPanel({ result, status, error }) {
  if (!result) return <Card title="Safety & fairness checks" id="checks"><Empty>{status === 'running' ? 'Checks are evaluated when the run finishes…' : 'No completed run yet.'}</Empty>{error && <p className="text-rose-400 text-sm mt-2">{error}</p>}</Card>;
  const all = Object.values(result.checks).every(Boolean);
  return (
    <Card title="Safety & fairness checks" id="checks" right={<span className={`text-xs px-2 py-0.5 rounded ${all ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>{all ? 'ALL PASSED' : 'FAILED'}</span>}>
      <ul className="space-y-1.5 text-sm">
        {Object.entries(CHECKS).map(([k, label]) => (
          <li key={k} className="flex gap-2"><span className={result.checks[k] ? 'text-emerald-400' : 'text-rose-400'}>{result.checks[k] ? '✓' : '✗'}</span><span>{label}</span></li>
        ))}
      </ul>
      <p className="text-xs text-slate-500 mt-3">Violations counted: {result.violations}. These checks verify the run that just executed; they do not prove the algorithm correct for all schedules (see engine unit tests).</p>
    </Card>
  );
}

export function ResultsSummary({ result, config }) {
  if (!result) return <Card title="Results summary" id="results"><Empty>Results appear after a run completes.</Empty></Card>;
  const rows = [
    ['Policy', result.policy], ['Reader batch limit', result.batch || 'unlimited'], ['Total requests', result.totalRequests], ['Completed', result.completed],
    ['Reads completed', result.readsCompleted], ['Writes completed', result.writesCompleted], ['Cancelled', result.cancelled], ['Errors', result.errors],
    ['Avg reader wait (ms)', fmt(+result.avgReaderWaitMs, 2)], ['Max reader wait (ms)', fmt(+result.maxReaderWaitMs, 2)],
    ['Avg writer wait (ms)', fmt(+result.avgWriterWaitMs, 2)], ['Max writer wait (ms)', fmt(+result.maxWriterWaitMs, 2)],
    ['Elapsed (ms)', fmt(+result.elapsedMs, 1)], ['Throughput (ops/s)', fmt(+result.throughputOpsPerSec, 1)],
    ['Max queue length', result.maxQueueLength], ['Max concurrent readers', result.maxConcurrentReaders], ['Violations', result.violations],
  ];
  return (
    <Card title="Results summary" id="results" right={<Btn className="text-xs" onClick={() => downloadCsv('osh006-results.csv', [['metric', 'value'], ...rows, ...Object.entries(config || {}).map(([k, v]) => [`config.${k}`, v])])}>Export CSV</Btn>}>
      {config?.scenario && config.scenario !== 'none' && <p className="text-xs text-amber-300 mb-2">Demo run: the driver pauses 250 ms between steps so the trace is watchable, so wait times and throughput here include that pacing and are not benchmark figures.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">{rows.map(([l, v]) => <Stat key={l} label={l} value={v} />)}</div>
    </Card>
  );
}

const CMP_ROWS = [
  ['avgReaderWaitMs', 'Avg reader wait (ms)'], ['maxReaderWaitMs', 'Max reader wait (ms)'], ['avgWriterWaitMs', 'Avg writer wait (ms)'], ['maxWriterWaitMs', 'Max writer wait (ms)'],
  ['throughputOpsPerSec', 'Throughput (ops/s)'], ['completed', 'Completed operations'], ['elapsedMs', 'Duration (ms)'], ['violations', 'Violations'],
];

export function ComparePanel({ cmp }) {
  const f = cmp.results.FIFO, w = cmp.results.WRITER_PREF;
  const note = f && w ? CMP_ROWS.slice(0, 4).map(([k, l]) => `${l}: FIFO ${fmt(+f[k], 2)} vs writer-pref ${fmt(+w[k], 2)}`).join(' · ') : null;
  return (
    <Card title="Fairness comparison: FIFO vs writer preference" id="compare">
      {cmp.status === 'idle' && <Empty>Press “Compare” to run both policies back-to-back on the current workload. Both runs are real executions of the Java engine.</Empty>}
      {cmp.error && <p className="text-rose-400 text-sm mb-2">{cmp.error}</p>}
      {cmp.status !== 'idle' && (
        <div className="overflow-auto"><table className="w-full text-sm">
          <thead className="text-slate-400 text-xs"><tr><th className="text-left p-2">Metric</th><th className="text-right p-2">FIFO</th><th className="text-right p-2">Writer preference</th></tr></thead>
          <tbody>{CMP_ROWS.map(([k, l]) => (
            <tr key={k} className="border-t border-slate-800"><td className="p-2">{l}</td><td className="p-2 text-right font-mono">{f ? fmt(+f[k], k === 'completed' || k === 'violations' ? 0 : 2) : cmp.status === 'running' ? '…' : '—'}</td><td className="p-2 text-right font-mono">{w ? fmt(+w[k], k === 'completed' || k === 'violations' ? 0 : 2) : cmp.status === 'running' ? '…' : '—'}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {note && <p className="text-xs text-slate-400 mt-3">Measured: {note}.</p>}
      <p className="text-xs text-slate-500 mt-2">Interpretation: FIFO bounds every request's wait by queue position, so neither side starves. Writer preference lets waiting writers jump ahead of newly arriving readers, which can reduce writer waits but lets a continuous stream of writers starve readers. These are single short runs with sleep-based work; timings vary run to run, so treat differences as indicative, not statistically significant.</p>
    </Card>
  );
}

export function Explainer() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card title="The reader-writer problem">
        <p className="text-sm text-slate-300 leading-relaxed">Many threads share one repository. Readers may run together; a writer needs exclusive access. A naive lock that always admits readers while others read can <b>starve writers</b>; one that always favours writers can <b>starve readers</b>. Starvation means a request that is waiting never gets its turn even though the system keeps making progress for others.</p>
        <p className="text-sm text-slate-300 leading-relaxed mt-2"><b>FIFO</b> admits strictly in ticket order (consecutive readers at the head enter together, a writer at the head blocks those behind it). <b>Writer preference</b> blocks new readers while any writer waits. <b>Reader batching</b> caps how many readers enter per batch; the next batch starts only when the current one has fully released.</p>
      </Card>
      <Card title="Architecture" id="architecture">
        <pre className="text-xs font-mono text-cyan-200 bg-slate-950/70 border border-slate-800 rounded-lg p-3 overflow-auto leading-5">{`Browser (React, SSE client)
   │  POST /api/simulations · GET …/events (SSE)
   ▼
Express API  ── validates input (≤100 requests, ≤16 threads)
   ▼
Simulation manager ── one run at a time, timeout, cancel
   │  spawns: java -cp engine/out osh.Simulator key=value…
   ▼
Java engine (QueueRWLock: ticket queue + monitor)
   ▼
JSON event lines → SSE → charts, log, checks`}</pre>
        <p className="text-xs text-slate-400 mt-2">All synchronization state lives in the Java process; the browser only displays events it receives.</p>
      </Card>
    </div>
  );
}

export function Help() {
  const code = `:: Windows (cmd). Requires Node 18+ and JDK 17+ (java and javac on PATH)
git clone <repo> && cd osh006
npm run install:all
npm run build:engine
npm run test
:: terminal 1
npm run start:backend
:: terminal 2
npm run dev:frontend
:: open http://localhost:5173`;
  return (
    <Card title="Run it yourself" id="help">
      <pre className="text-xs font-mono text-slate-300 bg-slate-950/70 border border-slate-800 rounded-lg p-3 overflow-auto leading-5">{code}</pre>
      <p className="text-xs text-slate-500 mt-2">Full deployment steps (Vercel + Render, CORS, SSE) are in the repository README.</p>
    </Card>
  );
}

export function DemoPanel({ busy, onRun, events }) {
  const notes = events.filter((e) => e.type === 'NOTE');
  const demos = [
    ['Cancellation handoff', { scenario: 'cancel' }],
    ['Batching: unlimited', { scenario: 'batch', batch: 0 }],
    ['Batching: limit 3', { scenario: 'batch', batch: 3 }],
  ];
  return (
    <Card title="Reproducible demonstrations" id="demos">
      <p className="text-xs text-slate-400 mb-3">Fixed request sequences run directly against the Java engine with the policy selected above. Cancellation: R1 active, W2 and R3 waiting, W2 cancelled. Batching: R1–R6, W7, R8.</p>
      <div className="flex flex-wrap gap-2 mb-3">{demos.map(([l, c]) => <Btn key={l} disabled={busy} onClick={() => onRun(c)} className="text-xs">{l}</Btn>)}</div>
      {notes.length === 0 ? <Empty>Run a demonstration to see the queue and each admission decision.</Empty> : (
        <ol className="space-y-1.5 text-sm max-h-64 overflow-auto">
          {notes.map((n, i) => (
            <li key={i} className="flex gap-2"><span className="text-slate-500 font-mono text-xs w-14 shrink-0">{fmt(n.t, 0)}ms</span>
              <span className="text-slate-200">{n.text}<span className="block text-xs font-mono text-cyan-300/80">queue: {n.queue || 'empty'}</span></span></li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function EngineTestsPanel() {
  const [res, setRes] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  useEffect(() => { api('/api/tests/engine').then(setRes).catch((e) => setErr(e.message)); }, []);
  const run = async () => { setBusy(true); setErr(null); try { setRes(await api('/api/tests/engine', { method: 'POST' })); } catch (e) { setErr(e.message); } setBusy(false); };
  const ran = res && res.status !== 'not_run';
  const badge = !ran ? ['NOT RUN', 'bg-slate-700 text-slate-300'] : res.status === 'passed' ? ['ALL PASSED', 'bg-emerald-500/20 text-emerald-300'] : ['FAILED', 'bg-rose-500/20 text-rose-300'];
  return (
    <Card title="Engine validation (Java unit & stress tests)" id="tests" right={<div className="flex items-center gap-2"><span className={`text-xs px-2 py-0.5 rounded ${badge[1]}`}>{badge[0]}</span><Btn kind="primary" className="text-xs" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run tests'}</Btn></div>}>
      {err && <p className="text-rose-400 text-sm mb-2">{err}</p>}
      {!ran ? <Empty>Tests have not been run in this server session. Press “Run tests” to execute the real Java suite (takes a few seconds).</Empty> : (
        <>
          <p className="text-xs text-slate-400 mb-2">{res.passed} passed, {res.failed} failed · {fmt(res.durationMs / 1000, 1)} s · ran {new Date(res.ranAt).toLocaleTimeString()}</p>
          {res.error && <p className="text-rose-400 text-sm mb-2">{res.error}</p>}
          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {res.tests.map((t) => <li key={t.name} className="flex gap-2"><span className={t.ok ? 'text-emerald-400' : 'text-rose-400'}>{t.ok ? '✓' : '✗'}</span><span>{t.name}</span></li>)}
          </ul>
        </>
      )}
    </Card>
  );
}
