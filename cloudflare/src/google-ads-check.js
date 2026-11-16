// The Google Ads Check (plan sections 3 and 3a), since 16 Nov 2026. Free for small and medium businesses.
// Connection for now: the manager link. The visitor invites the Phillips. manager account (495-618-4074) from Admin >
// Access and security > Managers in Google Ads; this accepts the invitation, reads the account, then ends the link.
// Fixed written rules (ads-check/rules.js) give strengths and weaknesses; each weakness gets a time estimate priced
// through the calculator (pricing.js). No AI. Google sign-in, Stripe checkout and applying fixes are built as screens
// behind FLAGS below and wait on Lewis's Google project and the Phillips. Stripe account.
//
// Routes
//   GET  /google-ads-audit                    the page (private preview until Lewis says go: tools-gate.js)
//   GET  /google-ads-audit/r/<id>             a saved report
//   POST /tools/google-ads-check/link         { customerId } is the invitation there yet?
//   POST /tools/google-ads-check/run          { customerId, token } accept, read, price, end the link
//   GET  /tools/google-ads-check/report/<id>
//   POST /tools/google-ads-check/sample       Lewis only: a report from a made-up account, to review layout and prices
//
// Storage (R2 BLOBS):
//   tools/google-ads-check/reports/<id>.json      the report with its quote and pricing version, 30 days
//   tools/google-ads-check/account/<hash>.json    when the account last had a free check (the ID is hashed)
//   tools/google-ads-check/day/<day>.json         checks run that day, for the daily ceiling
import pageHtml from '../private/google-ads-check.html';
import { gaql, linkStatus, acceptLink, endLink, configured, meter, AdsError, MANAGER_ID_SHOWN } from './ads-check/client.js';
import { QUERIES, OPTIONAL } from './ads-check/queries.js';
import { runRules } from './ads-check/rules.js';
import { SAMPLE_DATA } from './ads-check/sample.js';
import { toolAccessFor, jsonResponse, sha, turnstileOk, londonDay, NO_INDEX } from './tools-gate.js';
import { getPricing, quote } from './pricing.js';

// Built but switched off until Lewis's set-up is done. Nothing here holds a credential.
export const FLAGS = {
  googleSignIn: false,   // needs the "Phillips. Tools" Cloud project and Google's app verification
  checkout: false,       // needs the Phillips. Stripe account (inside the Phillips Group Stripe account)
  applyFixes: false,     // needs Google sign-in with the customer's approval of the exact changes
};

const PREFIX = 'tools/google-ads-check/';
const REPORT_DAYS = 30;

export function isAdsCheckPath(path) {
  return path === '/google-ads-audit' || /^\/google-ads-audit\/r\/[a-f0-9]{32}$/.test(path) || path.startsWith('/tools/google-ads-check/');
}

