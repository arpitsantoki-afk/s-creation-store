// Category tree helpers (two levels: department → category), shared by build, browser and worker.
// settings.categories: [{ slug, name, parent: '' | <slug>, intro?, google?, i18n? }]
// product.category = primary category slug; product.categories = extra memberships (optional).

export const catBySlug = (cats = []) => Object.fromEntries(cats.map((c) => [c.slug, c]));

/** Top-level categories with their children: [{ ...cat, children: [...] }] */
export function catTree(cats = []) {
  const tops = cats.filter((c) => !c.parent || !cats.some((x) => x.slug === c.parent));
  return tops.map((t) => ({ ...t, children: cats.filter((c) => c.parent === t.slug) }));
}

/** Every category slug a product belongs to, ancestors included. */
export function productCats(p, cats = []) {
  const by = catBySlug(cats), out = new Set();
  for (const s of [p.category, ...(p.categories || [])].filter(Boolean)) {
    let c = by[s], guard = 0;
    out.add(s);
    while (c?.parent && guard++ < 5) { out.add(c.parent); c = by[c.parent]; }
  }
  return out;
}

export const inCat = (p, slug, cats) => productCats(p, cats).has(slug);

/** Breadcrumb trail for a category slug: [top, child] */
export function catTrail(slug, cats = []) {
  const by = catBySlug(cats), out = [];
  let c = by[slug], guard = 0;
  while (c && guard++ < 5) { out.unshift(c); c = by[c.parent]; }
  return out;
}

export const catName = (c, lang) => (c?.i18n?.[lang] || c?.name || '');
