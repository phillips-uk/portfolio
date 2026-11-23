// node cloudflare/test/client-billing.test.mjs
import assert from 'node:assert/strict';
import { cleanBilling, phillipsPart, revenue, clientMoney } from '../src/client-billing.js';

// cleaning the form
assert.deepEqual(cleanBilling({ fee: '500', cadence: 'monthly', day: '23', start: '2026-11-23' }).value,
  { fee: 500, cadence: 'monthly', day: 23, start: '2026-11-23', end: null, xeroContactId: null, xeroContactName: null, deskId: null, deskName: null, note: '' });
assert.ok(cleanBilling({ fee: 'lots' }).error);
assert.ok(cleanBilling({ day: '40' }).error);
assert.ok(cleanBilling({ start: '2026-12-01', end: '2026-11-01' }).error);
assert.equal(cleanBilling({ fee: '' }).value.cadence, 'none');

// only the Phillips. lines count
const brand = o => [{ Name: 'Brand', Option: o }];
const inv = { InvoiceID: 'a', InvoiceNumber: 'INV-9', Contact: { ContactID: 'c1', Name: 'Lee' }, DateString: '2026-11-23T00:00:00', DueDateString: '2026-12-01T00:00:00',
  Status: 'AUTHORISED', Total: 800, AmountPaid: 0, AmountDue: 800,
  LineItems: [{ LineAmount: 500, Tracking: brand('Phillips.') }, { LineAmount: 300, Tracking: brand("The Director's Office") }] };
const p = phillipsPart(inv);
assert.equal(p.total, 500); assert.equal(p.owed, 500); assert.equal(p.date, '2026-11-23'); assert.equal(p.untagged, false);
assert.equal(phillipsPart({ ...inv, LineItems: [{ LineAmount: 100, Tracking: [] }] }).untagged, true);
assert.equal(phillipsPart({ ...inv, LineItems: [{ LineAmount: 100, Tracking: [] }] }).total, 0);

// revenue tiles
const billing = { lee: { fee: 500, cadence: 'monthly', start: '2026-11-23' }, old: { fee: 900, cadence: 'monthly', former: true }, once: { fee: 2000, cadence: 'one-off' }, later: { fee: 300, cadence: 'monthly', start: '2027-01-01' } };
const invoices = [
  { ...p },
  { ...p, id: 'b', date: '2026-10-23', due: '2026-11-01', status: 'PAID', total: 500, paid: 500, owed: 0, paidOn: '2026-10-30' },
  { ...p, id: 'c', date: '2026-09-23', due: '2026-10-01', status: 'AUTHORISED', total: 500, paid: 200, owed: 300 },
];
const r = revenue(billing, invoices, '2026-11-25');
assert.equal(r.monthly, 500); assert.equal(r.payers, 1);
assert.equal(r.invoicedMonth, 500);
assert.equal(r.paidYear, 700);
assert.equal(r.owed, 800); assert.equal(r.overdue, 300); assert.equal(r.openCount, 2);
assert.equal(revenue(billing, invoices, '2026-11-20').monthly, 0); // Lee's fee starts on the 23rd
assert.equal(revenue(billing, invoices, '2026-11-20').upcoming, 800); assert.equal(revenue(billing, invoices, '2026-11-20').nextStart, '2026-11-23');

const m = clientMoney('c1', invoices, '2026-11-25');
assert.equal(m.invoiced12m, 1500); assert.equal(m.owed, 800); assert.equal(m.recent[0].number, 'INV-9');
console.log('client billing: all checks passed');
