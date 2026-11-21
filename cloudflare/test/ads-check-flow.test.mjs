// The Google Ads Check flow against stubbed Google responses: no network, no credentials.
// Run: node --import ./cloudflare/test/html-loader.mjs cloudflare/test/ads-check-flow.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { adsCheck } from '../src/google-ads-check.js';
import { TOOLS_PUBLIC } from '../src/tools-gate.js';
import { QUERIES, queriesFor } from '../src/ads-check/queries.js';
import { londonDay } from '../src/tools-gate.js';
import { SAMPLE_DATA } from '../src/ads-check/sample.js';

const CID = '1234567890';
const LINK = '987654';

// In-memory R2
function bucket() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null; },
    async put(k, body, o = {}) {
      if (o.onlyIf && o.onlyIf.etagMatches && (!m.has(k) || m.get(k).etag !== o.onlyIf.etagMatches)) return null;
      const etag = Math.random().toString(36).slice(2);
      m.set(k, { body: String(body), uploaded: new Date(), customMetadata: o.customMetadata, etag });
      return { etag };
    },
    async list({ prefix }) { return { objects: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, uploaded: m.get(key).uploaded, customMetadata: m.get(key).customMetadata })), truncated: false }; },
    async delete(keys) { [].concat(keys).forEach(k => m.delete(k)); },
  };
}

