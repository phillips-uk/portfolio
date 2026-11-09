// Private pages that open with an invite link made in /admin: the rate card, the Search Desk demo and prospect prototypes.
//   /rate-card?invite=<token>   /search-desk?invite=<token>   /the-loft?invite=<token>   /monument?invite=<token>
// A page can ride on another page's invite (`access`) and share its cookie path (`cookiePath`), so one link opens a
// small multi-page proposal: /monument and /monument/calculators both open with a "monument" invite.
// The link itself is meant to be forwarded, so the token stays in the address bar. A cookie also remembers it, so the
// plain address keeps working in the same browser. Invites live in R2 under rate-card-invites/<token>.json and list the
// pages they open in `pages` (invites made before the demo existed have none and open the rate card only).
// A link is live between `startsAt` (optional) and `expiresAt` (optional); outside that window it shows a locked page.
import rateCardHtml from '../private/rate-card.html';
import searchDeskHtml from '../private/search-desk.html';
import theLoftHtml from '../private/the-loft.html';
import monumentHtml from '../private/monument.html';
import monumentCalculatorsHtml from '../private/monument-calculators.html';
import { adminEmail } from './admin.js';

export const PAGES = {
  'rate-card': { path: '/rate-card', html: rateCardHtml, cookie: 'ph_rc', title: 'The rate card' },
  'search-desk': { path: '/search-desk', html: searchDeskHtml, cookie: 'ph_sd', title: 'The Search Desk demo' },
  // The Loft (Nick, Ely): the booking app prototype. Phone frame on desktop, full screen on a phone.
  'the-loft': { path: '/the-loft', html: theLoftHtml, cookie: 'ph_tl', title: 'The Loft prototype' },
  // Monument Corporate Finance (Ben Boateng): the website draft, a homepage plus its calculators page. One invite opens both.
  'monument': { path: '/monument', html: monumentHtml, cookie: 'ph_mcf', cookiePath: '/monument', title: 'The Monument website draft' },
  'monument-calculators': { path: '/monument/calculators', html: monumentCalculatorsHtml, cookie: 'ph_mcf', cookiePath: '/monument', access: 'monument', title: 'The Monument website draft' },
};
const BY_PATH = Object.fromEntries(Object.entries(PAGES).map(([key, p]) => [p.path, key]));
const VISITOR = 'ph_vid';
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

async function recordView(env, token, visitor, request, key) {
  const inv = await getInvite(env, token);
  if (!inv) return;
  const now = new Date().toISOString();
  const country = (request.cf && request.cf.country) || '';
  inv.views = (inv.views || 0) + 1;
  inv.pageViews = inv.pageViews || {};
  inv.pageViews[key] = (inv.pageViews[key] || 0) + 1;
  inv.lastViewedAt = now;
  inv.lastCountry = country;
  inv.visitors = inv.visitors || [];
  if (visitor && !inv.visitors.includes(visitor) && inv.visitors.length < 200) inv.visitors.push(visitor);
  inv.recent = [{ at: now, country, page: key }, ...(inv.recent || [])].slice(0, 25);
  await putInvite(env, inv);
  console.log(key + ' viewed', inv.name, inv.views);
}

// Google Analytics on the invite pages, so a prospect reading a proposal shows in GA4 (Realtime included). Same property
// as the public site, but loaded straight from gtag.js rather than GTM so only the path is sent: the invite token in the
// address never reaches Google. GA groups these pages as "Proposals", and each open also sends proposal_view (a Key
// Event) with the page's path. A click on a Phillips. email address counts as
// contact_click, like the public site (Monument's own addresses on its draft do not). Never added to Lewis's previews
// from /admin, nor to the locked page.
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

function withAnalytics(html) {
  return html.includes('</head>') ? html.replace('</head>', GA_TAG + '\n</head>') : GA_TAG + html;
}

const LOCKED_HTML = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Private page | Phillips.</title><meta name="robots" content="noindex, nofollow, noarchive">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=4">
<style>
body{margin:0;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#1A1A1A;background:#FDF6EE;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:460px;background:#fff;border:1px solid #E8D8C4;border-radius:8px;padding:40px 36px}
h1{font-size:28px;letter-spacing:-0.025em;line-height:1.15;margin:28px 0 12px}
p{font-size:16px;line-height:1.6;color:#6B6B6B;margin:0 0 12px}
a.btn{display:inline-block;margin-top:12px;background:#985830;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 18px;border-radius:6px}
a.btn:hover{background:#7A3F1F}
</style></head><body><main>
<a href="/"><img src="/logo/phillips-lockup.svg" alt="Phillips." style="height:34px;width:auto;display:block"></a>
<h1>__HEADING__</h1>
<p>__BODY__</p>
<p><strong style="color:#1A1A1A">contact@phillips-uk.com</strong></p>
<a class="btn" href="mailto:contact@phillips-uk.com?subject=__SUBJECT__">Ask for access</a>
</main></body></html>`;

export function isRateCardPath(path) {
  return Object.prototype.hasOwnProperty.call(BY_PATH, path);
}

export async function rateCard(request, url, env, ctx) {
  const key = BY_PATH[url.pathname.replace(/\/+$/, '')];
  const page = PAGES[key];
  const PATH = page.cookiePath || page.path;
  const ACCESS = page.access || key;
  // Lewis signed in to /admin sees the page without it counting as a view.
  if (await adminEmail(request, env)) return new Response(page.html, { status: 200, headers: PRIVATE_HEADERS });

  const fromUrl = url.searchParams.get('invite');
  const token = fromUrl || readCookie(request, page.cookie);
  const invite = await getInvite(env, token);
  const state = inviteState(invite);
  if (state !== 'active' || !invitePages(invite).includes(ACCESS)) {
    const early = state === 'scheduled' && invitePages(invite).includes(ACCESS);
    const opens = early ? new Date(invite.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' }) : '';
    const locked = LOCKED_HTML
      .replace('__HEADING__', early ? 'This link opens soon.' : 'This page is by invitation.')
      .replace('__BODY__', early ? `${page.title} opens on ${opens}. Come back then, or ask if you need it sooner.` : `${page.title} is shared by link. If your link has stopped working or you would like a copy, ask and I'll send a new one.`)
      .replace('__SUBJECT__', encodeURIComponent(page.title.replace(/^The /, '') + ' access'));
    return new Response(locked, { status: 403, headers: PRIVATE_HEADERS });
  }

  let visitor = readCookie(request, VISITOR);
  const headers = new Headers(PRIVATE_HEADERS);
  const year = 365 * 86400;
  if (!visitor || !/^[A-Za-z0-9_-]{8,16}$/.test(visitor)) {
    visitor = randomId(9);
    headers.append('Set-Cookie', `${VISITOR}=${visitor}; Path=${PATH}; Max-Age=${year}; HttpOnly; Secure; SameSite=Lax`);
  }
  if (fromUrl) headers.append('Set-Cookie', `${page.cookie}=${encodeURIComponent(token)}; Path=${PATH}; Max-Age=${year}; HttpOnly; Secure; SameSite=Lax`);

  ctx.waitUntil(recordView(env, token, visitor, request, key).catch(err => console.error(key + ' view log failed', err && err.message)));
  return new Response(withAnalytics(page.html), { status: 200, headers });
}

export function newToken() {
  return randomId(12);
}
