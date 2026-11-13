import { json, bad, body, uid, clean, HttpError } from '../lib/http.js';
import { sign, verify, sha256 } from '../lib/crypto.js';
import { getSettings, getFx, listProducts, getOrder, updateOrder, logEvent } from '../lib/store.js';
import { priceCart, convert, taxFor, decimals, toMinor } from '../../../shared/pricing.js';
import { quote } from '../shipping/index.js';
import { gateways, availableGateways } from '../payments/index.js';
import { sendEmail, orderEmailHtml, b64 } from '../lib/services.js';
import { customerFromReq } from '../lib/auth.js';
import { ensureInvoiceNo, invoicePdf } from '../lib/documents.js';
import { customerOrder } from './account.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COUNTRY_CUR = { US: 'USD', GB: 'GBP', IN: 'INR', AE: 'AED', AU: 'AUD', CA: 'CAD', SG: 'SGD', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR', NZ: 'NZD', JP: 'JPY', CH: 'CHF', SA: 'SAR', QA: 'QAR' };

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw bad('Your cart is empty');
  if (items.length > 500) throw bad('Too many cart lines');
  return items.map((i) => ({ productId: clean(i.productId, 40), color: clean(i.color, 60), size: clean(i.size, 20), qty: Math.max(0, Math.min(100000, Math.floor(+i.qty || 0))) })).filter((i) => i.qty > 0);
}
function validateItems(items, products) {
  for (const i of items) {
    const p = products.find((x) => x.id === i.productId);
    if (!p) throw bad('A product in your cart is no longer available');
    if (!p.colors.some((c) => c.name === i.color)) throw bad(`${p.name}: colour “${i.color}” is no longer available`);
    if (!p.sizes.includes(i.size)) throw bad(`${p.name}: size ${i.size} is no longer available`);
  }
}
const itemsHash = (items) => sha256(JSON.stringify([...items].sort((a, b) => `${a.productId}${a.color}${a.size}`.localeCompare(`${b.productId}${b.color}${b.size}`)).map((i) => [i.productId, i.color, i.size, i.qty])));
function cleanAddress(a = {}) {
  const out = { name: clean(a.name, 120), company: clean(a.company, 120), line1: clean(a.line1, 120), line2: clean(a.line2, 120), city: clean(a.city, 80), state: clean(a.state, 80), postcode: clean(a.postcode, 20), country: clean(a.country, 2).toUpperCase(), phone: clean(a.phone, 30) };
  if (!/^[A-Z]{2}$/.test(out.country)) throw bad('Please choose a country');
  return out;
}
function checkCurrency(cur, settings, fx) {
  if (!(settings.currencies || []).some((c) => c.code === cur && c.enabled)) throw bad(`Currency ${cur} is not available`);
  if (cur !== settings.baseCurrency && !fx.rates?.[cur]) throw bad(`No exchange rate for ${cur}`);
}

