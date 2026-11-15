// The Monday Brief: a weekly "what's changed in marketing" issue on phillips-uk.com/updates/ and by email every Monday
// at 07:00 UK time to people who signed up and confirmed (double opt-in). Plan: vault
// 01_Phillips/02_Website/05_Weekly Updates Plan.md.
//
// R2 (BLOBS) keys, all under brief/:
//   issues/<date>.json       an issue's content, written by the weekly drafting session (date = the Monday it goes out)
//   state/<date>.json        its approval and send state (kept apart, so re-uploading content can't reset a send)
//   index.json               published issues, newest first (the archive, feed and sitemap read this)
//   subscribers/<hash>.json  one record per email address: consent log, confirmed or pending
//   tokens/<hash>.json       confirmation tokens (only the hash of each token is stored)
//   config.json              the Resend segment the issues are sent to
//
// Mail goes through Resend: confirmation emails and Lewis's notes as single emails (free plan: 100 a day, 3,000 a
// month, shared with the contact form), each issue as one Broadcast to the segment (free plan: 1,000 contacts,
// broadcasts not counted against the daily limit). Resend adds the per-person unsubscribe link.
// An issue is emailed only after Lewis approves it in /admin, and only once.
import pageShell from '../private/brief-page.html';

export const NAME = 'The Monday Brief';
const SITE = 'https://www.phillips-uk.com';
const FROM = 'Lewis Phillips <updates@phillips-uk.com>';
const REPLY_TO = 'lewis@phillips-uk.com';
const NOTE_FROM = 'Phillips. website <website@phillips-uk.com>';
const NOTE_TO = 'lewis@phillips-uk.com';
const INDEXNOW_KEY = 'c16543d0048f2c95ad3738e0c5b0a2a7';
const LEGAL = 'Phillips. is a trading name of PHILLIPSGROUPUK LIMITED, a company registered in England and Wales (company number 17567515). Registered office: 124-128 City Road, London, EC1V 2NX.';

// Cron triggers (wrangler.jsonc), told apart by the London day and hour, not by the cron string:
// Monday 06:00 and 07:00 UTC both fire and only the one that is 07:00 in London sends (BST and GMT);
// the Friday one tells Lewis whether Monday's draft is ready; the Sunday one reminds him if it isn't approved.

const TOKEN_DAYS = 7;          // confirmation links expire, and unconfirmed sign-ups are deleted, after this
const MIN_MS = 2000;           // a person needs longer than this to type an email address
const RATE_MAX = 5;            // sign-ups per connection per hour
const PER_ADDRESS_MAX = 3;     // confirmation emails to one address per day, so the form can't be used to pester someone

// The words next to the sign-up button. A new version gets a new key; each sign-up stores the key it agreed to.
export const CONSENT = {
  v1: 'One email every Monday morning on what changed in the ad and search platforms, and what it means for your account. I email you first to confirm. Unsubscribe any time.',
};
const CONSENT_NOW = 'v1';

const PLATFORMS = 'Google Ads, GA4, SEO, Merchant Center, Microsoft Ads, Meta, Apple Ads and LinkedIn Ads';

// The EMAIL is paused until the first real subscriber confirms (Lewis, 15 Nov 2026: no point emailing with nobody
// signed up; keep the writing on). Until then the weekly routine runs as normal but an approved issue is only published
// on the website. Lewis's own addresses don't count. The moment someone else confirms, brief/config.json gets
// "startedAt", Lewis gets an email, and approved issues are emailed from then on.
const OWN = ['lewis@phillips-uk.com', 'lewis@phillips-group.uk', 'lewisdp87@gmail.com', 'contact@phillips-uk.com'];

