// "Sign in with Google" for the Google Ads Check, against stubbed Google responses: no network, no credentials.
// Run: node --import ./cloudflare/test/html-loader.mjs cloudflare/test/google-signin.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { googleSignIn } from '../src/google-signin.js';
import { adsCheck, FLAGS } from '../src/google-ads-check.js';
import { QUERIES } from '../src/ads-check/queries.js';
import { SAMPLE_DATA } from '../src/ads-check/sample.js';

const OWN = '1112223333', MGR = '4445556666', KID = '7778889999';
function bucket() {
  const m = new Map();
  return { m,
    async get(k) { const v = m.get(k); return v ? { json: async () => JSON.parse(v), text: async () => v } : null; },
    async put(k, b) { m.set(k, String(b)); },
    async list({ prefix }) { return { objects: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, uploaded: new Date() })), truncated: false }; },
    async delete() {} };
}
async function adminCookie(key, email) {
  const b64 = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = Math.floor(Date.now() / 1000) + 3600, e64 = b64(email);
  const k = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(new Uint8Array(await webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${e64}.${exp}`)))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'ph_admin=' + encodeURIComponent(`${e64}.${exp}.${sig}`);
}

let calls = [], tokenBody = null;
const byQuery = Object.fromEntries(Object.entries(QUERIES).map(([n, q]) => [q.trim(), n]));
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  const login = init.headers && init.headers['login-customer-id'];
  if (url.includes('oauth2.googleapis.com/token')) { tokenBody = new URLSearchParams(init.body); calls.push('token'); return ok({ access_token: 'visitor-token', expires_in: 3599, scope: 'https://www.googleapis.com/auth/adwords' }); }
  assert.ok(url.startsWith('https://googleads.googleapis.com/'), url);
  assert.equal(auth, 'Bearer visitor-token', 'every read uses the visitor token, never the manager credentials');
  if (url.endsWith('customers:listAccessibleCustomers')) { calls.push('list'); return ok({ resourceNames: ['customers/' + OWN, 'customers/' + MGR] }); }
  const body = JSON.parse(init.body);
  const q = body.query.trim();
  const cid = url.match(/customers\/(\d+)\//)[1];
  if (q.startsWith('SELECT customer.id, customer.descriptive_name, customer.manager, customer.test_account')) {
    calls.push('head:' + cid);
    return ok([{ results: [{ customer: { id: cid, descriptiveName: cid === MGR ? 'My manager' : 'My shop', manager: cid === MGR, testAccount: true } }] }]);
  }
  if (q.includes('FROM customer_client')) { calls.push('kids:' + cid + ':' + login); return ok([{ results: [{ customerClient: { id: KID, descriptiveName: 'Shop under manager', manager: false, testAccount: true, status: 'ENABLED' } }] }]); }
  if (q.startsWith('SELECT customer.id, customer.descriptive_name, customer.currency_code')) { calls.push('reporthead:' + cid + ':' + (login || '')); return ok([{ results: [{ customer: { id: cid, descriptiveName: 'Shop under manager', currencyCode: 'GBP', manager: false } }] }]); }
  const name = byQuery[q];
  assert.ok(name, 'unknown query');
  assert.equal(login, MGR, 'report reads go through the chosen manager');
  calls.push('q:' + name);
  return ok([{ results: SAMPLE_DATA[name] || [] }]);
};

const env = { BLOBS: bucket(), ADMIN_SESSION_KEY: 'test-key', ALLOWED_AUDIT_EMAILS: 'tester@example.test', WORKER_SECRET: 'x',
  GOOGLE_ADS_CLIENT_ID: '146-test.apps.googleusercontent.com', GOOGLE_ADS_CLIENT_SECRET: 'secret', GOOGLE_ADS_REFRESH_TOKEN: 'refresh' };
const admin = await adminCookie(env.ADMIN_SESSION_KEY, 'tester@example.test');
const go = (path, init = {}) => { const url = new URL('https://www.phillips-uk.com' + path); return googleSignIn(new Request(url, init), url, env, url.pathname); };
const cookieOf = (res, name) => (res.headers.getSetCookie().find(c => c.startsWith(name + '=')) || '').split(';')[0];

// 0. With the preview switch off (as now), not even Lewis gets it.
const off = await go('/tools/google-ads-check/oauth/start', { headers: { Cookie: admin } });
assert.equal(off.status, 404);
{ const u = new URL('https://www.phillips-uk.com/google-ads-audit'); assert.doesNotMatch(await (await adsCheck(new Request(u, { headers: { Cookie: admin } }), u, env)).text(), /data-signin/); }
console.log('preview switch off: hidden from Lewis too');
FLAGS.googleSignInPreview = true;

// 1. A visitor can't start it while it's Lewis-only.
let r = await go('/tools/google-ads-check/oauth/start');
assert.equal(r.status, 404);
console.log('visitor: sign-in hidden (404)');

// 2. Lewis starts: Google URL with online access only, PKCE, the live callback.
r = await go('/tools/google-ads-check/oauth/start', { headers: { Cookie: admin } });
assert.equal(r.status, 302);
const auth = new URL(r.headers.get('Location'));
assert.equal(auth.origin, 'https://accounts.google.com');
assert.equal(auth.searchParams.get('access_type'), 'online', 'no refresh token is ever asked for');
assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
assert.equal(auth.searchParams.get('redirect_uri'), 'https://www.phillips-uk.com/tools/google-ads-check/oauth/callback');
assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
const stateCookie = cookieOf(r, 'ph_gads_oauth');
assert.ok(stateCookie.length > 30 && !stateCookie.includes(auth.searchParams.get('state')), 'state is sealed in the cookie');
console.log('start: online access only, PKCE, live callback');

// 3. A callback with the wrong state is refused.
r = await go('/tools/google-ads-check/oauth/callback?state=wrong&code=abc', { headers: { Cookie: stateCookie } });
assert.match(await r.text(), /signin=expired/);
assert.ok(!calls.includes('token'));
console.log('callback, wrong state: refused, no token swap');

// 4. The right callback swaps the code (with the PKCE verifier) and keeps the token only in a sealed cookie.
calls = [];
r = await go('/tools/google-ads-check/oauth/callback?state=' + auth.searchParams.get('state') + '&code=abc', { headers: { Cookie: stateCookie } });
const html = await r.text();
assert.match(html, /signin=1/);
assert.ok(tokenBody.get('code_verifier'));
const tokenCookie = r.headers.getSetCookie().find(c => c.startsWith('ph_gads='));
assert.ok(tokenCookie && /HttpOnly/.test(tokenCookie) && /Secure/.test(tokenCookie) && /Path=\/tools\/google-ads-check/.test(tokenCookie) && /Max-Age=900/.test(tokenCookie));
assert.ok(!tokenCookie.includes('visitor-token'), 'the token is encrypted in the cookie');
assert.equal(env.BLOBS.m.size, 0, 'nothing stored on our side');
const tc = tokenCookie.split(';')[0];
console.log('callback: token sealed in a 15-minute HttpOnly cookie, nothing stored');

// 5. Accounts: direct ones plus those under a manager; managers themselves left out.
calls = [];
r = await go('/tools/google-ads-check/oauth/accounts', { headers: { Cookie: admin + '; ' + tc } });
let d = await r.json();
assert.equal(r.status, 200, JSON.stringify(d));
assert.deepEqual(d.accounts.map(a => a.id + ':' + a.via), [OWN + ':', KID + ':' + MGR]);
console.log('accounts:', d.accounts.map(a => a.name).join(', '));

// 6. Run on the account under the manager: reads through that manager with the visitor token, then forgets the token.
calls = [];
r = await go('/tools/google-ads-check/oauth/run', { method: 'POST', headers: { Cookie: admin + '; ' + tc, 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: KID, via: MGR }) });
d = await r.json();
assert.equal(r.status, 200, JSON.stringify(d));
assert.ok(d.report.weaknesses.length > 0);
assert.match(r.headers.get('Set-Cookie') || '', /ph_gads=; .*Max-Age=0/);
const saved = [...env.BLOBS.m.entries()].find(([k]) => k.includes('/reports/'));
assert.ok(saved && !saved[1].includes('visitor-token'), 'the report never holds the token');
console.log('run: report built through the manager, token cookie cleared, token not in the report');

// 7. Without the token cookie, nothing runs.
r = await go('/tools/google-ads-check/oauth/run', { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: KID }) });
assert.equal(r.status, 401);
console.log('run without sign-in: 401');

// 8. The page marks sign-in for Lewis only.
const pageFor = async cookie => { const u = new URL('https://www.phillips-uk.com/google-ads-audit'); return (await (await adsCheck(new Request(u, { headers: cookie ? { Cookie: cookie } : {} }), u, env)).text()); };
assert.match(await pageFor(admin), /data-signin="1"/);
assert.doesNotMatch(await pageFor(''), /data-signin/);
console.log('page: sign-in shown to Lewis only');
console.log('All sign-in tests passed.');
