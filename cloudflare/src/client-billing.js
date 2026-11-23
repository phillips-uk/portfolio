// Client billing in /admin (Lewis, 22 Nov 2026): what each client pays and when, typed on the client's page, plus the
// Phillips. invoices read from Xero once a day, for the revenue tiles on Overview. Clients can be moved to "former
// clients" here (their Obsidian folder is never touched).
//
// Xero: read only (invoices and contacts), through The Director's Office Xero app (Starter tier, free, one of its five
// connections; redirect address https://www.phillips-uk.com/admin/xero/callback added 22 Nov 2026). Secrets set on this
// Worker: XERO_CLIENT_ID, XERO_CLIENT_SECRET (the app's second secret) and XERO_TOKEN_KEY (seals the tokens in R2).
// Only invoice lines tagged Brand = "Phillips." count, so The Director's Office work in the same books stays out.
import { seal, unseal } from './seal.js';

const BILLING = 'admin/client-billing.json';
const XERO = 'admin/xero.json';
const INVOICES = 'admin/xero-invoices.json';
const SCOPES = 'offline_access accounting.invoices.read accounting.contacts.read';
const LOGIN = 'https://login.xero.com/identity/connect/authorize';
const TOKEN = 'https://identity.xero.com/connect/token';
const REVOKE = 'https://identity.xero.com/connect/revocation';
const CONNECTIONS = 'https://api.xero.com/connections';
const API = 'https://api.xero.com/api.xro/2.0';
const BRAND = 'Phillips.';
const MAX_PAGES = 5; // 500 invoices at most per sync
const STATE_COOKIE = 'ph_xero_state';
const CADENCES = ['monthly', 'one-off', 'none'];
const SLUG = /^[a-z0-9-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const xeroReady = env => !!(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET && env.XERO_TOKEN_KEY);
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE } });
async function getJSON(env, key, fallback) { const o = await env.BLOBS.get(key); if (!o) return fallback; try { return await o.json(); } catch { return fallback; } }
const putJSON = (env, key, v) => env.BLOBS.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } });
const round2 = n => Math.round(n * 100) / 100;

// ---------- pure parts (tested in cloudflare/test/client-billing.test.mjs) ----------

/** One client's billing details from the form, cleaned. Returns { value } or { error }. */
export function cleanBilling(b) {
  const out = {};
  const fee = b.fee === '' || b.fee == null ? null : Number(b.fee);
  if (fee != null && (!Number.isFinite(fee) || fee < 0 || fee > 1e6)) return { error: 'Enter the fee as a number of pounds, like 500.' };
  out.fee = fee == null ? null : round2(fee);
  out.cadence = CADENCES.includes(b.cadence) ? b.cadence : (out.fee ? 'monthly' : 'none');
  const day = b.day === '' || b.day == null ? null : Number(b.day);
  if (day != null && !(Number.isInteger(day) && day >= 1 && day <= 31)) return { error: 'The invoice day is a day of the month, 1 to 31.' };
  out.day = day;
  for (const k of ['start', 'end']) {
    const v = b[k] ? String(b[k]) : null;
    if (v && !DAY.test(v)) return { error: 'Dates look like 2026-11-23.' };
    out[k] = v;
  }
  if (out.start && out.end && out.end < out.start) return { error: 'The end date is before the start date.' };
  out.xeroContactId = b.xeroContactId && UUID.test(b.xeroContactId) ? String(b.xeroContactId) : null;
  out.xeroContactName = out.xeroContactId ? String(b.xeroContactName || '').slice(0, 120) : null;
  out.note = String(b.note || '').slice(0, 300);
  return { value: out };
}

