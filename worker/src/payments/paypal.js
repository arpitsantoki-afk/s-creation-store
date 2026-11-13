// PayPal Orders v2 (redirect flow): create → buyer approves on PayPal → we capture on return.
import { decimals } from '../../../shared/pricing.js';

const base = (settings, env = {}) => env.PAYPAL_API_BASE || (settings.payments?.paypal?.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
// Currencies PayPal accepts for cross-border payments (INR only for India-domestic accounts).
export const PAYPAL_CURRENCIES = ['AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD'];

async function token(env, settings) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing)');
  const r = await fetch(base(settings, env) + '/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded' },
  });
  const d = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed: ' + (d.error_description || r.status));
  return d.access_token;
}
async function call(env, settings, path, bodyObj, extraHeaders = {}) {
  const tk = await token(env, settings);
  const r = await fetch(base(settings, env) + path, { method: 'POST', headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(bodyObj || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('PayPal: ' + (d.details?.[0]?.description || d.message || r.status));
  return d;
}
const amt = (v, cur) => v.toFixed(decimals(cur));

export const paypal = {
  id: 'paypal',
  configured: (env) => !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
  supports: (cur, settings) => PAYPAL_CURRENCIES.includes(cur) && (!settings.payments?.paypal?.currencies?.length || settings.payments.paypal.currencies.includes(cur)),

  async create({ order, env, settings, urls }) {
    const c = order.currency;
    const items = order.groups.map((g) => ({ name: g.name.slice(0, 127), sku: g.code, quantity: String(g.qty), unit_amount: { currency_code: c, value: amt(g.unit, c) }, category: 'PHYSICAL_GOODS' }));
    const a = order.address;
    const d = await call(env, settings, '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.id, invoice_id: order.number, custom_id: order.id, description: `${settings.store.name} order ${order.number}`,
        amount: { currency_code: c, value: amt(order.total, c), breakdown: {
          item_total: { currency_code: c, value: amt(order.subtotal, c) },
          shipping: { currency_code: c, value: amt(order.shippingAmount, c) },
          tax_total: { currency_code: c, value: amt(order.taxAmount || 0, c) },
        } },
        items,
        shipping: { name: { full_name: a.name.slice(0, 300) }, address: { address_line_1: a.line1, address_line_2: a.line2 || undefined, admin_area_2: a.city, admin_area_1: a.state || undefined, postal_code: a.postcode, country_code: a.country } },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: settings.store.name, user_action: 'PAY_NOW', shipping_preference: 'SET_PROVIDED_ADDRESS',
        locale: { de: 'de-DE', fr: 'fr-FR', es: 'es-ES' }[order.lang] || 'en-US', return_url: urls.success, cancel_url: urls.cancel,
      }, email_address: order.customer.email } },
    }, { 'PayPal-Request-Id': order.id });
    const link = d.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!link) throw new Error('PayPal did not return an approval link');
    return { redirectUrl: link.href, ref: d.id };
  },

  /** Capture an approved order. Returns { ok, captureId, raw } */
  async capture(env, settings, paypalOrderId) {
    const d = await call(env, settings, `/v2/checkout/orders/${paypalOrderId}/capture`, {}, { 'PayPal-Request-Id': 'cap-' + paypalOrderId });
    const cap = d.purchase_units?.[0]?.payments?.captures?.[0];
    return { ok: d.status === 'COMPLETED' && cap?.status === 'COMPLETED', captureId: cap?.id, amount: cap?.amount, raw: d };
  },

  /** Verify a webhook with PayPal's verification API (requires PAYPAL_WEBHOOK_ID). */
  async webhook(req, env, settings) {
    const raw = await req.text();
    if (!env.PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID not set');
    const h = (k) => req.headers.get(k);
    const v = await call(env, settings, '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: JSON.parse(raw),
    });
    if (v.verification_status !== 'SUCCESS') throw new Error('PayPal webhook verification failed');
    return JSON.parse(raw);
  },
};