/* ---------------- small helpers ---------------- */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function utcDate(s) { return new Date(s + 'T12:00:00Z'); }
function addDays(s, n) { const d = utcDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function isMonday(s) { return DATE.test(s) && utcDate(s).getUTCDay() === 1; }
export function longDate(s) { const d = utcDate(s); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function dayMonth(s) { const d = utcDate(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
function dayMonthYear(s) { const d = utcDate(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function coversText(c) {
  if (!c || !DATE.test(c.from || '') || !DATE.test(c.to || '')) return '';
  const a = utcDate(c.from), b = utcDate(c.to);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) return `${a.getUTCDate()} to ${dayMonthYear(c.to)}`;
  return `${dayMonth(c.from)} to ${dayMonthYear(c.to)}`;
}

export function londonNow(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}
function nextMonday(s) { let d = s; for (let i = 0; i < 7; i++) { d = addDays(d, 1); if (isMonday(d)) return d; } return d; }

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getJson(env, key) {
  const o = await env.BLOBS.get(key);
  if (!o) return null;
  try { return await o.json(); } catch { return null; }
}
async function putJson(env, key, value) {
  await env.BLOBS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
}
async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix, cursor });
    page.objects.forEach(o => keys.push(o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

const subKey = async email => 'brief/subscribers/' + (await sha('brief|' + email)).slice(0, 40) + '.json';
const tokenKey = async token => 'brief/tokens/' + (await sha('token|' + token)).slice(0, 40) + '.json';

/* ---------------- Resend ---------------- */

// Local dev has no Resend key: with BRIEF_DEV_OUTBOX set, every call is written to R2 (brief/dev-outbox/) and
// answered as if it worked, so the whole flow can be tested without sending anything.
async function resend(env, method, path, body) {
  const key = env.RESEND_LIST_KEY || env.RESEND_API_KEY;
  if (!key) {
    if (!env.BRIEF_DEV_OUTBOX) return { ok: false, status: 0, data: null, error: 'Resend is not set up (no key).' };
    const id = 'dev-' + crypto.randomUUID().slice(0, 8);
    await putJson(env, `brief/dev-outbox/${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.json`, { method, path, body });
    if (method === 'GET' && path === '/segments') return { ok: true, status: 200, data: { data: [] } };
    return { ok: true, status: 200, data: { id, object: 'dev' } };
  }
  try {
    const res = await fetch('https://api.resend.com' + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'phillips-uk-worker/1.0' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : ((data && (data.message || data.name)) || 'HTTP ' + res.status) };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: (err && err.message) || 'network error' };
  }
}

async function sendEmail(env, msg) {
  return resend(env, 'POST', '/emails', msg);
}

async function note(env, subject, lines) {
  const text = lines.filter(l => l != null).join('\n');
  const r = await sendEmail(env, { from: NOTE_FROM, to: [NOTE_TO], subject: `${NAME}: ${subject}`, text });
  if (!r.ok) console.error('brief note failed', r.error);
}

async function segmentId(env) {
  const cfg = (await getJson(env, 'brief/config.json')) || {};
  if (cfg.segmentId) return { ok: true, id: cfg.segmentId };
  const list = await resend(env, 'GET', '/segments');
  if (!list.ok) return { ok: false, error: list.error, status: list.status };
  const found = ((list.data && list.data.data) || []).find(s => s.name === NAME);
  let id = found && found.id;
  if (!id) {
    const made = await resend(env, 'POST', '/segments', { name: NAME });
    if (!made.ok) return { ok: false, error: made.error, status: made.status };
    id = made.data && made.data.id;
  }
  if (!id) return { ok: false, error: 'Resend did not return a segment id.' };
  await putJson(env, 'brief/config.json', { ...cfg, segmentId: id, segmentAt: new Date().toISOString() });
  return { ok: true, id };
}

// Put a confirmed address on the list: create the contact in the segment, or, if it already exists (for example
// someone who unsubscribed and has now confirmed again), mark it subscribed and add it to the segment.
async function addToList(env, email) {
  const seg = await segmentId(env);
  if (!seg.ok) return seg;
  const made = await resend(env, 'POST', '/contacts', { email, unsubscribed: false, segments: [{ id: seg.id }] });
  if (made.ok) return { ok: true };
  const upd = await resend(env, 'PATCH', '/contacts/' + encodeURIComponent(email), { unsubscribed: false });
  if (!upd.ok) return { ok: false, error: made.error + ' / ' + upd.error };
  const add = await resend(env, 'POST', `/contacts/${encodeURIComponent(email)}/segments/${seg.id}`);
  return add.ok || add.status === 409 || add.status === 422 ? { ok: true } : { ok: false, error: add.error };
}

/* ---------------- content ---------------- */

// Text in an issue is plain: blank lines start a new paragraph, lines starting "- " are bullet points.
function blocksHtml(text, pStyle = '', liStyle = '') {
  const out = [];
  String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).forEach(chunk => {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    if (lines.every(l => l.startsWith('- '))) {
      out.push(`<ul${pStyle ? ' style="margin:0 0 14px;padding-left:20px"' : ''}>` + lines.map(l => `<li${liStyle ? ` style="${liStyle}"` : ''}>${esc(l.slice(2))}</li>`).join('') + '</ul>');
    } else {
      out.push(`<p${pStyle ? ` style="${pStyle}"` : ''}>${esc(lines.join(' '))}</p>`);
    }
  });
  return out.join('');
}
function blocksText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(chunk => chunk.split('\n').map(l => l.trim()).filter(Boolean).join(chunk.split('\n').every(l => l.trim().startsWith('- ')) ? '\n' : ' ')).join('\n\n');
}

export const PARTS = [
  ['new', "What's new"],
  ['means', 'What it means'],
  ['affects', 'What it could affect in your account'],
  ['aware', 'What to be aware of'],
];

// Checks an issue file before it is shown or sent. Returns a list of problems (empty when it is fine).
export function checkIssue(c, date) {
  const p = [];
  if (!c || typeof c !== 'object') return ['The issue file is empty or not JSON.'];
  if (c.date !== date) p.push(`"date" should be ${date}.`);
  if (!isMonday(date)) p.push('The date must be a Monday.');
  if (!c.title || String(c.title).length > 140) p.push('"title" is missing or longer than 140 characters.');
  if (!c.summary) p.push('"summary" is missing.');
  if (!Array.isArray(c.items) || !c.items.length) p.push('"items" is empty.');
  (c.items || []).forEach((it, i) => {
    const n = `Item ${i + 1}`;
    if (!it.platform || !it.title) p.push(`${n}: "platform" and "title" are needed.`);
    PARTS.forEach(([k, label]) => { if (!it[k]) p.push(`${n}: "${k}" (${label}) is missing.`); });
    if (!Array.isArray(it.sources) || !it.sources.length) p.push(`${n}: needs at least one primary source.`);
    (it.sources || []).forEach(s => { if (!s || !/^https:\/\//.test(s.url || '') || !s.label) p.push(`${n}: each source needs a "label" and an https "url".`); });
    if (it.announced && !DATE.test(it.announced)) p.push(`${n}: "announced" should be YYYY-MM-DD.`);
    if (it.effective && !DATE.test(it.effective)) p.push(`${n}: "effective" should be YYYY-MM-DD.`);
    if (it.impact && !IMPACT[it.impact]) p.push(`${n}: "impact" should be action, watch or info.`);
    if (it.tldr && String(it.tldr).length > 200) p.push(`${n}: "tldr" should be one short sentence.`);
  });
  const all = JSON.stringify(c);
  if (/\u2014/.test(all)) p.push('The issue contains an em dash. Use a comma, colon or full stop instead.');
  return p;
}

async function getIssue(env, date) { return DATE.test(date) ? getJson(env, `brief/issues/${date}.json`) : null; }
async function getState(env, date) { return (await getJson(env, `brief/state/${date}.json`)) || { status: 'draft' }; }
async function putState(env, date, state) { await putJson(env, `brief/state/${date}.json`, state); }
async function contentHash(c) { return sha(JSON.stringify(c)); }
async function getIndex(env) { return (await getJson(env, 'brief/index.json')) || { issues: [] }; }

const platformsOf = c => [...new Set((c.items || []).map(i => i.platform).filter(Boolean))];

/* ---------------- web pages ---------------- */

function signupForm(location, idSuffix, opts = {}) {
  const id = 'brief-email-' + idSuffix;
  return `<form class="brief-signup${opts.dark ? ' brief-dark' : ''}" action="/subscribe" method="post" data-location="${esc(location)}" novalidate>
  <label class="brief-label" for="${id}">Your email address</label>
  <div class="brief-row"><input id="${id}" name="email" type="email" autocomplete="email" inputmode="email" maxlength="160" required placeholder="you@yourbusiness.co.uk"><button type="submit" class="brief-btn">Get the Brief</button></div>
  <label class="brief-trap" aria-hidden="true">Leave this empty <input name="company_url" tabindex="-1" autocomplete="off"></label>
  <p class="brief-note">${esc(CONSENT[CONSENT_NOW])} <a href="/privacy/">Privacy notice</a>.</p>
  <p class="brief-status" role="status" aria-live="polite"></p>
</form>`;
}

function shell({ title, description, path, robots = 'index, follow', jsonld = '', main, ogType = 'website' }) {
  const canonical = SITE + path;
  const vals = {
    TITLE: esc(title),
    DESCRIPTION: esc(description),
    CANONICAL: esc(canonical),
    ROBOTS: esc(robots),
    OGTYPE: esc(ogType),
    JSONLD: jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : '',
    MAIN: main,
  };
  return pageShell.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
}

function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...extra } });
}
const NOINDEX = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' };

// Each item is a card built for skimming: platform and dates up top, a plain illustration (drawn here, no platform
// logos), the one-line "in short", an impact tag, then the four parts as tiles with icons.
const PLATFORM_STYLE = [
  [/\bseo\b|search/i, 'search', '#2F6B66'],
  [/merchant|shopping/i, 'merchant', '#6A4C93'],
  [/analytics|ga4/i, 'analytics', '#9A6A12'],
  [/microsoft|bing/i, 'microsoft', '#2E5E8C'],
  [/meta|facebook|instagram/i, 'meta', '#3D5A98'],
  [/apple/i, 'apple', '#4A4A4A'],
  [/linkedin/i, 'linkedin', '#2A6496'],
  [/google ads|ads/i, 'ads', '#985830'],
];
function platformStyle(name) {
  for (const [re, key, colour] of PLATFORM_STYLE) if (re.test(name || '')) return { key, colour };
  return { key: 'ads', colour: '#985830' };
}
// Simple line drawings, one per kind of platform. They use currentColor, so each takes its card's colour.
const ART = {
  search: '<circle cx="62" cy="52" r="26"/><path d="M81 71l22 22"/><path d="M50 52h24M50 44h16M50 60h20" opacity=".55"/><path d="M118 34h34M118 50h26M118 66h30" opacity=".35"/>',
  ads: '<rect x="22" y="24" width="116" height="72" rx="8"/><path d="M36 82l22-22 16 12 26-30 22 18" /><circle cx="122" cy="60" r="4" fill="currentColor"/><path d="M36 40h40" opacity=".45"/>',
  analytics: '<path d="M28 92V30"/><path d="M28 92h112"/><rect x="42" y="62" width="14" height="30" rx="2"/><rect x="66" y="48" width="14" height="44" rx="2"/><rect x="90" y="56" width="14" height="36" rx="2"/><rect x="114" y="36" width="14" height="56" rx="2"/>',
  merchant: '<path d="M38 40h88l-8 48H46z"/><path d="M58 40c0-14 8-20 24-20s24 6 24 20"/><path d="M64 60h36" opacity=".5"/>',
  microsoft: '<rect x="34" y="22" width="36" height="36" rx="4"/><rect x="78" y="22" width="36" height="36" rx="4" opacity=".6"/><rect x="34" y="64" width="36" height="36" rx="4" opacity=".6"/><rect x="78" y="64" width="36" height="36" rx="4"/><path d="M126 46h22M126 78h18" opacity=".4"/>',
  meta: '<circle cx="54" cy="48" r="14"/><circle cx="104" cy="48" r="14"/><path d="M30 94c4-16 14-24 24-24s20 8 24 24M80 94c4-16 14-24 24-24s20 8 24 24"/>',
  apple: '<rect x="58" y="16" width="48" height="88" rx="9"/><path d="M74 26h16" opacity=".5"/><rect x="66" y="40" width="32" height="20" rx="3" opacity=".6"/><path d="M66 70h32M66 80h22" opacity=".45"/>',
  linkedin: '<rect x="34" y="40" width="92" height="56" rx="8"/><path d="M64 40v-8a6 6 0 0 1 6-6h20a6 6 0 0 1 6 6v8"/><path d="M34 62h92" opacity=".5"/>',
  image: '<rect x="30" y="20" width="110" height="80" rx="8"/><circle cx="112" cy="42" r="9"/><path d="M30 88l34-32 24 22 16-14 36 30"/>',
  policy: '<path d="M85 16l42 14v28c0 26-18 40-42 48-24-8-42-22-42-48V30z"/><path d="M68 60l12 12 24-26"/>',
  target: '<circle cx="78" cy="60" r="38"/><circle cx="78" cy="60" r="24" opacity=".7"/><circle cx="78" cy="60" r="10"/><path d="M78 60l52-40M118 20h12v12"/>',
  funnel: '<path d="M30 22h110l-42 44v30l-26 10V66z"/><path d="M52 40h66" opacity=".45"/><circle cx="150" cy="96" r="5" fill="currentColor"/>',
  calendar: '<rect x="34" y="24" width="102" height="80" rx="8"/><path d="M34 46h102M60 16v16M110 16v16"/><path d="M52 62h12M80 62h12M108 62h12M52 82h12M80 82h12" opacity=".6"/><rect x="104" y="76" width="20" height="16" rx="3" fill="currentColor" opacity=".35"/>',
  ranking: '<path d="M30 96h112"/><rect x="40" y="62" width="22" height="34" rx="3"/><rect x="74" y="36" width="22" height="60" rx="3"/><rect x="108" y="50" width="22" height="46" rx="3"/><path d="M50 40l34-22 30 14 26-12" opacity=".6"/>',
};
// Pick the drawing from what the change is about, falling back to the platform's own. An item can also set "art".
const TOPIC_ART = [
  [/core update|ranking|search result/i, 'ranking'],
  [/image|photo|video|creative|asset/i, 'image'],
  [/policy|policies|impersonat|prohibited|terms|privacy|consent/i, 'policy'],
  [/invalid traffic|fraud|spam|brand safety/i, 'policy'],
  [/conversion|tracking|measurement|attribution|api/i, 'funnel'],
  [/targeting|audience|exclusion|bidding|bid strategy/i, 'target'],
  [/deadline|sunset|from \d|retire|deprecat/i, 'calendar'],
];
function artFor(it, platformKey) {
  if (it.art && ART[it.art]) return it.art;
  const text = `${it.title || ''} ${it.tldr || ''}`;
  for (const [re, key] of TOPIC_ART) if (re.test(text)) return key;
  return platformKey;
}
const PART_ICON = {
  new: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  means: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  affects: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
  aware: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
};
const IMPACT = { action: 'Action needed', watch: 'Worth watching', info: 'Good to know' };
const svg = (inner, vb, cls) => `<svg class="${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
function firstSentence(t) { const one = String(t || '').replace(/\s+/g, ' ').trim(); const m = one.match(/^.*?[.!?](\s|$)/); return (m ? m[0] : one).trim(); }

function itemHtml(it, i) {
  const ps = platformStyle(it.platform);
  const chips = [
    it.announced ? `<span class="bi-chip">Announced ${esc(dayMonth(it.announced))}</span>` : '',
    it.effective ? `<span class="bi-chip bi-chip-date">From ${esc(dayMonth(it.effective))}</span>` : '',
    IMPACT[it.impact] ? `<span class="bi-chip bi-impact bi-${esc(it.impact)}">${IMPACT[it.impact]}</span>` : '',
  ].join('');
  const tiles = PARTS.map(([k, label]) => `<div class="bi-tile bi-tile-${k}">${svg(PART_ICON[k], '0 0 24 24', 'bi-ico')}<h3>${esc(label)}</h3>${blocksHtml(it[k])}</div>`).join('\n    ');
  return `<article class="brief-item bi bi-${ps.key}" id="item-${i + 1}" style="--pc:${ps.colour}">
  <div class="bi-head">
    <div class="bi-headtext">
      <p class="bi-meta"><span class="bi-num">${String(i + 1).padStart(2, '0')}</span><span class="bi-plat">${esc(it.platform)}</span></p>
      <h2>${esc(it.title)}</h2>
      <div class="bi-chips">${chips}</div>
    </div>
    <div class="bi-art">${svg(ART[artFor(it, ps.key)], '0 0 170 120', 'bi-art-svg')}</div>
  </div>
  <p class="bi-tldr"><b>In short:</b> ${esc(it.tldr || firstSentence(it.new))}</p>
  <div class="bi-grid">
    ${tiles}
  </div>
  <p class="brief-src bi-src">${(it.sources || []).length > 1 ? 'Sources' : 'Source'}: ${(it.sources || []).map(s => `<a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)} <span aria-hidden="true">&#8599;</span></a>`).join(' ')}</p>
</article>`;
}

export function issueMain(c, { preview = false } = {}) {
  const covers = coversText(c.covers);
  return `${preview ? '<div class="brief-preview">Preview. Not published' + (c.webOnly ? ' (web only: this issue is not emailed)' : '') + '.</div>' : ''}
<section class="brief-hero" data-hero>
  <div class="brief-w">
    <p class="brief-crumb"><a href="/updates/">${esc(NAME)}</a> <span aria-hidden="true">/</span> ${esc(dayMonthYear(c.date))}</p>
    <h1 class="brief-h1">${esc(c.title)}</h1>
    <p class="brief-meta">${esc(longDate(c.date))}${covers ? ' &middot; Covers ' + esc(covers) : ''} &middot; By <a href="/about/">Lewis Phillips</a></p>
    <div class="brief-summary">${blocksHtml(c.summary)}</div>
    ${c.oneThing ? `<div class="brief-one"><h2>If you only do one thing this week</h2>${blocksHtml(c.oneThing)}</div>` : ''}
    <nav class="brief-toc" aria-label="In this issue"><h2>In this issue</h2><ol>${c.items.map((it, i) => `<li><a href="#item-${i + 1}"><span class="brief-toc-p">${esc(it.platform)}</span><span class="brief-toc-t">${esc(it.title)}${it.impact === 'action' ? ' <em class="brief-toc-act">Action needed</em>' : ''}</span></a></li>`).join('')}</ol></nav>
  </div>
</section>
<section class="brief-body">
  <div class="brief-w">
    ${c.items.map(itemHtml).join('\n')}
    <p class="brief-how">How this is written: each change comes from the platform's own announcement, linked under it. I read the source, then write what it means for a typical account. Your account may differ, so check before you change anything.</p>
  </div>
</section>
<section class="brief-cta">
  <div class="brief-w">
    <div class="brief-card">
      <h2>Get it by email every Monday</h2>
      <p>One email at 7am. What changed last week and what it means for your account.</p>
      ${signupForm('issue-end', 'end')}
    </div>
    <p class="brief-ask">Want to know what one of these means for your account? <a href="/#contact">Ask me a question</a>.</p>
  </div>
</section>`;
}

function issueJsonLd(c) {
  const url = `${SITE}/updates/${c.date}/`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: c.title,
    description: String(c.summary || '').replace(/\s+/g, ' ').slice(0, 300),
    datePublished: c.date,
    url,
    mainEntityOfPage: url,
    inLanguage: 'en-GB',
    isPartOf: { '@type': 'Periodical', name: NAME, url: SITE + '/updates/' },
    author: { '@id': SITE + '/about/#lewis' },
    publisher: { '@id': SITE + '/#business' },
    about: platformsOf(c),
  };
}

export function issuePage(c, opts = {}) {
  return shell({
    title: `${c.title} | ${NAME} | Phillips.`,
    description: String(c.summary || '').replace(/\s+/g, ' ').slice(0, 155),
    path: `/updates/${c.date}/`,
    robots: opts.preview ? 'noindex, nofollow' : 'index, follow',
    ogType: 'article',
    jsonld: issueJsonLd(c),
    main: issueMain(c, opts),
  });
}

function archivePage(index) {
  const issues = index.issues || [];
  const latest = issues[0];
  const list = issues.map(i => `<li><a href="/updates/${esc(i.date)}/"><span class="brief-date">${esc(dayMonthYear(i.date))}</span><b>${esc(i.title)}</b><span class="brief-plat">${esc((i.platforms || []).join(' · '))}</span></a></li>`).join('');
  const main = `<section class="brief-hero brief-hero-top" data-hero>
  <div class="brief-w">
    <span class="eyebrow">${esc(NAME)}</span>
    <h1 class="brief-h1">What changed in marketing this week, <span>and what it means for your account.</span></h1>
    <p class="brief-lede">Every Monday at 7am, one short email on last week's changes to ${esc(PLATFORMS)}. For each change: what's new, what it means, what it could affect in your account and what to be aware of. Every item links to the platform's own announcement.</p>
    ${signupForm('updates-hero', 'top')}
  </div>
</section>
<section class="brief-body">
  <div class="brief-w">
    ${latest ? `<h2 class="brief-sec">Latest issue</h2>
    <a class="brief-latest" href="/updates/${esc(latest.date)}/"><span class="brief-date">${esc(longDate(latest.date))}</span><b>${esc(latest.title)}</b><span class="brief-sum">${esc(latest.summary)}</span><span class="brief-more">Read the issue &rarr;</span></a>
    <h2 class="brief-sec">All issues</h2>
    <ol class="brief-list">${list}</ol>` : '<p class="brief-empty">The first issue is on its way. Sign up above and it will reach you on a Monday morning.</p>'}
    <p class="brief-feed">Prefer a feed reader? <a href="/updates/feed.xml">RSS feed</a>.</p>
  </div>
</section>`;
  return shell({
    title: `${NAME}: weekly marketing updates | Phillips.`,
    description: `What changed in Google Ads, GA4, SEO, Meta, Microsoft Ads, Apple Ads and LinkedIn Ads this week, and what it means for your account. One email every Monday.`,
    path: '/updates/',
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: NAME,
      url: SITE + '/updates/',
      description: `Weekly marketing platform updates explained: what's new, what it means, what it could affect in your account and what to be aware of.`,
      inLanguage: 'en-GB',
      author: { '@id': SITE + '/about/#lewis' },
      publisher: { '@id': SITE + '/#business' },
    },
    main,
  });
}