const xeroDate = (inv, key) => {
  const s = inv[key + 'String'];
  if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = String(inv[key] || '').match(/\/Date\((-?\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : (DAY.test(String(inv[key] || '').slice(0, 10)) ? String(inv[key]).slice(0, 10) : null);
};

/**
 * The Phillips. part of one Xero sales invoice: the lines tagged Brand = "Phillips.", as a share of the invoice, so
 * payments and what is still owed are split the same way. untagged: the invoice has lines with no Brand at all.
 */
export function phillipsPart(inv) {
  const lines = inv.LineItems || [];
  let mine = 0, all = 0, untagged = false;
  for (const l of lines) {
    const amt = Number(l.LineAmount) || 0;
    all += amt;
    const brand = (l.Tracking || []).find(t => /^brand$/i.test(String(t.Name || '')));
    if (!brand) { if (amt) untagged = true; continue; }
    if (String(brand.Option || '').trim() === BRAND) mine += amt;
  }
  const share = all ? mine / all : 0;
  return {
    id: inv.InvoiceID, number: inv.InvoiceNumber || '', ref: inv.Reference || '',
    contactId: inv.Contact && inv.Contact.ContactID || null, contact: inv.Contact && inv.Contact.Name || '',
    date: xeroDate(inv, 'Date'), due: xeroDate(inv, 'DueDate'), status: inv.Status,
    total: round2((Number(inv.Total) || 0) * share), paid: round2((Number(inv.AmountPaid) || 0) * share),
    owed: round2((Number(inv.AmountDue) || 0) * share), paidOn: xeroDate(inv, 'FullyPaidOnDate'), untagged,
  };
}

/** Is a monthly fee running on this day? */
const running = (b, today) => b && !b.former && b.cadence === 'monthly' && b.fee > 0 && (!b.start || b.start <= today) && (!b.end || b.end >= today);

/**
 * The revenue tiles: monthly recurring from the fees typed in, and from Xero (Phillips. lines only) what was invoiced
 * this month, paid this year, and is still owed (and how much of that is past its due date).
 */
export function revenue(billing, invoices, today) {
  const month = today.slice(0, 7), year = today.slice(0, 4);
  let monthly = 0, payers = 0, upcoming = 0, nextStart = null;
  for (const b of Object.values(billing || {})) {
    if (running(b, today)) { monthly += b.fee; payers++; }
    else if (b && !b.former && b.cadence === 'monthly' && b.fee > 0 && b.start > today) { upcoming += b.fee; if (!nextStart || b.start < nextStart) nextStart = b.start; }
  }
  const live = (invoices || []).filter(i => i.total > 0 && (i.status === 'AUTHORISED' || i.status === 'PAID'));
  const sum = (list, k) => round2(list.reduce((a, i) => a + (i[k] || 0), 0));
  const invoicedMonth = sum(live.filter(i => (i.date || '').slice(0, 7) === month), 'total');
  const paidYear = sum(live.filter(i => (i.paidOn || i.date || '').slice(0, 4) === year), 'paid');
  const open = live.filter(i => i.status === 'AUTHORISED' && i.owed > 0);
  return { monthly: round2(monthly), payers, upcoming: round2(upcoming), nextStart, invoicedMonth, paidYear, owed: sum(open, 'owed'), overdue: sum(open.filter(i => i.due && i.due < today), 'owed'), openCount: open.length };
}

/** One client's invoices (by Xero contact): the last twelve months invoiced, paid, owed, and the latest invoice. */
export function clientMoney(contactId, invoices, today) {
  const since = new Date(Date.parse(today + 'T00:00:00Z') - 365 * 864e5).toISOString().slice(0, 10);
  const mine = (invoices || []).filter(i => i.contactId === contactId && i.total > 0 && (i.status === 'AUTHORISED' || i.status === 'PAID'))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const year = mine.filter(i => (i.date || '') >= since);
  return {
    invoiced12m: round2(year.reduce((a, i) => a + i.total, 0)), paid12m: round2(year.reduce((a, i) => a + i.paid, 0)),
    owed: round2(mine.filter(i => i.status === 'AUTHORISED').reduce((a, i) => a + i.owed, 0)),
    recent: mine.slice(0, 6).map(i => ({ number: i.number, date: i.date, due: i.due, total: i.total, owed: i.owed, status: i.status, id: i.id })),
  };
}

// ---------- Xero ----------

async function tokenCall(env, body) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.XERO_CLIENT_ID + ':' + env.XERO_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 400 && /invalid_grant/.test(j.error || '')) throw new Error('Xero ended the connection. Connect it again.');
  if (!res.ok || !j.access_token) throw new Error('Xero sign-in failed (' + res.status + (j.error ? ', ' + j.error : '') + ')');
  return { access: j.access_token, refresh: j.refresh_token, expires_at: Date.now() + Number(j.expires_in || 1800) * 1000 };
}
async function xeroGet(url, access, tenantId) {
  const headers = { Authorization: 'Bearer ' + access, Accept: 'application/json' };
  if (tenantId) headers['xero-tenant-id'] = tenantId;
  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error('Xero asked us to slow down. It tries again tomorrow.');
  if (res.status === 401) throw new Error('Xero refused the connection. Connect it again.');
  if (!res.ok) {
    // Keep Xero's own reason (no tokens in it), and which call it was, so a refusal can be fixed
    const j = await res.json().catch(() => null);
    const why = j && (j.Detail || j.Message || (j.Elements && j.Elements[0] && j.Elements[0].ValidationErrors && j.Elements[0].ValidationErrors[0] && j.Elements[0].ValidationErrors[0].Message) || j.Title) || '';
    const call = url.replace(API, '').split('?')[0] || url;
    throw new Error('Xero error ' + res.status + ' on ' + call + (why ? ': ' + String(why).slice(0, 200) : ''));
  }
  return res.json();
}

async function readConnection(env) {
  const c = await getJSON(env, XERO, null);
  if (!c || !c.sealed) return null;
  return { ...c, tokens: await unseal(env.XERO_TOKEN_KEY, c.sealed) };
}
async function saveConnection(env, c) {
  const { tokens, ...rest } = c;
  await putJSON(env, XERO, { ...rest, sealed: await seal(env.XERO_TOKEN_KEY, tokens) });
}

/** Reads the last two years of sales invoices and the customer list, keeps the Phillips. part. Never throws. */
export async function syncXero(env) {
  if (!xeroReady(env)) return { ok: false, error: 'Xero is not set up on this Worker.' };
  let c;
  try { c = await readConnection(env); } catch (e) { return { ok: false, error: 'The saved Xero connection could not be read. Connect it again.' }; }
  if (!c) return { ok: false, error: 'Xero is not connected.' };
  try {
    if (!c.tokens.expires_at || c.tokens.expires_at < Date.now() + 60e3) {
      c.tokens = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: c.tokens.refresh });
      await saveConnection(env, c); // Xero turns the refresh token over: store it before anything else
    }
    const since = new Date(Date.now() - 730 * 864e5);
    const where = encodeURIComponent('Type=="ACCREC" AND Date>=DateTime(' + since.getUTCFullYear() + ',' + (since.getUTCMonth() + 1) + ',' + since.getUTCDate() + ')');
    const invoices = [];
    let untagged = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await xeroGet(API + '/Invoices?where=' + where + '&Statuses=AUTHORISED,PAID&order=Date%20DESC&page=' + page, c.tokens.access, c.tenantId);
      const list = r.Invoices || [];
      for (const inv of list) { const p = phillipsPart(inv); if (p.untagged) untagged++; if (p.total > 0 || p.untagged) invoices.push(p); }
      if (list.length < 100) break;
    }
    const cr = await xeroGet(API + '/Contacts?where=' + encodeURIComponent('IsCustomer==true') + '&summaryOnly=true', c.tokens.access, c.tenantId);
    const contacts = (cr.Contacts || []).filter(x => x.ContactStatus !== 'ARCHIVED').map(x => ({ id: x.ContactID, name: x.Name })).sort((a, b) => a.name.localeCompare(b.name));
    const syncedAt = new Date().toISOString();
    await putJSON(env, INVOICES, { syncedAt, invoices, contacts, untagged });
    await saveConnection(env, { ...c, syncedAt, lastError: null });
    return { ok: true, syncedAt, count: invoices.length };
  } catch (e) {
    try { await saveConnection(env, { ...c, lastError: e.message, lastErrorAt: new Date().toISOString() }); } catch { /* leave it */ }
    return { ok: false, error: e.message };
  }
}

