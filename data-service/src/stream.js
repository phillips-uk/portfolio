// Companies House Streaming API, read in short catch-up sessions by the scheduled handler (every 10 minutes).
// Each session resumes from the saved timepoint, reads until the stream goes quiet or the time budget runs out,
// saves the new timepoint and closes. At most two streams are open at once (the per-account limit).
// Docs: https://developer-specs.company-information.service.gov.uk/streaming-api/guides/overview
// Company data only: charge holders are kept only when they are organisations; insolvency practitioners and every
// people stream (officers, PSCs) are never read.

const HOST = 'https://stream.companieshouse.gov.uk';
const ORG = /\b(limited|ltd|plc|llp|bank|banking|finance|financial|capital|lending|leasing|credit|trust|trustees|fund|funding|holdings|group|corporation|corp|inc|llc|gmbh|s\.?a\.?|n\.?v\.?|b\.?v\.?|ag|partners|council|authority|society|association|ministers)\b/i;
const SECTION = Object.fromEntries([['A', 1, 3], ['B', 5, 9], ['C', 10, 33], ['D', 35, 35], ['E', 36, 39], ['F', 41, 43],
  ['G', 45, 47], ['H', 49, 53], ['I', 55, 56], ['J', 58, 63], ['K', 64, 66], ['L', 68, 68], ['M', 69, 75], ['N', 77, 82],
  ['O', 84, 84], ['P', 85, 85], ['Q', 86, 88], ['R', 90, 93], ['S', 94, 96], ['T', 97, 98], ['U', 99, 99]]
  .flatMap(([s, lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => [String(lo + i).padStart(2, '0'), s])));

const BUDGET_MS = 240_000;  // per stream per run
const IDLE_MS = 30_000;     // no event for this long means we have caught up

export async function runStreams(env) {
  if (!env.CH_STREAM_KEY) return { skipped: 'no CH_STREAM_KEY' };
  // Two at a time: charges and insolvency together, then company profiles.
  const first = await Promise.allSettled([read('charges', env, chargeRows), read('insolvency-cases', env, insolvencyRows)]);
  const second = await Promise.allSettled([read('companies', env, companyRows)]);
  const names = ['charges', 'insolvency-cases', 'companies'];
  const results = [...first, ...second].map((r, i) => r.status === 'fulfilled' ? r.value : { stream: names[i], error: String(r.reason) });
  // One row per stream per run, so any run can be checked later (kept 14 days).
  await env.DB.batch([
    ...results.map(r => env.DB.prepare(
      `INSERT INTO stream_runs (run_at, stream, status, events, timepoint, note) VALUES (datetime('now'), ?, ?, ?, ?, ?)`)
      .bind(r.stream || null, r.status ?? (r.error ? 0 : 200), r.events ?? 0, r.timepoint ?? null, (r.error || r.note || '').slice(0, 300))),
    env.DB.prepare(`DELETE FROM stream_runs WHERE run_at < datetime('now', '-14 days')`),
  ]);
  return results;
}

async function read(stream, env, toStatements) {
  const state = await env.DB.prepare('SELECT timepoint FROM stream_state WHERE stream = ?').bind(stream).first();
  const url = `${env.CH_STREAM_HOST || HOST}/${stream}` + (state?.timepoint ? `?timepoint=${state.timepoint}` : '');
  const controller = new AbortController();
  const started = Date.now();
  const res = await fetch(url, { headers: { Authorization: 'Basic ' + btoa(env.CH_STREAM_KEY + ':') }, signal: controller.signal });
  if (res.status === 429) return { stream, status: 429, note: 'rate limited; next run in 10 minutes' };
  if (res.status === 416) {  // timepoint too old: start again from now
    await env.DB.prepare('DELETE FROM stream_state WHERE stream = ?').bind(stream).run();
    return { stream, status: 416, note: 'timepoint too old; restarting from now' };
  }
  if (!res.ok) return { stream, status: res.status, note: (await res.text()).slice(0, 200) };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', events = 0, lastEvent = Date.now(), timepoint = state?.timepoint || null, published = null;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const stmts = pending.flatMap(e => toStatements(e, env.DB));
    if (timepoint) stmts.push(env.DB.prepare(
      `INSERT INTO stream_state (stream, timepoint, published_at, updated_at, events) VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT (stream) DO UPDATE SET timepoint = excluded.timepoint, published_at = excluded.published_at,
       updated_at = excluded.updated_at, events = stream_state.events + ?`).bind(stream, timepoint, published, pending.length, pending.length));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    pending = [];
  };
  try {
    const budget = Number(env.STREAM_BUDGET_MS) || BUDGET_MS, idle = Number(env.STREAM_IDLE_MS) || IDLE_MS;  // overrides for tests
    while (Date.now() - started < budget) {
      const wait = Math.max(1, idle - (Date.now() - lastEvent));
      const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ idle: true }), wait))]);
      if (chunk.idle) { if (Date.now() - lastEvent >= idle) break; continue; }
      if (chunk.done) break;
      buf += chunk.value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;  // heartbeat
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        events++; lastEvent = Date.now();
        timepoint = e.event?.timepoint ?? timepoint;
        published = e.event?.published_at ?? published;
        pending.push(e);
        if (pending.length >= 200) await flush();
      }
    }
    await flush();
  } finally {
    controller.abort();
  }
  return { stream, status: 200, events, timepoint, published_at: published };
}

