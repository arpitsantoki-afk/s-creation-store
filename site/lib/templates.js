import { esc, md, plain, garmentSVG } from './util.js';
import { t, LANG_NAMES, LOCALES } from './i18n.js';

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

export const productImage = (p, color, cls = '') => {
  const c = color || p.colors.find((c) => c.name === p.heroColor) || p.colors[0] || {};
  if (c.images?.length) return `<img src="${esc(c.images[0])}" alt="${esc(p.name)} in ${esc(c.name)}" loading="lazy" decoding="async" class="${cls}">`;
  return garmentSVG(p.type, c.hex, c.hex2, cls);
};

const priceSpan = (amount, S) => `<span data-price="${amount}">${esc(fmtBase(amount, S))}</span>`;
export const fmtBase = (v, S) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: S.baseCurrency, maximumFractionDigits: 0 }).format(v);

export function layout(ctx, { title, description, path, body, jsonld = [], alternates = null, canonical = null, noindex = false, ogImage = null, pageClass = '' }) {
  const { S, lang } = ctx;
  const site = S.store.siteUrl.replace(/\/$/, '');
  const canon = canonical || site + ctx.url(path, lang, true);
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
${noindex ? '' : alts.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(site + ctx.url(path, l, true))}">`).join('\n')}
${noindex || !alts.includes(S.languages.default) ? '' : `<link rel="alternate" hreflang="x-default" href="${esc(site + ctx.url(path, S.languages.default, true))}">`}
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
    ${(S.categories || []).map((c) => `<a href="${ctx.href('/collections/' + c.slug + '/')}"${navActive('/collections/' + c.slug + '/')}>${esc(c.i18n?.[lang] || c.name)}</a>`).join('')}
    <a href="${ctx.href('/size-guide/')}"${navActive('/size-guide/')}>${t(lang, 'sizeGuide')}</a>
    <a href="${ctx.href('/contact/')}"${navActive('/contact/')}>${t(lang, 'contact')}</a>
  </nav>
  <div class="tools">${langSel}${curSel}
    <a class="cartbtn" href="${ctx.href('/cart/')}">${t(lang, 'cart').toUpperCase()} <span class="n" data-cart-count>0</span></a>
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
      <p class="note mono" style="font-size:11px">${esc(S.store.email)}<br>${esc(S.store.phone)}</p></div>
    <div><h4>${t(lang, 'shop')}</h4><ul>
      ${ctx.products.map((p) => `<li><a href="${ctx.href('/products/' + p.slug + '/')}">${esc(locProduct(p, lang).name)}</a></li>`).join('')}
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
  <div class="bigword" aria-hidden="true">${esc(S.store.name.toUpperCase())}</div>
  <div class="bottom"><span>© ${new Date().getFullYear()} ${esc(S.store.legalName || S.store.name)} · Made in India</span><span>${esc(S.store.domain)}</span></div>
</div></footer>
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
