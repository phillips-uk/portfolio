// Fixture test for the Google Ads check rules. No network, no API.
// Run: node cloudflare/src/ads-check/rules.test.mjs

import assert from 'node:assert/strict';
import { runRules } from './rules.js';
import { QUERIES, OPTIONAL } from './queries.js';

const CTX = { currency: 'GBP', today: '2026-11-16' };
const micros = (pounds) => String(Math.round(pounds * 1e6));
const CA = (id) => `customers/111/conversionActions/${id}`;

// ---------------------------------------------------------------------------
// Fixture 1: an account with several problems
// ---------------------------------------------------------------------------

function campaignRow(c) {
  return {
    campaign: {
      resourceName: `customers/111/campaigns/${c.id}`,
      id: c.id,
      name: c.name,
      status: 'ENABLED',
      advertisingChannelType: c.channel || 'SEARCH',
      biddingStrategyType: c.bidding,
      ...(c.systemStatus ? { biddingStrategySystemStatus: c.systemStatus } : {}),
      ...(c.targetCpa ? { maximizeConversions: { targetCpaMicros: micros(c.targetCpa) } } : {}),
      networkSettings: { targetSearchNetwork: true, targetContentNetwork: Boolean(c.display) },
      geoTargetTypeSetting: { positiveGeoTargetType: c.geo || 'PRESENCE' },
      campaignBudget: `customers/111/campaignBudgets/${c.id}`,
    },
    campaignBudget: { amountMicros: micros(c.budget) },
    metrics: {
      impressions: String(c.impressions ?? 5000),
      clicks: String(c.clicks ?? 300),
      costMicros: micros(c.spend),
      conversions: c.conversions ?? 0,
      conversionsValue: c.value ?? 0,
      ...(c.sis ? { searchImpressionShare: c.sis, searchBudgetLostImpressionShare: 0.1, searchRankLostImpressionShare: 0.2 } : {}),
    },
  };
}

function keywordRow(k) {
  return {
    adGroupCriterion: {
      criterionId: k.id,
      keyword: { text: k.text, matchType: k.match || 'EXACT' },
      ...(k.qs ? { qualityInfo: { qualityScore: k.qs } } : {}),
    },
    adGroup: { id: k.ag, name: k.agName },
    campaign: { id: k.cid, name: k.cname, advertisingChannelType: 'SEARCH', biddingStrategyType: k.bidding },
  };
}

function adRow(a) {
  return {
    adGroupAd: {
      ad: {
        id: a.id,
        type: 'RESPONSIVE_SEARCH_AD',
        finalUrls: [a.url],
        ...(a.path ? { responsiveSearchAd: { path1: a.path } } : {}),
      },
      adStrength: a.strength,
    },
    adGroup: { id: a.ag, name: a.agName },
    campaign: { id: a.cid, name: a.cname, advertisingChannelType: 'SEARCH' },
  };
}

const problemKeywords = [];
// Ad group 1: 22 broad keywords on manual CPC (oversized, broad on manual).
for (let i = 1; i <= 22; i++) {
  problemKeywords.push({ id: String(100 + i), text: `plumber ely ${i}`, match: 'BROAD', ag: '1', agName: 'Plumbers Ely', cid: '1', cname: 'Generic Plumbing', bidding: 'MANUAL_CPC', qs: i === 1 ? 2 : 6 });
}
// Duplicate keyword across ad groups 2 and 3.
problemKeywords.push({ id: '201', text: 'combi boiler repair', match: 'PHRASE', ag: '2', agName: 'Boiler Repair', cid: '2', cname: 'Boiler Repair', bidding: 'MAXIMIZE_CONVERSIONS', qs: 7 });
problemKeywords.push({ id: '301', text: 'combi boiler repair', match: 'PHRASE', ag: '3', agName: 'Emergency Boilers', cid: '3', cname: 'Emergency', bidding: 'MANUAL_CPC', qs: 8 });

