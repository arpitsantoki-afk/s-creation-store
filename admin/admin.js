// S Creation dashboard — single-page app talking to the Worker API.
import { CARRIERS, trackingUrl } from '../assets/js/carriers.js';
const API = (localStorage.getItem('sc_admin_api') || window.SC?.api || '').replace(/\/$/, '');
const SITE = (window.SC?.base || '');
const app = document.getElementById('app');
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let token = sessionStorage.getItem('sc_admin_token');
let user = null, settingsCache = null, fxCache = null, dirty = false;

function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = ''), err ? 6000 : 2600);
}
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch(API + path, {
    ...opts,
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
    body: opts.body && !isForm && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (r.status === 401 && token) { logout(); throw new Error('Session expired'); }
  if (opts.raw) return r;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}
function logout() { token = null; sessionStorage.removeItem('sc_admin_token'); location.hash = ''; route(); }

// ---------- path helpers & binding ----------
const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setP(o, p, v) {
  const ks = p.split('.'); let cur = o;
  ks.slice(0, -1).forEach((k, i) => { if (cur[k] == null) cur[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; cur = cur[k]; });
  cur[ks.at(-1)] = v;
}
function readInput(el) {
  const t = el.dataset.type;
  if (el.type === 'checkbox') return el.checked;
  if (t === 'number') return el.value === '' ? null : +el.value;
  if (t === 'lines') return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (t === 'csv') return el.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (t === 'upper-csv') return el.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (t === 'json') { try { el.style.borderColor = ''; return JSON.parse(el.value); } catch { el.style.borderColor = 'var(--err)'; return undefined; } }
  return el.value;
}
function writeValue(v, t) {
  if (v == null) return '';
  if (t === 'lines') return (v || []).join('\n');
  if (t === 'csv' || t === 'upper-csv') return (v || []).join(', ');
  if (t === 'json') return JSON.stringify(v, null, 2);
  return v;
}
/** Bind every [data-k] inside root to obj. onChange gets (path, value). */
function bind(root, obj, onChange) {
  for (const el of $$('[data-k]', root)) {
    const v = getP(obj, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = writeValue(v, el.dataset.type);
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      const val = readInput(el);
      if (val === undefined) return;
      setP(obj, el.dataset.k, val); dirty = true; onChange?.(el.dataset.k, val);
    });
  }
}
// Field builders (HTML strings)
const F = {
  text: (k, label, o = {}) => `<label class="f">${label}${o.hint ? ` <small>${o.hint}</small>` : ''}<input class="i" data-k="${k}" ${o.type ? `type="${o.type}"` : ''} ${o.type === 'number' ? 'data-type="number" step="any"' : ''} ${o.ph ? `placeholder="${esc(o.ph)}"` : ''} ${o.max ? `maxlength="${o.max}"` : ''}></label>`,
  num: (k, label, o = {}) => F.text(k, label, { ...o, type: 'number' }),
  area: (k, label, o = {}) => `<label class="f">${label}${o.hint ? ` <small>${o.hint}</small>` : ''}<textarea class="i ${o.code ? 'code' : ''}" data-k="${k}" ${o.type ? `data-type="${o.type}"` : ''} rows="${o.rows || 4}"></textarea></label>`,
  lines: (k, label, o = {}) => F.area(k, label, { ...o, type: 'lines', hint: o.hint || 'one per line' }),
  csv: (k, label, o = {}) => `<label class="f">${label} <small>${o.hint || 'comma-separated'}</small><input class="i" data-k="${k}" data-type="${o.upper ? 'upper-csv' : 'csv'}"></label>`,
  sel: (k, label, opts) => `<label class="f">${label}<select class="i" data-k="${k}">${opts.map((o) => (Array.isArray(o) ? `<option value="${esc(o[0])}">${esc(o[1])}</option>` : `<option>${esc(o)}</option>`)).join('')}</select></label>`,
  bool: (k, label) => `<label class="check"><input type="checkbox" data-k="${k}"> ${label}</label>`,
  color: (k) => `<input class="i" type="color" data-k="${k}">`,
};
/** Repeater for arrays of objects. fields: [{k,label,kind:'text'|'num'|'area'|'bool'|'csv',wide}] */
function rep(path, fields, arr = [], { cols, addLabel = 'Add' } = {}) {
  const tpl = cols || fields.map((f) => (f.kind === 'bool' ? 'auto' : f.wide ? '2fr' : '1fr')).join(' ');
  return `<div class="rep" data-rep="${path}">${(arr || []).map((_, i) => `<div class="ri" style="grid-template-columns:${tpl} auto">
    ${fields.map((f) => { const k = `${path}.${i}.${f.k}`; const lbl = i === 0 ? f.label : ''; return f.kind === 'bool' ? `<label class="f">${lbl || '&nbsp;'}<input type="checkbox" data-k="${k}" style="width:18px;height:18px;margin-top:10px"></label>` : (F[f.kind || 'text'] || F.text)(k, lbl, f); }).join('')}
    <div class="ctl" style="padding-top:${i === 0 ? 18 : 0}px"><button class="iconbtn" title="Move up" data-rep-up="${path}" data-i="${i}">↑</button><button class="iconbtn" title="Remove" data-rep-del="${path}" data-i="${i}">✕</button></div></div>`).join('')}
    <div class="add"><button class="btn ghost sm" data-rep-add="${path}">+ ${addLabel}</button></div></div>`;
}
function wireReps(root, obj, rerender, blanks = {}) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-rep-add],[data-rep-del],[data-rep-up]'); if (!a) return;
    e.preventDefault();
    const path = a.dataset.repAdd || a.dataset.repDel || a.dataset.repUp;
    const arr = getP(obj, path) || []; if (!getP(obj, path)) setP(obj, path, arr);
    const i = +a.dataset.i;
    if (a.dataset.repAdd) arr.push(structuredClone(blanks[path] ?? {}));
    if (a.dataset.repDel) arr.splice(i, 1);
    if (a.dataset.repUp && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    dirty = true; rerender();
  });
}
const money = (v, c) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(v); } catch { return `${c} ${v}`; } };
const date = (s) => (s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;
const STATUS = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

// ---------- shell ----------
let unread = 0;
const can = (perm) => (user?.perms || []).includes(perm);
const NAV = [['dashboard', 'Dashboard', 'dashboard'], ['orders', 'Orders', 'orders'], ['customers', 'Customers', 'orders'], ['products', 'Products', 'products'], ['messages', 'Messages', 'messages'],
  ['settings', 'Settings', 'settings'], ['team', 'Team', 'team'], ['publish', 'Publish', 'publish']];
function shell(active, title, inner, actions = '') {
  app.innerHTML = `<div class="shell"><aside class="side"><div class="logo"><i></i>S CREATION<button class="menu" aria-label="Menu" data-menu>☰</button></div>
    <nav class="sidenav">${NAV.filter((n) => can(n[2])).map(([k, n]) => `<a href="#/${k}" class="${active === k ? 'on' : ''}">${n}${k === 'messages' && unread ? `<span class="badge">${unread}</span>` : ''}</a>`).join('')}
    <a href="#/me" class="${active === 'me' ? 'on' : ''}">My account</a></nav>
    <div class="foot">${esc(user?.name || user?.email || '')}<br><span class="mono">${esc(user?.role || '')}</span><br><a href="${SITE}/" target="_blank">View site ↗</a> · <a href="#" data-logout>Sign out</a></div></aside>
    <div class="main"><div class="top"><div class="title">${title}</div>${actions}${can('publish') ? '<button class="btn accent" data-publish>Publish site</button>' : ''}</div><div class="content">${inner}</div></div></div>`;
  $('[data-logout]').onclick = (e) => { e.preventDefault(); logout(); };
  $('[data-menu]').onclick = () => $('.side').classList.toggle('open');
  const pb = $('[data-publish]'); if (pb) pb.onclick = publish;
}
async function publish() {
  if (dirty && !confirm('You have unsaved changes on this page. Publish anyway?')) return;
  try { await api('/api/admin/publish', { method: 'POST' }); toast('Publishing… the site updates in about 1–2 minutes.'); }
  catch (e) { toast(e.message, true); }
}
async function getSettings(force = false) {
  if (!settingsCache || force) { const d = await api('/api/admin/settings'); settingsCache = d.settings; fxCache = d.fx; }
  return settingsCache;
}

// ---------- auth screens ----------
async function renderAuth() {
  if (!API) { app.innerHTML = `<div class="login"><div class="box"><div class="logo"><i></i>S CREATION</div><p>API URL not configured. Set <code>store.apiUrl</code> in settings, or run <code>localStorage.sc_admin_api='https://api.example.com'</code> in the console.</p></div></div>`; return; }
  let hasAdmin = true, google = false;
  const frag = new URLSearchParams(location.hash.slice(1));
  const gErr = frag.get('error');
  if (gErr) history.replaceState(null, '', location.pathname);
  try { const st = await api('/api/admin/status'); hasAdmin = st.hasAdmin; google = st.google; } catch (e) { app.innerHTML = `<div class="login"><div class="box"><div class="logo"><i></i>S CREATION</div><div class="errbox">Cannot reach the API at ${esc(API)}: ${esc(e.message)}</div></div></div>`; return; }
  app.innerHTML = `<div class="login"><form class="box stack" id="auth"><div class="logo"><i></i>S CREATION</div>
    <h1 style="font-size:24px">${hasAdmin ? 'Sign in' : 'Create the owner account'}</h1>
    ${gErr ? `<div class="errbox">${esc(gErr)}</div>` : ''}
    ${hasAdmin && google ? `<a class="btn ghost" style="height:44px;justify-content:center" href="${API}/api/auth/google?for=admin&return=${encodeURIComponent(location.origin + location.pathname)}">${GOOGLE_SVG} Continue with Google</a><div class="mono muted" style="text-align:center">or with email</div>` : ''}
    ${hasAdmin ? '' : '<p class="muted">First-time setup. Use the SETUP_TOKEN secret you set on the Worker.</p><label class="f">Name<input class="i" name="name"></label>'}
    <label class="f">Email<input class="i" name="email" type="email" required autocomplete="username"></label>
    <label class="f">Password${hasAdmin ? '' : ' <small>min. 10 characters</small>'}<input class="i" name="password" type="password" required autocomplete="${hasAdmin ? 'current-password' : 'new-password'}"></label>
    ${hasAdmin ? '' : '<label class="f">Setup token<input class="i" name="setupToken" required></label>'}
    <button class="btn accent" style="height:44px">${hasAdmin ? 'Sign in' : 'Create account'}</button><div id="autherr"></div></form></div>`;
  $('#auth').onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    try {
      if (!hasAdmin) await api('/api/admin/setup', { method: 'POST', body: v });
      const d = await api('/api/admin/login', { method: 'POST', body: { email: v.email, password: v.password } });
      token = d.token; user = d.user; sessionStorage.setItem('sc_admin_token', token);
      location.hash = '#/dashboard'; route();
    } catch (ex) { $('#autherr').innerHTML = `<div class="errbox">${esc(ex.message)}</div>`; }
  };
}

