// Razorpay via Payment Links (hosted page; UPI, cards, netbanking, wallets; international cards once
// Razorpay enables them). Flow: create link → buyer pays on Razorpay → returns to /order/ → we confirm
// by fetching the link server-side (and via the payment_link.paid webhook).
import { toMinor } from '../../../shared/pricing.js';

const API = 'https://api.razorpay.com/v1';
const auth = (env) => 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
async function call(env, method, path, body) {
  const r = await fetch(API + path, { method, headers: { authorization: auth(env), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Razorpay: ' + (d.error?.description || r.status));
  return d;
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

export const razorpay = {
  id: 'razorpay',
  configured: (env) => !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
  supports: (cur, settings) => {
    const s = settings.payments?.razorpay || {};
    if (cur === 'INR') return true;
    return !!s.international && (!s.currencies?.length || s.currencies.includes(cur));
  },

  async create({ order, env, settings, urls }) {
    const c = order.currency;
    const d = await call(env, 'POST', '/payment_links', {
      amount: toMinor(order.total, c), currency: c, accept_partial: false,
      reference_id: order.number, description: `${settings.store.name} order ${order.number}`.slice(0, 2048),
      customer: { name: order.customer.name, email: order.customer.email, ...(/^\+?\d{10,15}$/.test((order.customer.phone || '').replace(/[^\d+]/g, '')) ? { contact: order.customer.phone.replace(/[^\d+]/g, '') } : {}) },
      notify: { sms: false, email: false }, reminder_enable: false,
      notes: { order_id: order.id, order_number: order.number },
      callback_url: urls.success, callback_method: 'get',
    });
    return { redirectUrl: d.short_url, ref: d.id };
  },

  /** Ask Razorpay whether the payment link has been paid. */
  async status(env, linkId) {
    const d = await call(env, 'GET', `/payment_links/${linkId}`);
    const pay = (d.payments || []).find((p) => p.status === 'captured') || d.payments?.[0];
    return { paid: d.status === 'paid', paymentId: pay?.payment_id || pay?.id, amount: d.amount_paid, currency: d.currency, raw: d };
  },

  /** Check the keys (lists one payment). */
  async ping(env) { await call(env, 'GET', '/payments?count=1'); return true; },

  /** Verify X-Razorpay-Signature (HMAC-SHA256 of the raw body with the webhook secret). */
  async webhook(req, env) {
    const raw = await req.text();
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET not set');
    const sig = req.headers.get('x-razorpay-signature') || '';
    if ((await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw)) !== sig) throw new Error('Razorpay webhook signature mismatch');
    return JSON.parse(raw);
  },
};
