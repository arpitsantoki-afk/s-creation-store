// Product image pipeline — one convention shared by the dashboard uploader, the bulk
// script (scripts/optimize-images.mjs) and the storefront.
//
// Every product photo is stored as WebP in several widths with an SEO filename:
//   <product-slug>-<colour-slug>-<view>-<W>x<H>.webp
//   e.g. aurum-pima-polo-mint-blue-2-1200x1500.webp  (+ -800x1000, -400x500)
// The product record keeps only the largest URL; the smaller widths are derived from it.

export const WIDTHS = [400, 800, 1200, 1600];
export const MAX_W = 1600;
export const QUALITY = 0.82;

const RX = /-(\d{2,4})x(\d{2,4})\.webp(?=$|[?#])/;

export const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** SEO base name (no size/extension) for a photo of a product colour. */
export const seoName = (productSlug, colour, view) => [slug(productSlug), slug(colour), view].filter(Boolean).join('-');

/** Output sizes for a source of w×h (never upscaled). */
export function variantSizes(w, h) {
  const top = Math.min(w, MAX_W);
  const ws = WIDTHS.filter((x) => x < top).concat(top);
  return ws.map((x) => ({ w: x, h: Math.round((h * x) / w) }));
}

/** Info about a pipeline image URL, or null for any other image. */
export function imgInfo(url) {
  const m = RX.exec(url || '');
  if (!m) return null;
  const w = +m[1], h = +m[2];
  const sizes = variantSizes(w, h);
  const at = (s) => url.replace(RX, `-${s.w}x${s.h}.webp`);
  return { w, h, srcset: sizes.map((s) => `${at(s)} ${s.w}w`).join(', '), smallest: at(sizes[0]), url };
}

const escA = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** <img> with srcset, sizes, intrinsic size and loading hints. */
export function imgTag(url, { alt = '', sizes = '100vw', eager = false, cls = '', thumb = false } = {}) {
  const i = imgInfo(url);
  const load = eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const c = cls ? ` class="${escA(cls)}"` : '';
  if (!i) return `<img src="${escA(url)}" alt="${escA(alt)}" ${load} decoding="async"${c}>`;
  const src = thumb ? i.smallest : url;
  return `<img src="${escA(src)}" srcset="${escA(i.srcset)}" sizes="${escA(sizes)}" width="${i.w}" height="${i.h}" alt="${escA(alt)}" ${load} decoding="async"${c}>`;
}
