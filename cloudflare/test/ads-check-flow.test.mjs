// The Google Ads Check flow against stubbed Google responses: no network, no credentials.
// Run: node --import ./cloudflare/test/html-loader.mjs cloudflare/test/ads-check-flow.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { adsCheck } from '../src/google-ads-check.js';
import { TOOLS_PUBLIC } from '../src/tools-gate.js';
import { QUERIES } from '../src/ads-check/queries.js';
import { SAMPLE_DATA } from '../src/ads-check/sample.js';

const CID = '1234567890';
const LINK = '987654';

// In-memory R2
function bucket() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v ? { json: async () => JSON.parse(v.body), text: async () => v.body } : null; },
    async put(k, body, o = {}) { m.set(k, { body: String(body), uploaded: new Date(), customMetadata: o.customMetadata }); },
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
const byQuery = Object.fromEntries(Object.entries(QUERIES).map(([name, q]) => [q.trim(), name]));
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const ok = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

async function run(headers = {}) {
  const url = new URL('http://localhost/tools/google-ads-check/run');
  const req = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ customerId: '123-456-7890', token: 't' }) });
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
assert.equal(r.body.report.quote.retainer, null, 'no retainer fee set, so no monthly option');
assert.equal(r.body.report.operations, undefined, 'operations are shown only to Lewis');
assert.equal(r.body.report.customerId, '123-456-7890');
console.log('pending invite: accepted, read', queryCalls().length, 'queries, unlinked last; total', r.body.report.quote.total);

// 2. The same account again: one free check every 30 days.
calls = []; linkState = 'PENDING';
r = await run();
assert.equal(r.status, 429); assert.ok(!calls.includes('accept'));
console.log('second check on the same account: refused (429), nothing accepted');

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
console.log('read fails: 502, link still ended, no report saved');

// 6. Lewis's preview on an already-linked account: read without touching the link, no Turnstile call.
TOOLS_PUBLIC['google-ads-check'] = false;
env.BLOBS = bucket(); calls = []; linkState = 'ACTIVE'; failQuery = null;
r = await run({ Cookie: admin });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(!calls.includes('accept') && !calls.includes('unlink') && !calls.includes('turnstile'));
assert.ok(r.body.report.operations > 0);
console.log('preview, already linked: read with the link left alone,', r.body.report.operations, 'operations');

// 7. Private: without the admin cookie, the tool answers 404 while it is a preview.
r = await run();
assert.equal(r.status, 404);
console.log('private preview, visitor: 404');
console.log('All flow tests passed.');