// ---------- dashboard ----------
async function viewDashboard() {
  const [d, integ] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/integrations')]);
  unread = d.unreadMessages;
  const n = (s) => d.byStatus.find((x) => x.status === s)?.n || 0;
  const pc = (s) => d.products.find((x) => x.status === s)?.n || 0;
  const ok = (b, label, extra = '') => `<div style="padding:6px 0"><span class="dot ${b ? 'ok' : 'no'}"></span>${label} <span class="muted">${extra}</span></div>`;
  shell('dashboard', 'Dashboard', `
  <div class="grid4" style="margin-bottom:18px">
    <div class="kpi"><div class="mono muted">To fulfil</div><b>${n('paid') + n('processing')}</b><span class="muted">paid + processing</span></div>
    <div class="kpi"><div class="mono muted">Revenue · 30 days</div><b style="font-size:22px">${d.revenue30d.length ? d.revenue30d.map((r) => money(r.total, r.currency)).join('<br>') : '—'}</b><span class="muted">${d.revenue30d.reduce((s, r) => s + r.n, 0)} orders</span></div>
    <div class="kpi"><div class="mono muted">Awaiting payment</div><b>${n('pending_payment')}</b><span class="muted">abandoned or in progress</span></div>
    <div class="kpi"><div class="mono muted">Products live</div><b>${pc('published')}</b><span class="muted">${pc('draft')} drafts</span></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Recent orders <a class="btn ghost sm" href="#/orders">All orders</a></h2>${ordersTable(d.recent)}</div>
    <div class="card"><h2>Setup checklist</h2>
      ${ok(integ.stripe.configured, 'Stripe', integ.stripe.configured ? `${integ.stripe.mode} mode${integ.stripe.webhook ? '' : ' · webhook secret missing'}` : 'add STRIPE_SECRET_KEY')}
      ${ok(integ.paypal.configured, 'PayPal', integ.paypal.configured ? integ.paypal.mode : 'add PAYPAL_CLIENT_ID / SECRET')}
      ${ok(integ.dhl.configured, 'DHL Express', integ.dhl.configured ? 'key saved — test it in Settings → Shipping' : 'add your DHL API key in Settings → Shipping — zone rates in use')}
      ${ok(integ.github.configured, 'Publishing (GitHub)', integ.github.repo || 'add GITHUB_TOKEN')}
      ${ok(integ.email.configured, 'Emails — orders, invoices, password resets (Resend)', integ.email.from || 'add RESEND_API_KEY + EMAIL_FROM')}
      ${ok(integ.google.configured, 'Google sign-in', integ.google.configured ? 'customers + team' : 'add GOOGLE_CLIENT_ID / SECRET')}
      ${ok(integ.fx.source !== 'fallback', 'Exchange rates', `${integ.fx.source || ''} ${integ.fx.updated ? '· ' + integ.fx.updated : ''}`)}
      ${ok(pc('published') > 0, 'Products published', pc('published') ? '' : '<a href="#/products">import or add products</a>')}
      <p class="muted" style="margin:12px 0 0;font-size:12px">Stripe webhook: <code>${esc(integ.webhooks.stripe)}</code><br>PayPal webhook: <code>${esc(integ.webhooks.paypal)}</code></p>
    </div></div>`);
}
function ordersTable(orders) {
  if (!orders.length) return '<div class="empty">No orders yet.</div>';
  return `<div class="wrapt"><table class="t"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Country</th><th class="r">Pcs</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
    ${orders.map((o) => `<tr class="click" data-href="#/orders/${o.id}"><td><b>${esc(o.number)}</b></td><td>${date(o.createdAt)}</td><td>${esc(o.name)} ${o.account ? '<span class="mono muted" title="has an account">●</span>' : ''}<div class="muted" style="font-size:12px">${esc(o.company || o.email)}</div></td><td>${esc(o.country)}</td><td class="r">${o.qty}</td><td class="r">${money(o.total, o.currency)}</td><td><span class="tag ${o.status}">${o.status.replace('_', ' ')}</span></td></tr>`).join('')}
  </tbody></table></div>`;
}
document.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr) location.hash = tr.dataset.href; });

