// Phillips. data service: a read-only API over company-level public data (data.phillips-uk.com/v1).
// Clients call it server to server with their own key, held as a Worker secret in their own account.
// The key is never stored here: only its SHA-256 hash. Writes come only from the ingest job.

import { liveCompany } from './live.js';
import { fxRates } from './fx.js';

const SOURCE = {
  payments: {
    source: 'Department for Business and Trade, payment practices reporting; Companies House',
    licence: 'Contains public sector information licensed under the Open Government Licence v3.0',
  },
};
const METRICS = new Set(['days', 'pct_late', 'pct30']);
const ACCOUNT_METRICS = new Set(['debtor_days', 'stock_days', 'creditor_days']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (path === '/v1/health') return json({ ok: true });
    if (!path.startsWith('/v1/')) return json({ error: 'not_found' }, 404);

    // ---- authentication ----
    const auth = request.headers.get('Authorization') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (key.length < 40) return json({ error: 'missing_or_invalid_key' }, 401);
    const hash = await sha256(key);
    const client = await env.DB.prepare(
      `SELECT c.id, c.status, c.scopes, c.daily_quota FROM api_keys k JOIN clients c ON c.id = k.client_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`).bind(hash).first();
    if (!client) return json({ error: 'missing_or_invalid_key' }, 401);
    if (client.status === 'suspended') return json({ error: 'client_suspended' }, 403);

    // ---- rate limits: per key per minute, and a daily quota per client ----
    if (env.PER_KEY) {
      const { success } = await env.PER_KEY.limit({ key: hash });
      if (!success) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    }
    const day = new Date().toISOString().slice(0, 10);
    const endpoint = path.replace(/\/[A-Z0-9]{8}(?=\/)/i, '/{number}');
    const used = await env.DB.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM usage WHERE client_id = ? AND day = ?')
      .bind(client.id, day).first('n');
    if (used >= client.daily_quota) return json({ error: 'daily_quota_reached' }, 429);
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare(`INSERT INTO usage (client_id, endpoint, day, requests) VALUES (?, ?, ?, 1)
        ON CONFLICT (client_id, endpoint, day) DO UPDATE SET requests = requests + 1`).bind(client.id, endpoint, day),
      env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').bind(new Date().toISOString(), hash),
    ]));

    const scopes = safeParse(client.scopes, []);
    const allow = scope => scopes.includes(scope);
    const denied = json({ error: 'not_in_plan' }, 403);

    try {
      if (path === '/v1/companies/search') {
        const all = url.searchParams.get('all') === '1';
        return (all ? allow('live') || allow('payments') : allow('payments')) ? await (all ? searchRegister : search)(url, env) : denied;
      }
      let m = path.match(/^\/v1\/companies\/([A-Za-z0-9]{8})\/payments$/);
      if (m) return allow('payments') ? await payments(m[1].toUpperCase(), env) : denied;
      m = path.match(/^\/v1\/companies\/([A-Za-z0-9]{8})\/live$/);
      if (m) {
        if (!allow('live')) return denied;
        // Companies House allows 600 calls per 5 minutes in total; a lookup uses up to 5. Shared cap across all clients.
        if (env.CH_GLOBAL && !(await env.CH_GLOBAL.limit({ key: 'companies-house' })).success)
          return json({ error: 'busy_try_again' }, 429, { 'Retry-After': '60' });
        const r = await liveCompany(m[1].toUpperCase(), env, ctx);
        return json(r, r.error ? 404 : 200);
      }
      if (path === '/v1/benchmarks') {
        const dataset = url.searchParams.get('dataset') || 'payments';
        if (dataset === 'accounts') return allow('accounts') ? await accountBenchmarks(url, env) : denied;
        return allow('payments') ? await benchmarks(url, env) : denied;
      }
      if (path === '/v1/rates/sme') return allow('rates') ? await smeRate(env) : denied;
      if (path === '/v1/rates/fx') return allow('rates') ? json(await fxRates(ctx)) : denied;
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

// GET /v1/companies/search?q=jaguar : companies that have filed payment reports. 2+ characters, 8 results at most.
async function search(url, env) {
  const q = (url.searchParams.get('q') || '').trim();
  const qn = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (qn.length < 2) return json({ error: 'query_too_short', min_length: 2 }, 400);
  const byNumber = /^[A-Z0-9]{8}$/.test(qn)
    ? await env.DB.prepare('SELECT number, name, postcode_area, section, reports FROM companies WHERE number = ?').bind(qn).all()
    : { results: [] };
  const byName = await env.DB.prepare(
    `SELECT number, name, postcode_area, section, reports FROM companies WHERE name_norm LIKE ?
     ORDER BY (name_norm LIKE ?) DESC, reports DESC, name LIMIT 8`).bind(`%${qn}%`, `${qn}%`).all();
  const seen = new Set();
  const results = [...byNumber.results, ...byName.results].filter(r => !seen.has(r.number) && seen.add(r.number)).slice(0, 8);
  return json({ ...(await meta(env)), results });
}

// GET /v1/companies/search?q=acme&all=1 : any company on the register (about 5.6 million). Name prefix or number,
// 8 results at most, in name order (the index answers it without sorting).
async function searchRegister(url, env) {
  const qn = (url.searchParams.get('q') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (qn.length < 2) return json({ error: 'query_too_short', min_length: 2 }, 400);
  const cols = 'number, name, status, postcode_area, section, sic_code, incorporated';
  const byNumber = /^[A-Z0-9]{8}$/.test(qn)
    ? await env.DB.prepare(`SELECT ${cols} FROM register WHERE number = ?`).bind(qn).all() : { results: [] };
  const byName = await env.DB.prepare(
    `SELECT ${cols} FROM register WHERE name_norm >= ? AND name_norm < ? ORDER BY name_norm LIMIT 8`).bind(qn, qn + '~').all();
  const seen = new Set();
  const results = [...byNumber.results, ...byName.results].filter(r => !seen.has(r.number) && seen.add(r.number)).slice(0, 8);
  return json({ source: 'Companies House Free Company Data Product',
    licence: 'Contains public sector information licensed under the Open Government Licence v3.0', results });
}

// GET /v1/companies/{number}/payments : latest report, history and the industry benchmark for the same year.
async function payments(number, env) {
  const company = await env.DB.prepare(
    `SELECT c.number, c.name, c.status, c.sic_code, c.sic_text, c.division, c.section, s.name AS section_name,
            c.postcode_area, c.incorporated FROM companies c LEFT JOIN sectors s ON s.code = 's-' || c.section
     WHERE c.number = ?`).bind(number).first();
  if (!company) return json({ ...(await meta(env)), error: 'no_payment_reports', number }, 404);
  const { results: reports } = await env.DB.prepare(
    `SELECT report_id, period_start, period_end, filed, payments_made, days, pct30, pct60, pct_over60, pct_late,
            pct_dispute, terms_shortest, terms_longest, terms_max, payment_code, e_invoicing, scf
     FROM payment_reports WHERE company_number = ? ORDER BY period_end DESC, filed DESC`).bind(number).all();
  const latest = reports.find(r => r.payments_made) || reports[0] || null;
  let benchmark = null;
  if (latest) {
    const year = Number(latest.period_end.slice(0, 4));
    const groups = [company.division && `d-${company.division}`, company.section && `s-${company.section}`, 'all'].filter(Boolean);
    for (const g of groups) {
      const { results } = await env.DB.prepare(
        `SELECT b.group_key, s.name AS group_name, b.metric, b.year, b.median, b.p25, b.p75, b.n
         FROM benchmarks b LEFT JOIN sectors s ON s.code = b.group_key
         WHERE b.dataset = 'payments' AND b.group_key = ? AND b.year = ?`).bind(g, year).all();
      if (results.length) {
        benchmark = {
          group: g, group_name: g === 'all' ? 'All reporting companies' : results[0].group_name, year,
          metrics: Object.fromEntries(results.map(r => [r.metric, { median: r.median, p25: r.p25, p75: r.p75, n: r.n }])),
        };
        break;
      }
    }
  }
  return json({ ...(await meta(env)), company, latest, history: reports.slice(0, 20), reports_total: reports.length, benchmark });
}

// GET /v1/benchmarks?group=s-C&metric=days&year=2025 (group and year optional; metric defaults to days)
async function benchmarks(url, env) {
  const group = url.searchParams.get('group') || 'all';
  const metric = url.searchParams.get('metric') || 'days';
  const year = url.searchParams.get('year');
  if (!/^(all|s-[A-U]|d-\d{2})$/.test(group)) return json({ error: 'bad_group' }, 400);
  if (!METRICS.has(metric)) return json({ error: 'bad_metric', allowed: [...METRICS] }, 400);
  if (year && !/^\d{4}$/.test(year)) return json({ error: 'bad_year' }, 400);
  const stmt = year
    ? env.DB.prepare(`SELECT group_key, metric, year, median, p25, p75, n FROM benchmarks
        WHERE dataset = 'payments' AND group_key = ? AND metric = ? AND year = ?`).bind(group, metric, Number(year))
    : env.DB.prepare(`SELECT group_key, metric, year, median, p25, p75, n FROM benchmarks
        WHERE dataset = 'payments' AND group_key = ? AND metric = ? ORDER BY year`).bind(group, metric);
  const { results } = await stmt.all();
  const name = group === 'all' ? 'All reporting companies'
    : await env.DB.prepare('SELECT name FROM sectors WHERE code = ?').bind(group).first('name');
  return json({ ...(await meta(env)), group, group_name: name, results });
}

// GET /v1/benchmarks?dataset=accounts&group=s-C&metric=debtor_days : from filed accounts of companies with 10+ staff.
async function accountBenchmarks(url, env) {
  const group = url.searchParams.get('group') || 'all';
  const metric = url.searchParams.get('metric') || 'debtor_days';
  if (!/^(all|s-[A-U]|d-\d{2})$/.test(group)) return json({ error: 'bad_group' }, 400);
  if (!ACCOUNT_METRICS.has(metric)) return json({ error: 'bad_metric', allowed: [...ACCOUNT_METRICS] }, 400);
  const { results } = await env.DB.prepare(
    'SELECT group_key, metric, year, median, p25, p75, n FROM accounts_benchmarks WHERE group_key = ? AND metric = ? ORDER BY year')
    .bind(group, metric).all();
  const name = group === 'all' ? 'All companies with 10 or more staff'
    : await env.DB.prepare('SELECT name FROM sectors WHERE code = ?').bind(group).first('name');
  const as_of = await env.DB.prepare("SELECT as_of FROM dataset_versions WHERE dataset = 'accounts' ORDER BY as_of DESC LIMIT 1").first('as_of');
  return json({ as_of, source: 'Companies House accounts bulk data (filed iXBRL accounts)',
    licence: SOURCE.payments.licence, group, group_name: name, basis: 'Companies with 10 or more staff that file turnover', results });
}

// GET /v1/rates/sme : the latest Bank of England effective rate on new loans to SMEs, entered by hand each month.
async function smeRate(env) {
  const r = await env.DB.prepare(
    "SELECT month, value, release, source_url FROM rates WHERE series = 'boe-sme-new-loans' ORDER BY month DESC LIMIT 1").first();
  if (!r) return json({ error: 'not_yet_entered' }, 404);
  return json({ series: 'Effective interest rate on new loans to SMEs', ...r,
    source: 'Bank of England, Bankstats (monetary and financial statistics)',
    licence: "Bank of England statistical data, reused under the Bank's terms of use" });
}

async function meta(env) {
  const as_of = await env.DB.prepare(
    "SELECT as_of FROM dataset_versions WHERE dataset = 'payments' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1").first('as_of');
  return { as_of, ...SOURCE.payments };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