const cookieOf = (request, name) => { const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : null; };
const redirect = (to, cookie) => new Response(null, { status: 302, headers: { Location: to, ...NO_STORE, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
const callbackUrl = origin => origin + '/admin/xero/callback';

// The admin's own sign-in cookie is SameSite=Strict, so the browser leaves it off when Xero sends Lewis back here.
// The return is trusted instead through a one-time state: made by a signed-in admin on /admin/xero/connect, held in R2
// for ten minutes with who made it, and matched against a SameSite=Lax cookie set on the same browser.
const STATE_KEY = s => 'admin/xero-state/' + s + '.json';

/** GET /admin/xero/connect (signed-in admin, checked by the caller) and /admin/xero/callback (checked here). */
export async function xeroRoutes(request, url, env, email) {
  if (!xeroReady(env)) return redirect('/admin#clients?xero=not-set-up');
  if (url.pathname === '/admin/xero/connect') {
    if (!email) return redirect('/admin');
    const state = crypto.randomUUID();
    await putJSON(env, STATE_KEY(state), { email, exp: Date.now() + 600e3 });
    const p = new URLSearchParams({ response_type: 'code', client_id: env.XERO_CLIENT_ID, redirect_uri: callbackUrl(url.origin), scope: SCOPES, state });
    return redirect(LOGIN + '?' + p, STATE_COOKIE + '=' + state + '; Path=/admin/xero; Max-Age=600; HttpOnly; Secure; SameSite=Lax');
  }
  if (url.pathname === '/admin/xero/callback') {
    const clear = STATE_COOKIE + '=; Path=/admin/xero; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (!state || !/^[0-9a-f-]{36}$/.test(state) || state !== cookieOf(request, STATE_COOKIE)) return redirect('/admin#clients?xero=expired', clear);
    const saved = await getJSON(env, STATE_KEY(state), null);
    await env.BLOBS.delete(STATE_KEY(state));
    if (!saved || saved.exp < Date.now()) return redirect('/admin#clients?xero=expired', clear);
    email = saved.email;
    if (!code) return redirect('/admin#clients?xero=cancelled', clear);
    try {
      const tokens = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(url.origin) });
      const conns = await xeroGet(CONNECTIONS, tokens.access, null);
      const orgs = (Array.isArray(conns) ? conns : []).filter(x => x.tenantType === 'ORGANISATION' || !x.tenantType);
      const org = orgs.find(x => /phillips group/i.test(x.tenantName || '')) || orgs[0];
      if (!org) return redirect('/admin#clients?xero=no-organisation', clear);
      await saveConnection(env, { tenantId: org.tenantId, connectionId: org.id, tenantName: org.tenantName, connectedAt: new Date().toISOString(), connectedBy: email, tokens });
      const s = await syncXero(env);
      return redirect('/admin#clients?xero=' + (s.ok ? 'connected' : 'sync-failed'), clear);
    } catch (e) {
      console.error('xero connect', e && e.message);
      return redirect('/admin#clients?xero=failed', clear);
    }
  }
  return new Response('Not found', { status: 404 });
}

/** Ends the connection: removes Phillips Group from the app at Xero, revokes the token, deletes what was saved. */
async function disconnect(env) {
  try {
    const c = await readConnection(env);
    if (c) {
      if (c.connectionId) await fetch(CONNECTIONS + '/' + encodeURIComponent(c.connectionId), { method: 'DELETE', headers: { Authorization: 'Bearer ' + c.tokens.access } }).catch(() => {});
      await fetch(REVOKE, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(env.XERO_CLIENT_ID + ':' + env.XERO_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.tokens.refresh }).toString() }).catch(() => {});
    }
  } catch { /* the token may be dead already */ }
  await Promise.all([env.BLOBS.delete(XERO), env.BLOBS.delete(INVOICES)]);
}

