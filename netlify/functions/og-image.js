/**
 * og-image.js
 * Netlify Function — generates branded SVG images on demand.
 *
 * Types:
 *   ?type=og       1200×630  dark bg — for <meta og:image> social sharing
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

/* ─── OG image: 1200×630, dark background ─────────────────────────── */
function ogSVG (title, label, desc) {
  const AMBER  = '#985830';
  const INK    = '#1A1A1A';
  const WHITE  = '#FFFFFF';
  const DIMMED = 'rgba(255,255,255,0.55)';
  const MUTED  = 'rgba(255,255,255,0.28)';
  const FONT   = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  const lines      = wrapText(title, 36);
  const lineH      = 68;
  const labelH     = 34;
  const labelGap   = 18;
  const descH      = desc ? 34 : 0;
  const descGap    = desc ? 16 : 0;
  const blockH     = labelH + labelGap + lines.length * lineH + descH + descGap;
  const blockStart = Math.round((630 - blockH) / 2) + 8; // slightly above centre

  const labelW    = label.toUpperCase().length * 8.4 + 28;
  const labelY    = blockStart;
  const titleY    = blockStart + labelH + labelGap;
  const descY     = titleY + lines.length * lineH + descGap;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>text { font-family: ${FONT}; }</style>
  </defs>
  <!-- Background -->
  <rect width="1200" height="630" fill="${INK}"/>
  <!-- Amber left bar -->
  <rect x="0" y="0" width="10" height="630" fill="${AMBER}"/>
  <!-- Subtle top gradient -->
  <defs>
    <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AMBER}" stop-opacity="0.07"/>
      <stop offset="1" stop-color="${AMBER}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="10" y="0" width="1190" height="200" fill="url(#tg)"/>

  <!-- Phillips. wordmark -->
  <text x="52" y="66" font-size="24" font-weight="700" letter-spacing="-0.3" fill="${WHITE}">Phillips<tspan fill="${AMBER}">.</tspan></text>

  <!-- Label chip -->
  <rect x="52" y="${labelY}" width="${labelW}" height="${labelH}" rx="4" fill="${AMBER}"/>
  <text x="${52 + labelW / 2}" y="${labelY + 22}" font-size="12" font-weight="700" letter-spacing="1.8" text-anchor="middle" fill="${WHITE}">${x(label.toUpperCase())}</text>

  <!-- Title -->
  ${lines.map((line, i) => `<text x="52" y="${titleY + i * lineH + 50}" font-size="56" font-weight="700" letter-spacing="-1.2" fill="${WHITE}">${x(line)}</text>`).join('\n  ')}

  <!-- Description -->
  ${desc ? `<text x="52" y="${descY + 50}" font-size="22" fill="${DIMMED}">${x(clip(desc, 90))}</text>` : ''}

  <!-- Bottom bar -->
  <text x="52" y="604" font-size="16" letter-spacing="0.3" fill="${MUTED}">phillips-uk.com</text>
  <text x="1148" y="604" font-size="22" font-weight="700" text-anchor="end" fill="${AMBER}">P.</text>
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
