// Shipping provider registry. Add new couriers (Shiprocket, FedEx, Aramex…) with the same shape:
// { id, configured(env), rates({env, settings, address, boxes, declaredValueBase}) → [{carrier, code, service, amount|amountBase, amountCurrency?, eta}] }
import { dhl } from './dhl.js';
import { manual } from './manual.js';
import { packBoxes } from './packing.js';

export const carriers = { dhl, manual };
export { packBoxes };

/** Returns rates with amounts converted to the store base currency (amountBase). */
export async function quote({ env, settings, fx, address, weightG, declaredValueBase }) {
  const boxes = packBoxes(weightG, settings);
  const out = [], errors = [];
  if (settings.shipping?.dhl?.enabled && dhl.configured(env)) {
    try {
      for (const r of await dhl.rates({ env, settings, address, boxes, declaredValueBase })) {
        let base = r.amount;
        if (r.amountCurrency && r.amountCurrency !== settings.baseCurrency) {
          const rate = fx.rates?.[r.amountCurrency];
          if (!rate) continue;
          base = r.amount / rate;
        }
        out.push({ ...r, amountBase: Math.ceil(base * (1 + (settings.shipping.handlingPct || 0) / 100)) });
      }
    } catch (e) { errors.push(e.message); }
  }
  // Manual zones are used when DHL is off/unconfigured or returns nothing for this lane.
  if (!out.length) out.push(...(await manual.rates({ address, boxes, settings })));
  return { rates: out.sort((a, b) => a.amountBase - b.amountBase), boxes, errors };
}
