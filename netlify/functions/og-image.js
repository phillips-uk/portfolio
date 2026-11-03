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
      'Cache-Control': 'public, max-age=86400, s-maxage=3600',
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

  <!-- Phillips. lockup (il mark, outlined Manrope name, peach full stop) -->
  <g transform="translate(39.16 36.56) scale(0.24)"><g transform="translate(0 0) scale(1.08) translate(-40 -40)"><g fill="none" stroke="#FFFFFF" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"><path d="M88 124C88 140 88 156 88 172"/><path d="M152 68C152 102.67 152 137.33 152 172"/></g><circle cx="88" cy="76" r="14" fill="#FFFFFF"/></g><path d="M227 122.67V50.67H256.75Q257.8 50.67 259.45 50.74Q261.1 50.82 262.5 51.07Q268.75 52.02 272.83 55.22Q276.9 58.42 278.88 63.29Q280.85 68.17 280.85 74.12Q280.85 80.02 278.85 84.89Q276.85 89.77 272.78 92.97Q268.7 96.17 262.5 97.12Q261.1 97.32 259.43 97.42Q257.75 97.52 256.75 97.52H239.05V122.67ZM239.05 86.27H256.25Q257.25 86.27 258.5 86.17Q259.75 86.07 260.8 85.77Q263.8 85.02 265.52 83.12Q267.25 81.22 267.98 78.82Q268.7 76.42 268.7 74.12Q268.7 71.82 267.98 69.39Q267.25 66.97 265.52 65.07Q263.8 63.17 260.8 62.42Q259.75 62.12 258.5 62.04Q257.25 61.97 256.25 61.97H239.05ZM324.7 122.67V96.67Q324.7 94.12 324.35 91.02Q324 87.92 322.73 85.04Q321.45 82.17 318.93 80.32Q316.4 78.47 312.1 78.47Q309.8 78.47 307.55 79.22Q305.3 79.97 303.48 81.79Q301.65 83.62 300.55 86.79Q299.45 89.97 299.45 94.92L292.3 91.87Q292.3 84.97 294.98 79.37Q297.65 73.77 302.85 70.44Q308.05 67.12 315.65 67.12Q321.65 67.12 325.55 69.12Q329.45 71.12 331.75 74.22Q334.05 77.32 335.15 80.82Q336.25 84.32 336.58 87.44Q336.9 90.57 336.9 92.52V122.67ZM287.25 122.67V50.67H298V88.57H299.45V122.67ZM347.4 60.47V49.42H359.45V60.47ZM347.4 122.67V68.67H359.45V122.67ZM371.95 122.67V49.17H384V122.67ZM396.5 122.67V49.17H408.55V122.67ZM421.05 60.47V49.42H433.1V60.47ZM421.05 122.67V68.67H433.1V122.67ZM470.55 124.17Q462.65 124.17 457.3 120.42Q451.95 116.67 449.25 110.19Q446.55 103.72 446.55 95.67Q446.55 87.52 449.25 81.07Q451.95 74.62 457.18 70.89Q462.4 67.17 470.1 67.17Q477.75 67.17 483.38 70.89Q489 74.62 492.1 81.04Q495.2 87.47 495.2 95.67Q495.2 103.77 492.15 110.22Q489.1 116.67 483.55 120.42Q478 124.17 470.55 124.17ZM444.5 146.67V68.67H455.15V106.57H456.65V146.67ZM468.7 113.37Q473.4 113.37 476.45 111.02Q479.5 108.67 480.98 104.64Q482.45 100.62 482.45 95.67Q482.45 90.77 480.95 86.74Q479.45 82.72 476.3 80.34Q473.15 77.97 468.3 77.97Q463.7 77.97 460.8 80.19Q457.9 82.42 456.53 86.39Q455.15 90.37 455.15 95.67Q455.15 100.92 456.53 104.92Q457.9 108.92 460.88 111.14Q463.85 113.37 468.7 113.37ZM522.3 124.17Q512.3 124.17 506.05 119.67Q499.8 115.17 498.45 107.02L510.75 105.12Q511.7 109.12 514.95 111.42Q518.2 113.72 523.15 113.72Q527.5 113.72 529.88 111.99Q532.25 110.27 532.25 107.27Q532.25 105.42 531.38 104.29Q530.5 103.17 527.55 102.12Q524.6 101.07 518.5 99.47Q511.7 97.67 507.7 95.59Q503.7 93.52 501.95 90.67Q500.2 87.82 500.2 83.77Q500.2 78.72 502.85 74.97Q505.5 71.22 510.25 69.19Q515 67.17 521.45 67.17Q527.75 67.17 532.62 69.12Q537.5 71.07 540.5 74.67Q543.5 78.27 544.2 83.12L531.9 85.32Q531.45 81.87 528.78 79.87Q526.1 77.87 521.65 77.62Q517.4 77.37 514.8 78.89Q512.2 80.42 512.2 83.17Q512.2 84.72 513.25 85.82Q514.3 86.92 517.48 88.02Q520.65 89.12 526.95 90.72Q533.4 92.37 537.28 94.49Q541.15 96.62 542.88 99.57Q544.6 102.52 544.6 106.72Q544.6 114.87 538.67 119.52Q532.75 124.17 522.3 124.17Z" fill="#FFFFFF"/><circle cx="562.6" cy="114.67" r="8" fill="#F6C7A1"/></g>

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
  const FONT   = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  const labelW = label.toUpperCase().length * 8 + 24;

  // Try single line at 36px (fits ~30 chars). If longer, wrap at 28px.
  let lines    = wrapText(title, 30);
  let fontSize = 36;
  let lineH    = 46;
  let titleY   = 140;   // baseline of first (and only) line

  if (lines.length > 1) {
    lines    = wrapText(title, 40);
    fontSize = 28;
    lineH    = 38;
    titleY   = 118;     // first line baseline — two lines fit before 200px edge
  }

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

  <!-- Title (wrapped) -->
  ${lines.map((line, i) => `<text x="32" y="${titleY + i * lineH}" font-size="${fontSize}" font-weight="700" letter-spacing="-0.5" fill="${INK}">${x(line)}</text>`).join('\n  ')}
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
  <text x="360" y="${desc ? 210 : 230}" font-size="${statFs}" font-weight="700" letter-spacing="-1" text-anchor="middle" fill="${AMBER}">${x(stat)}</text>

  <!-- Label -->
  <text x="360" y="${desc ? 275 : 295}" font-size="22" text-anchor="middle" fill="${MID}">${x(label)}</text>

  <!-- Description -->
  ${desc ? `<text x="360" y="320" font-size="16" text-anchor="middle" fill="${MID}">${x(clip(desc, 70))}</text>` : ''}
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
