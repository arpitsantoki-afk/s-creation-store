#!/usr/bin/env node
/**
 * S Creation static site generator.
 *   node site/build.mjs                → builds ./dist from the live API (API_URL) or ./content (fallback)
 * Env:
 *   API_URL     Worker URL to pull published products + settings (e.g. https://api.screationindia.in)
 *   SITE_URL    Override canonical site URL
 *   BASE_PATH   Path prefix if served from a sub-path (e.g. /s-creation-store for a project page)
 *   FILE_LINKS=1  Link to …/index.html (for hosts without directory indexes)
 *   OUT         Output directory (default dist)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, liveTree, waLink, productCard, productImage, sizeTable, faqBlock, crumbs, locProduct, locPage, fmtBase, md, esc, plain, t } from './lib/templates.js';
import { garmentSVG, xml } from './lib/util.js';
import { convert, samplePrice } from '../shared/pricing.js';
import { catTree, productCats, catTrail, catName, catBySlug } from '../shared/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.OUT || 'dist');
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, '');
const FILE_LINKS = process.env.FILE_LINKS === '1';
const V = Date.now().toString(36);

async function readJSON(p) { return JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8')); }

async function loadData() {
  const api = process.env.API_URL;
  if (api) {
    try {
      const r = await fetch(api.replace(/\/$/, '') + '/api/export', { headers: { 'x-build': '1' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      console.log(`✓ Loaded ${d.products.length} products from ${api}`);
      return d;
    } catch (e) {
      if (process.env.REQUIRE_API === '1') throw e;
      console.warn(`! API unavailable (${e.message}); falling back to ./content`);
    }
  }
  const settings = await readJSON('content/settings.json');
  const products = (await readJSON('content/products.json')).filter((p) => p.status === 'published');
  let fx = await readJSON('content/fx-fallback.json');
  return { settings, products, fx };
}

async function write(rel, content) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d); else await fs.copyFile(s, d);
  }
}

const { settings: S, products: rawProducts, fx } = await loadData();
if (process.env.SITE_URL) S.store.siteUrl = process.env.SITE_URL;
if (process.env.PUBLIC_API_URL) S.store.apiUrl = process.env.PUBLIC_API_URL;
const products = [...rawProducts].sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99));
// Photos stored in the repo (site/static/uploads → /assets/uploads) always point at the current site URL,
// so they keep working after the switch from the github.io preview to screationindia.in.
const upl = (u) => { const i = String(u).indexOf('/assets/uploads/'); return i < 0 ? u : S.store.siteUrl.replace(/\/$/, '') + u.slice(i); };
// Photos optimised into the repo (scripts/optimize-images.mjs → content/photos.json) fill any colour that has none yet.
const repoPhotos = await readJSON('content/photos.json').catch(() => ({}));
for (const p of products) for (const c of p.colors || []) if (!c.images?.length && repoPhotos[p.id]?.[c.name]?.length) c.images = [...repoPhotos[p.id][c.name]];
for (const p of products) for (const c of p.colors || []) if (c.images) c.images = c.images.map(upl);
const langs = S.languages.enabled.length ? S.languages.enabled : ['en'];
const DEF = S.languages.default || 'en';

const pfx = (l) => (l === DEF ? '' : '/' + l);
/** url(): path as used in canonical/hreflang (always pretty). href(): link in pages (respects FILE_LINKS). */
function makeCtx(lang) {
  const ctx = {
    S, lang, langs, products, base: BASE, v: V, fx,
    url: (p, l = lang, abs = false) => BASE + pfx(l) + p,
    href: (p, l = lang) => {
      let u = BASE + pfx(l) + p;
      if (FILE_LINKS && u.endsWith('/')) u += 'index.html';
      return u;
    },
  };
  return ctx;
}
const outPath = (p, l) => (pfx(l) + p).replace(/^\//, '') + (p.endsWith('/') ? 'index.html' : '');
const sitemap = []; // {loc, alts:{lang:url}, lastmod, images}
const site = () => S.store.siteUrl.replace(/\/$/, ''); // site home (includes BASE_PATH on the github.io preview)
const origin = () => (BASE && site().endsWith(BASE) ? site().slice(0, -BASE.length) : site()); // + ctx.url()/BASE paths

function addSitemap(p, langsFor, images = []) {
  for (const l of langsFor) sitemap.push({ loc: origin() + BASE + pfx(l) + p, alts: Object.fromEntries(langsFor.map((x) => [x, origin() + BASE + pfx(x) + p])), images });
}

const orgLD = () => ({
  '@context': 'https://schema.org', '@type': 'Organization', '@id': site() + '/#org',
  name: S.store.name, url: site() + '/', email: S.store.email, telephone: S.store.phone,
  logo: S.store.logo ? (S.store.logo.startsWith('http') ? S.store.logo : site() + S.store.logo) : site() + '/assets/img/logo.png',
  address: S.store.address?.line1 ? { '@type': 'PostalAddress', streetAddress: S.store.address.line1, addressLocality: S.store.address.city, addressRegion: S.store.address.state, postalCode: S.store.address.postcode, addressCountry: S.store.address.country } : { '@type': 'PostalAddress', addressCountry: 'IN' },
  sameAs: Object.values(S.store.social || {}).filter(Boolean),
});
const breadcrumbLD = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: site() + it.url })) });
const faqLD = (items) => ({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: plain(f.a) } })) });
const absImg = (u) => (u.startsWith('http') ? u : site() + u);

