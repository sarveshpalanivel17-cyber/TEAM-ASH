import { useCallback, useRef, useState } from 'react';
import { api, API } from './api.js';

const idle = { status: 'idle', events: [], result: null, error: null, runId: null, config: null };

/** Starts a real backend simulation and streams its events over SSE. run() resolves with the final run record (or null on error). */
export function useSim() {
  const [state, setState] = useState(idle);
  const ref = useRef({ es: null, id: null });

  const run = useCallback((config) => new Promise((resolve) => {
    ref.current.es?.close();
    setState({ ...idle, status: 'starting', config });
    api('/api/simulations', { method: 'POST', body: JSON.stringify(config) }).then(({ id }) => {
      ref.current.id = id;
      setState((p) => ({ ...p, status: 'running', runId: id }));
      const es = new EventSource(`${API}/api/simulations/${id}/events`);
      ref.current.es = es;
      let finished = false;
      es.onmessage = (e) => { const ev = JSON.parse(e.data); setState((p) => ({ ...p, events: [...p.events, ev] })); };
      es.addEventListener('done', async () => {
        finished = true; es.close();
        try {
          const r = await api(`/api/simulations/${id}`);
          setState((p) => ({ ...p, status: r.status, result: r.result, error: r.error }));
          resolve(r);
        } catch (err) { setState((p) => ({ ...p, status: 'error', error: err.message })); resolve(null); }
      });
      es.onerror = () => {
        if (finished) return;
        es.close(); setState((p) => ({ ...p, status: 'error', error: 'Lost connection to the event stream' })); resolve(null);
      };
    }).catch((err) => { setState({ ...idle, status: 'error', error: err.message, config }); resolve(null); });
  }), []);

  const cancel = useCallback(async () => {
    if (!ref.current.id) return;
    try { await api(`/api/simulations/${ref.current.id}/cancel`, { method: 'POST' }); }
    catch (err) { setState((p) => ({ ...p, error: err.message })); }
  }, []);

  const pause = useCallback(async (on) => {
    if (!ref.current.id) return;
    try { await api(`/api/simulations/${ref.current.id}/${on ? 'pause' : 'resume'}`, { method: 'POST' }); }
    catch (err) { setState((p) => ({ ...p, error: err.message })); }
  }, []);

  const reset = useCallback(() => { ref.current.es?.close(); ref.current = { es: null, id: null }; setState(idle); }, []);

  const paused = (() => { for (let i = state.events.length - 1; i >= 0; i--) { const t = state.events[i].type; if (t === 'PAUSED') return true; if (t === 'RESUMED') return false; } return false; })();
  return { ...state, paused: paused && state.status === 'running', run, cancel, pause, reset };
}
