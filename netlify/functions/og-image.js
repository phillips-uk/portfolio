/**
 * og-image.js
 * Netlify Function — generates branded SVG images on demand.
 *
 * Types:
 *   ?type=og       1200×630  amber bg — for <meta og:image> social sharing
 *   ?type=section  720×200   cream bg — for in-guide section header images
 *   ?type=stat     720×380   cream bg — for large stat callout images
 *
 * Params:
 *   title    Page or section title
 *   label    Chip label (e.g. "Guide", "Google Ads")
 *   desc     Short descriptor line
 *   stat     Large number/value for stat type (e.g. "30–50%")
 */

exports.handler = async function (event) {
  const q     = event.queryStringParameters || {};
  const type  = q.type  || 'og';
  const title = safeParam(q.title, 'Phillips.');
  const label = safeParam(q.label, 'Guide');
  const desc  = safeParam(q.desc,  '');
  const stat  = safeParam(q.stat,  '');

  let svg;
  if (type === 'section') svg = sectionSVG(title, label);
  else if (type === 'stat') svg = statSVG(stat, label, desc);
  else svg = ogSVG(title, label, desc);

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Content-Type-Options': 'nosniff',
    },
    body: svg,
  };
};

/* ─── OG image: 1200×630, amber background ────────────────────────── */
function ogSVG (title, label, desc) {
  const AMBER       = '#985830';
  const AMBER_DARK  = '#7a4525';  // deeper amber for depth
  const AMBER_LIGHT = 'rgba(255,255,255,0.12)'; // subtle white overlay
  const WHITE       = '#FFFFFF';
  const WHITE_DIM   = 'rgba(255,255,255,0.70)';
  const WHITE_MUTED = 'rgba(255,255,255,0.40)';
  const FONT        = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  const lines      = wrapText(title, 34);
  const lineH      = 70;
  const labelH     = 34;
  const labelGap   = 20;
  const descH      = desc ? 32 : 0;
  const descGap    = desc ? 18 : 0;
  const blockH     = labelH + labelGap + lines.length * lineH + descH + descGap;
  const blockStart = Math.round((630 - blockH) / 2) + 4;

  const labelW = label.toUpperCase().length * 8.4 + 28;
  const labelY = blockStart;
  const titleY = blockStart + labelH + labelGap;
  const descY  = titleY + lines.length * lineH + descGap;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>text { font-family: ${FONT}; }</style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"   stop-color="${AMBER_DARK}"/>
      <stop offset="100%" stop-color="${AMBER}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="${WHITE}" stop-opacity="0.08"/>
      <stop offset="0.5" stop-color="${WHITE}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Amber background with subtle diagonal gradient -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- Subtle top shine -->
  <rect width="1200" height="320" fill="url(#shine)"/>
  <!-- White left bar — thin, clean anchor -->
  <rect x="0" y="0" width="6" height="630" fill="${WHITE}" opacity="0.5"/>

  <!-- Phillips. wordmark — white -->
  <text x="48" y="66" font-size="24" font-weight="700" letter-spacing="-0.3" fill="${WHITE}">Phillips<tspan opacity="0.6">.</tspan></text>

  <!-- Label chip — white bg, amber text (inverted for contrast) -->
  <rect x="48" y="${labelY}" width="${labelW}" height="${labelH}" rx="4" fill="${WHITE}"/>
  <text x="${48 + labelW / 2}" y="${labelY + 22}" font-size="12" font-weight="700" letter-spacing="1.8" text-anchor="middle" fill="${AMBER}">${x(label.toUpperCase())}</text>

  <!-- Title — white, large -->
  ${lines.map((line, i) => `<text x="48" y="${titleY + i * lineH + 52}" font-size="58" font-weight="700" letter-spacing="-1.4" fill="${WHITE}">${x(line)}</text>`).join('\n  ')}

  <!-- Description -->
  ${desc ? `<text x="48" y="${descY + 50}" font-size="22" fill="${WHITE_DIM}">${x(clip(desc, 88))}</text>` : ''}

</svg>`;
}

/* ─── Section header: 720×200, cream background ────────────────────── */
function sectionSVG (title, label) {
  const AMBER  = '#985830';
  const INK    = '#1A1A1A';
  const CREAM  = '#FDF6EE';
  const BORDER = '#E8D8C4';
  const MID    = '#6B6B6B';
  const FONT   = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  const labelW = label.toUpperCase().length * 8 + 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="200" viewBox="0 0 720 200">
  <defs>
    <style>text { font-family: ${FONT}; }</style>
  </defs>
  <!-- Background -->
  <rect width="720" height="200" fill="${CREAM}"/>
  <!-- Bottom border -->
  <rect x="0" y="199" width="720" height="1" fill="${BORDER}"/>
  <!-- Amber left bar -->
  <rect x="0" y="0" width="6" height="200" fill="${AMBER}"/>

  <!-- Label chip -->
  <rect x="32" y="44" width="${labelW}" height="26" rx="3" fill="${AMBER}"/>
  <text x="${32 + labelW / 2}" y="61" font-size="11" font-weight="700" letter-spacing="1.5" text-anchor="middle" fill="#FFFFFF">${x(label.toUpperCase())}</text>

  <!-- Title -->
  <text x="32" y="140" font-size="38" font-weight="700" letter-spacing="-0.8" fill="${INK}">${x(clip(title, 52))}</text>

  <!-- Phillips. watermark -->
  <text x="688" y="180" font-size="15" font-weight="700" text-anchor="end" fill="${BORDER}">Phillips<tspan fill="${AMBER}">.</tspan></text>
</svg>`;
}

/* ─── Stat callout: 720×380, cream background ──────────────────────── */
function statSVG (stat, label, desc) {
  const AMBER  = '#985830';
  const INK    = '#1A1A1A';
  const CREAM  = '#FDF6EE';
  const BORDER = '#E8D8C4';
  const MID    = '#6B6B6B';
  const FONT   = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  // Scale stat font size based on length
  const statFs = stat.length <= 4 ? 160 : stat.length <= 6 ? 130 : 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="380" viewBox="0 0 720 380">
  <defs>
    <style>text { font-family: ${FONT}; }</style>
  </defs>
  <!-- Background -->
  <rect width="720" height="380" fill="${CREAM}"/>
  <rect x="0" y="0" width="6" height="380" fill="${AMBER}"/>
  <rect x="0" y="379" width="720" height="1" fill="${BORDER}"/>

  <!-- Stat number -->
  <text x="360" y="${desc ? 200 : 220}" font-size="${statFs}" font-weight="700" letter-spacing="-3" text-anchor="middle" fill="${AMBER}">${x(stat)}</text>

  <!-- Label -->
  <text x="360" y="${desc ? 260 : 280}" font-size="22" text-anchor="middle" fill="${MID}">${x(label)}</text>

  <!-- Description -->
  ${desc ? `<text x="360" y="310" font-size="16" text-anchor="middle" fill="${MID}">${x(clip(desc, 70))}</text>` : ''}

  <!-- Phillips. -->
  <text x="360" y="358" font-size="15" font-weight="700" text-anchor="middle" fill="${BORDER}">Phillips<tspan fill="${AMBER}">.</tspan></text>
</svg>`;
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

function safeParam (raw, fallback) {
  if (!raw) return fallback;
  try { return decodeURIComponent(raw).trim() || fallback; }
  catch { return fallback; }
}

// Wrap text to max chars per line, respecting word boundaries
function wrapText (text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? cur + ' ' + word : word;
    if (candidate.length <= maxChars) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

// Clip string to max length with ellipsis
function clip (str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// XML escape for safe SVG text content
function x (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
