// Accounts (vault 01_Phillips/04_Products/Accounts Plan.md, step 1, 22 Nov 2026). Optional: every free check works
// without one. An account keeps a visitor's Website Checks (and later Google Ads Checks), for a dashboard of how their
// sites change over time.
//
// Sign-in, two ways:
//   - An email link (Lewis, 22 Nov 2026: "let them use their email and we send them a link"): no password. The link
//     opens a page with a "Sign in" button, so mail scanners that open links can't use it up. Each link works once, for
//     20 minutes; only a hash of it is kept.
//   - Sign in with Google: Google's identity button (name and email only, like /admin's sign-in). Lewis's preview only
//     until Google's review of the Ads permission is done (Accounts Plan: don't touch the consent screen before then).
//
// Who sees it: Lewis signed in to /admin only, until FLAGS.open (step 7: privacy notice, delete and export, the ICO fee,
// and Google's approval). Visitors get a 404 meanwhile.
//
// The session: a signed cookie (ph_acct = id.expiry.signature), HttpOnly, 30 days. Nothing else in the browser.
//
// Email: Cloudflare Email Sending (wrangler.jsonc EMAIL, only from contact@phillips-uk.com). sendEmail() counts every
// email in email_months and stops at EMAIL_CAP a month, so it never costs anything (3,000 a month are included across
// the account, shared with Search Desk).
//
// Routes (all under /account)
//   GET  /account                    the account page (sign-in card, or the saved checks)
//   GET  /account/login?t=...        the page an email link opens, with a "Sign in" button
//   POST /account/login/email        { email, token, next } sends a sign-in link
//   POST /account/login/confirm      { t } uses the link and signs in
//   POST /account/login/google       { credential } signs in with Google (preview only)
//   POST /account/logout
//   GET  /account/me                 { account, checks } for the page
//   POST /account/save               { id } keeps a Website Check report with the account (the report's "Save" button)
import accountHtml from '../private/account.html';
import { adminEmail, GOOGLE_CLIENT_IDS } from './admin.js';
import { jsonResponse, turnstileOk, londonDay, NO_INDEX, guard } from './tools-gate.js';
import { BRANDS, renderEnquiryEmail } from './enquiry-email.js';

export const FLAGS = {
  open: false,          // accounts for every visitor (step 7)
  google: false,        // Sign in with Google for visitors, once Google has approved (Lewis's preview always has it)
};
export const EMAIL_CAP = 2000;   // emails a month (Lewis, 22 Nov 2026: "set hard cap ... so no charges"; 2,000 leaves Search Desk room)
const SESSION_DAYS = 30;
const LINK_MINUTES = 20;
const FROM = { email: 'contact@phillips-uk.com', name: 'Phillips.' };
const COOKIE = 'ph_acct';

// Weekly clean-up (the Worker's Monday cron): sign-in link records older than a day are deleted. A link works for 20
// minutes and the hourly send limit looks back one hour, so nothing needs them after that (privacy notice: accounts).
export async function cleanupAccounts(env) {
  if (!env.ACCOUNTS_DB) return;
  await env.ACCOUNTS_DB.prepare('DELETE FROM login_links WHERE created_at < ?').bind(new Date(Date.now() - 86400000).toISOString()).run();
}

export const isAccountPath = path => path === '/account' || path.startsWith('/account/');

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const now = () => new Date().toISOString();
const cleanEmail = e => String(e || '').trim().toLowerCase().slice(0, 254);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e);
// Only a path on this site, so a link can't send someone elsewhere after signing in
const safeNext = n => (typeof n === 'string' && /^\/[a-z0-9\-\/]*(\?[a-z0-9=&\-]*)?$/i.test(n) && !n.startsWith('//')) ? n.slice(0, 200) : '/account/';

async function hmacKey(env) {
  if (!env.WORKER_SECRET) throw new Error('WORKER_SECRET is not set');
  return crypto.subtle.importKey('raw', enc.encode(env.WORKER_SECRET + '|accounts'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function sign(env, payload) { return b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload))); }

async function sessionCookie(env, id) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = await sign(env, `${id}.${exp}`);
  return `${COOKIE}=${id}.${exp}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// The signed-in account, or null. Used by the tools too (website-check.js saves checks to it).
export async function currentAccount(request, env) {
  if (!env.ACCOUNTS_DB || !env.WORKER_SECRET) return null;
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [id, exp, sig] = m[1].split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  const expected = await sign(env, `${id}.${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  // A deleted account's cookie stops working, because the row is gone
  return env.ACCOUNTS_DB.prepare('SELECT id, email, name, created_at, emails_ok FROM accounts WHERE id = ?').bind(id).first();
}

