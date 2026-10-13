import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from './validate.js';
import { HttpError } from './manager.js';
import { createRateLimiter } from './ratelimit.js';
import { EngineTestRunner } from './engineTests.js';

export function createApp(manager, { corsOrigin = '*', rateLimit = {} } = {}) {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of the app
  const tests = new EngineTestRunner({ javaBin: manager.javaBin, classDir: manager.classDir });
  const general = createRateLimiter({ max: rateLimit.max ?? 240 });
  const heavy = createRateLimiter({ max: rateLimit.heavyMax ?? 20 });
  const origins = corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', engineBuilt: existsSync(join(manager.classDir, 'osh', 'Simulator.class')), javaBin: manager.javaBin, running: Boolean(manager.active) });
  });

  app.use('/api', general); // after /api/health so platform health checks are never throttled

  app.get('/api/simulations', (_req, res) => res.json(manager.list()));

  app.post('/api/simulations', heavy, (req, res) => {
    const { config, errors } = validateConfig(req.body);
    if (errors.length) return res.status(400).json({ error: 'Invalid simulation settings', errors });
    if (!existsSync(join(manager.classDir, 'osh', 'Simulator.class'))) throw new HttpError(503, 'Java engine is not built. Run: npm run build:engine');
    const run = manager.start(config);
    res.status(202).json({ id: run.id, status: run.status, config });
  });

  app.get('/api/simulations/:id', (req, res) => res.json(manager.summary(manager.get(req.params.id))));

  app.post('/api/simulations/:id/cancel', (req, res) => res.json(manager.summary(manager.cancel(req.params.id))));

  app.post('/api/simulations/:id/pause', (req, res) => res.json(manager.summary(manager.setPaused(req.params.id, true))));
  app.post('/api/simulations/:id/resume', (req, res) => res.json(manager.summary(manager.setPaused(req.params.id, false))));

  app.get('/api/tests/engine', (_req, res) => res.json(tests.last ?? { status: 'not_run' }));
  app.post('/api/tests/engine', heavy, async (_req, res, next) => { // Express 4 does not forward async rejections itself
    try {
      if (manager.active) throw new HttpError(409, 'A simulation is running; wait for it to finish before running tests');
      if (!existsSync(join(manager.classDir, 'Tests.class'))) throw new HttpError(503, 'Engine tests are not built. Run: npm run build:engine');
      res.json(await tests.run());
    } catch (e) { next(e); }
  });

  // Server-Sent Events: replays buffered events, then streams live ones, then sends `done`.
  app.get('/api/simulations/:id/events', (req, res) => {
    const run = manager.get(req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev, idx) => res.write(`id: ${idx}\ndata: ${JSON.stringify(ev)}\n\n`);
    const done = (summary) => { res.write(`event: done\ndata: ${JSON.stringify(summary)}\n\n`); cleanup(); res.end(); };
    const cleanup = () => { clearInterval(beat); run.bus.off('event', send); run.bus.off('done', done); };
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    run.events.forEach(send);
    if (run.finishedAt) return done(manager.summary(run));
    run.bus.on('event', send);
    run.bus.on('done', done);
    req.on('close', cleanup);
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status === 400 && err.type ? 'Malformed JSON body' : err.message });
  });
  return app;
}