// ---------- pages ----------
/** Hero: one slide per product line, photo + info card; swatches swap the colour in place. */
function heroSlides(ctx) {
  const { lang } = ctx;
  const withPhotos = products.filter((p) => p.colors.some((c) => c.images?.length));
  const total = `${products.length} STYLES · ${products.reduce((n, p) => n + p.colors.length, 0)} COLOURWAYS`;
  if (!withPhotos.length) return `<div class="hero-art" aria-hidden="true">
    <svg class="bigword" viewBox="0 0 1000 220" preserveAspectRatio="xMinYMin meet"><text x="0" y="190" textLength="1000" lengthAdjust="spacingAndGlyphs">${esc((products[0]?.line || 'S').toUpperCase())}</text></svg>
    <div class="stack">${products.slice(0, 3).map((p) => productImage(p)).join('')}</div><div class="tag">${total}</div></div>`;
  const slide = (p0, i) => {
    const p = locProduct(p0, lang);
    const cols = p.colors.filter((c) => c.images?.length);
    const c = cols.find((x) => x.name === p.heroColor) || cols[0];
    const href = ctx.href('/products/' + p.slug + '/');
    return `<article class="hs${i === 0 ? ' on' : ''}" role="group" aria-roledescription="slide" aria-label="${i + 1} / ${withPhotos.length}: ${esc(p.name)}"${i ? ' aria-hidden="true"' : ''}>
      <a class="hs-img" href="${href}" tabindex="-1">${productImage(p, c, '', { sizes: '(max-width: 900px) 100vw, 48vw', eager: i === 0 })}</a>
      <div class="hs-card">
        <div class="mono hs-code">${esc(p.code)} <span>/ ${String(withPhotos.length).padStart(2, '0')}</span></div>
        <h2 class="hs-name">${esc((p.line || p.name).toUpperCase())}</h2>
        <div class="hs-type">${esc(p.name.replace(p.line || '', '').trim() || p.type)}${p.gsm ? ` · ${p.gsm} GSM` : ''}</div>
        <div class="hs-sw" role="group" aria-label="${t(lang, 'colour')}">${cols.slice(0, 9).map((x) => `<button type="button" class="sw" style="--c:${x.hex};--c2:${x.hex2 || x.hex}" data-img="${esc(x.images[0])}" data-name="${esc(x.name)}" aria-pressed="${x === c}" title="${esc(x.name)}"></button>`).join('')}${cols.length > 9 ? `<a class="more mono" href="${href}">+${cols.length - 9}</a>` : ''}</div>
        <div class="hs-foot"><span class="mono hs-col">${esc(c.name)}</span><a class="btn sm accent" href="${href}">${t(lang, 'shop')} ${esc(p.line || p.name)} →</a></div>
      </div>
    </article>`;
  };
  return `<div class="hero-art hero-show" aria-roledescription="carousel" aria-label="${esc(S.store.name)}" data-hero>
    ${withPhotos.map(slide).join('')}
    <div class="tag">${total}</div>
    <div class="hs-nav"><button type="button" class="hs-arrow" data-dir="-1" aria-label="Previous">←</button>
      <div class="hs-bars">${withPhotos.map((p, i) => `<button type="button" data-go="${i}" aria-label="${esc(p.name)}"${i === 0 ? ' aria-current="true"' : ''}><i></i></button>`).join('')}</div>
      <button type="button" class="hs-arrow" data-dir="1" aria-label="Next">→</button></div>
  </div>`;
}

function home(ctx) {
  const { lang } = ctx;
  const minMoq = Math.min(...products.map((p) => p.moq || 50));
  const heroP = products.slice(0, 3);
  const body = `
<section class="hero"><div class="wrap">
  <div class="hero-copy">
    <div class="kicker mono">${t(lang, 'heroKicker')}</div>
    <h1>${t(lang, 'heroTitle')}</h1>
    <p>${t(lang, 'heroText', { moq: minMoq })}</p>
    <div class="hero-cta"><a class="btn accent" href="${ctx.href('/products/')}">${t(lang, 'shopCollection')} →</a><a class="btn ghost" href="#how">${t(lang, 'howItWorks')}</a></div>
  </div>
  ${heroSlides(ctx)}
</div></section>
<div class="strip wrap" style="padding:0">
  <div><b>${t(lang, 'why1')}</b><span>${t(lang, 'why1t')}</span></div>
  <div><b>${t(lang, 'why2')}</b><span>${t(lang, 'why2t')}</span></div>
  <div><b>${t(lang, 'why3')}</b><span>${t(lang, 'why3t')}</span></div>
  <div><b>${t(lang, 'why4')}</b><span>${t(lang, 'why4t')}</span></div>
</div>
${deptTiles(ctx)}
<section class="section"><div class="wrap">
  <div class="sec-head"><h2>${t(lang, 'allProducts')}</h2><a class="link mono" href="${ctx.href('/products/')}">${t(lang, 'shop')} →</a></div>
  <div class="grid">${products.map((p) => productCard(ctx, p)).join('')}</div>
</div></section>
${sampleSection(ctx)}
<section class="section alt" id="how"><div class="wrap">
  <div class="sec-head"><h2>${t(lang, 'howItWorks')}</h2></div>
  <ol class="steps">${[1, 2, 3, 4].map((n) => `<li><div class="n">0${n}</div><h3>${t(lang, 'step' + n)}</h3><p class="muted">${t(lang, 'step' + n + 't')}</p></li>`).join('')}</ol>
</div></section>
<section class="section"><div class="wrap">
  <div class="sec-head"><h2>${t(lang, 'faq')}</h2><a class="link mono" href="${ctx.href('/faq/')}">${t(lang, 'faq')} →</a></div>
  ${faqBlock((S.faqs || []).slice(0, 5))}
</div></section>
${ctaBand(ctx)}`;
  const ld = [orgLD(), { '@context': 'https://schema.org', '@type': 'WebSite', '@id': site() + '/#website', name: S.store.name, url: site() + '/', inLanguage: lang, publisher: { '@id': site() + '/#org' } },
    { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: origin() + ctx.url('/products/' + p.slug + '/') })) }];
  return layout(ctx, { title: S.seo.homeTitle, description: S.seo.homeDescription, path: '/', body, jsonld: ld, pageClass: 'home' });
}

const samplesOn = () => S.samples?.enabled !== false;
const ctaBand = (ctx) => `<section class="cta-band"><div class="wrap"><div><h2>${t(ctx.lang, 'sample')}</h2><p>${t(ctx.lang, 'sampleText')}</p></div>
  <div class="row" style="gap:10px;flex-wrap:wrap">${samplesOn() ? `<a class="btn" href="${ctx.href('/sample-kit/')}">${t(ctx.lang, 'buildKit')} →</a>` : ''}${S.store.whatsapp ? `<a class="btn ghost inv" href="${esc(waLink(S))}" target="_blank" rel="noopener">WhatsApp ↗</a>` : `<a class="btn ghost inv" href="${ctx.href('/contact/')}">${t(ctx.lang, 'getInTouch')} →</a>`}</div></div></section>`;

/** Products in a category (its sub-categories and extra memberships included). */
const inCategory = (slug) => products.filter((p) => productCats(p, S.categories).has(slug));
const catUrl = (ctx, c) => ctx.href('/collections/' + c.slug + '/');

