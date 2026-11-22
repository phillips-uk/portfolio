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
//   POST /tools/google-ads-check/sample       Lewis only: a report from a made-up demo client (demos.js)
//   GET  /tools/google-ads-check/demos        Lewis only: the demo clients, for /admin#demos
//
// Storage (R2 BLOBS):
//   tools/google-ads-check/reports/<id>.json      the report with its quote and pricing version, 30 days
//   tools/google-ads-check/kept/<id>.json         a report kept with an account (accounts.js): not deleted after 30 days
//   tools/google-ads-check/account/<hash>.json    when the account last had a free check (the ID is hashed)
//   tools/google-ads-check/day/<day>.json         checks run that day, for the daily ceiling
import pageHtml from '../private/google-ads-check.html';
import { gaql, linkStatus, acceptLink, endLink, configured, meter, AdsError, MANAGER_ID_SHOWN } from './ads-check/client.js';
import { OPTIONAL, queriesFor } from './ads-check/queries.js';
import { runRules, actionPlan, headlineFor } from './ads-check/rules.js';
import { checkUrls } from './ads-check/urls.js';
import { DEMOS, findDemo } from './ads-check/demos.js';
import { isReviewer, reviewEntry } from './signin-review.js';
import { toolAccessFor, jsonResponse, sha, turnstileOk, londonDay, NO_INDEX, guard } from './tools-gate.js';
import { countUse, addToolLead } from './tool-leads.js';
import { getPricing, quote } from './pricing.js';
import { currentAccount, accountsOn, saveCheck } from './accounts.js';

// Built but switched off until Lewis's set-up is done. Nothing here holds a credential.
export const FLAGS = {
  googleSignIn: false,   // true once Google verifies the app: Google sign-in for everyone (google-signin.js)
  googleSignInPreview: true,  // true: Google sign-in for Lewis only (signed in to /admin), e.g. to record the review video.
                              // On for the verification video (Nov 2026); visitors still see the manager-link route only
  checkout: false,       // needs the Phillips. Stripe account (inside the Phillips Group Stripe account)
  applyFixes: false,     // needs Google sign-in with the customer's approval of the exact changes
};

const PREFIX = 'tools/google-ads-check/';
const TOOL = 'google-ads-check';
const SITE = 'https://www.phillips-uk.com';
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
  const QUERIES = queriesFor(londonDay());
  const names = Object.keys(QUERIES);
  const data = {};
  const diag = {}; // rows per query, or the error code: shown only in Lewis's preview
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && next < names.length) {
      const name = names[next++];
      try { data[name] = await gaql(env, m, customerId, QUERIES[name]); diag[name] = data[name].length; }
      catch (err) {
        diag[name] = 'failed: ' + String(err.code || err.message).slice(0, 120);
        if (OPTIONAL.has(name)) { data[name] = undefined; console.warn('ads-check: optional query failed', name, err.code || err.message); }
        else failed = failed || err;
      }
    }
  };
  // Every read has finished before this returns, so the link is never ended while a query is still running.
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed) throw failed;
  Object.defineProperty(data, '__diag', { value: diag, enumerable: false });
  return data;
}

function publicReport(r, admin) {
  return {
    id: r.id, checkedAt: r.checkedAt, accountName: r.accountName, customerId: shownId(r.customerId), currency: r.currency,
    facts: r.facts, strengths: r.strengths, weaknesses: r.weaknesses, quote: r.quote,
    profile: r.profile || null, ngrams: r.ngrams || null, dayHour: r.dayHour || null,
    // Since 21 Nov 2026 (older reports have none of these, and the page leaves those sections out)
    headline: r.headline || null, plan: r.plan || null, trend: r.trend || null, segments: r.segments || null,
    changes: r.changes || null, urls: r.urls || null, target: r.target || null, yardstick: r.yardstick || null, brand: r.brand || null,
    flags: FLAGS, preview: !!admin, operations: admin ? r.operations : undefined, queryRows: admin ? r.queryRows : undefined,
  };
}

