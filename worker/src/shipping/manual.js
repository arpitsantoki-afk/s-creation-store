// Zone-based fallback rates (base + per-kg, in the store's base currency).
import { totalKg } from './packing.js';

export const manual = {
  id: 'manual',
  configured: () => true,
  async rates({ address, boxes, settings }) {
    const m = settings.shipping?.manual;
    if (!m?.enabled) return [];
    const zone = m.zones.find((z) => z.countries.includes(address.country)) || m.zones.find((z) => z.countries.includes('*'));
    if (!zone) return [];
    const kg = totalKg(boxes);
    return [{ carrier: 'manual', code: 'STD', service: zone.label || `Standard shipping (${zone.name})`, amountBase: Math.round(zone.base + zone.perKg * Math.ceil(kg)), eta: zone.days || '' }];
  },
};
