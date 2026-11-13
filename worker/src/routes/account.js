// Google sign-in (admins + customers) and the customer account API.
import { json, bad, body, clean, HttpError } from '../lib/http.js';
import { pwIter, needsRehash, sign, verify, hashPassword, checkPassword } from '../lib/crypto.js';
import { googleConfigured, googleStartUrl, googleCallback, adminToken, customerToken, requireCustomer, safeReturn, ROLES } from '../lib/auth.js';
import { getSettings, rowToOrder, getOrder } from '../lib/store.js';
import { sendEmail } from '../lib/services.js';
import { ensureInvoiceNo, invoicePdf } from '../lib/documents.js';
import { trackingUrl, carrierName } from '../../../shared/carriers.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVOICE_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'refunded'];
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function profile(c) {
  return { id: c.id, email: c.email, name: c.name || '', phone: c.phone || '', company: c.company || '', taxId: c.tax_id || '',
    emailVerified: !!c.email_verified, hasPassword: !!c.pass_hash, google: !!c.google_sub, addresses: JSON.parse(c.addresses || '[]'), marketing: !!c.marketing, createdAt: c.created_at };
}
async function rateLimit(env, key) {
  const since = Date.now() - 15 * 60e3;
  const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND at > ?').bind(key, since).first();
  if (t.n >= 8) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
}
const fail = (env, key) => env.DB.prepare('INSERT INTO login_attempts (email, at) VALUES (?, ?)').bind(key, Date.now()).run();
const siteUrl = (env, s) => (s.store.siteUrl || env.SITE_URL).replace(/\/$/, '');

