// S Creation API — Cloudflare Worker (D1 + R2). Serves the storefront API, the admin API and product media.
import { Router, json, corsHeaders, HttpError } from './lib/http.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';
import { getSettings } from './lib/store.js';
import { refreshFx, triggerPublish } from './lib/services.js';

const router = new Router();
publicRoutes(router);
adminRoutes(router);
accountRoutes(router);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // The API's public URL is wherever this request arrived (workers.dev now, api.screationindia.in later).
    env = { ...env, API_URL: url.origin };
    let settings = null;
    try { settings = await getSettings(env); } catch { /* DB not migrated yet */ }
    const cors = corsHeaders(req, env, settings);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      const m = router.match(req.method, url.pathname);
      res = m ? await m.handler(req, env, ctx, m.params) : json({ error: 'Not found' }, 404);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res = json({ error: status === 500 ? 'Server error: ' + e.message : e.message, ...(e.extra || {}) }, status);
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    h.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  },

  async scheduled(event, env, ctx) {
    const settings = await getSettings(env);
    try { await refreshFx(env, settings); } catch (e) { console.error('FX refresh failed', e); }
    // Optional nightly rebuild so feeds/JSON-LD carry fresh converted prices.
    if (settings.publish?.nightly) ctx.waitUntil(triggerPublish(env, 'nightly').catch((e) => console.error(e)));
  },
};
