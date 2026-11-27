// The data shape check for the Phillips. admin (Lewis, 27 Nov 2026: "Fix data shape check, every dashboard should have
// one too"; the same idea as Before You Pay's System health card). It counts the saved rows whose key fields are not in
// the shape the code reads, so a bad save shows up here before it breaks a page. Settings in /admin shows the result.
//
// What it reads, and why these fields:
//   Prospects (R2 admin/pipeline.json, the saved cards of the sales funnel, edited in /admin#prospects):
//     id      d_ and 16 hex: the board, the search and links open a card by it
//     name    not empty: it is the card's title
//     stage   one of the seven board stages: any other value quietly puts the card in Lead
//     values  a list of fees, each with an amount in figures: the board and Overview add them up, and text there stops
//             the board drawing
//     nextDate  empty or a real date (YYYY-MM-DD): Needs attention and the due counts read it
//     email   empty or an address: Follow up writes to it
//     lists   comments, files and history are lists: the card's drawer goes through each one
//   Accounts (D1 phillips-accounts, table accounts; visitors' accounts on the free tools):
//     email       lower case and an address: sign-in looks an address up in lower case, so any other spelling can't be
//                 signed in to and a second account gets made
//     created_at  a date and time: the account page shows it as "since"
//   Saved checks (D1 phillips-accounts, table checks; the checks kept with an account):
//     scores      empty, or JSON for a list of { id, score }: /account/me reads every row with JSON.parse, so one bad row
//                 stops that person's whole account page
//     tool        website or ads: the account page links a check by it
//     checked_at  a date and time: the list is sorted by it
//
// D1 stops a query after 30 seconds, so a table is never read in one query: it is read in pieces of 500 rows by rowid
// (each piece reads only its own rows), and a piece that fails is tried again at half the size, down to 25 rows, before
// that table is marked "Not checked" with the reason. A table that was not read to the end gets no counts at all, so it
// can never read as a pass. Free tier only: a few reads of D1 and one read and one write of R2 a run.
//
// Runs every day at 05:15 UTC (the Worker's daily cron, worker.js) and when Lewis presses "Check now" in Settings.
// The result is kept in R2 at admin/health/shape.json with the time it ran.
import { STAGES } from './pipeline-core.mjs';

