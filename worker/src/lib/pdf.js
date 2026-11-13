// Minimal PDF writer (A4, Helvetica / Helvetica-Bold, WinAnsi) — enough for invoices and packing slips
// without pulling a PDF library into the Worker.

// Helvetica glyph widths (1/1000 em) for ASCII 32–126 from the standard AFM.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// Helvetica-Bold widths for ASCII 32–126.
const WB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// Unicode → WinAnsi for common non-ASCII characters.
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '×': 0xd7, '½': 0xbd, '¼': 0xbc, '¾': 0xbe, '°': 0xb0, '£': 0xa3, '©': 0xa9, '®': 0xae, '·': 0xb7 };
const toWin = (s) => {
  const out = [];
  for (const ch of String(s ?? '').replace(/₹/g, 'Rs.').replace(/[⅛⅜⅝⅞]/g, (m) => ({ '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' }[m]))) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (WIN[ch]) out.push(WIN[ch]);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(63); // '?'
  }
  return out;
};
export function textWidth(s, size, bold = false) {
  const t = bold ? WB : W;
  return toWin(s).reduce((w, c) => w + (c >= 32 && c < 127 ? t[c - 32] : 556), 0) * size / 1000;
}
const pdfStr = (s) => '(' + String.fromCharCode(...toWin(s)).replace(/[\\()]/g, (m) => '\\' + m) + ')';
const rgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v.toFixed(3)).join(' '); };

export class PDF {
  constructor() { this.pages = []; this.newPage(); this.W = 595.28; this.H = 841.89; }
  newPage() { this.ops = []; this.pages.push(this.ops); return this; }
  /** y is measured from the TOP of the page (friendlier for documents). */
  text(x, y, s, { size = 10, bold = false, color = '#0E0E0E', align = 'left', maxWidth } = {}) {
    let str = String(s ?? '');
    if (maxWidth) while (str.length > 1 && textWidth(str, size, bold) > maxWidth) str = str.slice(0, -2) + '…';
    const w = textWidth(str, size, bold);
    const ax = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${ax.toFixed(2)} ${(841.89 - y).toFixed(2)} Td ${pdfStr(str)} Tj ET`);
    return this;
  }
  /** Wrap text into lines that fit maxWidth; returns the y after the last line. */
  para(x, y, s, maxWidth, { size = 10, bold = false, color, lead = 1.35 } = {}) {
    const lines = [];
    for (const raw of String(s ?? '').split('\n')) {
      let line = '';
      for (const word of raw.split(/\s+/)) {
        const cand = line ? line + ' ' + word : word;
        if (textWidth(cand, size, bold) > maxWidth && line) { lines.push(line); line = word; } else line = cand;
      }
      lines.push(line);
    }
    lines.forEach((l, i) => this.text(x, y + i * size * lead, l, { size, bold, color }));
    return y + lines.length * size * lead;
  }
  line(x1, y1, x2, y2, { color = '#0E0E0E', width = 0.6 } = {}) {
    this.ops.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${(841.89 - y1).toFixed(2)} m ${x2.toFixed(2)} ${(841.89 - y2).toFixed(2)} l S`);
    return this;
  }
  rect(x, y, w, h, { fill = '#0E0E0E' } = {}) {
    this.ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(841.89 - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    return this;
  }
  bytes() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1; objs.push(null);
    const kids = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const cId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cId} 0 R >>`));
    }
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    // Every char is already a single byte (WinAnsi / ASCII), so latin1 encoding keeps offsets exact.
    return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
  }
}
