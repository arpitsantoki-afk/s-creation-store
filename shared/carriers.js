// Carrier tracking links, shared by the Worker (emails), storefront and dashboard.
export const CARRIERS = {
  dhl: { name: 'DHL Express', url: 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id={n}' },
  bluedart: { name: 'Blue Dart', url: 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={n}' },
  delhivery: { name: 'Delhivery', url: 'https://www.delhivery.com/track/package/{n}' },
  fedex: { name: 'FedEx', url: 'https://www.fedex.com/fedextrack/?trknbr={n}' },
  ups: { name: 'UPS', url: 'https://www.ups.com/track?tracknum={n}' },
  aramex: { name: 'Aramex', url: 'https://www.aramex.com/us/en/track/results?ShipmentNumber={n}' },
  indiapost: { name: 'India Post', url: 'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx' },
  other: { name: 'Other', url: '' },
};
export function trackingUrl(shipment) {
  if (!shipment?.tracking) return '';
  if (shipment.trackingUrl) return shipment.trackingUrl;
  const c = CARRIERS[shipment.carrier || 'dhl'];
  return c?.url ? c.url.replace('{n}', encodeURIComponent(shipment.tracking)) : '';
}
export const carrierName = (s) => CARRIERS[s?.carrier]?.name || s?.carrierName || s?.carrier || 'Courier';
