// POST /enquiry: the "Ask me a question" form on phillips-uk.com.
// Each question is saved to R2 (admin/enquiries/), added to the /admin sales funnel as a Lead card, and emailed to
// contact@phillips-uk.com through Resend when the RESEND_API_KEY secret is set (no key: saved and on the board only).
// Since 16 Nov 2026 that email is branded HTML (enquiry-email.js) with a plain text version, and links to the Lead card.
// Spam: a hidden trap field, a minimum time on the page, at most RATE_MAX questions an hour from one connection, and
// Cloudflare Turnstile (since 16 Nov 2026; widget "Phillips. contact form (phillips-uk.com)", secret TURNSTILE_SECRET).
// The trap and the timer give bots the same "sent" answer as people, so they learn nothing; a failed Turnstile check
// asks the person to try again, as a real person can fail it too. No IP address is stored.
// Local dev (localhost) uses Cloudflare's always-pass test secret; every other host needs the real one.
import { addLead } from './pipeline.js';
import { BRANDS, renderEnquiryEmail, mailtoAddress } from './enquiry-email.js';

const LIMITS = { name: 120, email: 160, business: 160, message: 4000, page: 200, location: 40 };
const MIN_MS = 3000;       // a person needs longer than this to fill in the form
const RATE_MAX = 5;        // questions per connection per hour
const LIVE_HOST = 'www.phillips-uk.com';
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
const NOTIFY_TO = 'contact@phillips-uk.com';
const NOTIFY_FROM = 'Phillips. website <website@phillips-uk.com>';

const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/\s+/g, ' ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WEBSITE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) { try { return { data: await request.json(), form: false }; } catch { return { data: {}, form: false }; } }
  const fd = await request.formData().catch(() => null);
  return { data: fd ? Object.fromEntries(fd) : {}, form: true };
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function overLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = 'admin/enquiry-rate/' + await sha(ip + '|' + (env.WORKER_SECRET || 'phillips'));
  const hourAgo = Date.now() - 3600 * 1000;
  let times = [];
  const obj = await env.BLOBS.get(key);
  if (obj) { try { times = (await obj.json()).filter(t => t > hourAgo); } catch { times = []; } }
  if (times.length >= RATE_MAX) return true;
  times.push(Date.now());
  await env.BLOBS.put(key, JSON.stringify(times), { httpMetadata: { contentType: 'application/json' } });
  return false;
}

// Cloudflare Turnstile, checked on the server: the answer must be fresh, for this form, and solved on this site.
async function humanCheck(env, request, url, token) {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const secret = local ? TURNSTILE_TEST_SECRET : env.TURNSTILE_SECRET;
  if (!secret) { console.error('enquiry: TURNSTILE_SECRET is not set'); return false; }
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', String(token).slice(0, 2048));
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);
  try {
    const check = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })).json();
    if (!check || !check.success) return false;
    if (local) return true;
    return check.hostname === LIVE_HOST && (!check.action || check.action === 'enquiry');
  } catch {
    return false;
  }
}

// A mailto: link whose address can't add its own cc, bcc or body (mailtoAddress encodes ?, &, # and %).
const mailto = (email, subject) => 'mailto:' + mailtoAddress(email) + (subject ? '?subject=' + encodeURIComponent(subject) : '');

const LONDON_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
const LONDON_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// The branded email (cloudflare/src/enquiry-email.js, the layout shared by every Phillips Group site), with a plain
// text version alongside. Every visitor value is escaped by the renderer.
export function enquiryEmail(q, { cardId, at }) {
  const subject = `Website question from ${q.name}`;
  const first = q.name.split(/\s+/)[0] || q.name;
  const sentFrom = 'phillips-uk.com' + (q.page || '');
  const when = at || new Date();
  const board = 'https://www.phillips-uk.com/admin#prospects' + (cardId ? '/' + cardId : '');
  const fields = [
    ['Name', q.name],
    ['Email', q.email, mailto(q.email)],
    // Gmail would link a web address in its own blue, so the email links it: the visitor's website in the brand accent
    // (any address inside other text is handled by the renderer), and the page, which the site writes, as a quiet link.
    q.business ? ['Business or website', q.business, WEBSITE.test(q.business) ? (/^https?:\/\//i.test(q.business) ? '' : 'https://') + q.business : undefined] : null,
    ['Sent from', sentFrom, undefined, true],
  ].filter(Boolean);
  const { html, text } = renderEnquiryEmail(BRANDS.phillips, {
    kind: 'Website question',
    title: `New question from ${q.name}`,
    fields,
    message: q.message,
    primary: { label: `Reply to ${first}`, href: mailto(q.email, 'Re: ' + subject) },
    secondary: { label: cardId ? 'Open the Lead card' : 'Open the board', href: board },
    note: `Or press Reply: it goes straight to ${q.email}.`,
    footer: `Sent from the contact form at ${sentFrom} on ${LONDON_DATE.format(when)} at ${LONDON_TIME.format(when)}. It passed the spam checks. ` +
      (cardId ? 'Also saved on the board under Prospects, Lead.' : 'Saved, but it could not be added to the board, so add the Lead card by hand.'),
  });
  return { subject, html, text };
}

async function notify(env, q, extra) {
  if (!env.RESEND_API_KEY) return 'no key';
  const { subject, html, text } = enquiryEmail(q, extra);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], reply_to: q.email, subject, html, text }),
    });
    return res.ok ? 'sent' : 'failed ' + res.status;
  } catch (err) {
    return 'failed';
  }
}

