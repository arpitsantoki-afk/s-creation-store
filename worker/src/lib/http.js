export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

export function corsHeaders(req, env, settings) {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  const allowed = new Set([
    env.SITE_URL, settings?.store?.siteUrl, `https://www.${settings?.store?.domain || ''}`,
    ...(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()),
  ].filter(Boolean).map((u) => u.replace(/\/$/, '')));
  // GitHub Pages preview domains (*.github.io) are allowed so the site works before DNS is switched.
  const ok = allowed.has(origin) || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);
  return ok ? {
    'access-control-allow-origin': origin, 'vary': 'origin',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
  } : {};
}

/** Tiny router: add(method, '/api/orders/:id', handler) */
export class Router {
  routes = [];
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*$/, '(.*)') + '/?$');
    this.routes.push({ method, re, keys, handler, wildcard: pattern.endsWith('*') });
    return this;
  }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      if (r.wildcard) params.rest = m[r.keys.length + 1];
      return { handler: r.handler, params };
    }
    return null;
  }
}

export async function body(req) {
  try { return await req.json(); } catch { throw bad('Invalid JSON body'); }
}

export const uid = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function clean(s, max = 500) { return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
