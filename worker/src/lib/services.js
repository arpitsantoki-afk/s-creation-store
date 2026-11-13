import { saveFx } from './store.js';
import { trackingUrl, carrierName } from '../../../shared/carriers.js';

/** Fetch daily exchange rates for the base currency (free sources, no key). */
export async function refreshFx(env, settings) {
  const base = settings.baseCurrency || 'INR';
  const sources = [
    async () => { const d = await (await fetch(`https://open.er-api.com/v6/latest/${base}`)).json(); if (d.result !== 'success') throw 0; return { rates: d.rates, updated: d.time_last_update_utc, source: 'open.er-api.com' }; },
    async () => { const d = await (await fetch(`https://api.frankfurter.app/latest?from=${base}`)).json(); if (!d.rates) throw 0; return { rates: { ...d.rates, [base]: 1 }, updated: d.date, source: 'frankfurter.app (ECB)' }; },
  ];
  for (const s of sources) {
    try {
      const r = await s();
      const fx = { base, ...r, fetchedAt: new Date().toISOString() };
      await saveFx(env, fx);
      return fx;
    } catch { /* try next */ }
  }
  throw new Error('All FX sources failed');
}

/** Send email with Resend (optional). Silently skipped if not configured. */
export async function sendEmail(env, { to, subject, html, replyTo, attachments }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { skipped: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html, reply_to: replyTo, attachments }),
  });
  return { ok: r.ok };
}

/** Trigger the GitHub Actions workflow that rebuilds and deploys the storefront. */
export async function triggerPublish(env, reason = 'dashboard') {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new Error('GITHUB_TOKEN / GITHUB_REPO not configured');
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST', headers: gh(env), body: JSON.stringify({ event_type: 'publish', client_payload: { reason, at: new Date().toISOString() } }),
  });
  if (r.status !== 204) throw new Error(`GitHub dispatch failed (${r.status}): ${await r.text()}`);
  return { ok: true };
}
export async function publishStatus(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { configured: false, runs: [] };
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?per_page=6`, { headers: gh(env) });
  const d = await r.json();
  return { configured: true, runs: (d.workflow_runs || []).map((w) => ({ id: w.id, name: w.name, event: w.event, status: w.status, conclusion: w.conclusion, createdAt: w.created_at, url: w.html_url })) };
}
const gh = (env) => ({ authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'screation-worker', 'x-github-api-version': '2022-11-28' });

const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function orderEmailHtml(order, settings, title) {
  const f = (v) => `${order.currency} ${v.toFixed(2)}`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0E0E0E">
  <div style="background:#0E0E0E;color:#F2F1EE;padding:18px 24px;font-weight:800;letter-spacing:.02em"><span style="display:inline-block;width:10px;height:10px;background:#D7FF3D;margin-right:8px"></span>${settings.store.name.toUpperCase()}</div>
  <div style="padding:24px;background:#F2F1EE"><h2 style="margin:0 0 8px">${h(title)}</h2><p>Order <b>${order.number}</b></p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">${order.groups.map((g) => `<tr><td style="padding:8px 0;border-bottom:1px solid #ddd"><b>${h(g.name)}</b><br><span style="color:#55534F">${h(g.lines.map((l) => `${l.color} ${l.size}×${l.qty}`).join(', '))}</span></td><td style="text-align:right;border-bottom:1px solid #ddd">${g.qty} pcs<br>${f(g.total)}</td></tr>`).join('')}
  <tr><td style="padding:8px 0">Shipping (${h(order.shipping.service)})</td><td style="text-align:right">${f(order.shippingAmount)}</td></tr>
  ${order.taxAmount ? `<tr><td>${order.taxLabel}</td><td style="text-align:right">${f(order.taxAmount)}</td></tr>` : ''}
  <tr><td style="padding:10px 0;font-weight:800;border-top:2px solid #0E0E0E">Total</td><td style="text-align:right;font-weight:800;border-top:2px solid #0E0E0E">${f(order.total)}</td></tr></table>
  <p style="margin-top:20px;font-size:14px">Ship to: ${h([order.address.name, order.address.company, order.address.line1, order.address.line2, order.address.city, order.address.state, order.address.postcode, order.address.country].filter(Boolean).join(', '))}</p>
  ${order.shipment?.tracking ? `<p>${h(carrierName(order.shipment))} tracking: <a href="${h(trackingUrl(order.shipment))}">${h(order.shipment.tracking)}</a></p>` : ''}
  ${order.accountUrl ? `<p><a href="${h(order.accountUrl)}">View your order and download your invoice</a></p>` : ''}
  <p style="font-size:13px;color:#55534F">${settings.store.email} · ${settings.store.phone}</p></div></div>`;
}

export const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