export const SHAPE_KEY = 'admin/health/shape.json';
const PIECE = 500, MIN_PIECE = 25;
const MAX_CALLS = 800;            // D1 allows 1,000 queries in one Worker run; leave room for the rest of the run
const EXAMPLES = 20;              // examples kept per field
const D1_PAGE = 'https://dash.cloudflare.com/9cd423eee8986ecc6f22f6fa3a17878b/workers/d1';   // D1 SQL database, then phillips-accounts, Console

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;        // the funnel's own test (pipeline.js cleanFields)
const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i; // the accounts' own test (accounts.js validEmail)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const kind = v => v === null ? 'empty' : Array.isArray(v) ? 'a list' : typeof v === 'string' ? 'text' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'yes/no' : typeof v === 'object' ? 'an object' : 'missing';
const quote = v => '"' + String(v).replace(/\s+/g, ' ').slice(0, 40) + (String(v).length > 40 ? '…' : '') + '"';
const realDate = s => { const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
const time = s => typeof s === 'string' && ISO.test(s) && !isNaN(Date.parse(s));

// Each rule returns null when the value has the expected shape, or a few words on what it is instead.
const PROSPECT_FIELDS = [
  { field: 'id', label: 'Card ID', expect: 'd_ and 16 letters or figures', test: d => typeof d.id === 'string' && /^d_[a-f0-9]{16}$/.test(d.id) ? null : d.id == null ? 'missing' : quote(d.id) },
  { field: 'name', label: 'Name', expect: 'the company or person', test: d => typeof d.name === 'string' && d.name.trim() ? null : d.name == null || d.name === '' ? 'empty' : kind(d.name) },
  { field: 'stage', label: 'Stage', expect: 'one of the seven stages on the board', test: d => typeof d.stage === 'string' && STAGES.some(s => s.toLowerCase() === d.stage.trim().toLowerCase()) ? null : d.stage == null ? 'missing' : typeof d.stage === 'string' ? quote(d.stage) : kind(d.stage) },
  { field: 'values', label: 'Fees', expect: 'a list of fees, amounts as numbers', test: d => {
    if (d.values == null) return null;
    if (!Array.isArray(d.values)) return kind(d.values);
    const bad = d.values.find(v => !v || typeof v !== 'object' || Array.isArray(v) || typeof v.amount !== 'number' || !isFinite(v.amount));
    return bad === undefined ? null : !bad || typeof bad !== 'object' ? 'a fee saved as ' + kind(bad) : bad.amount == null ? 'amount missing' : 'amount saved as ' + kind(bad.amount);
  } },
  { field: 'nextDate', label: 'Next step date', expect: 'empty or a date', test: d => d.nextDate == null || d.nextDate === '' || (typeof d.nextDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.nextDate) && realDate(d.nextDate)) ? null : typeof d.nextDate === 'string' ? quote(d.nextDate) : kind(d.nextDate) },
  { field: 'email', label: 'Email', expect: 'empty or an email address', test: d => d.email == null || d.email === '' || (typeof d.email === 'string' && EMAIL.test(d.email)) ? null : typeof d.email === 'string' ? quote(d.email) : kind(d.email) },
  { field: 'lists', label: 'Comments, files, history', expect: 'each a list', test: d => {
    const bad = ['comments', 'files', 'history'].find(k => d[k] != null && !Array.isArray(d[k]));
    return bad ? bad + ' is ' + kind(d[bad]) : null;
  } },
];
const ACCOUNT_FIELDS = [
  { field: 'email', label: 'Email', expect: 'a lower-case email address', test: r => typeof r.email !== 'string' || !r.email ? 'empty' : r.email !== r.email.trim().toLowerCase() ? 'has capitals or spaces' : ACCOUNT_EMAIL.test(r.email) ? null : 'not an email address' },
  { field: 'created_at', label: 'Created', expect: 'a date and time', test: r => time(r.created_at) ? null : r.created_at == null ? 'empty' : quote(r.created_at) },
];
const CHECK_FIELDS = [
  { field: 'scores', label: 'Scores', expect: 'empty, or a list of area scores', test: r => {
    if (r.scores == null) return null;
    let v; try { v = JSON.parse(r.scores); } catch { return 'not JSON'; }
    if (v === null) return null;
    if (!Array.isArray(v)) return kind(v);
    return v.every(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && (x.score === null || (typeof x.score === 'number' && isFinite(x.score)))) ? null : 'a list with an odd score';
  } },
  { field: 'tool', label: 'Tool', expect: 'website or ads', test: r => r.tool === 'website' || r.tool === 'ads' ? null : r.tool == null ? 'empty' : quote(r.tool) },
  { field: 'checked_at', label: 'Checked', expect: 'a date and time', test: r => time(r.checked_at) ? null : r.checked_at == null ? 'empty' : quote(r.checked_at) },
];

export const TABLES = [
  { key: 'prospects', label: 'Prospects', where: 'Saved cards in the funnel (R2)', unit: ['card', 'cards'], fields: PROSPECT_FIELDS },
  { key: 'accounts', label: 'Accounts', where: 'Visitors’ accounts (D1)', unit: ['account', 'accounts'], fields: ACCOUNT_FIELDS,
    table: 'accounts', cols: 'id, email, created_at', name: r => r.email || 'Account ' + String(r.id || '').slice(0, 8), ref: r => 'ID ' + String(r.id || '').slice(0, 8) },
  { key: 'checks', label: 'Saved checks', where: 'Checks kept with an account (D1)', unit: ['check', 'checks'], fields: CHECK_FIELDS,
    table: 'checks', cols: 'id, account_id, tool, domain, checked_at, scores', name: r => (r.domain || 'A check') + (r.tool === 'website' || r.tool === 'ads' ? ' (' + r.tool + ')' : ''), ref: r => 'ID ' + String(r.id || '').slice(0, 8) },
];

function tally(fields) {
  return fields.map(f => ({ field: f.field, label: f.label, expect: f.expect, count: 0, examples: [] }));
}
function look(t, out, row, example) {
  t.fields.forEach((f, i) => {
    let found; try { found = f.test(row); } catch { found = 'unreadable'; }
    if (found == null) return;
    out[i].count++;
    if (out[i].examples.length < EXAMPLES) out[i].examples.push({ ...example(), found });
  });
}
const notChecked = (reason, rows) => ({ checked: false, reason, rowsRead: rows || 0 });

