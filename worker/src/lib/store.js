// Data access helpers over D1.
import defaultSettings from '../../../content/settings.json';
import starterProducts from '../../../content/products.json';
import fallbackFx from '../../../content/fx-fallback.json';

export { starterProducts };

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

export async function getSettings(env) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('site').first();
  // Saved settings are merged over defaults, so new setting keys added in code appear automatically.
  return row ? deepMerge(defaultSettings, JSON.parse(row.value)) : structuredClone(defaultSettings);
}
export async function saveSettings(env, value) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(value)).run();
}
export async function getFx(env) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('fx').first();
  return row ? JSON.parse(row.value) : fallbackFx;
}
export async function saveFx(env, fx) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('fx', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(fx)).run();
}

export async function listProducts(env, { publishedOnly = false } = {}) {
  const q = publishedOnly ? "SELECT data, status FROM products WHERE status = 'published' ORDER BY sort, id" : 'SELECT data, status, updated_at FROM products ORDER BY sort, id';
  const { results } = await env.DB.prepare(q).all();
  return results.map((r) => ({ ...JSON.parse(r.data), status: r.status, updatedAt: r.updated_at }));
}
export async function getProduct(env, id) {
  const r = await env.DB.prepare('SELECT data, status FROM products WHERE id = ?').bind(id).first();
  return r ? { ...JSON.parse(r.data), status: r.status } : null;
}
export async function saveProduct(env, p) {
  await env.DB.prepare(`INSERT INTO products (id, slug, status, sort, data, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, status = excluded.status, sort = excluded.sort, data = excluded.data, updated_at = excluded.updated_at`)
    .bind(p.id, p.slug, p.status || 'draft', p.sort ?? 99, JSON.stringify(p)).run();
}

export async function getOrder(env, id) {
  const r = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  return r ? rowToOrder(r) : null;
}
export function rowToOrder(r) { return { ...JSON.parse(r.data), id: r.id, number: r.number, status: r.status, gatewayRef: r.gateway_ref, token: r.token, customerId: r.customer_id ?? null, invoiceNo: r.invoice_no ?? null, createdAt: r.created_at, updatedAt: r.updated_at }; }

export async function updateOrder(env, id, patch, event) {
  const o = await getOrder(env, id);
  if (!o) return null;
  const next = { ...o, ...patch };
  const { id: _i, number: _n, token: _t, createdAt: _c, updatedAt: _u, gatewayRef, customerId: _cu, invoiceNo: _in, ...data } = next;
  await env.DB.prepare("UPDATE orders SET status = ?, gateway_ref = ?, data = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(next.status, next.gatewayRef ?? null, JSON.stringify(data), id).run();
  if (event) await logEvent(env, id, event.type, event.data);
  return next;
}
export async function logEvent(env, orderId, type, data) {
  await env.DB.prepare('INSERT INTO order_events (order_id, type, data) VALUES (?, ?, ?)').bind(orderId, type, data ? JSON.stringify(data) : null).run();
}

// Credentials entered in the dashboard (write-only; never sent back to the browser or exported).
export const DASHBOARD_SECRETS = ['DHL_API_KEY', 'DHL_API_SECRET', 'DHL_ACCOUNT_NUMBER'];
export async function getStoredSecrets(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'secrets'").first();
  return row ? JSON.parse(row.value) : {};
}
export async function saveStoredSecrets(env, obj) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('secrets', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(obj)).run();
}
