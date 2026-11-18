// Website Check rules, tested on the demo websites (website-demos.js, the same ones in /admin#demos/web).
//   node cloudflare/src/website-check.test.mjs
import assert from 'node:assert/strict';
import { analyse } from './website-check-rules.js';
import { WEBSITE_DEMOS, findWebsiteDemo } from './website-demos.js';

const run = (id) => analyse(findWebsiteDemo(id).input());
const ids = (list) => list.map((f) => f.id);

for (const d of WEBSITE_DEMOS) {
  const r = run(d.id);
  for (const k of ['strengths', 'weaknesses', 'notes']) assert.ok(Array.isArray(r[k]), `${d.id}: ${k} is a list`);
  for (const f of [...r.strengths, ...r.weaknesses, ...r.notes]) {
    for (const k of ['id', 'group', 'status', 'priority', 'title', 'detail']) assert.ok(f[k], `${d.id}: ${f.id} has ${k}`);
    assert.ok(!/\u2014/.test(f.title + f.detail + (f.why || '') + (f.start || '')), `${d.id}: ${f.id} has no em dash`);
  }
}

// What each demo is there to show
const trades = run('trades');
for (const id of ['viewport', 'analytics', 'speed-mobile', 'tap-to-call', 'https', 'sitemap']) assert.ok(ids(trades.weaknesses).includes(id), `old trade site flags ${id}`);
assert.equal(run('clinic').weaknesses.length, 0, 'the well-built clinic has nothing to fix');
const relaunch = run('relaunch');
for (const id of ['noindex', 'schema-broken', 'ai-search-bots', 'consistent']) assert.ok(ids(relaunch.weaknesses).includes(id), `relaunch flags ${id}`);
const restaurant = run('restaurant');
for (const id of ['zoom-blocked', 'tap-targets', 'web-vitals']) assert.ok(ids(restaurant.weaknesses).includes(id), `restaurant flags ${id}`);

// Rules version 3 (18 Nov 2026): UK-wide businesses, and review lines like "Rated 4.8 on Checkatrade"
const national = run('national');
assert.ok(ids(national.strengths).includes('where'), 'a UK-wide company is not asked for a town');
assert.ok(!ids(national.weaknesses).includes('gbp-link') && ids(national.notes).includes('gbp-link'), 'a Maps link is only a note for a UK-wide company');
assert.ok(ids(national.strengths).includes('local-schema'), 'Organization schema counts for a UK-wide company');
assert.ok(ids(run('shop').notes).includes('gbp-link'), 'an online shop delivering across the UK gets the Maps link as a note');
assert.ok(ids(relaunch.strengths).includes('proof'), '"Rated 4.8 on Checkatrade" counts as proof');
assert.ok(ids(national.strengths).includes('proof'), '"Rated 4.6 on Capterra" counts as proof');
assert.ok(ids(run('salon').weaknesses).includes('gbp-link'), 'a local salon with an address is still asked for its Maps link');

console.log(`website check: ${WEBSITE_DEMOS.length} demo sites pass`);
