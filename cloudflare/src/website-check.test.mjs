// Website Check rules, tested on the demo websites (website-demos.js, the same ones in /admin#demos/web).
//   node cloudflare/src/website-check.test.mjs
import assert from 'node:assert/strict';
import { analyse, readPsi, savingWords, robotsAllows, internalUrl, pageKey, areaScores, AREAS, snapshot, compareChecks } from './website-check-rules.js';
import { WEBSITE_DEMOS, findWebsiteDemo } from './website-demos.js';
import { webQuote, WEB_FIX, getPricing, quote, validate, humanMinutes } from './pricing.js';

const run = (id, model) => analyse({ ...findWebsiteDemo(id).input(), ...(model ? { model } : {}) });
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
assert.ok(!ids(national.weaknesses).includes('where'), 'a UK-wide company is not asked for a town');
assert.ok(!ids([...national.weaknesses, ...national.notes]).includes('gbp-link'), 'a UK-wide company is not asked for a Maps link');
assert.ok(ids(national.strengths).includes('local-schema'), 'Organization schema counts for a UK-wide company');
assert.ok(!ids([...run('shop').weaknesses, ...run('shop').notes]).includes('gbp-link'), 'an online shop is not asked for a Maps link');
assert.ok(ids(relaunch.strengths).includes('proof'), '"Rated 4.8 on Checkatrade" counts as proof');
assert.ok(ids(national.strengths).includes('proof'), '"Rated 4.6 on Capterra" counts as proof');
assert.ok(ids(run('salon').weaknesses).includes('gbp-link'), 'a local salon with an address is still asked for its Maps link');

// Rules version 4: the site profile behind "How I read your site"
const prof = (id) => run(id).profile;
assert.equal(prof('clinic').summary, 'A dentist in Ely, reached by phone, email and a contact form.');
assert.equal(prof('national').summary, 'A company working across the UK, reached by a contact form.');
assert.equal(prof('trades').place, 'Ely', 'a postcode gives the town written before it');
assert.equal(prof('trades').name, null, 'a title of "Home" is not the business name');
assert.equal(prof('shop').place, 'Suffolk', 'the title and heading are not joined into "Suffolk Hand"');
assert.equal(prof('shop').platform, 'Shopify'); assert.equal(prof('salon').platform, 'Wix');
assert.deepEqual(prof('clinic').firstScreen.cta, { text: 'Call 01353 000 333', kind: 'call' });
assert.ok(prof('relaunch').google.title && prof('relaunch').google.description, 'Google preview has a title and description');

// Rules version 5 (21 Nov 2026): three kinds of business, chosen or detected
const kinds = Object.fromEntries(WEBSITE_DEMOS.map((d) => [d.id, run(d.id).model]));
assert.deepEqual(kinds, { trades: 'local', salon: 'local', shop: 'shop', clinic: 'local', relaunch: 'local', restaurant: 'local', national: 'national' }, 'each demo is detected as the right kind');
assert.equal(run('trades').modelFrom, 'detected');
const tradesAsNational = run('trades', 'national');
assert.equal(tradesAsNational.modelFrom, 'chosen');
for (const id of ['where', 'gbp-link']) assert.ok(!ids([...tradesAsNational.weaknesses, ...tradesAsNational.notes]).includes(id), `a business that says it works UK-wide is not asked for ${id}`);
assert.ok(!ids(tradesAsNational.weaknesses).some((id) => id === 'local-schema' && tradesAsNational.weaknesses.find((w) => w.id === id).title.includes('local')), 'no "local business details" ask for a UK-wide business');
const nationalAsLocal = run('national', 'local');
for (const id of ['where', 'gbp-link', 'local-schema']) assert.ok(ids(nationalAsLocal.weaknesses).includes(id), `a business that says it is local is asked for ${id}`);
const shop = run('shop');
assert.ok(ids(shop.weaknesses).includes('delivery-returns') && /returns/.test(shop.weaknesses.find((w) => w.id === 'delivery-returns').title) && !/delivery or/.test(shop.weaknesses.find((w) => w.id === 'delivery-returns').title), 'the shop links delivery but not returns');
assert.ok(!ids([...run('clinic').weaknesses, ...run('clinic').strengths]).includes('delivery-returns'), 'delivery and returns only for shops');
assert.equal(shop.profile.model, 'shop'); assert.equal(prof('national').summary, 'A company working across the UK, reached by a contact form.');
for (const d of WEBSITE_DEMOS) for (const m of ['local', 'national', 'shop']) {
  const r = run(d.id, m);
  for (const f of [...r.strengths, ...r.weaknesses, ...r.notes]) {
    assert.ok(!/undefined/.test(f.title + f.detail + f.why + f.start), `${d.id} as ${m}: ${f.id} reads cleanly`);
    if (m !== 'local') assert.ok(!/Google Business Profile/.test(f.start) || f.id === 'gbp-link', `${d.id} as ${m}: ${f.id} doesn't send a non-local business to its Business Profile`);
  }
  for (const w of r.weaknesses) assert.ok(WEB_FIX[w.id], `${d.id} as ${m}: ${w.id} has a price`);
}

