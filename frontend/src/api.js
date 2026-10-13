export const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export async function api(path, opts = {}) {
  let res;
  try { res = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts }); }
  catch { throw new Error('Cannot reach the backend. Is it running and is VITE_API_URL correct?'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([body.error, ...(body.errors || [])].filter(Boolean).join(': ') || `HTTP ${res.status}`);
  return body;
}
