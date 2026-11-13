// DHL Express — MyDHL API (https://developer.dhl.com/api-reference/dhl-express-mydhl-api)
// Rates: POST /rates · Shipments (label + AWB): POST /shipments · Tracking: GET /shipments/{awb}/tracking
import { totalKg } from './packing.js';

// Test vs live is chosen in Dashboard → Settings → Shipping (“Use DHL test environment”).
const host = (env, settings) => (settings.shipping?.dhl?.test === false ? 'https://express.api.dhl.com/mydhlapi' : 'https://express.api.dhl.com/mydhlapi/test');
export const dhlHost = host;
// MyDHL API uses Basic auth (API key/username + secret/password). We also send the key as DHL-API-Key
// so single-key DHL products work where supported; DHL's error message is shown in the dashboard test.
const auth = (env) => 'Basic ' + btoa(`${env.DHL_API_KEY}:${env.DHL_API_SECRET || ''}`);

async function call(env, settings, method, path, body) {
  const r = await fetch(host(env, settings) + path, {
    method, headers: { authorization: auth(env), ...(env.DHL_API_SECRET ? {} : { 'DHL-API-Key': env.DHL_API_KEY }), 'content-type': 'application/json', accept: 'application/json', 'Message-Reference': crypto.randomUUID().replace(/-/g, '').slice(0, 32) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let d = {}; try { d = JSON.parse(raw); } catch { /* not JSON */ }
  if (!r.ok) {
    const extra = Array.isArray(d.additionalDetails) ? d.additionalDetails.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
    const msg = [d.title, d.detail, d.message, ...extra].filter(Boolean).join(' – ') || raw.slice(0, 600) || `HTTP ${r.status}`;
    const err = new Error(`DHL ${r.status}: ${msg}${r.status === 401 ? ' (DHL rejected the credentials for this environment — check test vs live)' : ''}`);
    err.dhl = { status: r.status, body: d && Object.keys(d).length ? d : raw.slice(0, 2000), request: body };
    throw err;
  }
  return d;
}

/** Planned shipping date: next working day at 10:00 IST in DHL's format. */
function plannedDate(daysAhead = 1) {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) + 'T10:00:00 GMT+05:30';
}

export const dhl = {
  id: 'dhl',
  configured: (env) => !!env.DHL_API_KEY,

  async rates({ env, settings, address, boxes, declaredValueBase }) {
    const o = settings.shipping.origin;
    const intl = address.country !== o.country;
    const d = await call(env, settings, 'POST', '/rates', {
      customerDetails: {
        shipperDetails: { postalCode: o.postcode, cityName: o.city, countryCode: o.country },
        receiverDetails: { postalCode: address.postcode, cityName: address.city, countryCode: address.country },
      },
      accounts: env.DHL_ACCOUNT_NUMBER ? [{ typeCode: 'shipper', number: env.DHL_ACCOUNT_NUMBER }] : undefined,
      plannedShippingDateAndTime: plannedDate(1), unitOfMeasurement: 'metric', isCustomsDeclarable: intl,
      monetaryAmount: intl ? [{ typeCode: 'declaredValue', value: Math.round(declaredValueBase), currency: settings.baseCurrency }] : undefined,
      packages: boxes.map((b) => ({ weight: b.weight, dimensions: { length: b.l, width: b.w, height: b.h } })),
    });
    const allow = settings.shipping?.dhl?.productCodes || [];
    return (d.products || [])
      .filter((p) => !allow.length || allow.includes(p.productCode))
      .map((p) => {
        // Prefer the price in the billing currency; convert to base currency later if it differs.
        const price = p.totalPrice?.find((x) => x.currencyType === 'BILLC') || p.totalPrice?.[0];
        const eta = p.deliveryCapabilities?.estimatedDeliveryDateAndTime;
        return { carrier: 'dhl', code: p.productCode, service: `DHL ${p.productName || 'Express'}`, amount: price?.price, amountCurrency: price?.priceCurrency,
          eta: eta ? `Est. delivery ${eta.slice(0, 10)}` : (p.deliveryCapabilities?.totalTransitDays ? `${p.deliveryCapabilities.totalTransitDays} transit days` : '') };
      })
      .filter((r) => r.amount > 0);
  },

  /** Create a shipment: returns { tracking, labelPdfBase64, invoicePdfBase64, raw } */
  async createShipment({ env, settings, order, boxes }) {
    const o = settings.shipping.origin, a = order.address;
    const intl = a.country !== o.country;
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      plannedShippingDateAndTime: plannedDate(0),
      pickup: { isRequested: false },
      productCode: order.shipping.code && order.shipping.carrier === 'dhl' ? order.shipping.code : (intl ? 'P' : 'N'),
      accounts: [{ typeCode: 'shipper', number: env.DHL_ACCOUNT_NUMBER }],
      outputImageProperties: { encodingFormat: 'pdf', imageOptions: [{ typeCode: 'label', templateName: 'ECOM26_84_001' }, ...(intl ? [{ typeCode: 'invoice', templateName: 'COMMERCIAL_INVOICE_P_10', isRequested: true }] : [])] },
      customerDetails: {
        shipperDetails: {
          postalAddress: { postalCode: o.postcode, cityName: o.city, countryCode: o.country, addressLine1: o.line1 || o.city, provinceCode: o.state },
          contactInformation: { phone: o.phone, companyName: o.company || settings.store.name, fullName: o.contact || settings.store.name, email: o.email },
          registrationNumbers: o.gstin ? [{ typeCode: 'GST', number: o.gstin, issuerCountryCode: 'IN' }] : undefined,
        },
        receiverDetails: {
          postalAddress: { postalCode: a.postcode, cityName: a.city, countryCode: a.country, addressLine1: a.line1.slice(0, 45), addressLine2: a.line2?.slice(0, 45) || undefined, provinceCode: a.state?.slice(0, 35) || undefined },
          contactInformation: { phone: a.phone || order.customer.phone, companyName: (a.company || a.name).slice(0, 100), fullName: a.name.slice(0, 255), email: order.customer.email },
          registrationNumbers: order.customer.taxId ? [{ typeCode: 'VAT', number: order.customer.taxId, issuerCountryCode: a.country }] : undefined,
        },
      },
      content: {
        packages: boxes.map((b) => ({ weight: b.weight, dimensions: { length: b.l, width: b.w, height: b.h }, customerReferences: [{ value: order.number, typeCode: 'CU' }] })),
        isCustomsDeclarable: intl, declaredValue: intl ? +order.subtotal.toFixed(2) : undefined, declaredValueCurrency: intl ? order.currency : undefined,
        description: 'Knitted garments (polo shirts / T-shirts)', incoterm: settings.shipping?.dhl?.incoterm || 'DAP', unitOfMeasurement: 'metric',
        exportDeclaration: intl ? {
          lineItems: order.groups.map((g, i) => ({
            number: i + 1, description: `${g.name} (${g.code})`.slice(0, 512), price: g.unit, quantity: { value: g.qty, unitOfMeasurement: 'PCS' },
            commodityCodes: [{ typeCode: 'outbound', value: (g.hsCode || '610510').replace(/\D/g, '') }], exportReasonType: 'permanent', manufacturerCountry: 'IN',
            weight: { netValue: +(g.qty * (g.weightG || 250) / 1000).toFixed(2), grossValue: +(g.qty * (g.weightG || 250) / 1000 * 1.06).toFixed(2) },
          })),
          invoice: { number: order.number, date: today }, exportReason: 'Sale',
        } : undefined,
      },
      shipmentNotification: [{ typeCode: 'email', receiverId: order.customer.email, languageCode: 'eng' }],
    };
    const d = await call(env, settings, 'POST', '/shipments', body);
    const doc = (t) => d.documents?.find((x) => x.typeCode === t)?.content;
    return { tracking: d.shipmentTrackingNumber, labelPdfBase64: doc('label'), invoicePdfBase64: doc('invoice'), trackingUrl: d.trackingUrl, kg: totalKg(boxes) };
  },

  async track(env, settings, awb) {
    const r = await fetch(`${host(env, settings)}/shipments/${encodeURIComponent(awb)}/tracking?trackingView=last-checkpoint`, { headers: { authorization: auth(env), accept: 'application/json' } });
    return r.json();
  },
};