async function billingState(env) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const [billing, conn, inv] = await Promise.all([getJSON(env, BILLING, {}), getJSON(env, XERO, null), getJSON(env, INVOICES, null)]);
  const invoices = inv ? inv.invoices || [] : [];
  const clients = {};
  for (const [slug, b] of Object.entries(billing)) clients[slug] = { ...b, money: b.xeroContactId ? clientMoney(b.xeroContactId, invoices, today) : null };
  return {
    today, clients, revenue: revenue(billing, invoices, today),
    xero: { ready: xeroReady(env), connected: !!(conn && conn.sealed), tenantName: conn && conn.tenantName || null, connectedAt: conn && conn.connectedAt || null,
      syncedAt: inv && inv.syncedAt || null, lastError: conn && conn.lastError || null, untagged: inv ? inv.untagged || 0 : 0, contacts: inv ? inv.contacts || [] : [] },
  };
}

/** /admin/api/billing and /admin/api/xero/* (signed-in admin only; checked by the caller). */
export async function billingAdmin(request, path, env) {
  const method = request.method;
  let body = {};
  if (method === 'POST') { try { body = await request.json(); } catch { /* empty */ } }
  if (path === '/admin/api/billing' && method === 'GET') return json(await billingState(env));
  const one = path.match(/^\/admin\/api\/billing\/([a-z0-9-]{1,80})(\/former)?$/);
  if (one && method === 'POST' && SLUG.test(one[1])) {
    const billing = await getJSON(env, BILLING, {});
    const was = billing[one[1]] || {};
    if (one[2]) {
      billing[one[1]] = { ...was, former: !!body.former, formerAt: body.former ? new Date().toISOString() : null };
    } else {
      const v = cleanBilling(body);
      if (v.error) return json({ error: v.error }, 400);
      billing[one[1]] = { ...was, ...v.value, updatedAt: new Date().toISOString() };
    }
    await putJSON(env, BILLING, billing);
    return json(await billingState(env));
  }
  if (path === '/admin/api/xero/sync' && method === 'POST') {
    const s = await syncXero(env);
    return s.ok ? json(await billingState(env)) : json({ error: s.error }, 502);
  }
  if (path === '/admin/api/xero/disconnect' && method === 'POST') { await disconnect(env); return json(await billingState(env)); }
  return json({ error: 'Not found' }, 404);
}
