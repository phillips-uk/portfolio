// Lewis's admin page at /admin: Google sign-in, clients (summaries synced from Obsidian), the prospects funnel
// (pipeline.js: deals made here plus the prospect notes, with comments and files on each card),
// rate card invite links (Search Desk demo invites each get their own Search Desk share link, desk-demo.js) and a short summary of the site.
// Session: an HMAC-signed cookie (ADMIN_SESSION_KEY secret), 12 hours. Only emails on ALLOWED_AUDIT_EMAILS get in.
import adminHtml from '../private/admin.html';
import { getInvite, putInvite, updateInvite, listInvites, inviteState, invitePages, newToken, PAGES } from './rate-card.js';
import { deals } from './pipeline.js';
import { getDeskDemo, deskDemoSummary, revokeDeskDemo } from './desk-demo.js';

const COOKIE = 'ph_admin';
const SESSION_SECONDS = 12 * 3600;
const GOOGLE_CLIENT_IDS = ['339165209514-jn3kstpi7on9jtl160afc8el2j5a4h1m.apps.googleusercontent.com'];
// lewis@phillips-group.uk is the Google Workspace sign-in since 12 Nov 2026; lewis@phillips-uk.com is an alias now.
const DEFAULT_ALLOWED = 'lewis@phillips-group.uk,lewis@phillips-uk.com,lewisdp87@gmail.com';

const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_INDEX, ...extra } });
}

function allowed(env) {
  return (env.ALLOWED_AUDIT_EMAILS || DEFAULT_ALLOWED).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}