// Pricing (18 Nov 2026): every weakness a demo can raise is a priced job; same-kind findings are one job
const pricing = await getPricing({});
for (const d of WEBSITE_DEMOS) for (const w of run(d.id).weaknesses) assert.ok(WEB_FIX[w.id], `${d.id}: ${w.id} has a price`);
const tq = webQuote(pricing, run('trades').weaknesses);
const speedJob = tq.lines.find((l) => l.fixType === 'web_speed');
assert.equal(tq.lines.filter((l) => l.fixType === 'web_speed').length, 1, 'speed findings are one job');
assert.ok(speedJob.covers.length >= 2 && speedJob.price > 0, 'the speed job lists what it covers');
assert.equal(tq.retainer, null, 'no monthly option on the Website Check');
assert.equal(webQuote(pricing, run('clinic').weaknesses).lines.length, 0, 'nothing to fix, nothing to price');

// AI-assisted pricing (Lewis, 19 Nov 2026): one hour to start, charged once; then each job at its AI-assisted time where
// it has one, or its time by hand where it can't be done quickly with AI. No job is forced up to an hour any more.
const hour = Math.round(pricing.settings.dayRate / pricing.settings.hoursPerDay);
assert.equal(tq.start.price, hour, 'the start is one hour');
assert.equal(tq.total, tq.start.price + tq.lines.reduce((a, l) => a + l.price, 0), 'total is the start plus every job');
assert.ok(tq.lines.some((l) => l.ai && l.price < hour), 'an AI-assisted job can cost less than an hour');
assert.ok(tq.lines.every((l) => l.minutes <= l.humanMinutes), 'AI time is never more than the time by hand');
assert.ok(tq.lines.filter((l) => l.fixType === 'web_speed' || l.fixType === 'web_tracking').every((l) => !l.ai && l.minutes === l.humanMinutes), 'speed and tracking keep the time by hand');
assert.ok(tq.lines.every((l) => l.minutes % pricing.settings.jobRoundMinutes === 0 && l.minutes >= pricing.settings.jobMinMinutes), 'jobs round to the quarter hour');
assert.equal(quote(pricing, []).total, 0, 'nothing ticked, no start charge');
// Version 1 (saved 16 Nov) carries roundToMinutes 30 and minMinutesPerFix 60; they no longer push a job up to an hour.
const v1 = validate({ roundToMinutes: 30, minMinutesPerFix: 60, dayRate: 625, hoursPerDay: 7 });
assert.ok(!v1.error && v1.settings.jobMinMinutes === 15, 'old minimum keys are ignored');
// An empty AI time in the admin means "by hand only"
const noAi = validate({ fixTypes: { web_search: { setup: 20, perItem: 15, aiSetup: '', aiPerItem: '' } } });
assert.equal(noAi.settings.fixTypes.web_search.aiSetup, null, 'empty AI time is saved as none');
const lines = [{ id: 'x', title: 'x', fixType: 'web_search', items: 2, priority: 'high' }];
assert.equal(quote({ settings: noAi.settings }, lines).lines[0].minutes, humanMinutes(noAi.settings, 'web_search', 2), 'no AI time: priced by hand');
assert.ok(quote(pricing, lines).lines[0].minutes < humanMinutes(pricing.settings, 'web_search', 2), 'with AI time: cheaper');
assert.ok(validate({ fixTypes: { web_search: { aiSetup: -1 } } }).error, 'a negative AI time is refused');