function deptTiles(ctx) {
  const { lang } = ctx;
  const tree = liveTree(ctx);
  if (tree.length < 2) return '';
  return `<section class="section depts"><div class="wrap">
  <div class="sec-head"><h2>${t(lang, 'shopBy')}</h2></div>
  <div class="dgrid">${tree.map((d) => {
    const list = inCategory(d.slug), p = list[0];
    const c = p && (p.colors.find((x) => x.name === p.heroColor && x.images?.length) || p.colors.find((x) => x.images?.length));
    return `<a class="dtile" href="${catUrl(ctx, d)}"><div class="dimg">${c ? productImage(p, c, '', { sizes: '(max-width: 700px) 50vw, 25vw' }) : ''}</div>
      <div class="dtxt"><h3>${esc(catName(d, lang))}</h3><span class="mono muted">${list.length} ${t(lang, list.length === 1 ? 'style' : 'styles')}${d.children.length ? ' · ' + d.children.map((x) => esc(catName(x, lang))).join(' · ') : ''}</span></div></a>`;
  }).join('')}</div></div></section>`;
}

function sampleSection(ctx) {
  if (!samplesOn()) return '';
  const { lang } = ctx;
  const sm = S.samples || {}, n = sm.maxPieces || 5;
  const minMoq = Math.min(...products.map((p) => p.moq || 50));
  const from = Math.min(...products.map((p) => samplePrice(p, S)));
  return `<section class="section samplekit" id="sample-kit"><div class="wrap">
  <div class="sk-grid">
    <div class="sk-copy"><div class="kicker mono">${t(lang, 'sampleKit')}</div>
      <h2>${esc(sm.title || t(lang, 'sampleKitTitle'))}</h2>
      <p>${esc(sm.text || t(lang, 'sampleHint', { n }))}</p>
      <div class="sk-price"><span class="mono muted">${t(lang, 'from')}</span> <b><span data-price="${from}">${fmtBase(from, S)}</span></b> <span class="muted">${t(lang, 'samplePerPc')}</span></div>
      <div class="row" style="gap:10px;flex-wrap:wrap"><a class="btn accent" href="${ctx.href('/sample-kit/')}">${t(lang, 'buildKit')} →</a>${S.store.whatsapp ? `<a class="btn ghost" href="${esc(waLink(S, t(lang, 'sampleKitTitle')))}" target="_blank" rel="noopener">${t(lang, 'askWa')} ↗</a>` : ''}</div></div>
    <ol class="sk-steps">
      <li><span class="n mono">01</span><div><b>${t(lang, 'sampleStep1', { n })}</b><p class="muted">${t(lang, 'sampleStep1t')}</p></div></li>
      <li><span class="n mono">02</span><div><b>${t(lang, 'sampleStep2')}</b><p class="muted">${t(lang, 'sampleStep2t')}${sm.dispatchDays ? ' ' + t(lang, 'dispatch', { d: esc(sm.dispatchDays) }) + '.' : ''}</p></div></li>
      <li><span class="n mono">03</span><div><b>${t(lang, 'sampleStep3')}</b><p class="muted">${t(lang, 'sampleStep3t', { moq: minMoq })}</p></div></li>
    </ol>
  </div></div></section>`;
}

