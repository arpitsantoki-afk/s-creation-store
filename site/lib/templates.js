import { esc, md, plain, garmentSVG } from './util.js';
import { t, LANG_NAMES, LOCALES } from './i18n.js';
import { imgTag } from '../../shared/img.js';
import { catTree, productCats, catName } from '../../shared/catalog.js';

/** wa.me link for the store's WhatsApp Business number (digits only, with country code). */
export function waLink(S, extra = '') {
  const n = String(S.store.whatsapp || '').replace(/\D/g, '');
  if (!n) return '';
  const msg = [S.store.whatsappMessage || '', extra].filter(Boolean).join('\n');
  return `https://wa.me/${n}${msg ? '?text=' + encodeURIComponent(msg) : ''}`;
}
const WA_ICON = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3zm0 23.4c-2.1 0-4.2-.6-6-1.7l-.4-.3-3.8 1.2 1.2-3.7-.3-.4a10.4 10.4 0 0 1-1.7-5.7C5 9.9 9.9 5.1 16 5.1S27 9.9 27 15.9s-4.9 10.5-11 10.5zm6-7.8c-.3-.2-2-1-2.3-1.1-.3-.1-.5-.2-.8.2l-1 1.3c-.2.2-.4.3-.7.1-.3-.2-1.4-.5-2.7-1.7-1-.9-1.7-2-1.9-2.3-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.5c-.3-.7-.6-.6-.8-.6h-.7c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.3 1.4 3.5c.2.2 2.4 3.7 5.9 5.1.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 2-.8 2.3-1.6.3-.8.3-1.4.2-1.6-.1-.1-.3-.2-.6-.4z"/></svg>';

/** Context passed to every template: { S (settings), lang, langs, base, href(), url(), fileLinks } */

export function locProduct(p, lang) {
  if (lang === 'en' || !p.i18n?.[lang]) return { ...p, _translated: lang === 'en' };
  const tr = p.i18n[lang];
  const out = { ...p, _translated: true };
  for (const k of ['name', 'type', 'tagline', 'short', 'description', 'fit', 'features', 'useCases', 'faqs', 'specs', 'highlights']) {
    if (tr[k] && (!Array.isArray(tr[k]) || tr[k].length)) out[k] = tr[k];
  }
  out.seo = { ...p.seo, ...(tr.seo || {}) };
  return out;
}
export function locPage(pg, lang) {
  if (lang === 'en' || !pg.i18n?.[lang]) return { ...pg, _translated: lang === 'en' };
  return { ...pg, ...pg.i18n[lang], _translated: true };
}

export const productImage = (p, color, cls = '', { sizes = '(max-width: 700px) 90vw, (max-width: 1100px) 45vw, 30vw', eager = false } = {}) => {
  const c = color || p.colors.find((c) => c.name === p.heroColor) || p.colors[0] || {};
  if (c.images?.length) return imgTag(c.images[0], { alt: `${p.name} in ${c.name}`, sizes, eager, cls });
  return garmentSVG(p.type, c.hex, c.hex2, cls);
};

const priceSpan = (amount, S) => `<span data-price="${amount}">${esc(fmtBase(amount, S))}</span>`;
export const fmtBase = (v, S) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: S.baseCurrency, maximumFractionDigits: 0 }).format(v);

