// The Website Check (plan section 4), since 16 Nov 2026. A visitor enters a web address, no sign-in, and gets strengths
// and weaknesses from fixed written rules (website-check-rules.js). No AI calls of any kind.
//
// Routes
//   GET  /website-check                 the page (private preview until Lewis says go: tools-gate.js)
//   GET  /website-check/r/<id>          the same page, showing a saved report (the share link)
//   POST /tools/website-check/run       { url, token, fresh?, model? } runs a check, or reuses the domain's last one
//                                       (model: local | national | shop, the kind of business; detected when left out)
//   GET  /tools/website-check/report/<id>
//   POST /tools/website-check/sample    Lewis only: { variant } a report for a made-up demo website (website-demos.js)
//   GET  /tools/website-check/demos     Lewis only: the demo websites, for /admin#demos/web
//
// What it fetches from the visitor's site: the page itself (and its response headers), the http version (to see if it
// redirects to https), a made-up address (to see that missing pages answer 404), robots.txt, the sitemap and llms.txt. Speed comes from Google's PageSpeed Insights API, which is free, with the
// PAGESPEED_API_KEY secret (key "Website Check PageSpeed" in the Phillips Tools Cloud project, since 16 Nov 2026).
// Without it the call goes keyless, which Google throttles.
//
// Storage: R2 (BLOBS), not D1. The tool needs a few small counters and one JSON report per check, the same shape as the
// contact form's rate limit, so R2 avoids a new database. Keys:
//   tools/website-check/reports/<id>.json      the report, served for 30 days, then deleted by the weekly clean-up
//   tools/website-check/domain/<domain>.json   the domain's latest report id (reused for websiteCacheHours), and a short
//                                              record of its last check per kind of business (scores and which checks
//                                              passed, no page content) for the next check's before and after; kept a year
//   tools/website-check/ip/<hash>/<day>.json   checks run from one connection that day (the IP is hashed, never stored)
//   tools/website-check/day/<day>.json         checks run by every visitor that day (the daily ceiling)
// Limits come from the pricing settings (pricing.js, editable in /admin#pricing).
import websiteCheckHtml from '../private/website-check.html';
import { analyse, readPsi, GROUPS, RULES_VERSION, MODELS, internalUrl, pageKey, robotsAllows, pageFacts, areaScores, areaOf, snapshot, compareChecks } from './website-check-rules.js';
import { toolAccessFor, jsonResponse, sha, turnstileOk, londonDay, NO_INDEX, guard } from './tools-gate.js';
import { countUse, addToolLead } from './tool-leads.js';
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

// ---------- the site scan (rules v7) ----------
const SCAN_PAGES = 25;       // the home page and up to 24 more
const LINK_CHECKS = 25;      // other links on those pages, checked for a working answer
const SCAN_AT_ONCE = 4;      // a few requests at a time, so a small site isn't strained
const SCAN_SECONDS = 35;     // no new request starts after this (Google's speed test usually takes longer anyway)
const ROBOT = 'PhillipsWebsiteCheck';

// One address, following redirects by hand so the hops can be counted. Reads the body only when asked.
async function fetchHops(url, withBody) {
  let current = url;
  for (let hops = 0; hops <= 5; hops++) {
    let r;
    try { r = await timedFetch(current, { redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml' } }, 9000); }
    catch { return { url, status: 0, hops, finalUrl: current }; }
    const loc = r.headers.get('Location');
    if (r.status >= 300 && r.status < 400 && loc) {
      try { await r.body?.cancel(); } catch { /* nothing to read */ }
      try { current = new URL(loc, current).href; } catch { return { url, status: r.status, hops, finalUrl: current }; }
      continue;
    }
    const isHtml = /html/i.test(r.headers.get('Content-Type') || '');
    const html = withBody && r.status === 200 && isHtml ? await readText(r, 600_000) : '';
    if (!html) { try { await r.body?.cancel(); } catch { /* nothing to read */ } }
    return { url, status: r.status, hops, finalUrl: current, html, isHtml, robotsHeader: r.headers.get('X-Robots-Tag') || '' };
  }
  return { url, status: 310, hops: 6, finalUrl: current }; // a redirect loop or a very long chain
}

// A few at a time; nothing new starts after the deadline, so a slow site can't hold the report up.
async function inTurns(items, n, fn, deadline) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length && Date.now() < deadline) { const i = next++; out[i] = await fn(items[i]); } }));
  return out.filter(Boolean);
}

