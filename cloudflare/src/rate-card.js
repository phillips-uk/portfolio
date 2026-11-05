// Private rate card at /rate-card. Opens only through a signed invite link:
//   /rate-card?invite=<label>.<expiryDay>.<signature>
// The link sets a cookie, then redirects to the clean URL. Links are made with cloudflare/scripts/rate-card-invite.mjs
// and signed with the RATE_CARD_KEY Worker secret. Revoke a link by adding its label to the RATE_CARD_REVOKED var.
import rateCardHtml from '../private/rate-card.html';

const COOKIE = 'ph_rc';
const PATH = '/rate-card';
const LABEL = /^[a-z0-9-]{1,40}$/;

const PRIVATE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(key, payload) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload))).slice(0, 22);
}

// Returns the invite's label when the token is genuine, unexpired and not revoked, otherwise null.
async function verify(token, env) {
  if (!token || !env.RATE_CARD_KEY) return null;
  const [label, day, sig] = token.split('.');
  if (!LABEL.test(label || '') || !/^\d{5}$/.test(day || '') || !sig) return null;
  if (Number(day) < Math.floor(Date.now() / 86400000)) return null;
  const revoked = (env.RATE_CARD_REVOKED || '').split(',').map(s => s.trim()).filter(Boolean);
  if (revoked.includes(label)) return null;
  const expected = await sign(env.RATE_CARD_KEY, `${label}.${day}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? label : null;
}

function readCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const LOCKED_HTML = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Private page | Phillips.</title><meta name="robots" content="noindex, nofollow, noarchive">
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3">
<style>
body{margin:0;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#1A1A1A;background:#FDF6EE;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{max-width:460px;background:#fff;border:1px solid #E8D8C4;border-radius:8px;padding:40px 36px}
.logo{font-size:24px;font-weight:700;letter-spacing:-0.01em;color:#1A1A1A;text-decoration:none}.logo span{color:#985830}
h1{font-size:28px;letter-spacing:-0.025em;line-height:1.15;margin:28px 0 12px}
p{font-size:16px;line-height:1.6;color:#6B6B6B;margin:0 0 12px}
a.btn{display:inline-block;margin-top:12px;background:#985830;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 18px;border-radius:6px}
a.btn:hover{background:#7A3F1F}
</style></head><body><main>
<a class="logo" href="/"><img src="/logo/phillips-lockup.svg" alt="Phillips." style="height:34px;width:auto;display:block"></a>
<h1>This page is by invitation.</h1>
<p>The rate card is shared one person at a time. If your link has expired or you would like a copy, ask and I'll send a new one.</p>
<p><strong style="color:#1A1A1A">contact@phillips-uk.com</strong></p>
<a class="btn" href="mailto:contact@phillips-uk.com?subject=Rate%20card%20access">Ask for access</a>
</main></body></html>`;

export function isRateCardPath(path) {
  return path === PATH;
}

export async function rateCard(request, url, env) {
  const invite = url.searchParams.get('invite');
  if (invite) {
    const label = await verify(invite, env);
    if (label) {
      const maxAge = Math.max(60, Number(invite.split('.')[1]) * 86400 + 86400 - Math.floor(Date.now() / 1000));
      console.log('rate-card invite opened', label);
      return new Response(null, {
        status: 302,
        headers: {
          Location: PATH,
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(invite)}; Path=${PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'private, no-store',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
  }

  const label = await verify(readCookie(request), env);
  if (label) {
    console.log('rate-card viewed', label);
    return new Response(rateCardHtml, { status: 200, headers: PRIVATE_HEADERS });
  }
  return new Response(LOCKED_HTML, { status: 403, headers: PRIVATE_HEADERS });
}
