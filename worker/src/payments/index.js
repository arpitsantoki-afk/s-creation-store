// Payment gateway registry. To add a gateway (e.g. Razorpay), create a module exposing
// { id, configured(env), supports(currency, settings), create({order, env, settings, urls}) → {redirectUrl, ref} }
// and register it here; then add its toggle under settings.payments.
import { stripe } from './stripe.js';
import { paypal } from './paypal.js';

export const gateways = { stripe, paypal };

export function availableGateways(env, settings, currency) {
  return Object.values(gateways).filter((g) => settings.payments?.[g.id]?.enabled && g.configured(env) && g.supports(currency, settings));
}