function messagePage({ title, heading, body, extra = '' }) {
  return shell({
    title: `${title} | ${NAME} | Phillips.`,
    description: title,
    path: '/updates/confirm/',
    robots: 'noindex, nofollow',
    main: `<section class="brief-hero brief-msg"><div class="brief-w"><div class="brief-card brief-center"><h1 class="brief-h2">${esc(heading)}</h1>${body}</div>${extra}</div></section>`,
  });
}

function feed(index) {
  const items = (index.issues || []).slice(0, 30).map(i => `<item><title>${esc(i.title)}</title><link>${SITE}/updates/${i.date}/</link><guid isPermaLink="true">${SITE}/updates/${i.date}/</guid><pubDate>${new Date(i.date + 'T07:00:00Z').toUTCString()}</pubDate><description>${esc(i.summary)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${esc(NAME)} | Phillips.</title><link>${SITE}/updates/</link><atom:link href="${SITE}/updates/feed.xml" rel="self" type="application/rss+xml"/><description>What changed in marketing platforms this week and what it means for your account.</description><language>en-gb</language>${items}</channel></rss>`;
}

// The Insights hub (/guides/): fills its Monday Brief slot with the latest published issue.
export async function withLatestIssue(res, env) {
  if (res.status !== 200 || !(res.headers.get('Content-Type') || '').includes('text/html')) return res;
  const latest = ((await getIndex(env).catch(() => ({ issues: [] }))).issues || [])[0];
  if (!latest) return res;
  const card = `<a class="brief-latest" href="/updates/${esc(latest.date)}/"><span class="brief-date">Latest issue &middot; ${esc(longDate(latest.date))}</span><b>${esc(latest.title)}</b><span class="brief-sum">${esc(latest.summary)}</span><span class="brief-more">Read this week's Brief &rarr;</span></a>`;
  return new HTMLRewriter().on('[data-brief-latest]', { element(el) { el.setInnerContent(card, { html: true }); } }).transform(res);
}

// Adds published issues to the static sitemap.
export async function sitemapWithIssues(res, env) {
  if (res.status !== 200) return res;
  const xml = await res.text();
  const index = await getIndex(env).catch(() => ({ issues: [] }));
  const extra = (index.issues || []).map(i => `  <url><loc>${SITE}/updates/${i.date}/</loc><lastmod>${i.date}</lastmod></url>`).join('\n');
  const body = extra ? xml.replace('</urlset>', extra + '\n</urlset>') : xml;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

/* ---------------- sign-up ---------------- */

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) { try { return { data: await request.json(), form: false }; } catch { return { data: {}, form: false }; } }
  const fd = await request.formData().catch(() => null);
  return { data: fd ? Object.fromEntries(fd) : {}, form: true };
}