// Who may use accounts now: everyone once FLAGS.open; otherwise Lewis's preview, which is his /admin sign-in or an
// account he has already signed in to. Sign-in links are only sent from the preview, so an account (and a link) can
// only exist for someone Lewis let in; that way a link opened in another browser or on a phone still works (22 Nov
// 2026: the first link opened in a browser without the /admin sign-in and went to the home page).
async function accountsAllowed(request, env) {
  const admin = !!(await adminEmail(request, env));
  if (FLAGS.open || admin) return { allowed: true, admin };
  return { allowed: !!(await currentAccount(request, env)), admin: false };
}
export async function accountsOn(request, env) { return (await accountsAllowed(request, env)).allowed; }

async function signIn(env, email, extra = {}) {
  const db = env.ACCOUNTS_DB;
  let acct = await db.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first();
  if (!acct) {
    acct = { id: randomToken(16) };
    await db.prepare('INSERT INTO accounts (id, email, name, google_sub, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(acct.id, email, extra.name || null, extra.sub || null, now(), now()).run();
  } else {
    await db.prepare('UPDATE accounts SET last_seen_at = ?, name = COALESCE(name, ?), google_sub = COALESCE(google_sub, ?) WHERE id = ?')
      .bind(now(), extra.name || null, extra.sub || null, acct.id).run();
  }
  return acct.id;
}

// ---------- email, capped ----------

// Sends one email if this month is under the cap. Returns 'sent', 'capped', 'local' (wrangler dev: written to the log)
// or 'failed'. The count goes up before sending, so a failed send still counts (better to stop early than to overspend).
export async function sendEmail(env, { to, subject, text, html }) {
  if (!env.EMAIL || !env.ACCOUNTS_DB) return 'failed';
  const month = londonDay().slice(0, 7);
  const db = env.ACCOUNTS_DB;
  await db.prepare('INSERT OR IGNORE INTO email_months (month, n) VALUES (?, 0)').bind(month).run();
  const got = await db.prepare('UPDATE email_months SET n = n + 1 WHERE month = ? AND n < ? RETURNING n').bind(month, EMAIL_CAP).first();
  if (!got) { console.warn('accounts: email cap reached for', month); return 'capped'; }
  try {
    await env.EMAIL.send({ from: FROM, to, replyTo: 'contact@phillips-uk.com', subject, text, html });
    return 'sent';
  } catch (err) {
    console.error('accounts: email', err && (err.code || err.message));
    return 'failed';
  }
}

function signInEmail(link) {
  return renderEnquiryEmail({ ...BRANDS.phillips, label: 'Your account' }, {
    kind: 'Your account',
    title: 'Sign in to Phillips.',
    preheader: 'Your sign-in link for phillips-uk.com. It works once, for 20 minutes.',
    fields: [['Link works for', `${LINK_MINUTES} minutes, once`, null, true]],
    messageLabel: 'Why you got this',
    message: 'A sign-in link was requested for phillips-uk.com using this email address. If you didn’t request it, you can ignore this email.',
    primary: { label: 'Sign in', href: link },
    note: 'The button takes you to phillips-uk.com. Select Sign in there to finish.',
    footer: 'Sent by phillips-uk.com because a sign-in link was asked for. Phillips. is a trading name of PHILLIPSGROUPUK LIMITED, registered in England and Wales.',
  });
}

// ---------- routes ----------

async function body(request) { try { return await request.json(); } catch { return {}; } }
const sameOrigin = request => { const o = request.headers.get('Origin'); return !o || o === new URL(request.url).origin; };

async function sendLink(request, env, access) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const blocked = await guard(env, request, access, 'account-login', 6, 60);
  if (blocked) return blocked.response;
  const b = await body(request);
  const email = cleanEmail(b.email);
  if (!validEmail(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400);
  if (!access.admin && !(await turnstileOk(env, request, b.token, 'account_login'))) return jsonResponse({ error: 'The spam check didn’t go through. Please try again.' }, 400);
  const db = env.ACCOUNTS_DB;
  // At most three links an hour to one address, so the form can't be used to flood someone's inbox
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at > ?').bind(email, new Date(Date.now() - 3600000).toISOString()).first();
  const done = jsonResponse({ ok: true, message: 'Check your inbox for a sign-in link. The link expires after 20 minutes.' });
  if (recent && recent.n >= 3) return done; // same answer, so nobody learns anything from it
  const token = randomToken();
  await db.prepare('INSERT INTO login_links (token_hash, email, created_at, expires_at, next) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), email, now(), new Date(Date.now() + LINK_MINUTES * 60000).toISOString(), safeNext(b.next)).run();
  const link = new URL('/account/login?t=' + token, request.url).href;
  const { html, text } = signInEmail(link);
  const sent = await sendEmail(env, { to: email, subject: 'Your sign-in link for Phillips.', text, html });
  if (sent === 'capped') return jsonResponse({ error: 'I can’t send sign-in emails right now. Please try again later.' }, 503);
  if (sent === 'failed' && !env.EMAIL) return jsonResponse({ error: 'Email isn’t set up here.' }, 503);
  if (new URL(request.url).hostname === 'localhost') console.log('accounts: sign-in link (local only)', link);
  return done;
}

async function confirmLink(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const b = await body(request);
  const t = String(b.t || '').slice(0, 100);
  if (!t) return jsonResponse({ error: 'That sign-in link isn’t complete.' }, 400);
  const db = env.ACCOUNTS_DB;
  // Used once: the update only succeeds for an unused, unexpired link
  const row = await db.prepare('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, next')
    .bind(now(), await sha256(t), now()).first();
  if (!row) return jsonResponse({ error: 'This link has expired or already been used. Request a new sign-in link.' }, 400);
  const id = await signIn(env, row.email);
  return jsonResponse({ ok: true, next: row.next || '/account/' }, 200, { 'Set-Cookie': await sessionCookie(env, id) });
}

async function googleLogin(request, env, access) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  if (!FLAGS.google && !access.admin) return jsonResponse({ error: 'Not found' }, 404);
  const b = await body(request);
  const credential = typeof b.credential === 'string' ? b.credential : '';
  if (!credential) return jsonResponse({ error: 'Sign in with Google first.' }, 400);
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!res.ok) return jsonResponse({ error: 'Google could not confirm that sign-in. Try again.' }, 401);
  const info = await res.json();
  const email = cleanEmail(info.email);
  if (!GOOGLE_CLIENT_IDS.includes(info.aud) || info.email_verified === 'false' || String(info.email_verified) === 'false' || !validEmail(email)) {
    return jsonResponse({ error: 'Google could not confirm that sign-in. Try again.' }, 401);
  }
  const id = await signIn(env, email, { name: info.name ? String(info.name).slice(0, 80) : null, sub: info.sub ? String(info.sub) : null });
  return jsonResponse({ ok: true, next: safeNext(b.next) }, 200, { 'Set-Cookie': await sessionCookie(env, id) });
}