// Rules version 6 (21 Nov 2026, v2 step 2): what Google says to fix, accessibility, best practices, indexing, security,
// link previews and the UK legal basics
const sp = trades.weaknesses.find((w) => w.id === 'speed-mobile');
assert.equal(sp.items.length, 3, 'slow phone speed lists Google’s top three fixes');
assert.equal(sp.items[0].text, 'Images are bigger than they need to be', 'biggest saving first');
assert.match(sp.items[0].note, /^about 2\.4 MB less to download$/, 'saving in plain words');
assert.equal(sp.start, sp.items.length && 'Resize images to the size they show at, compress them, and save photos as WebP or AVIF.', 'start is the top fix');
assert.equal(savingWords({ ms: 1000, bytes: 0, tbt: 0 }), 'about 1 second sooner');
for (const id of ['accessibility', 'best-practices', 'soft-404', 'mixed-content', 'canonical', 'lang', 'link-text', 'social-tags']) assert.ok(ids(trades.weaknesses).includes(id), `old trade site flags ${id}`);
assert.equal(relaunch.weaknesses.find((w) => w.id === 'canonical').priority, 'high', 'canonical to a test site is a fix-first');
for (const id of ['privacy', 'cookie-consent']) assert.ok(ids(relaunch.weaknesses).includes(id), `tracking without a banner or privacy link flags ${id}`);
assert.ok(ids(national.weaknesses).includes('company-details'), 'a Ltd with no company number is asked for it');
assert.ok(ids(national.weaknesses).includes('form-length'), 'a nine-field form is long');
assert.ok(ids(national.notes).includes('cookie-consent'), 'Tag Manager only: a note to check the banner, not a fault');
assert.equal(run('restaurant').weaknesses.find((w) => w.id === 'soft-404').priority, 'low', 'a redirect for missing pages is a small fix');
const clinicR = run('clinic');
for (const id of ['accessibility', 'best-practices', 'canonical', 'soft-404', 'security-headers', 'social-tags', 'privacy', 'cookie-consent']) assert.ok(ids(clinicR.strengths).includes(id), `the clinic passes ${id}`);
assert.ok(ids(run('salon').notes).includes('security-headers'), 'missing security headers are a note, never a fault');
// Lighthouse 13's shape, read by readPsi: insights with byte savings, a failed accessibility audit, an ARIA one
const lh = { lighthouseResult: { categories: { performance: { score: 0.41 }, accessibility: { score: 0.8 }, 'best-practices': { score: 0.74 }, seo: { score: 0.9 } },
  audits: { 'image-delivery-insight': { score: 0.5, scoreDisplayMode: 'metricSavings', numericValue: 300 * 1024, numericUnit: 'byte', metricSavings: { LCP: 0 } },
    'render-blocking-insight': { score: 0, scoreDisplayMode: 'metricSavings', numericValue: 900, numericUnit: 'millisecond', metricSavings: { FCP: 900, LCP: 900 } },
    'network-dependency-tree-insight': { score: 0, scoreDisplayMode: 'metricSavings', metricSavings: { LCP: 0 } },
    'color-contrast': { score: 0, scoreDisplayMode: 'binary' }, 'aria-roles': { score: 0, scoreDisplayMode: 'binary' }, 'image-alt': { score: 0, scoreDisplayMode: 'binary' },
    'errors-in-console': { score: 0, scoreDisplayMode: 'binary' }, 'csp-xss': { score: 0, scoreDisplayMode: 'informative' } } } };
const ps = readPsi(lh);
assert.deepEqual([ps.performance, ps.accessibility, ps.bestPractices], [41, 80, 74], 'four category scores');
assert.deepEqual(ps.fixes.map((x) => x.id), ['render-blocking-insight', 'image-delivery-insight'], 'fixes ranked by saving, unknown insights left out');
assert.deepEqual(ps.failed.a11y, ['color-contrast', 'aria'], 'accessibility failures, without the checks the report makes itself');
assert.deepEqual(ps.failed.bp, ['errors-in-console'], 'informative audits are not failures');

// Rules version 7 (21 Nov 2026, v2 step 3): the site scan
for (const d of WEBSITE_DEMOS) { const r = run(d.id); assert.ok(r.scan && r.scan.pages >= 6 && r.scan.pages <= 25, `${d.id}: scanned 6 to 25 pages`); }
for (const id of ['site-broken-links', 'site-titles', 'site-thin', 'site-key-pages']) assert.ok(ids(trades.weaknesses).includes(id), `old trade site flags ${id}`);
for (const id of ['site-noindex', 'site-sitemap', 'site-redirects']) assert.ok(ids(relaunch.weaknesses).includes(id), `relaunch flags ${id}`);
assert.equal(relaunch.weaknesses.find((w) => w.id === 'site-redirects').priority, 'medium', 'a two-hop chain is worth fixing');
assert.ok(ids(run('shop').weaknesses).includes('site-sitemap'), 'a product that redirects is flagged in the sitemap');
assert.ok(!ids(run('shop').weaknesses).includes('site-key-pages'), 'a shop isn’t asked for an about page');
assert.ok(!ids(run('restaurant').weaknesses).includes('site-thin'), 'a short booking page is not thin');
assert.ok(ids(clinicR.strengths).includes('site-broken-links') && ids(clinicR.strengths).includes('site-titles'), 'the clinic’s pages all load with their own titles');
assert.equal(analyse({ ...findWebsiteDemo('clinic').input(), pages: null }).scan, null, 'no scan, no site findings (one-page reports still work)');
// robots.txt for the scan, and which links are pages worth reading
const robotsTxt = 'User-agent: *\nDisallow: /private/\nAllow: /private/open$\nDisallow: /*.pdf$\n';
assert.ok(robotsAllows(robotsTxt, 'PhillipsWebsiteCheck', '/about/'));
assert.ok(!robotsAllows(robotsTxt, 'PhillipsWebsiteCheck', '/private/x'));
assert.ok(robotsAllows(robotsTxt, 'PhillipsWebsiteCheck', '/private/open'), 'the longer Allow wins');
assert.ok(!robotsAllows('User-agent: PhillipsWebsiteCheck\nDisallow: /\n', 'PhillipsWebsiteCheck', '/'), 'our own group is obeyed');
assert.equal(internalUrl('/about/#team', 'https://www.a.example/'), 'https://www.a.example/about/');
assert.equal(internalUrl('https://a.example/x', 'https://www.a.example/'), 'https://a.example/x', 'with or without www is the same site');
for (const bad of ['https://other.example/', '/brochure.pdf', '/cart', '/search?q=x', 'mailto:a@b.example', '#top']) assert.equal(internalUrl(bad, 'https://www.a.example/'), null, `${bad} is not scanned`);
assert.equal(pageKey('https://www.a.example/about/'), pageKey('https://a.example/about'), 'one page, one key');