async function overLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = 'brief/rate/' + (await sha(ip + '|' + (env.WORKER_SECRET || 'phillips'))).slice(0, 32);
  const hourAgo = Date.now() - 3600 * 1000;
  let times = ((await getJson(env, key)) || []).filter(t => t > hourAgo);
  if (times.length >= RATE_MAX) return true;
  times.push(Date.now());
  await putJson(env, key, times);
  return false;
}

function signupReply(form, request, ok, status, message) {
  if (form) {
    let back = '/updates/';
    try { const ref = new URL(request.headers.get('Referer') || '/updates/', request.url); if (ref.host === new URL(request.url).host) back = ref.pathname; } catch { /* keep default */ }
    return Response.redirect(new URL(back + (ok ? '?brief=check' : '?brief=error'), request.url).href, 303);
  }
  return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, error: message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function confirmEmail(link) {
  const text = [
    `You asked to get ${NAME} from Phillips.`,
    '',
    `It's one email every Monday morning: what changed last week in ${PLATFORMS}, and what it means for your account.`,
    '',
    'Confirm your subscription:',
    link,
    '',
    `The link works for ${TOKEN_DAYS} days. If you didn't ask for this, ignore this email and you won't hear from me.`,
    '',
    'Lewis Phillips',
    'Phillips. · Marketing consultant, Ely',
    '',
    LEGAL,
  ].join('\n');
  const html = emailFrame(`<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#985830">${esc(NAME)}</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;color:#1A1A1A">Confirm your subscription</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#1A1A1A">You asked to get ${esc(NAME)} from Phillips. It's one email every Monday morning: what changed last week in ${esc(PLATFORMS)}, and what it means for your account.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#985830;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 22px;border-radius:4px">Confirm my subscription</a></p>
<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#6B6B6B">The link works for ${TOKEN_DAYS} days. If you didn't ask for this, ignore this email and you won't hear from me.</p>
<p style="margin:20px 0 0;font-size:15px;line-height:1.5;color:#1A1A1A">Lewis Phillips<br><span style="color:#6B6B6B">Phillips. &middot; Marketing consultant, Ely</span></p>`, `<p style="margin:0;font-size:11px;line-height:1.55;color:#8A8A8A">${esc(LEGAL)}</p>`, 'Confirm your subscription to ' + NAME);
  return { subject: `Confirm your subscription to ${NAME}`, html, text };
}

async function subscribe(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
  const { data, form } = await readBody(request);
  const email = String(data.email || '').trim().toLowerCase().slice(0, 160);
  const page = String(data.page || '').slice(0, 200);
  const location = String(data.location || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);

  // Spam: answer as if it worked.
  const elapsed = data.elapsed === undefined || data.elapsed === '' ? NaN : Number(data.elapsed);
  if (String(data.company_url || '').trim() || (Number.isFinite(elapsed) && elapsed < MIN_MS)) return signupReply(form, request, true, 200);
  if (!EMAIL.test(email)) return signupReply(form, request, false, 400, 'Please check your email address.');
  if (await overLimit(env, request)) return signupReply(form, request, false, 429, 'Too many sign-ups from this connection. Please try again later.');

  const key = await subKey(email);
  const now = new Date();
  const rec = (await getJson(env, key)) || { email, status: 'pending', createdAt: now.toISOString(), requests: [], confirmSends: [] };
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  rec.confirmSends = (rec.confirmSends || []).filter(t => t > dayAgo);
  rec.requests = (rec.requests || []).slice(-9);
  rec.requests.push({ at: now.toISOString(), page, location, consent: CONSENT_NOW });
  // Same answer whatever the address's status, so the form never reveals who is subscribed.
  if (rec.confirmSends.length >= PER_ADDRESS_MAX) { await putJson(env, key, rec); return signupReply(form, request, true, 200); }

  const token = randomToken();
  await putJson(env, await tokenKey(token), { sub: key, expires: now.getTime() + TOKEN_DAYS * 86400 * 1000 });
  rec.confirmSends.push(now.getTime());
  rec.lastRequestAt = now.toISOString();
  await putJson(env, key, rec);

  const mail = confirmEmail(`${SITE}/updates/confirm/?t=${token}`);
  const sent = await sendEmail(env, { from: FROM, to: [email], reply_to: REPLY_TO, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.ok) {
    console.error('brief confirm email failed', sent.error);
    return signupReply(form, request, false, 502, 'The confirmation email did not send. Please try again in a few minutes.');
  }
  return signupReply(form, request, true, 200);
}

async function confirm(request, url, env) {
  const token = request.method === 'POST'
    ? String(((await readBody(request)).data || {}).t || '')
    : String(url.searchParams.get('t') || '');
  const bad = () => html(messagePage({
    title: 'Link expired',
    heading: 'That link has expired or was already used',
    body: `<p>Confirmation links work for ${TOKEN_DAYS} days and only once. If you're not getting the Brief yet, sign up again and use the newest email.</p><p><a class="btn-filled" href="/updates/">Sign up again</a></p>`,
  }), 400, NOINDEX);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return bad();
  const tKey = await tokenKey(token);
  const t = await getJson(env, tKey);
  if (!t || t.expires < Date.now()) return bad();

  if (request.method !== 'POST') {
    // A button, not an automatic confirm: mail scanners open links, they don't press buttons.
    return html(messagePage({
      title: 'Confirm your subscription',
      heading: 'One click to confirm',
      body: `<p>Press the button to start getting ${esc(NAME)}: one email every Monday at 7am.</p><form method="post" action="/updates/confirm/"><input type="hidden" name="t" value="${esc(token)}"><button class="btn-filled brief-confirm-btn" type="submit">Confirm my subscription</button></form>`,
    }), 200, NOINDEX);
  }

  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
  const rec = await getJson(env, t.sub);
  if (!rec) return bad();
  const now = new Date().toISOString();
  rec.status = 'confirmed';
  rec.confirmedAt = now;
  rec.confirmations = [...(rec.confirmations || []).slice(-9), { at: now, consent: (rec.requests && rec.requests.length ? rec.requests[rec.requests.length - 1].consent : CONSENT_NOW) }];
  const listed = await addToList(env, rec.email);
  rec.listSyncedAt = listed.ok ? now : null;
  if (!listed.ok) { rec.listError = listed.error || 'unknown'; console.error('brief list add failed', rec.listError); } else delete rec.listError;
  await putJson(env, t.sub, rec);
  await env.BLOBS.delete(tKey);
  if (!OWN.includes(rec.email)) await markStarted(env).catch(err => console.error('brief start', err && err.message));
  return html(messagePage({
    title: 'Subscribed',
    heading: "You're in",
    body: `<p>${esc(NAME)} will reach you on Monday mornings at 7am. Every email has a one-click unsubscribe link.</p><p><a class="btn-outline" href="/updates/">See past issues</a></p>`,
    extra: `<script>window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:'newsletter_confirm'});</script>`,
  }), 200, NOINDEX);
}

/* ---------------- email issue ---------------- */

function emailFrame(inner, after, preheader) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(NAME)}</title></head>
<body style="margin:0;padding:0;background:#FDF6EE;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1A1A1A">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6EE"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #E8D8C4;border-radius:8px">
<tr><td style="padding:28px 32px">${inner}</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td style="padding:18px 8px 0">${after}</td></tr></table>
</td></tr></table>
</body></html>`;
}

const P = 'margin:0 0 12px;font-size:15px;line-height:1.6;color:#1A1A1A';
const LI = 'margin:0 0 6px;font-size:15px;line-height:1.55;color:#1A1A1A';

export function issueEmail(c, { unsubscribe = '{{{RESEND_UNSUBSCRIBE_URL}}}', test = false } = {}) {
  const web = `${SITE}/updates/${c.date}/`;
  const covers = coversText(c.covers);
  const subject = `${test ? '[Test] ' : ''}${NAME}: ${c.title}`;
  const items = c.items.map((it, i) => `<tr><td style="padding:24px 0 4px;border-top:1px solid #F0E5D2">
<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#985830">${esc(it.platform)}${it.announced ? ' &middot; ' + esc(dayMonthYear(it.announced)) : ''}</p>
<h2 style="margin:0 0 14px;font-size:20px;line-height:1.25;color:#1A1A1A">${i + 1}. ${esc(it.title)}</h2>
${PARTS.map(([k, label]) => `<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6B6B6B">${esc(label)}</p>${blocksHtml(it[k], P, LI)}`).join('\n')}
<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:#6B6B6B">${(it.sources || []).length > 1 ? 'Sources' : 'Source'}: ${(it.sources || []).map(s => `<a href="${esc(s.url)}" style="color:#985830">${esc(s.label)}</a>`).join(', ')}</p>
</td></tr>`).join('');

  const inner = `<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#985830">${esc(NAME)} &middot; ${esc(dayMonthYear(c.date))}</p>
<h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:#1A1A1A">${esc(c.title)}</h1>
${covers ? `<p style="margin:0 0 14px;font-size:13px;color:#6B6B6B">Covers ${esc(covers)}</p>` : ''}
${blocksHtml(c.summary, P, LI)}
${c.oneThing ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;background:#FDF6EE;border:1px solid #E8D8C4;border-radius:6px"><tr><td style="padding:16px 18px"><p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#985830">If you only do one thing this week</p>${blocksHtml(c.oneThing, 'margin:0;font-size:15px;line-height:1.6;color:#1A1A1A', LI)}</td></tr></table>` : ''}
<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6B6B6B">In this issue</p>
<ol style="margin:0 0 20px;padding-left:20px">${c.items.map(it => `<li style="${LI}"><b>${esc(it.platform)}:</b> ${esc(it.title)}</li>`).join('')}</ol>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 0 0;border-top:1px solid #F0E5D2">
<p style="${P}"><b>Ask me a question.</b> If you want to know what any of this means for your account, reply to this email.</p>
<p style="margin:0;font-size:15px;line-height:1.5;color:#1A1A1A">Lewis Phillips<br><span style="color:#6B6B6B">Phillips. &middot; Marketing consultant, Ely</span></p>
</td></tr></table>`;

  const after = `<p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#6B6B6B">You're getting this because you signed up to ${esc(NAME)} at phillips-uk.com and confirmed your email address. <a href="${esc(unsubscribe)}" style="color:#6B6B6B">Unsubscribe</a> &middot; <a href="${esc(web)}" style="color:#6B6B6B">Read on the web</a> &middot; <a href="${SITE}/privacy/" style="color:#6B6B6B">Privacy</a></p>
<p style="margin:0;font-size:11px;line-height:1.55;color:#8A8A8A">${esc(LEGAL)}</p>`;

  const text = [
    `${NAME.toUpperCase()} · ${dayMonthYear(c.date)}`,
    c.title,
    covers ? `Covers ${covers}` : null,
    '',
    blocksText(c.summary),
    c.oneThing ? '\nIF YOU ONLY DO ONE THING THIS WEEK\n' + blocksText(c.oneThing) : null,
    '',
    'IN THIS ISSUE',
    ...c.items.map((it, i) => `${i + 1}. ${it.platform}: ${it.title}`),
    ...c.items.flatMap((it, i) => [
      '',
      '------------------------------',
      `${i + 1}. ${it.title}`,
      `${it.platform}${it.announced ? ' · ' + dayMonthYear(it.announced) : ''}`,
      ...PARTS.flatMap(([k, label]) => ['', label.toUpperCase(), blocksText(it[k])]),
      '',
      ...(it.sources || []).map(s => `Source: ${s.label}: ${s.url}`),
    ]),
    '',
    '------------------------------',
    'Ask me a question: if you want to know what any of this means for your account, reply to this email.',
    '',
    'Lewis Phillips',
    'Phillips. · Marketing consultant, Ely',
    '',
    `Read on the web: ${web}`,
    `Unsubscribe: ${unsubscribe}`,
    `Privacy: ${SITE}/privacy/`,
    '',
    LEGAL,
  ].filter(l => l !== null).join('\n');

  return { subject, html: emailFrame(inner, after, String(c.summary || '').replace(/\s+/g, ' ').slice(0, 140)), text };
}

/* ---------------- publish and send ---------------- */

async function publish(env, date, c, state) {
  state.publishedAt = state.publishedAt || new Date().toISOString();
  const index = await getIndex(env);
  const entry = { date, title: c.title, summary: String(c.summary || '').replace(/\s+/g, ' ').slice(0, 300), platforms: platformsOf(c), count: c.items.length };
  index.issues = [entry, ...(index.issues || []).filter(i => i.date !== date)].sort((a, b) => b.date.localeCompare(a.date));
  index.updatedAt = new Date().toISOString();
  await putJson(env, 'brief/index.json', index);
  await pingIndexNow(env, [`${SITE}/updates/${date}/`, `${SITE}/updates/`]);
}

async function pingIndexNow(env, urls) {
  if (env.BRIEF_DEV_OUTBOX) return;
  try {
    await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: 'www.phillips-uk.com', key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls }),
    });
  } catch (err) { console.error('indexnow', err && err.message); }
}

// Tops up the Resend list with any confirmed sign-ups that didn't reach it at the time (Resend was down, say).
async function syncList(env) {
  let added = 0, failed = 0;
  for (const key of await listKeys(env, 'brief/subscribers/')) {
    const rec = await getJson(env, key);
    if (!rec || rec.status !== 'confirmed' || rec.listSyncedAt) continue;
    const r = await addToList(env, rec.email);
    if (r.ok) { rec.listSyncedAt = new Date().toISOString(); delete rec.listError; added++; } else { rec.listError = r.error; failed++; }
    await putJson(env, key, rec);
  }
  return { added, failed };
}

async function counts(env) {
  let confirmed = 0, pending = 0, unsynced = 0, others = 0;
  for (const key of await listKeys(env, 'brief/subscribers/')) {
    const rec = await getJson(env, key);
    if (!rec) continue;
    if (rec.status === 'confirmed') { confirmed++; if (!OWN.includes(rec.email)) others++; if (!rec.listSyncedAt) unsynced++; } else pending++;
  }
  return { confirmed, pending, unsynced, others };
}

// Starts the weekly routine when the first real subscriber confirms, and tells Lewis when the first issue goes out.
async function markStarted(env) {
  const cfg = (await getJson(env, 'brief/config.json')) || {};
  if (cfg.startedAt) return;
  cfg.startedAt = new Date().toISOString();
  await putJson(env, 'brief/config.json', cfg);
  const now = londonNow();
  // The drafting task runs on Fridays at 13:00: if that has already passed this week, the first draft is next Friday's.
  let friday = now.date;
  while (utcDate(friday).getUTCDay() !== 5 || (friday === now.date && now.hour >= 13)) friday = addDays(friday, 1);
  const monday = addDays(friday, 3);
  await note(env, 'your first subscriber, the email starts now', [
    'Someone other than you has confirmed their subscription, so the email is switched on:',
    '',
    `- Friday ${dayMonth(friday)}: the drafting task writes the issue for Monday ${dayMonthYear(monday)}, and you get an email when it's ready.`,
    `- Monday ${dayMonth(monday)} at 07:00: once you've approved it, it goes to everyone who confirmed, as well as onto the website.`,
    '',
    ADMIN_LINK,
  ]);
}