const put = (env, key, value, meta) => env.BLOBS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' }, ...(meta ? { customMetadata: meta } : {}) });
async function getJson(env, key) {
  const obj = await env.BLOBS.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

const cleanId = v => String(v || '').replace(/\D/g, '');
const shownId = id => id.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');

async function readBody(request) { try { return await request.json(); } catch { return {}; } }

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

// Runs every query, a few at a time. A failed optional query (e.g. Shopping on an account without it) is "no data".
async function readAccount(env, m, customerId) {
  const names = Object.keys(QUERIES);
  const data = {};
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      try { data[name] = await gaql(env, m, customerId, QUERIES[name]); }
      catch (err) {
        if (OPTIONAL.has(name)) { data[name] = undefined; console.warn('ads-check: optional query failed', name, err.code || err.message); }
        else throw err;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return data;
}

function publicReport(r, admin) {
  return {
    id: r.id, checkedAt: r.checkedAt, accountName: r.accountName, customerId: shownId(r.customerId), currency: r.currency,
    facts: r.facts, strengths: r.strengths, weaknesses: r.weaknesses, quote: r.quote,
    flags: FLAGS, preview: !!admin, operations: admin ? r.operations : undefined,
  };
}

async function link(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
  if (!configured(env)) return jsonResponse({ error: 'The Google Ads Check is not connected yet.' }, 503);
  const body = await readBody(request);
  const customerId = cleanId(body.customerId);
  if (!/^\d{10}$/.test(customerId)) return jsonResponse({ error: 'Enter your 10-digit Google Ads customer ID (it is at the top of Google Ads, like 123-456-7890).' }, 400);
  try {
    const s = await linkStatus(env, null, customerId);
    // An account that is already linked is one of Lewis's clients: say only "already linked", never more.
    return jsonResponse({ status: s ? s.status : 'NONE' });
  } catch (err) {
    console.error('ads-check: link status', err.code || err.message);
    return jsonResponse({ error: 'I couldn’t check for the invitation just now. Please try again in a minute.' }, 502);
  }
}

async function run(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
  if (!configured(env)) return jsonResponse({ error: 'The Google Ads Check is not connected yet.' }, 503);
  const body = await readBody(request);
  const customerId = cleanId(body.customerId);
  if (!/^\d{10}$/.test(customerId)) return jsonResponse({ error: 'Enter your 10-digit Google Ads customer ID.' }, 400);
  // Lewis's own preview is already signed in to /admin, so it skips the bot check; visitors always get it.
  if (!access.admin && !(await turnstileOk(env, request, body.token, 'ads_check'))) return jsonResponse({ error: 'The spam check didn’t go through. Please press Run again.' }, 400);

  const pricing = await getPricing(env);
  const L = pricing.settings.limits;
  const accountKey = PREFIX + 'account/' + await sha(customerId + '|' + (env.WORKER_SECRET || 'phillips')) + '.json';
  const dayKey = PREFIX + 'day/' + londonDay() + '.json';
  if (!access.admin) {
    const last = await getJson(env, accountKey);
    if (last && Date.now() - Date.parse(last.at) < L.adsChecksPerAccountDays * 86400000) {
      return jsonResponse({ error: `This account had its free check on ${new Date(last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Each account gets one every ${L.adsChecksPerAccountDays} days. Ask me a question below if you’d like another look.`, limit: true }, 429);
    }
    const day = (await getJson(env, dayKey)) || { n: 0 };
    if (day.n >= L.adsChecksPerDay) return jsonResponse({ error: 'I’m busy today: the free checks for today have all been used. Please try again tomorrow, or ask me a question below.', limit: true }, 429);
  }

  const m = meter();
  let s;
  try { s = await linkStatus(env, m, customerId); }
  catch (err) { return jsonResponse({ error: 'I couldn’t check for the invitation just now. Please try again in a minute.' }, 502); }
  if (!s) return jsonResponse({ error: `I can’t see an invitation from ${shownId(customerId)} yet. In Google Ads, open Admin, then Access and security, then Managers, and invite ${MANAGER_ID_SHOWN}.`, status: 'NONE' }, 409);
  // Already linked means an existing client. Only Lewis may check those (from the preview), and the link is left alone.
  if (s.status === 'ACTIVE' && !access.admin) return jsonResponse({ error: 'This account is already linked to my manager account, so I can’t run the free check on it. Ask me a question below instead.', status: 'ACTIVE' }, 409);

  let accepted = false;
  try {
    if (s.status === 'PENDING') { await acceptLink(env, m, customerId, s.managerLinkId); accepted = true; }

    const head = (await gaql(env, m, customerId, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.time_zone FROM customer'))[0] || {};
    const c = head.customer || {};
    if (c.manager) {
      // A manager account: that is an agency, or a business with several accounts. One account at a time, by hand.
      return jsonResponse({ error: 'That’s a manager account. Checking accounts for clients? Ask me about a paid audit below. If it’s your own business, invite me from the advertising account itself.', agency: true }, 409);
    }
    const data = await readAccount(env, m, customerId);
    const result = runRules(data, { currency: c.currencyCode || 'GBP', today: londonDay() });
    const q = quote(pricing, result.weaknesses);
    const id = crypto.randomUUID().replace(/-/g, '');
    const report = {
      id, checkedAt: new Date().toISOString(), customerId, accountName: c.descriptiveName || 'Your Google Ads account',
      currency: c.currencyCode || 'GBP', facts: result.facts, strengths: result.strengths, weaknesses: result.weaknesses,
      quote: q, pricingVersion: pricing.version || 0, operations: m.ops, preview: !!access.admin,
      route: accepted ? 'manager-link' : 'already-linked',
    };
    await put(env, PREFIX + 'reports/' + id + '.json', report, { name: report.accountName.slice(0, 100) });
    if (!access.admin) {
      await put(env, accountKey, { at: report.checkedAt });
      const day = (await getJson(env, dayKey)) || { n: 0 };
      await put(env, dayKey, { n: day.n + 1 });
    }
    return jsonResponse({ report: publicReport(report, access.admin) });
  } catch (err) {
    console.error('ads-check: run failed', err && (err.code || err.message));
    const msg = err instanceof AdsError && err.kind === 'link' ? err.message : 'Something went wrong while reading the account. Nothing was changed. Please try again, or ask me a question below.';
    return jsonResponse({ error: msg }, 502);
  } finally {
    if (accepted) await endLink(env, m, customerId, s.managerLinkId);
  }
}

// Lewis only: the report for a made-up account, priced with the live calculator. Not saved.
async function sample(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.admin) return jsonResponse({ error: 'Not found' }, 404);
  const pricing = await getPricing(env);
  const result = runRules(SAMPLE_DATA, { currency: 'GBP', today: londonDay() });
  const report = {
    id: '0'.repeat(32), checkedAt: new Date().toISOString(), customerId: '0000000000', accountName: 'Sample account (made up for the preview)',
    currency: 'GBP', facts: result.facts, strengths: result.strengths, weaknesses: result.weaknesses,
    quote: quote(pricing, result.weaknesses), pricingVersion: pricing.version || 0, operations: 0, sample: true,
  };
  return jsonResponse({ report: { ...publicReport(report, true), sample: true } });
}

export async function adsCheck(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/tools/google-ads-check/sample') return request.method === 'POST' ? sample(request, env) : new Response('Method not allowed', { status: 405 });
  if (path === '/tools/google-ads-check/link') return request.method === 'POST' ? link(request, env) : new Response('Method not allowed', { status: 405 });
  if (path === '/tools/google-ads-check/run') return request.method === 'POST' ? run(request, env) : new Response('Method not allowed', { status: 405 });
  const api = path.match(/^\/tools\/google-ads-check\/report\/([a-f0-9]{32})$/);
  if (api) {
    const access = await toolAccessFor('google-ads-check', request, env);
    if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
    const r = await getJson(env, PREFIX + 'reports/' + api[1] + '.json');
    if (!r || Date.now() - Date.parse(r.checkedAt) > REPORT_DAYS * 86400000) return jsonResponse({ error: 'That report has expired or doesn’t exist. Reports are kept for 30 days.' }, 404);
    return jsonResponse({ report: publicReport(r, access.admin) });
  }
  if (path === '/google-ads-audit' || path.startsWith('/google-ads-audit/r/')) {
    const access = await toolAccessFor('google-ads-check', request, env);
    if (!access.allowed) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const html = access.admin ? pageHtml.replace('<body>', '<body data-preview="1">') : pageHtml;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', ...((path !== '/google-ads-audit' || access.admin) ? NO_INDEX : {}) } });
  }
  return jsonResponse({ error: 'Not found' }, 404);
}

export async function cleanupAdsChecks(env) {
  for (const prefix of ['reports/', 'account/', 'day/']) {
    // The "one free check per account" marker is kept a year, so a longer gap set in /admin#pricing still works.
    const cutoff = Date.now() - (prefix === 'account/' ? 366 : REPORT_DAYS) * 86400000;
    let cursor;
    do {
      const page = await env.BLOBS.list({ prefix: PREFIX + prefix, cursor });
      const old = page.objects.filter(o => new Date(o.uploaded).getTime() < cutoff).map(o => o.key);
      if (old.length) await env.BLOBS.delete(old);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
