/**
 * audit-share.js
 * Netlify Function — server-side rendered shareable audit result page.
 *
 * Served at /r/:id via netlify.toml redirect.
 * GET /.netlify/functions/audit-share?id={uuid}
 */

const { getStore } = require('@netlify/blobs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

exports.handler = async function (event) {
  const id = (event.queryStringParameters || {}).id || '';

  if (!UUID_RE.test(id)) {
    return redirect('/landing-page-audit');
  }

  let stored = null;
  try {
    const store = getStore({
      name:   'landing-audits',
      siteID: process.env.NETLIFY_SITE_ID,
      token:  process.env.NETLIFY_PERSONAL_TOKEN
    });
    stored = await store.get(id, { type: 'json' });
  } catch (e) {
    console.error('audit-share blob error:', e.message);
  }

  if (!stored) return html(pendingPage(id), 200);

  if (stored.status === 'error')   return redirect('/landing-page-audit');
  if (stored.status === 'pending') return html(pendingPage(id), 200);
  if (stored.status !== 'complete' || !stored.data) return html(pendingPage(id), 200);

  return html(buildPage(id, stored.data), 200);
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function redirect(to) {
  return { statusCode: 302, headers: { Location: to }, body: '' };
}

function html(body, status) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    body
  };
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return iso; }
}

// Metric colour class
function metricClass(type, val) {
  if (val == null || val === 'N/A') return 'm-na';
  if (type === 'lcp') {
    const ms = parseLcpMs(val);
    if (ms == null) return 'm-na';
    return ms <= 2500 ? 'm-good' : ms <= 4000 ? 'm-ok' : 'm-poor';
  }
  if (type === 'cls') {
    const n = parseFloat(val);
    return n <= 0.1 ? 'm-good' : n <= 0.25 ? 'm-ok' : 'm-poor';
  }
  if (type === 'score') {
    const n = parseInt(val, 10);
    return n >= 90 ? 'm-good' : n >= 50 ? 'm-ok' : 'm-poor';
  }
  return '';
}

function tierLabel(cls) {
  return cls === 'm-good' ? 'Good' : cls === 'm-ok' ? 'Needs improvement' : cls === 'm-poor' ? 'Poor' : 'N/A';
}

function parseLcpMs(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 1000);
}

// Score band → badge colour
function bandColour(band) {
  const map = {
    'Strong':      '#2E7D32',
    'Average':     '#D4691B',
    'Needs work':  '#BF360C',
    'Critical':    '#C0392B'
  };
  return map[band] || '#6B6B6B';
}

function sevColour(sev) {
  return sev === 'critical' ? '#C0392B' : sev === 'high' ? '#D4691B' : sev === 'medium' ? '#D97706' : '#6B6B6B';
}

// ── Pending page ──────────────────────────────────────────────────────────────

