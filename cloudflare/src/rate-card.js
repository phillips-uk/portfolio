// Private rate card at /rate-card. Opens with an invite link made in /admin:
//   /rate-card?invite=<token>
// The link itself is meant to be forwarded, so the token stays in the address bar. A cookie also remembers it, so the
// plain /rate-card address keeps working in the same browser. Invites live in R2 under rate-card-invites/<token>.json.
import rateCardHtml from '../private/rate-card.html';
import { adminEmail } from './admin.js';

const COOKIE = 'ph_rc';
const VISITOR = 'ph_vid';
const PATH = '/rate-card';
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

export function inviteState(inv) {
  if (!inv) return 'missing';
  if (inv.revoked) return 'revoked';
  if (inv.expiresAt && inv.expiresAt < new Date().toISOString()) return 'expired';
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

async function recordView(env, token, visitor, request) {
  const inv = await getInvite(env, token);
  if (!inv) return;
  const now = new Date().toISOString();
  const country = (request.cf && request.cf.country) || '';
  inv.views = (inv.views || 0) + 1;
  inv.lastViewedAt = now;
  inv.lastCountry = country;
  inv.visitors = inv.visitors || [];
  if (visitor && !inv.visitors.includes(visitor) && inv.visitors.length < 200) inv.visitors.push(visitor);
  inv.recent = [{ at: now, country }, ...(inv.recent || [])].slice(0, 25);
  await putInvite(env, inv);
  console.log('rate-card viewed', inv.name, inv.views);
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
<h1>This page is by invitation.</h1>
<p>The rate card is shared by link. If your link has stopped working or you would like a copy, ask and I'll send a new one.</p>
<p><strong style="color:#1A1A1A">contact@phillips-uk.com</strong></p>
<a class="btn" href="mailto:contact@phillips-uk.com?subject=Rate%20card%20access">Ask for access</a>
</main></body></html>`;

export function isRateCardPath(path) {
  return path === PATH;
}

export async function rateCard(request, url, env, ctx) {
  // Lewis signed in to /admin sees the page without it counting as a view.
  if (await adminEmail(request, env)) return new Response(rateCardHtml, { status: 200, headers: PRIVATE_HEADERS });

  const fromUrl = url.searchParams.get('invite');
  const token = fromUrl || readCookie(request, COOKIE);
  const invite = await getInvite(env, token);
  if (inviteState(invite) !== 'active') return new Response(LOCKED_HTML, { status: 403, headers: PRIVATE_HEADERS });

  let visitor = readCookie(request, VISITOR);
  const headers = new Headers(PRIVATE_HEADERS);
  const year = 365 * 86400;
  if (!visitor || !/^[A-Za-z0-9_-]{8,16}$/.test(visitor)) {
    visitor = randomId(9);
    headers.append('Set-Cookie', `${VISITOR}=${visitor}; Path=${PATH}; Max-Age=${year}; HttpOnly; Secure; SameSite=Lax`);
  }
  if (fromUrl) headers.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=${PATH}; Max-Age=${year}; HttpOnly; Secure; SameSite=Lax`);

  ctx.waitUntil(recordView(env, token, visitor, request).catch(err => console.error('rate-card view log failed', err && err.message)));
  return new Response(rateCardHtml, { status: 200, headers });
}

export function newToken() {
  return randomId(12);
}
