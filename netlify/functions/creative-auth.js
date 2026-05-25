/**
 * creative-auth.js
 * Netlify Function — validates a PIN and returns a signed token.
 *
 * POST { pin } → { token } on success
 *             → { error }  on failure
 *
 * Token format: base64url(timestamp:hmac-sha256(timestamp, pin+siteId))
 * Valid for 24 hours. Verified by creative-analyse-background.js.
 *
 * Env vars: CREATIVE_UPLOAD_PIN, NETLIFY_SITE_ID
 */

'use strict';

const crypto = require('crypto');

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

  const { pin } = body;

  if (!pin || typeof pin !== 'string') {
    return json({ error: 'PIN is required' }, 400);
  }

  const correctPin = process.env.CREATIVE_UPLOAD_PIN;
  if (!correctPin) {
    console.error('[creative-auth] CREATIVE_UPLOAD_PIN env var is not set');
    return json({ error: 'Service unavailable' }, 503);
  }

  // Constant-time comparison to prevent timing attacks
  const pinMatch = (() => {
    try {
      const a = Buffer.from(pin);
      const b = Buffer.from(correctPin);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  })();

  if (!pinMatch) {
    return json({ error: 'Invalid PIN' }, 401);
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
