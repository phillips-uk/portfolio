// The Website Check's run against stubbed websites: lead cards, usage counts and the spam and crawler checks
// (tool-leads.js, tools-gate.js). No network, no credentials.
// Run: node --import ./cloudflare/test/html-loader.mjs cloudflare/test/website-check-flow.test.mjs
import assert from 'node:assert/strict';
import { websiteCheck } from '../src/website-check.js';
import { TOOLS_PUBLIC } from '../src/tools-gate.js';
import { usageByWeek } from '../src/tool-leads.js';

function bucket() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null; },
    async put(k, body, o = {}) {
      if (o.onlyIf && o.onlyIf.etagMatches && (!m.has(k) || m.get(k).etag !== o.onlyIf.etagMatches)) return null;
      const etag = Math.random().toString(36).slice(2);
      m.set(k, { body: String(body), uploaded: new Date(), etag });
      return { etag };
    },
    async list({ prefix }) { return { objects: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, uploaded: m.get(key).uploaded })), truncated: false }; },
    async delete(keys) { [].concat(keys).forEach(k => m.delete(k)); },
  };
}

let turnstilePasses = true;
const PAGE = '<!doctype html><html><head><title>Ely Plumbing</title><meta name="viewport" content="width=device-width"></head><body><h1>Plumber in Ely</h1><a href="tel:01353000000">Call</a></body></html>';
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('challenges.cloudflare.com')) return new Response(JSON.stringify(turnstilePasses ? { success: true } : { success: false }), { status: 200 });
  if (url.includes('pagespeedonline')) return new Response('{}', { status: 500 });
  if (url.startsWith('https://elyplumbing.co.uk/') && new URL(url).pathname === '/') return new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  if (url.startsWith('https://down.co.uk/')) return new Response('no', { status: 500, headers: { 'Content-Type': 'text/html' } });
  return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
};

const env = { BLOBS: bucket(), WORKER_SECRET: 'x', ADMIN_SESSION_KEY: 'test-key' };
const BROWSER = { Origin: 'http://localhost', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'CF-Connecting-IP': '203.0.113.7' };
async function run(site, headers = {}, bare = false) {
  const url = new URL('http://localhost/tools/website-check/run');
  const req = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bare ? {} : BROWSER), ...headers }, body: JSON.stringify({ url: site, token: 't' }) });
  const res = await websiteCheck(req, url, env);
  return { status: res.status, body: await res.json() };
}
const board = () => { const v = env.BLOBS.m.get('admin/pipeline.json'); return v ? JSON.parse(v.body).deals : []; };
const usage = () => { const k = [...env.BLOBS.m.keys()].find(k => k.startsWith('admin/tool-usage/')); return k ? JSON.parse(env.BLOBS.m.get(k).body).tools['website-check'] : null; };
TOOLS_PUBLIC['website-check'] = true;

// 1. A visitor's completed check: one anonymous Lead card with the site, the issue count and the report link.
let r = await run('elyplumbing.co.uk');
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(board().length, 1);
const card = board()[0];
assert.equal(card.name, 'elyplumbing.co.uk'); assert.equal(card.source, 'Website Check'); assert.equal(card.contact, 'Anonymous');
assert.equal(card.website, 'https://elyplumbing.co.uk/');
assert.ok(card.about.includes('/website-check/r/' + r.body.report.id) && card.about.includes('Issues found: ' + r.body.report.weaknesses.length));
assert.ok(r.body.report.quote.start && r.body.report.quote.total === r.body.report.quote.start.price + r.body.report.quote.lines.reduce((a, l) => a + l.price, 0), 'the price list has the start');
console.log('visitor check: Lead card "' + card.name + '", ' + r.body.report.weaknesses.length + ' issues, all fixes £' + r.body.report.quote.total);

// 2. The same site again within 24 hours: the saved report, counted as reused, no second card.
r = await run('elyplumbing.co.uk');
assert.equal(r.status, 200); assert.equal(r.body.reused, true); assert.equal(board().length, 1);
console.log('same site again: reused, no second card');

// 3. Crawlers, scripts and other sites' pages: refused, no fetch of the site, no card.
for (const [why, h, bare] of [['python', { 'User-Agent': 'python-requests/2.31' }], ['bingbot', { 'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' }], ['other origin', { Origin: 'https://evil.example' }], ['no Origin', { 'User-Agent': BROWSER['User-Agent'] }, true]]) {
  r = await run('another.co.uk', h, bare);
  assert.equal(r.status, 403, why);
}
assert.equal(board().length, 1);
console.log('python, bingbot, another site and no Origin: refused (403), no card');

// 4. Turnstile fails: refused, no card.
turnstilePasses = false;
r = await run('another.co.uk');
assert.equal(r.status, 400); assert.equal(board().length, 1);
turnstilePasses = true;
console.log('Turnstile fails: refused (400), no card');

// 5. A site that can't be read: failed, no card.
r = await run('down.co.uk', { 'CF-Connecting-IP': '203.0.113.8' });
assert.equal(r.status, 422); assert.equal(board().length, 1);
console.log('unreadable site: 422, no card');

// 6. Five checks a day from one connection (the free-use limit), then refused with no card.
for (let i = 0; i < 5; i++) await run(`site${i}.co.uk`, { 'CF-Connecting-IP': '198.51.100.2' });
const before = board().length;
r = await run('site9.co.uk', { 'CF-Connecting-IP': '198.51.100.2' });
assert.equal(r.status, 429); assert.equal(board().length, before);
console.log('6th check today from one connection: refused (429), no card');

const u = usage();
assert.equal(u.reused, 1); assert.ok(u.blocked.bot === 2 && u.blocked.origin === 2 && u.blocked.turnstile === 1 && u.blocked.daily === 1, JSON.stringify(u.blocked));
assert.ok(u.failed >= 1);
const weeks = await usageByWeek(env, 12);
assert.ok(weeks.length >= 12 && weeks[0].tools['website-check'].completed === u.completed, 'this week leads the weekly table');
console.log('usage this week:', JSON.stringify(u));
console.log('All Website Check flow tests passed.');