function pendingPage(id) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit in progress · Phillips.</title>
<meta name="robots" content="noindex">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;background:#FDF6EE;color:#1A1A1A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;-webkit-font-smoothing:antialiased}
.box{background:#fff;border:1px solid #E8D8C4;border-radius:16px;padding:48px 40px;max-width:440px;width:100%;text-align:center}
.logo{font-size:20px;font-weight:700;color:#1A1A1A;margin-bottom:36px;display:block}
.logo span{color:#985830}
.spinner{width:40px;height:40px;border:3px solid #E8D8C4;border-top-color:#985830;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 24px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:20px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px}
p{font-size:14px;color:#6B6B6B;line-height:1.6;margin-bottom:24px}
a{color:#985830;font-size:14px;font-weight:600;text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="box">
  <a class="logo" href="https://www.phillips-uk.com">Phillips<span>.</span></a>
  <div class="spinner"></div>
  <h1>Audit still running</h1>
  <p>This report is being generated — it takes around 60 seconds. Check back shortly or return to the audit tool.</p>
  <a href="https://www.phillips-uk.com/landing-page-audit?id=${esc(id)}">Return to audit →</a>
</div>
</body>
</html>`;
}

// ── Full result page ──────────────────────────────────────────────────────────

function buildPage(id, r) {
  const dom      = esc(domain(r.url));
  const score    = r.health_score ?? '—';
  const band     = r.score_band   || '';
  const kw       = r.inferred_keyword || '';
  const date     = formatDate(r.audited_at);
  const perf     = (r.categories || {}).performance || {};
  const issues   = (r.findings || []).filter(f => f.severity !== 'pass' && f.severity !== 'info');
  const nIssues  = issues.length;
  const actions  = (r.priority_actions || []).slice(0, 3);

  const lcp     = perf.lcp       || 'N/A';
  const cls     = perf.cls != null ? perf.cls : 'N/A';
  const inp     = perf.inp       || 'N/A';
  const ttfb    = perf.ttfb      || 'N/A';
  const mob     = perf.mobile_score  != null ? perf.mobile_score : 'N/A';
  const desk    = perf.desktop_score != null ? perf.desktop_score : 'N/A';

  const lcpCls  = metricClass('lcp',   lcp);
  const clsCls  = metricClass('cls',   cls);
  const mobCls  = metricClass('score', mob);
  const deskCls = metricClass('score', desk);

  const bandCol = bandColour(band);

  // OG / meta values
  const pageUrl  = `https://www.phillips-uk.com/r/${esc(id)}`;
  const kwPart   = kw ? ` · "${esc(kw)}"` : '';
  const metaDesc = `${esc(band)} · Score: ${score}/100${kwPart} · Free paid media landing page diagnosis by Phillips.`;
  const ogTitle  = `${dom} — ${score}/100 · Landing Page Audit`;
  const ogDesc   = `${esc(band)} · ${nIssues} issue${nIssues !== 1 ? 's' : ''} found${kwPart}`;
  const ogLabel  = encodeURIComponent(`Landing Page Audit · ${domain(r.url)}`);
  const ogStat   = encodeURIComponent(`${score}/100`);
  const ogDescE  = encodeURIComponent(band);
  const ogImage  = `https://www.phillips-uk.com/.netlify/functions/og-image?type=stat&stat=${ogStat}&label=${ogLabel}&desc=${ogDescE}`;

  function metricCell(label, val, cls) {
    const tier = tierLabel(cls);
    const dispVal = val === 'N/A' || val == null ? 'N/A' : esc(String(val));
    return `<div style="padding:20px 18px;border-right:1px solid #E8D8C4;border-bottom:1px solid #E8D8C4;background:#FDF6EE">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6B6B6B;margin-bottom:10px">${label}</div>
      <div style="font-size:26px;font-weight:700;letter-spacing:-1px;line-height:1;color:${cls==='m-good'?'#2E7D32':cls==='m-ok'?'#D4691B':cls==='m-poor'?'#C0392B':'#ccc'};margin-bottom:6px">${dispVal}</div>
      <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${cls==='m-good'?'#2E7D32':cls==='m-ok'?'#D4691B':cls==='m-poor'?'#C0392B':'#ccc'}">${cls==='m-na'?'No data':tier}</div>
    </div>`;
  }

  function actionRow(a, i) {
    const col = sevColour(a.severity || 'medium');
    const badge = `<span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:2px 7px;border-radius:3px;background:${col}20;color:${col};border:1px solid ${col}40;margin-bottom:6px">${esc(a.severity || 'medium')}</span>`;
    return `<div style="display:flex;gap:16px;padding:16px 0;border-bottom:1px solid #E8D8C4;align-items:flex-start">
      <div style="font-size:11px;font-weight:700;color:#985830;padding-top:3px;width:18px;flex-shrink:0">${i + 1}</div>
      <div>
        ${badge}
        <div style="font-size:15px;font-weight:700;color:#1A1A1A;margin-bottom:4px">${esc(a.title)}</div>
        <div style="font-size:13px;color:#6B6B6B;line-height:1.6">${esc(a.fix)}</div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${dom} — ${score}/100 Landing Page Audit · Phillips.</title>
<meta name="description" content="${metaDesc}">

<meta property="og:type"        content="website">
<meta property="og:url"         content="${pageUrl}">
<meta property="og:title"       content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image"       content="${ogImage}">
<meta property="og:image:width" content="720">
<meta property="og:image:height" content="380">

<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image"       content="${ogImage}">

<link rel="canonical" href="${pageUrl}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">

<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1A1A1A;background:#fff;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
@media(max-width:600px){
  .metrics-grid{grid-template-columns:repeat(2,1fr)!important}
  .metrics-grid>div:nth-child(2n){border-right:none!important}
  .hero-score{font-size:72px!important;letter-spacing:-4px!important}
  .container{padding:32px 16px 60px!important}
  .nav-inner{padding:0 20px!important}
}
</style>
</head>
<body>

<!-- Nav -->
<nav style="position:sticky;top:0;background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);border-bottom:1px solid #E8D8C4;z-index:100;height:64px;display:flex;align-items:center">
  <div class="nav-inner" style="width:100%;max-width:720px;margin:0 auto;padding:0 32px;display:flex;align-items:center;justify-content:space-between">
    <a href="https://www.phillips-uk.com" style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#1A1A1A">Phillips<span style="color:#985830">.</span></a>
    <a href="https://www.phillips-uk.com/landing-page-audit" style="font-size:13px;font-weight:600;letter-spacing:0.03em;color:#985830;border:1.5px solid #985830;padding:7px 16px;border-radius:4px">← Run an audit</a>
  </div>
</nav>

<div class="container" style="max-width:720px;margin:0 auto;padding:48px 32px 80px">

  <!-- Hero (dark) -->
  <div style="background:#1A1A1A;border-radius:14px 14px 0 0;padding:44px 40px 40px;text-align:center">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#985830;margin-bottom:16px">Landing Page Audit</div>
    <div style="font-size:clamp(22px,4vw,32px);font-weight:700;letter-spacing:-0.02em;color:#fff;margin-bottom:24px;word-break:break-all">${dom}</div>
    <div class="hero-score" style="font-size:96px;font-weight:700;letter-spacing:-5px;line-height:1;color:#985830;margin-bottom:16px">${score}</div>
    <div style="font-size:18px;color:rgba(255,255,255,0.35);margin-top:-8px;margin-bottom:20px">/ 100</div>
    <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:3px;color:#fff;background:${bandCol};margin-bottom:${kw?'20px':'16px'}">${esc(band)}</span>
    ${kw ? `<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px"><span style="color:#985830;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase">Keyword · </span>${esc(kw)}</div>` : ''}
    <div style="font-size:12px;color:rgba(255,255,255,0.35)">${esc(date)}</div>
  </div>

  <!-- Metrics row -->
  <div class="metrics-grid" style="display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #E8D8C4;border-top:none;border-radius:0 0 14px 14px;overflow:hidden;margin-bottom:48px">
    ${metricCell('LCP',     lcp,  lcpCls)}
    ${metricCell('CLS',     String(cls), clsCls)}
    ${metricCell('INP',     inp,  '')}
    ${metricCell('TTFB',    ttfb, '')}
    ${metricCell('Mobile',  String(mob)  + (mob !== 'N/A' ? '' : ''), mobCls)}
    <div style="padding:20px 18px;border-bottom:1px solid #E8D8C4;background:#FDF6EE">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6B6B6B;margin-bottom:10px">Desktop</div>
      <div style="font-size:26px;font-weight:700;letter-spacing:-1px;line-height:1;color:${deskCls==='m-good'?'#2E7D32':deskCls==='m-ok'?'#D4691B':deskCls==='m-poor'?'#C0392B':'#ccc'};margin-bottom:6px">${desk === 'N/A' ? 'N/A' : esc(String(desk))}</div>
      <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${deskCls==='m-good'?'#2E7D32':deskCls==='m-ok'?'#D4691B':deskCls==='m-poor'?'#C0392B':'#ccc'}">${deskCls==='m-na'?'No data':tierLabel(deskCls)}</div>
    </div>
  </div>

  ${actions.length ? `
  <!-- Priority actions -->
  <div style="border-top:1px solid #E8D8C4;padding-top:40px;margin-bottom:48px">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#985830;margin-bottom:4px">Priority actions</div>
    <div style="font-size:13px;color:#6B6B6B;margin-bottom:24px">Top ${actions.length} issue${actions.length !== 1 ? 's' : ''} to fix first — ${nIssues} total found</div>
    ${actions.map((a, i) => actionRow(a, i)).join('')}
  </div>
  ` : ''}

  <!-- CTA -->
  <div style="text-align:center;padding:40px 32px;background:#FDF6EE;border:1px solid #E8D8C4;border-radius:12px;margin-bottom:48px">
    <div style="font-size:13px;color:#6B6B6B;margin-bottom:20px">See the full report — all findings, fixes, and the complete keyword analysis.</div>
    <a href="https://www.phillips-uk.com/landing-page-audit?id=${esc(id)}" style="display:inline-flex;align-items:center;gap:8px;background:#985830;color:#fff;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;margin-bottom:12px">View Full Report →</a>
    <div>
      <a href="https://www.phillips-uk.com/landing-page-audit" style="display:inline-flex;align-items:center;gap:8px;color:#985830;border:1.5px solid #985830;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-top:8px">Audit your page →</a>
    </div>
  </div>

</div><!-- /.container -->

<!-- Footer -->
<footer style="border-top:1px solid #E8D8C4;padding:24px 32px;text-align:center;font-size:13px;color:#6B6B6B">
  <a href="https://www.phillips-uk.com" style="font-weight:700;color:#1A1A1A">Phillips<span style="color:#985830">.</span></a> · <a href="https://www.phillips-uk.com" style="color:#6B6B6B">phillips-uk.com</a>
</footer>

</body>
</html>`;
}
