import { json, bad, body, uid, clean, HttpError } from '../lib/http.js';
import { pwIter, needsRehash, sign, verify, hashPassword, checkPassword, safeEqual } from '../lib/crypto.js';
import { getSettings, saveSettings, getFx, listProducts, getProduct, saveProduct, getOrder, updateOrder, logEvent, rowToOrder, starterProducts } from '../lib/store.js';
import { refreshFx, triggerPublish, publishStatus, sendEmail, orderEmailHtml } from '../lib/services.js';
import { carriers, packBoxes } from '../shipping/index.js';
import { gateways } from '../payments/index.js';
import { requireAdmin, adminToken, ROLES, googleConfigured } from '../lib/auth.js';
import { ensureInvoiceNo, invoicePdf, packingSlipPdf } from '../lib/documents.js';
import { b64 } from '../lib/services.js';
import { CARRIERS } from '../../../shared/carriers.js';

const STATUSES = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
const pdfRes = (bytes, name, inline = true) => new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'cache-control': 'private, no-store' } });
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
    return json({ hasAdmin: n.n > 0, google: googleConfigured(env) });
  });

  r.add('POST', '/api/admin/setup', async (req, env) => {
    const b = await body(req);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    if (n.n > 0) throw new HttpError(403, 'Setup already completed');
    if (!env.SETUP_TOKEN || !safeEqual(String(b.setupToken || ''), env.SETUP_TOKEN)) throw new HttpError(403, 'Invalid setup token');
    if (String(b.password || '').length < 10) throw bad('Password must be at least 10 characters');
    const email = clean(b.email, 160).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Valid email required');
    await env.DB.prepare("INSERT INTO admins (email, name, pass_hash, role, status) VALUES (?, ?, ?, 'owner', 'active')").bind(email, clean(b.name, 80), await hashPassword(b.password, pwIter(env))).run();
    return json({ ok: true });
  });

  r.add('POST', '/api/admin/login', async (req, env) => {
    const b = await body(req);
    const email = clean(b.email, 160).toLowerCase();
    const since = Date.now() - 15 * 60e3;
    const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?').bind(email, since).first();
    if (tries.n >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const a = await env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first();
    if (!a || a.status === 'disabled' || !a.pass_hash || !(await checkPassword(String(b.password || ''), a.pass_hash))) {
      await env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
      throw new HttpError(401, 'Wrong email or password');
    }
    if (needsRehash(a.pass_hash, env)) await env.DB.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').bind(await hashPassword(String(b.password), pwIter(env)), a.id).run();
    await env.DB.batch([env.DB.prepare("UPDATE admins SET last_login = datetime('now'), status = 'active' WHERE id = ?").bind(a.id), env.DB.prepare('DELETE FROM login_attempts WHERE email = ? OR at < ?').bind(email, since)]);
    return json({ token: await adminToken(env, a), user: { email: a.email, name: a.name, role: a.role, perms: ROLES[a.role] || [] } });
  });

  // Everything below requires a session.
  // A(method, path, permission, handler): every admin route declares the permission it needs.
  const A = (method, path, perm, fn) => r.add(method, path, async (req, env, ctx, p) => fn(req, env, ctx, p, await requireAdmin(req, env, perm)));

  A('GET', '/api/admin/me', null, async (req, env, ctx, p, s) => json({ user: { email: s.email, name: s.name, role: s.role, perms: ROLES[s.role] || [] } }));

  A('POST', '/api/admin/password', null, async (req, env, ctx, p, s) => {
    const b = await body(req);
    const a = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(s.id).first();
    if (a.pass_hash && !(await checkPassword(String(b.current || ''), a.pass_hash))) throw bad('Current password is wrong');
    if (String(b.next || '').length < 10) throw bad('New password must be at least 10 characters');
    await env.DB.prepare('UPDATE admins SET pass_hash = ?, session_v = session_v + 1 WHERE id = ?').bind(await hashPassword(b.next, pwIter(env)), s.id).run();
    const fresh = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(s.id).first();
    return json({ ok: true, token: await adminToken(env, fresh) });
  });

  // ---- team (owner only) ----
  A('GET', '/api/admin/team', 'team', async (req, env) => json({ members: (await env.DB.prepare('SELECT id, email, name, role, status, last_login, created_at, google_sub IS NOT NULL AS google, pass_hash != \'\' AS password FROM admins ORDER BY id').all()).results, roles: ROLES, google: googleConfigured(env) }));
  A('POST', '/api/admin/team', 'team', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const email = clean(b.email, 160).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Valid email required');
    if (!ROLES[b.role]) throw bad('Choose a role');
    if (await env.DB.prepare('SELECT id FROM admins WHERE lower(email) = ?').bind(email).first()) throw bad('This person already has access');
    const pw = String(b.password || '');
    if (pw && pw.length < 10) throw bad('Password must be at least 10 characters (or leave empty for Google-only sign-in)');
    await env.DB.prepare('INSERT INTO admins (email, name, pass_hash, role, status) VALUES (?, ?, ?, ?, ?)').bind(email, clean(b.name, 80), pw ? await hashPassword(pw, pwIter(env)) : '', b.role, pw ? 'active' : 'invited').run();
    const settings = await getSettings(env);
    const site = (settings.store.siteUrl || env.SITE_URL).replace(/\/$/, '');
    ctx.waitUntil(sendEmail(env, { to: email, subject: `You've been given access to the ${settings.store.name} dashboard`, html: `<p>${s.name || s.email} invited you as <b>${b.role}</b>.</p><p>Sign in at <a href="${site}/admin/">${site}/admin/</a> ${googleConfigured(env) ? 'with Google using this email address' : 'with the password you were given'}.</p>` }).catch(() => {}));
    return json({ ok: true });
  });
  A('PATCH', '/api/admin/team/:id', 'team', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const t = await env.DB.prepare('SELECT * FROM admins WHERE id = ?').bind(+p.id).first();
    if (!t) throw new HttpError(404, 'Not found');
    if (t.id === s.id && (b.role && b.role !== 'owner' || b.status === 'disabled')) throw bad("You can't demote or disable yourself");
    if (b.role && !ROLES[b.role]) throw bad('Invalid role');
    if (b.status && !['active', 'disabled', 'invited'].includes(b.status)) throw bad('Invalid status');
    if (b.password && String(b.password).length < 10) throw bad('Password must be at least 10 characters');
    await env.DB.prepare('UPDATE admins SET role = COALESCE(?, role), status = COALESCE(?, status), name = COALESCE(?, name), pass_hash = COALESCE(?, pass_hash), session_v = session_v + ? WHERE id = ?')
      .bind(b.role || null, b.status || null, b.name ?? null, b.password ? await hashPassword(b.password, pwIter(env)) : null, b.status === 'disabled' || b.password ? 1 : 0, t.id).run();
    return json({ ok: true });
  });
  A('DELETE', '/api/admin/team/:id', 'team', async (req, env, ctx, p, s) => {
    if (+p.id === s.id) throw bad('You cannot remove yourself');
    const owners = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND status = 'active' AND id != ?").bind(+p.id).first();
    if (!owners.n) throw bad('At least one active owner is required');
    await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(+p.id).run();
    return json({ ok: true });
  });

  // ---- customers ----
  A('GET', '/api/admin/customers', 'orders', async (req, env) => {
    const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
    const { results } = await env.DB.prepare(`SELECT c.id, c.email, c.name, c.company, c.phone, c.email_verified, c.google_sub IS NOT NULL AS google, c.created_at, c.last_login,
      (SELECT COUNT(*) FROM orders o WHERE (o.customer_id = c.id OR lower(o.email) = lower(c.email)) AND o.status NOT IN ('pending_payment','cancelled')) AS orders
      FROM customers c ${q ? 'WHERE lower(c.email) LIKE ?1 OR lower(c.name) LIKE ?1 OR lower(c.company) LIKE ?1' : ''} ORDER BY c.created_at DESC LIMIT 300`).bind(...(q ? [`%${q}%`] : [])).all();
    return json({ customers: results });
  });

  A('GET', '/api/admin/dashboard', 'dashboard', async (req, env) => {
    const [byStatus, recent, rev, msgs, prods] = await Promise.all([
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all(),
      env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8').all(),
      env.DB.prepare("SELECT currency, SUM(total) AS total, COUNT(*) AS n FROM orders WHERE status IN ('paid','processing','shipped','delivered') AND created_at > datetime('now','-30 days') GROUP BY currency").all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_read = 0').first(),
      env.DB.prepare('SELECT status, COUNT(*) AS n FROM products GROUP BY status').all(),
    ]);
    return json({ byStatus: byStatus.results, recent: recent.results.map(rowToOrder).map(summary), revenue30d: rev.results, unreadMessages: msgs.n, products: prods.results });
  });

  A('GET', '/api/admin/integrations', 'dashboard', async (req, env) => {
    const s = await getSettings(env);
    const fx = await getFx(env);
    return json({
      stripe: { configured: gateways.stripe.configured(env), webhook: !!env.STRIPE_WEBHOOK_SECRET, mode: (env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test' },
      paypal: { configured: gateways.paypal.configured(env), webhook: !!env.PAYPAL_WEBHOOK_ID, mode: s.payments?.paypal?.mode },
      dhl: { configured: carriers.dhl.configured(env), env: env.DHL_ENV || 'test' },
      github: { configured: !!(env.GITHUB_TOKEN && env.GITHUB_REPO), repo: env.GITHUB_REPO },
      email: { configured: !!(env.RESEND_API_KEY && env.EMAIL_FROM), from: env.EMAIL_FROM || null },
      ai: { configured: !!env.AI }, media: { configured: !!env.MEDIA }, google: { configured: googleConfigured(env) },
      fx: { source: fx.source || 'fallback', updated: fx.fetchedAt || fx.updated },
      webhooks: { stripe: `${env.API_URL}/api/webhooks/stripe`, paypal: `${env.API_URL}/api/webhooks/paypal` },
    });
  });

  // ---- products ----
  A('GET', '/api/admin/products', 'products', async (req, env) => json({ products: await listProducts(env) }));
  A('GET', '/api/admin/products/:id', 'products', async (req, env, ctx, p) => {
    const prod = await getProduct(env, p.id);
    if (!prod) throw new HttpError(404, 'Not found');
    return json({ product: prod });
  });
  A('POST', '/api/admin/products', 'products', async (req, env) => {
    const b = await body(req);
    const prod = normalizeProduct(b);
    if (await getProduct(env, prod.id)) throw bad('A product with this id already exists');
    const clash = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(prod.slug).first();
    if (clash) throw bad('Slug already in use');
    await saveProduct(env, prod);
    return json({ product: prod });
  });
  A('PUT', '/api/admin/products/:id', 'products', async (req, env, ctx, p) => {
    const existing = await getProduct(env, p.id);
    if (!existing) throw new HttpError(404, 'Not found');
    const prod = normalizeProduct({ ...(await body(req)), id: p.id }, existing);
    const clash = await env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').bind(prod.slug, p.id).first();
    if (clash) throw bad('Slug already in use by another product');
    await saveProduct(env, prod);
    return json({ product: prod });
  });
  A('DELETE', '/api/admin/products/:id', 'products', async (req, env, ctx, p) => {
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(p.id).run();
    return json({ ok: true });
  });
  A('POST', '/api/admin/import-starter', 'products', async (req, env) => {
    let n = 0;
    for (const sp of starterProducts) if (!(await getProduct(env, sp.id))) { await saveProduct(env, sp); n++; }
    return json({ imported: n });
  });

  // ---- media (R2) ----
  A('POST', '/api/admin/media', 'products', async (req, env) => {
    if (!env.MEDIA && !(env.GITHUB_TOKEN && env.GITHUB_REPO)) throw bad('Photo storage is not set up: add the PUBLISH_TOKEN GitHub secret (photos are stored in your GitHub repo) or enable Cloudflare R2, then re-run “Deploy API worker”.');
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || typeof file === 'string') throw bad('No file');
    if (!/^image\/(webp|jpeg|png|avif|gif|svg\+xml)$/.test(file.type)) throw bad('Images only (WebP, JPEG, PNG, AVIF)');
    if (file.size > 8 * 1024 * 1024) throw bad('Max 8 MB per image');
    const folder = slugify(fd.get('folder') || 'misc') || 'misc';
    const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[file.type];
    const name = slugify(String(file.name || '').replace(/\.[^.]+$/, '')).slice(0, 40) || 'img';
    const key = `products/${folder}/${name}-${uid(4)}.${ext}`;
    if (env.MEDIA) {
      await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      return json({ key, url: `${env.API_URL}/media/${key}` });
    }
    // Free-plan option: commit the image to the site repo; it is served by GitHub Pages after the rebuild.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = `site/static/uploads/${key}`;
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
      method: 'PUT', headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'screation-worker', 'content-type': 'application/json' },
      body: JSON.stringify({ message: `Upload product photo ${key}`, content: b64(bytes), branch: 'main' }),
    });
    if (!r.ok) throw bad(`GitHub upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const site = ((await getSettings(env)).store.siteUrl || env.SITE_URL).replace(/\/$/, '');
    return json({ key, url: `${(env.SITE_URL || site).replace(/\/$/, '')}/assets/uploads/${key}`, pending: true });
  });
  A('GET', '/api/admin/media', 'products', async (req, env) => {
    const prefix = new URL(req.url).searchParams.get('prefix') || 'products/';
    if (!env.MEDIA) return json({ objects: [] });
    const l = await env.MEDIA.list({ prefix, limit: 500 });
    return json({ objects: l.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, url: `${env.API_URL}/media/${o.key}` })) });
  });
  A('DELETE', '/api/admin/media', 'products', async (req, env) => {
    const key = new URL(req.url).searchParams.get('key');
    if (!key || !key.startsWith('products/')) throw bad('Invalid key');
    if (!env.MEDIA) throw bad('Delete photos from the repo folder site/static/uploads/ on GitHub');
    await env.MEDIA.delete(key);
    return json({ ok: true });
  });

  // ---- settings ----
  A('GET', '/api/admin/settings', 'settings', async (req, env) => json({ settings: await getSettings(env), fx: await getFx(env) }));
  A('PUT', '/api/admin/settings', 'settings', async (req, env) => {
    const b = await body(req);
    if (!b || typeof b !== 'object' || !b.store || !b.baseCurrency) throw bad('Invalid settings');
    if (!(b.currencies || []).some((c) => c.code === b.baseCurrency)) throw bad('Base currency must be in the currency list');
    if (!b.languages?.enabled?.includes(b.languages.default)) throw bad('Default language must be enabled');
    const codes = b.shipping?.dhl?.productCodes || [];
    if (codes.some((c) => !/^[A-Z0-9]{1,3}$/.test(c))) throw bad('“Limit DHL services” only takes 1–3 character DHL service codes such as P or N. Leave it empty to show all services. DHL credentials go in GitHub secrets.');
    await saveSettings(env, b);
    return json({ settings: await getSettings(env) });
  });
  // Diagnose DHL: runs one sample rate request and returns DHL's raw answer.
  A('POST', '/api/admin/shipping/test', 'settings', async (req, env) => {
    const b = await body(req);
    const settings = await getSettings(env);
    const missing = ['DHL_API_KEY', 'DHL_API_SECRET', 'DHL_ACCOUNT_NUMBER'].filter((k) => !env[k]);
    const { dhlHost } = await import('../shipping/dhl.js');
    const out = { endpoint: dhlHost(env, settings), environment: settings.shipping?.dhl?.test === false ? 'live' : 'test', enabledInSettings: !!settings.shipping?.dhl?.enabled, missingSecrets: missing,
      origin: settings.shipping?.origin, destination: { country: clean(b.country || 'US', 2).toUpperCase(), postcode: clean(b.postcode || '10001', 20), city: clean(b.city || 'New York', 80) } };
    if (missing.length) return json({ ok: false, ...out, error: `Missing GitHub secrets: ${missing.join(', ')} — add them and re-run “Deploy API worker”.` });
    try {
      const rates = await carriers.dhl.rates({ env, settings, address: out.destination, boxes: packBoxes(10000, settings), declaredValueBase: 30000 });
      return json({ ok: rates.length > 0, ...out, rates, ...(rates.length ? {} : { error: 'DHL answered but returned no products for this lane/date.' }) });
    } catch (e) { return json({ ok: false, ...out, error: e.message }); }
  });

  A('POST', '/api/admin/fx/refresh', 'settings', async (req, env) => json({ fx: await refreshFx(env, await getSettings(env)) }));

  // ---- orders ----
  A('GET', '/api/admin/orders', 'orders', async (req, env) => {
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
  A('GET', '/api/admin/orders/:id', 'orders', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const { results } = await env.DB.prepare('SELECT type, data, created_at FROM order_events WHERE order_id = ? ORDER BY id').bind(p.id).all();
    return json({ order: o, events: results.map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null })) });
  });
  const shippedEmail = async (env, ctx, o) => {
    const settings = await getSettings(env);
    const site = (settings.store.siteUrl || env.SITE_URL).replace(/\/$/, '');
    ctx.waitUntil(sendEmail(env, { to: o.customer.email, replyTo: settings.store.email, subject: `Your ${settings.store.name} order ${o.number} has shipped`,
      html: orderEmailHtml({ ...o, accountUrl: `${site}/order/?id=${o.id}&t=${o.token}` }, settings, 'Your order is on its way') }).catch(() => {}));
  };

  A('PATCH', '/api/admin/orders/:id', 'orders', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const patch = {}, changed = [];
    if (b.status && b.status !== o.status) { if (!STATUSES.includes(b.status)) throw bad('Invalid status'); patch.status = b.status; changed.push(`status → ${b.status}`); }
    if (b.shipment) {
      const sh = b.shipment;
      if (sh.carrier && !CARRIERS[sh.carrier]) throw bad('Unknown carrier');
      patch.shipment = { ...(o.shipment || {}), carrier: sh.carrier || o.shipment?.carrier || 'dhl', carrierName: clean(sh.carrierName, 60), service: clean(sh.service, 80), tracking: clean(sh.tracking, 60),
        trackingUrl: /^https:\/\//.test(sh.trackingUrl || '') ? clean(sh.trackingUrl, 300) : '', shippedAt: clean(sh.shippedAt, 30) || o.shipment?.shippedAt || null, boxes: +sh.boxes || null, weightKg: +sh.weightKg || null };
      patch.tracking = patch.shipment.tracking; // legacy field
      changed.push('shipping details');
      if (patch.shipment.tracking && !patch.status && ['paid', 'processing'].includes(o.status)) { patch.status = 'shipped'; changed.push('status → shipped'); }
      if (patch.shipment.tracking && !patch.shipment.shippedAt) patch.shipment.shippedAt = new Date().toISOString().slice(0, 10);
    }
    if (b.address) {
      const a = b.address;
      patch.address = { ...o.address, ...Object.fromEntries(['name', 'company', 'line1', 'line2', 'city', 'state', 'postcode', 'phone'].map((k) => [k, clean(a[k] ?? o.address[k], 120)])), country: clean(a.country || o.address.country, 2).toUpperCase() };
      changed.push('address');
    }
    if ('internalNote' in b) { patch.internalNote = clean(b.internalNote, 2000); changed.push('note'); }
    if (!changed.length) return json({ order: o });
    const next = await updateOrder(env, p.id, patch, { type: 'admin_update', data: { by: s.email, changed: changed.join(', ') } });
    if (b.notify && patch.status === 'shipped') await shippedEmail(env, ctx, next);
    return json({ order: next });
  });

  A('POST', '/api/admin/orders/:id/shipment', 'orders', async (req, env, ctx, p, s) => {
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    if (!carriers.dhl.configured(env)) throw bad('DHL is not configured (DHL_API_KEY, DHL_API_SECRET, DHL_ACCOUNT_NUMBER). Enter the shipping details manually instead.');
    if (o.shipment?.tracking) throw bad('This order already has a tracking number');
    const settings = await getSettings(env);
    const boxes = packBoxes(o.weightG, settings);
    const res = await carriers.dhl.createShipment({ env, settings, order: o, boxes });
    const docs = {};
    for (const [k, data] of [['label', res.labelPdfBase64], ['commercial-invoice', res.invoicePdfBase64]]) {
      if (!data || !env.MEDIA) continue; // without R2 the label is returned once below
      const key = `private/orders/${o.number}/${k}-${res.tracking}.pdf`;
      await env.MEDIA.put(key, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'application/pdf' } });
      docs[k] = key;
    }
    const shipment = { carrier: 'dhl', service: o.shipping?.carrier === 'dhl' ? o.shipping.service : 'DHL Express Worldwide', tracking: res.tracking, shippedAt: new Date().toISOString().slice(0, 10), boxes: boxes.length, weightKg: res.kg, viaApi: true };
    const next = await updateOrder(env, p.id, { shipment, tracking: res.tracking, shipmentDocs: docs, status: ['paid', 'processing'].includes(o.status) ? 'shipped' : o.status },
      { type: 'dhl_shipment', data: { by: s.email, tracking: res.tracking, boxes: boxes.length, kg: res.kg } });
    await shippedEmail(env, ctx, next);
    return json({ order: next, ...(env.MEDIA ? {} : { labelPdfBase64: res.labelPdfBase64, invoicePdfBase64: res.invoicePdfBase64 }) });
  });

  // Documents: DHL label / commercial invoice (stored), tax invoice + packing slip (generated)
  A('GET', '/api/admin/orders/:id/doc/:kind', 'orders', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const settings = await getSettings(env);
    if (p.kind === 'invoice') {
      if (['pending_payment', 'cancelled'].includes(o.status)) throw bad('Invoices are issued for paid orders only');
      o.invoiceNo = await ensureInvoiceNo(env, o, settings);
      return pdfRes(invoicePdf(o, settings), `Invoice-${o.number}.pdf`);
    }
    if (p.kind === 'packing-slip') return pdfRes(packingSlipPdf(o, settings, packBoxes(o.weightG, settings)), `Packing-slip-${o.number}.pdf`);
    const key = o.shipmentDocs?.[p.kind] || (p.kind === 'commercial-invoice' ? o.shipmentDocs?.invoice : null);
    if (!key) throw new HttpError(404, 'No document');
    const obj = await env.MEDIA.get(key);
    return pdfRes(obj.body, `${o.number}-${p.kind}.pdf`);
  });

  A('POST', '/api/admin/orders/:id/email', 'orders', async (req, env, ctx, p, s) => {
    const b = await body(req);
    const o = await getOrder(env, p.id);
    if (!o) throw new HttpError(404, 'Not found');
    const settings = await getSettings(env);
    if (!env.RESEND_API_KEY) throw bad('Email is not configured (RESEND_API_KEY / EMAIL_FROM)');
    if (b.type === 'shipped') await shippedEmail(env, ctx, o);
    else {
      const site = (settings.store.siteUrl || env.SITE_URL).replace(/\/$/, '');
      const atts = [];
      if (!['pending_payment', 'cancelled'].includes(o.status)) { o.invoiceNo = await ensureInvoiceNo(env, o, settings); atts.push({ filename: `Invoice-${o.number}.pdf`, content: b64(invoicePdf(o, settings)) }); }
      ctx.waitUntil(sendEmail(env, { to: o.customer.email, replyTo: settings.store.email, subject: `${settings.store.name} order ${o.number}`, html: orderEmailHtml({ ...o, accountUrl: `${site}/order/?id=${o.id}&t=${o.token}` }, settings, 'Your order details'), attachments: atts }).catch(() => {}));
    }
    await logEvent(env, o.id, 'email_sent', { by: s.email, type: b.type || 'confirmation' });
    return json({ ok: true });
  });

  A('GET', '/api/admin/orders/:id/tracking', 'orders', async (req, env, ctx, p) => {
    const o = await getOrder(env, p.id);
    if (!o?.shipment?.tracking || o.shipment.carrier !== 'dhl') throw bad('No DHL tracking number');
    return json(await carriers.dhl.track(env, await getSettings(env), o.shipment.tracking));
  });
  A('GET', '/api/admin/orders.csv', 'orders', async (req, env) => {
    const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5000').all();
    const rows = [['number', 'invoice', 'date', 'status', 'email', 'name', 'country', 'currency', 'subtotal', 'shipping', 'tax', 'total', 'gateway', 'tracking', 'items']];
    for (const o of results.map(rowToOrder)) rows.push([o.number, o.invoiceNo || '', o.createdAt, o.status, o.customer.email, o.customer.name, o.address.country, o.currency, o.subtotal, o.shippingAmount, o.taxAmount, o.total, o.gateway, o.shipment?.tracking || o.tracking || '', o.groups.map((g) => `${g.code}×${g.qty}`).join(' ')]);
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="orders.csv"' } });
  });

  // ---- messages ----
  A('GET', '/api/admin/messages', 'messages', async (req, env) => {
    const { results } = await env.DB.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200').all();
    return json({ messages: results.map((m) => ({ id: m.id, read: !!m.is_read, createdAt: m.created_at, ...JSON.parse(m.data) })) });
  });
  A('PATCH', '/api/admin/messages/:id', 'messages', async (req, env, ctx, p) => {
    const b = await body(req);
    await env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?').bind(b.read ? 1 : 0, +p.id).run();
    return json({ ok: true });
  });

  // ---- publish ----
  A('POST', '/api/admin/publish', 'publish', async (req, env, ctx, p, s) => json(await triggerPublish(env, `dashboard:${s.email}`)));
  A('GET', '/api/admin/publish', 'publish', async (req, env) => json(await publishStatus(env)));

  // ---- translation (Workers AI, optional) ----
  A('POST', '/api/admin/translate', 'products', async (req, env) => {
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
    country: o.address?.country, currency: o.currency, total: o.total, qty: o.groups?.reduce((s, g) => s + g.qty, 0), gateway: o.gateway, tracking: o.shipment?.tracking || o.tracking || null, account: !!o.customerId };
}