// Sends (or, for a web-only issue, just publishes) an approved issue. Writes "sending" before calling Resend, so a
// second run can never send it twice.
async function emailOn(env) { return !!((await getJson(env, 'brief/config.json')) || {}).startedAt; }

async function sendIssue(env, date, by) {
  const c = await getIssue(env, date);
  const state = await getState(env, date);
  if (!c) return { ok: false, error: 'There is no issue for ' + date + '.' };
  const problems = checkIssue(c, date);
  if (problems.length) return { ok: false, error: problems[0] };
  if (state.status === 'sent' || state.status === 'sending') return { ok: false, error: 'This issue has already gone out.' };
  if (state.status !== 'approved') return { ok: false, error: 'This issue is not approved.' };
  if (state.approvedHash !== await contentHash(c)) return { ok: false, error: 'The issue changed after it was approved. Approve it again first.' };

  if (c.webOnly || !(await emailOn(env))) {
    await publish(env, date, c, state);
    state.status = 'sent'; state.sentAt = new Date().toISOString(); state.sentBy = by; state.webOnly = true;
    if (!c.webOnly) state.emailPaused = true;
    await putState(env, date, state);
    return { ok: true, webOnly: true };
  }

  state.status = 'sending'; state.sendingAt = new Date().toISOString(); state.sentBy = by;
  await putState(env, date, state);
  const seg = await segmentId(env);
  let res = seg.ok ? null : { ok: false, error: 'Mailing list: ' + seg.error };
  if (seg.ok) {
    await syncList(env);
    const mail = issueEmail(c);
    res = await resend(env, 'POST', '/broadcasts', {
      segment_id: seg.id, from: FROM, reply_to: REPLY_TO, subject: mail.subject, html: mail.html, text: mail.text,
      name: `${NAME} ${date}`, send: true,
    });
  }
  if (!res.ok) {
    state.status = 'approved'; state.lastError = res.error; state.lastErrorAt = new Date().toISOString();
    await putState(env, date, state);
    return { ok: false, error: res.error };
  }
  state.status = 'sent'; state.sentAt = new Date().toISOString(); state.broadcastId = res.data && res.data.id; delete state.lastError;
  await publish(env, date, c, state);
  await putState(env, date, state);
  return { ok: true, broadcastId: state.broadcastId };
}

