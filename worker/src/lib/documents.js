// Tax invoice + packing slip PDFs, and invoice numbering (Indian financial year, Apr–Mar).
import { PDF } from './pdf.js';
import { decimals } from '../../../shared/pricing.js';

export function financialYear(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600e3);
  const y = ist.getUTCFullYear(), start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Assign a sequential invoice number once per order (idempotent). */
export async function ensureInvoiceNo(env, order, settings) {
  if (order.invoiceNo) return order.invoiceNo;
  const row = await env.DB.prepare('SELECT invoice_no FROM orders WHERE id = ?').bind(order.id).first();
  if (row?.invoice_no) return row.invoice_no;
  const fy = financialYear();
  const c = await env.DB.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value')
    .bind('invoice:' + fy).first();
  const no = `${(settings.invoice?.prefix || 'INV').replace(/[^A-Z0-9-]/gi, '')}/${fy}/${String(c.value).padStart(4, '0')}`;
  // Guard against a concurrent assignment: only set if still empty.
  await env.DB.prepare("UPDATE orders SET invoice_no = ?, updated_at = datetime('now') WHERE id = ? AND invoice_no IS NULL").bind(no, order.id).run();
  const fin = await env.DB.prepare('SELECT invoice_no FROM orders WHERE id = ?').bind(order.id).first();
  return fin.invoice_no;
}

