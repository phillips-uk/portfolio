/**
 * creative-auth.js
 * Netlify Function — verifies a Google Identity Services credential and returns
 * a signed HMAC session token for use with creative-upload.js.
 *
 * POST { googleToken } → { token } on success
 *                      → { error }  on failure
 *
 * Token format: base64url(timestamp:hmac-sha256(timestamp, pin+siteId))
 * Valid for 24 hours. Verified by creative-upload.js / creative-analyse-background.js.
 *
 * Env vars: CREATIVE_UPLOAD_PIN (internal HMAC key), NETLIFY_SITE_ID,
 *           ALLOWED_AUDIT_EMAILS, GOOGLE_OAUTH_CLIENT_ID
 */

'use strict';

const crypto = require('crypto');

// ── Google token verification ─────────────────────────────────────────────────

async function verifyGoogleToken(credential) {
  if (!credential) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!res.ok) return null;
    const payload = await res.json();
    const validAuds = [
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      '339165209514-jn3kstpi7on9jtl160afc8el2j5a4h1m.apps.googleusercontent.com'
    ].filter(Boolean);
    if (!validAuds.includes(payload.aud)) return null;
    return (payload.email || '').toLowerCase();
  } catch { return null; }
}

// ── Token construction ────────────────────────────────────────────────────────

function makeToken(pin, siteId) {
  const ts  = Date.now().toString();
  const mac = crypto
    .createHmac('sha256', pin + siteId)
    .update(ts)
    .digest('hex');
  return Buffer.from(ts + ':' + mac).toString('base64url');
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { googleToken } = body;

  if (!googleToken || typeof googleToken !== 'string') {
    return json({ error: 'Google token required' }, 400);
  }

  // Verify Google credential and check email allowlist
  const verifiedEmail = await verifyGoogleToken(googleToken);
  const allowedEmails = (process.env.ALLOWED_AUDIT_EMAILS || 'lewis@phillips-uk.com,lewisdp87@gmail.com')
    .toLowerCase().split(',').map(e => e.trim()).filter(Boolean);

  if (!verifiedEmail || !allowedEmails.includes(verifiedEmail)) {
    console.warn(`[creative-auth] Blocked — token email: ${verifiedEmail || 'none'}`);
    return json({ error: 'Access restricted' }, 403);
  }

  const pin = process.env.CREATIVE_UPLOAD_PIN;
  if (!pin) {
    console.error('[creative-auth] CREATIVE_UPLOAD_PIN env var is not set');
    return json({ error: 'Service unavailable' }, 503);
  }

  const siteId = process.env.NETLIFY_SITE_ID || 'phillips';
  const token  = makeToken(pin, siteId);

  return json({ token });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store'
    },
    body: JSON.stringify(obj)
  };
}