async function cleanup(env) {
  const cutoff = Date.now() - TOKEN_DAYS * 86400 * 1000;
  // Sign-up rate counters only matter for an hour.
  for (const key of await listKeys(env, 'brief/rate/')) await env.BLOBS.delete(key);
  for (const key of await listKeys(env, 'brief/tokens/')) {
    const t = await getJson(env, key);
    if (!t || t.expires < Date.now()) await env.BLOBS.delete(key);
  }
  for (const key of await listKeys(env, 'brief/subscribers/')) {
    const rec = await getJson(env, key);
    if (rec && rec.status === 'pending' && new Date(rec.lastRequestAt || rec.createdAt).getTime() < cutoff) await env.BLOBS.delete(key);
  }
}

export async function scheduled(controller, env) {
  let when = controller.scheduledTime || Date.now();
  // Local testing only: with the dev outbox on, brief/dev-now.json ({"at": "<ISO time>"}) stands in for the clock.
  if (env.BRIEF_DEV_OUTBOX) { const fake = await getJson(env, 'brief/dev-now.json'); if (fake && fake.at) when = Date.parse(fake.at); }
  const now = londonNow(new Date(when));
  try {
    if (now.weekday === 'Mon') return now.hour === 7 ? await mondayRun(env, now.date) : undefined;
    if (now.weekday === 'Fri') return await fridayNote(env, nextMonday(now.date));
    if (now.weekday === 'Sun') return await sundayNote(env, nextMonday(now.date));
  } catch (err) {
    console.error('brief scheduled', err && err.stack);
    await note(env, 'something went wrong', [`The ${controller.cron} run failed: ${err && err.message}`, '', 'Check the Worker logs in Cloudflare.']);
  }
}