async function me(request, env) {
  const acct = await currentAccount(request, env);
  if (!acct) return jsonResponse({ account: null });
  const { results } = await env.ACCOUNTS_DB.prepare('SELECT id, tool, domain, model, checked_at, scores, fixes FROM checks WHERE account_id = ? ORDER BY checked_at DESC LIMIT 200').bind(acct.id).all();
  return jsonResponse({
    account: { email: acct.email, name: acct.name, since: acct.created_at },
    checks: results.map(c => ({ ...c, scores: c.scores ? JSON.parse(c.scores) : null })),
  });
}

// Keeps a check with the account (website-check.js calls this when a signed-in visitor runs one; the report's Save
// button calls /account/save for a report they opened from a link).
export async function saveCheck(env, accountId, c) {
  await env.ACCOUNTS_DB.prepare('INSERT OR REPLACE INTO checks (id, account_id, tool, domain, model, checked_at, scores, fixes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(c.id, accountId, c.tool, c.domain, c.model || null, c.checkedAt, c.scores ? JSON.stringify(c.scores) : null, c.fixes ?? null).run();
}

export async function accounts(request, url, env, { keepWebsiteReport } = {}) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const access = await accountsAllowed(request, env);
  // While accounts are private: the page an email link opens, and using the link, work anywhere (the link is the key);
  // the account calls answer "off" quietly; everything else sends visitors home (the caller).
  const linkPage = path === '/account/login' || path === '/account/login/confirm';
  if (!access.allowed && !linkPage) return path === '/account' ? null : jsonResponse({ off: true }, 404);
  if (!env.ACCOUNTS_DB) return jsonResponse({ error: 'Accounts aren’t set up here.' }, 503);
  const post = request.method === 'POST';
  if (path === '/account' || path === '/account/login') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const html = accountHtml.replace('<body>', `<body data-google="${FLAGS.google || access.admin ? '1' : ''}" data-preview="${access.admin ? '1' : ''}">`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', ...NO_INDEX } });
  }
  if (path === '/account/login/email' && post) return sendLink(request, env, access);
  if (path === '/account/login/confirm' && post) return confirmLink(request, env);
  if (path === '/account/login/google' && post) return googleLogin(request, env, access);
  if (path === '/account/logout' && post) return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookie });
  if (path === '/account/me') return me(request, env);
  if (path === '/account/save' && post) {
    if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
    const acct = await currentAccount(request, env);
    if (!acct) return jsonResponse({ error: 'Sign in first.' }, 401);
    const b = await body(request);
    const id = String(b.id || '');
    if (!/^[a-f0-9]{32}$/.test(id) || !keepWebsiteReport) return jsonResponse({ error: 'That report can’t be saved.' }, 400);
    const saved = await keepWebsiteReport(env, id);
    if (!saved) return jsonResponse({ error: 'That report has expired, so it can’t be saved. Run the check again.' }, 404);
    await saveCheck(env, acct.id, saved);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: 'Not found' }, 404);
}