export function layout(ctx, { title, description, path, body, jsonld = [], alternates = null, canonical = null, noindex = false, ogImage = null, pageClass = '', waText = '' }) {
  const { S, lang } = ctx;
  const site = S.store.siteUrl.replace(/\/$/, '');
  const origin = ctx.base && site.endsWith(ctx.base) ? site.slice(0, -ctx.base.length) : site;
  const canon = canonical || origin + ctx.url(path, lang, true);
  const alts = alternates ?? ctx.langs;
  const og = ogImage ? (ogImage.startsWith('http') ? ogImage : site + ogImage) : site + S.seo.ogImage;
  const navActive = (p) => (path === p ? ' aria-current="page"' : '');
  const langSel = ctx.langs.length > 1 ? `<label class="sr-only" for="langSel">${t(lang, 'language')}</label>
    <select id="langSel" class="sel lang">${ctx.langs.map((l) => `<option value="${l}" data-href="${esc(ctx.href(path, l))}"${l === lang ? ' selected' : ''}>${l.toUpperCase()}</option>`).join('')}</select>` : '';
  const curSel = `<label class="sr-only" for="curSel">${t(lang, 'currency')}</label>
    <select id="curSel" class="sel cur">${S.currencies.filter((c) => c.enabled).map((c) => `<option value="${c.code}">${c.code}</option>`).join('')}</select>`;
  const pages = S.pages || [];
  const pageLink = (slug) => { const p = pages.find((x) => x.slug === slug); return p ? `<li><a href="${ctx.href('/' + slug + '/')}">${esc(locPage(p, lang).title)}</a></li>` : ''; };
  const logo = S.store.logo ? `<img src="${esc(S.store.logo)}" alt="${esc(S.store.name)}">` : `<i></i>${esc(S.store.name.toUpperCase())}`;
  return `<!doctype html>
<html lang="${LOCALES[lang] || lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
<link rel="canonical" href="${esc(canon)}">
${noindex ? '' : alts.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(origin + ctx.url(path, l, true))}">`).join('\n')}
${noindex || !alts.includes(S.languages.default) ? '' : `<link rel="alternate" hreflang="x-default" href="${esc(origin + ctx.url(path, S.languages.default, true))}">`}
<meta property="og:type" content="${pageClass === 'page-pdp' ? 'product' : 'website'}">
<meta property="og:site_name" content="${esc(S.store.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canon)}">
<meta property="og:image" content="${esc(og)}">
<meta property="og:locale" content="${(LOCALES[lang] || lang).replace('-', '_')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0E0E0E">
<link rel="icon" href="${ctx.base}/assets/img/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="${ctx.base}/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,700..900&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap">
<link rel="stylesheet" href="${ctx.base}/assets/css/site.css?v=${ctx.v}">
${S.store.apiUrl ? `<link rel="preconnect" href="${esc(S.store.apiUrl)}" crossorigin>` : ''}
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n')}
<script src="${ctx.base}/assets/config.js?v=${ctx.v}"></script>
<script type="module" src="${ctx.base}/assets/js/app.js?v=${ctx.v}"></script>
${S.analytics?.ga4 ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(S.analytics.ga4)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${esc(S.analytics.ga4)}');</script>` : ''}
${S.analytics?.cloudflareToken ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${esc(S.analytics.cloudflareToken)}"}'></script>` : ''}
</head>
<body class="${pageClass}" data-lang="${lang}">
<a href="#main" class="sr-only">Skip to content</a>
${S.store.announcement ? `<div class="announce">${esc(S.store.announcement)}</div>` : ''}
<header class="hdr"><div class="wrap">
  <a class="logo" href="${ctx.href('/')}" aria-label="${esc(S.store.name)} home">${logo}</a>
  <nav class="nav" id="nav" aria-label="Main">
    <a href="${ctx.href('/products/')}"${navActive('/products/')}>${t(lang, 'shop')}</a>
    ${navTree(ctx, path)}
    <a href="${ctx.href('/size-guide/')}"${navActive('/size-guide/')}>${t(lang, 'sizeGuide')}</a>
    <a href="${ctx.href('/contact/')}"${navActive('/contact/')}>${t(lang, 'contact')}</a>
  </nav>
  <div class="tools">${langSel}${curSel}
    <a class="acctbtn" href="${ctx.href('/account/')}" aria-label="${t(lang, 'account')}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg><span data-acct-label>${t(lang, 'signIn')}</span></a>
    <a class="cartbtn" href="${ctx.href('/cart/')}" aria-label="${t(lang, 'cart')}"><span class="lbl">${t(lang, 'cart').toUpperCase()}</span><svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 7h14l-1.5 13h-11z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg> <span class="n" data-cart-count>0</span></a>
    <button class="burger" aria-label="Menu" aria-controls="nav" aria-expanded="false">☰</button>
  </div>
</div></header>
<main id="main">
${body}
</main>
<footer class="ftr"><div class="wrap">
  <div class="cols">
    <div><a class="logo" href="${ctx.href('/')}"><i></i>${esc(S.store.name.toUpperCase())}</a>
      <p class="note">${t(lang, 'footerNote')}</p>
      <p class="note mono" style="font-size:11px">${esc(S.store.email)}<br>${esc(S.store.phone)}${S.store.whatsapp ? `<br><a href="${esc(waLink(S))}" target="_blank" rel="noopener">WhatsApp ↗</a>` : ''}</p></div>
    <div><h4>${t(lang, 'shop')}</h4><ul>
      ${liveTree(ctx).map((d) => `<li><a href="${ctx.href('/collections/' + d.slug + '/')}">${esc(catName(d, lang))}</a></li>`).join('')}
      <li><a href="${ctx.href('/products/')}">${t(lang, 'allProducts')}</a></li>
      ${S.samples?.enabled !== false ? `<li><a href="${ctx.href('/sample-kit/')}">${t(lang, 'sampleKit')}</a></li>` : ''}
    </ul></div>
    <div><h4>${t(lang, 'company2')}</h4><ul>
      ${pageLink('about')}${pageLink('contact')}
      <li><a href="${ctx.href('/faq/')}">${t(lang, 'faq')}</a></li>
      <li><a href="${ctx.href('/size-guide/')}">${t(lang, 'sizeGuide')}</a></li>
    </ul></div>
    <div><h4>${t(lang, 'policies')}</h4><ul>
      ${pageLink('shipping-returns')}${pageLink('terms')}${pageLink('privacy')}
    </ul></div>
  </div>
  <svg class="bigword" viewBox="0 0 1000 150" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><text x="0" y="128" textLength="1000" lengthAdjust="spacingAndGlyphs">${esc(S.store.name.toUpperCase())}</text></svg>
  <div class="bottom"><span>© ${new Date().getFullYear()} ${esc(S.store.legalName || S.store.name)} · Made in India</span><span>${esc(S.store.domain)}</span></div>
</div></footer>
${S.store.whatsapp ? `<a class="wa-fab" href="${esc(waLink(S, waText || `${t(lang, 'waPage')}: ${canon}`))}" target="_blank" rel="noopener" aria-label="${t(lang, 'waChat')}">${WA_ICON}<span>${t(lang, 'waChat')}</span></a>` : ''}
<div class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
}

export function productCard(ctx, p0) {
  const { S, lang } = ctx;
  const p = locProduct(p0, lang);
  const minPrice = Math.min(p.price, ...(p.tiers || []).map((t) => t.price));
  return `<a class="card" href="${ctx.href('/products/' + p.slug + '/')}">
  <div class="media"><div class="word" aria-hidden="true">${esc((p.line || p.name).toUpperCase())}</div>${productImage(p)}
    <span class="pill code">${esc(p.code)}</span></div>
  <div class="body">
    <h3>${esc(p.name)}</h3>
    <div class="meta">${esc([p.fabric, p.gsm ? p.gsm + ' GSM' : ''].filter(Boolean).join(' · '))}</div>
    <div class="swatches" aria-label="${p.colors.length} ${t(lang, 'colours')}">${p.colors.slice(0, 16).map((c) => `<i style="background:${c.hex2 ? `linear-gradient(135deg,${c.hex} 60%,${c.hex2} 60%)` : c.hex}" title="${esc(c.name)}"></i>`).join('')}</div>
    <div class="foot"><div class="price"><small>${t(lang, 'from')}</small> ${priceSpan(minPrice, S)} <small>${t(lang, 'perPc')}</small></div>
      <span class="pill">${t(lang, 'moq')} ${p.moq}</span></div>
  </div></a>`;
}

export function sizeTable(chart) {
  if (!chart) return '';
  return `<div class="tablewrap"><table class="sizes"><caption class="sr-only">${esc(chart.title)} (${esc(chart.unit)})</caption>
  <thead><tr>${chart.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>${chart.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function faqBlock(items) {
  return `<div class="faq">${items.map((f) => `<details><summary>${esc(f.q)}</summary><div>${md(f.a)}</div></details>`).join('')}</div>`;
}

export function crumbs(ctx, trail) {
  return `<nav class="crumbs wrap" aria-label="Breadcrumb">${trail.map((c, i) => i === trail.length - 1
    ? `<span aria-current="page" style="margin:0">${esc(c.name)}</span>` : `<a href="${c.href}">${esc(c.name)}</a><span>/</span>`).join('')}</nav>`;
}

export { md, esc, plain, t, LANG_NAMES };

/** Category tree limited to categories that contain products (ctx.products). */
export function liveTree(ctx) {
  const cats = ctx.S.categories || [];
  const used = new Set(ctx.products.flatMap((p) => [...productCats(p, cats)]));
  return catTree(cats).filter((d) => used.has(d.slug)).map((d) => ({ ...d, children: d.children.filter((c) => used.has(c.slug)) }));
}
function navTree(ctx, path) {
  const { lang } = ctx;
  const cur = (slug) => (path === '/collections/' + slug + '/' ? ' aria-current="page"' : '');
  return liveTree(ctx).map((d) => {
    const top = `<a href="${ctx.href('/collections/' + d.slug + '/')}"${cur(d.slug)}>${esc(catName(d, lang))}</a>`;
    if (!d.children.length) return top;
    return `<div class="dd">${top}<div class="ddm">${d.children.map((c) => `<a href="${ctx.href('/collections/' + c.slug + '/')}"${cur(c.slug)}>${esc(catName(c, lang))}</a>`).join('')}<a class="all" href="${ctx.href('/collections/' + d.slug + '/')}">${t(lang, 'allIn', { name: catName(d, lang) })} →</a></div></div>`;
  }).join('');
}