// The addresses in the sitemap (a sitemap index is followed to its first three sitemaps), same site only, at most 500.
async function sitemapLocs(origin, robots) {
  const read = async u => {
    try {
      const r = await timedFetch(u, { redirect: 'follow' }, 9000);
      if (!r.ok) { try { await r.body?.cancel(); } catch { /* */ } return null; }
      const t = await readText(r, 1_500_000);
      return /<(urlset|sitemapindex)\b/i.test(t) ? t : null;
    } catch { return null; }
  };
  const listed = robots ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]) : [];
  let xml = null;
  for (const u of [...listed.slice(0, 2), origin + '/sitemap.xml', origin + '/sitemap_index.xml']) { xml = await read(u); if (xml) break; }
  if (!xml) return { found: listed.length > 0, locs: [] };
  const locs = x => [...x.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  let urls = [];
  if (/<sitemapindex\b/i.test(xml)) {
    const children = locs(xml);
    // Pages before products and posts, so the scan sees the main pages first
    children.sort((a, b) => (/page/i.test(b) ? 1 : 0) - (/page/i.test(a) ? 1 : 0));
    for (const c of children.slice(0, 3)) { const t = await read(c); if (t) urls.push(...locs(t)); }
  } else urls = locs(xml);
  return { found: true, locs: urls.map(u => internalUrl(u, origin + '/')).filter(Boolean).slice(0, 500) };
}

// The pages to read after the home page: the home page's own links first (the menu), then the sitemap's, keeping some
// room for each, in the order they appear. robots.txt is respected.
async function scanSite(homeUrl, homeHtml, robots, sitemap, started) {
  const deadline = started + SCAN_SECONDS * 1000;
  const homeFacts = pageFacts({ url: homeUrl, status: 200, finalUrl: homeUrl, html: homeHtml });
  const seen = new Set([pageKey(homeUrl)]);
  const pick = (arr, n, out) => { for (const u of arr) { if (out.length >= n) break; const k = pageKey(u); if (seen.has(k) || !robotsAllows(robots, ROBOT, new URL(u).pathname)) continue; seen.add(k); out.push(u); } return out; };
  const want = SCAN_PAGES - 1;
  const fromHome = pick(homeFacts.links || [], sitemap.locs.length ? Math.ceil(want / 2) : want, []);
  const fromMap = pick(sitemap.locs, want - fromHome.length, []);
  pick([...(homeFacts.links || []), ...sitemap.locs], want - fromHome.length - fromMap.length, fromHome);
  const inMap = new Set(sitemap.locs.map(pageKey));
  const fetched = await inTurns([...fromHome, ...fromMap], SCAN_AT_ONCE, u => fetchHops(u, true), deadline);
  const pages = [{ ...homeFacts, inSitemap: inMap.has(pageKey(homeUrl)) }, ...fetched.map(f => ({ ...pageFacts(f), inSitemap: inMap.has(pageKey(f.url)) }))];
  // Other links found on those pages, not read above: checked for a working answer
  const checked = new Set(pages.flatMap(pg => [pageKey(pg.url), pageKey(pg.finalUrl)]));
  const others = [];
  for (const pg of pages) for (const l of pg.links || []) {
    const k = pageKey(l);
    if (others.length >= LINK_CHECKS) break;
    if (checked.has(k) || !robotsAllows(robots, ROBOT, new URL(l).pathname)) continue;
    checked.add(k); others.push({ url: l, from: pg.url });
  }
  const linkChecks = (await inTurns(others, SCAN_AT_ONCE, async o => ({ ...(await fetchHops(o.url, false)), from: o.from }), deadline)).map(({ html, isHtml, robotsHeader, ...c }) => c);
  // Pages keep only what the rules need (no link lists beyond the scan)
  return { pages: pages.map(({ links, ...pg }) => pg).map((pg, i) => ({ ...pg, linkTexts: pages[i].linkTexts })), linkChecks, sitemapCount: sitemap.locs.length };
}

async function pageSpeed(env, url, strategy, withBestPractices = true) {
  const key = env.PAGESPEED_API_KEY || '';
  // The phone run carries every category (best practices since rules v6): still one free call each way.
  const cats = strategy === 'mobile' ? ['performance', 'seo', 'accessibility', ...(withBestPractices ? ['BEST_PRACTICES'] : [])] : ['performance'];
  const q = new URLSearchParams({ url, strategy });
  cats.forEach(c => q.append('category', c));
  if (key) q.set('key', key);
  try {
    const res = await timedFetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, {}, 55000);
    // A refused category must never cost the speed scores: ask again with the three that worked before v6
    if (res.status === 400 && strategy === 'mobile' && withBestPractices) { console.warn('website-check: pagespeed refused best practices'); return pageSpeed(env, url, strategy, false); }
    if (!res.ok) { console.warn('website-check: pagespeed', strategy, res.status); return null; }
    return readPsi(await res.json());
  } catch (err) {
    console.warn('website-check: pagespeed', strategy, err && err.name);
    return null;
  }
}