// ---------- orders ----------
async function viewOrders() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = q.get('status') || '', search = q.get('q') || '';
  const d = await api(`/api/admin/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(search)}`);
  shell('orders', 'Orders', `
    <div class="row" style="margin-bottom:16px"><div class="pills">${['', ...STATUS].map((s) => `<button data-st="${s}" class="${s === status ? 'on' : ''}">${s ? s.replace('_', ' ') : 'All'}</button>`).join('')}</div>
      <div class="spacer"></div><form id="osearch" class="row"><input class="i" name="q" placeholder="Search number, email, name…" value="${esc(search)}" style="width:260px"><button class="btn ghost sm">Search</button></form></div>
    ${ordersTable(d.orders)}`, `<button class="btn ghost" data-csv>Export CSV</button>`);
  $$('[data-st]').forEach((b) => (b.onclick = () => (location.hash = `#/orders?status=${b.dataset.st}&q=${encodeURIComponent(search)}`)));
  $('#osearch').onsubmit = (e) => { e.preventDefault(); location.hash = `#/orders?status=${status}&q=${encodeURIComponent(new FormData(e.target).get('q'))}`; };
  $('[data-csv]').onclick = async () => { const r = await api('/api/admin/orders.csv', { raw: true }); const u = URL.createObjectURL(await r.blob()); const a = Object.assign(document.createElement('a'), { href: u, download: 'orders.csv' }); a.click(); };
}
async function viewOrder(id) {
  const { order: o, events } = await api('/api/admin/orders/' + id);
  const a = o.address, c = o.customer, sh = o.shipment || (o.tracking ? { carrier: 'dhl', tracking: o.tracking } : {});
  const paid = !['pending_payment', 'cancelled'].includes(o.status);
  const docBtn = (kind, label, cls = 'btn ghost sm') => `<button class="${cls}" data-doc="${kind}">${label}</button>`;
  shell('orders', `<a href="#/orders" style="text-decoration:none">Orders</a> / ${esc(o.number)} <span class="tag ${o.status}">${o.status.replace('_', ' ')}</span>`, `
  <div class="card" style="padding:14px 20px"><div class="row">
    <span class="mono muted">Quick actions</span>
    ${o.status === 'paid' ? '<button class="btn sm" data-st="processing">Mark processing</button>' : ''}
    ${o.status === 'shipped' ? '<button class="btn sm" data-st="delivered">Mark delivered</button>' : ''}
    ${paid ? docBtn('invoice', 'Tax invoice (PDF)') : ''}${docBtn('packing-slip', 'Packing slip (PDF)')}
    ${o.shipmentDocs?.label ? docBtn('label', 'DHL label (PDF)', 'btn accent sm') : ''}${o.shipmentDocs?.['commercial-invoice'] || o.shipmentDocs?.invoice ? docBtn('commercial-invoice', 'DHL commercial invoice') : ''}
    <span class="spacer"></span>
    <button class="btn ghost sm" data-mail="confirmation">Resend confirmation</button>
    ${['pending_payment', 'paid', 'processing'].includes(o.status) ? '<button class="btn danger sm" data-st="cancelled">Cancel order</button>' : ''}
  </div>${o.invoiceNo ? `<div class="muted" style="font-size:12px;margin-top:6px">Invoice ${esc(o.invoiceNo)}</div>` : ''}</div>
  <div class="grid2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);align-items:start">
    <div>
      <div class="card"><h2>Items <span class="muted mono">${o.groups.reduce((s, g) => s + g.qty, 0)} pcs · ${(o.weightG / 1000).toFixed(1)} kg</span></h2>
        ${o.groups.map((g) => {
          const colors = [...new Set(g.lines.map((l) => l.color))], sizes = [...new Set(g.lines.map((l) => l.size))];
          return `<div style="margin-bottom:18px"><div class="row"><b>${esc(g.code)} · ${esc(g.name)}</b><span class="spacer"></span><span>${g.qty} × ${money(g.unit, o.currency)} = <b>${money(g.total, o.currency)}</b></span></div>
          <div class="wrapt" style="margin-top:8px"><table class="t"><thead><tr><th>Colour</th>${sizes.map((s) => `<th class="r">${esc(s)}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>
          ${colors.map((col) => `<tr><td>${esc(col)}</td>${sizes.map((s) => `<td class="r">${g.lines.find((l) => l.color === col && l.size === s)?.qty || ''}</td>`).join('')}<td class="r"><b>${g.lines.filter((l) => l.color === col).reduce((x, l) => x + l.qty, 0)}</b></td></tr>`).join('')}
          </tbody></table></div></div>`; }).join('')}
        <table class="t" style="max-width:380px;margin-left:auto"><tbody>
          <tr><td>Subtotal</td><td class="r">${money(o.subtotal, o.currency)}</td></tr>
          <tr><td>Shipping · ${esc(o.shipping.service)}</td><td class="r">${money(o.shippingAmount, o.currency)}</td></tr>
          ${o.taxAmount ? `<tr><td>${esc(o.taxLabel)}</td><td class="r">${money(o.taxAmount, o.currency)}</td></tr>` : ''}
          <tr><td><b>Total</b></td><td class="r"><b>${money(o.total, o.currency)}</b></td></tr></tbody></table>
        ${o.currency !== 'INR' && o.fxRate ? `<p class="muted" style="font-size:12px;text-align:right">≈ ${money(o.total / o.fxRate, 'INR')} at checkout rate</p>` : ''}
      </div>
      <div class="card"><h2>Shipping & tracking ${sh.tracking ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="${esc(trackingUrl(sh))}">Track ↗</a>` : ''}</h2>
        <form id="shipform" class="stack">
          <div class="grid3"><label class="f">Carrier<select class="i" name="carrier">${Object.entries(CARRIERS).map(([k, v]) => `<option value="${k}" ${(sh.carrier || 'dhl') === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
            <label class="f">Service<input class="i" name="service" value="${esc(sh.service || o.shipping.service || '')}"></label>
            <label class="f">Tracking number<input class="i" name="tracking" value="${esc(sh.tracking || '')}"></label></div>
          <div class="grid4"><label class="f">Ship date<input class="i" type="date" name="shippedAt" value="${esc((sh.shippedAt || '').slice(0, 10))}"></label>
            <label class="f">Boxes<input class="i" type="number" name="boxes" min="1" value="${esc(sh.boxes || '')}"></label>
            <label class="f">Weight (kg)<input class="i" type="number" step="0.1" name="weightKg" value="${esc(sh.weightKg || '')}"></label>
            <label class="f">Tracking URL <small>for “Other”</small><input class="i" name="trackingUrl" value="${esc(sh.trackingUrl || '')}" placeholder="https://"></label></div>
          <div class="row"><label class="check"><input type="checkbox" name="notify" checked> Email the customer when marked shipped</label><span class="spacer"></span>
            <button class="btn">Save shipping details</button>
            ${!sh.tracking && paid ? `<button type="button" class="btn accent" id="oship" title="Books the DHL shipment, creates the label and commercial invoice">Generate DHL label</button>` : ''}</div>
          <p class="muted" style="font-size:12px;margin:0">Adding a tracking number to a paid order marks it shipped. DHL labels need the DHL API keys; for other couriers enter the details by hand.</p>
        </form></div>
      <div class="card"><h2>Timeline</h2><ul class="timeline">
        <li><b>Order created</b> <span class="muted">${date(o.createdAt)}</span></li>
        ${events.map((e) => `<li><b>${esc(e.type.replace(/_/g, ' '))}</b> <span class="muted">${date(e.created_at)}</span>${e.data ? `<div class="mix">${esc(Object.entries(e.data).filter(([k]) => !['raw'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</div>` : ''}</li>`).join('')}
      </ul></div>
    </div>
    <div>
      <div class="card"><h2>Status</h2><div class="stack">
        <select class="i" id="ostatus">${STATUS.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>
        <label class="f">Internal note <small>only your team sees this</small><textarea class="i" id="onote" rows="3">${esc(o.internalNote || '')}</textarea></label>
        <button class="btn" id="osave" style="justify-self:start">Save</button></div></div>
      <div class="card"><h2>Customer ${o.customerId ? '<span class="tag published">account</span>' : '<span class="tag archived">guest</span>'}</h2>
        <div><b>${esc(c.name)}</b>${c.company ? ` · ${esc(c.company)}` : ''}</div>
        <div><a href="mailto:${esc(c.email)}">${esc(c.email)}</a> · ${esc(c.phone)}</div>${c.taxId ? `<div class="muted">Tax ID: ${esc(c.taxId)}</div>` : ''}
        <h3 style="margin-top:16px;display:flex;justify-content:space-between">Ship to <button class="btn ghost sm" id="editaddr">Edit</button></h3>
        <div id="addrview">${[a.name, a.company, a.line1, a.line2, [a.city, a.state, a.postcode].filter(Boolean).join(', '), a.country, a.phone].filter(Boolean).map(esc).join('<br>')}</div>
        <form id="addrform" class="stack" hidden>${['name', 'company', 'line1', 'line2', 'city', 'state', 'postcode', 'country', 'phone'].map((k) => `<label class="f">${k}<input class="i" name="${k}" value="${esc(a[k] || '')}"></label>`).join('')}<button class="btn sm" style="justify-self:start">Save address</button></form>
        ${o.notes ? `<h3 style="margin-top:16px">Customer note</h3><div class="note">${esc(o.notes)}</div>` : ''}
      </div>
      <div class="card"><h2>Payment</h2><div>${esc(o.gateway)} · ${esc(o.currency)}</div><div class="muted" style="font-size:12px;word-break:break-all">${esc(o.gatewayRef || '')}${o.payment?.paymentIntent ? '<br>' + esc(o.payment.paymentIntent) : ''}${o.payment?.captureId ? '<br>' + esc(o.payment.captureId) : ''}</div>
        ${o.paidAt ? `<div class="muted">Paid ${date(o.paidAt)}</div>` : ''}<p class="muted" style="font-size:12px">Refunds are issued from the Stripe or PayPal dashboard; then set the status to “refunded”.</p></div>
    </div></div>`);
  const patch = async (body, msg) => { try { await api('/api/admin/orders/' + id, { method: 'PATCH', body }); toast(msg); viewOrder(id); } catch (e) { toast(e.message, true); } };
  $('#osave').onclick = () => patch({ status: $('#ostatus').value, internalNote: $('#onote').value, notify: true }, 'Order updated');
  $$('[data-st]').forEach((b) => (b.onclick = () => { if (b.dataset.st === 'cancelled' && !confirm('Cancel this order? Refund any payment in Stripe/PayPal first.')) return; patch({ status: b.dataset.st }, 'Status updated'); }));
  $('#shipform').onsubmit = (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.target)); patch({ shipment: v, notify: !!v.notify }, 'Shipping details saved'); };
  $('#editaddr').onclick = () => { $('#addrform').hidden = !$('#addrform').hidden; $('#addrview').hidden = !$('#addrform').hidden; };
  $('#addrform').onsubmit = (e) => { e.preventDefault(); patch({ address: Object.fromEntries(new FormData(e.target)) }, 'Address updated'); };
  $$('[data-mail]').forEach((b) => (b.onclick = async () => { try { await api(`/api/admin/orders/${id}/email`, { method: 'POST', body: { type: b.dataset.mail } }); toast('Email sent'); } catch (e) { toast(e.message, true); } }));
  const ship = $('#oship');
  if (ship) ship.onclick = async () => {
    if (!confirm('Book a DHL Express shipment for this order and create the label?')) return;
    ship.disabled = true; ship.textContent = 'Creating…';
    try {
      const d = await api(`/api/admin/orders/${id}/shipment`, { method: 'POST' });
      if (d.labelPdfBase64) { const a = Object.assign(document.createElement('a'), { href: 'data:application/pdf;base64,' + d.labelPdfBase64, download: `DHL-label-${d.order.number}.pdf` }); a.click(); }
      toast('DHL shipment created — label ready'); viewOrder(id);
    }
    catch (e) { toast(e.message, true); ship.disabled = false; ship.textContent = 'Generate DHL label'; }
  };
  $$('[data-doc]').forEach((b) => (b.onclick = async () => {
    const w = window.open('', '_blank');
    try { const r = await api(`/api/admin/orders/${id}/doc/${b.dataset.doc}`, { raw: true }); if (!r.ok) throw new Error((await r.json()).error); const u = URL.createObjectURL(await r.blob()); if (w) w.location = u; else window.open(u); }
    catch (e) { w?.close(); toast(e.message, true); }
  }));
}

// ---------- customers ----------
async function viewCustomers() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  const { customers } = await api('/api/admin/customers?q=' + encodeURIComponent(q));
  shell('customers', 'Customers', `<form id="csearch" class="row" style="margin-bottom:16px"><input class="i" name="q" value="${esc(q)}" placeholder="Search name, email, company" style="max-width:320px"><button class="btn ghost sm">Search</button><span class="spacer"></span><span class="muted">${customers.length} account${customers.length === 1 ? '' : 's'}</span></form>
    ${customers.length ? `<div class="wrapt"><table class="t"><thead><tr><th>Customer</th><th>Company</th><th>Sign-in</th><th class="r">Paid orders</th><th>Joined</th><th>Last sign-in</th></tr></thead><tbody>
      ${customers.map((c) => `<tr class="click" data-href="#/orders?q=${encodeURIComponent(c.email)}"><td><b>${esc(c.name || '—')}</b><div class="muted" style="font-size:12px">${esc(c.email)} ${c.email_verified ? '✓' : '<span title="not verified">·</span>'}</div></td><td>${esc(c.company || '')}</td><td class="mono">${c.google ? 'Google' : 'Email'}</td><td class="r">${c.orders}</td><td>${date(c.created_at)}</td><td>${date(c.last_login)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty">No customer accounts yet. Guests who check out without an account appear under Orders.</div>'}`);
  $('#csearch').onsubmit = (e) => { e.preventDefault(); location.hash = '#/customers?q=' + encodeURIComponent(new FormData(e.target).get('q')); };
}

// ---------- team ----------
async function viewTeam() {
  const { members, roles, google } = await api('/api/admin/team');
  const roleDesc = { owner: 'Everything, including team access', manager: 'Orders, products, settings, publishing', staff: 'Orders and messages only' };
  shell('team', 'Team', `<div class="grid2" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start">
    <div class="card"><h2>People with dashboard access</h2><div class="wrapt"><table class="t"><thead><tr><th>Person</th><th>Role</th><th>Sign-in</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${members.map((m) => `<tr><td><b>${esc(m.name || '—')}</b><div class="muted" style="font-size:12px">${esc(m.email)}</div></td>
        <td><select class="i" data-role="${m.id}" ${m.email === user.email ? 'disabled' : ''} style="height:32px;min-width:120px">${Object.keys(roles).map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="mono">${[m.google ? 'Google' : '', m.password ? 'Password' : ''].filter(Boolean).join(' + ') || '—'}</td>
        <td><span class="tag ${m.status === 'active' ? 'published' : m.status === 'invited' ? 'draft' : 'archived'}">${m.status}</span></td><td>${date(m.last_login)}</td>
        <td class="r">${m.email === user.email ? '<span class="muted">you</span>' : `<button class="btn ghost sm" data-toggle="${m.id}" data-to="${m.status === 'disabled' ? 'active' : 'disabled'}">${m.status === 'disabled' ? 'Enable' : 'Disable'}</button> <button class="btn danger sm" data-rm="${m.id}">Remove</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="stack" style="margin-top:14px;font-size:13px">${Object.entries(roleDesc).map(([r, d]) => `<div><span class="tag">${r}</span> <span class="muted">${d}</span></div>`).join('')}</div></div>
    <div class="card"><h2>Invite someone</h2><form id="invite" class="stack">
      <label class="f">Email<input class="i" name="email" type="email" required placeholder="name@gmail.com"></label>
      <label class="f">Name<input class="i" name="name"></label>
      <label class="f">Role<select class="i" name="role">${Object.keys(roles).map((r) => `<option ${r === 'staff' ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="f">Password <small>${google ? 'optional — leave empty to sign in with Google only' : 'required until Google sign-in is configured'} (10+ chars)</small><input class="i" name="password" type="password" autocomplete="new-password" ${google ? '' : 'required'}></label>
      <button class="btn accent" style="justify-self:start">Give access</button>
      <p class="muted" style="font-size:12px;margin:0">${google ? 'They sign in at /admin with “Continue with Google” using this exact email.' : 'Google sign-in is not configured yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).'}</p></form></div></div>`);
  $('#invite').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/admin/team', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Access granted'); viewTeam(); } catch (ex) { toast(ex.message, true); } };
  $$('[data-role]').forEach((s) => (s.onchange = async () => { try { await api('/api/admin/team/' + s.dataset.role, { method: 'PATCH', body: { role: s.value } }); toast('Role updated'); } catch (ex) { toast(ex.message, true); viewTeam(); } }));
  $$('[data-toggle]').forEach((b) => (b.onclick = async () => { try { await api('/api/admin/team/' + b.dataset.toggle, { method: 'PATCH', body: { status: b.dataset.to } }); viewTeam(); } catch (ex) { toast(ex.message, true); } }));
  $$('[data-rm]').forEach((b) => (b.onclick = async () => { if (!confirm('Remove dashboard access for this person?')) return; try { await api('/api/admin/team/' + b.dataset.rm, { method: 'DELETE' }); viewTeam(); } catch (ex) { toast(ex.message, true); } }));
}

async function viewMe() {
  shell('me', 'My account', `<div class="card" style="max-width:560px"><h2>${esc(user.name || user.email)}</h2><p class="muted">${esc(user.email)} · ${esc(user.role)}</p>
    <form id="chpw" class="stack"><h3>Set or change password</h3><input class="i" name="current" type="password" placeholder="Current password (leave empty if you only use Google)" autocomplete="current-password"><input class="i" name="next" type="password" placeholder="New password (10+ characters)" required autocomplete="new-password"><button class="btn sm" style="justify-self:start">Update password</button></form></div>`);
  $('#chpw').onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/api/admin/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); token = d.token; sessionStorage.setItem('sc_admin_token', token); toast('Password updated — other sessions were signed out'); e.target.reset(); } catch (ex) { toast(ex.message, true); } };
}

// ---------- products ----------
async function viewProducts() {
  const [{ products }, S] = await Promise.all([api('/api/admin/products'), getSettings()]);
  shell('products', 'Products', products.length ? `<div class="wrapt"><table class="t"><thead><tr><th>Code</th><th>Product</th><th>Category</th><th>Colours</th><th class="r">MOQ</th><th class="r">Weight/pc</th><th class="r">Price (${S.baseCurrency})</th><th>Languages</th><th>Status</th></tr></thead><tbody>
    ${products.map((p) => `<tr class="click" data-href="#/products/${p.id}"><td class="mono">${esc(p.code)}</td><td><b>${esc(p.name)}</b><div class="muted" style="font-size:12px">${esc(p.fabric || '')}${p.gsm ? ' · ' + p.gsm + ' GSM' : ''}</div></td><td>${esc(p.category)}</td>
      <td>${p.colors.slice(0, 12).map((c) => `<span class="sw" style="background:${c.hex}"></span>`).join('')} <span class="muted">${p.colors.length}</span>
        <div class="muted" style="font-size:11px">${p.colors.reduce((n, c) => n + (c.images?.length || 0), 0)} photos</div></td>
      <td class="r">${p.moq}</td><td class="r">${p.weightG ? p.weightG + ' g' : '<span style="color:var(--err)">missing</span>'}</td><td class="r">${p.price}${p.tiers?.length ? `<div class="muted" style="font-size:11px">${p.tiers.map((t) => `${t.min}+: ${t.price}`).join(' · ')}</div>` : ''}</td>
      <td class="mono">${['en', ...Object.keys(p.i18n || {})].join(' ')}</td><td><span class="tag ${p.status}">${p.status}</span></td></tr>`).join('')}
    </tbody></table></div>` : `<div class="card empty"><p>No products yet.</p><button class="btn accent" id="imp">Import the 6 starter products (SC-01 – SC-06)</button></div>`,
  `<a class="btn" href="#/products/new">+ New product</a>`);
  const imp = $('#imp');
  if (imp) imp.onclick = async () => { const d = await api('/api/admin/import-starter', { method: 'POST' }); toast(`Imported ${d.imported} products`); viewProducts(); };
}

const BLANK = {
  name: '', line: '', code: '', type: 'Polo', category: 'polos', gender: "Men's", sleeve: 'Half sleeve', status: 'draft', sort: 99,
  tagline: '', short: '', description: '', fabric: '', gsm: null, fit: '', features: [], highlights: [], impact: [], specs: [], useCases: [], faqs: [],
  sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '5XL'], sizeChart: 'mens-polo', careKey: 'cotton', colors: [{ name: 'White', hex: '#F4F4F2', images: [] }], heroColor: 'White',
  moq: 50, price: 0, tiers: [], weightG: 250, hsCode: '', leadTime: '7–10 working days', seo: { title: '', description: '' }, i18n: {},
};
let ptab = 'basics', plang = 'de';
async function viewProduct(id) {
  const S = await getSettings();
  const isNew = id === 'new';
  const p = isNew ? structuredClone(BLANK) : (await api('/api/admin/products/' + id)).product;
  dirty = false;
  const tabs = [['basics', 'Basics'], ['content', 'Content'], ['specs', 'Specs & sizes'], ['uses', 'Use cases & FAQ'], ['colours', 'Colours & photos'], ['pricing', 'Pricing, MOQ & weight'], ['shipping', 'Customs'], ['seo', 'SEO'], ['i18n', 'Translations']];
  const render = () => {
    const panes = {
      basics: `<div class="grid3">${F.text('name', 'Product name')}${F.text('line', 'Line name', { hint: 'big word, e.g. Aurum' })}${F.text('code', 'Code', { ph: 'SC-07' })}
        ${F.text('type', 'Type', { ph: 'Polo / T-shirt / Hoodie' })}${F.sel('category', 'Category', (S.categories || []).map((c) => [c.slug, c.name]))}${F.text('gender', 'Gender label', { ph: "Men's / Women's / blank" })}
        ${F.text('sleeve', 'Sleeve')}${F.sel('status', 'Status', [['draft', 'Draft'], ['published', 'Published'], ['archived', 'Archived']])}${F.num('sort', 'Sort order')}
        ${F.text('slug', 'URL slug', { hint: `/products/${esc(p.slug || '…')}/` })}${F.sel('heroColor', 'Hero colour', p.colors.map((c) => c.name))}${F.text('leadTime', 'Dispatch / lead time')}</div>
        <div class="stack" style="margin-top:16px">${F.text('tagline', 'Tagline', { max: 140 })}${F.area('short', 'Short description', { rows: 2, hint: 'used on cards, feeds and search' })}</div>`,
      content: `<div class="stack">${F.area('description', 'Long description', { rows: 10, hint: 'Markdown: blank line between paragraphs, ## heading, - bullets, **bold**' })}
        <h3>Highlights <span class="muted mono">numbered tiles under the description</span></h3>${rep('highlights', [{ k: 'title', label: 'Title' }, { k: 'text', label: 'Sub-text', wide: true }], p.highlights)}
        <h3>Impact numbers <span class="muted mono">optional lime band, e.g. 5,000 L water saved</span></h3>${rep('impact', [{ k: 'value', label: 'Value' }, { k: 'label', label: 'Label', wide: true }], p.impact)}
        ${F.lines('features', 'Feature bullets', { rows: 7 })}</div>`,
      specs: `<div class="grid3">${F.text('fabric', 'Fabric')}${F.num('gsm', 'GSM')}${F.text('fit', 'Fit')}</div>
        <h3 style="margin-top:18px">Specification table</h3>${rep('specs', [{ k: 'label', label: 'Label' }, { k: 'value', label: 'Value', wide: true }], p.specs, { addLabel: 'Add row' })}
        <div class="grid3" style="margin-top:18px">${F.csv('sizes', 'Sizes', { hint: 'comma-separated, in order' })}
          ${F.sel('sizeChart', 'Size chart', [['', '— none —'], ...Object.entries(S.sizeCharts || {}).map(([k, c]) => [k, c.title])])}
          ${F.sel('careKey', 'Care instructions', Object.keys(S.care || {}))}</div>`,
      uses: `<h3>Use cases <span class="muted mono">who it's for — great for SEO and AI answers</span></h3>${rep('useCases', [{ k: 'title', label: 'Title' }, { k: 'text', label: 'Description', kind: 'area', wide: true, rows: 2 }], p.useCases)}
        <h3 style="margin-top:18px">Product FAQs <span class="muted mono">shown with the store FAQs, marked up as FAQPage</span></h3>${rep('faqs', [{ k: 'q', label: 'Question' }, { k: 'a', label: 'Answer', kind: 'area', wide: true, rows: 2 }], p.faqs)}`,
      colours: colourPane(p),
      pricing: `<div class="grid3">${F.num('price', `Base unit price (${S.baseCurrency})`)}${F.num('moq', 'Minimum order (pcs per product)', { hint: 'sizes & colours mix' })}${F.num('weightG', 'Net weight per piece (grams)', { hint: 'weigh one garment, e.g. 260 — drives DHL rates' })}</div>
        <p class="muted" id="wprev" style="font-size:13px"></p>
        <h3 style="margin-top:18px">Volume tiers</h3>${rep('tiers', [{ k: 'min', label: 'From qty', kind: 'num' }, { k: 'price', label: `Unit price (${S.baseCurrency})`, kind: 'num' }], p.tiers, { addLabel: 'Add tier' })}
        <h3 style="margin-top:18px">Preview in enabled currencies <span class="muted mono">rate · markup · rounding</span></h3><div id="pricePrev"></div>`,
      shipping: `<div class="grid3">${F.text('hsCode', 'HS code', { hint: 'customs, e.g. 6105.10' })}<div></div><div></div></div>
        <p class="muted">Net weight per piece is under “Pricing, MOQ & weight”. Boxes are packed at max ${S.shipping.packaging.maxBoxKg} kg + ${S.shipping.packaging.packagingPct}% packaging weight (Settings → Shipping).</p>`,
      seo: `<div class="stack">${F.text('seo.title', 'SEO title', { hint: `<span id="tlen"></span> · aim for 50–60 characters` })}${F.area('seo.description', 'Meta description', { rows: 3, hint: '<span id="dlen"></span> · aim for 140–160 characters' })}
        <div class="card" style="border-style:dashed"><div class="mono muted">Google preview</div><div id="serp" style="font-family:arial;margin-top:8px"></div></div></div>`,
      i18n: i18nPane(p, S),
    };
    $('#pedit').innerHTML = `<div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${ptab === k ? 'on' : ''}">${n}</button>`).join('')}</div><div id="pane">${panes[ptab]}</div>`;
    const wp = () => { const el = $('#wprev'); if (!el) return; const pk = S.shipping.packaging; const kg = (p.weightG || 0) * p.moq / 1000; el.textContent = p.weightG ? `At the minimum order (${p.moq} pcs): net ${kg.toFixed(2)} kg → shipped weight ≈ ${(kg * (1 + (pk.packagingPct ?? 6) / 100)).toFixed(2)} kg incl. ${pk.packagingPct ?? 6}% packaging.` : 'Enter the weight of one garment in grams.'; };
    bind($('#pane'), p, (k) => { wp(); if (ptab === 'pricing') pricePreview(p, S); if (ptab === 'seo') serp(p, S); if (k.startsWith('colors.') && k.endsWith('.name')) {} });
    $$('[data-tab]').forEach((b) => (b.onclick = () => { ptab = b.dataset.tab; render(); }));
    if (ptab === 'pricing') { pricePreview(p, S); wp(); }
    if (ptab === 'seo') serp(p, S);
    if (ptab === 'colours') wireColours(p, render);
    if (ptab === 'i18n') wireI18n(p, render);
  };
  shell('products', `<a href="#/products" style="text-decoration:none">Products</a> / ${esc(isNew ? 'New product' : p.name)} ${isNew ? '' : `<span class="tag ${p.status}">${p.status}</span>`}`,
    `<div id="pedit"></div><div class="savebar"><span class="mono">${isNew ? 'New product' : esc(p.code)}</span><span class="spacer"></span>
      ${isNew ? '' : `<a class="btn ghost" target="_blank" href="${SITE}/products/${esc(p.slug)}/">View on site ↗</a><button class="btn danger" id="pdel">Delete</button>`}
      <button class="btn accent" id="psave">Save product</button></div>`);
  $('#pedit').addEventListener('click', () => {}, { once: true });
  wireReps($('#pedit'), p, render, { highlights: { title: '', text: '' }, impact: { value: '', label: '' }, specs: { label: '', value: '' }, useCases: { title: '', text: '' }, faqs: { q: '', a: '' }, tiers: { min: 100, price: 0 } });
  render();
  $('#psave').onclick = async () => {
    try {
      const d = isNew ? await api('/api/admin/products', { method: 'POST', body: p }) : await api('/api/admin/products/' + id, { method: 'PUT', body: p });
      dirty = false; toast('Saved. Click “Publish site” to push changes live.');
      if (isNew) location.hash = '#/products/' + d.product.id; else viewProduct(id);
    } catch (e) { toast(e.message, true); }
  };
  const del = $('#pdel');
  if (del) del.onclick = async () => { if (!confirm(`Delete ${p.name}? Consider setting status to Archived instead.`)) return; await api('/api/admin/products/' + id, { method: 'DELETE' }); dirty = false; location.hash = '#/products'; };
}

function colourPane(p) {
  return `<p class="muted">Upload transparent cut-out PNGs or photos per colour — they're converted to WebP (max 1600 px) in your browser before upload. First image = main image. Drag files onto a colour or click +.</p>
  <div class="colors">${p.colors.map((c, i) => `<div class="color" data-ci="${i}">
    <div class="head">${F.color(`colors.${i}.hex`)}<input class="i" data-k="colors.${i}.name" placeholder="Colour name">
      <label class="check mono" title="Second colour for two-tone"><input type="checkbox" data-twotone="${i}" ${c.hex2 ? 'checked' : ''}> 2-tone</label>
      ${c.hex2 ? F.color(`colors.${i}.hex2`) : '<span></span>'}
      <div class="row" style="gap:4px"><button class="iconbtn" data-cup="${i}" title="Move up">↑</button><button class="iconbtn" data-cdel="${i}" title="Remove colour">✕</button></div></div>
    <div class="imgs">${(c.images || []).map((u, j) => `<div class="im"><img src="${esc(localPreviews[u] || u)}" alt="" loading="lazy" onerror="this.style.opacity=.25;this.title='Appears after the next site build'"><div class="ctl"><button data-imleft="${i}:${j}" title="Move left">←</button><button data-imdel="${i}:${j}" title="Remove">✕</button></div></div>`).join('')}
      <label class="drop" data-drop="${i}">+ Add photos<input type="file" accept="image/*" multiple hidden data-file="${i}"></label></div></div>`).join('')}</div>
  <div class="row" style="margin-top:12px"><button class="btn ghost" data-cadd>+ Add colour</button><span class="muted" id="upmsg"></span></div>`;
}
const localPreviews = {}; let pendingNote = false;
async function toWebp(file) {
  if (file.type === 'image/svg+xml') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.86));
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
}
function wireColours(p, render) {
  const pane = $('#pane');
  const upload = async (ci, files) => {
    const msg = $('#upmsg');
    for (const [n, f] of [...files].entries()) {
      msg.textContent = `Uploading ${n + 1}/${files.length}…`;
      try {
        const fd = new FormData(); fd.append('file', await toWebp(f)); fd.append('folder', p.slug || p.name || 'product');
        const d = await api('/api/admin/media', { method: 'POST', body: fd });
        (p.colors[ci].images ||= []).push(d.url); dirty = true;
        if (d.pending) { localPreviews[d.url] = URL.createObjectURL(f); pendingNote = true; }
      } catch (e) { toast(`${f.name}: ${e.message}`, true); }
    }
    msg.textContent = ''; render(); toast(pendingNote ? 'Photos uploaded — save the product, then they go live with the next site build (about 2 minutes).' : 'Photos uploaded — save the product to keep them.');
  };
  pane.addEventListener('change', (e) => {
    if (e.target.dataset.file) upload(+e.target.dataset.file, e.target.files);
    if (e.target.dataset.twotone) { const c = p.colors[+e.target.dataset.twotone]; if (e.target.checked) c.hex2 = '#D8301E'; else delete c.hex2; dirty = true; render(); }
  });
  pane.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cadd != null) { p.colors.push({ name: '', hex: '#cccccc', images: [] }); }
    else if (b.dataset.cdel) { if (!confirm('Remove this colour and its photos from the product?')) return; p.colors.splice(+b.dataset.cdel, 1); }
    else if (b.dataset.cup) { const i = +b.dataset.cup; if (i > 0) [p.colors[i - 1], p.colors[i]] = [p.colors[i], p.colors[i - 1]]; }
    else if (b.dataset.imdel) { const [i, j] = b.dataset.imdel.split(':').map(Number); p.colors[i].images.splice(j, 1); }
    else if (b.dataset.imleft) { const [i, j] = b.dataset.imleft.split(':').map(Number); const a = p.colors[i].images; if (j > 0) [a[j - 1], a[j]] = [a[j], a[j - 1]]; }
    else return;
    e.preventDefault(); dirty = true; render();
  });
  for (const d of $$('[data-drop]', pane)) {
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', (e) => { e.preventDefault(); d.classList.remove('over'); upload(+d.dataset.drop, e.dataTransfer.files); });
  }
}
function convertPrice(v, cur, S) {
  if (cur === S.baseCurrency) return v;
  const r = fxCache?.rates?.[cur]; if (!r) return null;
  const c = S.currencies.find((x) => x.code === cur) || {};
  const raw = v * r * (1 + (c.markup ?? S.fxMarkup ?? 0) / 100), step = +c.round || 0.01;
  return +(Math.ceil(+(raw / step).toFixed(6)) * step).toFixed(2);
}
function pricePreview(p, S) {
  const tiers = [{ min: p.moq, price: p.price }, ...(p.tiers || [])].sort((a, b) => a.min - b.min);
  const curs = S.currencies.filter((c) => c.enabled);
  $('#pricePrev').innerHTML = `<div class="wrapt"><table class="t"><thead><tr><th>Qty</th>${curs.map((c) => `<th class="r">${c.code}</th>`).join('')}</tr></thead><tbody>
    ${tiers.map((t) => `<tr><td>${t.min}+ pcs</td>${curs.map((c) => `<td class="r">${convertPrice(+t.price || 0, c.code, S) ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted" style="font-size:12px">Rates: ${esc(fxCache?.source || 'fallback')} ${esc(fxCache?.fetchedAt || fxCache?.updated || '')}</p>`;
}
function serp(p, S) {
  const title = p.seo?.title || p.name + S.seo.titleSuffix, desc = p.seo?.description || p.short;
  $('#tlen').textContent = `${(p.seo?.title || '').length} chars`; $('#dlen').textContent = `${(p.seo?.description || '').length} chars`;
  $('#serp').innerHTML = `<div style="color:#202124;font-size:12px">${esc(S.store.domain)} › products › ${esc(p.slug || '')}</div><div style="color:#1a0dab;font-size:19px;line-height:1.3">${esc(title.slice(0, 62))}${title.length > 62 ? '…' : ''}</div><div style="color:#4d5156;font-size:13.5px">${esc(desc.slice(0, 160))}${desc.length > 160 ? '…' : ''}</div>`;
}
function i18nPane(p, S) {
  const langs = (S.languages.available || []).filter((l) => l !== 'en');
  if (!langs.includes(plang)) plang = langs[0];
  const tr = p.i18n?.[plang];
  const base = `i18n.${plang}`;
  return `<div class="row" style="margin-bottom:14px"><div class="pills">${langs.map((l) => `<button data-plang="${l}" class="${l === plang ? 'on' : ''}">${l.toUpperCase()} ${p.i18n?.[l] ? '✓' : ''}</button>`).join('')}</div><span class="spacer"></span>
    ${S.languages.enabled.includes(plang) ? '' : `<span class="note">${plang.toUpperCase()} is not enabled on the site yet (Settings → Languages).</span>`}</div>
    ${tr ? `<div class="row" style="margin-bottom:14px"><button class="btn ghost sm" data-autotr>Auto-translate empty fields from English (AI draft)</button><button class="btn danger sm" data-rmtr>Remove ${plang.toUpperCase()} translation</button></div>
    <div class="stack">${F.text(base + '.name', 'Name', { ph: p.name })}${F.text(base + '.tagline', 'Tagline', { ph: p.tagline })}${F.area(base + '.short', 'Short description', { rows: 2 })}
      ${F.area(base + '.description', 'Long description', { rows: 8 })}${F.lines(base + '.features', 'Feature bullets', { rows: 6 })}
      <h3>Use cases</h3>${rep(base + '.useCases', [{ k: 'title', label: 'Title' }, { k: 'text', label: 'Description', kind: 'area', wide: true, rows: 2 }], tr.useCases)}
      <h3>FAQs</h3>${rep(base + '.faqs', [{ k: 'q', label: 'Question' }, { k: 'a', label: 'Answer', kind: 'area', wide: true, rows: 2 }], tr.faqs)}
      ${F.text(base + '.seo.title', 'SEO title')}${F.area(base + '.seo.description', 'Meta description', { rows: 2 })}</div>
    <p class="muted">Empty fields fall back to English. A product page is generated in ${plang.toUpperCase()} only once this translation exists.</p>`
    : `<div class="empty"><p>No ${plang.toUpperCase()} translation yet.</p><button class="btn accent" data-newtr>Start ${plang.toUpperCase()} translation</button></div>`}`;
}
function wireI18n(p, render) {
  const pane = $('#pane');
  pane.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.plang) { plang = b.dataset.plang; render(); }
    if (b.dataset.newtr != null) { p.i18n ||= {}; p.i18n[plang] = { name: '', tagline: '', short: '', description: '', features: [], useCases: (p.useCases || []).map(() => ({ title: '', text: '' })), faqs: (p.faqs || []).map(() => ({ q: '', a: '' })), seo: {} }; dirty = true; render(); }
    if (b.dataset.rmtr != null) { if (confirm('Remove this translation?')) { delete p.i18n[plang]; dirty = true; render(); } }
    if (b.dataset.autotr != null) {
      const tr = p.i18n[plang];
      const jobs = []; // [setter, english]
      const want = (cur, en, set) => { if (en && (!cur || (Array.isArray(cur) && !cur.length))) jobs.push([set, en]); };
      want(tr.name, p.name, (v) => (tr.name = v)); want(tr.tagline, p.tagline, (v) => (tr.tagline = v)); want(tr.short, p.short, (v) => (tr.short = v));
      want(tr.description, p.description, (v) => (tr.description = v));
      if (!tr.features?.length) (p.features || []).forEach((f, i) => jobs.push([(v) => ((tr.features ||= [])[i] = v), f]));
      (p.useCases || []).forEach((u, i) => { tr.useCases ||= []; tr.useCases[i] ||= {}; want(tr.useCases[i].title, u.title, (v) => (tr.useCases[i].title = v)); want(tr.useCases[i].text, u.text, (v) => (tr.useCases[i].text = v)); });
      (p.faqs || []).forEach((f, i) => { tr.faqs ||= []; tr.faqs[i] ||= {}; want(tr.faqs[i].q, f.q, (v) => (tr.faqs[i].q = v)); want(tr.faqs[i].a, f.a, (v) => (tr.faqs[i].a = v)); });
      tr.seo ||= {}; want(tr.seo.title, p.seo?.title, (v) => (tr.seo.title = v)); want(tr.seo.description, p.seo?.description || p.short, (v) => (tr.seo.description = v));
      if (!jobs.length) return toast('Nothing to translate');
      b.disabled = true; b.textContent = `Translating ${jobs.length} fields…`;
      try {
        const out = [];
        for (let i = 0; i < jobs.length; i += 20) out.push(...(await api('/api/admin/translate', { method: 'POST', body: { target: plang, texts: jobs.slice(i, i + 20).map((j) => j[1]) } })).texts);
        jobs.forEach(([set], i) => set(out[i])); dirty = true; toast('Draft translation added — please review before publishing.'); render();
      } catch (ex) { toast(ex.message, true); b.disabled = false; }
    }
  });
}

// ---------- messages ----------
async function viewMessages() {
  const { messages } = await api('/api/admin/messages');
  unread = messages.filter((m) => !m.read).length;
  shell('messages', 'Messages', messages.length ? messages.map((m) => `<div class="card" style="${m.read ? 'opacity:.7' : ''}"><div class="row"><b>${esc(m.name)}</b>${m.company ? `<span class="muted">· ${esc(m.company)}</span>` : ''}<span class="spacer"></span><span class="muted">${date(m.createdAt)} · ${esc(m.country || '')}</span></div>
    <div><a href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: your enquiry to S Creation')}">${esc(m.email)}</a> ${esc(m.phone || '')}</div><p style="white-space:pre-wrap">${esc(m.message)}</p>
    <div class="row"><a class="btn sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: your enquiry to S Creation')}">Reply</a><button class="btn ghost sm" data-read="${m.id}" data-v="${m.read ? 0 : 1}">${m.read ? 'Mark unread' : 'Mark read'}</button></div></div>`).join('') : '<div class="card empty">No messages yet. Enquiries from the contact page land here.</div>');
  $$('[data-read]').forEach((b) => (b.onclick = async () => { await api('/api/admin/messages/' + b.dataset.read, { method: 'PATCH', body: { read: b.dataset.v === '1' } }); viewMessages(); }));
}

// ---------- settings ----------
let stab = 'store';
async function viewSettings() {
  const S = structuredClone(await getSettings(true));
  const integ = await api('/api/admin/integrations');
  dirty = false;
  const tabs = [['store', 'Store'], ['currency', 'Currencies'], ['lang', 'Languages'], ['pay', 'Payments'], ['ship', 'Shipping'], ['tax', 'Tax'], ['content', 'Content & pages'], ['seo', 'SEO & analytics'], ['accounts', 'Accounts & invoices'], ['raw', 'Advanced']];
  const render = () => {
    const allLangs = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español' };
    const panes = {
      store: `<div class="grid3">${F.text('store.name', 'Store name')}${F.text('store.legalName', 'Legal name')}${F.text('store.tagline', 'Tagline')}
        ${F.text('store.email', 'Email')}${F.text('store.phone', 'Phone')}${F.text('store.whatsapp', 'WhatsApp')}
        ${F.text('store.domain', 'Domain')}${F.text('store.siteUrl', 'Site URL')}${F.text('store.apiUrl', 'API URL')}</div>
        <h3 style="margin-top:18px">Address</h3><div class="grid3">${F.text('store.address.line1', 'Address line 1')}${F.text('store.address.line2', 'Line 2')}${F.text('store.address.city', 'City')}${F.text('store.address.state', 'State')}${F.text('store.address.postcode', 'PIN code')}${F.text('store.address.country', 'Country (ISO)')}</div>
        <div class="stack" style="margin-top:18px">${F.text('store.logo', 'Logo URL', { hint: 'leave empty to use the S CREATION wordmark' })}${F.text('store.announcement', 'Announcement bar')}
        <div class="grid3">${F.text('store.social.instagram', 'Instagram URL')}${F.text('store.social.linkedin', 'LinkedIn URL')}${F.text('store.social.facebook', 'Facebook URL')}</div></div>`,
      currency: `<div class="grid3">${F.text('baseCurrency', 'Base currency', { hint: 'prices are entered in this currency' })}${F.num('fxMarkup', 'Default FX markup %', { hint: 'covers conversion fees' })}<div></div></div>
        <h3 style="margin-top:18px">Currencies shown on the site</h3>${rep('currencies', [{ k: 'code', label: 'ISO code' }, { k: 'enabled', label: 'On', kind: 'bool' }, { k: 'round', label: 'Round up to', kind: 'num' }, { k: 'markup', label: 'Markup % (optional)', kind: 'num' }], S.currencies, { addLabel: 'Add currency' })}
        <div class="row" style="margin-top:14px"><span class="muted">Rates: ${esc(fxCache?.source || 'fallback')} · ${esc(fxCache?.fetchedAt || fxCache?.updated || '')} · refreshed daily</span><button class="btn ghost sm" data-fx>Refresh rates now</button></div>
        <p class="muted" style="font-size:12px">Example: 650 INR × rate × (1 + markup) rounded up to the step (0.05 → $7.45). Stripe settles to your INR bank account; PayPal supports the currencies listed under Payments.</p>`,
      lang: `<div class="stack">${Object.entries(allLangs).map(([k, n]) => `<label class="check"><input type="checkbox" data-lang="${k}" ${S.languages.enabled.includes(k) ? 'checked' : ''} ${k === 'en' ? 'disabled' : ''}> ${n} (${k})</label>`).join('')}
        ${F.sel('languages.default', 'Default language (served at /)', S.languages.enabled)}
        <p class="muted">Interface text for DE/FR/ES is built in. Product and page content is translated per item (Products → Translations). Pages without a translation stay in English and point search engines to the English version.</p></div>`,
      pay: `<div class="grid2"><div class="card"><h2>Stripe <span>${dot(integ.stripe.configured)}</span></h2><div class="stack">${F.bool('payments.stripe.enabled', 'Enabled')}${F.text('payments.stripe.label', 'Label at checkout')}${F.csv('payments.stripe.currencies', 'Limit to currencies', { hint: 'empty = all enabled', upper: true })}
          <p class="muted" style="font-size:12px">Keys are Worker secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Webhook URL: <code>${esc(integ.webhooks.stripe)}</code> (events: checkout.session.completed, .async_payment_succeeded, .async_payment_failed, .expired).</p></div></div>
        <div class="card"><h2>PayPal <span>${dot(integ.paypal.configured)}</span></h2><div class="stack">${F.bool('payments.paypal.enabled', 'Enabled')}${F.sel('payments.paypal.mode', 'Mode', [['sandbox', 'Sandbox (test)'], ['live', 'Live']])}${F.text('payments.paypal.label', 'Label at checkout')}${F.csv('payments.paypal.currencies', 'Currencies', { upper: true })}
          <p class="muted" style="font-size:12px">Secrets: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (+ PAYPAL_WEBHOOK_ID optional). INR is not accepted for cross-border PayPal payments.</p></div></div></div>
        <p class="muted">New gateways (e.g. Razorpay) plug in as a module in <code>worker/src/payments/</code> and appear here.</p>`,
      ship: `<div class="card"><h2>Ship-from address (DHL shipper)</h2><div class="grid3">${F.text('shipping.origin.company', 'Company')}${F.text('shipping.origin.contact', 'Contact name')}${F.text('shipping.origin.phone', 'Phone')}
          ${F.text('shipping.origin.email', 'Email')}${F.text('shipping.origin.line1', 'Address')}${F.text('shipping.origin.city', 'City')}${F.text('shipping.origin.state', 'State code')}${F.text('shipping.origin.postcode', 'PIN code')}${F.text('shipping.origin.country', 'Country (ISO)')}${F.text('shipping.origin.gstin', 'GSTIN', { hint: 'printed on export docs' })}</div></div>
        <div class="card"><h2>DHL Express <span>${dot(integ.dhl.configured)}</span></h2><div class="grid3">${F.bool('shipping.dhl.enabled', 'Use DHL live rates')}${F.bool('shipping.dhl.test', 'Use DHL test environment')}${F.sel('shipping.dhl.incoterm', 'Incoterm', [['DAP', 'DAP — buyer pays duties'], ['DDP', 'DDP — you pay duties']])}
          ${F.csv('shipping.dhl.productCodes', 'Limit DHL services (optional)', { hint: 'leave EMPTY to show all. Codes only, e.g. P = Express Worldwide, N = Domestic Express. Not the API key.', upper: true })}${F.num('shipping.handlingPct', 'Handling % on top of DHL rate')}</div>
          <div class="card" style="background:#faf9f7;margin:14px 0 6px"><h3>DHL credentials</h3><div class="grid3" id="dhlcreds">
            <label class="f">API key <small id="h_DHL_API_KEY"></small><input class="i" type="password" autocomplete="off" data-sec="DHL_API_KEY" placeholder="Paste your DHL API key"></label>
            <label class="f">API secret / password <small>optional · <span id="h_DHL_API_SECRET"></span></small><input class="i" type="password" autocomplete="off" data-sec="DHL_API_SECRET" placeholder="If DHL gave you one"></label>
            <label class="f">DHL account number <small>optional · <span id="h_DHL_ACCOUNT_NUMBER"></span></small><input class="i" autocomplete="off" data-sec="DHL_ACCOUNT_NUMBER" placeholder="e.g. 123456789"></label></div>
            <div class="row" style="margin-top:10px"><button class="btn sm" data-savesec>Save DHL credentials</button><button class="btn ghost sm" data-clearsec>Remove</button><span class="muted" style="font-size:12px">Stored securely; never shown again after saving.</span></div></div>
          <p class="muted" style="font-size:12px">Untick “Use DHL test environment” if your key is for live/production, then Save settings before testing.</p>
          <div class="row" style="margin-top:8px"><input class="i" id="dhlc" value="US" style="width:70px" title="Country"><input class="i" id="dhlp" value="10001" style="width:110px" title="Postcode"><input class="i" id="dhlcity" value="New York" style="width:160px" title="City"><input class="i" id="dhlkg" value="10" style="width:90px" title="Net weight (kg)"><span class="muted">kg</span><button class="btn sm" data-dhltest>Test DHL connection</button></div>
          <pre id="dhlout" style="white-space:pre-wrap;font-size:12px;background:#faf9f7;border:1px solid var(--line);padding:10px;margin-top:10px;max-height:320px;overflow:auto" hidden></pre></div>
        <div class="card"><h2>Packing</h2><p class="muted" style="font-size:13px;margin-top:0">Shipping weight = Σ (net weight per piece × qty) + packaging %, split into boxes of up to the max kg.</p>
          <div class="grid4">${F.num('shipping.packaging.maxBoxKg', 'Max kg per box')}${F.num('shipping.packaging.packagingPct', 'Packaging weight %')}</div>
          <div style="margin-top:12px">${F.bool('shipping.packaging.sendDimensions', 'Also send box size to DHL (rates then include volumetric weight)')}</div>
          <div class="grid4" style="margin-top:10px">${F.num('shipping.packaging.box.l', 'Box L (cm)')}${F.num('shipping.packaging.box.w', 'Box W (cm)')}${F.num('shipping.packaging.box.h', 'Box H (cm)')}</div></div>
        <div class="card"><h2>Fallback zone rates <span class="muted mono">used when DHL is off or has no rate</span></h2>${F.bool('shipping.manual.enabled', 'Enabled')}
          <div style="margin-top:10px">${rep('shipping.manual.zones', [{ k: 'name', label: 'Zone' }, { k: 'countries', label: 'Countries (ISO, * = rest)', kind: 'csv', upper: true, wide: true }, { k: 'base', label: `Base (${S.baseCurrency})`, kind: 'num' }, { k: 'perKg', label: 'Per kg', kind: 'num' }, { k: 'days', label: 'Delivery time' }], S.shipping.manual.zones, { addLabel: 'Add zone' })}</div></div>`,
      tax: `<p class="muted">Tax is added on goods at checkout for orders shipped to these countries. For exports from India (DAP), import VAT/duty is collected by DHL from the buyer, so other countries are usually left out.</p>
        ${rep('tax.rules', [{ k: 'country', label: 'Country (ISO)' }, { k: 'rate', label: 'Rate %', kind: 'num' }, { k: 'label', label: 'Label (e.g. GST)' }], S.tax.rules, { addLabel: 'Add rule' })}
        <p class="note" style="margin-top:14px">Check GST rates and invoicing rules (incl. LUT for zero-rated exports) with your accountant.</p>`,
      content: `<h3>Categories</h3>${rep('categories', [{ k: 'slug', label: 'Slug' }, { k: 'name', label: 'Name' }], S.categories)}
        <h3 style="margin-top:18px">Store FAQs <span class="muted mono">home, FAQ page and every product page</span></h3>${rep('faqs', [{ k: 'q', label: 'Question' }, { k: 'a', label: 'Answer', kind: 'area', wide: true, rows: 2 }], S.faqs)}
        <h3 style="margin-top:18px">Pages</h3>${rep('pages', [{ k: 'slug', label: 'Slug' }, { k: 'title', label: 'Title' }, { k: 'body', label: 'Body (Markdown)', kind: 'area', wide: true, rows: 5 }], S.pages, { cols: '1fr 1fr 3fr' })}
        <p class="muted" style="font-size:12px">Pages that still contain “[Add …]” placeholders are hidden from search engines.</p>
        <div class="stack" style="margin-top:18px">${F.text('sizeNote', 'Size chart note')}${F.area('sizeCharts', 'Size charts (JSON)', { type: 'json', code: true, rows: 14 })}${F.area('care', 'Care instructions (JSON)', { type: 'json', code: true, rows: 8 })}</div>`,
      seo: `<div class="stack">${F.text('seo.homeTitle', 'Home page title')}${F.area('seo.homeDescription', 'Home meta description', { rows: 2 })}${F.text('seo.titleSuffix', 'Title suffix')}${F.text('seo.ogImage', 'Social share image URL')}${F.csv('seo.keywords', 'Focus keywords')}
        <div class="grid2">${F.text('analytics.ga4', 'Google Analytics 4 ID', { ph: 'G-XXXXXXX' })}${F.text('analytics.cloudflareToken', 'Cloudflare Web Analytics token')}</div>
        ${F.bool('publish.nightly', 'Rebuild the site nightly (refreshes converted prices in feeds & structured data)')}
        <p class="muted" style="font-size:12px">Submit <code>${esc(S.store.siteUrl)}/sitemap.xml</code> in Google Search Console and Bing Webmaster Tools. Merchant Center feeds: <code>${esc(S.store.siteUrl)}/feeds/google-USD.xml</code> (one per currency). AI assistants read <code>/llms.txt</code> and <code>/catalog.json</code>.</p></div>`,
      accounts: `<div class="grid2" style="align-items:start"><div class="card"><h2>Customer accounts</h2><div class="stack">${F.bool('auth.customerAccounts', 'Let buyers create accounts (email/password and Google)')}
          <p class="muted" style="font-size:12px">Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET Worker secrets — status: ${dot(integ.google.configured)}</p>
          ${F.csv('auth.adminDomains', 'Auto-approve dashboard sign-ins from these Google domains', { hint: 'e.g. screationindia.in — new people join as Staff. Leave empty to allow invited people only.' })}</div></div>
        <div class="card"><h2>Invoices</h2><div class="stack"><div class="grid2">${F.text('invoice.prefix', 'Number prefix', { hint: 'SC/2026-27/0001' })}${F.text('invoice.gstin', 'GSTIN')}</div>
          ${F.text('invoice.legalName', 'Legal name on invoice')}${F.area('invoice.address', 'Registered address', { rows: 3 })}${F.text('invoice.state', 'State (for CGST/SGST vs IGST)')}
          ${F.text('invoice.lutNote', 'Export note (LUT)')}${F.text('invoice.footer', 'Footer note')}</div></div></div>`,
      raw: `<p class="muted">Full settings JSON — for bulk edits. Invalid JSON is ignored.</p><textarea class="i code" id="rawjson" rows="30">${esc(JSON.stringify(S, null, 2))}</textarea>`,
    };
    $('#sedit').innerHTML = `<div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${stab === k ? 'on' : ''}">${n}</button>`).join('')}</div><div id="pane">${panes[stab]}</div>`;
    bind($('#pane'), S);
    $$('[data-tab]').forEach((b) => (b.onclick = () => { stab = b.dataset.tab; render(); }));
    $$('[data-lang]').forEach((c) => (c.onchange = () => { const l = c.dataset.lang; S.languages.enabled = c.checked ? [...new Set([...S.languages.enabled, l])] : S.languages.enabled.filter((x) => x !== l); dirty = true; render(); }));
    if ($('#dhlcreds')) {
      const paint = async () => { const { secrets } = await api('/api/admin/secrets'); for (const [k, v] of Object.entries(secrets)) { const el = $('#h_' + k); if (el) el.textContent = v.set ? `saved ••••${v.hint}` : 'not set'; } };
      paint();
      $('[data-savesec]').onclick = async () => { const body = {}; $$('[data-sec]').forEach((i) => { if (i.value.trim()) body[i.dataset.sec] = i.value.trim(); }); if (!Object.keys(body).length) return toast('Type the key first', true); await api('/api/admin/secrets', { method: 'PUT', body }); $$('[data-sec]').forEach((i) => (i.value = '')); toast('DHL credentials saved'); paint(); };
      $('[data-clearsec]').onclick = async () => { if (!confirm('Remove the DHL credentials saved in the dashboard?')) return; await api('/api/admin/secrets', { method: 'PUT', body: { DHL_API_KEY: '', DHL_API_SECRET: '', DHL_ACCOUNT_NUMBER: '' } }); toast('Removed'); paint(); };
    }
    const dt = $('[data-dhltest]'); if (dt) dt.onclick = async () => {
      const o = $('#dhlout'); o.hidden = false; o.textContent = 'Asking DHL…';
      try { const d = await api('/api/admin/shipping/test', { method: 'POST', body: { test: S.shipping?.dhl?.test !== false, country: $('#dhlc').value, postcode: $('#dhlp').value, city: $('#dhlcity').value, netKg: +$('#dhlkg').value || 10 } });
        o.textContent = (d.weight ? `Net ${d.weight.netKg} kg → shipped ${d.weight.shippedKg.toFixed(2)} kg in ${d.weight.boxes} box(es)${d.weight.dimensionsSent ? ' (box size sent)' : ''}\n` : '') + (d.ok ? '✓ DHL is working — ' + d.rates.map((r) => `${r.service}: ${r.amountCurrency} ${r.amount}`).join(' · ') : '✗ ' + d.error) + '\n\n' + JSON.stringify(d, null, 2); }
      catch (e) { o.textContent = '✗ ' + e.message; }
    };
    const fxb = $('[data-fx]'); if (fxb) fxb.onclick = async () => { try { fxCache = (await api('/api/admin/fx/refresh', { method: 'POST' })).fx; toast('Rates refreshed'); render(); } catch (e) { toast(e.message, true); } };
    const raw = $('#rawjson'); if (raw) raw.oninput = () => { try { const v = JSON.parse(raw.value); Object.keys(S).forEach((k) => delete S[k]); Object.assign(S, v); raw.style.borderColor = ''; dirty = true; } catch { raw.style.borderColor = 'var(--err)'; } };
  };
  const dot = (b) => `<span class="dot ${b ? 'ok' : 'no'}"></span><span class="mono muted">${b ? 'connected' : 'not configured'}</span>`;
  shell('settings', 'Settings', `<div id="sedit"></div><div class="savebar"><span class="mono">Settings</span><span class="spacer"></span><button class="btn accent" id="ssave">Save settings</button></div>`);
  wireReps($('#sedit'), S, render, { currencies: { code: '', enabled: true, round: 0.05 }, 'tax.rules': { country: '', rate: 0, label: 'VAT' }, categories: { slug: '', name: '' }, faqs: { q: '', a: '' }, pages: { slug: '', title: '', body: '' }, 'shipping.manual.zones': { name: '', countries: [], base: 0, perKg: 0, days: '' } });
  render();
  $('#ssave').onclick = async () => {
    try { settingsCache = (await api('/api/admin/settings', { method: 'PUT', body: S })).settings; dirty = false; toast('Settings saved. Publish to update the site.'); }
    catch (e) { toast(e.message, true); }
  };
}
// ---------- publish ----------
async function viewPublish() {
  const st = await api('/api/admin/publish');
  shell('publish', 'Publish', `<div class="card"><h2>Storefront deployments</h2>
    <p>The storefront is a static site on GitHub Pages. <b>Publish site</b> rebuilds every page, the sitemap, feeds and structured data from the products and settings saved here, then deploys — usually in 1–2 minutes. Prices in other currencies update live without publishing.</p>
    ${st.configured ? `<div class="wrapt"><table class="t"><thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th></th></tr></thead><tbody>
      ${st.runs.map((r) => `<tr><td>${date(r.createdAt)}</td><td>${esc(r.event)}</td><td><span class="dot ${r.conclusion === 'success' ? 'ok' : r.conclusion ? 'no' : 'warn'}"></span>${esc(r.conclusion || r.status)}</td><td class="r"><a href="${esc(r.url)}" target="_blank">Log ↗</a></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No runs yet</td></tr>'}
    </tbody></table></div><div class="row" style="margin-top:14px"><button class="btn ghost sm" onclick="location.reload()">Refresh status</button></div>`
    : '<div class="note">Publishing is not connected yet. Add GITHUB_TOKEN as a Worker secret and set GITHUB_REPO in wrangler.toml.</div>'}</div>`);
}

// ---------- router ----------
async function route() {
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('token')) { token = frag.get('token'); sessionStorage.setItem('sc_admin_token', token); history.replaceState(null, '', location.pathname + '#/dashboard'); }
  if (!token) return renderAuth();
  if (!user) { try { user = (await api('/api/admin/me')).user; } catch { return; } }
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, id] = path.split('/');
  try {
    const need = (NAV.find((n) => n[0] === view) || [])[2];
    if (need && !can(need)) { shell(view, 'No access', `<div class="card empty">Your role (${esc(user.role)}) doesn't include ${esc(view)}. Ask an owner to change it.</div>`); return; }
    if (view === 'orders' && id) await viewOrder(id);
    else if (view === 'orders') await viewOrders();
    else if (view === 'customers') await viewCustomers();
    else if (view === 'products' && id) await viewProduct(id);
    else if (view === 'products') await viewProducts();
    else if (view === 'messages') await viewMessages();
    else if (view === 'settings') await viewSettings();
    else if (view === 'team') await viewTeam();
    else if (view === 'publish') await viewPublish();
    else if (view === 'me') await viewMe();
    else if (can('dashboard')) await viewDashboard();
    else location.hash = '#/orders';
  } catch (e) { toast(e.message, true); }
}
window.addEventListener('hashchange', () => { if (dirty && !confirm('Discard unsaved changes?')) return; dirty = false; route(); });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
route();
