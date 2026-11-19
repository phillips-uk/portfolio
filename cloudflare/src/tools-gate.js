// Who may use the relaunched free tools (Website Check, Google Ads Check). Built as a private preview on 16 Nov 2026 and
// opened to the public the same day (Lewis: "make the tools public now"). Setting a flag back to false makes that tool
// private again: only someone signed in to /admin can open it, everyone else is redirected (worker.js) and its APIs
// answer 404.
import { adminEmail } from './admin.js';

export const TOOLS_PUBLIC = {
  'website-check': true,
  'google-ads-check': true,
};

// Who may use a tool right now: { allowed, admin } where admin is the signed-in admin email or null.
export async function toolAccessFor(tool, request, env) {
  const admin = await adminEmail(request, env);
  return { allowed: !!(TOOLS_PUBLIC[tool] || admin), admin };
}

export const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow, noarchive' };

export function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...NO_INDEX, ...extra },
  });
}

export async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Cloudflare Turnstile, checked on the server, as on the contact form (enquiry.js). Same widget, its own action.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
const LIVE_HOST = 'www.phillips-uk.com';
export async function turnstileOk(env, request, token, action) {
  const url = new URL(request.url);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const secret = local ? TURNSTILE_TEST_SECRET : env.TURNSTILE_SECRET;
  if (!secret || !token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', String(token).slice(0, 2048));
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);
  try {
    const check = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })).json();
    if (!check || !check.success) return false;
    if (local) return true;
    return check.hostname === LIVE_HOST && (!check.action || check.action === action);
  } catch {
    return false;
  }
}

// The London calendar day, YYYY-MM-DD.
export const londonDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);

// Spam and crawlers (Lewis, 19 Nov 2026). Every tool request that does work goes through guard() first: it must come
// from this site's own page (a browser always sends Origin on these POSTs), from something that says it is a browser,
// and within the per-connection rate. Turnstile is checked on top of this wherever a check starts (turnstileOk). All of
// it runs in the Worker on Cloudflare's free plan; nothing here is a paid service. IP addresses are hashed, never stored.
const BOT_UA = /bot[\/;)]|\+https?:|crawl|spider|slurp|scrap|curl\/|wget|python|httpclient|http-client|okhttp|go-http|node-fetch|undici|axios|java\/|libwww|perl|ruby|php\/|postman|insomnia|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|chrome-lighthouse|facebookexternalhit|preview|monitor|uptime/i;
export function looksLikeBot(request) {
  const ua = request.headers.get('User-Agent') || '';
  return ua.length < 20 || !/^Mozilla\/5\.0 /.test(ua) || BOT_UA.test(ua);
}

// At most `max` requests from one connection in `minutes`, per bucket. Lewis's own requests are never counted.
export async function overRate(env, request, bucket, max, minutes) {
  if (!env.BLOBS) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = 'tools/rate/' + bucket + '/' + await sha(ip + '|' + (env.WORKER_SECRET || 'phillips')) + '.json';
  const since = Date.now() - minutes * 60000;
  let times = [];
  const obj = await env.BLOBS.get(key);
  if (obj) { try { times = (await obj.json()).filter(t => t > since); } catch { times = []; } }
  if (times.length >= max) return true;
  times.push(Date.now());
  await env.BLOBS.put(key, JSON.stringify(times), { httpMetadata: { contentType: 'application/json' } });
  return false;
}

// Returns null when the request may go on, or { reason, response } when it is refused. Lewis (signed in to /admin) passes.
export async function guard(env, request, access, bucket, max, minutes) {
  if (access && access.admin) return null;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) return { reason: 'origin', response: jsonResponse({ error: 'Forbidden' }, 403) };
  if (looksLikeBot(request)) return { reason: 'bot', response: jsonResponse({ error: 'I couldn’t run this free check from here. Please try again in your web browser, or ask me a question below.' }, 403) };
  if (await overRate(env, request, bucket, max, minutes)) return { reason: 'rate', response: jsonResponse({ error: 'Too many checks from this connection. Please wait a while and try again, or ask me a question below.', limit: true }, 429) };
  return null;
}

// Weekly clean-up of the per-connection rate records (from the Worker's cron, with the tools' own clean-ups).
export async function cleanupToolRates(env) {
  const cutoff = Date.now() - 2 * 86400000;
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: 'tools/rate/', cursor });
    const old = page.objects.filter(o => new Date(o.uploaded).getTime() < cutoff).map(o => o.key);
    if (old.length) await env.BLOBS.delete(old);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