const problem = {
  customer: [{ customer: { id: '111', currencyCode: 'GBP', conversionTrackingSetting: { enhancedConversionsForLeadsEnabled: false } } }],
  conversionActions: [
    { conversionAction: { resourceName: CA(1), id: '1', name: 'Contact form', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_ADS_LAST_CLICK' } } },
    { conversionAction: { resourceName: CA(2), id: '2', name: 'Page view', status: 'ENABLED', type: 'GOOGLE_ANALYTICS_4_CUSTOM', category: 'PAGE_VIEW', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
    { conversionAction: { resourceName: CA(3), id: '3', name: 'Phone calls', status: 'ENABLED', type: 'AD_CALL', category: 'PHONE_CALL_LEAD', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
  ],
  conversionStats: [
    { campaign: { id: '2' }, segments: { conversionAction: CA(2) }, metrics: { allConversions: 50, conversions: 50 } },
    { campaign: { id: '3' }, segments: { conversionAction: CA(3) }, metrics: { allConversions: 3, conversions: 3 } },
  ],
  campaigns: [
    // £1,200 in 30 days on a £40 budget = £40 a day, so capped. No conversions.
    campaignRow({ id: '1', name: 'Generic Plumbing', bidding: 'MANUAL_CPC', budget: 40, spend: 1200, conversions: 0, sis: 0.3, geo: 'PRESENCE_OR_INTEREST', display: true }),
    campaignRow({ id: '2', name: 'Boiler Repair', bidding: 'MAXIMIZE_CONVERSIONS', systemStatus: 'LEARNING_NEW', budget: 100, spend: 300, conversions: 5, sis: 0.6 }),
    campaignRow({ id: '3', name: 'Emergency', bidding: 'MANUAL_CPC', budget: 100, spend: 500, conversions: 35, sis: 0.7 }),
  ],
  keywords: problemKeywords.map(keywordRow),
  keywordStats: [
    { adGroup: { id: '1' }, adGroupCriterion: { criterionId: '101' }, metrics: { impressions: '900', clicks: '40', costMicros: micros(20), conversions: 0 } },
    { adGroup: { id: '1' }, adGroupCriterion: { criterionId: '102' }, metrics: { impressions: '400', clicks: '20', costMicros: micros(15), conversions: 0 } },
  ],
  negativeKeywords: [{ campaign: { id: '3' } }],
  negativeKeywordLists: [],
  accountNegativeLists: undefined, // optional query that failed
  searchTerms: [
    { searchTermView: { searchTerm: 'plumbing apprenticeship jobs' }, campaign: { id: '1', name: 'Generic Plumbing' }, adGroup: { name: 'Plumbers Ely' }, metrics: { impressions: '300', clicks: '20', costMicros: micros(30), conversions: 0 } },
    { searchTermView: { searchTerm: 'plumbing apprenticeship salary' }, campaign: { id: '1', name: 'Generic Plumbing' }, adGroup: { name: 'Plumbers Ely' }, metrics: { impressions: '200', clicks: '9', costMicros: micros(12), conversions: 0 } },
    { searchTermView: { searchTerm: 'plumber ely prices' }, campaign: { id: '1', name: 'Generic Plumbing' }, adGroup: { name: 'Plumbers Ely' }, metrics: { impressions: '100', clicks: '6', costMicros: micros(8), conversions: 0 } },
    { searchTermView: { searchTerm: 'diy tap washer' }, campaign: { id: '1', name: 'Generic Plumbing' }, adGroup: { name: 'Plumbers Ely' }, metrics: { impressions: '90', clicks: '5', costMicros: micros(6), conversions: 0 } },
    { searchTermView: { searchTerm: 'emergency plumber ely' }, campaign: { id: '3', name: 'Emergency' }, adGroup: { name: 'Emergency Boilers' }, metrics: { impressions: '500', clicks: '40', costMicros: micros(60), conversions: 6 } },
  ],
  assetGroups: undefined, // optional query that failed
  ads: [
    adRow({ id: '11', ag: '1', agName: 'Plumbers Ely', cid: '1', cname: 'Generic Plumbing', strength: 'POOR', url: 'https://example.co.uk/' }),
    adRow({ id: '21', ag: '2', agName: 'Boiler Repair', cid: '2', cname: 'Boiler Repair', strength: 'AVERAGE', url: 'https://example.co.uk/' }),
    adRow({ id: '22', ag: '2', agName: 'Boiler Repair', cid: '2', cname: 'Boiler Repair', strength: 'GOOD', url: 'https://example.co.uk' }),
    adRow({ id: '31', ag: '3', agName: 'Emergency Boilers', cid: '3', cname: 'Emergency', strength: 'EXCELLENT', url: 'https://example.co.uk/emergency/', path: 'emergency' }),
  ],
  customerAssets: [],
  campaignAssets: [],
  adGroups: [
    { adGroup: { id: '1', name: 'Plumbers Ely' }, campaign: { id: '1', name: 'Generic Plumbing' } },
    { adGroup: { id: '2', name: 'Boiler Repair' }, campaign: { id: '2', name: 'Boiler Repair' } },
    { adGroup: { id: '3', name: 'Emergency Boilers' }, campaign: { id: '3', name: 'Emergency' } },
    { adGroup: { id: '4', name: 'Old Offers \u2013 2024' }, campaign: { id: '1', name: 'Generic Plumbing' } }, // en dash in a name
  ],
  audienceCriteria: [],
  campaignCriteria: [],
  products: undefined,
};

// ---------------------------------------------------------------------------
// Fixture 2: a mostly healthy account
// ---------------------------------------------------------------------------

const healthyKeywords = [
  ...['boiler service ely', 'boiler service cambridge', 'gas safety check ely', 'boiler servicing near me', 'annual boiler service'].map((t, i) => ({ id: String(500 + i), text: t, match: 'EXACT', ag: '10', agName: 'Boiler Service', cid: '10', cname: 'Services Ely', bidding: 'MAXIMIZE_CONVERSIONS', qs: 7 + (i % 3) })),
  ...['plumber ely', 'emergency plumber ely', 'local plumber ely'].map((t, i) => ({ id: String(600 + i), text: t, match: 'PHRASE', ag: '11', agName: 'Plumbers', cid: '10', cname: 'Services Ely', bidding: 'MAXIMIZE_CONVERSIONS', qs: 8 })),
];

const products = [];
for (let i = 1; i <= 10; i++) {
  products.push({
    segments: {
      productItemId: `sku-${i}`,
      productTitle: `Combi Boiler Service Kit Model ${i} with Filters and Seals`,
      productTypeL1: 'Boiler parts',
      productBrand: 'Example',
      productCustomAttribute0: i <= 3 ? 'hero' : 'standard',
    },
    metrics: { impressions: '400', clicks: '20', costMicros: micros(i <= 8 ? 30 : 4), conversions: i <= 8 ? 2 : 0, conversionsValue: 200 },
  });
}

const healthy = {
  customer: [{ customer: { id: '222', currencyCode: 'GBP', conversionTrackingSetting: { enhancedConversionsForLeadsEnabled: true } } }],
  conversionActions: [
    { conversionAction: { resourceName: CA(10), id: '10', name: 'Enquiry form', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
    { conversionAction: { resourceName: CA(11), id: '11', name: 'Purchase', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
    { conversionAction: { resourceName: CA(12), id: '12', name: 'Scroll depth', status: 'ENABLED', type: 'GOOGLE_ANALYTICS_4_CUSTOM', category: 'ENGAGEMENT', primaryForGoal: false, includeInConversionsMetric: false } },
  ],
  conversionStats: [
    { campaign: { id: '10' }, segments: { conversionAction: CA(10) }, metrics: { allConversions: 40, conversions: 40 } },
    { campaign: { id: '20' }, segments: { conversionAction: CA(11) }, metrics: { allConversions: 20, conversions: 20 } },
  ],
  campaigns: [
    campaignRow({ id: '10', name: 'Services Ely', bidding: 'MAXIMIZE_CONVERSIONS', targetCpa: 40, systemStatus: 'ENABLED', budget: 50, spend: 900, conversions: 40, sis: 0.7 }),
    campaignRow({ id: '20', name: 'PMax Shop', channel: 'PERFORMANCE_MAX', bidding: 'MAXIMIZE_CONVERSION_VALUE', systemStatus: 'ENABLED', budget: 40, spend: 600, conversions: 20, value: 2400 }),
  ],
  keywords: healthyKeywords.map(keywordRow),
  keywordStats: healthyKeywords.map((k) => ({ adGroup: { id: k.ag }, adGroupCriterion: { criterionId: k.id }, metrics: { impressions: '500', clicks: '30', costMicros: micros(40), conversions: 2 } })),
  negativeKeywords: [{ campaign: { id: '10' } }, { campaign: { id: '10' } }],
  negativeKeywordLists: [],
  accountNegativeLists: [],
  searchTerms: [
    { searchTermView: { searchTerm: 'boiler service ely' }, campaign: { id: '10', name: 'Services Ely' }, adGroup: { name: 'Boiler Service' }, metrics: { impressions: '400', clicks: '30', costMicros: micros(45), conversions: 4 } },
    { searchTermView: { searchTerm: 'plumber ely reviews' }, campaign: { id: '10', name: 'Services Ely' }, adGroup: { name: 'Plumbers' }, metrics: { impressions: '100', clicks: '5', costMicros: micros(6), conversions: 0 } },
  ],
  assetGroups: [
    { assetGroup: { id: '1', name: 'All products', adStrength: 'GOOD' }, campaign: { id: '20', name: 'PMax Shop' } },
    { assetGroup: { id: '2', name: 'Boiler parts', adStrength: 'EXCELLENT' }, campaign: { id: '20', name: 'PMax Shop' } },
  ],
  ads: [
    adRow({ id: '101', ag: '10', agName: 'Boiler Service', cid: '10', cname: 'Services Ely', strength: 'GOOD', url: 'https://example.co.uk/boiler-service/', path: 'boiler-service' }),
    adRow({ id: '102', ag: '10', agName: 'Boiler Service', cid: '10', cname: 'Services Ely', strength: 'EXCELLENT', url: 'https://example.co.uk/boiler-service/', path: 'boiler-service' }),
    adRow({ id: '111', ag: '11', agName: 'Plumbers', cid: '10', cname: 'Services Ely', strength: 'EXCELLENT', url: 'https://example.co.uk/plumber-ely/', path: 'plumber' }),
  ],
  customerAssets: [{ customerAsset: { fieldType: 'SITELINK', status: 'ENABLED' } }, { customerAsset: { fieldType: 'CALLOUT', status: 'ENABLED' } }],
  campaignAssets: [],
  adGroups: [
    { adGroup: { id: '10', name: 'Boiler Service' }, campaign: { id: '10', name: 'Services Ely' } },
    { adGroup: { id: '11', name: 'Plumbers' }, campaign: { id: '10', name: 'Services Ely' } },
  ],
  audienceCriteria: [{ campaign: { id: '10' }, adGroup: { id: '10' }, adGroupCriterion: { type: 'USER_LIST' } }],
  campaignCriteria: [],
  products,
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const ALLOWED_LINKS = new Set([
  null,
  '/guides/fix-google-ads-conversion-tracking/',
  '/guides/ga4-imports-break-smart-bidding/',
  '/guides/google-ads-bidding-strategy/',
  '/guides/improve-google-ads-quality-score/',
  '/guides/target-cpa-few-conversions/',
  '/google-ads/',
  '/marketing-systems/',
]);
const CATEGORIES = new Set(['tracking', 'structure', 'settings', 'keywords', 'search-terms', 'ads', 'bidding', 'shopping']);
const FIX_TYPES = new Set(['settings', 'negatives', 'ad_copy', 'tracking', 'structure', 'bidding', 'shopping', 'keywords']);
const PRIORITIES = ['high', 'medium', 'low'];
const BANNED_WORDS = /\b(delve|leverage|robust|seamless|crucial|it's important to note)\b/i;

function allStrings(value, path = 'result', found = []) {
  if (typeof value === 'string') found.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => allStrings(v, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) allStrings(v, `${path}.${k}`, found);
  return found;
}

function checkShape(result, label) {
  assert.ok(Array.isArray(result.strengths), `${label}: strengths is an array`);
  assert.ok(Array.isArray(result.weaknesses), `${label}: weaknesses is an array`);
  assert.equal(typeof result.facts, 'object', `${label}: facts is an object`);

  for (const f of [...result.strengths, ...result.weaknesses]) {
    assert.match(f.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${label}: id is kebab case (${f.id})`);
    assert.ok(CATEGORIES.has(f.category), `${label}: category on ${f.id}`);
    assert.ok(PRIORITIES.includes(f.priority), `${label}: priority on ${f.id}`);
    assert.ok(f.title && f.detail, `${label}: title and detail on ${f.id}`);
    assert.ok(ALLOWED_LINKS.has(f.startLink ?? null), `${label}: startLink on ${f.id}`);
  }
  for (const w of result.weaknesses) {
    assert.ok(FIX_TYPES.has(w.fixType), `${label}: fixType on ${w.id}`);
    assert.ok(Number.isInteger(w.items) && w.items >= 1, `${label}: items on ${w.id} is an integer >= 1`);
    assert.ok(typeof w.itemLabel === 'string' && w.itemLabel.length > 0, `${label}: itemLabel on ${w.id}`);
    assert.ok(typeof w.why === 'string' && w.why.length > 10, `${label}: why on ${w.id}`);
    assert.ok(typeof w.start === 'string' && w.start.length > 10, `${label}: start on ${w.id}`);
    assert.equal(typeof w.fromPrice, 'boolean', `${label}: fromPrice on ${w.id}`);
  }

  // Sorted high, medium, low.
  const ranks = result.weaknesses.map((w) => PRIORITIES.indexOf(w.priority));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${label}: weaknesses sorted by priority`);

  // No long dashes and no banned words in any string.
  for (const [path, s] of allStrings(result)) {
    assert.ok(!s.includes('\u2014') && !s.includes('\u2013'), `${label}: dash in ${path}: ${s}`);
    assert.ok(!BANNED_WORDS.test(s), `${label}: banned word in ${path}: ${s}`);
  }
}

const ids = (list) => list.map((f) => f.id);

// Queries file sanity.
assert.ok(Object.keys(QUERIES).length >= 15 && Object.keys(QUERIES).length <= 25, 'between 15 and 25 queries');
for (const name of OPTIONAL) assert.ok(QUERIES[name], `optional query ${name} exists`);
for (const [name, gaql] of Object.entries(QUERIES)) {
  assert.match(gaql, /^SELECT .+ FROM [a-z_]+/, `${name} looks like GAQL`);
  assert.ok(!/[\u2013\u2014]/.test(gaql), `${name} has no long dashes`);
}

// Fixture 1.
const bad = runRules(problem, CTX);
checkShape(bad, 'problem account');
const badIds = ids(bad.weaknesses);
const expectedProblems = [
  'silent-conversion-actions', 'attribution-model', 'micro-conversions-primary', 'enhanced-conversions',
  'spend-no-conversions', 'budget-limited', 'learning-phase', 'manual-cpc-ready-for-smart-bidding',
  'location-presence', 'search-display-network',
  'low-quality-score', 'duplicate-keywords', 'broad-match-manual-bidding', 'no-negative-keywords',
  'search-term-waste', 'max-conversions-no-target',
  'single-weak-ad', 'weak-rsa-strength', 'missing-sitelinks-callouts', 'rsa-display-paths',
  'bloated-ad-groups', 'empty-ad-groups', 'homepage-landing-pages',
  'no-audiences', 'no-device-adjustments', 'no-schedule-adjustments',
];
for (const id of expectedProblems) assert.ok(badIds.includes(id), `problem account flags ${id}`);

// N-gram waste guards (18 Nov 2026). The problem account's "apprenticeship" spent £42 against a £50 average cost per
// conversion, so it is not yet proven waste; "plumbing" is the business's own word and is never put forward.
assert.ok(!badIds.includes('ngram-waste'), 'n-grams under one cost per conversion are not called waste');
{
  const pm = (t, cost, conv) => ({ campaignSearchTermView: { searchTerm: t }, campaign: { id: '9', name: 'PMax' }, metrics: { impressions: '100', clicks: '10', costMicros: String(cost * 1e6), conversions: conv } });
  const withPmax = runRules({ ...problem, pmaxSearchTerms: [
    pm('plumbing apprenticeship course', 40, 0), pm('apprenticeship wages', 35, 0),
    pm('plumbers near me', 60, 0), pm('plumber quotes', 55, 0),
  ] }, { currency: 'GBP', today: '2026-11-18' });
  const ng = withPmax.ngrams;
  const words = ng.wasted.map((w) => w.text);
  assert.ok(words.includes('apprenticeship'), 'an off-topic word over one cost per conversion is listed');
  assert.ok(!words.some((w) => /plumb/.test(w)), 'the business\'s own words (and their plurals) are never listed');
  assert.ok(ng.ownLeftOut >= 1, 'own words left out are counted for the note');
  assert.equal(ng.minSpend, 50, 'the bar is the account cost per conversion');
  assert.ok(withPmax.weaknesses.some((w) => w.id === 'ngram-waste'), 'the finding uses the same guards');
}
assert.equal(new Set(badIds).size, badIds.length, 'no duplicate weakness ids');

// How the account is read (18 Nov 2026): lead goals, Search only, grouped by role, what it sells from ad groups.
{
  const p = bad.profile;
  assert.equal(p.model, 'leads', 'lead goals read as a lead business');
  assert.equal(p.groups.length, 1, 'all Search, one group');
  assert.equal(p.groups[0].label, 'Search · Non-brand', 'non-brand Search');
  assert.equal(p.groups[0].campaigns.length, 3, 'three campaigns in the group');
  assert.ok(p.sells.length > 0 && p.sellsFrom === 'ad groups', 'what it sells comes from the ad groups');
  assert.ok(/enquiries/.test(p.summary) && !/\u2014/.test(p.summary), 'summary names the model, no long dashes');
}

const byId = Object.fromEntries(bad.weaknesses.map((w) => [w.id, w]));
assert.equal(byId['no-negative-keywords'].items, 2, 'two campaigns lack negatives');
assert.equal(byId['search-term-waste'].items, 3, 'three off-target search terms');
assert.equal(byId['empty-ad-groups'].items, 1, 'one empty ad group');
assert.equal(byId['duplicate-keywords'].items, 1, 'one duplicated keyword');
assert.equal(byId['silent-conversion-actions'].items, 1, 'one silent primary action');
assert.equal(byId['silent-conversion-actions'].fromPrice, true, 'tracking fix is a from price');
assert.equal(byId['micro-conversions-primary'].items, 1, 'one micro conversion as primary');
assert.ok(byId['empty-ad-groups'].detail.includes('Old Offers - 2024'), 'en dash in account names is replaced');
assert.ok(byId['spend-no-conversions'].detail.includes('£1,200'), 'spend shown in pounds');
assert.equal(bad.facts.spend30, 2000, 'facts: 30-day spend');
assert.equal(bad.facts.campaigns, 3, 'facts: campaigns');
assert.equal(bad.facts.keywords, 24, 'facts: keywords');

// Fixture 2.
const good = runRules(healthy, CTX);
checkShape(good, 'healthy account');
const goodIds = ids(good.weaknesses);
for (const id of expectedProblems) assert.ok(!goodIds.includes(id), `healthy account does not flag ${id}`);
const expectedStrengths = [
  'conversion-tracking', 'attribution-model', 'micro-conversions-primary', 'enhanced-conversions',
  'spend-no-conversions', 'budget-limited', 'learning-phase', 'manual-cpc-ready-for-smart-bidding',
  'location-presence', 'search-display-network', 'low-quality-score', 'duplicate-keywords',
  'no-negative-keywords', 'search-term-waste', 'pmax-asset-strength', 'max-conversions-no-target',
  'single-weak-ad', 'weak-rsa-strength', 'missing-sitelinks-callouts', 'rsa-display-paths',
  'bloated-ad-groups', 'empty-ad-groups', 'homepage-landing-pages', 'no-audiences', 'bid-adjustments',
  'shopping-wasted-spend', 'shopping-missing-product-type', 'shopping-short-titles', 'shopping-no-custom-labels',
];
for (const id of expectedStrengths) assert.ok(ids(good.strengths).includes(id), `healthy account shows strength ${id}`);
assert.equal(good.weaknesses.length, 0, `healthy account has no weaknesses (got ${goodIds.join(', ')})`);

// Empty and missing data must not throw.
const empty = runRules({}, CTX);
checkShape(empty, 'empty account');
assert.equal(empty.weaknesses.length, 0, 'no data, no weaknesses');
const noTracking = runRules({ ...problem, conversionActions: [], conversionStats: [] }, CTX);
checkShape(noTracking, 'no tracking');
assert.ok(ids(noTracking.weaknesses).includes('conversion-tracking-missing'), 'no conversion actions is flagged');
assert.ok(!ids(noTracking.weaknesses).includes('spend-no-conversions'), 'spend with no conversions is not repeated when tracking is missing');

console.log(`problem account: ${bad.weaknesses.length} weaknesses, ${bad.strengths.length} strengths`);
for (const w of bad.weaknesses) console.log(`  [${w.priority}] ${w.id} (${w.fixType}, ${w.items} ${w.itemLabel})`);
console.log(`healthy account: ${good.weaknesses.length} weaknesses, ${good.strengths.length} strengths`);
console.log('facts (problem):', JSON.stringify(bad.facts));
console.log('All rules tests passed.');
