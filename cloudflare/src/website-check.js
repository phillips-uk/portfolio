// The Website Check (plan section 4), since 16 Nov 2026. A visitor enters a web address, no sign-in, and gets strengths
// and weaknesses from fixed written rules (website-check-rules.js). No AI calls of any kind.
//
// Routes
//   GET  /website-check                 the page (private preview until Lewis says go: tools-gate.js)
//   GET  /website-check/r/<id>          the same page, showing a saved report (the share link)
//   POST /tools/website-check/run       { url, token, fresh? } runs a check, or reuses the domain's last one
//   GET  /tools/website-check/report/<id>
//   POST /tools/website-check/sample    Lewis only: { variant } a report for a made-up demo website (website-demos.js)
//   GET  /tools/website-check/demos     Lewis only: the demo websites, for /admin#demos/web
//
// What it fetches from the visitor's site: the page itself, the http version (to see if it redirects to https),
// robots.txt, the sitemap and llms.txt. Speed comes from Google's PageSpeed Insights API, which is free, with the
// PAGESPEED_API_KEY secret (key "Website Check PageSpeed" in the Phillips Tools Cloud project, since 16 Nov 2026).
// Without it the call goes keyless, which Google throttles.
//
// Storage: R2 (BLOBS), not D1. The tool needs a few small counters and one JSON report per check, the same shape as the
// contact form's rate limit, so R2 avoids a new database. Keys:
//   tools/website-check/reports/<id>.json      the report, served for 30 days, then deleted by the weekly clean-up
//   tools/website-check/domain/<domain>.json   the domain's latest report id (reused for websiteCacheHours)
//   tools/website-check/ip/<hash>/<day>.json   checks run from one connection that day (the IP is hashed, never stored)
// Limits come from the pricing settings (pricing.js, editable in /admin#pricing).
import websiteCheckHtml from '../private/website-check.html';
import { analyse, readPsi, GROUPS, RULES_VERSION } from './website-check-rules.js';
import { toolAccessFor, jsonResponse, sha, turnstileOk, londonDay, NO_INDEX } from './tools-gate.js';
import { getPricing, webQuote } from './pricing.js';
import { WEBSITE_DEMOS, findWebsiteDemo } from './website-demos.js';

const PREFIX = 'tools/website-check/';
const REPORT_DAYS = 30;
const UA = 'Mozilla/5.0 (compatible; PhillipsWebsiteCheck/1.0; +https://www.phillips-uk.com/website-check)';
const MAX_HTML = 2_000_000;

export function isWebsiteCheckPath(path) {
  return path === '/website-check' || /^\/website-check\/r\/[a-f0-9]{32}$/.test(path) || path.startsWith('/tools/website-check/');
}

const put = (env, key, value) => env.BLOBS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
async function getJson(env, key) {
  const obj = await env.BLOBS.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

// The visitor's address, tidied: https assumed, public hostnames only, no ports, no logins.
export function normaliseUrl(input) {
  let s = String(input || '').trim().slice(0, 500);
  if (!s) return { error: 'Enter your website’s address.' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: 'That doesn’t look like a web address. Try something like yourbusiness.co.uk.' }; }
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return { error: 'Enter just the website’s address.' };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host) || /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(host)) {
    return { error: 'That doesn’t look like a public website address.' };
  }
  u.hash = '';
  return { url: u.href, domain: host.replace(/^www\./, '') };
}

// A Worker can't fetch its own zone over the network (Cloudflare answers 522), so a check of phillips-uk.com
// itself is served by the Worker's own router instead. worker.js hands the router in on each request.
const SELF_HOSTS = new Set(['www.phillips-uk.com', 'phillips-uk.com']);
let selfHandler = null;
export function setSelfHandler(fn) { selfHandler = fn; }

async function selfFetch(url, init) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await selfHandler(new Request(current, { method: 'GET', headers: { 'User-Agent': UA, ...(init.headers || {}) } }));
    const loc = res.headers.get('Location');
    if (init.redirect !== 'manual' && res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href;
      if (!SELF_HOSTS.has(new URL(current).hostname.toLowerCase())) return netFetch(current, init, 12000);
      continue;
    }
    const out = new Response(res.body, res);
    Object.defineProperty(out, 'url', { value: current });
    return out;
  }
  throw new Error('website-check: too many redirects');
}

async function timedFetch(url, init = {}, ms = 12000) {
  if (selfHandler && SELF_HOSTS.has(new URL(url).hostname.toLowerCase())) return selfFetch(url, init);
  return netFetch(url, init, ms);
}

