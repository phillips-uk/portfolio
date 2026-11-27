// node cloudflare/test/shape-check.test.mjs
// The admin's data shape check (cloudflare/src/shape-check.js) against a made-up R2 and D1: counts, examples, reading in
// pieces, halving a piece that fails, and never a pass for a table that was not read to the end.
import assert from 'node:assert/strict';
import { runShapeCheck, getShapeCheck, SHAPE_KEY } from '../src/shape-check.js';

// R2: a Map of key -> text
function r2(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k) { if (!m.has(k)) return null; const v = m.get(k); return { json: async () => JSON.parse(v) }; },
    async put(k, v) { m.set(k, String(v)); return {}; },
  };
}
// D1: tables as arrays of rows (rowid = position + 1). refuse(size) makes a piece of that size fail.
function d1(tables, { refuse = () => false, log = [] } = {}) {
  return {
    log,
    prepare(sql) {
      const m = sql.match(/FROM (\w+) WHERE rowid > \?1 ORDER BY rowid LIMIT \?2/);
      return { bind: (after, size) => ({ all: async () => {
        log.push({ table: m[1], after, size });
        if (refuse(size, m[1])) throw new Error('D1_ERROR: query took too long');
        const rows = (tables[m[1]] || null);
        if (!rows) throw new Error('D1_ERROR: no such table: ' + m[1]);
        return { results: rows.map((r, i) => ({ rid: i + 1, ...r })).filter(r => r.rid > after).slice(0, size) };
      } }) };
    },
  };
}
const id = n => 'd_' + n.toString(16).padStart(16, '0');
const deal = (n, o = {}) => ({ id: id(n), name: 'Example ' + n, stage: 'Lead', values: [{ id: 'f1', label: 'Fee', amount: 100, basis: 'one-off' }], nextDate: '', email: '', comments: [], files: [], history: [], ...o });
const acct = (n, o = {}) => ({ id: 'a' + n, email: 'person' + n + '@example.com', created_at: '2026-11-22T10:00:00.000Z', ...o });
const check = (n, o = {}) => ({ id: 'c' + n, account_id: 'a1', tool: 'website', domain: 'example' + n + '.co.uk', checked_at: '2026-11-22T10:00:00.000Z', scores: '[{"id":"speed","score":82}]', ...o });
const byKey = (res, k) => res.tables.find(t => t.key === k);
const field = (t, f) => t.fields.find(x => x.field === f);

// 1. everything in shape: every table checked, nothing odd, kept in R2 with when it ran
{
  const BLOBS = r2({ 'admin/pipeline.json': JSON.stringify({ deals: [deal(1), deal(2, { stage: 'proposal sent', nextDate: '2026-12-01', email: 'a@example.com' })] }) });
  const ACCOUNTS_DB = d1({ accounts: [acct(1), acct(2)], checks: [check(1), check(2, { tool: 'ads', scores: null })] });
  const res = await runShapeCheck({ BLOBS, ACCOUNTS_DB });
  assert.ok(res.ranAt && res.tables.length === 3);
  for (const t of res.tables) { assert.equal(t.checked, true, t.key); assert.equal(t.odd, 0, t.key); assert.ok(t.checkedAt); }
  assert.equal(byKey(res, 'prospects').rows, 2);
  assert.equal(byKey(res, 'checks').rows, 2);
  assert.deepEqual(await getShapeCheck({ BLOBS }), res);
  assert.ok(BLOBS.m.has(SHAPE_KEY));
}

// 2. odd shapes are counted per field, with examples linked to where they're fixed
{
  const deals = [
    deal(1, { stage: 'Negotiating' }),
    deal(2, { values: 'five hundred' }),
    deal(3, { values: [{ label: 'Fee', amount: '500' }] }),
    deal(4, { nextDate: '2026-02-30' }),
    deal(5, { email: 'not an address' }),
    deal(6, { comments: 'call back' }),
    deal(7, { name: '' }),
    { ...deal(8), id: 'card-8' },
  ];
  const BLOBS = r2({ 'admin/pipeline.json': JSON.stringify({ deals }) });
  const ACCOUNTS_DB = d1({
    accounts: [acct(1, { email: 'Person@Example.com' }), acct(2, { email: 'nobody' }), acct(3, { created_at: 'yesterday' })],
    checks: [check(1, { scores: '{"speed":82}' }), check(2, { scores: 'not json' }), check(3, { scores: '"[]"' }), check(4, { tool: 'seo' }), check(5, { checked_at: '22/11/2026' })],
  });
  const res = await runShapeCheck({ BLOBS, ACCOUNTS_DB }, { by: 'now' });
  const p = byKey(res, 'prospects');
  assert.equal(p.checked, true);
  assert.equal(field(p, 'stage').count, 1);
  assert.deepEqual(field(p, 'stage').examples[0], { id: id(1), name: 'Example 1', href: '#prospects/' + id(1), found: '"Negotiating"' });
  assert.equal(field(p, 'values').count, 2);
  assert.equal(field(p, 'values').examples[0].found, 'text');
  assert.equal(field(p, 'values').examples[1].found, 'amount saved as text');
  assert.equal(field(p, 'nextDate').count, 1);
  assert.equal(field(p, 'email').count, 1);
  assert.equal(field(p, 'lists').examples[0].found, 'comments is text');
  assert.equal(field(p, 'name').count, 1);
  assert.equal(field(p, 'name').examples[0].name, 'A card with no name');
  assert.equal(field(p, 'id').count, 1);
  assert.equal(field(p, 'id').examples[0].href, '#prospects');   // a card the link can't open goes to the board
  assert.equal(p.odd, 8);   // stage 1, fees 2, date 1, email 1, lists 1, name 1, id 1
  const a = byKey(res, 'accounts');
  assert.equal(field(a, 'email').count, 2);
  assert.deepEqual(field(a, 'email').examples.map(x => x.found), ['has capitals or spaces', 'not an email address']);
  assert.equal(field(a, 'created_at').count, 1);
  assert.match(field(a, 'email').examples[0].href, /^https:\/\/dash\.cloudflare\.com\/.+\/workers\/d1$/);
  const c = byKey(res, 'checks');
  assert.deepEqual(field(c, 'scores').examples.map(x => x.found), ['an object', 'not JSON', 'text']);
  assert.equal(field(c, 'tool').count, 1);
  assert.equal(field(c, 'checked_at').count, 1);
  assert.equal(res.by, 'now');
}

