// "Sign in with Google" for the Google Ads Check (plan section 2; verification pack:
// vault 01_Phillips/04_Products/Google Sign-in Verification Pack.md). Built 16 Nov 2026.
//
// Until Google verifies the app (the adwords scope is sensitive), it is off for visitors. FLAGS.googleSignInPreview in
// google-ads-check.js shows it to Lewis signed in to /admin (off since 16 Nov 2026 until he records the review video);
// FLAGS.googleSignIn turns it on for everyone once Google approves.
//
// How the permission is held: Google's sign-in uses the Phillips Tools OAuth client ("Phillips. free tools") with
// access_type=online, so Google issues no refresh token. The short-lived access token (about an hour from Google, kept
// at most 15 minutes here) sits only in an encrypted, HttpOnly cookie in the visitor's own browser, limited to the
// check's addresses. Nothing is written to storage. The cookie is deleted as soon as a check runs, or on sign-out.
// Reads only: the check never changes anything in the account.
//
// Routes (all under /tools/google-ads-check/oauth/)
//   GET  start      sends the visitor to Google's sign-in
//   GET  callback   Google sends them back here with a code, swapped for the access token
//   GET  accounts   the Google Ads accounts that login can reach
//   POST run        { customerId, via } runs the check on one of them, then forgets the token
//   POST signout    forgets the token
import { FLAGS, freeLimits, buildReport, publicReport, accountIdFor } from './google-ads-check.js';
import { asVisitor, accessibleAccounts, meter, AdsError } from './ads-check/client.js';
import { toolAccessFor, jsonResponse, guard } from './tools-gate.js';
import { countUse } from './tool-leads.js';
import { getPricing } from './pricing.js';
import { isReviewer } from './signin-review.js';

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const BASE = '/tools/google-ads-check/oauth';
const TOKEN_COOKIE = 'ph_gads';
const STATE_COOKIE = 'ph_gads_oauth';
const TOKEN_SECONDS = 15 * 60;

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function key(env) {
  if (!env.WORKER_SECRET) throw new Error('WORKER_SECRET is not set');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.WORKER_SECRET + '|google-signin'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(JSON.stringify(obj))));
  return b64url(iv) + '.' + b64url(ct);
}
async function open(env, value) {
  try {
    const [iv, ct] = String(value || '').split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, await key(env), unb64url(ct));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    return obj && obj.exp > Date.now() ? obj : null;
  } catch { return null; }
}
const readCookie = (request, name) => {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
const cookie = (name, value, path, maxAge) => `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const clearToken = () => cookie(TOKEN_COOKIE, '', '/tools/google-ads-check', 0);

// A small page that moves on with a script, so the next request is same-site and carries the /admin sign-in cookie.
function moveOn(to, setCookies = []) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(`<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Signing in | Phillips.</title><meta name="robots" content="noindex"><style>:root{color-scheme:light}body{margin:0;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;background:#fff;color:#1A1A1A;display:grid;place-items:center;min-height:100vh}</style></head><body><p>One moment…</p><script>location.replace(${JSON.stringify(to)})</script></body></html>`, { headers });
}

const redirectUri = url => url.origin + BASE + '/callback';

async function allowed(request, env) {
  const access = await toolAccessFor('google-ads-check', request, env);
  // Google's reviewers get in through a private review link (signin-review.js) while the app is being verified.
  const signIn = FLAGS.googleSignIn ? access.allowed : (access.admin && FLAGS.googleSignInPreview) || (access.allowed && await isReviewer(request, env));
  return { ...access, signIn: !!signIn };
}

async function start(request, url, env) {
  const access = await allowed(request, env);
  if (!access.signIn) return new Response('Not found', { status: 404 });
  if (!env.GOOGLE_ADS_CLIENT_ID) return new Response('Google sign-in is not set up.', { status: 503 });
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env.GOOGLE_ADS_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code', scope: SCOPE,
    // ?consent=1, Lewis only: Google shows its permission screen again even for a login that already allowed the app,
    // so the verification video can show it. Visitors always get the normal prompt.
    access_type: 'online', prompt: access.admin && url.searchParams.get('consent') === '1' ? 'select_account consent' : 'select_account', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  const headers = new Headers({ Location: auth, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(STATE_COOKIE, await seal(env, { state, verifier, exp: Date.now() + 600000 }), BASE, 600));
  return new Response(null, { status: 302, headers });
}

async function callback(request, url, env) {
  const saved = await open(env, readCookie(request, STATE_COOKIE));
  const clearState = cookie(STATE_COOKIE, '', BASE, 0);
  if (!saved || url.searchParams.get('state') !== saved.state) return moveOn('/google-ads-audit?signin=expired', [clearState]);
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return moveOn('/google-ads-audit?signin=cancelled', [clearState]);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID, client_secret: env.GOOGLE_ADS_CLIENT_SECRET, code: url.searchParams.get('code'),
      code_verifier: saved.verifier, redirect_uri: redirectUri(url), grant_type: 'authorization_code',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) { console.error('google-signin: token swap failed', res.status, j.error || ''); return moveOn('/google-ads-audit?signin=failed', [clearState]); }
  if (!String(j.scope || '').includes(SCOPE)) return moveOn('/google-ads-audit?signin=noscope', [clearState]);
  // Only the access token is kept, in the visitor's browser. A refresh token is never asked for (access_type=online).
  const seconds = Math.min(TOKEN_SECONDS, Math.max(60, Number(j.expires_in || 0) - 60));
  const sealed = await seal(env, { t: j.access_token, exp: Date.now() + seconds * 1000 });
  return moveOn('/google-ads-audit?signin=1', [clearState, cookie(TOKEN_COOKIE, sealed, '/tools/google-ads-check', seconds)]);
}

async function token(request, env) {
  const t = await open(env, readCookie(request, TOKEN_COOKIE));
  return t && t.t;
}

async function accounts(request, env) {
  const access = await allowed(request, env);
  if (!access.signIn) return jsonResponse({ error: 'Not found' }, 404);
  const t = await token(request, env);
  if (!t) return jsonResponse({ error: 'Your Google sign-in has expired. Please sign in again.', signin: true }, 401);
  try {
    const list = await accessibleAccounts(asVisitor(env, t, ''), meter());
    const pricing = await getPricing(env);
    const underManager = list.filter(a => a.via).length;
    return jsonResponse({
      accounts: list.filter(a => !a.manager),
      // A login that reaches more accounts through a manager than the threshold is treated as an agency (plan section 5)
      agency: underManager > pricing.settings.limits.agencyAccountThreshold,
    });
  } catch (err) {
    console.error('google-signin: accounts', err && (err.code || err.message));
    const expired = err instanceof AdsError && (err.status === 401 || err.kind === 'auth');
    return jsonResponse({ error: expired ? 'Your Google sign-in has expired. Please sign in again.' : 'I couldn’t list your Google Ads accounts just now. Please try again.', signin: expired }, expired ? 401 : 502,
      expired ? { 'Set-Cookie': clearToken() } : {});
  }
}

async function run(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await allowed(request, env);
  if (!access.signIn) return jsonResponse({ error: 'Not found' }, 404);
  // The Google sign-in itself shows a person is there, so no Turnstile here; the same crawler and rate checks as the
  // manager-link run (tools-gate.js) still apply.
  const blocked = await guard(env, request, access, 'google-ads-check', 6, 60);
  if (blocked) { await countUse(env, 'google-ads-check', 'blocked', blocked.reason); return blocked.response; }
  const t = await token(request, env);
  if (!t) return jsonResponse({ error: 'Your Google sign-in has expired. Please sign in again.', signin: true }, 401);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const customerId = String(body.customerId || '').replace(/\D/g, '');
  const via = String(body.via || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(customerId) || (via && !/^\d{10}$/.test(via))) return jsonResponse({ error: 'Choose one of your accounts.' }, 400);
  const pricing = await getPricing(env);
  const limit = await freeLimits(env, access, customerId, pricing);
  if (limit.error) { await countUse(env, 'google-ads-check', 'blocked', limit.reason); return limit.error; }
  const m = meter();
  try {
    // Google checks this login really can reach the account (and through that manager), so nothing else is trusted here.
    const out = await buildReport(asVisitor(env, t, via), env, m, customerId, access, pricing, limit, 'google-sign-in', { accountId: await accountIdFor(request, env) });
    if (out.error) return out.error;
    return jsonResponse({ report: publicReport(out.report, access.admin) }, 200, { 'Set-Cookie': clearToken() });
  } catch (err) {
    console.error('google-signin: run failed', err && (err.code || err.message));
    if (!access.admin) await countUse(env, 'google-ads-check', 'failed');
    return jsonResponse({ error: 'Something went wrong while reading the account. Nothing was changed. Please sign in and try again, or ask me a question below.' }, 502, { 'Set-Cookie': clearToken() });
  }
}

export async function googleSignIn(request, url, env, path) {
  const what = path.slice(BASE.length + 1);
  if (what === 'start' && request.method === 'GET') return start(request, url, env);
  if (what === 'callback' && request.method === 'GET') return callback(request, url, env);
  if (what === 'accounts' && request.method === 'GET') return accounts(request, env);
  if (what === 'run' && request.method === 'POST') return run(request, env);
  if (what === 'signout' && request.method === 'POST') return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearToken() });
  return jsonResponse({ error: 'Not found' }, 404);
}

export const isSignInPath = path => path.startsWith(BASE + '/');