async function netFetch(url, init = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(init.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function readText(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { reader.cancel(); } catch { /* already done */ }
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) { const part = c.subarray(0, Math.max(0, all.length - off)); all.set(part, off); off += part.length; if (off >= all.length) break; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

async function smallText(url) {
  try {
    const res = await timedFetch(url, { redirect: 'follow' }, 8000);
    if (!res.ok) return null;
    const type = res.headers.get('Content-Type') || '';
    const text = await readText(res, 200_000);
    if (/text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) return null; // a "not found" page served as 200
    return text;
  } catch { return null; }
}

async function pageSpeed(env, url, strategy) {
  const key = env.PAGESPEED_API_KEY || '';
  const cats = strategy === 'mobile' ? ['performance', 'seo', 'accessibility'] : ['performance'];
  const q = new URLSearchParams({ url, strategy });
  cats.forEach(c => q.append('category', c));
  if (key) q.set('key', key);
  try {
    const res = await timedFetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, {}, 55000);
    if (!res.ok) { console.warn('website-check: pagespeed', strategy, res.status); return null; }
    return readPsi(await res.json());
  } catch (err) {
    console.warn('website-check: pagespeed', strategy, err && err.name);
    return null;
  }
}

// Fetches everything the rules need. Throws { userMessage } when the page itself can't be read.
async function gather(env, url) {
  const psiP = Promise.all([pageSpeed(env, url, 'mobile'), pageSpeed(env, url, 'desktop')]);
  let res;
  try { res = await timedFetch(url, { redirect: 'follow', headers: { Accept: 'text/html,application/xhtml+xml' } }, 15000); }
  catch { throw { userMessage: 'I couldn’t reach that website. Check the address and try again.' }; }
  if (!res.ok) throw { userMessage: `The website answered with an error (${res.status}), so I couldn’t check the page.` };
  const type = res.headers.get('Content-Type') || '';
  if (!/html/i.test(type)) throw { userMessage: 'That address doesn’t return a web page I can check.' };
  const html = await readText(res, MAX_HTML);
  const finalUrl = res.url || url;
  const origin = new URL(finalUrl).origin;

  const httpCheck = (async () => {
    try {
      const h = await timedFetch('http://' + new URL(finalUrl).host + '/', { redirect: 'manual' }, 8000);
      const loc = h.headers.get('Location') || '';
      if (h.status >= 300 && h.status < 400) return /^https:/i.test(new URL(loc, 'http://' + new URL(finalUrl).host).href);
      return false;
    } catch { return null; }
  })();
  const robotsP = smallText(origin + '/robots.txt');
  const llmsP = smallText(origin + '/llms.txt');
  const robots = await robotsP;
  const sitemapUrls = robots ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]) : [];
  const sitemap = sitemapUrls.length > 0 || await (async () => {
    for (const p of ['/sitemap.xml', '/sitemap_index.xml']) {
      const t = await smallText(origin + p);
      if (t && /<(urlset|sitemapindex)\b/i.test(t)) return true;
    }
    return false;
  })();
  const [httpRedirects, llms, psi] = await Promise.all([httpCheck, llmsP, psiP]);
  return {
    url, finalUrl, html, robots, sitemap, httpRedirects,
    llms: !!(llms && llms.trim().length > 20),
    robotsHeader: res.headers.get('X-Robots-Tag') || '',
    psi: { mobile: psi[0], desktop: psi[1] },
  };
}

function publicReport(r) {
  return {
    id: r.id, domain: r.domain, url: r.url, finalUrl: r.finalUrl, checkedAt: r.checkedAt,
    page: r.page, profile: r.profile || null, strengths: r.strengths, weaknesses: r.weaknesses, notes: r.notes, counts: r.counts,
    speed: r.speed, groups: GROUPS,
  };
}

const fresh = r => r && Date.now() - Date.parse(r.checkedAt) < REPORT_DAYS * 86400000;

// The report as the page gets it, with today's price list for its fixes (Lewis, 18 Nov 2026: pricing like the
// Google Ads report). Priced when it's shown, from the live calculator, so a saved link always shows current prices.
async function priced(env, r, pricing) {
  const p = pricing || await getPricing(env);
  return { ...publicReport(r), quote: webQuote(p, r.weaknesses || []) };
}