// A test admin cookie, signed like admin.js does
async function cookie(key, email) {
  const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) + 3600, e64 = b64(email);
  const k = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(new Uint8Array(await webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${e64}.${exp}`)))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'ph_admin=' + encodeURIComponent(`${e64}.${exp}.${sig}`);
}

// Stubbed Google: records every call in order
let calls, linkState, failQuery;
const byQuery = Object.fromEntries(Object.entries(queriesFor(londonDay())).map(([name, q]) => [q.trim(), name]));
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const ok = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  // The landing page check (ads-check/urls.js): the sample's pages answer, one GET each
  if (/^https:\/\/(www\.)?example\.co\.uk/.test(url)) { calls.push('page'); assert.equal(init.method, 'GET'); return new Response('', { status: url.includes('/emergency/') ? 404 : 200 }); }
  if (url.includes('challenges.cloudflare.com')) { calls.push('turnstile'); return ok({ success: true, hostname: 'www.phillips-uk.com', action: 'ads_check' }); }
  if (url.includes('oauth2.googleapis.com/token')) { calls.push('token'); return ok({ access_token: 'stub', expires_in: 3600 }); }
  if (url.includes('customerClientLinks:mutate')) { calls.push('accept'); assert.equal(body.operation.update.status, 'ACTIVE'); assert.match(body.operation.update.resourceName, new RegExp(`/customerClientLinks/${CID}~${LINK}$`)); linkState = 'ACTIVE'; return ok({ result: {} }); }
  if (url.includes('customerManagerLinks:mutate')) { const st = body.operations[0].update.status; calls.push(st === 'INACTIVE' ? 'unlink' : 'accept-other'); if (st === 'INACTIVE') linkState = 'INACTIVE'; return ok({ results: [{}] }); }
  if (url.includes('googleAds:searchStream')) {
    const q = body.query.trim();
    if (q.includes('FROM customer_client_link')) { calls.push('link-status'); return ok(linkState ? [{ results: [{ customerClientLink: { clientCustomer: 'customers/' + CID, managerLinkId: LINK, status: linkState } }] }] : [{ results: [] }]); }
    if (q.startsWith('SELECT customer.id, customer.descriptive_name')) { calls.push('head'); return ok([{ results: [{ customer: { id: CID, descriptiveName: 'Stub Ltd', currencyCode: 'GBP', manager: false } }] }]); }
    const name = byQuery[q];
    assert.ok(name, 'unknown query: ' + q.slice(0, 60));
    calls.push('q:' + name);
    if (failQuery === name) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400 });
    return ok([{ results: SAMPLE_DATA[name] || [] }]);
  }
  throw new Error('unexpected fetch ' + url);
};

const env = { BLOBS: bucket(), ADMIN_SESSION_KEY: 'test-key', ALLOWED_AUDIT_EMAILS: 'tester@example.test', WORKER_SECRET: 'x',
  GOOGLE_ADS_CLIENT_ID: 'id', GOOGLE_ADS_CLIENT_SECRET: 'secret', GOOGLE_ADS_REFRESH_TOKEN: 'refresh' };
const admin = await cookie(env.ADMIN_SESSION_KEY, 'tester@example.test');

// A visitor's browser on the page itself (tools-gate.js guard: Origin and a browser user agent)
const BROWSER = { Origin: 'http://localhost', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'CF-Connecting-IP': '203.0.113.7' };
async function run(headers = {}, bare = false) {
  const url = new URL('http://localhost/tools/google-ads-check/run');
  const req = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bare ? {} : BROWSER), ...headers }, body: JSON.stringify({ customerId: '123-456-7890', token: 't', target: { type: 'cpa', value: '£40' }, brand: 'Example <b>Heating</b>' }) });
  const res = await adsCheck(req, url, env);
  return { status: res.status, body: await res.json() };
}
const queryCalls = () => calls.filter(c => c.startsWith('q:'));

// 1. Visitor with a pending invitation: accept, read everything, price, then end the link last.
TOOLS_PUBLIC['google-ads-check'] = true;
calls = []; linkState = 'PENDING'; failQuery = null;
let r = await run();
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(calls.indexOf('accept') > calls.indexOf('link-status'));
assert.equal(calls.at(-1), 'unlink', 'the link is ended after the read');
assert.equal(queryCalls().length, Object.keys(QUERIES).length);
assert.ok(calls.indexOf('accept') < calls.indexOf(queryCalls()[0]));
assert.equal(linkState, 'INACTIVE');
assert.ok(r.body.report.weaknesses.length > 0 && r.body.report.quote.lines.length > 0);
// Monthly fee since 21 Nov 2026: estimated hours at the hourly rate, never under the £500 minimum
{ const ret = r.body.report.quote.retainer;
  assert.ok(ret && ret.fee >= 500 && ret.hours > 0, 'monthly option priced on hours, with the minimum');
  assert.equal(ret.fee % 50, 0, 'monthly fee rounds to £50'); }
assert.equal(r.body.report.operations, undefined, 'operations are shown only to Lewis');
assert.equal(r.body.report.customerId, '123-456-7890');
// The deeper report (21 Nov 2026): landing pages checked while reading, the target applied, a headline and a ranked plan.
{ const rep = r.body.report;
  assert.ok(calls.filter(c => c === 'page').length >= 1 && calls.indexOf('page') < calls.indexOf('unlink'), 'landing pages checked before the link ends');
  assert.ok(rep.weaknesses.some(w => w.id === 'broken-landing-pages'), 'the 404 page is reported');
  assert.deepEqual(rep.target, { type: 'cpa', value: 40 }, 'target read from "£40"');
  assert.equal(rep.brand, 'Example bHeatingb', 'brand name stripped of markup characters');
  assert.ok(Array.isArray(rep.headline) && rep.headline.length >= 2, 'a written headline');
  assert.equal(rep.plan.length, rep.weaknesses.length, 'every finding is in the plan');
  assert.ok(rep.plan.every((p, i) => p.rank === i + 1 && ['high', 'medium', 'low'].includes(p.impact)), 'ranked, with an impact');
  { const end = rep.headline[rep.headline.length - 1]; const first = rep.plan[0];
    assert.ok(end === "That's where I'd start." || end === `I'd start with "${first.title}".`, '"In short" starts where the plan starts'); }
  assert.ok(rep.plan.some(p => p.hours > 0 && p.effort), 'effort from the priced time'); }
console.log('pending invite: accepted, read', queryCalls().length, 'queries, unlinked last; total', r.body.report.quote.total);

// 1a. That visitor run is a Lead card in the /admin funnel (tool-leads.js), anonymous, with the report link, and counted.
const board = () => { const v = env.BLOBS.m.get('admin/pipeline.json'); return v ? JSON.parse(v.body).deals : []; };
const usage = () => { const k = [...env.BLOBS.m.keys()].find(k => k.startsWith('admin/tool-usage/')); return k ? JSON.parse(env.BLOBS.m.get(k).body) : null; };
assert.equal(board().length, 1, 'one Lead card');
const card = board()[0];
assert.equal(card.stage, 'Lead'); assert.equal(card.name, 'Stub Ltd'); assert.equal(card.source, 'Google Ads Check'); assert.equal(card.contact, 'Anonymous');
assert.ok(card.about.includes('/google-ads-audit/r/' + r.body.report.id), 'card links the report');
assert.ok(card.about.includes('123-456-7890') && card.about.includes('Issues found: ' + r.body.report.weaknesses.length), 'card names the account and the issue count');
assert.equal(usage().tools['google-ads-check'].completed, 1); assert.equal(usage().cards, 1);
console.log('visitor run: Lead card "' + card.name + '" (' + card.contact + '), counted');

// 2. The same account again: one free check every 30 days.
calls = []; linkState = 'PENDING';
r = await run();
assert.equal(r.status, 429); assert.ok(!calls.includes('accept'));
assert.equal(board().length, 1, 'no card for a refused run');
assert.equal(usage().tools['google-ads-check'].blocked.account, 1);
console.log('second check on the same account: refused (429), nothing accepted, no card');

// 2a. Crawlers and scripts: refused before Turnstile or Google is touched, no card.
for (const [why, h, bare] of [['curl', { 'User-Agent': 'curl/8.4.0' }, false], ['Googlebot', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, false], ['headless', { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36' }, false], ['no Origin', { 'User-Agent': BROWSER['User-Agent'] }, true]]) {
  calls = []; linkState = 'PENDING';
  r = await run(h, bare);
  assert.equal(r.status, 403, why); assert.equal(calls.length, 0, why + ': nothing called');
}
assert.equal(board().length, 1, 'no card for a crawler');
console.log('curl, Googlebot, HeadlessChrome and no Origin: refused (403), nothing called, no card');

// 2b. A failed Turnstile check: refused, no card.
{
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).includes('challenges.cloudflare.com') ? new Response(JSON.stringify({ success: false }), { status: 200 }) : real(input, init);
  env.BLOBS.m.delete([...env.BLOBS.m.keys()].find(k => k.includes('/account/')));
  calls = []; linkState = 'PENDING';
  r = await run({ 'CF-Connecting-IP': '203.0.113.9' });
  globalThis.fetch = real;
  assert.equal(r.status, 400); assert.equal(board().length, 1, 'no card when Turnstile fails');
  assert.equal(usage().tools['google-ads-check'].blocked.turnstile, 1);
  console.log('Turnstile fails: refused (400), no card');
}

// 2c. One connection: at most 6 runs an hour.
{
  const ipH = { 'CF-Connecting-IP': '198.51.100.1' };
  let last;
  for (let i = 0; i < 7; i++) { calls = []; linkState = null; last = await run(ipH); }
  assert.equal(last.status, 429); assert.equal(calls.length, 0, 'the 7th run in an hour is refused before Google is called');
  console.log('7th run in an hour from one connection: refused (429)');
}

// 3. An already-linked account (an existing client) is refused for a visitor, and the link is left alone.
env.BLOBS = bucket(); calls = []; linkState = 'ACTIVE';
r = await run();
assert.equal(r.status, 409); assert.ok(!calls.includes('accept') && !calls.includes('unlink') && !queryCalls().length);
console.log('already linked, visitor: refused (409), no read, link untouched');

// 4. No invitation yet.
calls = []; linkState = null;
r = await run();
assert.equal(r.status, 409); assert.equal(r.body.status, 'NONE');
console.log('no invitation: 409 NONE');

// 5. A required query fails mid-read: nothing saved, and the link is still ended.
env.BLOBS = bucket(); calls = []; linkState = 'PENDING'; failQuery = 'campaigns';
r = await run();
assert.equal(r.status, 502); assert.equal(calls.at(-1), 'unlink');
assert.equal([...env.BLOBS.m.keys()].filter(k => k.includes('/reports/')).length, 0);
assert.equal(board().length, 0, 'no card for a failed run');
assert.equal(usage().tools['google-ads-check'].failed, 1);
console.log('read fails: 502, link still ended, no report saved, no card');

// 6. Lewis's preview on an already-linked account: read without touching the link, no Turnstile call.
TOOLS_PUBLIC['google-ads-check'] = false;
env.BLOBS = bucket(); calls = []; linkState = 'ACTIVE'; failQuery = null;
r = await run({ Cookie: admin });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(!calls.includes('accept') && !calls.includes('unlink') && !calls.includes('turnstile'));
assert.ok(r.body.report.operations > 0);
assert.equal(board().length, 0, 'Lewis\'s own run makes no card'); assert.equal(usage(), null, 'and is not counted');
console.log('preview, already linked: read with the link left alone,', r.body.report.operations, 'operations');

// 7. Private: without the admin cookie, the tool answers 404 while it is a preview.
r = await run();
assert.equal(r.status, 404);
console.log('private preview, visitor: 404');
console.log('All flow tests passed.');