const fmt = (v, cur) => {
  const dp = decimals(cur);
  try { return `${cur} ${new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v)}`; }
  catch { return `${cur} ${(+v).toFixed(dp)}`; }
};
const dt = (s) => new Date(s ? (String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const addrLines = (a = {}) => [a.name, a.company, a.line1, a.line2, [a.city, a.state, a.postcode].filter(Boolean).join(', '), countryName(a.country), a.phone ? 'Tel: ' + a.phone : ''].filter(Boolean);
function countryName(code) { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; } }
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function header(pdf, settings, title, rightLines) {
  pdf.rect(40, 40, 11, 11, { fill: '#D7FF3D' });
  pdf.line(40, 40, 51, 40).line(51, 40, 51, 51).line(51, 51, 40, 51).line(40, 51, 40, 40);
  pdf.text(58, 50.5, (settings.store.name || 'S CREATION').toUpperCase(), { size: 15, bold: true });
  pdf.text(555, 50, title, { size: 15, bold: true, align: 'right' });
  rightLines.forEach((l, i) => pdf.text(555, 68 + i * 13, l, { size: 9, color: '#55534F', align: 'right' }));
  const inv = settings.invoice || {};
  const seller = [inv.legalName || settings.store.legalName || settings.store.name, ...String(inv.address || '').split('\n').filter(Boolean),
    inv.gstin ? `GSTIN: ${inv.gstin}` : '', [settings.store.email, settings.store.phone].filter(Boolean).join(' · ')].filter(Boolean);
  seller.forEach((l, i) => pdf.text(40, 68 + i * 13, l, { size: 9, bold: i === 0, color: i === 0 ? '#0E0E0E' : '#55534F' }));
  return Math.max(68 + seller.length * 13, 68 + rightLines.length * 13) + 14;
}

export function invoicePdf(order, settings) {
  const pdf = new PDF();
  const inv = settings.invoice || {};
  const cur = order.currency;
  const export_ = order.address.country !== (settings.shipping?.origin?.country || 'IN');
  const title = export_ ? 'EXPORT INVOICE' : 'TAX INVOICE';
  let y = header(pdf, settings, title, [`Invoice no: ${order.invoiceNo}`, `Invoice date: ${dt(order.invoiceDate || order.paidAt || order.createdAt)}`, `Order: ${order.number}`, `Currency: ${cur}`]);
  pdf.line(40, y, 555, y); y += 18;

  // Bill to / ship to
  const bill = [order.customer.name, order.customer.company, order.customer.email, order.customer.phone, order.customer.taxId ? `Tax ID: ${order.customer.taxId}` : ''].filter(Boolean);
  pdf.text(40, y, 'BILL TO', { size: 8, bold: true, color: '#55534F' }); pdf.text(300, y, 'SHIP TO', { size: 8, bold: true, color: '#55534F' });
  bill.forEach((l, i) => pdf.text(40, y + 14 + i * 12.5, l, { size: 9.5, bold: i === 0, maxWidth: 240 }));
  const ship = addrLines(order.address);
  ship.forEach((l, i) => pdf.text(300, y + 14 + i * 12.5, l, { size: 9.5, bold: i === 0, maxWidth: 255 }));
  y += 14 + Math.max(bill.length, ship.length) * 12.5 + 8;
  if (!export_) pdf.text(40, y, `Place of supply: ${order.address.state || '—'}`, { size: 9, color: '#55534F' }), (y += 14);
  y += 6;

  // Items table
  const cols = { n: 40, item: 62, hsn: 330, qty: 395, rate: 470, amt: 555 };
  const head = () => {
    pdf.rect(40, y, 515, 20, { fill: '#0E0E0E' });
    const o = { size: 8, bold: true, color: '#F2F1EE' };
    pdf.text(cols.n + 4, y + 13.5, '#', o); pdf.text(cols.item, y + 13.5, 'DESCRIPTION', o); pdf.text(cols.hsn, y + 13.5, 'HSN', o);
    pdf.text(cols.qty, y + 13.5, 'QTY', { ...o, align: 'right' }); pdf.text(cols.rate, y + 13.5, 'RATE', { ...o, align: 'right' }); pdf.text(cols.amt - 4, y + 13.5, 'AMOUNT', { ...o, align: 'right' });
    y += 28;
  };
  head();
  order.groups.forEach((g, i) => {
    if (y > 700) { pdf.newPage(); y = 50; head(); }
    pdf.text(cols.n + 4, y, String(i + 1), { size: 9.5 });
    pdf.text(cols.item, y, `${g.name} (${g.code})`, { size: 9.5, bold: true, maxWidth: 260 });
    pdf.text(cols.hsn, y, (g.hsCode || '').replace(/\./g, ''), { size: 9.5 });
    pdf.text(cols.qty, y, `${g.qty} pcs`, { size: 9.5, align: 'right' });
    pdf.text(cols.rate, y, fmt(g.unit, cur), { size: 9.5, align: 'right' });
    pdf.text(cols.amt - 4, y, fmt(g.total, cur), { size: 9.5, align: 'right' });
    const byColor = {};
    for (const l of g.lines) (byColor[l.color] ||= []).push(`${l.size}×${l.qty}`);
    const detail = Object.entries(byColor).map(([c, s]) => `${c}: ${s.join(', ')}`).join('  ·  ');
    y = pdf.para(cols.item, y + 13, detail, 255, { size: 8, color: '#55534F', lead: 1.3 }) + 6;
    pdf.line(40, y, 555, y, { color: '#D9D7D2' }); y += 16;
  });

  // Totals
  if (y > 640) { pdf.newPage(); y = 60; }
  const tot = (label, v, bold = false) => { pdf.text(470, y, label, { size: bold ? 10.5 : 9.5, bold, align: 'right' }); pdf.text(551, y, fmt(v, cur), { size: bold ? 10.5 : 9.5, bold, align: 'right' }); y += bold ? 18 : 15; };
  tot('Subtotal', order.subtotal);
  tot(`Shipping — ${order.shipping?.service || ''}`.slice(0, 48), order.shippingAmount);
  if (order.taxAmount) {
    const intra = norm(order.address.state) && norm(order.address.state) === norm(inv.state || settings.shipping?.origin?.state);
    const rate = (order.taxLabel.match(/([\d.]+)%/) || [])[1];
    if (intra && rate) { tot(`CGST ${rate / 2}%`, +(order.taxAmount / 2).toFixed(2)); tot(`SGST ${rate / 2}%`, +(order.taxAmount - (order.taxAmount / 2).toFixed(2)).toFixed(2)); }
    else tot(rate ? `IGST ${rate}%` : order.taxLabel, order.taxAmount);
  }
  pdf.line(330, y - 6, 555, y - 6, { width: 1 }); y += 6;
  tot('TOTAL', order.total, true);
  if (cur !== 'INR' && order.fxRate) { pdf.text(551, y, `Approx. ${fmt(order.total / order.fxRate, 'INR')} at 1 ${cur} = ${(1 / order.fxRate).toFixed(4)} INR`, { size: 8, color: '#55534F', align: 'right' }); y += 14; }

  // Notes
  y += 14;
  const notes = [
    order.status === 'refunded' ? 'This order has been refunded.' : order.paidAt ? `Paid on ${dt(order.paidAt)} via ${order.gateway === 'paypal' ? 'PayPal' : 'Stripe'}${order.payment?.paymentIntent || order.payment?.captureId ? ' (ref ' + (order.payment.paymentIntent || order.payment.captureId) + ')' : ''}.` : 'Payment pending.',
    export_ && inv.lutNote ? inv.lutNote : '',
    export_ ? `Incoterm: ${settings.shipping?.dhl?.incoterm || 'DAP'}. Import duties and taxes, if any, are payable by the receiver.` : '',
    'Country of origin: India.',
    inv.footer || '',
  ].filter(Boolean);
  for (const n of notes) y = pdf.para(40, y, n, 515, { size: 8.5, color: '#55534F' }) + 3;
  pdf.text(40, 805, `${settings.store.domain || ''}`, { size: 8, color: '#55534F' });
  pdf.text(555, 805, 'This is a computer-generated invoice.', { size: 8, color: '#55534F', align: 'right' });
  return pdf.bytes();
}

export function packingSlipPdf(order, settings, boxes = []) {
  const pdf = new PDF();
  let y = header(pdf, settings, 'PACKING SLIP', [`Order: ${order.number}`, `Date: ${dt(order.createdAt)}`, `Pieces: ${order.groups.reduce((s, g) => s + g.qty, 0)}`, boxes.length ? `Boxes: ${boxes.length} · ${boxes.reduce((s, b) => s + b.weight, 0).toFixed(1)} kg` : '']);
  pdf.line(40, y, 555, y); y += 18;
  pdf.text(40, y, 'SHIP TO', { size: 8, bold: true, color: '#55534F' });
  const ship = addrLines(order.address);
  ship.forEach((l, i) => pdf.text(40, y + 14 + i * 13, l, { size: 10, bold: i === 0 }));
  pdf.text(300, y, 'SHIPPING', { size: 8, bold: true, color: '#55534F' });
  [order.shipping?.service, order.tracking ? `Tracking: ${order.tracking}` : '', order.notes ? `Note: ${order.notes}` : ''].filter(Boolean)
    .forEach((l, i) => pdf.para(300, y + 14 + i * 13, l, 255, { size: 9.5 }));
  y += 14 + ship.length * 13 + 18;
  for (const g of order.groups) {
    const sizes = [...new Set(g.lines.map((l) => l.size))], colors = [...new Set(g.lines.map((l) => l.color))];
    const need = 40 + colors.length * 18;
    if (y + need > 790) { pdf.newPage(); y = 50; }
    pdf.text(40, y, `${g.code} · ${g.name}`, { size: 11, bold: true }); pdf.text(555, y, `${g.qty} pcs`, { size: 11, bold: true, align: 'right' }); y += 10;
    const cw = Math.min(46, (515 - 170 - 50) / Math.max(1, sizes.length));
    pdf.rect(40, y, 515, 18, { fill: '#E4E2DD' });
    pdf.text(48, y + 12.5, 'COLOUR', { size: 8, bold: true });
    sizes.forEach((s, i) => pdf.text(210 + i * cw + cw / 2, y + 12.5, s, { size: 8, bold: true, align: 'center' }));
    pdf.text(547, y + 12.5, 'TOTAL', { size: 8, bold: true, align: 'right' });
    y += 18;
    for (const c of colors) {
      pdf.text(48, y + 12.5, c, { size: 9.5, maxWidth: 155 });
      sizes.forEach((s, i) => { const q = g.lines.find((l) => l.color === c && l.size === s)?.qty; if (q) pdf.text(210 + i * cw + cw / 2, y + 12.5, String(q), { size: 9.5, align: 'center' }); });
      pdf.text(547, y + 12.5, String(g.lines.filter((l) => l.color === c).reduce((a, l) => a + l.qty, 0)), { size: 9.5, bold: true, align: 'right' });
      y += 18; pdf.line(40, y, 555, y, { color: '#D9D7D2' });
    }
    y += 22;
  }
  pdf.text(40, Math.min(y + 10, 800), 'Packed by: ____________________     Checked by: ____________________', { size: 9, color: '#55534F' });
  return pdf.bytes();
}
