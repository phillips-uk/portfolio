// Private pages that open with an invite link made in /admin: the rate card, the Search Desk demo and prospect prototypes.
//   /rate-card?invite=<token>   /search-desk?invite=<token>   /the-loft?invite=<token>   /monument?invite=<token>
// A page can ride on another page's invite (`access`) and share its cookie path (`cookiePath`), so one link opens a
// small multi-page proposal: /monument, /monument/calculators and /monument/thank-you all open with a "monument" invite.
// The link itself is meant to be forwarded, so the token stays in the address bar. A cookie also remembers it, so the
// plain address keeps working in the same browser. Invites live in R2 under rate-card-invites/<token>.json and list the
// pages they open in `pages` (invites made before the demo existed have none and open the rate card only).
// A link is live between `startsAt` (optional) and `expiresAt` (optional); outside that window it shows a locked page.
// Every open is kept in `visits` (place, device, page, time read; link previews by chat apps and mail scanners kept
// apart and not counted), shown per link in /admin. `archived` only hides a link in the admin; it keeps working.
// /search-desk has no page of its own since 2026-11-09: it opens the real Search Desk demo at /desk (desk-demo.js).
import rateCardHtml from '../private/rate-card.html';
import theLoftHtml from '../private/the-loft.html';
import monumentHtml from '../private/monument.html';
import monumentCalculatorsHtml from '../private/monument-calculators.html';
import monumentThankYouHtml from '../private/monument-thank-you.html';
import monumentAblHtml from '../private/monument-asset-based-lending.html';
import monumentAdvisersHtml from '../private/monument-for-advisers.html';
import monumentAboutHtml from '../private/monument-about.html';
import monumentTradeHtml from '../private/monument-trade-finance.html';
import monumentAcqHtml from '../private/monument-acquisitions-and-refinancing.html';
import monumentRequestHtml from '../private/monument-request-terms.html';
import monumentIntroduceHtml from '../private/monument-introduce.html';
import monumentInvoiceHtml from '../private/monument-invoice-discounting.html';
import monumentLettersHtml from '../private/monument-letters-of-credit.html';
import monumentRefiHtml from '../private/monument-refinancing.html';
import monumentLondonHtml from '../private/monument-london.html';
import monumentCambsHtml from '../private/monument-cambridgeshire.html';
import monumentDealsHtml from '../private/monument-deals.html';
import monumentStockFinHtml from '../private/monument-stock-finance.html';
import monumentPlantHtml from '../private/monument-plant-and-machinery.html';
import monumentSupplyHtml from '../private/monument-supply-chain-finance.html';
import monumentImportFinHtml from '../private/monument-import-finance.html';
import monumentSecRecruitmentHtml from '../private/monument-sectors-recruitment.html';
import monumentSecManufacturingAndEngineeringHtml from '../private/monument-sectors-manufacturing-and-engineering.html';
import monumentSecDistributionHtml from '../private/monument-sectors-distribution.html';
import monumentSecImportersHtml from '../private/monument-sectors-importers.html';
import monumentSecCommodityTradeHtml from '../private/monument-sectors-commodity-trade.html';
import monumentSecFoodAndDrinkHtml from '../private/monument-sectors-food-and-drink.html';
import monumentGuidesHtml from '../private/monument-guides.html';
import monumentGuideCashFlowForecastHtml from '../private/monument-guide-cash-flow-forecast.html';
import monumentGuideRevolvingCreditFacilityHtml from '../private/monument-guide-revolving-credit-facility.html';
import monumentGuideCashConversionCycleHtml from '../private/monument-guide-cash-conversion-cycle.html';
import monumentGuideDebtorDaysHtml from '../private/monument-guide-debtor-days.html';
import monumentGuideOvertradingHtml from '../private/monument-guide-overtrading.html';
import monumentGuideWhatIsAssetBasedLendingHtml from '../private/monument-guide-what-is-asset-based-lending.html';
import monumentGuideLettersOfCreditHtml from '../private/monument-guide-letters-of-credit.html';
import monumentGuideIncotermsForImportersHtml from '../private/monument-guide-incoterms-for-importers.html';
import { adminEmail } from './admin.js';
import { openDeskDemo } from './desk-demo.js';
import { CONSENT_HEAD, CONSENT_TAG } from './consent.js';

