/** Split an order's weight into boxes per settings.shipping.packaging. Returns [{weight(kg), l, w, h}] */
export function packBoxes(weightG, settings) {
  const pk = settings.shipping?.packaging || {};
  const max = pk.maxBoxKg || 20;
  const box = pk.box || { l: 60, w: 40, h: 40 };
  let kg = (weightG / 1000) * (1 + (pk.packagingPct ?? 6) / 100);
  kg = Math.max(0.5, kg);
  const n = Math.ceil(kg / max);
  const each = +(kg / n).toFixed(2);
  return Array.from({ length: n }, () => ({ weight: Math.max(0.5, each), l: box.l, w: box.w, h: box.h }));
}
export const totalKg = (boxes) => +boxes.reduce((s, b) => s + b.weight, 0).toFixed(2);