const ADMIN_LINK = `${SITE}/admin#brief`;

async function mondayRun(env, date) {
  await cleanup(env).catch(err => console.error('brief cleanup', err && err.message));
  const c = await getIssue(env, date);
  const state = await getState(env, date);
  if (!c) return note(env, 'nothing sent today', [`There was no draft for ${longDate(date)}, so nothing went out.`]);
  if (state.status === 'sent') return;
  if (state.status !== 'approved') return note(env, 'not sent: not approved', [`"${c.title}" was not approved, so it did not go out this morning.`, '', `If you want it out today: approve it, then press "Send now" at ${ADMIN_LINK}`]);
  const r = await sendIssue(env, date, 'Monday 07:00 send');
  if (!r.ok) return note(env, 'not sent', [`"${c.title}" did not go out: ${r.error}`, '', `Fix it, then press "Send now" at ${ADMIN_LINK}`]);
  const n = await counts(env);
  return note(env, r.webOnly ? 'published' : 'sent', [`"${c.title}" ${r.webOnly ? 'is on the website now. No email: the email starts when the first subscriber confirms.' : `went out at 07:00 to the mailing list (${n.confirmed} confirmed sign-ups on record).`}`, '', `Page: ${SITE}/updates/${date}/`, `LinkedIn post draft: vault 01_Phillips/02_Website/The Monday Brief/${date}/linkedin.md`]);
}

