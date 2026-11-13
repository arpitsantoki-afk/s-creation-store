// Stripe Checkout (hosted page) via the REST API — no SDK needed on Workers.
import { toMinor } from '../../../shared/pricing.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';

// STRIPE_API_BASE is only for automated tests against a mock server.
const apiBase = (env) => env.STRIPE_API_BASE || 'https://api.stripe.com/v1';

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function call(env, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const r = await fetch(apiBase(env) + path, { method: params ? 'POST' : 'GET', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: params ? form(params) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`Stripe: ${d.error?.message || r.status}`);
  return d;
}

export const stripe = {
  id: 'stripe',
  configured: (env) => !!env.STRIPE_SECRET_KEY,
  // Stripe supports 135+ presentment currencies; optionally restrict in settings.payments.stripe.currencies
  supports: (cur, s) => !s.payments?.stripe?.currencies?.length || s.payments.stripe.currencies.includes(cur),

  async create({ order, env, urls }) {
    const cur = order.currency.toLowerCase();
    const line_items = [];
    for (const g of order.groups) {
      // One line per product+colour keeps the Stripe receipt readable while staying under the 100-line limit.
      const byColor = {};
      for (const l of g.lines) byColor[l.color] = (byColor[l.color] || 0) + l.qty;
      for (const [color, qty] of Object.entries(byColor)) {
        line_items.push({ quantity: qty, price_data: { currency: cur, unit_amount: toMinor(g.unit, order.currency), product_data: { name: `${g.name} – ${color}`, description: g.lines.filter((l) => l.color === color).map((l) => `${l.size}×${l.qty}`).join(', ').slice(0, 500) } } });
      }
    }
    if (order.taxAmount) line_items.push({ quantity: 1, price_data: { currency: cur, unit_amount: toMinor(order.taxAmount, order.currency), product_data: { name: order.taxLabel || 'Tax' } } });
    const params = {
      mode: 'checkout', client_reference_id: order.id, customer_email: order.customer.email,
      success_url: urls.success, cancel_url: urls.cancel, locale: ['de', 'fr', 'es'].includes(order.lang) ? order.lang : 'auto',
      metadata: { order_id: order.id, order_number: order.number },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.number }, description: `Order ${order.number}` },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: order.shipping.service.slice(0, 100), fixed_amount: { amount: toMinor(order.shippingAmount, order.currency), currency: cur } } }],
      expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
    };
    // Arrays → Stripe bracket notation: shipping_options[0][…], line_items[0][…]
    const { shipping_options, ...rest } = params;
    const p = form(rest);
    shipping_options.forEach((s, i) => form(s, `shipping_options[${i}]`, p));
    line_items.forEach((li, i) => form(li, `line_items[${i}]`, p));
    const r = await fetch(apiBase(env) + '/checkout/sessions', { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: p });
    const d = await r.json();
    if (!r.ok) throw new Error(`Stripe: ${d.error?.message || r.status}`);
    return { redirectUrl: d.url, ref: d.id };
  },

  /** Verify webhook signature (Stripe-Signature: t=…,v1=…) and return the parsed event. */
  async webhook(req, env) {
    const raw = await req.text();
    const sig = req.headers.get('stripe-signature') || '';
    const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=')));
    if (!env.STRIPE_WEBHOOK_SECRET || !parts.t || !parts.v1) throw new Error('Missing Stripe signature');
    if (Math.abs(Date.now() / 1000 - +parts.t) > 600) throw new Error('Stale Stripe signature');
    const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${parts.t}.${raw}`);
    const v1s = sig.split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
    if (!v1s.some((v) => safeEqual(v, expected))) throw new Error('Invalid Stripe signature');
    return JSON.parse(raw);
  },

  async refund(env, paymentIntent, amountMinor) {
    return call(env, '/refunds', { payment_intent: paymentIntent, amount: amountMinor });
  },
  retrieveSession: (env, id) => call(env, `/checkout/sessions/${id}`),
};