function reply(form, request, ok, status, message) {
  if (form) {
    // Without JavaScript the browser posted the form itself. The spam check needs JavaScript, so a real person lands
    // here only when it didn't send: say so on a plain page. Anything that passes (only bots, given a fake "sent")
    // goes back to the page it came from.
    let back = '/';
    try { const ref = new URL(request.headers.get('Referer') || '/', request.url); if (ref.host === new URL(request.url).host) back = ref.pathname; } catch {}
    if (ok) return Response.redirect(new URL(back + '?sent=1#contact', request.url).href, 303);
    return new Response(`<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your question didn't send | Phillips.</title><meta name="robots" content="noindex"><style>:root{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#FDF6EE;color:#1A1A1A;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;text-align:center}main{max-width:440px}h1{font-size:26px;letter-spacing:-0.02em;margin:0 0 12px}p{color:#6B6B6B;line-height:1.6;margin:0 0 20px}a{color:#985830;font-weight:700}</style></head><body><main><h1>Your question didn't send.</h1><p>The form checks for spam with a little JavaScript, which seems to be off in this browser. Turn it on and try again, or message me on LinkedIn.</p><p><a href="${back}#contact">Back to the form</a> &middot; <a href="https://www.linkedin.com/in/lewis-p-153b2119a/">LinkedIn</a></p></main></body></html>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, error: message }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function enquiry(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });

  const { data, form } = await readBody(request);
  const q = {
    name: oneLine(data.name, LIMITS.name),
    email: oneLine(data.email, LIMITS.email).toLowerCase(),
    business: oneLine(data.business, LIMITS.business),
    message: clean(data.message, LIMITS.message),
    page: oneLine(data.page, LIMITS.page),
    location: oneLine(data.location, LIMITS.location),
  };

  if (!q.page) { try { const ref = new URL(request.headers.get('Referer') || '', url); if (ref.host === url.host) q.page = ref.pathname.slice(0, LIMITS.page); } catch {} }

  // Spam checks: answer as if it worked.
  // Only the JavaScript form sends the time spent on the page; a plain form post has none.
  const elapsed = data.elapsed === undefined || data.elapsed === '' ? NaN : Number(data.elapsed);
  if (clean(data.company_url, 200) || (Number.isFinite(elapsed) && elapsed < MIN_MS)) return reply(form, request, true, 200);

  if (!q.name) return reply(form, request, false, 400, 'Please add your name.');
  if (!EMAIL.test(q.email)) return reply(form, request, false, 400, 'Please check your email address.');
  if (q.message.length < 5) return reply(form, request, false, 400, 'Please add your question.');

  if (!(await humanCheck(env, request, url, data.token || data['cf-turnstile-response']))) return reply(form, request, false, 400, 'The spam check didn’t go through. Please press Send again, or message me on LinkedIn.');

  if (await overLimit(env, request)) return reply(form, request, false, 429, 'Too many questions from this connection. Please try again later.');

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  const record = { id, receivedAt: now.toISOString(), ...q, country: (request.cf && request.cf.country) || null, notified: null, card: null };

  // Save first, so nothing is lost if the board or the email fails.
  await env.BLOBS.put('admin/enquiries/' + id + '.json', JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });

  try {
    const website = WEBSITE.test(q.business) ? q.business : '';
    const card = await addLead(env, {
      name: (website ? '' : q.business) || q.name,
      contact: q.name,
      email: q.email,
      website,
      source: 'Website form' + (q.page ? ' (' + q.page + ')' : ''),
      nextStep: 'Reply by email',
      about: `Question sent ${now.toISOString().slice(0, 10)} through the website form:\n\n${q.message}`,
    });
    record.card = card && card.id;
  } catch (err) {
    console.error('enquiry: board', err && err.message);
  }
  record.notified = await notify(env, q, { cardId: record.card, at: now });
  await env.BLOBS.put('admin/enquiries/' + id + '.json', JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return reply(form, request, true, 200);
}