function sampleKitPage(ctx) {
  const { lang } = ctx;
  const sm = S.samples || {}, n = sm.maxPieces || 5;
  const pth = '/sample-kit/';
  const title = sm.title || t(lang, 'sampleKitTitle');
  const rows = products.map((p0) => {
    const p = locProduct(p0, lang);
    const cols = p.colors;
    const c = cols.find((x) => x.name === p.heroColor) || cols[0];
    const sp = samplePrice(p0, S);
    return `<article class="skrow" data-skp="${esc(p.id)}">
      <a class="skimg" href="${ctx.href('/products/' + p.slug + '/')}" data-skimg>${productImage(p, c, '', { sizes: '120px' })}</a>
      <div class="skinfo"><div class="mono muted">${esc(p.code)}</div><h3><a href="${ctx.href('/products/' + p.slug + '/')}">${esc(p.name)}</a></h3>
        <div class="muted" style="font-size:13px">${esc([p.fabric, p.gsm ? p.gsm + ' GSM' : ''].filter(Boolean).join(' · '))}</div>
        <div class="skprice"><b><span data-price="${sp}">${fmtBase(sp, S)}</span></b> <small class="muted">${t(lang, 'samplePerPc')}</small></div></div>
      <div class="skpick">
        <label class="f">${t(lang, 'colour')}<select class="i" data-skc>${cols.map((x) => `<option value="${esc(x.name)}" data-img="${esc(x.images?.[0] || '')}"${x === c ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="f">${t(lang, 'size')}<select class="i" data-sks>${p.sizes.map((z) => `<option>${esc(z)}</option>`).join('')}</select></label>
        <label class="f">${t(lang, 'qty')}<select class="i" data-skq>${Array.from({ length: n }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></label>
        <button type="button" class="btn sm accent" data-skadd>${t(lang, 'addSample')}</button>
      </div></article>`;
  }).join('');
  const body = `${crumbs(ctx, [{ name: t(lang, 'home'), href: ctx.href('/') }, { name: t(lang, 'sampleKit') }])}
<section class="wrap" style="padding-bottom:80px" data-samplekit data-max="${n}">
  <div class="sec-head"><div><h1 style="margin:0 0 8px">${esc(title)}</h1><p class="muted" style="max-width:60ch;margin:0">${esc(sm.text || t(lang, 'sampleHint', { n }))}</p></div></div>
  <div class="skwrap"><div class="sklist">${rows}</div>
    <aside class="summary skbox"><h2 style="font-size:20px">${t(lang, 'yourKit')}</h2>
      <div class="kitbar"><i data-kitbar></i></div><p class="mono" data-kitcount>${t(lang, 'kitPieces', { k: 0, n })}</p>
      <div data-kitlist class="mixlist"></div>
      <a class="btn accent block" href="${ctx.href('/cart/')}">${t(lang, 'cart')} →</a>
      ${sm.dispatchDays ? `<p class="muted" style="font-size:13px;margin-top:12px">${t(lang, 'dispatch', { d: esc(sm.dispatchDays) })}</p>` : ''}</aside></div>
</section>${ctaBand(ctx)}`;
  return layout(ctx, { title: title + S.seo.titleSuffix, description: `${title}: ${esc(sm.text || '')}`.slice(0, 160), path: pth, body, waText: title,
    jsonld: [breadcrumbLD([{ name: t(lang, 'home'), url: ctx.url('/') }, { name: t(lang, 'sampleKit'), url: ctx.url(pth) }])] });
}

function listing(ctx, cat = null) {
  const { lang } = ctx;
  const list = cat ? inCategory(cat.slug) : products;
  const trail = cat ? catTrail(cat.slug, S.categories) : [];
  const dept = trail[0];
  const title = cat ? (dept && dept !== cat ? `${catName(dept, lang)} › ${catName(cat, lang)}` : catName(cat, lang)) : t(lang, 'allProducts');
  const h1 = cat ? (dept && dept !== cat ? `${catName(dept, lang)} ${catName(cat, lang)}` : catName(cat, lang)) : t(lang, 'allProducts');
  const pth = cat ? `/collections/${cat.slug}/` : '/products/';
  const tree = liveTree(ctx);
  const subs = dept ? (tree.find((d) => d.slug === dept.slug)?.children || []) : [];
  const crumbTrail = [{ name: t(lang, 'home'), href: ctx.href('/'), url: ctx.url('/') }, ...(cat ? [] : [{ name: title }]),
    ...trail.map((c, i) => ({ name: catName(c, lang), ...(i < trail.length - 1 ? { href: catUrl(ctx, c) } : {}), url: ctx.url('/collections/' + c.slug + '/') }))];
  const body = `${crumbs(ctx, crumbTrail)}
<section class="wrap" style="padding-bottom:80px">
  <div class="sec-head"><div><h1 style="margin:0">${esc(h1)}</h1>${cat?.intro ? `<p class="muted" style="max-width:62ch;margin:10px 0 0">${esc(cat.intro)}</p>` : ''}</div>
    <div class="filters"><a class="pill" href="${ctx.href('/products/')}" aria-current="${!cat}">${t(lang, 'allProducts')}</a>
    ${tree.map((d) => `<a class="pill" href="${catUrl(ctx, d)}" aria-current="${dept?.slug === d.slug}">${esc(catName(d, lang))}</a>`).join('')}</div></div>
  ${subs.length > 1 ? `<div class="filters sub"><a class="pill" href="${catUrl(ctx, dept)}" aria-current="${cat?.slug === dept.slug}">${t(lang, 'allIn', { name: catName(dept, lang) })}</a>${subs.map((c) => `<a class="pill" href="${catUrl(ctx, c)}" aria-current="${cat?.slug === c.slug}">${esc(catName(c, lang))}</a>`).join('')}</div>` : ''}
  <div class="grid">${list.map((p) => productCard(ctx, p)).join('')}</div>
</section>${ctaBand(ctx)}`;
  const desc = cat ? (cat.intro || `${h1} by ${S.store.name}: ${list.map((p) => p.name).join(', ')}.`) + ` Order from ${Math.min(...list.map((p) => p.moq))} pcs, mix sizes and colours, worldwide shipping.` : S.seo.homeDescription;
  return layout(ctx, { title: title + S.seo.titleSuffix, description: desc.slice(0, 300), path: pth, body,
    jsonld: [breadcrumbLD(crumbTrail.filter((c) => c.url).map((c) => ({ name: c.name, url: c.url }))),
      { '@context': 'https://schema.org', '@type': 'CollectionPage', name: h1, url: origin() + ctx.url(pth), mainEntity: { '@type': 'ItemList', itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: origin() + ctx.url('/products/' + p.slug + '/'), name: p.name })) } }] });
}

function productPage(ctx, p0) {
  const { lang } = ctx;
  const p = locProduct(p0, lang);
  const hero = p.colors.find((c) => c.name === p.heroColor) || p.colors[0];
  const chart = S.sizeCharts?.[p.sizeChart];
  const care = S.care?.[p.careKey] || S.care?.cotton || [];
  const faqs = [...(p.faqs || []), ...(S.faqs || []).slice(0, 4)];
  const pth = `/products/${p.slug}/`;
  const minPrice = Math.min(p.price, ...(p.tiers || []).map((x) => x.price));
  const tiers = [{ min: p.moq, price: p.price }, ...(p.tiers || [])].sort((a, b) => a.min - b.min);
  const allImgs = p.colors.flatMap((c) => c.images || []);
  const pdata = { id: p.id, code: p.code, slug: p.slug, name: p.name, type: p.type, moq: p.moq, price: p.price, tiers: p.tiers || [],
    sizes: p.sizes, colors: p.colors.map((c) => ({ name: c.name, hex: c.hex, hex2: c.hex2 || null, images: c.images || [] })), hero: hero?.name };
  const sections = [['overview', t(lang, 'overview')], ['use-cases', t(lang, 'useCases')], ['specs', t(lang, 'specifications')],
    ['sizes', t(lang, 'sizeGuide')], ['care', t(lang, 'care')], ['faq', t(lang, 'faqs')]];

  const ptrail = catTrail(p.category, S.categories).map((c) => ({ name: catName(c, lang), href: catUrl(ctx, c), url: ctx.url('/collections/' + c.slug + '/') }));
  const pcrumbs = [{ name: t(lang, 'home'), href: ctx.href('/'), url: ctx.url('/') }, ...(ptrail.length ? ptrail : [{ name: t(lang, 'products'), href: ctx.href('/products/'), url: ctx.url('/products/') }]), { name: p.name, url: ctx.url(pth) }];
  const sp = samplePrice(p0, S), smax = S.samples?.maxPieces || 5;
  const body = `${crumbs(ctx, pcrumbs.map(({ name, href }, i) => (i === pcrumbs.length - 1 ? { name } : { name, href })))}
<div class="pdp" data-product>
  <div class="gallery">
    <div class="main"><div class="word" aria-hidden="true">${esc((p.line || p.name).toUpperCase())}</div>
      <div data-main>${productImage(p, hero, '', { sizes: '(max-width: 980px) 92vw, 50vw', eager: true })}</div>
      <span class="pill lime shown" data-shown>${t(lang, 'shownIn')} — ${esc(hero?.name || '')}</span></div>
    <div class="thumbs" data-thumbs></div>
  </div>
  <div class="buy"><div class="sticky">
    <div class="code mono muted">${esc(p.code)} · ${esc([p.gender, p.sleeve].filter(Boolean).join(' · '))}</div>
    <h1>${esc(p.line || p.name)}</h1>
    <div class="type">${esc(p.name.replace(p.line || '', '').trim() || p.type)}</div>
    <p class="tagline">${esc(p.tagline || p.short)}</p>
    <div class="gsm"><div class="num">${p.gsm || ''}</div><div class="lbl"><div class="mono">GSM</div><div>${esc(p.fabric)}</div></div></div>
    <div class="pricebox"><div class="price" data-unit>${t(lang, 'from')} <span data-price="${minPrice}">${fmtBase(minPrice, S)}</span> <small>${t(lang, 'perPc')}</small></div>
      <span class="pill">${t(lang, 'moq')} ${p.moq} ${t(lang, 'pcs')}</span></div>
    <table class="tiers"><thead><tr><th>${t(lang, 'qty')}</th><th>${t(lang, 'unitPrice')}</th></tr></thead><tbody>
      ${tiers.map((x, i) => `<tr data-tier="${x.min}"><td>${x.min}${tiers[i + 1] ? '–' + (tiers[i + 1].min - 1) : '+'} ${t(lang, 'pcs')}</td><td><span data-price="${x.price}">${fmtBase(x.price, S)}</span></td></tr>`).join('')}
    </tbody></table>
    <h2 class="mono" style="font-size:12px;margin:0 0 4px">${t(lang, 'buildOrder')}</h2>
    <p class="muted" style="font-size:13px;margin:0">${t(lang, 'buildOrderHint')}</p>
    <div class="swatchrow" role="group" aria-label="${t(lang, 'colour')}" data-swatches>
      ${p.colors.map((c) => `<button type="button" class="sw" style="background:${c.hex2 ? `linear-gradient(135deg,${c.hex} 60%,${c.hex2} 60%)` : c.hex}" data-color="${esc(c.name)}" aria-pressed="${c.name === hero?.name}" title="${esc(c.name)}"><span class="sr-only">${esc(c.name)}</span></button>`).join('')}
    </div>
    <div class="colname">${t(lang, 'colour')}: <span data-colname>${esc(hero?.name || '')}</span></div>
    <div class="matrix" data-matrix>${p.sizes.map((s) => `<label><span>${esc(s)}</span><input type="number" min="0" step="1" inputmode="numeric" data-size="${esc(s)}" aria-label="${esc(s)} ${t(lang, 'qty')}" placeholder="0"></label>`).join('')}</div>
    <div class="progress" data-progress><i style="width:0"></i></div>
    <div class="moqline"><span><b data-total>0</b> / ${p.moq} ${t(lang, 'pcs')}</span><span data-moqmsg class="muted">${p.moq} ${t(lang, 'toGo')}</span></div>
    <div class="mixlist" data-mix></div>
    <div class="subtotal"><span>${t(lang, 'subtotal')}</span><b data-subtotal>—</b></div>
    <button class="btn accent block" data-add disabled>${t(lang, 'addToCart')}</button>
    ${samplesOn() ? `<div class="samplebox" data-sample>
      <div class="sb-head"><b>${t(lang, 'orderSample', { moq: p.moq })}</b><span><span data-price="${sp}">${fmtBase(sp, S)}</span> <small class="muted">${t(lang, 'samplePerPc')}</small></span></div>
      <p class="muted">${t(lang, 'sampleHint', { n: smax })}</p>
      <div class="sb-pick"><span class="mono sb-col" data-sbcol>${esc(hero?.name || '')}</span>
        <label class="sr-only" for="sbsize">${t(lang, 'size')}</label><select class="i" id="sbsize" data-sbsize>${p.sizes.map((z) => `<option>${esc(z)}</option>`).join('')}</select>
        <button type="button" class="btn sm" data-sbadd>${t(lang, 'addSample')}</button></div>
      <a class="link mono" href="${ctx.href('/sample-kit/')}" style="font-size:12px">${t(lang, 'buildKit')} →</a></div>` : ''}
    ${S.store.whatsapp ? `<a class="wa-inline" href="${esc(waLink(S, `${t(lang, 'waProduct')} ${p.name} (${p.code}) — ${origin() + ctx.url(pth)}`))}" target="_blank" rel="noopener">${t(lang, 'askWa')} ↗</a>` : ''}
    <div class="trust"><div>${t(lang, 'why1')}</div><div>${t(lang, 'why3')}</div><div>${t(lang, 'leadTime')}: ${esc(p.leadTime || '')}</div><div>${t(lang, 'why4')}</div></div>
  </div></div>
</div>
<nav class="subnav" aria-label="Product sections"><div class="wrap">${sections.map(([id, n]) => `<a href="#${id}">${esc(n)}</a>`).join('')}</div></nav>
<div class="wrap">
  <section class="pblock" id="overview"><h2>${t(lang, 'overview')}</h2><div>
    <div class="prose">${md(p.description)}</div>
    ${p.impact?.length ? `<div class="impact" aria-label="${t(lang, 'impact')}">${p.impact.map((x) => `<div><b>${esc(x.value)}</b>${esc(x.label)}</div>`).join('')}</div>` : ''}
    ${p.highlights?.length ? `<div class="hl">${p.highlights.map((h, i) => `<div><div class="no">${String(i + 1).padStart(2, '0')}</div><b>${esc(h.title)}</b><span>${esc(h.text)}</span></div>`).join('')}</div>` : ''}
  </div></section>
  ${p.useCases?.length ? `<section class="pblock" id="use-cases"><h2>${t(lang, 'useCases')}</h2>
    <div class="uses">${p.useCases.map((u, i) => `<article><div class="no">${String(i + 1).padStart(2, '0')}</div><h3>${esc(u.title)}</h3><p>${esc(u.text)}</p></article>`).join('')}</div></section>` : ''}
  <section class="pblock" id="specs"><h2>${t(lang, 'specifications')}</h2><div>
    <table class="spec"><tbody>${(p.specs || []).map((s) => `<tr><th scope="row">${esc(s.label)}</th><td>${esc(s.value)}</td></tr>`).join('')}
      <tr><th scope="row">${t(lang, 'colours')}</th><td>${p.colors.length}: ${esc(p.colors.map((c) => c.name).join(', '))}</td></tr>
      <tr><th scope="row">${t(lang, 'moq')}</th><td>${p.moq} ${t(lang, 'pcs')} — ${t(lang, 'why1t')}</td></tr>
      ${p.leadTime ? `<tr><th scope="row">${t(lang, 'leadTime')}</th><td>${esc(p.leadTime)}</td></tr>` : ''}
      ${p.weightG ? `<tr><th scope="row">${t(lang, 'weight')}</th><td>${p.weightG} g / pc</td></tr>` : ''}
      ${p.hsCode ? `<tr><th scope="row">${t(lang, 'hsCode')}</th><td>${esc(p.hsCode)}</td></tr>` : ''}
    </tbody></table>
    ${p.features?.length ? `<h3 style="margin-top:36px">${t(lang, 'features')}</h3><ul class="ticks">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  </div></section>
  <section class="pblock" id="sizes"><h2>${t(lang, 'sizeGuide')}</h2><div>
    ${chart ? `${sizeTable(chart)}<p class="muted" style="margin-top:12px;font-size:14px">${esc(S.sizeNote || '')}</p>` : `<p class="muted">${t(lang, 'sizeChartSoon')}</p>`}
  </div></section>
  <section class="pblock" id="care"><h2>${t(lang, 'care')}</h2><div><ul class="ticks">${care.map((c) => `<li>${esc(c)}</li>`).join('')}<li>Made in India</li></ul></div></section>
  <section class="pblock" id="faq"><h2>${t(lang, 'faqs')}</h2><div>${faqBlock(faqs)}</div></section>
</div>
<section class="section"><div class="wrap"><div class="sec-head"><h2>${t(lang, 'related')}</h2></div>
  <div class="grid">${products.filter((x) => x.id !== p.id).sort((a, b) => (b.category === p.category) - (a.category === p.category) || (productCats(b, S.categories).has(catTrail(p.category, S.categories)[0]?.slug) - productCats(a, S.categories).has(catTrail(p.category, S.categories)[0]?.slug))).slice(0, 3).map((x) => productCard(ctx, x)).join('')}</div></div></section>
<script type="application/json" id="pdata">${JSON.stringify(pdata).replace(/</g, '\\u003c')}</script>`;

  const images = allImgs.length ? allImgs.map(absImg) : [site() + `/assets/img/p/${p.slug}.svg`];
  const offerFor = (cur) => {
    const price = convert(minPrice, cur, S, fx);
    return price == null ? null : {
      '@type': 'Offer', url: origin() + ctx.url(pth), priceCurrency: cur, price,
      availability: 'https://schema.org/MadeToOrder', itemCondition: 'https://schema.org/NewCondition',
      eligibleQuantity: { '@type': 'QuantitativeValue', minValue: p.moq, unitCode: 'C62' },
      priceSpecification: tiers.map((x) => ({ '@type': 'UnitPriceSpecification', price: convert(x.price, cur, S, fx), priceCurrency: cur, eligibleQuantity: { '@type': 'QuantitativeValue', minValue: x.min, unitCode: 'C62' } })),
      seller: { '@id': site() + '/#org' },
    };
  };
  const productLD = {
    '@context': 'https://schema.org', '@type': 'ProductGroup', '@id': origin() + ctx.url(pth) + '#product',
    name: p.name, description: plain(p.short + ' ' + p.description), url: origin() + ctx.url(pth), productGroupID: p.code, sku: p.code,
    brand: { '@type': 'Brand', name: S.store.name }, manufacturer: { '@id': site() + '/#org' }, material: p.fabric, image: images,
    category: 'Apparel & Accessories > Clothing > Shirts & Tops', countryOfOrigin: 'IN', inLanguage: lang,
    variesBy: ['https://schema.org/color', 'https://schema.org/size'],
    additionalProperty: (p.specs || []).map((s) => ({ '@type': 'PropertyValue', name: s.label, value: s.value })),
    hasVariant: p.colors.map((c) => ({ '@type': 'Product', name: `${p.name} – ${c.name}`, sku: `${p.code}-${c.name.replace(/[^A-Za-z0-9]+/g, '').toUpperCase()}`, color: c.name, image: c.images?.length ? c.images.map(absImg) : images[0], offers: offerFor(S.baseCurrency) })),
    offers: { '@type': 'AggregateOffer', priceCurrency: S.baseCurrency, lowPrice: minPrice, highPrice: p.price, offerCount: p.colors.length * p.sizes.length, offers: S.currencies.filter((c) => c.enabled).map((c) => offerFor(c.code)).filter(Boolean) },
  };
  const ld = [productLD, breadcrumbLD(pcrumbs.map(({ name, url }) => ({ name, url }))), faqLD(faqs)];
  const avail = langs.filter((l) => l === DEF || p0.i18n?.[l]);
  return layout(ctx, { waText: `${t(lang, 'waProduct')} ${p.name} (${p.code})`,
    title: p.seo?.title || p.name + S.seo.titleSuffix, description: p.seo?.description || p.short, path: pth, body, jsonld: ld, pageClass: 'page-pdp',
    alternates: avail, canonical: p._translated ? null : origin() + ctx.url(pth, DEF), ogImage: allImgs[0] || `/assets/img/p/${p.slug}.svg`,
  });
}

function sizeGuide(ctx) {
  const { lang } = ctx;
  const body = `${crumbs(ctx, [{ name: t(lang, 'home'), href: ctx.href('/') }, { name: t(lang, 'sizeGuide') }])}
<div class="wrap" style="padding-bottom:80px"><h1>${t(lang, 'sizeGuide')}</h1><p class="muted">${esc(S.sizeNote || '')}</p>
${Object.entries(S.sizeCharts || {}).map(([k, c]) => `<section class="pblock" id="${k}"><h2>${esc(c.title)}</h2><div>${sizeTable(c)}<p class="muted mono" style="margin-top:10px">${esc(c.unit === 'in' ? 'Inches' : c.unit)}</p></div></section>`).join('')}</div>`;
  return layout(ctx, { title: t(lang, 'sizeGuide') + S.seo.titleSuffix, description: `${S.store.name} size charts for polos, T-shirts, hoodies, jackets and trousers. ${S.sizeNote || ''}`, path: '/size-guide/', body,
    jsonld: [breadcrumbLD([{ name: t(lang, 'home'), url: ctx.url('/') }, { name: t(lang, 'sizeGuide'), url: ctx.url('/size-guide/') }])] });
}

function faqPage(ctx) {
  const { lang } = ctx;
  const body = `${crumbs(ctx, [{ name: t(lang, 'home'), href: ctx.href('/') }, { name: t(lang, 'faq') }])}
<div class="wrap" style="padding-bottom:80px;max-width:960px"><h1>${t(lang, 'faq')}</h1>${faqBlock(S.faqs || [])}</div>${ctaBand(ctx)}`;
  return layout(ctx, { title: t(lang, 'faq') + S.seo.titleSuffix, description: `Answers about minimum order quantities, mixing sizes and colours, volume pricing, currencies, DHL Express shipping and duties at ${S.store.name}.`, path: '/faq/', body, jsonld: [faqLD(S.faqs || [])] });
}

function contentPage(ctx, pg0) {
  const { lang } = ctx;
  const pg = locPage(pg0, lang);
  const pth = `/${pg.slug}/`;
  const isContact = pg.slug === 'contact';
  const form = isContact ? `<form class="form fieldset" data-contact style="margin-top:28px">
    <div class="two"><label>${t(lang, 'name')}<input name="name" required autocomplete="name"></label><label>${t(lang, 'email')}<input type="email" name="email" required autocomplete="email"></label></div>
    <div class="two"><label>${t(lang, 'company')}<input name="company" autocomplete="organization"></label><label>${t(lang, 'phone')}<input name="phone" autocomplete="tel"></label></div>
    <label>${t(lang, 'message')}<textarea name="message" required></textarea></label>
    <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <button class="btn">${t(lang, 'sendMessage')}</button><div data-msg></div></form>` : '';
  const body = `${crumbs(ctx, [{ name: t(lang, 'home'), href: ctx.href('/') }, { name: pg.title }])}
<div class="wrap" style="padding-bottom:80px;max-width:900px"><h1>${esc(pg.title)}</h1><div class="prose">${md(pg.body)}</div>${form}</div>`;
  const avail = langs.filter((l) => l === DEF || pg0.i18n?.[l]);
  return layout(ctx, { title: pg.title + S.seo.titleSuffix, description: plain(pg.body).slice(0, 155), path: pth, body, alternates: avail,
    canonical: pg._translated ? null : origin() + ctx.url(pth, DEF), noindex: /\[add /i.test(pg0.body) });
}

function appPage(ctx, kind) {
  const { lang } = ctx;
  const titles = { cart: t(lang, 'yourCart'), checkout: t(lang, 'checkout'), order: t(lang, 'orderNumber'), account: t(lang, 'account') };
  const body = `<div class="page-head"><div class="wrap"><h1>${titles[kind]}</h1></div></div><div class="wrap" data-app="${kind}"><div class="empty muted">…</div></div>`;
  return layout(ctx, { title: titles[kind] + S.seo.titleSuffix, description: S.seo.homeDescription, path: `/${kind}/`, body, noindex: true, pageClass: 'app' });
}

function notFound(ctx) {
  const body = `<div class="wrap empty"><div class="display" style="font-size:clamp(96px,20vw,220px)">404</div><h1 style="font-size:32px">${t(ctx.lang, 'notFound')}</h1><p class="muted">${t(ctx.lang, 'notFoundText')}</p><a class="btn accent" href="${ctx.href('/products/')}">${t(ctx.lang, 'shopCollection')}</a></div>`;
  return layout(ctx, { title: t(ctx.lang, 'notFound') + S.seo.titleSuffix, description: '', path: '/404.html', body, noindex: true });
}

// ---------- machine-readable outputs ----------
function sitemapXML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${sitemap.map((u) => `<url><loc>${xml(u.loc)}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>${Object.keys(u.alts).length > 1 ? Object.entries(u.alts).map(([l, h]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${xml(h)}"/>`).join('') : ''}${u.images.map((i) => `<image:image><image:loc>${xml(i)}</image:loc></image:image>`).join('')}</url>`).join('\n')}
</urlset>`;
}

function robots() {
  // Explicitly welcome search and AI crawlers so the catalogue can be cited by AI assistants.
  const bots = ['Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot', 'Applebot-Extended', 'CCBot', 'DuckAssistBot', 'meta-externalagent'];
  return `# ${S.store.name} — crawlers welcome\n${bots.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /admin/\nDisallow: /cart/\nDisallow: /checkout/\nDisallow: /order/\nDisallow: /account/\n`).join('\n')}
User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /cart/\nDisallow: /checkout/\nDisallow: /order/\nDisallow: /account/\n\nSitemap: ${site()}${BASE}/sitemap.xml\n`;
}

function llmsTxt(full = false) {
  const ctx = makeCtx(DEF);
  const lines = [`# ${S.store.name}`, '', `> ${S.store.tagline} Bulk ordering from ${Math.min(...products.map((p) => p.moq))} pieces per style with any mix of sizes and colours, multi-currency checkout (Stripe, PayPal) and worldwide shipping by DHL Express.`, '',
    `- Website: ${site()}`, `- Email: ${S.store.email}`, `- Phone: ${S.store.phone}`, `- Base currency: ${S.baseCurrency}; also priced in ${S.currencies.filter((c) => c.enabled && c.code !== S.baseCurrency).map((c) => c.code).join(', ')}`,
    `- Machine-readable catalogue: ${site()}${BASE}/catalog.json`, '', '## Products', ''];
  for (const p of products) {
    lines.push(`- [${p.name}](${site()}${ctx.url('/products/' + p.slug + '/')}): ${p.short} MOQ ${p.moq} pcs. From ${fmtBase(Math.min(p.price, ...(p.tiers || []).map((x) => x.price)), S)}/pc. Colours: ${p.colors.length}. Sizes: ${p.sizes[0]}–${p.sizes.at(-1)}.`);
    if (full) {
      lines.push('', `### ${p.name} (${p.code})`, '', plain(p.description), '', '**Specifications**', ...(p.specs || []).map((s) => `- ${s.label}: ${s.value}`),
        `- Colours: ${p.colors.map((c) => c.name).join(', ')}`, `- Sizes: ${p.sizes.join(', ')}`, `- Minimum order: ${p.moq} pcs (sizes and colours can be mixed)`,
        `- Price per piece (${S.baseCurrency}): ${[{ min: p.moq, price: p.price }, ...(p.tiers || [])].map((x) => `${x.min}+ pcs: ${x.price}`).join('; ')}`,
        '', '**Use cases**', ...(p.useCases || []).map((u) => `- ${u.title}: ${u.text}`), '');
    }
  }
  lines.push('', '## Ordering', '', ...(S.faqs || []).map((f) => `- ${f.q} ${plain(f.a)}`), '', '## Pages', '',
    `- [All products](${site()}${ctx.url('/products/')})`, `- [Size guide](${site()}${ctx.url('/size-guide/')})`, `- [FAQ](${site()}${ctx.url('/faq/')})`,
    ...(S.pages || []).map((pg) => `- [${pg.title}](${site()}${ctx.url('/' + pg.slug + '/')})`));
  if (!full) lines.push('', '## Optional', '', `- [Full product details](${site()}${BASE}/llms-full.txt)`);
  return lines.join('\n') + '\n';
}

function catalogJSON() {
  return JSON.stringify({
    store: { name: S.store.name, url: site(), email: S.store.email, baseCurrency: S.baseCurrency },
    generated: new Date().toISOString(),
    products: products.map((p) => ({
      id: p.id, code: p.code, slug: p.slug, url: origin() + BASE + '/products/' + p.slug + '/', name: p.name, line: p.line, type: p.type, category: p.category, categories: [...productCats(p, S.categories)], samplePrice: samplePrice(p, S),
      short: p.short, fabric: p.fabric, gsm: p.gsm, moq: p.moq, price: p.price, tiers: p.tiers || [], weightG: p.weightG,
      sizes: p.sizes, colors: p.colors.map((c) => ({ name: c.name, hex: c.hex, hex2: c.hex2 || null, image: c.images?.[0] || null })),
      specs: p.specs, leadTime: p.leadTime, i18n: Object.fromEntries(Object.entries(p.i18n || {}).map(([l, v]) => [l, { name: v.name }])),
    })),
  });
}

function merchantFeed(cur) {
  const ctx = makeCtx(DEF);
  const items = [];
  for (const p of products) for (const c of p.colors) {
    const price = convert(p.price, cur, S, fx);
    if (price == null) continue;
    items.push(`<item>
<g:id>${xml(p.code + '-' + c.name.replace(/[^A-Za-z0-9]+/g, ''))}</g:id><g:item_group_id>${xml(p.code)}</g:item_group_id>
<g:title>${xml(`${p.name} – ${c.name}`)}</g:title><g:description>${xml(plain(p.short + ' ' + p.description))}</g:description>
<g:link>${xml(origin() + ctx.url('/products/' + p.slug + '/'))}</g:link>
<g:image_link>${xml(c.images?.[0] ? absImg(c.images[0]) : site() + `/assets/img/p/${p.slug}.svg`)}</g:image_link>
<g:availability>in_stock</g:availability><g:price>${price} ${cur}</g:price><g:condition>new</g:condition><g:brand>${xml(S.store.name)}</g:brand>
<g:color>${xml(c.name)}</g:color><g:material>${xml(p.fabric)}</g:material><g:gender>${/women/i.test(p.gender) ? 'female' : /men/i.test(p.gender) ? 'male' : 'unisex'}</g:gender><g:age_group>adult</g:age_group>
<g:size>${xml(p.sizes.join('/'))}</g:size><g:google_product_category>${xml(catTrail(p.category, S.categories).reverse().find((c) => c.google)?.google || '212')}</g:google_product_category><g:product_type>${xml(catTrail(p.category, S.categories).map((c) => c.name).join(' > ') || p.type)}</g:product_type><g:identifier_exists>no</g:identifier_exists>
<g:min_handling_time>7</g:min_handling_time><g:max_handling_time>10</g:max_handling_time>
<g:product_detail><g:attribute_name>Minimum order</g:attribute_name><g:attribute_value>${p.moq} pcs</g:attribute_value></g:product_detail>
</item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(S.store.name)} (${cur})</title><link>${xml(site())}</link><description>${xml(S.store.tagline)}</description>\n${items.join('\n')}\n</channel></rss>`;
}

// ---------- build ----------
await fs.rm(OUT, { recursive: true, force: true });
await copyDir(path.join(ROOT, 'site/static'), path.join(OUT, 'assets'));
await fs.copyFile(path.join(ROOT, 'shared/pricing.js'), path.join(OUT, 'assets/js/pricing.js'));
await fs.copyFile(path.join(ROOT, 'shared/carriers.js'), path.join(OUT, 'assets/js/carriers.js'));
await fs.copyFile(path.join(ROOT, 'shared/img.js'), path.join(OUT, 'assets/js/img.js'));
await copyDir(path.join(ROOT, 'site/lib'), path.join(OUT, 'assets/js/lib')).catch(() => {});
await fs.rm(path.join(OUT, 'assets/js/lib/templates.js')).catch(() => {});
await copyDir(path.join(ROOT, 'admin'), path.join(OUT, 'admin'));

for (const p of products) {
  const hero = p.colors.find((c) => c.name === p.heroColor) || p.colors[0];
  await write(`assets/img/p/${p.slug}.svg`, garmentSVG(p.type, hero.hex, hero.hex2).replace('<svg ', '<svg style="background:#EEEDEA" '));
}

for (const lang of langs) {
  const ctx = makeCtx(lang);
  await write(outPath('/', lang), home(ctx));
  await write(outPath('/products/', lang), listing(ctx));
  for (const c of S.categories || []) if (inCategory(c.slug).length) await write(outPath(`/collections/${c.slug}/`, lang), listing(ctx, c));
  if (samplesOn()) await write(outPath('/sample-kit/', lang), sampleKitPage(ctx));
  for (const p of products) await write(outPath(`/products/${p.slug}/`, lang), productPage(ctx, p));
  await write(outPath('/size-guide/', lang), sizeGuide(ctx));
  await write(outPath('/faq/', lang), faqPage(ctx));
  for (const pg of S.pages || []) await write(outPath(`/${pg.slug}/`, lang), contentPage(ctx, pg));
  for (const k of ['cart', 'checkout', 'order', 'account']) await write(outPath(`/${k}/`, lang), appPage(ctx, k));
}
await write('404.html', notFound(makeCtx(DEF)));

addSitemap('/', langs);
addSitemap('/products/', langs);
for (const c of S.categories || []) if (inCategory(c.slug).length) addSitemap(`/collections/${c.slug}/`, langs);
if (samplesOn()) addSitemap('/sample-kit/', langs);
for (const p of products) addSitemap(`/products/${p.slug}/`, langs.filter((l) => l === DEF || p.i18n?.[l]), p.colors.flatMap((c) => c.images || []).slice(0, 20).map(absImg));
addSitemap('/size-guide/', langs); addSitemap('/faq/', langs);
for (const pg of S.pages || []) if (!/\[add /i.test(pg.body)) addSitemap(`/${pg.slug}/`, langs.filter((l) => l === DEF || pg.i18n?.[l]));

await write('sitemap.xml', sitemapXML());
await write('robots.txt', robots());
await write('llms.txt', llmsTxt());
await write('llms-full.txt', llmsTxt(true));
await write('catalog.json', catalogJSON());
for (const c of S.currencies.filter((c) => c.enabled)) await write(`feeds/google-${c.code}.xml`, merchantFeed(c.code));
await write('assets/config.js', `window.SC=${JSON.stringify({
  api: S.store.apiUrl, base: BASE, fileLinks: FILE_LINKS, defaultLang: DEF, langs, baseCurrency: S.baseCurrency,
  currencies: S.currencies.filter((c) => c.enabled), fxMarkup: S.fxMarkup, fx,
  payments: Object.fromEntries(Object.entries(S.payments).map(([k, v]) => [k, { enabled: v.enabled, label: v.label, currencies: v.currencies || [] }])),
  tax: S.tax, store: { name: S.store.name, email: S.store.email, whatsapp: S.store.whatsapp || '' },
  samples: { enabled: samplesOn(), maxPieces: S.samples?.maxPieces || 5, markupPct: S.samples?.markupPct || 0 },
})};`);
await write('manifest.webmanifest', JSON.stringify({ name: S.store.name, short_name: S.store.name, start_url: BASE + '/', display: 'standalone', background_color: '#F2F1EE', theme_color: '#0E0E0E', icons: [{ src: BASE + '/assets/img/favicon.svg', sizes: 'any', type: 'image/svg+xml' }] }));
await write('.nojekyll', '');
if (S.store.domain && !BASE) await write('CNAME', S.store.domain + '\n');

console.log(`✓ Built ${langs.length} language(s), ${products.length} products → ${path.relative(process.cwd(), OUT) || OUT}`);
