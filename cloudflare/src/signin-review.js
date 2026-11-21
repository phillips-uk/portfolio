// Reviewer access to "Sign in with Google" while Google verifies the app (Nov 2026). Google's reviewers must be able to
// reach the sign-in, but it stays hidden from the public until approval. Opening
//   https://www.phillips-uk.com/google-ads-audit?review=<SIGNIN_REVIEW_CODE>
// sets a signed cookie for 30 days that shows the sign-in in that browser only. The code is the Worker secret
// SIGNIN_REVIEW_CODE (never in the repo or the vault); without the secret, review access is off. Delete the secret
// (and this file's use) once FLAGS.googleSignIn is on for everyone.
const COOKIE = 'ph_gads_review';
const DAYS = 30;

const enc = new TextEncoder();
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

async function mac(env, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.WORKER_SECRET + '|signin-review'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// True when this browser holds a valid reviewer cookie.
export async function isReviewer(request, env) {
  if (!env.SIGNIN_REVIEW_CODE || !env.WORKER_SECRET) return false;
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await mac(env, exp));
}

// For /google-ads-audit?review=...: a redirect to the clean address that sets the cookie when the code is right,
// or null to carry on as normal (a wrong code changes nothing).
export async function reviewEntry(url, env) {
  const code = url.searchParams.get('review');
  if (!code || !env.SIGNIN_REVIEW_CODE || !env.WORKER_SECRET || !same(code, env.SIGNIN_REVIEW_CODE)) return null;
  const exp = String(Date.now() + DAYS * 86400000);
  const value = exp + '.' + await mac(env, exp);
  return new Response(null, { status: 302, headers: {
    Location: '/google-ads-audit',
    'Set-Cookie': `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
  } });
}
