// POST /enquiry: the "Ask me a question" form on phillips-uk.com.
// Each question is saved to R2 (admin/enquiries/), added to the /admin sales funnel as a Lead card, and emailed to
// contact@phillips-uk.com through Resend when the RESEND_API_KEY secret is set (no key: saved and on the board only).
// Spam: a hidden trap field, a minimum time on the page, and at most RATE_MAX questions an hour from one connection.
// Bots get the same "sent" answer as people, so they learn nothing. No IP address is stored.
import { addLead } from './pipeline.js';

const LIMITS = { name: 120, email: 160, business: 160, message: 4000, page: 200, location: 40 };
const MIN_MS = 3000;       // a person needs longer than this to fill in the form
const RATE_MAX = 5;        // questions per connection per hour
const NOTIFY_TO = 'contact@phillips-uk.com';
const NOTIFY_FROM = 'Phillips. website <website@phillips-uk.com>';

const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/\s+/g, ' ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

async function notify(env, q) {
  if (!env.RESEND_API_KEY) return 'no key';
  const text = [
    `${q.name} asked a question on phillips-uk.com${q.page ? ' (' + q.page + ')' : ''}.`,
    '',
    `Name: ${q.name}`,
    `Email: ${q.email}`,
    q.business ? `Business or website: ${q.business}` : null,
    '',
    q.message,
    '',
    'Reply to this email to answer. The question is also on the board at https://www.phillips-uk.com/admin (Prospects, Lead).',
  ].filter(l => l !== null).join('\n');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], reply_to: q.email, subject: `Website question from ${q.name}`, text }),
    });
    return res.ok ? 'sent' : 'failed ' + res.status;
  } catch (err) {
    return 'failed';
  }
}

function reply(form, request, ok, status, message) {
  if (form) {
    // Without JavaScript the browser posted the form itself: send it back to the page it came from.
    let back = '/';
    try { const ref = new URL(request.headers.get('Referer') || '/', request.url); if (ref.host === new URL(request.url).host) back = ref.pathname; } catch {}
    return Response.redirect(new URL(back + (ok ? '?sent=1' : '?error=1') + '#contact', request.url).href, 303);
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

  if (await overLimit(env, request)) return reply(form, request, false, 429, 'Too many questions from this connection. Please try again later.');

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
  const record = { id, receivedAt: now.toISOString(), ...q, country: (request.cf && request.cf.country) || null, notified: null, card: null };

  // Save first, so nothing is lost if the board or the email fails.
  await env.BLOBS.put('admin/enquiries/' + id + '.json', JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });

  try {
    const website = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(q.business) ? q.business : '';
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
  record.notified = await notify(env, q);
  await env.BLOBS.put('admin/enquiries/' + id + '.json', JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return reply(form, request, true, 200);
}