async function hmac(env, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_SESSION_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The signed-in admin email, or null. Used by /rate-card too, so Lewis can preview it.
export async function adminEmail(request, env) {
  if (!env.ADMIN_SESSION_KEY) return null;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)ph_admin=([^;]+)/);
  if (!m) return null;
  const [email64, exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!email64 || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  const expected = await hmac(env, `${email64}.${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const email = atob(email64.replace(/-/g, '+').replace(/_/g, '/'));
  return allowed(env).includes(email) ? email : null;
}

async function login(request, env) {
  if (!env.ADMIN_SESSION_KEY) return json({ error: 'Admin is not set up yet.' }, 503);
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const credential = typeof body.credential === 'string' ? body.credential : '';
  if (!credential) return json({ error: 'Sign in with Google first.' }, 400);
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!res.ok) return json({ error: 'Google could not confirm that sign-in. Try again.' }, 401);
  const info = await res.json();
  const email = String(info.email || '').toLowerCase();
  if (!GOOGLE_CLIENT_IDS.includes(info.aud) || info.email_verified === 'false' || !allowed(env).includes(email)) {
    console.warn('admin login refused', email || 'no email');
    return json({ error: 'This Google account does not have access.' }, 403);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const email64 = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const value = `${email64}.${exp}.${await hmac(env, `${email64}.${exp}`)}`;
  return json({ email }, 200, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
}

function publicInvite(inv, origin) {
  return {
    token: inv.token,
    name: inv.name,
    note: inv.note || '',
    createdAt: inv.createdAt,
    startsAt: inv.startsAt || null,
    expiresAt: inv.expiresAt || null,
    state: inviteState(inv),
    archived: !!inv.archived,
    archivedAt: inv.archivedAt || null,
    views: inv.views || 0,
    previews: inv.previews || 0,
    browsers: (inv.visitors || []).length,
    lastViewedAt: inv.lastViewedAt || null,
    lastCountry: inv.lastCountry || '',
    pages: invitePages(inv),
    pageViews: inv.pageViews || (inv.views ? { 'rate-card': inv.views } : {}),
    links: Object.fromEntries(invitePages(inv).map(k => [k, `${origin}${PAGES[k].path}?invite=${inv.token}`])),
    link: `${origin}${PAGES[invitePages(inv)[0]].path}?invite=${inv.token}`,
  };
}

// A UK calendar date (YYYY-MM-DD) as an ISO time: the start of that day, or its last second, in Europe/London.
function londonDay(date, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const [y, m, d] = date.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(utc)));
  const offset = (londonHour - new Date(utc).getUTCHours() + 24) % 24; // 0 in winter, 1 in summer
  return new Date(utc - offset * 3600000).toISOString();
}

// The live window from a request body: { from, until } as dates, or the older { days } after today.
function liveWindow(body, now) {
  const startsAt = body.from ? londonDay(body.from, false) : null;
  let expiresAt = body.until ? londonDay(body.until, true) : null;
  if (body.from && !startsAt) return { error: 'The start date is not a date.' };
  if (body.until && !expiresAt) return { error: 'The end date is not a date.' };
  if (!body.until && !('from' in body || 'until' in body)) {
    const days = Number(body.days);
    expiresAt = days > 0 && days <= 3650 ? new Date(now.getTime() + days * 86400000).toISOString() : null;
  }
  if (startsAt && expiresAt && expiresAt <= startsAt) return { error: 'The end date has to be after the start date.' };
  if (expiresAt && expiresAt < now.toISOString()) return { error: 'The end date has already passed.' };
  return { startsAt, expiresAt };
}

async function createInvite(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const name = String(body.name || '').trim().slice(0, 80);
  const note = String(body.note || '').trim().slice(0, 200);
  const pages = (Array.isArray(body.pages) ? body.pages : ['rate-card']).filter((k, i, a) => PAGES[k] && a.indexOf(k) === i);
  if (!name) return json({ error: 'Add who the link is for.' }, 400);
  if (!pages.length) return json({ error: 'Choose what the link opens.' }, 400);
  const now = new Date();
  const win = liveWindow(body, now);
  if (win.error) return json({ error: win.error }, 400);
  const inv = {
    token: newToken(),
    name, note,
    createdAt: now.toISOString(),
    startsAt: win.startsAt,
    expiresAt: win.expiresAt,
    pages,
    revoked: false, views: 0, pageViews: {}, visitors: [], recent: [],
  };
  await putInvite(env, inv);
  return json(publicInvite(inv, origin), 201);
}

async function setDates(request, env, token, origin) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const win = liveWindow({ from: body.from || '', until: body.until || '' }, new Date());
  if (win.error) return json({ error: win.error }, 400);
  const inv = await updateInvite(env, token, i => { i.startsAt = win.startsAt; i.expiresAt = win.expiresAt; });
  if (!inv) return json({ error: 'That link no longer exists.' }, 404);
  return json(publicInvite(inv, origin));
}

// Archiving only tidies the admin list: the link keeps working until it is switched off or runs out.
async function setArchived(env, token, archived, origin) {
  const inv = await updateInvite(env, token, i => { i.archived = archived; i.archivedAt = archived ? new Date().toISOString() : null; });
  if (!inv) return json({ error: 'That link no longer exists.' }, 404);
  return json(publicInvite(inv, origin));
}

// One link with every visit kept, for its detail panel.
async function inviteDetail(env, token, origin) {
  const inv = await getInvite(env, token);
  if (!inv) return json({ error: 'That link no longer exists.' }, 404);
  return json({ ...publicInvite(inv, origin), visits: Array.isArray(inv.visits) ? inv.visits : [], recent: Array.isArray(inv.recent) ? inv.recent : [] });
}

async function setRevoked(env, token, revoked, origin) {
  const inv = await updateInvite(env, token, i => { i.revoked = revoked; });
  if (!inv) return json({ error: 'That link no longer exists.' }, 404);
  // Its Search Desk share link goes too, signing its guests out at once; switching it back on makes a new one on the next open
  if (revoked && invitePages(inv).includes('search-desk')) await revokeDeskDemo(env, inv);
  return json(publicInvite(inv, origin));
}

// Landing page audits are the site's main tool; each finished audit writes a small lead record.
async function siteSummary(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: 'landing-audit-leads/', cursor });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort().reverse();
  const day = k => (k.match(/lead-(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const since = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const recent = [];
  for (const k of keys.slice(0, 10)) {
    const obj = await env.BLOBS.get(k);
    if (!obj) continue;
    try {
      const r = JSON.parse(await obj.text());
      recent.push({ domain: r.domain || '', score: r.score ?? null, band: r.band || '', keyword: r.keyword || '', auditedAt: r.auditedAt || '', report: r.jobId ? `/r/${r.jobId}` : null });
    } catch { /* skip a bad record */ }
  }
  return {
    audits: { total: keys.length, last7: keys.filter(k => day(k) >= since(7)).length, last30: keys.filter(k => day(k) >= since(30)).length },
    recent,
  };
}

// Client and prospect summaries, uploaded from the Obsidian vault by cloudflare/scripts/sync-clients.mjs.
async function clientsSummary(env, origin) {
  const obj = await env.BLOBS.get('admin/clients-index.json');
  if (!obj) return { syncedAt: null, clients: [], prospects: [] };
  // Prospects are served merged with the saved funnel by /admin/api/deals.
  return obj.json();
}

// One document from the latest-files bundle the sync uploads (admin/docs.json).
async function getDoc(env, id) {
  const obj = await env.BLOBS.get('admin/docs.json');
  if (!obj) return null;
  const bundle = await obj.json();
  const d = bundle.docs && bundle.docs[id];
  return d ? { id, ...d, syncedAt: bundle.syncedAt } : null;
}

export function isAdminPath(path) {
  return path === '/admin' || path.startsWith('/admin/api/');
}

export async function admin(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/admin') {
    if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return new Response(adminHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...NO_INDEX } });
  }

  // Writes need a JSON body and a custom header, which a form on another site cannot send.
  if (method === 'POST' && request.headers.get('X-Admin') !== '1') return json({ error: 'Bad request' }, 400);

  if (path === '/admin/api/login' && method === 'POST') return login(request, env);
  if (path === '/admin/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  const email = await adminEmail(request, env);
  if (!email) return json({ error: 'Signed out' }, 401);

  if (path === '/admin/api/me') return json({ email });
  if (path === '/admin/api/invites' && method === 'GET') {
    const [invites, desk] = await Promise.all([listInvites(env), getDeskDemo(env)]);
    return json({ invites: invites.map(inv => publicInvite(inv, url.origin)), deskDemo: deskDemoSummary(desk) });
  }
  if (path === '/admin/api/invites' && method === 'POST') return createInvite(request, env, url.origin);
  const act = path.match(/^\/admin\/api\/invites\/([A-Za-z0-9._-]{8,80})\/(revoke|restore)$/);
  if (act && method === 'POST') return setRevoked(env, act[1], act[2] === 'revoke', url.origin);
  const arch = path.match(/^\/admin\/api\/invites\/([A-Za-z0-9._-]{8,80})\/(archive|unarchive)$/);
  if (arch && method === 'POST') return setArchived(env, arch[1], arch[2] === 'archive', url.origin);
  const one = path.match(/^\/admin\/api\/invites\/([A-Za-z0-9._-]{8,80})$/);
  if (one && method === 'GET') return inviteDetail(env, one[1], url.origin);
  const dates = path.match(/^\/admin\/api\/invites\/([A-Za-z0-9._-]{8,80})\/dates$/);
  if (dates && method === 'POST') return setDates(request, env, dates[1], url.origin);
  if (path === '/admin/api/site') return json(await siteSummary(env));
  if (path === '/admin/api/clients') return json(await clientsSummary(env, url.origin));
  if (path === '/admin/api/deals' || path.startsWith('/admin/api/deals/')) {
    return deals(request, path, env, { 'Content-Type': 'application/json', ...NO_INDEX }, async token => {
      const inv = await getInvite(env, token);
      return inv ? publicInvite(inv, url.origin) : null;
    }, email);
  }
  const doc = path.match(/^\/admin\/api\/doc\/([a-f0-9]{16})$/);
  if (doc) {
    const d = await getDoc(env, doc[1]);
    return d ? json(d) : json({ error: 'That document is no longer in the latest sync. Open it in Obsidian instead.' }, 404);
  }

  return json({ error: 'Not found' }, 404);
}
