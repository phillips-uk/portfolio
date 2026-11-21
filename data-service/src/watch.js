// Insolvency watch: each client keeps a list of companies and hears about changes to them.
//
//   GET    /v1/watch                     the client's list
//   POST   /v1/watch                     { companies: [{ number, label? }] } or { numbers: [...] }: add (max 500 a call)
//   DELETE /v1/watch/{number}            remove one
//   GET    /v1/watch/changes?since=YYYY-MM-DD   changes to the client's companies, newest first (200 at most)
//
// Changes are found every 10 minutes from data we already hold, so watching costs no Companies House calls after the
// first one per company (the starting point): Gazette notices (nightly), insolvency cases and charges (stream), status
// (register, kept current by the companies stream), overdue filing (companies stream, watched companies only) and new
// accounts (daily accounts files). Each change is stored once per company, whoever watches it. A morning digest goes
// to each client's alert_email at 07:30 UTC through Resend, when RESEND_API_KEY is set. Company data only.
import { ukDate, money } from './signals.js';

const API = 'https://api.company-information.service.gov.uk';
const MAX_ADD = 500;
const SEED_PER_RUN = 50;
const STATUS_WORDS = s => (s || '').toLowerCase().replace(/^in /, '').replace(/[^a-z]/g, '');
const pct = (now, before) => before ? Math.round(((now - before) / Math.abs(before)) * 100) : null;

