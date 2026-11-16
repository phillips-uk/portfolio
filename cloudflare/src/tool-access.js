// POST /tool-access { credential }: may this Google sign-in use the free tools (Google Ads audit, landing page audit,
// creative scoring)? The tools are paused (PAUSED in worker.js), but their pages keep a sign-in gate for when they come
// back. Until 16 Nov 2026 each page held the list of allowed addresses in its own source; now the page sends the Google
// credential here and only learns yes or no. Same list as /admin (ALLOWED_AUDIT_EMAILS, or the default in admin.js).
// The tools' own server functions still check the list again before they do anything.
import { allowed, GOOGLE_CLIENT_IDS } from './admin.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

export async function toolAccess(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  let credential = '';
  try { credential = String((await request.json()).credential || ''); } catch { /* empty body */ }
  let ok = false;
  if (credential && credential.length < 4096) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      if (res.ok) {
        const info = await res.json();
        const clientIds = [env.GOOGLE_OAUTH_CLIENT_ID, ...GOOGLE_CLIENT_IDS].filter(Boolean);
        ok = clientIds.includes(info.aud) && info.email_verified !== 'false' && allowed(env).includes(String(info.email || '').toLowerCase());
      }
    } catch { ok = false; }
  }
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 403, headers: HEADERS });
}
