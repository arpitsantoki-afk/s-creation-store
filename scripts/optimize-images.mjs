#!/usr/bin/env node
// Bulk image pipeline (same output as the dashboard uploader).
//   node scripts/optimize-images.mjs <folder-of-exported-images>
// Input file names: "<Line> upload – <Colour> (<view>).png" (canvas export) or <Line>-<Colour>-<view>.<png|jpg|webp>
// Output: site/static/uploads/products/<product-slug>/<product>-<colour>-<view>-<W>x<H>.webp (400/800/1200/1600 px)
//         content/photos.json  { "<product id>": { "<Colour name>": ["/assets/uploads/…-1200x1500.webp", …] } }
// Then: Dashboard → Products → "Attach repo photos" links them to the products.
import fs from 'node:fs/promises';
import path from 'node:path';
import { variantSizes, seoName, QUALITY } from '../shared/img.js';

let sharp;
try { sharp = (await import('sharp')).default; } catch { console.error('Run: npm i --no-save sharp'); process.exit(1); }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const inDir = process.argv[2];
if (!inDir) { console.error('Usage: node scripts/optimize-images.mjs <folder>'); process.exit(1); }

const products = JSON.parse(await fs.readFile(path.join(ROOT, 'content/products.json'), 'utf8'));
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const byLine = Object.fromEntries(products.map((p) => [key(p.line || p.name.split(' ')[0]), p]));

const manifestFile = path.join(ROOT, 'content/photos.json');
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8').catch(() => '{}'));
const touched = new Set();
let n = 0, bytesIn = 0, bytesOut = 0;

const files = (await fs.readdir(inDir, { recursive: true })).filter((f) => /\.(png|jpe?g|webp|avif|tiff?)$/i.test(f)).sort();
for (const rel of files) {
  const stem = path.basename(rel).replace(/\.[^.]+$/, '').replace(/^(site|web)[-_ ]/i, '');
  // "Aurum upload – Mint Blue (2)" (canvas export) or "Aurum-MintBlue-2"
  const m = /^(\S+)\s+upload\s+[–—-]\s+(.+?)\s*\((\d+)\)$/i.exec(stem) || /^([^-_ ]+)[-_ ]+(.+?)[-_ ]+(\d+)$/.exec(stem) || /^([^-_ ]+)[-_ ]+(.+)$/.exec(stem);
  const p = m && byLine[key(m[1])];
  const col = p && p.colors.find((c) => key(c.name) === key(m[2]));
  if (!col) { console.warn(`skip ${rel}: can't match product/colour`); continue; }
  const view = +(m[3] || 1);
  const src = path.join(inDir, rel);
  const img = sharp(src, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const base = seoName(p.slug, col.name, view);
  const dir = path.join(ROOT, 'site/static/uploads/products', p.slug);
  await fs.mkdir(dir, { recursive: true });
  let largest;
  for (const s of variantSizes(meta.width, meta.height)) {
    const name = `${base}-${s.w}x${s.h}.webp`;
    const buf = await img.clone().resize(s.w, s.h, { kernel: 'lanczos3' }).webp({ quality: Math.round(QUALITY * 100), effort: 6, smartSubsample: true }).toBuffer();
    await fs.writeFile(path.join(dir, name), buf);
    largest = { name, size: buf.length };
  }
  bytesIn += (await fs.stat(src)).size; bytesOut += largest.size;
  const tag = `${p.id}|${col.name}`;
  if (!touched.has(tag)) { touched.add(tag); ((manifest[p.id] ||= {})[col.name] = []); }
  const list = manifest[p.id][col.name];
  list[view - 1] = `/assets/uploads/products/${p.slug}/${largest.name}`;
  n++;
}
for (const p of Object.values(manifest)) for (const c in p) p[c] = p[c].filter(Boolean);
await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
console.log(`${n} photos → WebP (${(bytesIn / 1048576).toFixed(1)} MB → ${(bytesOut / 1048576).toFixed(1)} MB at the largest size), manifest: content/photos.json`);