function brandedEmail(settings, title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0E0E0E"><div style="background:#0E0E0E;color:#F2F1EE;padding:16px 22px;font-weight:800"><span style="display:inline-block;width:10px;height:10px;background:#D7FF3D;margin-right:8px"></span>${h(settings.store.name.toUpperCase())}</div>
  <div style="padding:22px;background:#F2F1EE"><h2 style="margin:0 0 12px">${h(title)}</h2>${bodyHtml}<p style="font-size:12px;color:#55534F;margin-top:24px">${h(settings.store.email)} · ${h(settings.store.phone)}</p></div></div>`;
}
const button = (href, label) => `<p><a href="${h(href)}" style="display:inline-block;background:#D7FF3D;color:#0E0E0E;border:2px solid #0E0E0E;padding:12px 18px;font-weight:700;text-decoration:none">${h(label)}</a></p>`;

async function sendVerify(env, settings, c) {
  const tok = await sign(env.SESSION_SECRET, { k: 'verify', id: c.id, e: c.email }, 3 * 86400);
  return sendEmail(env, { to: c.email, subject: `Confirm your ${settings.store.name} account`, html: brandedEmail(settings, 'Confirm your email', `<p>Hi ${h(c.name || '')}, please confirm your email so we can link your orders to your account.</p>${button(`${siteUrl(env, settings)}/account/?verify=${encodeURIComponent(tok)}`, 'Confirm email')}`) });
}

/** Orders a customer may see: placed while signed in, or (once their email is verified) placed as a guest with that email. */
const ownsSql = 'customer_id = ? OR (? = 1 AND lower(email) = ?)';
const ownsArgs = (c) => [c.id, c.email_verified ? 1 : 0, c.email.toLowerCase()];

export function customerOrder(o) {
  const ship = o.shipment || (o.tracking ? { carrier: o.shipping?.carrier === 'dhl' ? 'dhl' : 'dhl', tracking: o.tracking } : null);
  return { id: o.id, number: o.number, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt || null, currency: o.currency,
    groups: o.groups.map(({ name, code, slug, qty, unit, total, lines }) => ({ name, code, slug, qty, unit, total, lines })),
    subtotal: o.subtotal, shippingAmount: o.shippingAmount, taxAmount: o.taxAmount, taxLabel: o.taxLabel, total: o.total,
    shipping: { service: o.shipping?.service, eta: o.shipping?.eta }, address: o.address,
    shipment: ship ? { carrier: carrierName(ship), tracking: ship.tracking, url: trackingUrl(ship), shippedAt: ship.shippedAt || o.shippedAt || null } : null,
    invoiceAvailable: INVOICE_STATUSES.includes(o.status), invoiceNo: o.invoiceNo || null, payUrl: o.status === 'pending_payment' ? o.payUrl : null };
}

export function accountRoutes(r) {
  // ---------- Google sign-in ----------
  r.add('GET', '/api/auth/config', async (req, env) => json({ google: googleConfigured(env) }));

  r.add('GET', '/api/auth/google', async (req, env) => {
    if (!googleConfigured(env)) throw bad('Google sign-in is not configured yet');
    const u = new URL(req.url);
    const settings = await getSettings(env);
    const audience = u.searchParams.get('for') === 'admin' ? 'admin' : 'customer';
    const fallback = siteUrl(env, settings) + (audience === 'admin' ? '/admin/' : '/account/');
    const returnTo = safeReturn(u.searchParams.get('return') || '', env, settings, fallback);
    const { url } = await googleStartUrl(env, { audience, returnTo });
    return Response.redirect(url, 302);
  });

  r.add('GET', '/api/auth/google/callback', async (req, env) => {
    const settings = await getSettings(env);
    const back = (ret, frag) => Response.redirect(`${ret.split('#')[0]}#${frag}`, 302);
    let res;
    try { res = await googleCallback(env, new URL(req.url)); }
    catch (e) { return back(siteUrl(env, settings) + '/account/', 'error=' + encodeURIComponent(e.message)); }
    const { state, profile: g, error } = res;
    if (error) return back(state.ret, 'error=' + encodeURIComponent('Google sign-in was cancelled'));

    if (state.aud === 'admin') {
      let a = await env.DB.prepare('SELECT * FROM admins WHERE google_sub = ?').bind(g.sub).first()
        || await env.DB.prepare('SELECT * FROM admins WHERE lower(email) = ?').bind(g.email).first();
      const domain = g.email.split('@')[1];
      if (!a && (settings.auth?.adminDomains || []).map((d) => d.toLowerCase()).includes(domain)) {
        await env.DB.prepare("INSERT INTO admins (email, name, pass_hash, role, status, google_sub) VALUES (?, ?, '', 'staff', 'active', ?)").bind(g.email, g.name, g.sub).run();
        a = await env.DB.prepare('SELECT * FROM admins WHERE google_sub = ?').bind(g.sub).first();
      }
      if (!a || a.status === 'disabled') return back(state.ret, 'error=' + encodeURIComponent(`${g.email} doesn't have dashboard access. Ask the owner to invite you.`));
      await env.DB.prepare("UPDATE admins SET google_sub = ?, status = 'active', name = COALESCE(NULLIF(name, ''), ?), last_login = datetime('now') WHERE id = ?").bind(g.sub, g.name, a.id).run();
      return back(state.ret, 'token=' + encodeURIComponent(await adminToken(env, a)));
    }

    if (settings.auth?.customerAccounts === false) return back(state.ret, 'error=' + encodeURIComponent('Accounts are disabled'));
    let c = await env.DB.prepare('SELECT * FROM customers WHERE google_sub = ?').bind(g.sub).first()
      || await env.DB.prepare('SELECT * FROM customers WHERE lower(email) = ?').bind(g.email).first();
    if (c) await env.DB.prepare("UPDATE customers SET google_sub = ?, email_verified = 1, name = COALESCE(NULLIF(name, ''), ?), last_login = datetime('now') WHERE id = ?").bind(g.sub, g.name, c.id).run();
    else await env.DB.prepare("INSERT INTO customers (email, name, google_sub, email_verified, last_login) VALUES (?, ?, ?, 1, datetime('now'))").bind(g.email, g.name, g.sub).run();
    c = await env.DB.prepare('SELECT * FROM customers WHERE google_sub = ?').bind(g.sub).first();
    return back(state.ret, 'ctoken=' + encodeURIComponent(await customerToken(env, c)));
  });

  // ---------- customer accounts ----------
  r.add('POST', '/api/account/register', async (req, env, ctx) => {
    const b = await body(req);
    const settings = await getSettings(env);
    if (settings.auth?.customerAccounts === false) throw bad('Accounts are disabled');
    const email = clean(b.email, 160).toLowerCase(), name = clean(b.name, 120), pw = String(b.password || '');
    if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email');
    if (pw.length < 8) throw bad('Password must be at least 8 characters');
    const exists = await env.DB.prepare('SELECT id FROM customers WHERE lower(email) = ?').bind(email).first();
    if (exists) throw new HttpError(409, 'An account with this email already exists. Sign in or reset your password.');
    await env.DB.prepare("INSERT INTO customers (email, name, pass_hash, marketing, last_login) VALUES (?, ?, ?, ?, datetime('now'))").bind(email, name, await hashPassword(pw, pwIter(env)), b.marketing ? 1 : 0).run();
    const c = await env.DB.prepare('SELECT * FROM customers WHERE lower(email) = ?').bind(email).first();
    ctx.waitUntil(sendVerify(env, settings, c).catch(() => {}));
    return json({ token: await customerToken(env, c), profile: profile(c) });
  });

  r.add('POST', '/api/account/login', async (req, env) => {
    const b = await body(req);
    const email = clean(b.email, 160).toLowerCase();
    await rateLimit(env, 'c:' + email);
    const c = await env.DB.prepare('SELECT * FROM customers WHERE lower(email) = ?').bind(email).first();
    if (!c || !c.pass_hash || !(await checkPassword(String(b.password || ''), c.pass_hash))) {
      await fail(env, 'c:' + email);
      throw new HttpError(401, c && !c.pass_hash ? 'This account uses Google sign-in. Continue with Google, or reset your password to add one.' : 'Wrong email or password');
    }
    if (needsRehash(c.pass_hash, env)) await env.DB.prepare('UPDATE customers SET pass_hash = ? WHERE id = ?').bind(await hashPassword(String(b.password), pwIter(env)), c.id).run();
    await env.DB.prepare("UPDATE customers SET last_login = datetime('now') WHERE id = ?").bind(c.id).run();
    return json({ token: await customerToken(env, c), profile: profile(c) });
  });

  r.add('POST', '/api/account/forgot', async (req, env, ctx) => {
    const b = await body(req);
    const email = clean(b.email, 160).toLowerCase();
    await rateLimit(env, 'f:' + email);
    await fail(env, 'f:' + email); // counts requests, limits abuse
    const c = await env.DB.prepare('SELECT * FROM customers WHERE lower(email) = ?').bind(email).first();
    if (c) {
      const settings = await getSettings(env);
      const tok = await sign(env.SESSION_SECRET, { k: 'reset', id: c.id, ph: String(c.pass_hash || 'none').slice(-12) }, 3600);
      ctx.waitUntil(sendEmail(env, { to: c.email, subject: `Reset your ${settings.store.name} password`, html: brandedEmail(settings, 'Reset your password', `<p>Use the button below within one hour to choose a new password. If you didn't ask for this, you can ignore this email.</p>${button(`${siteUrl(env, settings)}/account/?reset=${encodeURIComponent(tok)}`, 'Choose a new password')}`) }).catch(() => {}));
    }
    return json({ ok: true }); // same answer whether or not the email exists
  });

  r.add('POST', '/api/account/reset', async (req, env) => {
    const b = await body(req);
    const t = await verify(env.SESSION_SECRET, b.token);
    if (!t || t.k !== 'reset') throw bad('This reset link has expired. Please request a new one.');
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(t.id).first();
    if (!c || String(c.pass_hash || 'none').slice(-12) !== t.ph) throw bad('This reset link was already used. Please request a new one.');
    if (String(b.password || '').length < 8) throw bad('Password must be at least 8 characters');
    await env.DB.prepare('UPDATE customers SET pass_hash = ?, email_verified = 1, session_v = session_v + 1 WHERE id = ?').bind(await hashPassword(b.password, pwIter(env)), c.id).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first();
    return json({ token: await customerToken(env, fresh), profile: profile(fresh) });
  });

  r.add('POST', '/api/account/verify', async (req, env) => {
    const b = await body(req);
    const t = await verify(env.SESSION_SECRET, b.token);
    if (!t || t.k !== 'verify') throw bad('This confirmation link has expired.');
    await env.DB.prepare('UPDATE customers SET email_verified = 1 WHERE id = ? AND lower(email) = ?').bind(t.id, t.e).run();
    return json({ ok: true });
  });

  r.add('POST', '/api/account/resend-verification', async (req, env, ctx) => {
    const c = await requireCustomer(req, env);
    if (!c.email_verified) ctx.waitUntil(sendVerify(env, await getSettings(env), c).catch(() => {}));
    return json({ ok: true });
  });

  r.add('GET', '/api/account/me', async (req, env) => json({ profile: profile(await requireCustomer(req, env)) }));

  r.add('PUT', '/api/account/me', async (req, env) => {
    const c = await requireCustomer(req, env);
    const b = await body(req);
    const addresses = (Array.isArray(b.addresses) ? b.addresses : []).slice(0, 10).map((a, i) => ({
      id: clean(a.id, 20) || 'a' + Date.now().toString(36) + i, label: clean(a.label, 40), name: clean(a.name, 120), company: clean(a.company, 120), line1: clean(a.line1, 120), line2: clean(a.line2, 120),
      city: clean(a.city, 80), state: clean(a.state, 80), postcode: clean(a.postcode, 20), country: clean(a.country, 2).toUpperCase(), phone: clean(a.phone, 30), isDefault: !!a.isDefault,
    }));
    if (addresses.length && !addresses.some((a) => a.isDefault)) addresses[0].isDefault = true;
    await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, company = ?, tax_id = ?, addresses = ?, marketing = ? WHERE id = ?')
      .bind(clean(b.name, 120), clean(b.phone, 30), clean(b.company, 120), clean(b.taxId, 40), JSON.stringify(addresses), b.marketing ? 1 : 0, c.id).run();
    return json({ profile: profile(await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first()) });
  });

  r.add('POST', '/api/account/password', async (req, env) => {
    const c = await requireCustomer(req, env);
    const b = await body(req);
    if (c.pass_hash && !(await checkPassword(String(b.current || ''), c.pass_hash))) throw bad('Current password is wrong');
    if (String(b.next || '').length < 8) throw bad('New password must be at least 8 characters');
    await env.DB.prepare('UPDATE customers SET pass_hash = ?, session_v = session_v + 1 WHERE id = ?').bind(await hashPassword(b.next, pwIter(env)), c.id).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(c.id).first();
    return json({ token: await customerToken(env, fresh) }); // other devices are signed out
  });

  r.add('POST', '/api/account/logout-all', async (req, env) => {
    const c = await requireCustomer(req, env);
    await env.DB.prepare('UPDATE customers SET session_v = session_v + 1 WHERE id = ?').bind(c.id).run();
    return json({ ok: true });
  });

  r.add('GET', '/api/account/orders', async (req, env) => {
    const c = await requireCustomer(req, env);
    const { results } = await env.DB.prepare(`SELECT * FROM orders WHERE (${ownsSql}) AND status != 'cancelled' ORDER BY created_at DESC LIMIT 200`).bind(...ownsArgs(c)).all();
    return json({ orders: results.map(rowToOrder).map(customerOrder), emailVerified: !!c.email_verified });
  });

  r.add('GET', '/api/account/orders/:id', async (req, env, ctx, p) => {
    const c = await requireCustomer(req, env);
    const row = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND (${ownsSql})`).bind(p.id, ...ownsArgs(c)).first();
    if (!row) throw new HttpError(404, 'Order not found');
    return json({ order: customerOrder(rowToOrder(row)) });
  });

  r.add('GET', '/api/account/orders/:id/invoice', async (req, env, ctx, p) => {
    const c = await requireCustomer(req, env);
    const row = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? AND (${ownsSql})`).bind(p.id, ...ownsArgs(c)).first();
    if (!row) throw new HttpError(404, 'Order not found');
    const o = rowToOrder(row);
    if (!INVOICE_STATUSES.includes(o.status)) throw bad('The invoice is available once payment is confirmed');
    const settings = await getSettings(env);
    o.invoiceNo = await ensureInvoiceNo(env, o, settings);
    return new Response(invoicePdf(o, settings), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="Invoice-${o.number}.pdf"`, 'cache-control': 'private, no-store' } });
  });
}

export { ROLES };
