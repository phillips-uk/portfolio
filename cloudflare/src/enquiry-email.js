// enquiry-email.js: the branded email the "Ask me a question" form sends to Lewis (16 Nov 2026).
// Copied from the shared layout every Phillips Group site uses for its contact form email (same structure, each in its
// own brand). Only the Phillips. entry is kept here; it matches The Monday Brief's email frame: cream page, white card,
// amber. Inline styles and tables only, because Gmail ignores most CSS and never loads SVG or web fonts. The logo tile
// is /email/phillips-tile.png on this site.
//
//   renderEnquiryEmail(BRANDS.phillips, {
//     kind:      eyebrow over the title, e.g. 'Website question'
//     title:     e.g. 'New question from Joe Bloggs'
//     preheader: inbox preview line (defaults to the first 110 characters of the message)
//     fields:    [[label, value, href?], ...]  values are escaped here; href makes the value a link
//     messageLabel, message
//     primary:   { label, href }   the main button
//     secondary: { label, href }   optional text link beside it
//     note:      one line under the button
//     footer:    where and when it was sent, and what is kept
//   }) -> { html, text }

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const BRANDS = {
  phillips: {
    // Matches The Monday Brief's email frame: cream page, white card, amber
    name: 'Phillips.', site: 'phillips-uk.com', tile: 'https://www.phillips-uk.com/email/phillips-tile.png',
    page: '#FDF6EE', header: '#FFFFFF', headerText: '#1A1A1A', headerMuted: '#985830', headerRule: true,
    accent: '#985830', button: '#985830', buttonText: '#FFFFFF', tint: '#FDF6EE', line: '#E8D8C4', text: '#1A1A1A', muted: '#77706A',
  },
};

function brandBlock(b) {
  if (b.logo) {
    return `<img src="${esc(b.logo.src)}" width="${b.logo.width}" height="${b.logo.height}" alt="${esc(b.name)}" style="display:block;border:0;outline:none;height:auto;max-width:100%">` +
      `<p style="margin:10px 0 0;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${b.headerMuted}">Website contact form</p>`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:middle"><img src="${esc(b.tile)}" width="40" height="40" alt="" style="display:block;border:0;outline:none;border-radius:10px"></td>` +
    `<td style="vertical-align:middle;padding-left:12px;font-family:${FONT}">` +
    `<p style="margin:0;font-size:17px;font-weight:800;letter-spacing:-.01em;color:${b.headerText}">${esc(b.name)}</p>` +
    `<p style="margin:2px 0 0;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${b.headerMuted}">Website contact form</p>` +
    `</td></tr></table>`;
}

export function renderEnquiryBody(b, e) {
  const rows = e.fields.map(([label, value, href], i) => {
    const top = i === 0 ? '' : `border-top:1px solid ${b.line};`;
    const val = href ? `<a href="${esc(href)}" style="color:${b.accent};text-decoration:underline">${esc(value)}</a>` : esc(value);
    return `<tr><td width="34%" style="${top}padding:10px 12px 10px 0;vertical-align:top;font-family:${FONT};font-size:13px;color:${b.muted}">${esc(label)}</td>` +
      `<td style="${top}padding:10px 0;vertical-align:top;font-family:${FONT};font-size:15px;line-height:1.45;color:${b.text}">${val}</td></tr>`;
  }).join('');
  const message = esc(e.message).replace(/\n/g, '<br>');
  const secondary = e.secondary
    ? `<td style="padding-left:18px;vertical-align:middle;font-family:${FONT};font-size:14px"><a href="${esc(e.secondary.href)}" style="color:${b.accent};text-decoration:underline">${esc(e.secondary.label)}</a></td>`
    : '';
  const pre = e.preheader || String(e.message).replace(/\s+/g, ' ').slice(0, 110);
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${b.line};border-radius:14px;border-collapse:separate">
<tr><td style="background:${b.header};border-radius:14px 14px 0 0;padding:20px 28px;${b.headerRule ? `border-bottom:1px solid ${b.line};` : ''}">${brandBlock(b)}</td></tr>
<tr><td style="padding:28px 28px 0;font-family:${FONT}">
<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${b.accent}">${esc(e.kind)}</p>
<h1 style="margin:0 0 18px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.01em;color:${b.text}">${esc(e.title)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
</td></tr>
<tr><td style="padding:18px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${b.tint};border:1px solid ${b.line};border-radius:10px;border-collapse:separate"><tr><td style="padding:18px 20px;font-family:${FONT}">
<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${b.muted}">${esc(e.messageLabel || 'Message')}</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:${b.text}">${message}</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 28px 26px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${b.button};border-radius:999px"><a href="${esc(e.primary.href)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;font-weight:700;color:${b.buttonText};text-decoration:none;border-radius:999px">${esc(e.primary.label)}</a></td>${secondary}
</tr></table>
${e.note ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${b.muted}">${esc(e.note)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px 20px;border-top:1px solid ${b.line};font-family:${FONT};font-size:12px;line-height:1.6;color:${b.muted}">${esc(e.footer)}</td></tr>
</table>
<p style="margin:14px 0 0;font-family:${FONT};font-size:11px;color:${b.muted}">${esc(b.name)} &middot; ${esc(b.site)}</p>
</td></tr></table>`;
}

export function renderEnquiryEmail(b, e) {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(e.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${b.page}">${renderEnquiryBody(b, e)}</body></html>`;
  const text = [
    `${b.name}: ${e.kind}`, '', e.title, '',
    ...e.fields.map(([l, v]) => `${l}: ${v}`), '',
    `${e.messageLabel || 'Message'}:`, e.message, '',
    `${e.primary.label}: ${e.primary.href}`,
    e.secondary ? `${e.secondary.label}: ${e.secondary.href}` : null,
    e.note || null, '', e.footer,
  ].filter(l => l !== null).join('\n');
  return { html, text };
}