// The free-use limits (from the calculator) for a visitor: one free check per account every N days, and a daily ceiling.
// Lewis's own runs are never counted. Returns { error } (a response) or the keys to mark once a report is saved.
export async function freeLimits(env, access, customerId, pricing) {
  const L = pricing.settings.limits;
  const accountKey = PREFIX + 'account/' + await sha(customerId + '|' + (env.WORKER_SECRET || 'phillips')) + '.json';
  const dayKey = PREFIX + 'day/' + londonDay() + '.json';
  if (!access.admin) {
    const last = await getJson(env, accountKey);
    if (last && Date.now() - Date.parse(last.at) < L.adsChecksPerAccountDays * 86400000) {
      return { reason: 'account', error: jsonResponse({ error: `This account had its free check on ${new Date(last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Each account gets one every ${L.adsChecksPerAccountDays} days. Ask me a question below if you’d like another look.`, limit: true }, 429) };
    }
    const day = (await getJson(env, dayKey)) || { n: 0 };
    if (day.n >= L.adsChecksPerDay) return { reason: 'daily', error: jsonResponse({ error: 'I’m busy today: the free checks for today have all been used. Please try again tomorrow, or ask me a question below.', limit: true }, 429) };
  }
  return { accountKey, dayKey };
}

// The visitor's optional target and brand name (21 Nov 2026): one target (cost per conversion, or return on ad spend
// as a percentage like 400 or a ratio like 4) and a brand name. Anything else is ignored.
export function readTarget(body) {
  const t = body && body.target;
  let target = null;
  if (t && (t.type === 'cpa' || t.type === 'roas')) {
    let v = Number(String(t.value ?? '').replace(/[^0-9.]/g, ''));
    if (t.type === 'roas' && v > 20) v = v / 100;
    if (Number.isFinite(v) && v > 0 && v <= (t.type === 'cpa' ? 100000 : 100)) target = { type: t.type, value: Math.round(v * 100) / 100 };
  }
  const brand = String((body && body.brand) || '').replace(/[^\p{L}\p{N} &'.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  return { target, brand };
}

// Reads one account, applies the rules, prices the weaknesses and saves the report. readEnv decides whose access the
// reads use: the manager account's (env) or a signed-in visitor's (asVisitor). Returns { report } or { error } (a response).
export async function buildReport(readEnv, env, m, customerId, access, pricing, limit, route, opts = {}) {
  const head = (await gaql(readEnv, m, customerId, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.time_zone FROM customer'))[0] || {};
  const c = head.customer || {};
  if (c.manager) {
    // A manager account: that is an agency, or a business with several accounts. One account at a time, by hand.
    return { error: jsonResponse({ error: 'That’s a manager account. Checking accounts for clients? Ask me about a paid audit below. If it’s your own business, choose the advertising account itself.', agency: true }, 409) };
  }
  const data = await readAccount(readEnv, m, customerId);
  // Does each landing page load? One GET per distinct page, capped and timed out (ads-check/urls.js). Never fails the report.
  try { data.urlChecks = await checkUrls(data); } catch (err) { console.warn('ads-check: landing page check failed', err && err.message); }
  const result = runRules(data, { currency: c.currencyCode || 'GBP', today: londonDay(), target: opts.target, brand: opts.brand });
  const q = quote(pricing, result.weaknesses, new Date(), result.workload);
  const plan = actionPlan(result.weaknesses, q, result.facts.spend30);
  const id = crypto.randomUUID().replace(/-/g, '');
  const report = {
    id, checkedAt: new Date().toISOString(), customerId, accountName: c.descriptiveName || 'Your Google Ads account',
    currency: c.currencyCode || 'GBP', facts: result.facts, strengths: result.strengths, weaknesses: result.weaknesses,
    profile: result.profile, ngrams: result.ngrams, dayHour: result.dayHour, workload: result.workload,
    headline: headlineFor(result.headline, plan, result.weaknesses), plan, trend: result.trend, segments: result.segments, changes: result.changes, urls: result.urls,
    target: result.target, yardstick: result.yardstick, brand: opts.brand || null,
    quote: q, pricingVersion: pricing.version || 0, operations: m.ops, queryRows: data.__diag, preview: !!access.admin, route,
  };
  await put(env, PREFIX + 'reports/' + id + '.json', report, { name: report.accountName.slice(0, 100) });
  // Kept with the visitor's account when signed in (Accounts Plan step 2): a copy outside the clean-up and a dashboard line
  if (opts.accountId) {
    try {
      await put(env, PREFIX + 'kept/' + id + '.json', report, { name: report.accountName.slice(0, 100) });
      await saveCheck(env, opts.accountId, { id, tool: 'ads', domain: report.accountName, checkedAt: report.checkedAt, fixes: report.weaknesses.length });
    } catch (err) { console.warn('ads-check: keep for account', err && err.message); }
  }
  if (!access.admin) {
    await put(env, limit.accountKey, { at: report.checkedAt });
    const day = (await getJson(env, limit.dayKey)) || { n: 0 };
    await put(env, limit.dayKey, { n: day.n + 1 });
    // Every completed visitor check is a Lead card in /admin#prospects (tool-leads.js), whichever way the account was
    // reached. Lewis's own preview and the demo clients (sample()) make none.
    await countUse(env, TOOL, 'completed');
    await addToolLead(env, access, {
      tool: TOOL, at: report.checkedAt, name: report.accountName,
      checked: `${report.accountName} (Google Ads customer ID ${shownId(customerId)})`,
      reportUrl: SITE + '/google-ads-audit/r/' + id,
      issues: report.weaknesses.length, high: report.weaknesses.filter(w => w.priority === 'high').length,
      total: q.total,
    });
  }
  return { report };
}

export { publicReport };

// The signed-in account's id, when accounts are on for this visitor (else undefined: nothing is kept)
export async function accountIdFor(request, env) {
  try { if (!(await accountsOn(request, env))) return undefined; const a = await currentAccount(request, env); return a ? a.id : undefined; }
  catch { return undefined; }
}

async function link(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
  // Each look for the invitation is a Google Ads API call, so crawlers are refused and one connection gets 30 an hour.
  const blocked = await guard(env, request, access, 'ads-link', 30, 60);
  if (blocked) { await countUse(env, TOOL, 'blocked', blocked.reason); return blocked.response; }
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
  // Spam and crawlers: this site's page only, a browser, at most 6 runs an hour from one connection (tools-gate.js)
  const blocked = await guard(env, request, access, TOOL, 6, 60);
  if (blocked) { await countUse(env, TOOL, 'blocked', blocked.reason); return blocked.response; }
  const body = await readBody(request);
  const customerId = cleanId(body.customerId);
  if (!/^\d{10}$/.test(customerId)) return jsonResponse({ error: 'Enter your 10-digit Google Ads customer ID.' }, 400);
  // Lewis's own preview is already signed in to /admin, so it skips the bot check; visitors always get it.
  if (!access.admin && !(await turnstileOk(env, request, body.token, 'ads_check'))) {
    await countUse(env, TOOL, 'blocked', 'turnstile');
    return jsonResponse({ error: 'The spam check didn’t go through. Please press Run again.' }, 400);
  }

  const pricing = await getPricing(env);
  const limit = await freeLimits(env, access, customerId, pricing);
  if (limit.error) { await countUse(env, TOOL, 'blocked', limit.reason); return limit.error; }

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

    const out = await buildReport(env, env, m, customerId, access, pricing, limit, accepted ? 'manager-link' : 'already-linked', { ...readTarget(body), accountId: await accountIdFor(request, env) });
    return out.error || jsonResponse({ report: publicReport(out.report, access.admin) });
  } catch (err) {
    console.error('ads-check: run failed', err && (err.code || err.message));
    if (!access.admin) await countUse(env, TOOL, 'failed');
    const msg = err instanceof AdsError && err.kind === 'link' ? err.message : 'Something went wrong while reading the account. Nothing was changed. Please try again, or ask me a question below.';
    return jsonResponse({ error: msg }, 502);
  } finally {
    if (accepted) await endLink(env, m, customerId, s.managerLinkId);
  }
}

// Lewis only: the demo clients, for the picker in /admin#demos.
async function demoList(request, env) {
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.admin) return jsonResponse({ error: 'Not found' }, 404);
  return jsonResponse({ demos: DEMOS.map(({ id, name, size, model, build, note }) => ({ id, name, size, model, build, note })) });
}

// Lewis only: the report for a made-up account, priced with the live calculator. Not saved.
async function sample(request, env) {
  if (!sameOrigin(request)) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('google-ads-check', request, env);
  if (!access.admin) return jsonResponse({ error: 'Not found' }, 404);
  const pricing = await getPricing(env);
  // ?sample=<demo id> (demos.js, listed in /admin#demos). 1 and 2 are the first two samples' old names.
  const body = await readBody(request);
  const demo = findDemo(String(body.variant || ''));
  // A target from the page (?cpa= or ?roas=) wins, else the demo's own; the brand the same way.
  const given = readTarget(body);
  const target = given.target || demo.target || null;
  const result = runRules(demo.data(londonDay()), { currency: 'GBP', today: londonDay(), target, brand: given.brand });
  const q = quote(pricing, result.weaknesses, new Date(), result.workload);
  const plan = actionPlan(result.weaknesses, q, result.facts.spend30);
  const report = {
    id: '0'.repeat(32), checkedAt: new Date().toISOString(), customerId: '0000000000', accountName: `Demo: ${demo.name} (made up)`,
    currency: 'GBP', facts: result.facts, strengths: result.strengths, weaknesses: result.weaknesses,
    profile: result.profile, ngrams: result.ngrams, dayHour: result.dayHour, workload: result.workload,
    headline: headlineFor(result.headline, plan, result.weaknesses), plan, trend: result.trend, segments: result.segments,
    changes: result.changes, urls: result.urls, target: result.target, yardstick: result.yardstick, brand: given.brand,
    quote: q, pricingVersion: pricing.version || 0, operations: 0, sample: true,
  };
  return jsonResponse({ report: { ...publicReport(report, true), sample: true } });
}

export async function adsCheck(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/tools/google-ads-check/demos') return request.method === 'GET' ? demoList(request, env) : new Response('Method not allowed', { status: 405 });
  if (path === '/tools/google-ads-check/sample') return request.method === 'POST' ? sample(request, env) : new Response('Method not allowed', { status: 405 });
  if (path === '/tools/google-ads-check/link') return request.method === 'POST' ? link(request, env) : new Response('Method not allowed', { status: 405 });
  if (path === '/tools/google-ads-check/run') return request.method === 'POST' ? run(request, env) : new Response('Method not allowed', { status: 405 });
  const api = path.match(/^\/tools\/google-ads-check\/report\/([a-f0-9]{32})$/);
  if (api) {
    const access = await toolAccessFor('google-ads-check', request, env);
    if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
    let r = await getJson(env, PREFIX + 'reports/' + api[1] + '.json');
    if (!r || Date.now() - Date.parse(r.checkedAt) > REPORT_DAYS * 86400000) r = await getJson(env, PREFIX + 'kept/' + api[1] + '.json');
    if (!r) return jsonResponse({ error: 'That report has expired or doesn’t exist. Reports are kept for 30 days.' }, 404);
    return jsonResponse({ report: publicReport(r, access.admin) });
  }
  if (path === '/google-ads-audit' || path.startsWith('/google-ads-audit/r/')) {
    const access = await toolAccessFor('google-ads-check', request, env);
    if (!access.allowed) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (path === '/google-ads-audit') { const entry = await reviewEntry(new URL(request.url), env); if (entry) return entry; }
    const signIn = FLAGS.googleSignIn ? access.allowed : !!((access.admin && FLAGS.googleSignInPreview) || await isReviewer(request, env));
    const attrs = (access.admin ? ' data-preview="1"' : '') + (signIn ? ' data-signin="1"' : '');
    const html = attrs ? pageHtml.replace('<body>', '<body' + attrs + '>') : pageHtml;
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
