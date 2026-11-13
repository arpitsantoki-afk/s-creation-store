import { json, bad, body, uid, clean, HttpError } from '../lib/http.js';
import { sign, verify, hashPassword, checkPassword, safeEqual } from '../lib/crypto.js';
import { getSettings, saveSettings, getFx, listProducts, getProduct, saveProduct, getOrder, updateOrder, logEvent, rowToOrder, starterProducts } from '../lib/store.js';
import { refreshFx, triggerPublish, publishStatus, sendEmail, orderEmailHtml } from '../lib/services.js';
import { carriers, packBoxes } from '../shipping/index.js';
import { gateways } from '../payments/index.js';

const SESSION_TTL = 12 * 3600;
const STATUSES = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

async function requireAdmin(req, env) {
  const h = req.headers.get('authorization') || '';
  const s = await verify(env.SESSION_SECRET, h.replace(/^Bearer\s+/i, ''));
  if (!s || s.k !== 'admin') throw new HttpError(401, 'Please sign in');
  return s;
}
const slugify = (s = '') => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function normalizeProduct(p, existing = {}) {
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const out = {
    ...existing, ...p,
    id: existing.id || clean(p.id, 40) || 'p-' + uid(4),
    code: clean(p.code, 20), name: clean(p.name, 120), line: clean(p.line, 40), type: clean(p.type, 40), category: clean(p.category, 40),
    slug: slugify(p.slug || p.name), status: ['draft', 'published', 'archived'].includes(p.status) ? p.status : 'draft', sort: num(p.sort, 99),
    moq: Math.max(1, Math.floor(num(p.moq, 1))), price: num(p.price), weightG: num(p.weightG, 250), gsm: num(p.gsm) || null,
    tiers: arr(p.tiers).map((t) => ({ min: Math.floor(num(t.min)), price: num(t.price) })).filter((t) => t.min > 0 && t.price > 0).sort((a, b) => a.min - b.min),
    sizes: arr(p.sizes).map((s) => clean(s, 20)).filter(Boolean),
    colors: arr(p.colors).map((c) => ({ name: clean(c.name, 60), hex: /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#cccccc', ...(c.hex2 && /^#[0-9a-f]{6}$/i.test(c.hex2) ? { hex2: c.hex2 } : {}), images: arr(c.images).map((u) => clean(u, 500)).filter(Boolean) })).filter((c) => c.name),
    i18n: typeof p.i18n === 'object' && p.i18n ? p.i18n : {},
  };
  if (!out.name) throw bad('Product name is required');
  if (!out.slug) throw bad('Slug is required');
  if (!out.colors.length) throw bad('Add at least one colour');
  if (!out.sizes.length) throw bad('Add at least one size');
  if (out.status === 'published' && !(out.price > 0)) throw bad('Set a price before publishing');
  delete out.updatedAt;
  return out;
}

export function adminRoutes(r) {
  r.add('GET', '/api/admin/status', async (req, env) => {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    return json({ hasAdmin: n.n > 0 });
  });

  r.add('POST', '/api/admin/setup', async (req, env) => {
    const b = await body(req);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    if (n.n > 0) throw new HttpError(403, 'Setup already completed');
    if (!env.SETUP_TOKEN || !safeEqual(String(b.setupToken || ''), env.SETUP_TOKEN)) throw new HttpError(403, 'Invalid setup token');
    if (String(b.password || '').length < 10) throw bad('Password must be at least 10 characters');
    const email = clean(b.email, 160).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Valid email required');
    await env.DB.prepare('INSERT INTO admins (email, name, pass_hash) VALUES (?, ?, ?)').bind(email, clean(b.name, 80), await hashPassword(b.password)).run();
    return json({ ok: true });
  });

  r.add('POST', '/api/admin/login', async (req, env) => {
    const b = await body(req);
    const email = clean(b.email, 160).toLowerCase();
    const since = Date.now() - 15 * 60e3;
    const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?').bind(email, since).first();
    if (tries.n >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const a = await env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first();
    if (!a || !(await checkPassword(String(b.password || ''), a.pass_hash))) {
      await env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
      throw new HttpError(401, 'Wrong email or password');
    }
    await env.DB.batch([env.DB.prepare("UPDATE admins SET last_login = datetime('now') WHERE id = ?").bind(a.id), env.DB.prepare('DELETE FROM login_attempts WHERE email = ? OR at < ?').bind(email, since)]);
    return json({ token: await sign(env.SESSION_SECRET, { k: 'admin', id: a.id, email: a.email, name: a.name }, SESSION_TTL), user: { email: a.email, name: a.name } });
  });

  // Everything below requires a session.
  const A = (method, path, fn) => r.add(method, path, async (req, env, ctx, p) => fn(req, env, ctx, p, await requireAdmin(req, env)));

  A('GET', '/api/admin/me', async (req, env, ctx, p, s) => json({ user: { email: s.email, name: s.name } }));

  A('POST', '/api/admin/password', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const a = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(s.id).first();
    if (!(await checkPassword(String(b.current || ''), a.pass_hash))) throw bad('Current password is wrong');
    if (String(b.next || '').length < 10) throw bad('New password must be at least 10 characters');
    await env.DB.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').bind(await hashPassword(b.next), s.id).run();
    return json({ ok: true });
  });

  A('GET', '/api/admin/admins', async (req, env) => json({ admins: (await env.DB.prepare('SELECT id, email, name, created_at, last_login FROM admins').all()).results }));
  A('POST', '/api/admin/admins', async (req, env) => {
    const b = await body(req);
    if (String(b.password || '').length < 10) throw bad('Password must be at least 10 characters');
    await env.DB.prepare('INSERT INTO admins (email, name, pass_hash) VALUES (?, ?, ?)').bind(clean(b.email, 160).toLowerCase(), clean(b.name, 80), await hashPassword(b.password)).run();
    return json({ ok: true });
  });
  A('DELETE', '/api/admin/admins/:id', async (req, env, ctx, p, s) => {
    if (+p.id === s.id) throw bad('You cannot remove yourself');
    await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(+p.id).run();
    return json({ ok: true });
  });

  A('GET', '/api/admin/dashboard', async (req, env) => {
    const [byStatus, recent, rev, msgs, prods] = await Promise.all([
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all(),
      env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8').all(),
      env.DB.prepare("SELECT currency, SUM(total) AS total, COUNT(*) AS n FROM orders WHERE status IN ('paid','processing','shipped','delivered') AND created_at > datetime('now','-30 days') GROUP BY currency").all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_read = 0').first(),
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM products GROUP BY status').all(),
    ]);
    return json({ byStatus: byStatus.results, recent: recent.results.map(rowToOrder).map(summary), revenue30d: rev.results, unreadMessages: msgs.n, products: prods.results });
  });

  A('GET', '/api/admin/integrations', async (req, env) => {
    const s = await getSettings(env);
    const fx = await getFx(env);
    return json({
      stripe: { configured: gateways.stripe.configured(env), webhook: !!env.STRIPE_WEBHOOK_SECRET, mode: (env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test' },
      paypal: { configured: gateways.paypal.configured(env), webhook: !!env.PAYPAL_WEBHOOK_ID, mode: s.payments?.paypal?.mode },
      dhl: { configured: carriers.dhl.configured(env), env: env.DHL_ENV || 'test' },
      github: { configured: !!(env.GITHUB_TOKEN && env.GITHUB_REPO), repo: env.GITHUB_REPO },
      email: { configured: !!(env.RESEND_API_KEY && env.EMAIL_FROM), from: env.EMAIL_FROM || null },
      ai: { configured: !!env.AI }, media: { configured: !!env.MEDIA },
      fx: { source: fx.source || 'fallback', updated: fx.fetchedAt || fx.updated },
      webhooks: { stripe: `${env.API_URL}/api/webhooks/stripe`, paypal: `${env.API_URL}/api/webhooks/paypal` },
    });
  });

  // ---- products ----
  A('GET', '/api/admin/products', async (req, env) => json({ products: await listProducts(env) }));
  A('GET', '/api/admin/products/:id', async (req, env, ctx, p) => {
    const prod = await getProduct(env, p.id);
    if (!prod) throw new HttpError(404, 'Not found');
    return json({ product: prod });
  });
  A('POST', '/api/admin/products', async (req, env) => {
    const b = await body(req);
    const prod = normalizeProduct(b);
    if (await getProduct(env, prod.id)) throw bad('A product with this id already exists');
    const clash = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(prod.slug).first();
    if (clash) throw bad('Slug already in use');
    await saveProduct(env, prod);
    return json({ product: prod });
  });
  A('PUT', '/api/admin/products/:id', async (req, env, ctx, p) => {
    const existing = await getProduct(env, p.id);
    if (!existing) throw new HttpError(404, 'Not found');
    const prod = normalizeProduct({ ...(await body(req)), id: p.id }, existing);
    const clash = await env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').bind(prod.slug, p.id).first();
    if (clash) throw bad('Slug already in use by another product');
    await saveProduct(env, prod);
    return json({ product: prod });
  });
  A('DELETE', '/api/admin/products/:id', async (req, env, ctx, p) => {
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(p.id).run();
    return json({ ok: true });
  });
  A('POST', '/api/admin/import-starter', async (req, env) => {
    let n = 0;
    for (const sp of starterProducts) if (!(await getProduct(env, sp.id))) { await saveProduct(env, sp); n++; }
    return json({ imported: n });
  });

  // ---- media (R2) ----
  A('POST', '/api/admin/media', async (req, env) => {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || typeof file === 'string') throw bad('No file');
    if (!/^image\/(webp|jpeg|png|avif|gif|svg\+xml)$/.test(file.type)) throw bad('Images only (WebP, JPEG, PNG, AVIF)');
    if (file.size > 8 * 1024 * 1024) throw bad('Max 8 MB per image');
    const folder = slugify(fd.get('folder') || 'misc') || 'misc';
    const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[file.type];
    const name = slugify(String(file.name || '').replace(/\.[^.]+$/, '')).slice(0, 40) || 'img';
    const key = `products/${folder}/${name}-${uid(4)}.${ext}`;
    await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return json({ key, url: `${env.API_URL}/media/${key}` });
  });
  A('GET', '/api/admin/media', async (req, env) => {
    const prefix = new URL(req.url).searchParams.get('prefix') || 'products/';
    const l = await env.MEDIA.list({ prefix, limit: 500 });
    return json({ objects: l.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, url: `${env.API_URL}/media/${o.key}` })) });
  });
  A('DELETE', '/api/admin/media', async (req, env) => {
    const key = new URL(req.url).searchParams.get('key');
    if (!key || !key.startsWith('products/')) throw bad('Invalid key');
    await env.MEDIA.delete(key);
    return json({ ok: true });
  });

  // ---- settings ----
  A('GET', '/api/admin/settings', async (req, env) => json({ settings: await getSettings(env), fx: await getFx(env) }));
  A('PUT', '/api/admin/settings', async (req, env) => {
    const b = await body(req);
    if (!b || typeof b !== 'object' || !b.store || !b.baseCurrency) throw bad('Invalid settings');
    if (!(b.currencies || []).some((c) => c.code === b.baseCurrency)) throw bad('Base currency must be in the currency list');
    if (!b.languages?.enabled?.includes(b.languages.default)) throw bad('Default language must be enabled');
    await saveSettings(env, b);
    return json({ settings: await getSettings(env) });
  });
  A('POST', '/api/admin/fx/refresh', async (req, env) => json({ fx: await refreshFx(env, await getSettings(env)) }));

  // ---- orders ----
  A('GET', '/api/admin/orders', async (req, env) => {
    const u = new URL(req.url);
    const status = u.searchParams.get('status'), q = (u.searchParams.get('q') || '').trim();
    const page = Math.max(0, +u.searchParams.get('page') || 0);
    let sql = 'SELECT * FROM orders WHERE 1=1'; const args = [];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (q) { sql += ' AND (number LIKE ? OR email LIKE ? OR data LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 50 OFFSET ?'; args.push(page * 50);
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ orders: results.map(rowToOrder).map(summary) });
  });
  A('GET', '/api/admin/orders/:id', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const { results } = await env.DB.prepare('SELECT type, data, created_at FROM order_events WHERE order_id = ? ORDER BY id').bind(p.id).all();
    return json({ order: o, events: results.map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null })) });
  });
  A('PATCH', '/api/admin/orders/:id', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const patch = {};
    if (b.status) { if (!STATUSES.includes(b.status)) throw bad('Invalid status'); patch.status = b.status; }
    if ('tracking' in b) patch.tracking = clean(b.tracking, 40);
    if ('internalNote' in b) patch.internalNote = clean(b.internalNote, 2000);
    const next = await updateOrder(env, p.id, patch, { type: 'admin_update', data: { by: s.email, ...patch } });
    if (b.notify && patch.status === 'shipped') {
      const settings = await getSettings(env);
      ctx.waitUntil(sendEmail(env, { to: o.customer.email, replyTo: settings.store.email, subject: `Your ${settings.store.name} order ${o.number} has shipped`, html: orderEmailHtml(next, settings, 'Your order is on its way') }).catch(() => {}));
    }
    return json({ order: next });
  });
  A('POST', '/api/admin/orders/:id/shipment', async (req, env, ctx, p, s) => {
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    if (!carriers.dhl.configured(env)) throw bad('DHL is not configured (DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT_NUMBER)');
    if (o.tracking) throw bad('This order already has a tracking number');
    const settings = await getSettings(env);
    const boxes = packBoxes(o.weightG, settings);
    const res = await carriers.dhl.createShipment({ env, settings, order: o, boxes });
    const docs = {};
    for (const [k, b64] of [['label', res.labelPdfBase64], ['invoice', res.invoicePdfBase64]]) {
      if (!b64) continue;
      const key = `private/orders/${o.number}/${k}-${res.tracking}.pdf`;
      await env.MEDIA.put(key, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'application/pdf' } });
      docs[k] = key;
    }
    const next = await updateOrder(env, p.id, { tracking: res.tracking, shipmentDocs: docs, status: ['paid', 'processing'].includes(o.status) ? 'shipped' : o.status, shippedAt: new Date().toISOString() },
      { type: 'dhl_shipment', data: { by: s.email, tracking: res.tracking, boxes: boxes.length, kg: res.kg } });
    const settings2 = settings;
    ctx.waitUntil(sendEmail(env, { to: o.customer.email, replyTo: settings2.store.email, subject: `Your ${settings2.store.name} order ${o.number} has shipped`, html: orderEmailHtml(next, settings2, 'Your order is on its way') }).catch(() => {}));
    return json({ order: next });
  });
  A('GET', '/api/admin/orders/:id/doc/:kind', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    const key = o?.shipmentDocs?.[p.kind];
    if (!key) throw new HttpError(404, 'No document');
    const obj = await env.MEDIA.get(key);
    return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${o.number}-${p.kind}.pdf"` } });
  });
  A('GET', '/api/admin/orders/:id/tracking', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    if (!o?.tracking) throw bad('No tracking number');
    return json(await carriers.dhl.track(env, await getSettings(env), o.tracking));
  });
  A('GET', '/api/admin/orders.csv', async (req, env) => {
    const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5000').all();
    const rows = [['number', 'date', 'status', 'email', 'name', 'country', 'currency', 'subtotal', 'shipping', 'tax', 'total', 'gateway', 'tracking', 'items']];
    for (const o of results.map(rowToOrder)) rows.push([o.number, o.createdAt, o.status, o.customer.email, o.customer.name, o.address.country, o.currency, o.subtotal, o.shippingAmount, o.taxAmount, o.total, o.gateway, o.tracking || '', o.groups.map((g) => `${g.code}×${g.qty}`).join(' ')]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="orders.csv"' } });
  });

  // ---- messages ----
  A('GET', '/api/admin/messages', async (req, env) => {
    const { results } = await env.DB.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200').all();
    return json({ messages: results.map((m) => ({ id: m.id, read: !!m.is_read, createdAt: m.created_at, ...JSON.parse(m.data) })) });
  });
  A('PATCH', '/api/admin/messages/:id', async (req, env, ctx, p) => {
    const b = await body(req);
    await env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?').bind(b.read ? 1 : 0, +p.id).run();
    return json({ ok: true });
  });

  // ---- publish ----
  A('POST', '/api/admin/publish', async (req, env, ctx, p, s) => json(await triggerPublish(env, `dashboard:${s.email}`)));
  A('GET', '/api/admin/publish', async (req, env) => json(await publishStatus(env)));

  // ---- translation (Workers AI, optional) ----
  A('POST', '/api/admin/translate', async (req, env) => {
    if (!env.AI) throw bad('Workers AI binding not configured');
    const b = await body(req);
    const target = { de: 'german', fr: 'french', es: 'spanish' }[b.target];
    if (!target) throw bad('Unsupported language');
    const texts = (b.texts || []).slice(0, 80).map((x) => String(x ?? '').slice(0, 3000));
    const out = [];
    for (const text of texts) {
      if (!text.trim()) { out.push(text); continue; }
      const res = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'english', target_lang: target });
      out.push(res.translated_text || text);
    }
    return json({ texts: out });
  });
}

function summary(o) {
  return { id: o.id, number: o.number, status: o.status, createdAt: o.createdAt, email: o.customer?.email, name: o.customer?.name, company: o.customer?.company,
    country: o.address?.country, currency: o.currency, total: o.total, qty: o.groups?.reduce((s, g) => s + g.qty, 0), gateway: o.gateway, tracking: o.tracking || null };
}
