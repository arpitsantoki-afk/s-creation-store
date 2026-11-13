export const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Minimal, safe markdown: ## headings, paragraphs, - lists, **bold**, *italic*, [links](url). */
export function md(src = '') {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  for (const block of String(src).replace(/\r/g, '').split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^(#{2,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      out.push('<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('') + '</ul>');
      continue;
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      out.push('<ol>' + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('') + '</ol>');
      continue;
    }
    out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

export const plain = (s = '') => String(s).replace(/[#*_\[\]>`]/g, '').replace(/\(https?:[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
export const slugify = (s = '') => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const xml = (s = '') => esc(s);

/** Illustrated garment used until real photos are uploaded. */
export function garmentSVG(type, hex = '#ccc', hex2 = null, cls = 'garment') {
  const collar = hex2 || hex;
  const tee = /t-?shirt|tee/i.test(type || '');
  const body = tee
    ? 'M128 52 Q200 78 272 52 L350 90 L372 190 L318 200 L312 410 Q200 424 88 410 L82 200 L28 190 L50 90 Z'
    : 'M138 46 L168 32 Q200 50 232 32 L262 46 L342 92 L318 170 L288 158 L290 410 Q200 424 110 410 L112 158 L82 170 L58 92 Z';
  const neck = tee
    ? `<path d="M152 58 Q200 92 248 58" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="7" stroke-linecap="round"/>`
    : `<path d="M168 32 L200 78 L186 96 L150 42 Z" fill="${collar}"/><path d="M232 32 L200 78 L214 96 L250 42 Z" fill="${collar}"/>
       <path d="M168 32 L200 78 L186 96 L150 42 Z M232 32 L200 78 L214 96 L250 42 Z" fill="rgba(0,0,0,.12)"/>
       <rect x="193" y="80" width="14" height="74" rx="2" fill="rgba(0,0,0,.10)"/>
       <circle cx="200" cy="100" r="3.2" fill="rgba(0,0,0,.28)"/><circle cx="200" cy="124" r="3.2" fill="rgba(0,0,0,.28)"/><circle cx="200" cy="146" r="3.2" fill="rgba(0,0,0,.28)"/>`;
  return `<svg class="${cls}" viewBox="0 0 400 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <path d="${body}" fill="${hex}"/>
  <path d="${body}" fill="url(#shade)" opacity=".9"/>
  ${neck}
  <defs><linearGradient id="shade" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".10"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#000" stop-opacity=".14"/></linearGradient></defs>
</svg>`;
}
