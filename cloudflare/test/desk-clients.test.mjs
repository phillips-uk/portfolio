// node cloudflare/test/desk-clients.test.mjs
import assert from 'node:assert/strict';
import { deskSummary, deskClients, deskIdOk } from '../src/desk-clients.js';
import { cleanBilling } from '../src/client-billing.js';

assert.equal(deskSummary(null), null);
assert.equal(deskSummary({ id: 'x', error: 'not_a_client' }), null);
assert.deepEqual(deskSummary({ findings: [
  { daily: true, money: 120.5 }, { daily: true, money: 80, nosum: true }, { daily: false, money: 999 }, { daily: true, money: null },
] }), { count: 3, money: 120.5 });

assert.ok(deskIdOk('T_us3zRDhR6LYwrV')); assert.ok(!deskIdOk('../etc')); assert.ok(!deskIdOk(5));

assert.equal(cleanBilling({ deskId: 'T_us3zRDhR6LYwrV', deskName: 'Lee Renée' }).value.deskId, 'T_us3zRDhR6LYwrV');
assert.equal(cleanBilling({ deskId: 'bad id!', deskName: 'x' }).value.deskId, null);
assert.equal(cleanBilling({ deskId: 'bad id!', deskName: 'x' }).value.deskName, null);

assert.deepEqual(await deskClients({}, ['T_us3zRDhR6LYwrV']), { ready: false, companies: [], health: {} });
let asked = null;
const env = { DESK_CLIENTS: {
  list: async () => ({ companies: [{ id: 'T_us3zRDhR6LYwrV', name: 'Lee Renée Jewellery', extra: 1 }] }),
  summary: async ({ ids }) => { asked = ids; return { companies: [{ id: ids[0], name: 'Lee', findings: [{ daily: true, money: 10 }] }, { id: ids[1], error: 'not_a_client' }] }; },
} };
const r = await deskClients(env, ['T_us3zRDhR6LYwrV', 'Orf9PGovjRA3iwUX', 'T_us3zRDhR6LYwrV', 'nope!']);
assert.deepEqual(asked, ['T_us3zRDhR6LYwrV', 'Orf9PGovjRA3iwUX']);
assert.deepEqual(r.companies, [{ id: 'T_us3zRDhR6LYwrV', name: 'Lee Renée Jewellery' }]);
assert.deepEqual(r.health.T_us3zRDhR6LYwrV.summary, { count: 1, money: 10 });
assert.equal(r.health.Orf9PGovjRA3iwUX.error, 'not_a_client');
const bad = await deskClients({ DESK_CLIENTS: { list: async () => { throw new Error('down'); }, summary: async () => ({}) } }, []);
assert.equal(bad.ready, true); assert.ok(bad.error);
console.log('desk-clients: all passed');