// Fetches everything the rules need. Throws { userMessage } when the page itself can't be read.
async function gather(env, url) {
  const started = Date.now();
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
  // A made-up address on the same site: a real "not found" answers 404 (or 410); 200 means a soft 404 (rules v6)
  const missingP = (async () => {
    try {
      const r = await timedFetch(origin + '/phillips-check-' + crypto.randomUUID().slice(0, 8), { redirect: 'manual' }, 8000);
      try { await r.body?.cancel(); } catch { /* nothing to read */ }
      return r.status;
    } catch { return null; }
  })();
  const robotsP = smallText(origin + '/robots.txt');
  const llmsP = smallText(origin + '/llms.txt');
  const robots = await robotsP;
  const map = await sitemapLocs(origin, robots);
  // The scan runs while Google's speed test does, so it adds little to the wait
  const scanP = scanSite(finalUrl, html, robots, map, started).catch(err => { console.warn('website-check: scan', err && err.message); return null; });
  const [httpRedirects, llms, psi, missingStatus, scan] = await Promise.all([httpCheck, llmsP, psiP, missingP, scanP]);
  const sitemap = map.found;
  const h = k => res.headers.get(k) || '';
  return {
    url, finalUrl, html, robots, sitemap, httpRedirects,
    pages: scan ? scan.pages : null, linkChecks: scan ? scan.linkChecks : [], sitemapCount: scan ? scan.sitemapCount : 0,
    llms: !!(llms && llms.trim().length > 20),
    robotsHeader: h('X-Robots-Tag'), missingStatus,
    headers: { hsts: h('Strict-Transport-Security'), nosniff: h('X-Content-Type-Options'), frame: h('X-Frame-Options'), csp: h('Content-Security-Policy'), referrer: h('Referrer-Policy') },
    psi: { mobile: psi[0], desktop: psi[1] },
  };
}

function publicReport(r) {
  return {
    id: r.id, domain: r.domain, url: r.url, finalUrl: r.finalUrl, checkedAt: r.checkedAt,
    page: r.page, scan: r.scan || null, compare: r.compare || null, model: r.model || null, modelFrom: r.modelFrom || null, profile: r.profile || null, strengths: r.strengths, weaknesses: r.weaknesses, notes: r.notes, counts: r.counts,
    speed: r.speed, groups: GROUPS,
    // Area scores and each finding's area (v2 step 4), worked out when shown so older reports have them too
    areas: areaScores(r), areaOf: Object.fromEntries([...(r.strengths || []), ...(r.weaknesses || []), ...(r.notes || [])].map(f => [f.id, areaOf(f)])),
  };
}

const fresh = r => r && Date.now() - Date.parse(r.checkedAt) < REPORT_DAYS * 86400000;

// The report as the page gets it, with today's price list for its fixes (Lewis, 18 Nov 2026: pricing like the
// Google Ads report). Priced when it's shown, from the live calculator, so a saved link always shows current prices.
async function priced(env, r, pricing) {
  const p = pricing || await getPricing(env);
  return { ...publicReport(r), quote: webQuote(p, r.weaknesses || []) };
}

const TOOL = 'website-check';

