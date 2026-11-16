// Private preview for the relaunched free tools (Website Check, Google Ads Check), 16 Nov 2026.
// Until Lewis says go, the tools are only for someone signed in to /admin: everyone else gets the PAUSED redirects in
// worker.js, and their APIs answer 404. To open a tool to the public, set its flag below to true (and restore its links,
// sitemap entry and llms.txt line), never before Lewis's yes.
import { adminEmail } from './admin.js';

export const TOOLS_PUBLIC = {
  'website-check': false,
  'google-ads-check': false,
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
