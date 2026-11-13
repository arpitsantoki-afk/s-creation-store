// Sessions, roles and Google sign-in (OpenID Connect, authorization-code flow).
import { HttpError } from './http.js';
import { sign, verify } from './crypto.js';

export const ROLES = {
  owner: ['dashboard', 'orders', 'products', 'messages', 'settings', 'publish', 'team'],
  manager: ['dashboard', 'orders', 'products', 'messages', 'settings', 'publish'],
  staff: ['dashboard', 'orders', 'messages'],
};
export const ADMIN_TTL = 12 * 3600;
export const CUSTOMER_TTL = 30 * 24 * 3600;

const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

/** Verify an admin session and permission. Reads the DB each time so role changes / removals apply immediately. */
export async function requireAdmin(req, env, perm) {
  const s = await verify(env.SESSION_SECRET, bearer(req));
  if (!s || s.k !== 'admin') throw new HttpError(401, 'Please sign in');
  const a = await env.DB.prepare('SELECT id, email, name, role, status, session_v FROM admins WHERE id = ?').bind(s.id).first();
  if (!a || a.status !== 'active' || a.session_v !== s.v) throw new HttpError(401, 'Your session has ended. Please sign in again.');
  if (perm && !(ROLES[a.role] || []).includes(perm)) throw new HttpError(403, `Your role (${a.role}) does not have access to ${perm}`);
  return a;
}
export const adminToken = (env, a) => sign(env.SESSION_SECRET, { k: 'admin', id: a.id, v: a.session_v ?? 1 }, ADMIN_TTL);

export async function customerFromReq(req, env) {
  const t = bearer(req);
  if (!t) return null;
  const s = await verify(env.SESSION_SECRET, t);
  if (!s || s.k !== 'cust') return null;
  const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(s.id).first();
  if (!c || c.session_v !== s.v) return null;
  return c;
}
export async function requireCustomer(req, env) {
  const c = await customerFromReq(req, env);
  if (!c) throw new HttpError(401, 'Please sign in');
  return c;
}
export const customerToken = (env, c) => sign(env.SESSION_SECRET, { k: 'cust', id: c.id, v: c.session_v ?? 1 }, CUSTOMER_TTL);

/** Only redirect back to our own site / dashboard origins. */
export function safeReturn(url, env, settings, fallback) {
  try {
    const u = new URL(url);
    const ok = [settings?.store?.siteUrl, env.SITE_URL, ...(env.ALLOWED_ORIGINS || '').split(',')].filter(Boolean).map((s) => new URL(s.trim()).origin);
    if (ok.includes(u.origin) || /^[a-z0-9-]+\.github\.io$/i.test(u.hostname)) return u.toString();
  } catch { /* fall through */ }
  return fallback;
}

// ---------- Google ----------
export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const redirectUri = (env) => `${env.API_URL.replace(/\/$/, '')}/api/auth/google/callback`;

export async function googleStartUrl(env, { audience, returnTo }) {
  const state = await sign(env.SESSION_SECRET, { k: 'gstate', aud: audience, ret: returnTo, n: crypto.randomUUID() }, 600);
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(env), response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account', access_type: 'online' });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state };
}

/** Exchange the code and return the verified Google profile + decoded state. */
export async function googleCallback(env, url) {
  const state = await verify(env.SESSION_SECRET, url.searchParams.get('state'));
  if (!state || state.k !== 'gstate') throw new HttpError(400, 'Sign-in expired. Please try again.');
  if (url.searchParams.get('error')) return { state, error: url.searchParams.get('error') };
  const r = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(env), grant_type: 'authorization_code' }),
  });
  const d = await r.json();
  if (!r.ok || !d.id_token) throw new HttpError(400, 'Google sign-in failed: ' + (d.error_description || d.error || r.status));
  // The ID token came straight from Google's token endpoint over TLS, so (per OIDC Core §3.1.3.7) we validate its claims.
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) throw new HttpError(400, 'Invalid Google token');
  if (!claims.email_verified) throw new HttpError(400, 'Your Google email is not verified');
  return { state, profile: { sub: claims.sub, email: String(claims.email).toLowerCase(), name: claims.name || '', picture: claims.picture || '' } };
}
