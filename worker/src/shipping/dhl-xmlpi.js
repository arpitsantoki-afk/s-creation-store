// DHL Express XML Services (XML-PI) — the older DHL Express integration that uses a "Site ID" (e.g. v62_…)
// and password. Used automatically when the saved DHL key looks like a Site ID. Supports rate quotes (GetQuote).
const ENDPOINTS = { live: 'https://xmlpi-ea.dhl.com/XMLShippingServlet', test: 'https://xmlpitest-ea.dhl.com/XMLShippingServlet' };
export const isXmlpi = (env) => /^v\d+_/i.test(String(env.DHL_API_KEY || ''));
export const xmlpiHost = (settings) => (settings.shipping?.dhl?.test === false ? ENDPOINTS.live : ENDPOINTS.test);

const x = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; };
const all = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

function readyDate(daysAhead = 1) {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function xmlpiRates({ env, settings, address, boxes, declaredValueBase }) {
  const o = settings.shipping.origin;
  const intl = address.country !== o.country;
  const now = new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('Z', '+05:30');
  const ref = (crypto.randomUUID().replace(/-/g, '') + '0000').slice(0, 30);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<p:DCTRequest xmlns:p="http://www.dhl.com" xmlns:p1="http://www.dhl.com/datatypes" xmlns:p2="http://www.dhl.com/DCTRequestdatatypes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" schemaVersion="2.0" xsi:schemaLocation="http://www.dhl.com DCT-req.xsd">
<GetQuote>
<Request><ServiceHeader><MessageTime>${now}</MessageTime><MessageReference>${ref}</MessageReference><SiteID>${x(env.DHL_API_KEY)}</SiteID><Password>${x(env.DHL_API_SECRET)}</Password></ServiceHeader>
<MetaData><SoftwareName>SCreation</SoftwareName><SoftwareVersion>1.0</SoftwareVersion></MetaData></Request>
<From><CountryCode>${x(o.country)}</CountryCode><Postalcode>${x(o.postcode)}</Postalcode><City>${x(o.city)}</City></From>
<BkgDetails><PaymentCountryCode>${x(o.country)}</PaymentCountryCode><Date>${readyDate(1)}</Date><ReadyTime>PT10H00M</ReadyTime><ReadyTimeGMTOffset>+05:30</ReadyTimeGMTOffset>
<DimensionUnit>CM</DimensionUnit><WeightUnit>KG</WeightUnit>
<Pieces>${boxes.map((b, i) => `<Piece><PieceID>${i + 1}</PieceID><Height>${b.h}</Height><Depth>${b.l}</Depth><Width>${b.w}</Width><Weight>${b.weight}</Weight></Piece>`).join('')}</Pieces>
${env.DHL_ACCOUNT_NUMBER ? `<PaymentAccountNumber>${x(env.DHL_ACCOUNT_NUMBER)}</PaymentAccountNumber>` : ''}<IsDutiable>${intl ? 'Y' : 'N'}</IsDutiable><NetworkTypeCode>AL</NetworkTypeCode></BkgDetails>
<To><CountryCode>${x(address.country)}</CountryCode><Postalcode>${x(address.postcode)}</Postalcode><City>${x(address.city)}</City></To>
${intl ? `<Dutiable><DeclaredCurrency>${x(settings.baseCurrency)}</DeclaredCurrency><DeclaredValue>${Math.max(1, Math.round(declaredValueBase))}</DeclaredValue></Dutiable>` : ''}
</GetQuote>
</p:DCTRequest>`;
  const r = await fetch(xmlpiHost(settings), { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' }, body });
  const xml = await r.text();
  const conds = all(xml, 'Condition').map((c) => `${tag(c, 'ConditionCode')}: ${tag(c, 'ConditionData')}`.trim()).filter((s) => s !== ':');
  const quotes = all(xml, 'QtdShp');
  if (!r.ok || (!quotes.length && conds.length)) {
    const err = new Error(`DHL XML Services: ${conds.join(' | ') || `HTTP ${r.status}`}`);
    err.dhl = { status: r.status, body: xml.slice(0, 3000), request: body.replace(/<Password>[\s\S]*?<\/Password>/, '<Password>••••</Password>') };
    throw err;
  }
  const allow = settings.shipping?.dhl?.productCodes || [];
  return quotes.map((q) => {
    const code = tag(q, 'GlobalProductCode');
    const amount = parseFloat(tag(q, 'ShippingCharge'));
    const days = tag(q, 'TotalTransitDays');
    const date = tag(q, 'DeliveryDate').slice(0, 10);
    return { carrier: 'dhl', code, service: `DHL ${tag(q, 'ProductShortName') || 'Express'}`, amount, amountCurrency: tag(q, 'CurrencyCode') || settings.baseCurrency,
      eta: date ? `Est. delivery ${date}` : days ? `${days} transit days` : '' };
  }).filter((q) => q.amount > 0 && (!allow.length || allow.includes(q.code)));
}
