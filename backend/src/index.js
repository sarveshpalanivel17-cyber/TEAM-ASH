import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SimulationManager } from './manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const manager = new SimulationManager({
  javaBin: process.env.JAVA_BIN || 'java',
  classDir: resolve(here, '..', process.env.ENGINE_DIR || '../engine/out'),
  timeoutMs: Number(process.env.SIM_TIMEOUT_MS) || 60000,
});
const app = createApp(manager, { corsOrigin: process.env.CORS_ORIGIN || '*', rateLimit: { max: Number(process.env.RATE_LIMIT_MAX) || 240, heavyMax: Number(process.env.RATE_LIMIT_HEAVY_MAX) || 20 } });
const port = Number(process.env.PORT) || 4000;
const server = app.listen(port, '0.0.0.0', () => console.log(`OSH006 backend listening on :${port} (engine: ${manager.classDir})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { manager.shutdown(); server.close(() => process.exit(0)); });
