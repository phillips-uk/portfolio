// Monument's draft: the tools' data, from Index Point (api.indexpoint.uk, formerly the Phillips. data service).
//   GET /monument/api/search?q=tesco        companies that have filed payment reports (debtor days customer search)
//   GET /monument/api/company/04780736      one company's latest payment report and its past reports
//   GET /monument/api/register?q=acme       any company on the register, for "fill in from your accounts"
//   GET /monument/api/lookup/04780736       one company's latest filed accounts figures and its outstanding charges
//   GET /monument/api/benchmarks?division=61&section=J
//                                           debtor, stock and creditor days from filed accounts: the division, else
//                                           the section, else all companies (the first with figures)
// Monument's own key (Worker secret MONUMENT_DATA_KEY) stays here and never reaches the browser. Only Ben's invite
// (the ph_mcf cookie on /monument) or Lewis signed in to /admin opens these routes, and only these shapes are passed
// on. Answers are cached at the edge, so repeat lookups don't use Monument's daily quota or Companies House calls.
import { getInvite, inviteState, invitePages } from './rate-card.js';
import { adminEmail } from './admin.js';

const API = 'https://api.indexpoint.uk/v1';
const COOKIE = 'ph_mcf';
const HOURS = { search: 6, company: 6, register: 24, lookup: 24, benchmarks: 24 };
const METRICS = ['debtor_days', 'stock_days', 'creditor_days'];

export function isMonumentDataPath(path) {
  return path.startsWith('/monument/api/');
}

export async function monumentData(request, url, env, ctx) {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if (!(await allowed(request, env))) return reply({ error: 'by_invitation' }, 403);
  if (!env.MONUMENT_DATA_KEY) return reply({ error: 'not_configured' }, 503);

  const path = url.pathname.replace(/\/+$/, '');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  let m;
  if (path === '/monument/api/search' || path === '/monument/api/register') {
    if (q.replace(/[^A-Za-z0-9]/g, '').length < 2) return reply({ results: [] });
    const kind = path.endsWith('search') ? 'search' : 'register';
    return cached(kind, `${API}/companies/search?q=${encodeURIComponent(q.toLowerCase())}${kind === 'register' ? '&all=1' : ''}`, env, ctx);
  }
  if ((m = path.match(/^\/monument\/api\/company\/([A-Za-z0-9]{8})$/))) return cached('company', `${API}/companies/${m[1].toUpperCase()}/payments`, env, ctx);
  if ((m = path.match(/^\/monument\/api\/lookup\/([A-Za-z0-9]{8})$/))) return cached('lookup', `${API}/companies/${m[1].toUpperCase()}/live`, env, ctx);
  if (path === '/monument/api/benchmarks') {
    const d = url.searchParams.get('division') || '', s = url.searchParams.get('section') || '';
    const groups = [/^\d{2}$/.test(d) && `d-${d}`, /^[A-U]$/.test(s) && `s-${s}`, 'all'].filter(Boolean);
    return benchmarks(groups, env, ctx);
  }
  return reply({ error: 'not_found' }, 404);
}

// One upstream call through the edge cache; answers are trimmed to what the page shows.
async function cached(kind, upstream, env, ctx) {
  const r = await fetchCached(kind, upstream, env, ctx);
  return reply(r.body, r.status);
}

async function fetchCached(kind, upstream, env, ctx) {
  // The cache key is the upstream address only: the answers are the same public data for every visitor.
  const cache = caches.default, cacheKey = new Request(upstream);
  const hit = await cache.match(cacheKey);
  if (hit) return { status: hit.status, body: await hit.json() };
  let res, body;
  try {
    res = await fetch(upstream, { headers: { Authorization: `Bearer ${env.MONUMENT_DATA_KEY}` } });
    body = await res.json();
  } catch (err) {
    console.error('monument data failed', err && err.message);
    return { status: 502, body: { error: 'unavailable' } };
  }
  // The live lookup is capped across every client (Companies House's limit): the page says to try again shortly.
  if (res.status === 429 && kind === 'lookup' && body && body.error === 'busy_try_again') return { status: 503, body: { error: 'busy' } };
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    console.error('monument data refused', res.status, body && body.error);
    return { status: 502, body: { error: 'unavailable' } };
  }
  const out = res.status === 200 ? trim(kind, body) : { error: 'not_found' };
  if (res.status === 200 || res.status === 404) {
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
      status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${HOURS[kind] * 3600}` },
    })));
  }
  return { status: res.status, body: out };
}

// Debtor, stock and creditor days for the first group that has all three
async function benchmarks(groups, env, ctx) {
  for (const g of groups) {
    const parts = await Promise.all(METRICS.map(metric =>
      fetchCached('benchmarks', `${API}/benchmarks?dataset=accounts&group=${g}&metric=${metric}`, env, ctx)));
    if (parts.some(p => p.status >= 500)) return reply({ error: 'unavailable' }, 502);
    const out = { group: g, as_of: parts[0].body.as_of || null };
    for (const [k, p] of parts.entries()) {
      // The year with the most companies: the latest year is still filling up as accounts arrive
      const rows = (p.body.results || []).filter(r => r.median != null);
      const last = rows.reduce((b, r) => (!b || r.n > b.n || (r.n === b.n && r.year > b.year) ? r : b), null);
      if (!last) break;
      out[METRICS[k]] = { median: last.median, p25: last.p25, p75: last.p75, n: last.n, year: last.year };
    }
    if (METRICS.every(k => out[k])) return reply(out);
  }
  return reply({ error: 'not_found' }, 404);
}

// Only what the page shows
function trim(kind, b) {
  if (kind === 'search') return { as_of: b.as_of, results: (b.results || []).map(r => ({ number: r.number, name: r.name, section: r.section })) };
  if (kind === 'register') return { results: (b.results || []).map(r => ({ number: r.number, name: r.name, status: r.status })) };
  if (kind === 'benchmarks') return { as_of: b.as_of, results: (b.results || []).map(r => ({ year: r.year, median: r.median, p25: r.p25, p75: r.p75, n: r.n })) };
  if (kind === 'lookup') {
    const c = b.company || {}, ch = b.charges || {}, a = b.accounts;
    const F = ['turnover', 'cost_of_sales', 'trade_debtors', 'debtors', 'stock', 'trade_creditors', 'fixed_assets', 'cash', 'employees'];
    return {
      as_of: b.as_of,
      company: { number: c.number, name: c.name, status: c.status, division: c.division, section: c.section },
      charges: { outstanding: ch.outstanding || 0, holders: ch.holders || [], holders_not_listed: ch.holders_not_listed || 0 },
      accounts: a ? {
        made_up_to: a.made_up_to, filed: a.filed, type: a.type, machine_readable: Boolean(a.machine_readable),
        figures: a.figures ? Object.fromEntries(F.filter(k => typeof a.figures[k] === 'number').map(k => [k, a.figures[k]])) : null,
      } : null,
    };
  }
  const c = b.company || {};
  return {
    as_of: b.as_of,
    company: { number: c.number, name: c.name, division: c.division, section: c.section },
    latest: b.latest,
    history: (b.history || []).map(r => ({ period_end: r.period_end, days: r.days, payments_made: r.payments_made })),
  };
}

async function allowed(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const invite = m ? await getInvite(env, decodeURIComponent(m[1])) : null;
  if (inviteState(invite) === 'active' && invitePages(invite).includes('monument')) return true;
  return Boolean(await adminEmail(request, env));
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' },
  });
}
