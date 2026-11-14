// Shared pricing logic — used by the storefront (browser), the build script (Node)
// and the Cloudflare Worker, so displayed prices always match charged prices.

export const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);

/** Unit price (base currency) for a product at a total quantity, using tiers. */
export function tierPrice(product, qty) {
  let price = Number(product.price) || 0;
  const tiers = [...(product.tiers || [])].sort((a, b) => a.min - b.min);
  for (const t of tiers) if (qty >= t.min) price = Number(t.price);
  return price;
}

/** Convert an amount in the base currency to `cur`, applying markup + rounding. */
export function convert(amount, cur, settings, fx) {
  const base = settings.baseCurrency || 'INR';
  if (!cur || cur === base) return round(amount, cur || base, settings, true);
  const rate = fx?.rates?.[cur];
  if (!rate) return null; // unknown currency → caller falls back to base
  const c = (settings.currencies || []).find((x) => x.code === cur) || {};
  const markup = c.markup ?? settings.fxMarkup ?? 0;
  return round(amount * rate * (1 + markup / 100), cur, settings);
}

function round(v, cur, settings, isBase = false) {
  const c = (settings.currencies || []).find((x) => x.code === cur) || {};
  const dp = ZERO_DECIMAL.has(cur) ? 0 : 2;
  const step = isBase ? Math.pow(10, -dp) : Number(c.round) || Math.pow(10, -dp);
  const r = Math.ceil(+(v / step).toFixed(6)) * step;
  return +r.toFixed(dp);
}

export function decimals(cur) { return ZERO_DECIMAL.has(cur) ? 0 : 2; }

/** Minor units for payment APIs (Stripe). */
export function toMinor(v, cur) { return Math.round(v * Math.pow(10, decimals(cur))); }

export function format(v, cur, locale = 'en') {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: cur,
      minimumFractionDigits: v % 1 === 0 ? 0 : decimals(cur),
      maximumFractionDigits: decimals(cur),
    }).format(v);
  } catch { return `${cur} ${v}`; }
}

/** Sample price per piece (base currency). */
export function samplePrice(product, settings) {
  const sm = settings.samples || {};
  if (Number(product.samplePrice) > 0) return Number(product.samplePrice);
  const base = Number(product.price) || 0;
  return +(base * (1 + (Number(sm.markupPct) || 0) / 100)).toFixed(2);
}

/**
 * Price a cart. items: [{productId, color, size, qty, sample?}]
 * Bulk lines are grouped per product (MOQ + tiers apply). Sample lines form their own
 * group per product: no MOQ, priced per piece, limited to settings.samples.maxPieces per order.
 */
export function priceCart(items, products, settings, fx, cur) {
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const sm = settings.samples || {};
  const groups = {};
  for (const it of items) {
    const p = byId[it.productId];
    const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
    if (!p || !qty) continue;
    const sample = !!it.sample;
    const k = p.id + (sample ? '#sample' : '');
    groups[k] ??= { product: p, sample, lines: [], qty: 0 };
    groups[k].lines.push({ color: it.color, size: it.size, qty });
    groups[k].qty += qty;
  }
  let subtotal = 0, weightG = 0, samplePieces = 0;
  const out = [];
  for (const g of Object.values(groups)) {
    const baseUnit = g.sample ? samplePrice(g.product, settings) : tierPrice(g.product, g.qty);
    const unit = convert(baseUnit, cur, settings, fx);
    const total = +(unit * g.qty).toFixed(decimals(cur));
    subtotal += total;
    weightG += g.qty * (Number(g.product.weightG) || 250);
    if (g.sample) samplePieces += g.qty;
    out.push({
      productId: g.product.id, code: g.product.code, name: g.product.name + (g.sample ? ' — Sample' : ''), slug: g.product.slug,
      hsCode: g.product.hsCode, qty: g.qty, moq: g.sample ? 1 : (g.product.moq || 1), sample: g.sample,
      meetsMoq: g.sample || g.qty >= (g.product.moq || 1), unit, total, lines: g.lines,
    });
  }
  out.sort((a, b) => a.sample - b.sample);
  const sampleLimit = Number(sm.maxPieces) || 5;
  const samplesOk = !samplePieces || (sm.enabled !== false && samplePieces <= sampleLimit);
  return { currency: cur, groups: out, subtotal: +subtotal.toFixed(decimals(cur)), weightG, samplePieces, sampleLimit,
    ok: out.length > 0 && out.every((g) => g.meetsMoq) && samplesOk };
}

export function taxFor(country, amount, settings, cur) {
  const rule = (settings.tax?.rules || []).find((r) => r.country === country);
  if (!rule || !rule.rate) return { amount: 0, label: '' };
  return { amount: +(amount * rule.rate / 100).toFixed(decimals(cur)), label: `${rule.label || 'Tax'} ${rule.rate}%`, inclusive: !!settings.tax?.inclusive };
}