async function run(request, env) {
  const access = await toolAccessFor(TOOL, request, env);
  if (!access.allowed) return jsonResponse({ error: 'Not found' }, 404);
  // Spam and crawlers: this site's page only, a browser, at most 12 tries an hour from one connection (tools-gate.js)
  const blocked = await guard(env, request, access, TOOL, 12, 60);
  if (blocked) { await countUse(env, TOOL, 'blocked', blocked.reason); return blocked.response; }
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const n = normaliseUrl(body.url);
  if (n.error) return jsonResponse({ error: n.error }, 400);
  const model = MODELS[body.model] ? body.model : null;
  // Lewis's own preview is already signed in to /admin, so it skips the bot check; visitors always get it.
  if (!access.admin && !(await turnstileOk(env, request, body.token, 'website_check'))) {
    await countUse(env, TOOL, 'blocked', 'turnstile');
    return jsonResponse({ error: 'The spam check didn’t go through. Please press Check again.' }, 400);
  }

  const { settings } = await getPricing(env);
  const L = settings.limits;

  // The same domain reuses its last result for a while (Lewis can ask for a fresh run from the preview).
  const last = await getJson(env, PREFIX + 'domain/' + n.domain + '.json');
  // A fresh check (the report's "Check again"): Lewis any time, visitors once the last one is an hour old, so someone
  // who has just fixed things can see the difference the same day. It still counts towards the daily limits.
  const wantFresh = !!(body.fresh && (access.admin || (last && Date.now() - Date.parse(last.checkedAt) > 3600000)));
  // A report reused for the same kind of business only: switching the kind re-runs the rules on a fresh fetch.
  const sameKind = last && (!model || model === last.model);
  if (last && sameKind && !wantFresh && Date.now() - Date.parse(last.checkedAt) < L.websiteCacheHours * 3600000) {
    const r = await getJson(env, PREFIX + 'reports/' + last.id + '.json');
    if (fresh(r) && r.rulesVersion === RULES_VERSION) { // a rules change re-runs the check
      // A reused report already has its Lead card from the run that made it, so it is only counted.
      if (!access.admin) await countUse(env, TOOL, 'reused');
      return jsonResponse({ report: await priced(env, r), reused: true });
    }
  }

  // The ceiling across every visitor per London day, then checks per connection. Lewis's own preview runs aren't counted,
  // and nor are reused reports (above), which cost nothing.
  const dayKey = PREFIX + 'day/' + londonDay() + '.json';
  if (!access.admin) {
    const day = (await getJson(env, dayKey)) || { n: 0 };
    if (day.n >= L.websiteChecksPerDay) {
      await countUse(env, TOOL, 'blocked', 'ceiling');
      return jsonResponse({ error: 'I’m busy today: the free checks for today have all been used. Please try again tomorrow, or ask me a question below.', limit: true }, 429);
    }
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = PREFIX + 'ip/' + await sha(ip + '|' + (env.WORKER_SECRET || 'phillips')) + '/' + londonDay() + '.json';
  if (!access.admin) {
    const used = (await getJson(env, ipKey)) || { n: 0 };
    if (used.n >= L.websiteChecksPerIpPerDay) {
      await countUse(env, TOOL, 'blocked', 'daily');
      return jsonResponse({ error: `That’s ${L.websiteChecksPerIpPerDay} checks from this connection today, the most I allow. Please come back tomorrow, or ask me a question below.`, limit: true }, 429);
    }
    await put(env, ipKey, { n: used.n + 1 });
    const day = (await getJson(env, dayKey)) || { n: 0 };
    await put(env, dayKey, { n: day.n + 1 });
  }

  let input;
  try { input = await gather(env, n.url); }
  catch (err) {
    if (!access.admin) await countUse(env, TOOL, 'failed');
    return jsonResponse({ error: (err && err.userMessage) || 'Something went wrong while checking that site. Please try again.' }, 422);
  }

  const result = analyse({ ...input, model });
  const id = crypto.randomUUID().replace(/-/g, '');
  const report = {
    id, domain: n.domain, url: n.url, finalUrl: input.finalUrl, checkedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION, ...result,
    speed: { mobile: input.psi.mobile && pick(input.psi.mobile), desktop: input.psi.desktop && pick(input.psi.desktop) },
    preview: !!access.admin,
  };
  // Before and after: the last check of this site as the same kind of business (v3 item 1)
  const snaps = (last && last.snaps) || {};
  report.compare = compareChecks(snaps[result.model], report);
  await put(env, PREFIX + 'reports/' + id + '.json', report);
  await put(env, PREFIX + 'domain/' + n.domain + '.json', { id, checkedAt: report.checkedAt, model: result.model, snaps: { ...snaps, [result.model]: snapshot(report) } });
  const out = await priced(env, report);
  if (!access.admin) {
    // Every completed visitor check is a Lead card in /admin#prospects (tool-leads.js). Lewis's preview makes none.
    await countUse(env, TOOL, 'completed');
    await addToolLead(env, access, {
      tool: TOOL, at: report.checkedAt, name: n.domain, website: input.finalUrl || n.url, checked: input.finalUrl || n.url,
      reportUrl: new URL('/website-check/r/' + id, request.url).href,
      issues: (report.weaknesses || []).length, high: (report.weaknesses || []).filter(w => w.priority === 'high').length,
      total: out.quote && out.quote.total,
    });
  }
  return jsonResponse({ report: out, reused: false });
}

const pick = s => ({ performance: s.performance, accessibility: s.accessibility ?? null, bestPractices: s.bestPractices ?? null, seo: s.seo ?? null, lcp: s.lcp, cls: s.cls, tbt: s.tbt, field: s.field });

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
    const result = analyse({ ...input, model: MODELS[body.model] ? body.model : null });
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
  const yearAgo = Date.now() - 400 * 86400000; // domain records hold the before and after, so they stay about a year
  for (const prefix of ['reports/', 'ip/', 'domain/', 'day/']) {
    let cursor;
    do {
      const page = await env.BLOBS.list({ prefix: PREFIX + prefix, cursor });
      const old = page.objects.filter(o => {
        if (prefix === 'ip/') return (o.key.match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1] < dayCutoff;
        return new Date(o.uploaded).getTime() < (prefix === 'domain/' ? yearAgo : cutoff);
      }).map(o => o.key);
      if (old.length) await env.BLOBS.delete(old);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
