// Customer account area: sign in / register / Google, orders, invoices, profile, addresses, security.
const COUNTRIES = 'AE AR AT AU BD BE BG BH BR CA CH CL CN CO CY CZ DE DK EE EG ES FI FR GB GR HK HR HU ID IE IL IN IS IT JO JP KE KR KW LK LT LU LV MA MT MU MX MY NG NL NO NP NZ OM PE PH PK PL PT QA RO RS SA SE SG SI SK TH TR TW TZ UA US UY VN ZA'.split(' ');

export async function initAccount(root, X) {
  const { api, session, href, lang, t, esc, $, $$, toast, cart, catalog, format, locale } = X;
  const q = new URLSearchParams(location.search);
  const fmt = (v, c) => format(v, c, locale);
  const date = (s) => (s ? new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const dn = (() => { try { return new Intl.DisplayNames([locale], { type: 'region' }); } catch { return { of: (c) => c }; } })();
  let googleOn = false;
  api('/api/auth/config').then((c) => { googleOn = c.google; $$('[data-google]', root).forEach((el) => (el.hidden = !googleOn)); }).catch(() => {});
  const err = (el, e) => { el.innerHTML = `<div class="errbox" style="margin-top:12px">${esc(e.message || e)}</div>`; };
  const googleHref = () => `${(window.SC.api || '').replace(/\/$/, '')}/api/auth/google?for=customer&return=${encodeURIComponent(location.origin + location.pathname + (q.get('next') ? '?next=' + q.get('next') : ''))}`;
  const afterLogin = () => { if (q.get('next') === 'checkout') location.href = href('/checkout/'); else { history.replaceState(null, '', location.pathname); location.hash = '#orders'; route(); } };

  // Returning from Google (#ctoken=… / #error=…)
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('ctoken')) { session.set(frag.get('ctoken')); history.replaceState(null, '', location.pathname + location.search); try { session.set(session.token, (await api('/api/account/me')).profile); } catch {} return afterLogin(); }
  const gErr = frag.get('error');
  if (gErr) history.replaceState(null, '', location.pathname + location.search);

  // Email links
  if (q.get('verify')) {
    try { await api('/api/account/verify', { method: 'POST', body: { token: q.get('verify') } }); toast(t(lang, 'verified')); } catch (e) { toast(esc(e.message)); }
    history.replaceState(null, '', location.pathname);
  }
  if (q.get('reset')) return resetView(q.get('reset'));

  async function route() {
    if (!session.token) return authView();
    const h = location.hash.replace('#', '');
    const [view, id] = h.split('=');
    try {
      if (view === 'order' && id) return await orderView(id);
      if (view === 'profile') return await profileView();
      if (view === 'addresses') return await addressesView();
      if (view === 'security') return await securityView();
      return await ordersView();
    } catch (e) { if (!session.token) return authView(); shell('orders', `<div class="errbox">${esc(e.message)}</div>`); }
  }
  window.addEventListener('hashchange', route);

  // ---------- signed out ----------
  function authView(mode = 'login') {
    const pwField = (name, label, ac) => `<label>${label}<input type="password" name="${name}" required minlength="8" autocomplete="${ac}"></label>`;
    root.innerHTML = `<div class="auth">
      <section><h2>${t(lang, 'signIn')}</h2>
        <a class="gbtn" data-google href="${googleHref()}" ${googleOn ? '' : 'hidden'}>${GOOGLE_SVG}${t(lang, 'continueGoogle')}</a>
        <div class="sep" data-google ${googleOn ? '' : 'hidden'}>${t(lang, 'orText')}</div>
        ${gErr ? `<div class="errbox" style="margin-bottom:14px">${esc(gErr)}</div>` : ''}
        ${mode === 'forgot' ? `<form class="form" data-forgot><p class="muted">${t(lang, 'sendReset')}</p><label>${t(lang, 'email')}<input type="email" name="email" required autocomplete="email"></label><button class="btn accent">${t(lang, 'sendReset')}</button><a href="#" class="link" data-mode="login">← ${t(lang, 'signIn')}</a><div data-out></div></form>`
        : `<form class="form" data-login><label>${t(lang, 'email')}<input type="email" name="email" required autocomplete="email"></label>${pwField('password', t(lang, 'password'), 'current-password')}
          <button class="btn accent">${t(lang, 'signIn')}</button><a href="#" class="link" data-mode="forgot" style="font-size:14px">${t(lang, 'forgot')}</a><div data-out></div></form>`}
      </section>
      <section><h2>${t(lang, 'createAccount')}</h2><p class="muted" style="font-size:14px">${t(lang, 'signInFaster')}</p>
        <form class="form" data-register><label>${t(lang, 'name')}<input name="name" required autocomplete="name"></label><label>${t(lang, 'email')}<input type="email" name="email" required autocomplete="email"></label>
          ${pwField('password', `${t(lang, 'password')} · ${t(lang, 'passwordHint')}`, 'new-password')}
          <label class="opt" style="background:none;border:0;padding:0"><input type="checkbox" name="marketing"> <span class="sub">${t(lang, 'marketing')}</span></label>
          <button class="btn">${t(lang, 'createAccount')}</button><div data-out></div></form></section></div>`;
    $$('[data-mode]', root).forEach((a) => (a.onclick = (e) => { e.preventDefault(); authView(a.dataset.mode); }));
    const lf = $('[data-login]', root);
    if (lf) lf.onsubmit = async (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(lf)); try { const d = await api('/api/account/login', { method: 'POST', body: v }); session.set(d.token, d.profile); afterLogin(); } catch (ex) { err($('[data-out]', lf), ex); } };
    const ff = $('[data-forgot]', root);
    if (ff) ff.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/account/forgot', { method: 'POST', body: Object.fromEntries(new FormData(ff)) }); $('[data-out]', ff).innerHTML = `<div class="okbox" style="margin-top:12px">${t(lang, 'resetSent')}</div>`; } catch (ex) { err($('[data-out]', ff), ex); } };
    const rf = $('[data-register]', root);
    rf.onsubmit = async (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(rf)); v.marketing = !!v.marketing; try { const d = await api('/api/account/register', { method: 'POST', body: v }); session.set(d.token, d.profile); afterLogin(); } catch (ex) { err($('[data-out]', rf), ex); } };
  }
  function resetView(token) {
    root.innerHTML = `<div class="auth" style="grid-template-columns:1fr;max-width:520px;margin-inline:auto"><section><h2>${t(lang, 'newPassword')}</h2>
      <form class="form" data-reset><label>${t(lang, 'newPassword')} · ${t(lang, 'passwordHint')}<input type="password" name="password" required minlength="8" autocomplete="new-password"></label><button class="btn accent">${t(lang, 'setPassword')}</button><div data-out></div></form></section></div>`;
    const f = $('[data-reset]', root);
    f.onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/api/account/reset', { method: 'POST', body: { token, password: f.password.value } }); session.set(d.token, d.profile); history.replaceState(null, '', location.pathname); location.hash = '#orders'; route(); } catch (ex) { err($('[data-out]', f), ex); } };
  }

  // ---------- signed in ----------
  function shell(active, inner) {
    const p = session.profile() || {};
    const tabs = [['orders', t(lang, 'myOrders')], ['profile', t(lang, 'profile')], ['addresses', t(lang, 'addresses')], ['security', t(lang, 'security')]];
    root.innerHTML = `<div class="acct"><nav aria-label="${t(lang, 'account')}">${tabs.map(([k, n]) => `<a href="#${k}" aria-current="${active === k}">${n}</a>`).join('')}<button data-signout>${t(lang, 'signOut')}</button></nav>
      <div><p class="mono muted" style="margin:0 0 6px">${t(lang, 'welcome')}${p.name ? ', ' + esc(p.name.split(' ')[0]) : ''} · ${esc(p.email || '')}</p>${inner}</div></div>`;
    $('[data-signout]', root).onclick = () => { session.clear(); location.hash = ''; authView(); };
  }
  async function refreshProfile() { const p = (await api('/api/account/me')).profile; session.set(session.token, p); return p; }
  const invoiceBtn = (o, cls = 'btn ghost sm') => o.invoiceAvailable ? `<button class="${cls}" data-inv="${esc(o.id)}" data-num="${esc(o.number)}">${t(lang, 'invoice')} ↓</button>` : '';
  async function downloadInvoice(id, num) {
    const r = await fetch(`${window.SC.api.replace(/\/$/, '')}/api/account/orders/${encodeURIComponent(id)}/invoice`, { headers: { authorization: 'Bearer ' + session.token } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(esc(d.error || 'Error')); }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `Invoice-${num}.pdf` }); a.click();
  }
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-inv]'); if (b) downloadInvoice(b.dataset.inv, b.dataset.num); });

  async function ordersView() {
    const [{ orders, emailVerified }] = await Promise.all([api('/api/account/orders'), refreshProfile()]);
    const verifyNote = emailVerified ? '' : `<div class="hint"><span>${t(lang, 'emailNotVerified')}</span><button class="btn ghost sm" data-resend>${t(lang, 'resend')}</button></div>`;
    shell('orders', `<h2>${t(lang, 'myOrders')}</h2>${verifyNote}${orders.length ? orders.map((o) => `<article class="ocard">
      <header><div><b>${t(lang, 'orderNumber')}</b>${esc(o.number)}</div><div><b>${t(lang, 'placed')}</b>${date(o.createdAt)}</div><div><b>${t(lang, 'total')}</b>${fmt(o.total, o.currency)}</div>
        <div><b>${t(lang, 'status')}</b><span class="status ${o.status}">${esc(o.status.replace(/_/g, ' '))}</span></div></header>
      <div class="body"><div>${o.groups.map((g) => `<div>${esc(g.name)} × ${g.qty}</div>`).join('')}${o.shipment?.tracking ? `<div class="muted" style="font-size:13px">${esc(o.shipment.carrier)} · ${esc(o.shipment.tracking)}</div>` : ''}</div>
        <div class="acts"><a class="btn sm" href="#order=${esc(o.id)}">${t(lang, 'view')}</a>${invoiceBtn(o)}${o.shipment?.url ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="${esc(o.shipment.url)}">${t(lang, 'track')} ↗</a>` : ''}${o.payUrl ? `<a class="btn accent sm" href="${esc(o.payUrl)}">${t(lang, 'payNowShort')}</a>` : ''}</div></div></article>`).join('')
      : `<div class="empty"><p class="muted">${t(lang, 'noOrders')}</p><a class="btn accent" href="${href('/products/')}">${t(lang, 'shopCollection')}</a></div>`}`);
    $('[data-resend]', root)?.addEventListener('click', async (e) => { await api('/api/account/resend-verification', { method: 'POST', body: {} }); e.target.disabled = true; toast(t(lang, 'resend') + ' ✓'); });
  }

  async function orderView(id) {
    const { order: o } = await api('/api/account/orders/' + encodeURIComponent(id));
    const a = o.address || {};
    shell('orders', `<p><a class="link mono" href="#orders">← ${t(lang, 'backToOrders')}</a></p>
      <div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2 style="margin:0">${t(lang, 'orderNumber')} ${esc(o.number)}</h2><span class="status ${o.status}">${esc(o.status.replace(/_/g, ' '))}</span></div>
      <p class="muted">${t(lang, 'placed')} ${date(o.createdAt)}${o.invoiceNo ? ` · ${t(lang, 'invoice')} ${esc(o.invoiceNo)}` : ''}</p>
      <div class="acts" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">${invoiceBtn(o, 'btn sm')}${o.shipment?.url ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="${esc(o.shipment.url)}">${t(lang, 'track')} ↗</a>` : ''}<button class="btn ghost sm" data-reorder>${t(lang, 'reorder')}</button>${o.payUrl ? `<a class="btn accent sm" href="${esc(o.payUrl)}">${t(lang, 'payNowShort')}</a>` : ''}</div>
      ${o.shipment?.tracking ? `<div class="okbox" style="margin-bottom:18px">${t(lang, 'shippedOn')} ${date(o.shipment.shippedAt)} · ${esc(o.shipment.carrier)} ${esc(o.shipment.tracking)}</div>` : ''}
      ${o.groups.map((g) => { const sizes = [...new Set(g.lines.map((l) => l.size))], colors = [...new Set(g.lines.map((l) => l.color))];
        return `<section class="cgroup"><header><div style="flex:1"><div class="mono muted">${esc(g.code)}</div><h3>${esc(g.name)}</h3></div><div style="text-align:right">${g.qty} × ${fmt(g.unit, o.currency)}<br><b>${fmt(g.total, o.currency)}</b></div></header>
          <div class="tablewrap"><table class="mtable"><thead><tr><th>${t(lang, 'colour')}</th>${sizes.map((s) => `<th>${esc(s)}</th>`).join('')}<th>${t(lang, 'total')}</th></tr></thead><tbody>
          ${colors.map((c) => `<tr><td>${esc(c)}</td>${sizes.map((s) => `<td>${g.lines.find((l) => l.color === c && l.size === s)?.qty || ''}</td>`).join('')}<td><b>${g.lines.filter((l) => l.color === c).reduce((n, l) => n + l.qty, 0)}</b></td></tr>`).join('')}</tbody></table></div></section>`; }).join('')}
      <div class="twocol"><div class="fieldset"><h3>${t(lang, 'shippingAddress')}</h3><p>${[a.name, a.company, a.line1, a.line2, [a.city, a.state, a.postcode].filter(Boolean).join(', '), dn.of(a.country)].filter(Boolean).map(esc).join('<br>')}</p><p class="muted">${esc(o.shipping?.service || '')}</p></div>
        <div class="summary" style="position:static"><div class="row"><span>${t(lang, 'subtotal')}</span><span>${fmt(o.subtotal, o.currency)}</span></div><div class="row"><span>${t(lang, 'shipping')}</span><span>${fmt(o.shippingAmount, o.currency)}</span></div>
          ${o.taxAmount ? `<div class="row"><span>${esc(o.taxLabel || t(lang, 'tax'))}</span><span>${fmt(o.taxAmount, o.currency)}</span></div>` : ''}<div class="row total"><span>${t(lang, 'total')}</span><span>${fmt(o.total, o.currency)}</span></div></div></div>`);
    $('[data-reorder]', root).onclick = async () => {
      const products = await catalog();
      const items = cart.items();
      for (const g of o.groups) {
        const pid = products.find((p) => p.code === g.code)?.id; if (!pid) continue;
        for (const l of g.lines) { const ex = items.find((i) => i.productId === pid && i.color === l.color && i.size === l.size); if (ex) ex.qty += l.qty; else items.push({ productId: pid, color: l.color, size: l.size, qty: l.qty }); }
      }
      cart.save(items); location.href = href('/cart/');
    };
  }

  async function profileView() {
    const p = await refreshProfile();
    shell('profile', `<h2>${t(lang, 'profile')}</h2><form class="form fieldset" data-prof>
      <label>${t(lang, 'email')}<input value="${esc(p.email)}" readonly></label>
      <div class="two"><label>${t(lang, 'name')}<input name="name" value="${esc(p.name)}" autocomplete="name"></label><label>${t(lang, 'phone')}<input name="phone" value="${esc(p.phone)}" autocomplete="tel"></label></div>
      <div class="two"><label>${t(lang, 'company')}<input name="company" value="${esc(p.company)}" autocomplete="organization"></label><label>${t(lang, 'taxId')}<input name="taxId" value="${esc(p.taxId)}"></label></div>
      <label class="opt" style="background:none;border:0;padding:0"><input type="checkbox" name="marketing" ${p.marketing ? 'checked' : ''}> <span class="sub">${t(lang, 'marketing')}</span></label>
      <button class="btn accent" style="justify-self:start">${t(lang, 'save')}</button></form>`);
    const f = $('[data-prof]', root);
    f.onsubmit = async (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(f)); try { const d = await api('/api/account/me', { method: 'PUT', body: { ...p, ...v, marketing: !!v.marketing } }); session.set(session.token, d.profile); toast(t(lang, 'saved')); } catch (ex) { toast(esc(ex.message)); } };
  }

  async function addressesView(editIdx = null) {
    const p = await refreshProfile();
    const list = p.addresses;
    const form = (a = {}) => `<form class="form fieldset" data-addr>
      <div class="two"><label>${t(lang, 'label')}<input name="label" value="${esc(a.label || '')}"></label><label>${t(lang, 'country')}<select name="country" required><option value=""></option>${[...new Set([...COUNTRIES, a.country].filter(Boolean))].map((c) => [c, dn.of(c) || c]).sort((x, y) => x[1].localeCompare(y[1], locale)).map(([c, n]) => `<option value="${c}" ${a.country === c ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
      <div class="two"><label>${t(lang, 'name')}<input name="name" required value="${esc(a.name || p.name)}"></label><label>${t(lang, 'company')}<input name="company" value="${esc(a.company || p.company || '')}"></label></div>
      <label>${t(lang, 'address1')}<input name="line1" required value="${esc(a.line1 || '')}"></label><label>${t(lang, 'address2')}<input name="line2" value="${esc(a.line2 || '')}"></label>
      <div class="two"><label>${t(lang, 'city')}<input name="city" required value="${esc(a.city || '')}"></label><label>${t(lang, 'state')}<input name="state" value="${esc(a.state || '')}"></label></div>
      <div class="two"><label>${t(lang, 'postcode')}<input name="postcode" required value="${esc(a.postcode || '')}"></label><label>${t(lang, 'phone')}<input name="phone" value="${esc(a.phone || p.phone || '')}"></label></div>
      <div style="display:flex;gap:10px"><button class="btn accent">${t(lang, 'save')}</button><button type="button" class="btn ghost" data-cancel>✕</button></div></form>`;
    shell('addresses', `<h2>${t(lang, 'addresses')}</h2>
      ${list.map((a, i) => editIdx === i ? form(a) : `<div class="addr ${a.isDefault ? 'def' : ''}"><div>${a.label ? `<b>${esc(a.label)}</b>${a.isDefault ? ` · <span class="mono">${t(lang, 'default_')}</span>` : ''}<br>` : a.isDefault ? `<span class="mono">${t(lang, 'default_')}</span><br>` : ''}${[a.name, a.company, a.line1, a.line2, [a.city, a.state, a.postcode].filter(Boolean).join(', '), dn.of(a.country)].filter(Boolean).map(esc).join('<br>')}</div>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap"><button class="btn ghost sm" data-edit="${i}">${t(lang, 'edit')}</button>${a.isDefault ? '' : `<button class="btn ghost sm" data-def="${i}">${t(lang, 'makeDefault')}</button>`}<button class="xbtn" data-del="${i}">${t(lang, 'delete_')}</button></div></div>`).join('')}
      ${editIdx === -1 ? form() : `<button class="btn" data-add>+ ${t(lang, 'addAddress')}</button>`}`);
    const save = async (addresses) => { await api('/api/account/me', { method: 'PUT', body: { ...p, addresses } }); toast(t(lang, 'saved')); addressesView(); };
    root.querySelector('[data-add]')?.addEventListener('click', () => addressesView(-1));
    $$('[data-edit]', root).forEach((b) => (b.onclick = () => addressesView(+b.dataset.edit)));
    $$('[data-def]', root).forEach((b) => (b.onclick = () => save(list.map((a, i) => ({ ...a, isDefault: i === +b.dataset.def })))));
    $$('[data-del]', root).forEach((b) => (b.onclick = () => save(list.filter((_, i) => i !== +b.dataset.del))));
    $('[data-cancel]', root)?.addEventListener('click', () => addressesView());
    const f = $('[data-addr]', root);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const next = [...list];
      if (editIdx === -1) next.push({ ...v, isDefault: !list.length }); else next[editIdx] = { ...next[editIdx], ...v };
      try { await save(next); } catch (ex) { toast(esc(ex.message)); }
    };
  }

  async function securityView() {
    const p = await refreshProfile();
    shell('security', `<h2>${t(lang, 'security')}</h2>
      ${p.google ? `<p class="okbox" style="display:inline-block">✓ Google</p>` : ''}
      <form class="form fieldset" data-pw style="max-width:520px">${!p.hasPassword ? `<p class="muted">${t(lang, 'googleOnly')}</p>` : `<label>${t(lang, 'currentPassword')}<input type="password" name="current" required autocomplete="current-password"></label>`}
        <label>${t(lang, 'newPassword')} · ${t(lang, 'passwordHint')}<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <button class="btn accent" style="justify-self:start">${t(lang, 'save')}</button><div data-out></div></form>
      <button class="btn ghost" data-all>${t(lang, 'signOutAll')}</button>`);
    const f = $('[data-pw]', root);
    f.onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/api/account/password', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); session.set(d.token); f.reset(); toast(t(lang, 'saved')); } catch (ex) { err($('[data-out]', f), ex); } };
    $('[data-all]', root).onclick = async () => { await api('/api/account/logout-all', { method: 'POST', body: {} }); session.clear(); authView(); };
  }

  route();
}

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;
