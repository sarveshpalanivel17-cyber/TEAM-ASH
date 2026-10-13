import React, { useMemo, useState } from 'react';
import { useSim } from './useSim.js';
import { ConfigPanel, QueueViz, EventLog, Charts, ChecksPanel, ResultsSummary, ComparePanel, DemoPanel, EngineTestsPanel, Explainer, Help, deriveStats } from './components.jsx';

const DEFAULTS = { policy: 'FIFO', readers: 10, writers: 5, ops: 4, threads: 8, batch: 0, readMs: 5, writeMs: 10, cancelPct: 0, scenario: 'none' };

export default function App() {
  const sim = useSim();
  const [config, setConfig] = useState(DEFAULTS);
  const [cmp, setCmp] = useState({ status: 'idle', results: {}, error: null });
  const busy = sim.status === 'starting' || sim.status === 'running';
  const stats = useMemo(() => deriveStats(sim.events), [sim.events]);

  const compare = async () => {
    setCmp({ status: 'running', results: {}, error: null });
    for (const policy of ['FIFO', 'WRITER_PREF']) {
      const run = await sim.run({ ...config, policy, scenario: 'none' });
      if (!run || run.status !== 'completed') { setCmp((c) => ({ ...c, status: 'idle', error: run ? `Comparison stopped: run ${run.status}${run.error ? ` (${run.error})` : ''}` : 'Comparison stopped: run failed' })); return; }
      setCmp((c) => ({ ...c, results: { ...c.results, [policy]: run.result } }));
    }
    setCmp((c) => ({ ...c, status: 'done' }));
  };

  const reset = () => { sim.reset(); setCmp({ status: 'idle', results: {}, error: null }); };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-950/90 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
          <div><span className="text-cyan-400 font-mono text-xs">OSH006</span><h1 className="text-base sm:text-lg font-semibold text-slate-100">Starvation-Free Reader-Writer Synchronization</h1></div>
          <nav className="flex gap-4 text-xs text-slate-400 sm:ml-auto">
            {[['demos', 'Demos'], ['log', 'Log'], ['checks', 'Checks'], ['compare', 'Compare'], ['tests', 'Tests'], ['architecture', 'Architecture'], ['help', 'Run it']].map(([id, l]) => <a key={id} href={`#${id}`} className="hover:text-cyan-300">{l}</a>)}
          </nav>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <Explainer />
        {sim.error && sim.status !== 'completed' && (
          <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm p-3">{sim.error}</div>
        )}
        {sim.status === 'starting' && <div className="text-sm text-cyan-300">Starting Java engine…</div>}
        <div className="grid lg:grid-cols-2 gap-4">
          <ConfigPanel config={config} setConfig={setConfig} busy={busy} paused={sim.paused} onPause={sim.pause} onStart={() => sim.run({ ...config, scenario: 'none' })} onCancel={sim.cancel} onReset={reset} onCompare={compare} />
          <QueueViz events={sim.events} status={sim.status} />
        </div>
        <DemoPanel busy={busy} events={sim.events} onRun={(c) => sim.run({ ...config, ...c })} />
        <Charts stats={stats} hasData={sim.events.length > 0} />
        <div className="grid lg:grid-cols-2 gap-4">
          <ChecksPanel result={sim.result} status={sim.status} error={sim.status === 'failed' || sim.status === 'timeout' ? sim.error : null} />
          <ResultsSummary result={sim.result} config={sim.config} />
        </div>
        <EventLog events={sim.events} />
        <ComparePanel cmp={cmp} />
        <EngineTestsPanel />
        <Help />
      </main>
      <footer className="text-center text-xs text-slate-600 py-6">OSH006 · Java engine + Express + React</footer>
    </div>
  );
}