async function fridayNote(env, monday) {
  const c = await getIssue(env, monday);
  if (!c) return note(env, `no draft yet for ${dayMonth(monday)}`, [`There's no draft for Monday ${dayMonthYear(monday)} yet. The Friday drafting task may not have run (the Mac needs to be awake).`, '', 'Start it from a Claude session in the vault: "draft this week\'s Monday Brief".']);
  const problems = checkIssue(c, monday);
  return note(env, `ready for review: ${c.title}`, [
    `The draft for Monday ${dayMonthYear(monday)} is ready: "${c.title}" (${c.items.length} item${c.items.length === 1 ? '' : 's'}).`,
    problems.length ? `\nIt has problems to fix before it can be approved:\n- ${problems.join('\n- ')}` : null,
    '',
    `Review it, send yourself a test and approve it at ${ADMIN_LINK}`,
    (await emailOn(env)) ? 'It goes out at 07:00 on Monday only if you approve it.' : 'Once approved it goes on the website at 07:00 on Monday. No email yet: that starts when the first subscriber confirms.',
    `LinkedIn post draft: vault 01_Phillips/02_Website/The Monday Brief/${monday}/linkedin.md`,
  ]);
}

async function sundayNote(env, monday) {
  const c = await getIssue(env, monday);
  const state = await getState(env, monday);
  if (!c || state.status === 'approved' || state.status === 'sent') return;
  return note(env, 'waiting for your approval', [`"${c.title}" ${(await emailOn(env)) ? 'goes out' : 'goes on the website'} at 07:00 tomorrow only if you approve it.`, '', ADMIN_LINK]);
}

/* ---------------- routing ---------------- */

export function isBriefPath(path) {
  return path === '/subscribe' || path === '/updates' || path.startsWith('/updates/');
}

export async function brief(request, url, env) {
  const path = url.pathname;
  const method = request.method;
  if (path === '/subscribe') return method === 'POST' ? subscribe(request, env) : new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (path === '/updates') return Response.redirect(new URL('/updates/' + url.search, url).href, 301);
  if (path === '/updates/feed.xml') return new Response(feed(await getIndex(env)), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' } });
  if (path === '/updates/confirm' || path === '/updates/confirm/') {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return new Response('Method not allowed', { status: 405 });
    return confirm(request, url, env);
  }
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  if (path === '/updates/') return html(archivePage(await getIndex(env)));
  const m = path.match(/^\/updates\/(\d{4}-\d{2}-\d{2})(\/?)$/);
  if (m) {
    if (!m[2]) return Response.redirect(new URL(`/updates/${m[1]}/`, url).href, 301);
    const state = await getState(env, m[1]);
    const c = state.publishedAt ? await getIssue(env, m[1]) : null;
    if (c) return html(issuePage(c));
  }
  return null; // not ours: the static files (and their 404) handle it
}

/* ---------------- admin API (/admin/api/brief...) ---------------- */

export async function briefAdmin(request, path, env, email, headers) {
  const method = request.method;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const today = londonNow().date;

  if (path === '/admin/api/brief' && method === 'GET') {
    const dates = (await listKeys(env, 'brief/issues/')).map(k => k.slice('brief/issues/'.length, -5)).filter(d => DATE.test(d)).sort().reverse().slice(0, 30);
    const issues = [];
    for (const date of dates) {
      const [c, state] = await Promise.all([getIssue(env, date), getState(env, date)]);
      if (!c) continue;
      const problems = checkIssue(c, date);
      issues.push({
        date, title: c.title || '(no title)', items: (c.items || []).length, webOnly: !!c.webOnly, problems,
        status: state.status || 'draft', approvedAt: state.approvedAt || null, approvedBy: state.approvedBy || null,
        changedSinceApproval: state.status === 'approved' && state.approvedHash !== await contentHash(c),
        publishedAt: state.publishedAt || null, sentAt: state.sentAt || null, lastError: state.lastError || null,
        canSendNow: state.status === 'approved' && date <= today && !c.webOnly,
      });
    }
    const [n, seg] = await Promise.all([counts(env), segmentId(env)]);
    const cfg = (await getJson(env, 'brief/config.json')) || {};
    return json({ issues, subscribers: n, startedAt: cfg.startedAt || null, list: seg.ok ? { ok: true } : { ok: false, error: seg.error, status: seg.status || null }, today });
  }

  const m = path.match(/^\/admin\/api\/brief\/(\d{4}-\d{2}-\d{2})\/(page|email|test|approve|withdraw|send-now)$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const [, date, action] = m;
  const c = await getIssue(env, date);
  if (!c) return json({ error: 'There is no issue for ' + date + '.' }, 404);
  const state = await getState(env, date);

  if (action === 'page' && method === 'GET') {
    return new Response(issuePage(c, { preview: true }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
  }
  if (action === 'email' && method === 'GET') {
    return new Response(issueEmail(c, { unsubscribe: SITE + '/updates/' }).html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
  }
  if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (action === 'test') {
    const mail = issueEmail(c, { unsubscribe: SITE + '/updates/', test: true });
    const r = await sendEmail(env, { from: FROM, to: [email], reply_to: REPLY_TO, subject: mail.subject, html: mail.html, text: mail.text });
    return r.ok ? json({ ok: true, to: email }) : json({ error: 'The test did not send: ' + r.error }, 502);
  }
  if (action === 'approve') {
    if (state.status === 'sent' || state.status === 'sending') return json({ error: 'This issue has already gone out.' }, 409);
    const problems = checkIssue(c, date);
    if (problems.length) return json({ error: 'Fix these first: ' + problems.join(' ') }, 400);
    Object.assign(state, { status: 'approved', approvedAt: new Date().toISOString(), approvedBy: email, approvedHash: await contentHash(c) });
    delete state.lastError;
    await putState(env, date, state);
    if (c.webOnly) {
      const r = await sendIssue(env, date, email);
      return r.ok ? json({ ok: true, published: true }) : json({ error: r.error }, 502);
    }
    return json({ ok: true });
  }
  if (action === 'withdraw') {
    if (state.status !== 'approved') return json({ error: 'Only an approved issue that has not gone out can be withdrawn.' }, 409);
    Object.assign(state, { status: 'draft', withdrawnAt: new Date().toISOString(), withdrawnBy: email });
    delete state.approvedHash;
    await putState(env, date, state);
    return json({ ok: true });
  }
  if (action === 'send-now') {
    if (date > today) return json({ error: `This issue is for ${longDate(date)}. It goes out at 07:00 that day.` }, 409);
    const r = await sendIssue(env, date, email);
    if (!r.ok) return json({ error: r.error }, 502);
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}
