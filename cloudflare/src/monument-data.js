// Monument's draft: the debtor days tool's data, from the Phillips. data service (data.phillips-uk.com).
//   GET /monument/api/search?q=tesco        companies that have filed payment reports (8 at most)
//   GET /monument/api/company/04780736      one company's latest report and its past reports
//   GET /monument/api/rate                  the Bank of England SME rate, once it has been entered
// Monument's own key (Worker secret MONUMENT_DATA_KEY) stays here and never reaches the browser. Only Ben's invite
// (the ph_mcf cookie on /monument) or Lewis signed in to /admin opens these routes, and only these three shapes are
// passed on. Answers are cached at the edge, so repeat lookups don't use Monument's daily quota.
import { getInvite, inviteState, invitePages } from './rate-card.js';
import { adminEmail } from './admin.js';

const API = 'https://data.phillips-uk.com/v1';
const COOKIE = 'ph_mcf';
const HOURS = { search: 6, company: 6, rate: 6 };

export function isMonumentDataPath(path) {
  return path.startsWith('/monument/api/');
}

export async function monumentData(request, url, env, ctx) {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if (!(await allowed(request, env))) return reply({ error: 'by_invitation' }, 403);
  if (!env.MONUMENT_DATA_KEY) return reply({ error: 'not_configured' }, 503);

  const path = url.pathname.replace(/\/+$/, '');
  let upstream, kind;
  if (path === '/monument/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (q.replace(/[^A-Za-z0-9]/g, '').length < 2) return reply({ results: [] });
    upstream = `${API}/companies/search?q=${encodeURIComponent(q.toLowerCase())}`; kind = 'search';
  } else if (path === '/monument/api/rate') {
    upstream = `${API}/rates/sme`; kind = 'rate';
  } else {
    const m = path.match(/^\/monument\/api\/company\/([A-Za-z0-9]{8})$/);
    if (!m) return reply({ error: 'not_found' }, 404);
    upstream = `${API}/companies/${m[1].toUpperCase()}/payments`; kind = 'company';
  }

  // The edge cache is keyed on the upstream address only: the answers are the same public data for every visitor.
  const cache = caches.default, cacheKey = new Request(upstream);
  const hit = await cache.match(cacheKey);
  if (hit) return reply(await hit.json(), hit.status);

  let res, body;
  try {
    res = await fetch(upstream, { headers: { Authorization: `Bearer ${env.MONUMENT_DATA_KEY}` } });
    body = await res.json();
  } catch (err) {
    console.error('monument data failed', err && err.message);
    return reply({ error: 'unavailable' }, 502);
  }
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    console.error('monument data refused', res.status, body && body.error);
    return reply({ error: 'unavailable' }, 502);
  }
  const out = trim(kind, body, res.status);
  if (res.status === 200 || res.status === 404) {
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
      status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${HOURS[kind] * 3600}` },
    })));
  }
  return reply(out, res.status);
}

// Only what the page shows
function trim(kind, b, status) {
  if (status !== 200) return { error: b && b.error === 'not_yet_entered' ? 'not_yet_entered' : 'not_found' };
  if (kind === 'search') return { as_of: b.as_of, results: (b.results || []).map(r => ({ number: r.number, name: r.name, section: r.section })) };
  if (kind === 'rate') return { month: b.month, value: b.value, source_url: b.source_url };
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