export const PAGES = {
  'rate-card': { path: '/rate-card', html: rateCardHtml, cookie: 'ph_rc', title: 'The rate card' },
  // Search Desk: Example Car Hire Co. inside the real product at /desk, each invite through its own share link (desk-demo.js)
  'search-desk': { path: '/search-desk', desk: true, cookie: 'ph_sd', title: 'The Search Desk demo' },
  // The Loft (Nick, Ely): the booking app prototype. Phone frame on desktop, full screen on a phone.
  'the-loft': { path: '/the-loft', html: theLoftHtml, cookie: 'ph_tl', title: 'The Loft prototype' },
  // Monument Corporate Finance (Ben Boateng): the website draft (homepage, tools, asset-based lending, for advisers, about, thank you). One invite opens all of them.
  'monument': { path: '/monument', html: monumentHtml, cookie: 'ph_mcf', cookiePath: '/monument', title: 'The Monument website draft' },
  'monument-calculators': { path: '/monument/calculators', html: monumentCalculatorsHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  // Where every enquiry on the draft lands (no details are sent; the page only shows the flow)
  'monument-thank-you': { path: '/monument/thank-you', html: monumentThankYouHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  // v20 (25 Nov 2026): the design system pages. Same invite, same cookie.
  'monument-abl': { path: '/monument/asset-based-lending', html: monumentAblHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-advisers': { path: '/monument/for-advisers', html: monumentAdvisersHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-about': { path: '/monument/about', html: monumentAboutHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-trade': { path: '/monument/trade-finance', html: monumentTradeHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-acq': { path: '/monument/acquisitions-and-refinancing', html: monumentAcqHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-request': { path: '/monument/request-terms', html: monumentRequestHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-introduce': { path: '/monument/introduce', html: monumentIntroduceHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-invoice': { path: '/monument/invoice-discounting', html: monumentInvoiceHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-letters': { path: '/monument/letters-of-credit', html: monumentLettersHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-refinancing': { path: '/monument/refinancing', html: monumentRefiHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-london': { path: '/monument/london', html: monumentLondonHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-cambridgeshire': { path: '/monument/cambridgeshire', html: monumentCambsHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-deals': { path: '/monument/deals', html: monumentDealsHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-stock-finance': { path: '/monument/stock-finance', html: monumentStockFinHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-plant-and-machinery': { path: '/monument/plant-and-machinery', html: monumentPlantHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-supply-chain-finance': { path: '/monument/supply-chain-finance', html: monumentSupplyHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-import-finance': { path: '/monument/import-finance', html: monumentImportFinHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-recruitment': { path: '/monument/sectors/recruitment', html: monumentSecRecruitmentHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-manufacturing-and-engineering': { path: '/monument/sectors/manufacturing-and-engineering', html: monumentSecManufacturingAndEngineeringHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-distribution': { path: '/monument/sectors/distribution', html: monumentSecDistributionHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-importers': { path: '/monument/sectors/importers', html: monumentSecImportersHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-commodity-trade': { path: '/monument/sectors/commodity-trade', html: monumentSecCommodityTradeHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-sectors-food-and-drink': { path: '/monument/sectors/food-and-drink', html: monumentSecFoodAndDrinkHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guides': { path: '/monument/guides', html: monumentGuidesHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-cash-flow-forecast': { path: '/monument/guides/cash-flow-forecast', html: monumentGuideCashFlowForecastHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-revolving-credit-facility': { path: '/monument/guides/revolving-credit-facility', html: monumentGuideRevolvingCreditFacilityHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-cash-conversion-cycle': { path: '/monument/guides/cash-conversion-cycle', html: monumentGuideCashConversionCycleHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-debtor-days': { path: '/monument/guides/debtor-days', html: monumentGuideDebtorDaysHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-overtrading': { path: '/monument/guides/overtrading', html: monumentGuideOvertradingHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-what-is-asset-based-lending': { path: '/monument/guides/what-is-asset-based-lending', html: monumentGuideWhatIsAssetBasedLendingHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-letters-of-credit': { path: '/monument/guides/letters-of-credit', html: monumentGuideLettersOfCreditHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
  'monument-guide-incoterms-for-importers': { path: '/monument/guides/incoterms-for-importers', html: monumentGuideIncotermsForImportersHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
};
const BY_PATH = Object.fromEntries(Object.entries(PAGES).map(([key, p]) => [p.path, key]));
const VISITOR = 'ph_vid'; // retired 22 Nov 2026: only ever cleared now
const TOKEN = /^[A-Za-z0-9._-]{8,80}$/;
const PREFIX = 'rate-card-invites/';

const PRIVATE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export async function getInvite(env, token) {
  if (!token || !TOKEN.test(token)) return null;
  const obj = await env.BLOBS.get(PREFIX + token + '.json');
  return obj ? obj.json() : null;
}

export async function putInvite(env, invite) {
  await env.BLOBS.put(PREFIX + invite.token + '.json', JSON.stringify(invite), { httpMetadata: { contentType: 'application/json' } });
}

export async function listInvites(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: PREFIX, cursor });
    for (const o of page.objects) {
      const obj = await env.BLOBS.get(o.key);
      if (obj) out.push(await obj.json());
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function invitePages(inv) {
  const pages = Array.isArray(inv && inv.pages) ? inv.pages.filter(k => PAGES[k]) : [];
  return pages.length ? pages : ['rate-card'];
}

export function inviteState(inv) {
  if (!inv) return 'missing';
  if (inv.revoked) return 'revoked';
  const now = new Date().toISOString();
  if (inv.expiresAt && inv.expiresAt < now) return 'expired';
  if (inv.startsAt && inv.startsAt > now) return 'scheduled';
  return 'active';
}

function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function randomId(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Read, change and save one invite, retrying if a view, a ping or the admin saved it in between. `change` returns false
// when there is nothing to write. Returns the saved invite, or null if it no longer exists.
export async function updateInvite(env, token, change) {
  if (!token || !TOKEN.test(token)) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const obj = await env.BLOBS.get(PREFIX + token + '.json');
    if (!obj) return null;
    const inv = await obj.json();
    if (change(inv) === false) return inv;
    const put = await env.BLOBS.put(PREFIX + token + '.json', JSON.stringify(inv), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagMatches: obj.etag },
    });
    if (put) return inv;
  }
  throw new Error('The link was saved somewhere else at the same moment. Try again.');
}

// Each open is kept as a visit (newest first, the last MAX_VISITS) so the admin can show who opened what, where, on
// what, and for how long. Place is the city Cloudflare gives for the connection; no IP address is stored.
const MAX_VISITS = 300;

// Chat apps, social sites and mail scanners fetch a link to build a preview or check it. Those are kept as previews
// and never count as views or browsers. Matched on the fetcher's own name, so in-app browsers (LinkedIn's, Gmail's)
// still count as people.
const PREVIEWERS = [
  ['iMessage', /Facebot.*Twitterbot|Twitterbot.*Facebot/i],
  ['Slack', /Slackbot|Slack-ImgProxy/i],
  ['WhatsApp', /^WhatsApp\//i],
  ['Facebook', /facebookexternalhit|Facebot/i],
  ['LinkedIn', /LinkedInBot/i],
  ['X', /Twitterbot/i],
  ['Teams or Skype', /SkypeUriPreview|MicrosoftPreview/i],
  ['Microsoft Office', /Microsoft Office|MSOffice|ms-office|Microsoft Outlook|BingPreview|bingbot/i],
  ['Telegram', /TelegramBot/i],
  ['Discord', /Discordbot/i],
  ['Google', /Googlebot|Google-InspectionTool|GoogleOther|Google-Safety|AdsBot-Google|Google Web Preview|FeedFetcher-Google/i],
  ['Apple', /Applebot/i],
  ['a mail scanner', /Proofpoint|Mimecast|Barracuda|safelinks|urlscan|Symantec|TrendMicro|Trend Micro|Forcepoint|Sophos|Cisco/i],
  ['a script', /^(curl|Wget|python|Go-http-client|okhttp|axios|node-fetch|undici|Java\/|libwww|Apache-HttpClient)|HeadlessChrome|PhantomJS/i],
  ['a crawler', /(bot|crawler|spider)\b|bot\//i],
];
function previewBy(ua) {
  if (!ua) return 'an unnamed client';
  const hit = PREVIEWERS.find(([, re]) => re.test(ua));
  return hit ? hit[0] : null;
}
function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'Tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'Phone';
  return 'Computer';
}
function browserOf(ua) {
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn app';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook app';
  if (/Instagram/i.test(ua)) return 'Instagram app';
  if (/GSA\//.test(ua)) return 'Google app';
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
  if (/Chrome|CriOS/.test(ua)) return 'Chrome';
  if (/Safari/.test(ua)) return 'Safari';
  return 'Another browser';
}
function osOf(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}
// Where the link was opened from, when the app passes it on (often it does not): the referring site's host only.
function referrerHost(request) {
  try {
    const host = new URL(request.headers.get('Referer') || '').host.replace(/^www\./, '');
    return host && !/(^|\.)phillips-uk\.com$/.test(host) ? host.slice(0, 80) : '';
  } catch { return ''; }
}

async function recordView(env, token, visitor, request, key, viewId) {
  const ua = request.headers.get('User-Agent') || '';
  const preview = previewBy(ua);
  const cf = request.cf || {};
  const now = new Date().toISOString();
  const visit = {
    id: viewId, at: now, page: key, visitor: preview ? null : visitor,
    city: String(cf.city || '').slice(0, 60), region: String(cf.region || '').slice(0, 60), country: String(cf.country || '').slice(0, 4),
    device: deviceOf(ua), browser: browserOf(ua), os: osOf(ua), from: referrerHost(request),
    preview: preview || null, secs: 0, scroll: 0,
  };
  const inv = await updateInvite(env, token, inv => {
    inv.visits = [visit, ...(Array.isArray(inv.visits) ? inv.visits : [])].slice(0, MAX_VISITS);
    if (preview) { inv.previews = (inv.previews || 0) + 1; return; }
    inv.views = (inv.views || 0) + 1;
    inv.pageViews = inv.pageViews || {};
    inv.pageViews[key] = (inv.pageViews[key] || 0) + 1;
    inv.lastViewedAt = now;
    inv.lastCountry = visit.country;
    inv.visitors = inv.visitors || [];
    if (visitor && !inv.visitors.includes(visitor) && inv.visitors.length < 200) inv.visitors.push(visitor);
    inv.recent = [{ at: now, country: visit.country, page: key }, ...(inv.recent || [])].slice(0, 25);
  });
  if (inv) console.log(key + (preview ? ' preview by ' + preview : ' viewed'), inv.name, inv.views);
}

// Time on the page and how far down it was read, sent by the page itself (engagementTag). Only ever raises the numbers
// on a visit that exists, so a repeat or late ping changes nothing.
export async function invitePing(request, env) {
  const done = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  let b = {};
  try { b = JSON.parse((await request.text()).slice(0, 500)); } catch { return done; }
  const token = String(b.t || ''), id = String(b.v || '');
  if (!TOKEN.test(token) || !/^[A-Za-z0-9_-]{8,16}$/.test(id)) return done;
  const secs = Math.max(0, Math.min(4 * 3600, Math.round(Number(b.s) || 0)));
  const scroll = Math.max(0, Math.min(100, Math.round(Number(b.d) || 0)));
  try {
    await updateInvite(env, token, inv => {
      const v = (Array.isArray(inv.visits) ? inv.visits : []).find(x => x.id === id);
      if (!v || v.preview || (secs <= (v.secs || 0) && scroll <= (v.scroll || 0))) return false;
      v.secs = Math.max(v.secs || 0, secs);
      v.scroll = Math.max(v.scroll || 0, scroll);
    });
  } catch (err) { console.error('invite ping failed', err && err.message); }
  return done;
}

// Google Analytics on the invite pages, so a prospect reading a proposal shows in GA4 (Realtime included). Same property
// as the public site, but loaded straight from gtag.js rather than GTM so only the path is sent: the invite token in the
// address never reaches Google. GA groups these pages as "Proposals", and each open also sends proposal_view (a Key
// Event) with the page's path. Since 16 Nov 2026 the pages have no email button: "Ask me a question" goes to the form
// on the homepage, where generate_lead is the lead (same _ga cookie, so GA4 joins the visit up). The only address left
// is the one email.js writes into the legal line; a click on it still sends contact_click, now an ordinary event, not
// a key event (Monument's own addresses on its draft never count). Never added to Lewis's previews from /admin, nor to
// the locked page.
const GA_ID = 'G-P8648KZWNP';
const GA_TAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('set', { page_location: location.origin + location.pathname, content_group: 'Proposals' });
gtag('config', '${GA_ID}', { page_location: location.origin + location.pathname, content_group: 'Proposals' });
gtag('event', 'proposal_view', { proposal_page: location.pathname });
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a[href^="mailto:"]') : null;
  if (a && /@phillips-uk\\.com/i.test(a.getAttribute('href'))) gtag('event', 'contact_click', { link_url: a.getAttribute('href').split('?')[0] });
}, true);
</script>`;

// Time the page is on screen and how far down it was scrolled, sent back to /invite-ping at 15 s, 1 and 3 minutes and
// whenever the page is hidden or closed, so the admin can show how long each visit was read.
function engagementTag(token, viewId) {
  return `<script>
(function () {
  var ref = ${jsString(token)}, view = ${jsString(viewId)}, shown = 0, since = document.visibilityState === 'visible' ? Date.now() : 0, deep = 0;
  function depth() {
    var h = document.documentElement, room = h.scrollHeight - innerHeight;
    deep = Math.max(deep, room <= 4 ? 100 : Math.min(100, Math.round(scrollY / room * 100)));
  }
  function send() {
    depth();
    var body = JSON.stringify({ t: ref, v: view, s: Math.round((shown + (since ? Date.now() - since : 0)) / 1000), d: deep });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/invite-ping', body))) fetch('/invite-ping', { method: 'POST', body: body, keepalive: true }).catch(function () {});
  }
  addEventListener('scroll', depth, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { if (since) { shown += Date.now() - since; since = 0; } send(); }
    else since = Date.now();
  });
  addEventListener('pagehide', send);
  [15, 60, 180].forEach(function (s) { setTimeout(function () { if (document.visibilityState === 'visible') send(); }, s * 1000); });
})();
</script>`;
}

// Cookie choices (cloudflare/src/consent.js, 22 Nov 2026): the consent defaults go before gtag.js, and the banner
// (/consent.js) goes on pages built on the site's tokens (the rate card); the prospect prototypes have their own look,
// so they get the defaults only.
function withAnalytics(html, token, viewId) {
  const banner = html.includes('tokens:start') ? '\n' + CONSENT_TAG : '';
  const tags = CONSENT_HEAD + '\n' + GA_TAG + (token && viewId ? '\n' + engagementTag(token, viewId) : '') + banner;
  return html.includes('</head>') ? html.replace('</head>', tags + '\n</head>') : tags + html;
}

// One small card page on the site's own look: the locked page, the Search Desk hand-off and its notices.
function noticePage({ title = 'Private page', heading, body, after = '', head = '' }) {
  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} | Phillips.</title><meta name="robots" content="noindex, nofollow, noarchive">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=4">
<link rel="stylesheet" href="/agency.css?v=12">
<style>
/* Design Spec v3: the tokens and fonts come from agency.css; a choice is a centred card */
body{background:var(--bg-art),var(--bg);min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:460px;width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:var(--r-md);padding:40px 36px;background:var(--card-fill) padding-box,var(--card-rim) border-box;box-shadow:var(--e3)}
h1{font-size:28px;font-weight:800;letter-spacing:-0.035em;line-height:1.12;margin:28px 0 12px}
p{font-size:16px;line-height:1.6;color:var(--text-2);margin:0 0 12px}
ol{font-size:15px;line-height:1.6;color:var(--text);margin:0 0 12px;padding-left:20px}
ol li{margin-bottom:4px}
.acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
a.btn{display:inline-flex;align-items:center;min-height:var(--control-h);padding:0 20px;border:1px solid transparent;border-radius:var(--r-pill);background:linear-gradient(180deg,var(--brand-top),var(--brand));color:var(--brand-ink);text-decoration:none;font-weight:800;font-size:15px;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 8px 18px -10px var(--brand-glow);transition:transform var(--d2) var(--ease-out),background var(--d2)}
a.btn:hover{background:linear-gradient(180deg,var(--brand),var(--brand-hover));transform:translateY(-1px)}
a.btn.quiet{background:var(--surface);color:var(--text);border-color:var(--line-2);box-shadow:var(--e1)}
a.btn.quiet:hover{border-color:var(--text-2);background:var(--surface)}
@media (max-width:480px){main{padding:32px 24px}h1{font-size:25px}}
</style>${head}</head><body><main>
<a href="/"><img src="/logo/phillips-lockup.svg" alt="Phillips." style="height:34px;width:auto;display:block"></a>
<h1>${heading}</h1>
<p>${body}</p>
${after}
</main></body></html>`;
}

// The way to ask for a new link: the "Ask me a question" form on the homepage (no email address on the page).
function askFor() {
  return `<div class="acts"><a class="btn" href="https://www.phillips-uk.com/#contact">Ask me a question</a></div>`;
}

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Inside a <script>: JSON, with < escaped so it can never close the tag
const jsString = s => JSON.stringify(String(s)).replace(/</g, '\\u003c');

// The Search Desk hand-off: Search Desk's guest cookie is already set, so this page only sends proposal_view to
// Google Analytics (as the other invite pages do) and moves on to the demo, at most about a second later. Without
// JavaScript it moves on at once. location.replace keeps it out of the back button, so going back never opens a
// second guest session.
function handoffPage(dest) {
  const head = `<noscript><meta http-equiv="refresh" content="0;url=${attr(dest)}"></noscript>
${CONSENT_HEAD}
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
(function () {
  var dest = ${jsString(dest)}, gone = false;
  function go() { if (!gone) { gone = true; location.replace(dest); } }
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', '${GA_ID}', { page_location: location.origin + location.pathname, content_group: 'Proposals' });
  gtag('event', 'proposal_view', { proposal_page: location.pathname, event_callback: go, event_timeout: 900 });
  setTimeout(go, 1200);
})();
</script>`;
  return noticePage({
    title: 'Search Desk demo', head,
    heading: 'Opening the Search Desk demo',
    body: 'Example Car Hire Co. is a made-up company, so try anything you like. Nothing you change is kept.',
    after: `<div class="acts"><a class="btn" href="${attr(dest)}">Open the demo</a></div>`,
  });
}

// What Lewis sees on /search-desk when Search Desk can't give or open a demo link
const DESK_WHY = {
  unavailable: 'Search Desk did not give a demo link, so demo invites show a holding page. Check that the search-desk Worker is up and still exports its DemoLinks entrypoint (the DESK_LINKS binding on this site).',
  refused: 'Search Desk gave a demo link but would not open it, so demo invites show a holding page. Check that Example Car Hire Co. is still active in Search Desk Workspaces.',
};
function renewPage(why) {
  return noticePage({
    title: 'Search Desk demo',
    heading: 'The Search Desk demo is not opening.',
    body: DESK_WHY[why] || DESK_WHY.unavailable,
    after: `<div class="acts"><a class="btn" href="/desk#admin">Open Search Desk</a><a class="btn quiet" href="/admin#links">Back to the admin</a></div>`,
  });
}

export function isRateCardPath(path) {
  return Object.prototype.hasOwnProperty.call(BY_PATH, path);
}

export async function rateCard(request, url, env, ctx) {
  const key = BY_PATH[url.pathname.replace(/\/+$/, '')];
  const page = PAGES[key];
  const PATH = page.cookiePath || page.path;
  const ACCESS = page.access || key;
  // Lewis signed in to /admin sees the page without it counting as a view. For the Search Desk demo he goes straight
  // to /desk: signed in to Search Desk as staff he is switched to the demo company, otherwise he gets a guest session.
  if (await adminEmail(request, env)) {
    if (!page.desk) return new Response(page.html, { status: 200, headers: PRIVATE_HEADERS });
    const open = await openDeskDemo(request, url, env, ctx, null);
    if (!open.location) return new Response(renewPage(open.why), { status: 200, headers: PRIVATE_HEADERS });
    const go = new Headers({ Location: open.location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    open.cookies.forEach(c => go.append('Set-Cookie', c));
    return new Response(null, { status: 302, headers: go });
  }

  const fromUrl = url.searchParams.get('invite');
  const token = fromUrl || readCookie(request, page.cookie);
  const invite = await getInvite(env, token);
  const state = inviteState(invite);
  if (state !== 'active' || !invitePages(invite).includes(ACCESS)) {
    const early = state === 'scheduled' && invitePages(invite).includes(ACCESS);
    const opens = early ? new Date(invite.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' }) : '';
    const locked = noticePage({
      heading: early ? 'This link opens soon.' : 'This page is by invitation.',
      body: early ? `${page.title} opens on ${opens}. Come back then, or ask if you need it sooner.` : `${page.title} is shared by link. If your link has stopped working or you would like a copy, ask and I'll send a new one.`,
      after: askFor(),
    });
    return new Response(locked, { status: 403, headers: PRIVATE_HEADERS });
  }

  // No visitor cookie since 22 Nov 2026 (Lewis: drop it): ph_vid used to tell repeat visits apart, which isn't needed
  // for the page to work. One left over from before is removed. The admin now groups visits by device and place.
  const visitor = null;
  const headers = new Headers(PRIVATE_HEADERS);
  const year = 365 * 86400;
  if (readCookie(request, VISITOR)) headers.append('Set-Cookie', `${VISITOR}=; Path=${PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  if (fromUrl) headers.append('Set-Cookie', `${page.cookie}=${encodeURIComponent(token)}; Path=${PATH}; Max-Age=${year}; HttpOnly; Secure; SameSite=Lax`);

  const viewId = randomId(9);
  ctx.waitUntil(recordView(env, token, visitor, request, key, viewId).catch(err => console.error(key + ' view log failed', err && err.message)));
  if (!page.desk) return new Response(withAnalytics(page.html, token, viewId), { status: 200, headers });

  // The Search Desk demo, on this invite's own share link. The view is counted above either way, so the admin still
  // shows the prospect tried it.
  const open = await openDeskDemo(request, url, env, ctx, invite);
  if (!open.location) {
    const held = noticePage({
      title: 'Search Desk demo',
      heading: 'The demo is being refreshed.',
      body: 'The Search Desk demo is down for a short refresh and your link will work again soon. If you need it sooner, ask and I will sort it.',
      after: askFor(),
    });
    return new Response(held, { status: 503, headers });
  }
  open.cookies.forEach(c => headers.append('Set-Cookie', c));
  return new Response(handoffPage(open.location), { status: 200, headers });
}

export function newToken() {
  return randomId(12);
}
