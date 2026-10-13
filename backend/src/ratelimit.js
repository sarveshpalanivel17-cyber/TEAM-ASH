/** Dependency-free fixed-window rate limiter keyed by client IP. */
export function createRateLimiter({ windowMs = 60000, max = 120, now = () => Date.now() } = {}) {
  const hits = new Map();
  const timer = setInterval(() => { const t = now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, windowMs);
  timer.unref?.();
  const middleware = (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const t = now(); let h = hits.get(key);
    if (!h || h.reset <= t) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
    h.count++;
    res.setHeader('X-RateLimit-Limit', String(max)); res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      const retry = Math.ceil((h.reset - t) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many requests; retry in ${retry}s` });
    }
    next();
  };
  middleware.stop = () => clearInterval(timer);
  return middleware;
}
