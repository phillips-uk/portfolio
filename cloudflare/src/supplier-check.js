// Supplier health check: a demo of the tool we build into client websites (Lewis, 21 Nov 2026), on the Phillips. data
// service's health signals. Not linked from the site and kept out of search (noindex) until Lewis decides to launch it.
//
// Routes
//   GET /demo/supplier-check                 the page
//   GET /demo/supplier-check/api/search?q=   any company on the register, 8 results (name prefix or number)
//   GET /demo/supplier-check/api/check/<n>   one company's health signals
//
// The demo's own data key (Worker secret PHILLIPS_DATA_KEY, client "phillips-demo", scopes live and signals) stays here.
// Only same-site browser requests are served. Lookups are limited per connection (20 an hour, the IP hashed by
// tools-gate.js, never stored) because each uncached one uses Companies House calls shared with every client.
// Answers are cached at the edge (public data, the same for everyone), so a repeat lookup costs nothing.
import pageHtml from '../private/supplier-check.html';
import { jsonResponse, looksLikeBot, overRate, NO_INDEX } from './tools-gate.js';

const API = 'https://data.phillips-uk.com/v1';
const BASE = '/demo/supplier-check';
const HOURS = { search: 24, check: 6 };

export function isSupplierCheckPath(path) {
  return path === BASE || path.startsWith(BASE + '/');
}

export async function supplierCheck(request, url, env, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  if (request.method !== 'GET' && request.method !== 'HEAD') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (path === BASE) {
    if (url.pathname !== BASE + '/') return Response.redirect(new URL(BASE + '/' + url.search, url).href, 301);
    return new Response(pageHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...NO_INDEX } });
  }
  if (!path.startsWith(BASE + '/api/')) return jsonResponse({ error: 'not_found' }, 404);
  // Browser requests from this site only
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return jsonResponse({ error: 'forbidden' }, 403);
  if (looksLikeBot(request)) return jsonResponse({ error: 'Please try again in your web browser.' }, 403);
  if (!env.PHILLIPS_DATA_KEY) return jsonResponse({ error: 'not_configured' }, 503);

  if (path === BASE + '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (q.replace(/[^A-Za-z0-9]/g, '').length < 2) return jsonResponse({ results: [] });
    return relay('search', `${API}/companies/search?q=${encodeURIComponent(q.toLowerCase())}&all=1`, env, ctx);
  }
  const m = path.match(/^\/demo\/supplier-check\/api\/check\/([A-Za-z0-9]{8})$/);
  if (m) {
    const upstream = `${API}/companies/${m[1].toUpperCase()}/signals`;
    const hit = await caches.default.match(new Request(upstream));
    if (hit) return jsonResponse(await hit.json(), hit.status);
    if (await overRate(env, request, 'supplier-check', 20, 60))
      return jsonResponse({ error: 'You have checked a lot of companies in the last hour. Please try again later.' }, 429);
    return relay('check', upstream, env, ctx);
  }
  return jsonResponse({ error: 'not_found' }, 404);
}

async function relay(kind, upstream, env, ctx) {
  const cacheKey = new Request(upstream);
  const hit = await caches.default.match(cacheKey);
  if (hit) return jsonResponse(await hit.json(), hit.status);
  let res, body;
  try {
    res = await fetch(upstream, { headers: { Authorization: `Bearer ${env.PHILLIPS_DATA_KEY}` } });
    body = await res.json();
  } catch (err) {
    console.error('supplier check upstream', err && err.message);
    return jsonResponse({ error: 'unavailable' }, 502);
  }
  if (res.status === 429) return jsonResponse({ error: 'busy' }, 503);
  if (res.status === 404) return jsonResponse({ error: 'not_found' }, 404);
  if (!res.ok) {
    console.error('supplier check refused', res.status, body && body.error);
    return jsonResponse({ error: 'unavailable' }, 502);
  }
  const out = kind === 'search'
    ? { results: (body.results || []).map(r => ({ number: r.number, name: r.name, status: r.status, postcode_area: r.postcode_area })) }
    : body;
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${HOURS[kind] * 3600}` },
  })));
  return jsonResponse(out);
}