// The funnel's saved cards: one R2 object (up to 2,000 cards), read once.
async function scanProspects(env, t) {
  let obj;
  try { obj = await env.BLOBS.get('admin/pipeline.json'); } catch (err) { return notChecked('the saved funnel could not be read (' + String(err && err.message || err).slice(0, 80) + ')'); }
  if (!obj) return { checked: true, rows: 0, fields: tally(t.fields) };
  let data; try { data = await obj.json(); } catch { data = null; }
  if (!data || !Array.isArray(data.deals)) return notChecked('the saved funnel can’t be read, so no cards were checked');
  const out = tally(t.fields);
  for (const d of data.deals) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) { out[0].count++; if (out[0].examples.length < EXAMPLES) out[0].examples.push({ id: '', name: 'A card that is ' + kind(d), found: kind(d), href: '#prospects' }); continue; }
    const ok = typeof d.id === 'string' && /^d_[a-f0-9]{16}$/.test(d.id);
    look(t, out, d, () => ({ id: ok ? d.id : '', name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 80) : 'A card with no name', href: ok ? '#prospects/' + d.id : '#prospects' }));
  }
  return { checked: true, rows: data.deals.length, fields: out };
}

// A D1 table, a piece at a time by rowid, halving a piece that fails.
async function scanD1(env, t, run) {
  const db = env.ACCOUNTS_DB;
  if (!db) return notChecked('the accounts database is not connected here');
  const out = tally(t.fields);
  let after = 0, size = PIECE, rows = 0;
  for (;;) {
    if (Date.now() > run.until) return notChecked(`it ran out of time after ${rows.toLocaleString('en-GB')} rows`, rows);
    if (run.calls >= MAX_CALLS) return notChecked(`it reached the query limit for one run after ${rows.toLocaleString('en-GB')} rows`, rows);
    let list;
    run.calls++;
    try {
      const res = await db.prepare(`SELECT rowid AS rid, ${t.cols} FROM ${t.table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`).bind(after, size).all();
      list = (res && res.results) || [];
    } catch (err) {
      if (size > MIN_PIECE) { size = Math.max(MIN_PIECE, Math.floor(size / 2)); continue; }   // the same place again, smaller
      return notChecked(`the read failed after ${rows.toLocaleString('en-GB')} rows, even in small pieces (${String(err && err.message || err).replace(/^D1_ERROR:\s*/, '').slice(0, 80)})`, rows);
    }
    for (const r of list) look(t, out, r, () => ({ id: String(r.id || ''), name: t.name(r).slice(0, 80), ref: t.ref(r), href: D1_PAGE }));
    rows += list.length;
    if (list.length < size) break;
    after = list[list.length - 1].rid;
    if (size < PIECE) size = Math.min(PIECE, size * 2);   // back to the normal size after a slow patch
  }
  return { checked: true, rows, fields: out };
}

// Runs the check on every table, keeps it in R2 and returns it. budgetMs: the time it may take in all.
export async function runShapeCheck(env, { by = 'daily', budgetMs = 5 * 60 * 1000 } = {}) {
  const started = Date.now(), run = { until: started + budgetMs, calls: 0 };
  let before = null;
  try { before = await getShapeCheck(env); } catch { /* none yet */ }
  const tables = [];
  for (const t of TABLES) {
    let r;
    try { r = t.table ? await scanD1(env, t, run) : await scanProspects(env, t); }
    catch (err) { r = notChecked('the check failed (' + String(err && err.message || err).slice(0, 80) + ')'); }
    const at = new Date().toISOString();
    const row = { key: t.key, label: t.label, where: t.where, unit: t.unit, ...r };
    if (r.checked) { row.checkedAt = at; row.odd = r.fields.reduce((a, f) => a + f.count, 0); }
    else {
      // the last full result for this table, kept with its time; never shown as this run's pass
      const prev = before && (before.tables || []).find(x => x.key === t.key);
      const last = prev && (prev.checked ? { checkedAt: prev.checkedAt, odd: prev.odd, rows: prev.rows } : prev.last);
      if (last) row.last = last;
    }
    tables.push(row);
  }
  const result = { ranAt: new Date().toISOString(), by, ms: Date.now() - started, calls: run.calls, tables };
  await env.BLOBS.put(SHAPE_KEY, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
  return result;
}

export async function getShapeCheck(env) {
  const obj = await env.BLOBS.get(SHAPE_KEY);
  return obj ? obj.json() : null;
}
