// S Creation storefront runtime: currency, cart, product order grid, checkout, order status.
import { convert, format, tierPrice, priceCart } from './pricing.js';
import { t, LOCALES } from './lib/i18n.js';
import { garmentSVG, esc } from './lib/util.js';

const SC = window.SC || {};
const lang = document.body.dataset.lang || 'en';
const locale = LOCALES[lang] || 'en';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const settings = { baseCurrency: SC.baseCurrency, currencies: SC.currencies, fxMarkup: SC.fxMarkup, tax: SC.tax };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const href = (p) => {
  let u = (SC.base || '') + (lang === SC.defaultLang ? '' : '/' + lang) + p;
  if (SC.fileLinks && u.endsWith('/')) u += 'index.html';
  return u;
};
// Customer session (signed token from the API; 30 days)
export const session = {
  get token() { return store.get('sc_ctoken', null); },
  set(token, profile) { store.set('sc_ctoken', token); if (profile) store.set('sc_cprofile', profile); paintAccount(); },
  profile() { return store.get('sc_cprofile', null); },
  clear() { try { localStorage.removeItem('sc_ctoken'); localStorage.removeItem('sc_cprofile'); } catch {} paintAccount(); },
};
function paintAccount() {
  const p = session.token && session.profile();
  for (const el of $$('[data-acct-label]')) el.textContent = p ? (p.name || p.email).split(' ')[0] : t(lang, 'signIn');
}
async function api(path, opts = {}) {
  if (!SC.api) throw new Error('API not configured');
  const auth = session.token && /^\/api\/(account|checkout)/.test(path) ? { authorization: 'Bearer ' + session.token } : {};
  const r = await fetch(SC.api.replace(/\/$/, '') + path, {
    ...opts, headers: { 'content-type': 'application/json', ...auth, ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && auth.authorization) session.clear();
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { data, status: r.status });
  return data;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ---------------- currency ----------------
const REGION_CUR = { US: 'USD', GB: 'GBP', IN: 'INR', AE: 'AED', AU: 'AUD', CA: 'CAD', SG: 'SGD', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR' };
let fx = SC.fx;
let cur = store.get('sc_cur', null);
const enabled = (c) => (SC.currencies || []).some((x) => x.code === c);

async function initCurrency() {
  const cached = (() => { try { return JSON.parse(sessionStorage.getItem('sc_fx')); } catch { return null; } })();
  if (cached && Date.now() - cached.at < 6 * 3600e3) fx = cached.fx;
  else withTimeout(api('/api/fx'), 2500).then((d) => { if (d?.rates) { fx = d; try { sessionStorage.setItem('sc_fx', JSON.stringify({ at: Date.now(), fx })); } catch {} applyPrices(); } }).catch(() => {});
  if (!cur || !enabled(cur)) {
    const region = (navigator.language || '').split('-')[1];
    cur = REGION_CUR[region] && enabled(REGION_CUR[region]) ? REGION_CUR[region] : (enabled('USD') ? 'USD' : SC.baseCurrency);
    withTimeout(api('/api/geo'), 2000).then((g) => {
      if (!store.get('sc_cur') && g?.currency && enabled(g.currency)) { cur = g.currency; applyPrices(); }
    }).catch(() => {});
  }
  const sel = $('#curSel');
  if (sel) { sel.value = cur; sel.addEventListener('change', () => { cur = sel.value; store.set('sc_cur', cur); applyPrices(); document.dispatchEvent(new Event('sc:currency')); }); }
}
const conv = (base) => convert(base, cur, settings, fx) ?? convert(base, SC.baseCurrency, settings, fx);
const curOrBase = () => (fx?.rates?.[cur] || cur === SC.baseCurrency ? cur : SC.baseCurrency);
const money = (v, c = curOrBase()) => format(v, c, locale);
function applyPrices() {
  const sel = $('#curSel'); if (sel && sel.value !== cur) sel.value = cur;
  for (const el of $$('[data-price]')) el.textContent = money(conv(+el.dataset.price));
  document.dispatchEvent(new Event('sc:prices'));
}

// ---------------- cart ----------------
const cart = {
  items: () => store.get('sc_cart', []),
  save(items) { store.set('sc_cart', items.filter((i) => i.qty > 0)); updateCount(); },
  setProductMix(productId, mix) { // mix: [{color,size,qty}] replaces this product's lines
    const rest = cart.items().filter((i) => i.productId !== productId);
    cart.save([...rest, ...mix.map((m) => ({ productId, ...m }))]);
  },
  clear() { cart.save([]); },
};
function updateCount() { const n = cart.items().reduce((s, i) => s + i.qty, 0); for (const el of $$('[data-cart-count]')) el.textContent = n; }
function toast(html, ms = 3500) { const el = $('.toast'); if (!el) return; el.innerHTML = html; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), ms); }

let catalogP;
const catalog = () => (catalogP ??= fetch((SC.base || '') + '/catalog.json').then((r) => r.json()).then((d) => d.products));

// ---------------- header ----------------
function initHeader() {
  const b = $('.burger'), nav = $('#nav');
  b?.addEventListener('click', () => { const o = nav.classList.toggle('open'); b.setAttribute('aria-expanded', o); });
  $('#langSel')?.addEventListener('change', (e) => { const o = e.target.selectedOptions[0]; location.href = o.dataset.href; });
  updateCount();
}

// ---------------- product page ----------------
function initPDP() {
  const root = $('[data-product]'); if (!root) return;
  const P = JSON.parse($('#pdata').textContent);
  const existing = cart.items().filter((i) => i.productId === P.id);
  const qty = {}; // color -> size -> n
  for (const i of existing) ((qty[i.color] ??= {})[i.size] = i.qty);
  let color = P.hero || P.colors[0]?.name;
  const inputs = $$('[data-size]', root);

  const showColor = (name, imgIdx = 0) => {
    color = name;
    const c = P.colors.find((x) => x.name === name);
    $('[data-colname]').textContent = name;
    $('[data-shown]').textContent = `${t(lang, 'shownIn')} — ${name}`;
    $$('.sw', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.color === name));
    $('[data-main]').innerHTML = c.images?.length ? `<img src="${esc(c.images[imgIdx])}" alt="${esc(P.name)} – ${esc(name)}">` : garmentSVG(P.type, c.hex, c.hex2);
    $('[data-thumbs]').innerHTML = (c.images || []).length > 1 ? c.images.map((u, i) => `<button type="button" aria-pressed="${i === imgIdx}" data-img="${i}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join('') : '';
    inputs.forEach((inp) => { const v = qty[name]?.[inp.dataset.size] || ''; inp.value = v || ''; inp.classList.toggle('has', !!v); });
  };
  $('[data-thumbs]').addEventListener('click', (e) => { const b = e.target.closest('[data-img]'); if (b) showColor(color, +b.dataset.img); });
  $('[data-swatches]').addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) showColor(b.dataset.color); });

  const render = () => {
    const total = Object.values(qty).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    const ok = total >= P.moq;
    $('[data-total]').textContent = total;
    const prog = $('[data-progress]'); prog.classList.toggle('ok', ok); prog.firstElementChild.style.width = Math.min(100, (total / P.moq) * 100) + '%';
    $('[data-moqmsg]').textContent = ok ? '✓ ' + t(lang, 'moqMet') : `${P.moq - total} ${t(lang, 'toGo')}`;
    const unitBase = tierPrice(P, Math.max(total, P.moq));
    const unit = conv(unitBase);
    $('[data-unit]').innerHTML = `${money(unit)} <small>${t(lang, 'perPc')}</small>`;
    $$('[data-tier]').forEach((tr, i, all) => { const min = +tr.dataset.tier, next = all[i + 1] ? +all[i + 1].dataset.tier : Infinity; tr.classList.toggle('on', Math.max(total, P.moq) >= min && Math.max(total, P.moq) < next); });
    $('[data-subtotal]').textContent = total ? money(+(unit * total).toFixed(2)) : '—';
    $('[data-mix]').innerHTML = Object.entries(qty).filter(([, m]) => Object.values(m).some(Boolean))
      .map(([c, m]) => `<div><b>${esc(c)}</b>: ${Object.entries(m).filter(([, n]) => n).map(([s, n]) => `${esc(s)}×${n}`).join(', ')}</div>`).join('');
    $$('.sw', root).forEach((b) => { const n = Object.values(qty[b.dataset.color] || {}).reduce((a, x) => a + x, 0); let q = $('.q', b); if (n) { if (!q) { q = document.createElement('span'); q.className = 'q'; b.append(q); } q.textContent = n; } else q?.remove(); });
    const btn = $('[data-add]'); btn.disabled = !ok; btn.textContent = existing.length ? t(lang, 'addToCart') + ' ✓' : t(lang, 'addToCart');
  };
  inputs.forEach((inp) => inp.addEventListener('input', () => {
    const n = Math.max(0, Math.floor(+inp.value || 0));
    (qty[color] ??= {})[inp.dataset.size] = n;
    inp.classList.toggle('has', n > 0);
    render();
  }));
  $('[data-add]').addEventListener('click', () => {
    const mix = [];
    for (const [c, m] of Object.entries(qty)) for (const [s, n] of Object.entries(m)) if (n > 0) mix.push({ color: c, size: s, qty: n });
    cart.setProductMix(P.id, mix);
    toast(`${t(lang, 'added')} — <a href="${href('/cart/')}">${t(lang, 'cart')} →</a>`);
  });
  document.addEventListener('sc:prices', render);
  showColor(color);
  render();
}

// ---------------- cart page ----------------
async function initCartPage(root) {
  const products = await catalog();
  const draw = () => {
    const items = cart.items();
    if (!items.length) { root.innerHTML = `<div class="empty"><p class="muted">${t(lang, 'emptyCart')}</p><a class="btn accent" href="${href('/products/')}">${t(lang, 'shopCollection')}</a></div>`; return; }
    const priced = priceCart(items, products, settings, fx, curOrBase());
    root.innerHTML = `<div class="cartgrid"><div>${priced.groups.map((g) => {
      const p = products.find((x) => x.id === g.productId);
      const c0 = p.colors.find((c) => c.name === g.lines[0].color) || p.colors[0];
      return `<section class="cgroup" data-pid="${p.id}">
        <header><div class="thumb">${c0.image ? `<img src="${esc(c0.image)}" alt="">` : garmentSVG(p.type, c0.hex, c0.hex2)}</div>
          <div style="flex:1"><div class="mono muted">${esc(p.code)}</div><h3>${esc(p.i18n?.[lang]?.name || p.name)}</h3><div class="muted" style="font-size:14px">${money(g.unit)} ${t(lang, 'perPc')} · ${t(lang, 'moq')} ${g.moq}</div></div>
          <a class="btn ghost sm" href="${href('/products/' + p.slug + '/')}">${t(lang, 'edit')}</a></header>
        <table><thead><tr><th>${t(lang, 'colour')}</th><th>${t(lang, 'size')}</th><th class="r">${t(lang, 'qty')}</th><th class="r">${t(lang, 'total')}</th><th></th></tr></thead><tbody>
        ${g.lines.map((l) => `<tr><td>${esc(l.color)}</td><td>${esc(l.size)}</td><td class="r"><input type="number" min="0" value="${l.qty}" data-line="${esc(l.color)}|${esc(l.size)}" aria-label="${t(lang, 'qty')}"></td><td class="r">${money(+(g.unit * l.qty).toFixed(2))}</td><td class="r"><button class="xbtn" data-rm="${esc(l.color)}|${esc(l.size)}">${t(lang, 'remove')}</button></td></tr>`).join('')}
        </tbody></table>
        <footer><div>${g.meetsMoq ? `<span class="okbox">✓ ${g.qty} ${t(lang, 'pcs')} · ${t(lang, 'moqMet')}</span>` : `<span class="warnbox">${t(lang, 'belowMoq', { n: g.moq - g.qty })}</span>`}</div><b>${money(g.total)}</b></footer>
      </section>`; }).join('')}
      <a class="link" href="${href('/products/')}">← ${t(lang, 'continueShopping')}</a></div>
      <aside class="summary"><h2 style="font-size:22px">${t(lang, 'yourCart')}</h2>
        <div class="row"><span>${t(lang, 'subtotal')}</span><b>${money(priced.subtotal)}</b></div>
        <div class="row muted"><span>${t(lang, 'shipping')}</span><span>DHL Express — ${t(lang, 'checkout').toLowerCase()}</span></div>
        <div class="row total"><span>${t(lang, 'total')}</span><span>${money(priced.subtotal)}</span></div>
        <a class="btn accent block" href="${href('/checkout/')}" ${priced.ok ? '' : 'aria-disabled="true" style="pointer-events:none;opacity:.35"'}>${t(lang, 'checkout')} →</a>
        <p class="mono muted" style="margin-top:12px;font-size:11px">${t(lang, 'pricesIn')} ${curOrBase()}</p></aside></div>`;
  };
  root.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-line]'); if (!inp) return;
    const pid = inp.closest('[data-pid]').dataset.pid, [c, s] = inp.dataset.line.split('|');
    cart.save(cart.items().map((i) => (i.productId === pid && i.color === c && i.size === s ? { ...i, qty: Math.max(0, Math.floor(+inp.value || 0)) } : i)));
    draw();
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const pid = b.closest('[data-pid]').dataset.pid, [c, s] = b.dataset.rm.split('|');
    cart.save(cart.items().filter((i) => !(i.productId === pid && i.color === c && i.size === s)));
    draw();
  });
  document.addEventListener('sc:prices', draw);
  draw();
}

// ---------------- checkout ----------------
const COUNTRIES = 'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CG CH CI CK CL CM CN CO CR CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PR PT PW PY QA RE RO RS RW SA SB SC SE SG SH SI SK SL SM SN SO SR SS ST SV SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS XK YE YT ZA ZM ZW'.split(' ');
async function initCheckout(root) {
  const items = cart.items();
  if (!items.length) { location.href = href('/cart/'); return; }
  const products = await catalog();
  const dn = new Intl.DisplayNames([locale], { type: 'region' });
  const countries = COUNTRIES.map((c) => [c, dn.of(c) || c]).sort((a, b) => a[1].localeCompare(b[1], locale));
  const saved = store.get('sc_checkout', {});
  let me = null;
  if (session.token) { try { me = (await api('/api/account/me')).profile; session.set(session.token, me); } catch { me = null; } }
  if (me) {
    const def = me.addresses.find((a) => a.isDefault) || me.addresses[0];
    Object.assign(saved, { email: me.email, name: saved.name || me.name, phone: saved.phone || me.phone, company: saved.company || me.company, taxId: saved.taxId || me.taxId });
    if (def && !saved.line1) Object.assign(saved, { line1: def.line1, line2: def.line2, city: def.city, state: def.state, postcode: def.postcode, country: def.country, name: def.name || saved.name, company: def.company || saved.company, phone: def.phone || saved.phone });
  }
  let rates = [], rate = null;
  const field = (n, label, attrs = '') => `<label>${label}<input name="${n}" value="${esc(saved[n] || '')}" ${attrs}></label>`;
  const addrPick = me?.addresses?.length > 1 ? `<label>${t(lang, 'savedAddress')}<select data-pick><option value="">${t(lang, 'useNew')}</option>${me.addresses.map((a, i) => `<option value="${i}"${a.line1 === saved.line1 ? ' selected' : ''}>${esc([a.label, a.line1, a.city, a.country].filter(Boolean).join(' · '))}</option>`).join('')}</select></label>` : '';
  root.innerHTML = `<div class="cartgrid"><form class="form" data-co novalidate>
    ${me ? '' : `<div class="hint"><span>${t(lang, 'signInFaster')}</span><a class="btn ghost sm" href="${href('/account/')}?next=checkout">${t(lang, 'signIn')}</a></div>`}
    <div class="fieldset"><h2><span class="n">1</span>${t(lang, 'contactDetails')}</h2>
      <div class="two">${field('email', t(lang, 'email'), 'type="email" required autocomplete="email"')}${field('phone', t(lang, 'phone'), 'type="tel" required autocomplete="tel"')}</div>
      <div class="two" style="margin-top:14px">${field('name', t(lang, 'name'), 'required autocomplete="name"')}${field('company', t(lang, 'company'), 'autocomplete="organization"')}</div></div>
    <div class="fieldset"><h2><span class="n">2</span>${t(lang, 'shippingAddress')}</h2><div class="form">${addrPick}
      <label>${t(lang, 'country')}<select name="country" required autocomplete="country"><option value=""></option>${countries.map(([c, n]) => `<option value="${c}"${saved.country === c ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      ${field('line1', t(lang, 'address1'), 'required autocomplete="address-line1"')}${field('line2', t(lang, 'address2'), 'autocomplete="address-line2"')}
      <div class="two">${field('city', t(lang, 'city'), 'required autocomplete="address-level2"')}${field('state', t(lang, 'state'), 'autocomplete="address-level1"')}</div>
      <div class="two">${field('postcode', t(lang, 'postcode'), 'required autocomplete="postal-code"')}${field('taxId', t(lang, 'taxId'))}</div>
      <button type="button" class="btn ghost" data-rates>${t(lang, 'getRates')}</button><div data-rates-out></div></div></div>
    <div class="fieldset"><h2><span class="n">3</span>${t(lang, 'payment')}</h2><div data-pay></div>
      <label style="margin-top:14px">${t(lang, 'notes')}<textarea name="notes">${esc(saved.notes || '')}</textarea></label>
      <p class="muted" style="font-size:13px;margin:14px 0">${t(lang, 'agree')}</p>
      <button class="btn accent block" data-submit disabled>${t(lang, 'payNow')} →</button><div data-err style="margin-top:12px"></div></div>
  </form><aside class="summary" data-sum></aside></div>`;
  const form = $('[data-co]', root);
  const val = () => Object.fromEntries(new FormData(form));
  const priced = () => priceCart(items, products, settings, fx, curOrBase());

  const drawPay = () => {
    const c = curOrBase();
    const opts = Object.entries(SC.payments || {}).filter(([, g]) => g.enabled && (!g.currencies?.length || g.currencies.includes(c)));
    $('[data-pay]', root).innerHTML = opts.length ? opts.map(([k, g], i) => `<label class="opt"><input type="radio" name="gateway" value="${k}"${i === 0 ? ' checked' : ''}><span class="grow"><b>${esc(g.label || k)}</b><div class="sub">${k === 'stripe' ? 'Visa · Mastercard · Amex · Apple Pay · Google Pay' : 'PayPal account or card via PayPal'}</div></span></label>`).join('')
      : `<div class="warnbox">No payment method supports ${c}. Please switch currency.</div>`;
  };
  const drawSum = () => {
    const p = priced();
    const ship = rate ? rate.amount : null;
    const tax = rate?.tax || 0;
    $('[data-sum]', root).innerHTML = `<h2 style="font-size:22px">${t(lang, 'yourCart')}</h2>
      ${p.groups.map((g) => `<div class="row"><span>${esc(g.name)} × ${g.qty}</span><span>${money(g.total)}</span></div>${g.meetsMoq ? '' : `<div class="warnbox">${t(lang, 'belowMoq', { n: g.moq - g.qty })}</div>`}`).join('')}
      <div class="row" style="border-top:1px solid var(--line);margin-top:8px;padding-top:12px"><span>${t(lang, 'subtotal')}</span><b>${money(p.subtotal)}</b></div>
      <div class="row"><span>${t(lang, 'shipping')}</span><span>${ship == null ? '—' : money(ship)}</span></div>
      ${tax ? `<div class="row"><span>${esc(rate.taxLabel || t(lang, 'tax'))}</span><span>${money(tax)}</span></div>` : ''}
      <div class="row total"><span>${t(lang, 'total')}</span><span>${money(+(p.subtotal + (ship || 0) + tax).toFixed(2))}</span></div>
      <p class="mono muted" style="margin-top:12px;font-size:11px">${t(lang, 'pricesIn')} ${curOrBase()}</p>`;
    $('[data-submit]', root).disabled = !(rate && p.ok);
  };
  const required = ['email', 'phone', 'name', 'country', 'line1', 'city', 'postcode'];
  const check = (keys) => {
    let ok = true;
    for (const k of keys) { const el = form.elements[k]; const bad = !el.value.trim() || (k === 'email' && !/^\S+@\S+\.\S+$/.test(el.value)); el.setAttribute('aria-invalid', bad); el.style.borderColor = bad ? 'var(--err)' : ''; if (bad) ok = false; }
    return ok;
  };
  $('[data-rates]', root).addEventListener('click', async () => {
    const out = $('[data-rates-out]', root);
    if (!check(['country', 'line1', 'city', 'postcode'])) return;
    const v = val(); store.set('sc_checkout', v);
    out.innerHTML = `<p class="muted">${t(lang, 'processing')}</p>`;
    try {
      const d = await api('/api/shipping/rates', { method: 'POST', body: { items, currency: curOrBase(), address: { country: v.country, postcode: v.postcode, city: v.city, state: v.state, line1: v.line1 } } });
      rates = d.rates || [];
      if (!rates.length) throw new Error('No shipping options for this address.');
      out.innerHTML = `<div style="margin-top:6px">${rates.map((r, i) => `<label class="opt"><input type="radio" name="rate" value="${i}"${i === 0 ? ' checked' : ''}><span class="grow"><b>${esc(r.service)}</b><div class="sub">${esc(r.eta || '')}</div></span><b>${money(r.amount)}</b></label>`).join('')}</div>`;
      rate = rates[0]; drawSum();
    } catch (e) { out.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; rate = null; drawSum(); }
  });
  if (me) form.elements.email.readOnly = true;
  $('[data-pick]', root)?.addEventListener('change', (e) => {
    const a = me.addresses[+e.target.value]; if (!a) return;
    for (const k of ['line1', 'line2', 'city', 'state', 'postcode', 'country', 'name', 'company', 'phone']) if (form.elements[k] && a[k] != null) form.elements[k].value = a[k];
    rate = null; rates = []; $('[data-rates-out]', root).innerHTML = ''; drawSum();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'rate') { rate = rates[+e.target.value]; drawSum(); }
    if (['country', 'postcode', 'city'].includes(e.target.name)) { rate = null; rates = []; $('[data-rates-out]', root).innerHTML = ''; drawSum(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-err]', root); err.innerHTML = '';
    if (!check(required) || !rate) return;
    const v = val(); store.set('sc_checkout', v);
    const btn = $('[data-submit]', root); btn.disabled = true; btn.textContent = t(lang, 'processing');
    try {
      const d = await api('/api/checkout', { method: 'POST', body: {
        items, currency: curOrBase(), lang, gateway: v.gateway, rateToken: rate.token, notes: v.notes,
        customer: { email: v.email, name: v.name, company: v.company, phone: v.phone, taxId: v.taxId },
        address: { name: v.name, company: v.company, line1: v.line1, line2: v.line2, city: v.city, state: v.state, postcode: v.postcode, country: v.country, phone: v.phone },
        returnBase: location.origin + href('/order/'),
      } });
      store.set('sc_last_order', { id: d.orderId, token: d.token });
      location.href = d.redirectUrl;
    } catch (ex) { err.innerHTML = `<div class="errbox">${esc(ex.message)}</div>`; btn.disabled = false; btn.textContent = t(lang, 'payNow') + ' →'; }
  });
  document.addEventListener('sc:currency', () => { rate = null; rates = []; $('[data-rates-out]', root).innerHTML = ''; drawPay(); drawSum(); });
  document.addEventListener('sc:prices', drawSum);
  drawPay(); drawSum();
}

// ---------------- order status ----------------
async function initOrder(root) {
  const q = new URLSearchParams(location.search);
  const last = store.get('sc_last_order', {});
  const id = q.get('id') || last.id, tok = q.get('t') || last.token;
  if (!id || !tok) { root.innerHTML = `<div class="empty"><a class="btn" href="${href('/')}">${t(lang, 'backToShop')}</a></div>`; return; }
  root.innerHTML = `<div class="empty"><p>${t(lang, 'processing')}</p></div>`;
  try {
    if (q.get('gateway') === 'paypal' && q.get('token') && !q.get('cancel')) await api(`/api/orders/${id}/capture?t=${encodeURIComponent(tok)}`, { method: 'POST', body: {} }).catch(() => {});
    let o;
    for (let i = 0; i < 15; i++) {
      o = (await api(`/api/orders/${id}?t=${encodeURIComponent(tok)}`)).order;
      if (o.status !== 'pending_payment' || q.get('cancel')) break;
      root.innerHTML = `<div class="empty"><p>${t(lang, 'orderPending')}</p></div>`;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const paid = !['pending_payment', 'cancelled'].includes(o.status);
    if (paid) cart.clear();
    root.innerHTML = `<div style="max-width:760px;margin:40px auto 80px">
      <div class="${paid ? 'okbox' : 'warnbox'}" style="font-size:16px;padding:16px">${paid ? '✓ ' + t(lang, 'orderReceived') : esc(o.status === 'cancelled' ? 'Payment cancelled.' : t(lang, 'orderPending'))}</div>
      <h2 style="margin-top:28px">${t(lang, 'orderNumber')} ${esc(o.number)}</h2>
      <p class="muted">${t(lang, 'status')}: <b>${esc(o.status.replace(/_/g, ' '))}</b>${o.shipment?.tracking ? ` · ${esc(o.shipment.carrier)} ${o.shipment.url ? `<a class="link" href="${esc(o.shipment.url)}" target="_blank" rel="noopener">${esc(o.shipment.tracking)}</a>` : esc(o.shipment.tracking)}` : ''}</p>
      ${o.invoiceAvailable ? `<p><a class="btn ghost sm" href="${esc(SC.api.replace(/\/$/, ''))}/api/orders/${encodeURIComponent(id)}/invoice?t=${encodeURIComponent(tok)}">${t(lang, 'downloadInvoice')} (PDF)</a></p>` : ''}
      <div class="summary" style="position:static;margin-top:20px">
        ${o.groups.map((g) => `<div class="row"><span>${esc(g.name)} × ${g.qty}</span><span>${format(g.total, o.currency, locale)}</span></div>`).join('')}
        <div class="row"><span>${t(lang, 'shipping')} (${esc(o.shipping?.service || '')})</span><span>${format(o.shippingAmount, o.currency, locale)}</span></div>
        ${o.taxAmount ? `<div class="row"><span>${t(lang, 'tax')}</span><span>${format(o.taxAmount, o.currency, locale)}</span></div>` : ''}
        <div class="row total"><span>${t(lang, 'total')}</span><span>${format(o.total, o.currency, locale)}</span></div></div>
      ${!paid && o.status === 'pending_payment' && o.payUrl ? `<a class="btn accent" style="margin-top:18px" href="${esc(o.payUrl)}">${t(lang, 'payNow')} →</a>` : ''}
      <p style="margin-top:24px" class="row"><a class="btn ghost" href="${href('/products/')}">${t(lang, 'backToShop')}</a> ${session.token ? `<a class="btn ghost" href="${href('/account/')}#orders">${t(lang, 'myOrders')}</a>` : `<a class="btn ghost" href="${href('/account/')}">${t(lang, 'createAccount')}</a>`}</p></div>`;
  } catch (e) { root.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
}

// ---------------- contact form ----------------
function initContact() {
  const f = $('[data-contact]'); if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('[data-msg]', f), btn = $('button', f);
    btn.disabled = true;
    try { await api('/api/contact', { method: 'POST', body: { ...Object.fromEntries(new FormData(f)), lang, page: location.pathname } }); f.reset(); out.innerHTML = `<div class="okbox">${t(lang, 'messageSent')}</div>`; }
    catch (ex) { out.innerHTML = `<div class="errbox">${esc(ex.message)} — ${esc(SC.store?.email || '')}</div>`; }
    btn.disabled = false;
  });
}

// ---------------- boot ----------------
initHeader();
paintAccount();
await initCurrency();
applyPrices();
initPDP();
initContact();
const app = $('[data-app]');
if (app?.dataset.app === 'cart') initCartPage(app);
if (app?.dataset.app === 'checkout') initCheckout(app);
if (app?.dataset.app === 'order') initOrder(app);
if (app?.dataset.app === 'account') import('./account.js').then((m) => m.initAccount(app, { api, session, store, href, money, lang, t, esc, $, $$, toast, cart, catalog, format, locale }));