export function publicRoutes(r) {
  r.add('GET', '/api/health', async (req, env) => json({ ok: true, time: new Date().toISOString() }));

  // Everything the static site generator needs, in one call.
  r.add('GET', '/api/export', async (req, env) => {
    const [settings, products, fx] = await Promise.all([getSettings(env), listProducts(env, { publishedOnly: true }), getFx(env)]);
    return json({ settings, products, fx }, 200, { 'cache-control': 'no-store' });
  });

  r.add('GET', '/api/fx', async (req, env) => {
    const fx = await getFx(env);
    return json(fx, 200, { 'cache-control': 'public, max-age=3600' });
  });

  r.add('GET', '/api/geo', async (req) => {
    const country = req.cf?.country || req.headers.get('cf-ipcountry') || null;
    return json({ country, currency: COUNTRY_CUR[country] || 'USD' }, 200, { 'cache-control': 'private, max-age=3600' });
  });

  r.add('POST', '/api/shipping/rates', async (req, env) => {
    const b = await body(req);
    const [settings, products, fx] = await Promise.all([getSettings(env), listProducts(env, { publishedOnly: true }), getFx(env)]);
    const cur = clean(b.currency, 3).toUpperCase();
    checkCurrency(cur, settings, fx);
    const items = cleanItems(b.items);
    validateItems(items, products);
    const address = cleanAddress(b.address);
    if (!address.postcode || !address.city) throw bad('Please enter your city and postal code');
    const priced = priceCart(items, products, settings, fx, cur);
    if (!priced.ok) throw bad('Each product must meet its minimum order quantity');
    const baseSubtotal = priceCart(items, products, settings, fx, settings.baseCurrency).subtotal;
    const q = await quote({ env, settings, fx, address, weightG: priced.weightG, declaredValueBase: baseSubtotal });
    if (!q.rates.length) throw new HttpError(422, 'We could not find a shipping option for this address. Please contact us for a quote.', { errors: q.errors });
    const h = await itemsHash(items);
    const tax = taxFor(address.country, priced.subtotal, settings, cur);
    const rates = [];
    for (const rt of q.rates) {
      const amount = convert(rt.amountBase, cur, settings, fx);
      const token = await sign(env.SESSION_SECRET, { k: 'rate', cur, country: address.country, postcode: address.postcode, h, amount, amountBase: rt.amountBase, carrier: rt.carrier, code: rt.code, service: rt.service, eta: rt.eta || '' }, 3 * 3600);
      rates.push({ service: rt.service, eta: rt.eta || '', amount, carrier: rt.carrier, token, tax: tax.amount, taxLabel: tax.label });
    }
    return json({ currency: cur, rates, subtotal: priced.subtotal, weightKg: +(priced.weightG / 1000).toFixed(2), boxes: q.boxes.length });
  });

  r.add('POST', '/api/checkout', async (req, env, ctx) => {
    const b = await body(req);
    const [settings, products, fx] = await Promise.all([getSettings(env), listProducts(env, { publishedOnly: true }), getFx(env)]);
    const cur = clean(b.currency, 3).toUpperCase();
    checkCurrency(cur, settings, fx);
    const items = cleanItems(b.items);
    validateItems(items, products);
    const address = cleanAddress(b.address);
    const c = b.customer || {};
    const customer = { email: clean(c.email, 160).toLowerCase(), name: clean(c.name, 120), company: clean(c.company, 120), phone: clean(c.phone, 30), taxId: clean(c.taxId, 40) };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw bad('Please enter a valid email');
    if (!customer.name || !address.line1 || !address.city || !address.postcode) throw bad('Please complete your shipping address');

    const priced = priceCart(items, products, settings, fx, cur);
    if (!priced.ok) throw bad('Each product must meet its minimum order quantity');
    const rate = await verify(env.SESSION_SECRET, b.rateToken);
    if (!rate || rate.k !== 'rate') throw bad('Your shipping quote expired. Please recalculate shipping.');
    if (rate.cur !== cur || rate.country !== address.country || rate.postcode !== address.postcode || rate.h !== (await itemsHash(items))) throw bad('Your cart or address changed. Please recalculate shipping.');

    const gw = gateways[b.gateway];
    if (!gw || !availableGateways(env, settings, cur).includes(gw)) throw bad('This payment method is not available for ' + cur);

    const tax = taxFor(address.country, priced.subtotal, settings, cur);
    const dp = decimals(cur);
    const total = +(priced.subtotal + rate.amount + tax.amount).toFixed(dp);
    const id = uid(10), token = uid(16);
    const order = {
      lang: ['en', 'de', 'fr', 'es'].includes(b.lang) ? b.lang : 'en', currency: cur, fxRate: cur === settings.baseCurrency ? 1 : fx.rates[cur],
      customer, address, notes: clean(b.notes, 1000), gateway: gw.id,
      groups: priced.groups.map(({ productId, code, name, slug, hsCode, qty, moq, unit, total, lines }) => ({ productId, code, name, slug, hsCode, qty, moq, unit, total, lines,
        weightG: products.find((p) => p.id === productId)?.weightG })),
      subtotal: priced.subtotal, weightG: priced.weightG,
      shipping: { carrier: rate.carrier, code: rate.code, service: rate.service, eta: rate.eta, amountBase: rate.amountBase },
      shippingAmount: rate.amount, taxAmount: tax.amount, taxLabel: tax.label, total,
    };
    const prefix = (settings.orders?.numberPrefix || 'SC').replace(/[^A-Z0-9-]/gi, '');
    const cust = await customerFromReq(req, env);
    const { status, ...data } = { status: 'pending_payment', ...order };
    await env.DB.prepare(`INSERT INTO orders (id, seq, number, status, email, currency, total, gateway, token, data, customer_id)
      SELECT ?, s, ? || '-' || s, 'pending_payment', ?, ?, ?, ?, ?, ?, ? FROM (SELECT COALESCE(MAX(seq), 1000) + 1 AS s FROM orders)`)
      .bind(id, prefix, customer.email, cur, total, gw.id, token, JSON.stringify(data), cust?.id ?? null).run();
    const saved = await getOrder(env, id);

    const site = (settings.store.siteUrl || env.SITE_URL).replace(/\/$/, '');
    let ret = String(b.returnBase || '');
    const okOrigins = [site, env.SITE_URL, ...(env.ALLOWED_ORIGINS || '').split(',')].filter(Boolean).map((s) => s.trim().replace(/\/$/, ''));
    if (!okOrigins.some((o) => ret.startsWith(o + '/')) && !/^https:\/\/[a-z0-9-]+\.github\.io\//i.test(ret)) ret = site + '/order/';
    const q = `id=${id}&t=${token}&gateway=${gw.id}`;
    const urls = { success: `${ret}?${q}${gw.id === 'stripe' ? '&session_id={CHECKOUT_SESSION_ID}' : ''}`, cancel: `${ret}?${q}&cancel=1` };
    try {
      const pay = await gw.create({ order: saved, env, settings, urls });
      await updateOrder(env, id, { gatewayRef: pay.ref, payUrl: pay.redirectUrl }, { type: 'payment_started', data: { gateway: gw.id, ref: pay.ref } });
      return json({ orderId: id, token, number: saved.number, redirectUrl: pay.redirectUrl });
    } catch (e) {
      await updateOrder(env, id, { status: 'cancelled' }, { type: 'payment_error', data: { message: e.message } });
      throw new HttpError(502, e.message);
    }
  });

  r.add('GET', '/api/orders/:id', async (req, env, ctx, p) => {
    const o = await authOrder(req, env, p.id);
    // If the Stripe webhook hasn't arrived yet, confirm directly with Stripe.
    if (o.status === 'pending_payment' && o.gateway === 'stripe' && o.gatewayRef && gateways.stripe.configured(env)) {
      try {
        const s = await gateways.stripe.retrieveSession(env, o.gatewayRef);
        if (s.payment_status === 'paid') return json({ order: publicOrder(await markPaid(env, ctx, o, { sessionId: s.id, paymentIntent: s.payment_intent, amount: s.amount_total })) });
      } catch { /* fall through */ }
    }
    return json({ order: publicOrder(o) });
  });

  // Guest invoice download (the order link in the confirmation email carries the access token).
  r.add('GET', '/api/orders/:id/invoice', async (req, env, ctx, p) => {
    const o = await authOrder(req, env, p.id);
    if (!['paid', 'processing', 'shipped', 'delivered', 'refunded'].includes(o.status)) throw bad('The invoice is available once payment is confirmed');
    const settings = await getSettings(env);
    o.invoiceNo = await ensureInvoiceNo(env, o, settings);
    return new Response(invoicePdf(o, settings), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="Invoice-${o.number}.pdf"`, 'cache-control': 'private, no-store' } });
  });

  r.add('POST', '/api/orders/:id/capture', async (req, env, ctx, p) => {
    const o = await authOrder(req, env, p.id);
    if (o.gateway !== 'paypal') throw bad('Not a PayPal order');
    if (o.status !== 'pending_payment') return json({ order: publicOrder(o) });
    const settings = await getSettings(env);
    const cap = await gateways.paypal.capture(env, settings, o.gatewayRef);
    if (!cap.ok) { await logEvent(env, o.id, 'paypal_capture_failed', { status: cap.raw?.status }); throw bad('Payment was not completed'); }
    if (cap.amount && (cap.amount.currency_code !== o.currency || Math.abs(+cap.amount.value - o.total) > 0.01)) await logEvent(env, o.id, 'amount_mismatch', cap.amount);
    return json({ order: publicOrder(await markPaid(env, ctx, o, { captureId: cap.captureId, amount: cap.amount })) });
  });

  r.add('POST', '/api/webhooks/stripe', async (req, env, ctx) => {
    let ev;
    try { ev = await gateways.stripe.webhook(req, env); } catch (e) { return json({ error: e.message }, 400); }
    const s = ev.data?.object || {};
    const id = s.client_reference_id || s.metadata?.order_id;
    const o = id ? await getOrder(env, id) : null;
    if (!o) return json({ received: true, ignored: 'no order' });
    if ((ev.type === 'checkout.session.completed' && s.payment_status === 'paid') || ev.type === 'checkout.session.async_payment_succeeded') {
      if (s.amount_total !== toMinor(o.total, o.currency)) await logEvent(env, o.id, 'amount_mismatch', { stripe: s.amount_total, expected: toMinor(o.total, o.currency) });
      if (o.status === 'pending_payment') await markPaid(env, ctx, o, { sessionId: s.id, paymentIntent: s.payment_intent, amount: s.amount_total });
    } else if (ev.type === 'checkout.session.expired' && o.status === 'pending_payment') {
      await updateOrder(env, o.id, { status: 'cancelled' }, { type: 'payment_expired' });
    } else if (ev.type === 'checkout.session.async_payment_failed') {
      await updateOrder(env, o.id, { status: 'cancelled' }, { type: 'payment_failed' });
    }
    return json({ received: true });
  });

  r.add('POST', '/api/webhooks/paypal', async (req, env, ctx) => {
    const settings = await getSettings(env);
    let ev;
    try { ev = await gateways.paypal.webhook(req, env, settings); } catch (e) { return json({ error: e.message }, 400); }
    if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const id = ev.resource?.custom_id || ev.resource?.supplementary_data?.related_ids?.order_id;
      const o = await getOrder(env, id) || (await env.DB.prepare('SELECT id FROM orders WHERE gateway_ref = ?').bind(ev.resource?.supplementary_data?.related_ids?.order_id || '').first().then((r) => r && getOrder(env, r.id)));
      if (o && o.status === 'pending_payment') await markPaid(env, ctx, o, { captureId: ev.resource.id, amount: ev.resource.amount });
    }
    return json({ received: true });
  });

  r.add('POST', '/api/contact', async (req, env, ctx) => {
    const b = await body(req);
    if (b.website) return json({ ok: true }); // honeypot
    const m = { name: clean(b.name, 120), email: clean(b.email, 160), company: clean(b.company, 120), phone: clean(b.phone, 40), message: clean(b.message, 5000), lang: clean(b.lang, 5), page: clean(b.page, 200), country: req.cf?.country || null };
    if (!m.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email) || m.message.length < 5) throw bad('Please fill in your name, email and message');
    await env.DB.prepare('INSERT INTO messages (data) VALUES (?)').bind(JSON.stringify(m)).run();
    const settings = await getSettings(env);
    ctx.waitUntil(sendEmail(env, { to: settings.orders?.notifyEmail || settings.store.email, replyTo: m.email, subject: `New enquiry from ${m.name}${m.company ? ' (' + m.company + ')' : ''}`,
      html: `<p><b>${esc(m.name)}</b> &lt;${esc(m.email)}&gt; ${esc(m.phone)} ${esc(m.company)}</p><p>${esc(m.message).replace(/\n/g, '<br>')}</p><p style="color:#888">${esc(m.page)} · ${esc(m.country || '')}</p>` }).catch(() => {}));
    return json({ ok: true });
  });

  // Public product media from R2
  r.add('GET', '/media/*', async (req, env, ctx, p) => {
    const key = decodeURIComponent(p.rest || '');
    if (!key || key.includes('..') || key.startsWith('private/')) return new Response('Not found', { status: 404 });
    const obj = await env.MEDIA.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    h.set('cache-control', 'public, max-age=31536000, immutable');
    h.set('access-control-allow-origin', '*');
    return new Response(obj.body, { headers: h });
  });
}

async function authOrder(req, env, id) {
  const t = new URL(req.url).searchParams.get('t');
  const o = await getOrder(env, id);
  if (!o || !t || o.token !== t) throw new HttpError(404, 'Order not found');
  return o;
}

export function publicOrder(o) {
  const { address, ...rest } = customerOrder(o);
  return rest;
}

export async function markPaid(env, ctx, o, payment) {
  let next = await updateOrder(env, o.id, { status: 'paid', paidAt: new Date().toISOString(), payment }, { type: 'paid', data: payment });
  const settings = await getSettings(env);
  next.invoiceNo = await ensureInvoiceNo(env, next, settings);
  next.accountUrl = `${(settings.store.siteUrl || env.SITE_URL).replace(/\/$/, '')}/order/?id=${o.id}&t=${o.token}`;
  const attachments = [{ filename: `Invoice-${o.number}.pdf`, content: b64(invoicePdf(next, settings)) }];
  ctx?.waitUntil?.(Promise.all([
    sendEmail(env, { to: o.customer.email, replyTo: settings.store.email, subject: `${settings.store.name} order ${o.number} confirmed`, html: orderEmailHtml(next, settings, 'Thank you — your order is confirmed'), attachments }),
    sendEmail(env, { to: settings.orders?.notifyEmail || settings.store.email, subject: `New paid order ${o.number} — ${o.currency} ${o.total}`, html: orderEmailHtml(next, settings, `New order from ${o.customer.name}`) }),
  ]).catch(() => {}));
  return next;
}