// ---------- API ----------
export async function watchApi(request, path, url, client, env, json) {
  const one = path.match(/^\/v1\/watch\/([A-Za-z0-9]{8})$/);
  if (path === '/v1/watch' && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT w.company_number AS number, r.name, COALESCE(f.status, r.status) AS status, w.label, w.added_at, s.seeded_at IS NOT NULL AS watching
       FROM watch_lists w LEFT JOIN register r ON r.number = w.company_number LEFT JOIN company_flags f ON f.number = w.company_number
       LEFT JOIN watch_state s ON s.company_number = w.company_number
       WHERE w.client_id = ? ORDER BY r.name`).bind(client.id).all();
    return json({ companies: results.map(r => ({ ...r, watching: !!r.watching })), total: results.length, limit: client.watch_limit });
  }
  if (path === '/v1/watch' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const wanted = (Array.isArray(body?.companies) ? body.companies : (body?.numbers || []).map(n => ({ number: n })))
      .map(c => ({ number: String(c?.number || '').trim().toUpperCase(), label: c?.label ? String(c.label).slice(0, 80) : null }));
    if (!wanted.length) return json({ error: 'no_companies' }, 400);
    if (wanted.length > MAX_ADD) return json({ error: 'too_many', max_per_request: MAX_ADD }, 400);
    const bad = wanted.filter(c => !/^[A-Z0-9]{8}$/.test(c.number)).map(c => c.number);
    const good = wanted.filter(c => /^[A-Z0-9]{8}$/.test(c.number));
    const known = new Set();
    for (let i = 0; i < good.length; i += 90) {
      const part = good.slice(i, i + 90);
      const { results } = await env.DB.prepare(`SELECT number FROM register WHERE number IN (${part.map(() => '?').join(',')})`)
        .bind(...part.map(c => c.number)).all();
      results.forEach(r => known.add(r.number));
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM watch_lists WHERE client_id = ?').bind(client.id).first('n');
    const adding = good.filter(c => known.has(c.number));
    const existing = new Set((await Promise.all(chunks(adding, 90).map(part => env.DB.prepare(
      `SELECT company_number FROM watch_lists WHERE client_id = ? AND company_number IN (${part.map(() => '?').join(',')})`)
      .bind(client.id, ...part.map(c => c.number)).all()))).flatMap(r => r.results.map(x => x.company_number)));
    const fresh = adding.filter(c => !existing.has(c.number));
    if (count + fresh.length > client.watch_limit) return json({ error: 'watch_limit', limit: client.watch_limit, total: count }, 409);
    const now = new Date().toISOString();
    const stmts = adding.flatMap(c => [
      env.DB.prepare(`INSERT INTO watch_lists (client_id, company_number, label, added_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (client_id, company_number) DO UPDATE SET label = COALESCE(excluded.label, watch_lists.label)`).bind(client.id, c.number, c.label, now),
      env.DB.prepare('INSERT OR IGNORE INTO watch_state (company_number) VALUES (?)').bind(c.number),
    ]);
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ added: fresh.length, already_watched: adding.length - fresh.length,
      not_found: [...good.filter(c => !known.has(c.number)).map(c => c.number), ...bad], total: count + fresh.length,
      limit: client.watch_limit, note: 'New companies start being watched within 10 minutes.' });
  }
  if (one && request.method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM watch_lists WHERE client_id = ? AND company_number = ?').bind(client.id, one[1].toUpperCase()).run();
    return json({ removed: r.meta.changes });
  }
  if (path === '/v1/watch/changes' && request.method === 'GET') {
    const since = url.searchParams.get('since') || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return json({ error: 'bad_since' }, 400);
    const { results } = await env.DB.prepare(
      `SELECT e.company_number AS number, r.name, w.label, e.kind, e.notable, e.text, e.date, e.url, e.found_at
       FROM watch_events e JOIN watch_lists w ON w.company_number = e.company_number AND w.client_id = ?
       LEFT JOIN register r ON r.number = e.company_number
       WHERE e.found_at >= ? AND e.found_at >= w.added_at ORDER BY e.found_at DESC, e.id DESC LIMIT 200`).bind(client.id, since).all();
    return json({ since, changes: results.map(r => ({ ...r, notable: !!r.notable })),
      source: 'Companies House; The Gazette', licence: 'Contains public sector information licensed under the Open Government Licence v3.0' });
  }
  return json({ error: 'not_found' }, 404);
}

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------- Starting points: one Companies House profile call per newly watched company ----------
export async function seedWatch(env) {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO watch_state (company_number) SELECT DISTINCT company_number FROM watch_lists'),
    env.DB.prepare('DELETE FROM watch_state WHERE company_number NOT IN (SELECT company_number FROM watch_lists)'),
    env.DB.prepare('DELETE FROM company_flags WHERE number NOT IN (SELECT company_number FROM watch_lists)'),
  ]);
  if (!env.CH_API_KEY) return { seeded: 0 };
  const { results } = await env.DB.prepare('SELECT company_number FROM watch_state WHERE seeded_at IS NULL LIMIT ?').bind(SEED_PER_RUN).all();
  const auth = 'Basic ' + btoa(env.CH_API_KEY + ':');
  let seeded = 0;
  for (const { company_number: n } of results) {
    const r = await fetch(`${API}/company/${n}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (r.status === 429) break;
    const now = new Date().toISOString();
    if (r.status === 404) {  // not at Companies House: stop trying, nothing to watch
      await env.DB.prepare('UPDATE watch_state SET seeded_at = ?, status = ? WHERE company_number = ?').bind(now, 'Not found', n).run();
      continue;
    }
    if (!r.ok) continue;
    const p = await r.json();
    const status = p.company_status_detail === 'active-proposal-to-strike-off' ? 'Active - Proposal to Strike off'
      : (p.company_status || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
    const ao = p.accounts?.overdue ? 1 : 0, co = p.confirmation_statement?.overdue ? 1 : 0;
    await env.DB.batch([
      env.DB.prepare('UPDATE watch_state SET seeded_at = ?, status = ?, accounts_overdue = ?, cs_overdue = ?, checked_at = ? WHERE company_number = ?')
        .bind(now, status, ao, co, now, n),
      env.DB.prepare(`INSERT INTO company_flags (number, accounts_overdue, cs_overdue, next_accounts_due, next_cs_due, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (number) DO UPDATE SET accounts_overdue = excluded.accounts_overdue,
        cs_overdue = excluded.cs_overdue, next_accounts_due = excluded.next_accounts_due, next_cs_due = excluded.next_cs_due,
        updated_at = excluded.updated_at, status = excluded.status`).bind(n, ao, co, p.accounts?.next_due || null, p.confirmation_statement?.next_due || null, now, status),
    ]);
    seeded++;
  }
  return { seeded };
}

// ---------- Finding changes (every 10 minutes) ----------
export async function detectChanges(env) {
  const now = new Date().toISOString();
  const S = `JOIN watch_state s ON s.company_number = x.company_number AND s.seeded_at IS NOT NULL`;
  const [notices, cases, charges, status, flags, accounts] = await Promise.all([
    env.DB.prepare(`SELECT x.notice_id, x.company_number, x.notice_type, x.published FROM insolvency_notices x ${S}
      WHERE x.published >= substr(s.seeded_at, 1, 10)`).all(),
    env.DB.prepare(`SELECT x.company_number, x.status, x.cases, x.updated_at FROM insolvency_cases x ${S}
      WHERE x.updated_at >= s.seeded_at`).all(),
    env.DB.prepare(`SELECT x.charge_id, x.company_number, x.status, x.created_on, x.satisfied_on, x.holders, x.holders_not_listed, x.updated_at
      FROM charges x ${S} WHERE x.updated_at >= s.seeded_at`).all(),
    env.DB.prepare(`SELECT s.company_number, s.status AS old, f.status AS new FROM watch_state s
      JOIN company_flags f ON f.number = s.company_number WHERE s.seeded_at IS NOT NULL AND f.status IS NOT NULL AND s.status != 'Not found'`).all(),
    env.DB.prepare(`SELECT f.number AS company_number, f.accounts_overdue, f.cs_overdue, f.next_accounts_due, f.next_cs_due,
      s.accounts_overdue AS a0, s.cs_overdue AS c0 FROM company_flags f JOIN watch_state s ON s.company_number = f.number
      WHERE s.seeded_at IS NOT NULL`).all(),
    env.DB.prepare(`SELECT x.company_number, x.period_end, x.turnover, x.cash, x.net_assets, x.prior_turnover, x.prior_cash,
      x.prior_net_assets FROM accounts_facts x ${S}
      WHERE x.source_file LIKE 'Accounts_Bulk_Data-%' AND substr(x.source_file, -14, 10) >= substr(s.seeded_at, 1, 10)`).all(),
  ]);

  const ev = [];
  const add = (company_number, kind, ref, notable, text, date, url = null) => ev.push({ company_number, kind, ref, notable, text, date, url });
  for (const n of notices.results)
    add(n.company_number, 'gazette', n.notice_id, 1, `${n.notice_type} published in The Gazette`, n.published, `https://www.thegazette.co.uk/notice/${n.notice_id}`);
  for (const c of cases.results) {
    const list = JSON.parse(c.cases || '[]');
    const latest = list.map(k => ({ type: k.type, date: Object.values(k.dates || {}).sort().pop() })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const type = (latest?.type || 'insolvency case').replace(/-/g, ' ');
    add(c.company_number, 'case', c.updated_at, 1, `Insolvency case recorded at Companies House: ${type}`, latest?.date || c.updated_at.slice(0, 10));
  }
  for (const c of charges.results) {
    const holders = JSON.parse(c.holders || '[]');
    const who = holders.length ? `, held by ${holders.slice(0, 2).join(' and ')}${holders.length > 2 ? ' and others' : ''}`
      : c.holders_not_listed ? ', held by a private individual' : '';
    if (c.satisfied_on) add(c.company_number, 'charge', `${c.charge_id}:satisfied`, 0, `Charge satisfied${who}`, c.satisfied_on);
    else if (c.created_on) add(c.company_number, 'charge', `${c.charge_id}:created`, 1, `New charge registered${who}`, c.created_on);
  }
  const statusUpdates = [];
  for (const r of status.results) {
    if (!r.old) { statusUpdates.push([r.new, r.company_number]); continue; }
    if (STATUS_WORDS(r.old) === STATUS_WORDS(r.new)) continue;
    add(r.company_number, 'status', `${STATUS_WORDS(r.new)}:${now.slice(0, 10)}`, /^active$/i.test(r.new) ? 0 : 1,
      `Status changed from ${r.old} to ${r.new}`, now.slice(0, 10));
    statusUpdates.push([r.new, r.company_number]);
  }
  const flagUpdates = [];
  for (const f of flags.results) {
    if (f.accounts_overdue && !f.a0) add(f.company_number, 'filing', `accounts:${f.next_accounts_due}`, 1, `Accounts now overdue (were due ${ukDate(f.next_accounts_due)})`, f.next_accounts_due);
    if (f.cs_overdue && !f.c0) add(f.company_number, 'filing', `cs:${f.next_cs_due}`, 1, `Confirmation statement now overdue (was due ${ukDate(f.next_cs_due)})`, f.next_cs_due);
    if (f.accounts_overdue !== f.a0 || f.cs_overdue !== f.c0) flagUpdates.push([f.accounts_overdue, f.cs_overdue, f.company_number]);
  }
  for (const a of accounts.results) {
    const bits = [];
    let notable = 0;
    if (a.net_assets !== null && a.net_assets < 0) { bits.push(`net liabilities of ${money(-a.net_assets)}`); notable = 1; }
    for (const [label, now_, before, limit] of [['turnover', a.turnover, a.prior_turnover, -25], ['net assets', a.net_assets, a.prior_net_assets, -25], ['cash', a.cash, a.prior_cash, -50]]) {
      const ch = now_ !== null && before !== null && Math.abs(before) >= 10000 ? pct(now_, before) : null;
      if (ch !== null && ch <= limit && !(label === 'net assets' && a.net_assets < 0)) { bits.push(`${label} down ${Math.abs(ch)}% to ${money(now_)}`); notable = 1; }
    }
    add(a.company_number, 'accounts', a.period_end, notable, `New accounts to ${ukDate(a.period_end)} filed${bits.length ? ': ' + bits.join(', ') : ''}`, a.period_end);
  }

  const stmts = [
    ...ev.map(e => env.DB.prepare(`INSERT OR IGNORE INTO watch_events (company_number, kind, ref, notable, text, date, url, found_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(e.company_number, e.kind, String(e.ref), e.notable, e.text, e.date, e.url, now)),
    ...statusUpdates.map(([s, n]) => env.DB.prepare('UPDATE watch_state SET status = ? WHERE company_number = ?').bind(s, n)),
    ...flagUpdates.map(([a, c, n]) => env.DB.prepare('UPDATE watch_state SET accounts_overdue = ?, cs_overdue = ? WHERE company_number = ?').bind(a, c, n)),
    env.DB.prepare('UPDATE watch_state SET checked_at = ? WHERE seeded_at IS NOT NULL').bind(now),
  ];
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    inserted += res.reduce((t, r, j) => t + (i + j < ev.length ? r.meta?.changes || 0 : 0), 0);
  }
  return { candidates: ev.length, new_events: inserted };
}

// ---------- Morning digest (07:30 UTC) ----------
export async function sendDigests(env) {
  const { results: clients } = await env.DB.prepare(
    `SELECT id, name, alert_email FROM clients WHERE status = 'active' AND alert_email IS NOT NULL AND scopes LIKE '%"watch"%'`).all();
  const out = [];
  for (const c of clients) {
    const last = await env.DB.prepare('SELECT MAX(last_event_id) AS id FROM watch_digests WHERE client_id = ?').bind(c.id).first('id') || 0;
    const { results: events } = await env.DB.prepare(
      `SELECT e.id, e.company_number, r.name, w.label, e.notable, e.text, e.date, e.url FROM watch_events e
       JOIN watch_lists w ON w.company_number = e.company_number AND w.client_id = ?
       LEFT JOIN register r ON r.number = e.company_number
       WHERE e.id > ? AND e.found_at >= w.added_at ORDER BY r.name, e.date DESC`).bind(c.id, last).all();
    if (!events.length) { out.push({ client: c.id, events: 0 }); continue; }
    if (!env.RESEND_API_KEY) { out.push({ client: c.id, events: events.length, sent: false, note: 'no RESEND_API_KEY' }); continue; }
    const { subject, html, text } = digestEmail(c, events);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ALERT_FROM || 'Phillips. data <alerts@phillips-uk.com>', to: [c.alert_email], subject, html, text }),
    });
    if (!r.ok) { out.push({ client: c.id, events: events.length, sent: false, status: r.status }); continue; }
    await env.DB.prepare('INSERT INTO watch_digests (client_id, sent_at, last_event_id, events) VALUES (?, ?, ?, ?)')
      .bind(c.id, new Date().toISOString(), Math.max(...events.map(e => e.id)), events.length).run();
    out.push({ client: c.id, events: events.length, sent: true });
  }
  return out;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function digestEmail(client, events) {
  const byCo = new Map();
  for (const e of events) {
    if (!byCo.has(e.company_number)) byCo.set(e.company_number, { name: e.name || e.company_number, label: e.label, items: [] });
    byCo.get(e.company_number).items.push(e);
  }
  const shown = [...byCo.entries()].slice(0, 40);
  const notable = events.filter(e => e.notable).length;
  const today = ukDate(new Date().toISOString().slice(0, 10));
  const subject = `Watch list, ${today}: ${events.length} change${events.length > 1 ? 's' : ''} for ${byCo.size} compan${byCo.size > 1 ? 'ies' : 'y'}`;
  const intro = `${events.length} change${events.length > 1 ? 's' : ''} since the last email${notable ? `, ${notable} worth a look` : ''}.`;
  const foot = 'From the Phillips. data service. Facts from public records (Companies House and The Gazette), each with its date: not a credit opinion. Contains public sector information licensed under the Open Government Licence v3.0.';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F6F4EE;font-family:Arial,Helvetica,sans-serif;color:#1d2329">
<div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:12px;padding:28px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6b6f73">Watch list for ${esc(client.name)}</p>
<h1 style="margin:0 0 8px;font-size:22px">${esc(today)}</h1><p style="margin:0 0 20px;color:#4a4f55">${esc(intro)}</p>
${shown.map(([n, co]) => `<div style="border-top:1px solid #e6e3da;padding:14px 0">
<p style="margin:0 0 6px;font-weight:bold">${esc(co.name)} <span style="font-weight:normal;color:#6b6f73;font-size:13px">${esc(n)}${co.label ? ' · ' + esc(co.label) : ''}</span></p>
${co.items.map(e => `<p style="margin:4px 0;font-size:14px;${e.notable ? 'font-weight:bold' : 'color:#4a4f55'}">${e.notable ? '&#9679; ' : ''}${esc(e.text)}${e.date ? ` <span style="font-weight:normal;color:#6b6f73">(${esc(ukDate(e.date))})</span>` : ''}${e.url ? ` <a href="${esc(e.url)}" style="color:#985830">Notice</a>` : ''}</p>`).join('')}
</div>`).join('')}
${byCo.size > shown.length ? `<p style="color:#4a4f55;font-size:14px">And ${byCo.size - shown.length} more companies: see your watch list.</p>` : ''}
<p style="margin:20px 0 0;font-size:12px;color:#6b6f73;line-height:1.5">${esc(foot)}</p></div></body></html>`;
  const text = [`Watch list for ${client.name}, ${today}`, intro, '',
    ...shown.flatMap(([n, co]) => [`${co.name} (${n}${co.label ? ', ' + co.label : ''})`,
      ...co.items.map(e => `  ${e.notable ? '* ' : '- '}${e.text}${e.date ? ` (${ukDate(e.date)})` : ''}${e.url ? ' ' + e.url : ''}`), '']),
    foot].join('\n');
  return { subject, html, text };
}