// 3. at most 20 examples a field, but every odd row counted
{
  const BLOBS = r2({ 'admin/pipeline.json': JSON.stringify({ deals: Array.from({ length: 35 }, (_, i) => deal(i + 1, { stage: 'Old' })) }) });
  const res = await runShapeCheck({ BLOBS, ACCOUNTS_DB: d1({ accounts: [], checks: [] }) });
  const s = field(byKey(res, 'prospects'), 'stage');
  assert.equal(s.count, 35);
  assert.equal(s.examples.length, 20);
}

// 4. read in pieces of 500 by rowid; a piece that fails is tried again at half the size, then grows back
{
  const accounts = Array.from({ length: 1234 }, (_, i) => acct(i + 1));
  const log = [];
  const ACCOUNTS_DB = d1({ accounts, checks: [] }, { refuse: (size, t) => t === 'accounts' && size > 250, log });
  const res = await runShapeCheck({ BLOBS: r2(), ACCOUNTS_DB });
  const a = byKey(res, 'accounts');
  assert.equal(a.checked, true);
  assert.equal(a.rows, 1234);
  assert.equal(a.odd, 0);
  const sizes = log.filter(x => x.table === 'accounts').map(x => x.size);
  assert.deepEqual(sizes.slice(0, 2), [500, 250]);
  assert.ok(sizes.every(s => s <= 500));
  // each piece starts after the last row of the one before
  const ok = log.filter(x => x.table === 'accounts' && x.size <= 250);
  assert.equal(ok[0].after, 0); assert.equal(ok[1].after, 250);
}

// 5. a piece that fails even at 25 rows: that table is Not checked, with the reason and no counts (never a pass)
{
  const ACCOUNTS_DB = d1({ accounts: [acct(1)], checks: [check(1)] }, { refuse: (size, t) => t === 'checks' });
  const res = await runShapeCheck({ BLOBS: r2(), ACCOUNTS_DB });
  const c = byKey(res, 'checks');
  assert.equal(c.checked, false);
  assert.match(c.reason, /read failed after 0 rows, even in small pieces \(query took too long\)/);
  assert.equal(c.fields, undefined);
  assert.equal(c.odd, undefined);
  assert.equal(byKey(res, 'accounts').checked, true);
}

// 6. no database, a missing table, out of time, an unreadable funnel: Not checked, each with why
{
  const res = await runShapeCheck({ BLOBS: r2({ 'admin/pipeline.json': '{"deals":"lots"}' }) });
  assert.equal(byKey(res, 'prospects').checked, false);
  assert.match(byKey(res, 'prospects').reason, /saved funnel can’t be read/);
  assert.match(byKey(res, 'accounts').reason, /not connected/);
  const res2 = await runShapeCheck({ BLOBS: r2(), ACCOUNTS_DB: d1({ accounts: [] }) });
  assert.match(byKey(res2, 'checks').reason, /no such table: checks/);
  assert.equal(byKey(res2, 'prospects').checked, true);   // nothing saved yet: checked, no cards
  assert.equal(byKey(res2, 'prospects').rows, 0);
  const res3 = await runShapeCheck({ BLOBS: r2(), ACCOUNTS_DB: d1({ accounts: [acct(1)], checks: [] }) }, { budgetMs: -1 });
  assert.match(byKey(res3, 'accounts').reason, /ran out of time after 0 rows/);
}

// 7. a table not checked this run keeps its last full result, with its time, apart from this run's
{
  const BLOBS = r2();
  await runShapeCheck({ BLOBS, ACCOUNTS_DB: d1({ accounts: [acct(1)], checks: [check(1, { tool: 'seo' })] }) });
  const res = await runShapeCheck({ BLOBS, ACCOUNTS_DB: d1({ accounts: [acct(1)], checks: [check(1)] }, { refuse: (s, t) => t === 'checks' }) });
  const c = byKey(res, 'checks');
  assert.equal(c.checked, false);
  assert.equal(c.last.odd, 1);
  assert.equal(c.last.rows, 1);
  assert.ok(c.last.checkedAt);
  const res2 = await runShapeCheck({ BLOBS, ACCOUNTS_DB: d1({ accounts: [acct(1)] }) });   // still not checked: the same last result
  assert.equal(byKey(res2, 'checks').last.checkedAt, c.last.checkedAt);
}

console.log('shape-check: all tests passed');
