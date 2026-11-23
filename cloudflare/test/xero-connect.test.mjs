// node cloudflare/test/xero-connect.test.mjs: Xero's sign-in round trip with Xero stubbed out.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { xeroRoutes, syncXero } from '../src/client-billing.js';

const store = new Map();
const BLOBS = {
  get: async k => store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : null,
  put: async (k, v) => { store.set(k, v); },
  delete: async k => { store.delete(k); },
};
const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
const env = { BLOBS, XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret', XERO_TOKEN_KEY: key };
globalThis.fetch = async (url, init) => {
  if (url.includes('/connect/token')) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 1800 }));
  if (url.endsWith('/connections')) return new Response(JSON.stringify([{ id: 'conn1', tenantId: 'ten1', tenantName: 'Phillips Group', tenantType: 'ORGANISATION' }]));
  if (url.includes('/Invoices')) return new Response(JSON.stringify({ Invoices: [{ InvoiceID: 'i1', InvoiceNumber: 'PG-2026-001', Contact: { ContactID: 'c1', Name: 'Lee' }, Date: '/Date(1795392000000+0000)/', DueDate: '/Date(1796083200000+0000)/', FullyPaidOnDate: '/Date(1795392000000+0000)/', Status: 'PAID', Total: 500, AmountPaid: 500, AmountDue: 0, LineItems: [{ LineAmount: 500, Tracking: [{ Name: 'Brand', Option: 'Phillips.' }] }] }] }));
  if (url.includes('/Contacts')) return new Response(JSON.stringify({ Contacts: [{ ContactID: 'c1', Name: 'Lee' }] }));
  throw new Error('unexpected ' + url);
};
const U = p => new URL('https://www.phillips-uk.com' + p);

// 1. start: signed-in admin gets sent to Xero with a state, saved in R2 and in a Lax cookie
const start = await xeroRoutes(new Request(U('/admin/xero/connect')), U('/admin/xero/connect'), env, 'lewis@phillips-group.uk');
assert.equal(start.status, 302);
const loc = new URL(start.headers.get('Location'));
assert.equal(loc.searchParams.get('redirect_uri'), 'https://www.phillips-uk.com/admin/xero/callback');
const state = loc.searchParams.get('state');
assert.match(start.headers.get('Set-Cookie'), /SameSite=Lax/);
assert.ok(store.has('admin/xero-state/' + state + '.json'));

// 2. a return with no admin cookie, only the state cookie: connects and syncs
const cb = '/admin/xero/callback?code=abc&state=' + state;
const back = await xeroRoutes(new Request(U(cb), { headers: { Cookie: 'ph_xero_state=' + state } }), U(cb), env, null);
assert.equal(back.headers.get('Location'), '/admin#clients?xero=connected');
assert.ok(!store.has('admin/xero-state/' + state + '.json'), 'state is one use');
const inv = JSON.parse(store.get('admin/xero-invoices.json'));
assert.equal(inv.invoices[0].number, 'PG-2026-001'); assert.equal(inv.invoices[0].paid, 500); assert.equal(inv.invoices[0].paidOn, '2026-11-23');
const conn = JSON.parse(store.get('admin/xero.json'));
assert.equal(conn.tenantName, 'Phillips Group'); assert.equal(conn.connectedBy, 'lewis@phillips-group.uk'); assert.ok(!JSON.stringify(conn).includes('"R"'), 'tokens are sealed');

// 3. the same state again, or a state with no matching cookie, is refused
const again = await xeroRoutes(new Request(U(cb), { headers: { Cookie: 'ph_xero_state=' + state } }), U(cb), env, null);
assert.equal(again.headers.get('Location'), '/admin#clients?xero=expired');
const forged = await xeroRoutes(new Request(U(cb)), U(cb), env, null);
assert.equal(forged.headers.get('Location'), '/admin#clients?xero=expired');

// 4. the daily sync reuses the sealed tokens
assert.equal((await syncXero(env)).ok, true);
console.log('xero connect: all checks passed');