// v2 step 4 (22 Nov 2026): six area scores, out of 100
const withSpeed = (id) => { const i = findWebsiteDemo(id).input(); return { ...analyse(i), speed: { mobile: i.psi.mobile } }; };
for (const d of WEBSITE_DEMOS) {
  const a = areaScores(withSpeed(d.id));
  assert.deepEqual(a.map((x) => x.id), AREAS.map((x) => x[0]), `${d.id}: six areas in order`);
  for (const x of a) assert.ok(x.score === null || (x.score >= 0 && x.score <= 100), `${d.id}: ${x.id} between 0 and 100`);
  assert.equal(a.reduce((n, x) => n + x.fixes, 0), run(d.id).weaknesses.length, `${d.id}: every fix belongs to one area`);
}
assert.ok(areaScores(withSpeed('clinic')).every((x) => x.score === null || x.score >= 94), 'the clinic scores high everywhere');
assert.equal(areaScores(withSpeed('trades')).find((x) => x.id === 'speed').score, 24, 'speed is Google’s phone score');
assert.equal(areaScores(withSpeed('relaunch')).find((x) => x.id === 'seo').score, 33, 'two fix-firsts and two smaller ones: 100 - 25 - 25 - 12 - 5');

// v3 item 1 (22 Nov 2026): before and after
const before = { ...withSpeed('trades'), id: 'a'.repeat(32), checkedAt: '2026-11-01T10:00:00Z' };
const snap = snapshot(before);
assert.ok(!JSON.stringify(snap).includes('<'), 'the snapshot holds no page content');
const fixedIds = ['viewport', 'analytics'];
const after = { ...before, id: 'b'.repeat(32), checkedAt: '2026-11-22T10:00:00Z',
  weaknesses: [...before.weaknesses.filter((w) => !fixedIds.includes(w.id))],
  strengths: [...before.strengths.filter((f) => f.id !== 'contact-top'), ...before.weaknesses.filter((w) => fixedIds.includes(w.id)).map((w) => ({ ...w, status: 'strength' }))] };
after.weaknesses.push({ ...before.strengths.find((f) => f.id === 'contact-top'), status: 'weakness', priority: 'high' });
const cmp = compareChecks(snap, after);
assert.deepEqual(cmp.fixed.map((f) => f.id).sort(), [...fixedIds].sort(), 'two fixes done');
assert.deepEqual(cmp.added.map((f) => f.id), ['contact-top'], 'one new problem, which passed before');
assert.equal(cmp.still, before.weaknesses.length - 2, 'the rest still to do');
assert.ok(cmp.sameRules && cmp.areas.find((a) => a.id === 'technical').after > cmp.areas.find((a) => a.id === 'technical').before, 'Technical went up after adding analytics');
assert.equal(compareChecks(snap, { ...after, model: 'shop' }), null, 'a different kind of business is not compared');
assert.equal(compareChecks(snap, before), null, 'a report is not compared with itself');
const older = compareChecks({ ...snap, rulesVersion: 1 }, after);
assert.ok(!older.sameRules && older.areas.length === 0 && older.fixed.length === 2, 'older rules: fixes listed, scores not compared');
const newCheck = compareChecks({ ...snap, strong: snap.strong.filter((id) => id !== 'contact-top') }, after);
assert.equal(newCheck.added.length, 0, 'a check that wasn’t there before is not called new');

console.log(`website check: ${WEBSITE_DEMOS.length} demo sites pass`);