const companyFrom = uri => (uri?.match(/\/company\/([A-Z0-9]{8})/i) || [])[1]?.toUpperCase() || null;

function chargeRows(e, db) {
  const number = companyFrom(e.resource_uri);
  const id = e.resource_id || e.data?.id;
  if (!number || !id) return [];
  if (e.event?.type === 'deleted') return [db.prepare('DELETE FROM charges WHERE charge_id = ?').bind(id)];
  const d = e.data || {};
  const names = (d.persons_entitled || []).map(p => (p.name || '').trim()).filter(Boolean);
  const cls = [].concat(d.classification || []);  // an object in the charges resource; accept a list too
  const kind = cls.map(c => c?.description).filter(Boolean)[0] || null;
  return [db.prepare(
    `INSERT INTO charges (charge_id, company_number, status, created_on, delivered_on, satisfied_on, kind, holders,
       holders_not_listed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (charge_id) DO UPDATE SET status = excluded.status, delivered_on = excluded.delivered_on,
       satisfied_on = excluded.satisfied_on, kind = excluded.kind, holders = excluded.holders,
       holders_not_listed = excluded.holders_not_listed, updated_at = excluded.updated_at`).bind(
    id, number, d.status || null, d.created_on || null, d.delivered_on || null, d.satisfied_on || null, kind,
    JSON.stringify(names.filter(n => ORG.test(n))), names.filter(n => !ORG.test(n)).length, e.event?.published_at || null)];
}

function insolvencyRows(e, db) {
  const number = companyFrom(e.resource_uri) || (/^[A-Z0-9]{8}$/i.test(e.resource_id || '') ? e.resource_id.toUpperCase() : null);
  if (!number) return [];
  if (e.event?.type === 'deleted') return [db.prepare('DELETE FROM insolvency_cases WHERE company_number = ?').bind(number)];
  const d = e.data || {};
  // Case type, number and dates only: practitioners' names and addresses are never kept.
  const cases = (d.cases || []).map(c => ({ type: c.type || null, number: c.number || null,
    dates: Object.fromEntries((c.dates || []).filter(x => x.type && x.date).map(x => [x.type, x.date])) }));
  return [db.prepare(
    `INSERT INTO insolvency_cases (company_number, status, cases, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (company_number) DO UPDATE SET status = excluded.status, cases = excluded.cases, updated_at = excluded.updated_at`)
    .bind(number, d.status || null, JSON.stringify(cases), e.event?.published_at || null)];
}

function companyRows(e, db) {
  const number = (e.resource_id || '').toUpperCase() || companyFrom(e.resource_uri);
  if (!/^[A-Z0-9]{8}$/.test(number) || e.event?.type === 'deleted' || !e.data?.company_name) return [];
  const d = e.data;
  const sic = (d.sic_codes || []).find(c => /^\d{5}$/.test(c) && c !== '99999') || null;
  const div = sic ? sic.slice(0, 2) : null;
  const pc = (d.registered_office_address?.postal_code || '').toUpperCase();
  const name = d.company_name.trim();
  // Status words as in the monthly file (e.g. "Active"); the stream uses lower-case slugs.
  const status = d.company_status ? d.company_status.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()) : null;
  return [db.prepare(
    `INSERT INTO register (number, name, name_norm, status, sic_code, division, section, postcode_area, incorporated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (number) DO UPDATE SET name = excluded.name, name_norm = excluded.name_norm, status = excluded.status,
       sic_code = excluded.sic_code, division = excluded.division, section = excluded.section,
       postcode_area = excluded.postcode_area, incorporated = COALESCE(excluded.incorporated, register.incorporated)`).bind(
    number, name, name.toUpperCase().replace(/[^A-Z0-9]/g, ''), status, sic, div, div ? SECTION[div] || null : null,
    (pc.match(/^([A-Z]{1,2})\d/) || [])[1] || null, d.date_of_creation || null)];
}