async function run(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: 'Forbidden' }, 403);
  const access = await toolAccessFor('website-check', request, env);
  if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const n = normaliseUrl(body.url);
  if (n.error) return jsonResponse({ error: n.error }, 400);
  // Lewis's own preview is already signed in to /admin, so it skips the bot check; visitors always get it.
  if (!access.admin && !(await turnstileOk(env, request, body.token, 'website_check'))) return jsonResponse({ error: 'The spam check didn’t go through. Please press Check again.' }, 400);

  const { settings } = await getPricing(env);
  const L = settings.limits;

  // The same domain reuses its last result for a while (Lewis can ask for a fresh run from the preview).
  const last = await getJson(env, PREFIX + 'domain/' + n.domain + '.json');
  const wantFresh = !!(body.fresh && access.admin);
  if (last && !wantFresh && Date.now() - Date.parse(last.checkedAt) < L.websiteCacheHours * 3600000) {
    const r = await getJson(env, PREFIX + 'reports/' + last.id + '.json');
    if (fresh(r) && r.rulesVersion === RULES_VERSION) return jsonResponse({ report: await priced(env, r), reused: true }); // a rules change re-runs the check
  }

  // Checks per connection per London day. Lewis's own preview runs aren't counted.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = PREFIX + 'ip/' + await sha(ip + '|' + (env.WORKER_SECRET || 'phillips')) + '/' + londonDay() + '.json';
  if (!access.admin) {
    const used = (await getJson(env, ipKey)) || { n: 0 };
    if (used.n >= L.websiteChecksPerIpPerDay) return jsonResponse({ error: `That’s ${L.websiteChecksPerIpPerDay} checks from this connection today, the most I allow. Please come back tomorrow, or ask me a question below.`, limit: true }, 429);
    await put(env, ipKey, { n: used.n + 1 });
  }

  let input;
  try { input = await gather(env, n.url); }
  catch (err) { return jsonResponse({ error: (err && err.userMessage) || 'Something went wrong while checking that site. Please try again.' }, 422); }

  const result = analyse(input);
  const id = crypto.randomUUID().replace(/-/g, '');
  const report = {
    id, domain: n.domain, url: n.url, finalUrl: input.finalUrl, checkedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION, ...result,
    speed: { mobile: input.psi.mobile && pick(input.psi.mobile), desktop: input.psi.desktop && pick(input.psi.desktop) },
    preview: !!access.admin,
  };
  await put(env, PREFIX + 'reports/' + id + '.json', report);
  await put(env, PREFIX + 'domain/' + n.domain + '.json', { id, checkedAt: report.checkedAt });
  return jsonResponse({ report: await priced(env, report), reused: false });
}

const pick = s => ({ performance: s.performance, lcp: s.lcp, cls: s.cls, tbt: s.tbt, field: s.field });

async function reportById(env, id) {
  const r = await getJson(env, PREFIX + 'reports/' + id + '.json');
  return fresh(r) ? r : null;
}

export async function websiteCheck(request, url, env) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/tools/website-check/demos' || path === '/tools/website-check/sample') {
    const access = await toolAccessFor('website-check', request, env);
    if (!access.admin) return jsonResponse({ error: 'Not found' }, 404);
    if (path === '/tools/website-check/demos') return jsonResponse({ demos: WEBSITE_DEMOS.map(({ id, name, size, model, build, note }) => ({ id, name, size, model, build, note })) });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: 'Forbidden' }, 403);
    let body = {};
    try { body = await request.json(); } catch { /* empty */ }
    // A made-up site through the same rules a visitor's site goes through. Not saved, never counted.
    const demo = findWebsiteDemo(String(body.variant || ''));
    const input = demo.input();
    const result = analyse(input);
    const report = {
      id: '0'.repeat(32), domain: new URL(input.finalUrl).hostname.replace(/^www\./, ''), url: input.url, finalUrl: input.finalUrl,
      checkedAt: new Date().toISOString(), rulesVersion: RULES_VERSION, ...result,
      speed: { mobile: input.psi.mobile && pick(input.psi.mobile), desktop: input.psi.desktop && pick(input.psi.desktop) },
    };
    return jsonResponse({ report: { ...(await priced(env, report)), sample: true, demoName: demo.name } });
  }
  if (path === '/tools/website-check/run') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    return run(request, env);
  }
  const api = path.match(/^\/tools\/website-check\/report\/([a-f0-9]{32})$/);
  if (api) {
    const access = await toolAccessFor('website-check', request, env);
    if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
    const r = await reportById(env, api[1]);
    return r ? jsonResponse({ report: await priced(env, r) }) : jsonResponse({ error: 'That report has expired or doesn’t exist. Reports are kept for 30 days.' }, 404);
  }
  if (path === '/website-check' || path.startsWith('/website-check/r/')) {
    const access = await toolAccessFor('website-check', request, env);
    if (!access.allowed) return null; // the caller sends the PAUSED redirect
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const isReport = path !== '/website-check';
    const html = access.admin ? websiteCheckHtml.replace('<body>', '<body data-preview="1">') : websiteCheckHtml;
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
        // Private until launch, and report pages are never indexed.
        ...((isReport || access.admin) ? NO_INDEX : {}),
      },
    });
  }
  return jsonResponse({ error: 'Not found' }, 404);
}

// Weekly clean-up (from the Worker's cron): reports older than 30 days and old per-connection counters are deleted.
export async function cleanupWebsiteChecks(env) {
  const cutoff = Date.now() - REPORT_DAYS * 86400000;
  const dayCutoff = londonDay(new Date(Date.now() - 2 * 86400000));
  for (const prefix of ['reports/', 'ip/', 'domain/']) {
    let cursor;
    do {
      const page = await env.BLOBS.list({ prefix: PREFIX + prefix, cursor });
      const old = page.objects.filter(o => {
        if (prefix === 'ip/') return (o.key.match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1] < dayCutoff;
        return new Date(o.uploaded).getTime() < cutoff;
      }).map(o => o.key);
      if (old.length) await env.BLOBS.delete(old);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
