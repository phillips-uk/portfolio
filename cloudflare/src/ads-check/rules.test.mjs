// Fixture test for the Google Ads check rules. No network, no API.
// Run: node cloudflare/src/ads-check/rules.test.mjs

import assert from 'node:assert/strict';
import { runRules, actionPlan } from './rules.js';
import { QUERIES, OPTIONAL, queriesFor } from './queries.js';
import { checkUrls, landingPages, MAX as URL_MAX } from './urls.js';
import { DEMOS, findDemo } from './demos.js';

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
assert.ok(Object.keys(QUERIES).length >= 15 && Object.keys(QUERIES).length <= 32, 'between 15 and 32 queries');
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
// Demo clients (/admin#demos): every one runs, has a profile, and the cases they caught stay fixed.
for (const d of DEMOS) {
  const r = runRules(d.data(), CTX);
  checkShape(r, `demo ${d.id}`);
  assert.ok(r.profile && r.profile.groups.length, `demo ${d.id} has an account profile`);
}
const demo = (id) => runRules(findDemo(id).data(), CTX);
assert.ok(demo('retailer').profile.groups.some((g) => g.label === 'Search · Brand'), 'underscore names: UK_Search_Brand_Exact reads as brand');
assert.deepEqual(demo('national').profile.sells, ['Windows', 'Solar', 'Conservatories', 'Roofing'], 'regions and competitor ad groups are left out of what it sells');
assert.deepEqual(demo('clinic').profile.sells, ['Implants', 'Invisalign', 'Emergency', 'Whitening'], '"Implants prices" folds into "Implants"');
assert.deepEqual(demo('trades').profile.sells, [], '"Ad group 1" is not a product');
assert.equal(demo('clinic').weaknesses.length, 0, 'the clinic demo is clean');
assert.equal(findDemo('2').id, 'mixed'); assert.equal(findDemo('1').id, 'problem');
console.log(`demo clients: ${DEMOS.length} run cleanly`);

// AI-assisted pricing (Lewis, 19 Nov 2026): every demo's price list has the one-hour start, judgement fixes keep the
// time by hand, and AI-assisted fixes can cost less than an hour.
{
  const { quote, getPricing, HUMAN_ONLY } = await import('../pricing.js');
  const pricing = await getPricing({});
  const hour = Math.round(pricing.settings.dayRate / pricing.settings.hoursPerDay);
  let cheap = 0;
  for (const d of DEMOS) {
    const q = quote(pricing, demo(d.id).weaknesses);
    if (!q.lines.length) { assert.equal(q.total, 0, d.id + ': nothing to fix, nothing to pay'); continue; }
    assert.equal(q.start.price, hour, d.id + ': one hour to start');
    assert.equal(q.total, q.start.price + q.lines.reduce((a, l) => a + l.price, 0), d.id + ': total is the start plus the fixes');
    for (const l of q.lines) {
      if (['tracking', 'structure', 'bidding'].includes(l.fixType) || HUMAN_ONLY.has(l.id)) assert.ok(!l.ai && l.minutes === l.humanMinutes, `${d.id}: ${l.id} keeps the time by hand`);
      if (l.ai && l.price < hour) cheap++;
    }
  }
  assert.ok(cheap > 0, 'some AI-assisted fixes cost less than an hour');
  console.log(`pricing: ${cheap} AI-assisted fixes under an hour across the demos`);
}

// ---------------------------------------------------------------------------
// The deeper checks (21 Nov 2026): one test each, on the healthy account with one thing changed.
// ---------------------------------------------------------------------------
{
  const run = (extra, ctx = {}) => { const r = runRules({ ...healthy, ...extra }, { ...CTX, ...ctx }); checkShape(r, 'deep'); return r; };
  const weak = (r, id) => r.weaknesses.find((w) => w.id === id);
  const strong = (r, id) => r.strengths.find((w) => w.id === id);

  // Every dated query gets its dates; nothing is left as a placeholder.
  const dated = queriesFor('2026-11-21');
  for (const [name, g] of Object.entries(dated)) assert.ok(!/\{[A-Z0-9]+\}/.test(g), `${name}: dates filled in`);
  assert.match(dated.monthly13, /BETWEEN '2025-11-01' AND '2026-11-20'/, '13 months from the first of the month a year ago to yesterday');
  assert.match(dated.segments90, /BETWEEN '2026-08-23' AND '2026-11-20'/, '90 days to yesterday');
  assert.match(dated.changes, />= '2026-10-24 00:00:00'/, '28 days of change history');
  assert.ok(!/user_email/.test(dated.changes), 'change history never reads who made the change');

  // 13a. Double-counted conversions: a GA4 copy of the purchase, with a close count, is high; one purchase action is a strength.
  assert.ok(strong(run({}), 'double-counting'), 'one purchase action: counted once');
  const ga4 = { conversionAction: { resourceName: CA(13), id: '13', name: 'GA4 purchase', status: 'ENABLED', type: 'GOOGLE_ANALYTICS_4_PURCHASE', category: 'PURCHASE', primaryForGoal: true, includeInConversionsMetric: true } };
  let r = run({ conversionActions: [...healthy.conversionActions, ga4], conversionStats: [...healthy.conversionStats, { campaign: { id: '20' }, segments: { conversionAction: CA(13) }, metrics: { allConversions: 19, conversions: 19 } }] });
  assert.equal(weak(r, 'double-counting')?.priority, 'high', 'tag plus GA4 purchase: high');
  assert.match(weak(r, 'double-counting').detail, /Google Ads tag.*Google Analytics 4 import/, 'names both sources');
  // Two different lead forms from the tag are normal, not double counting.
  const form2 = { conversionAction: { resourceName: CA(14), id: '14', name: 'Quote form', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true, includeInConversionsMetric: true } };
  r = run({ conversionActions: [...healthy.conversionActions, form2], conversionStats: [...healthy.conversionStats, { campaign: { id: '10' }, segments: { conversionAction: CA(14) }, metrics: { allConversions: 12, conversions: 12 } }] });
  assert.ok(!weak(r, 'double-counting'), 'two tag lead forms are not flagged');

  // 13b. Negatives against the account's own keywords, by Google's matching rules.
  const neg = (text, matchType) => ({ campaign: { id: '10' }, campaignCriterion: { keyword: { text, matchType } } });
  r = run({ campaignNegatives: [neg('boiler service', 'PHRASE')] });
  assert.equal(weak(r, 'negatives-block-keywords')?.items, 1, 'one negative');
  assert.match(weak(r, 'negatives-block-keywords').detail, /^3 keywords/, 'phrase "boiler service" blocks 3 keywords (not "boiler servicing near me")');
  r = run({ campaignNegatives: [neg('ely boiler', 'BROAD')] });
  assert.match(weak(r, 'negatives-block-keywords').detail, /^1 keyword /, 'broad: all the words in any order');
  r = run({ campaignNegatives: [neg('plumber ely', 'EXACT'), neg('jobs', 'BROAD')] });
  assert.match(weak(r, 'negatives-block-keywords').detail, /^1 keyword /, 'exact blocks only the same words');
  r = run({ campaignNegatives: [neg('jobs', 'PHRASE')], adGroupNegatives: [{ adGroup: { id: '11' }, campaign: { id: '10' }, adGroupCriterion: { keyword: { text: 'boiler', matchType: 'BROAD' } } }] });
  assert.ok(!weak(r, 'negatives-block-keywords') && strong(r, 'negatives-block-keywords'), 'an ad group negative only applies to its ad group');
  r = run({ negativeKeywordLists: [{ campaign: { id: '10' }, sharedSet: { id: '77' } }], sharedNegatives: [{ sharedSet: { id: '77' }, sharedCriterion: { keyword: { text: 'emergency', matchType: 'BROAD' } } }] });
  assert.ok(weak(r, 'negatives-block-keywords'), 'a shared list attached to the campaign counts');

  // 13c. Held back by budget and beating the target: its own finding, with a suggested budget, and not repeated.
  const capped = campaignRow({ id: '10', name: 'Services Ely', bidding: 'MAXIMIZE_CONVERSIONS', targetCpa: 40, systemStatus: 'ENABLED', budget: 50, spend: 900, conversions: 40, sis: 0.6 });
  capped.metrics.searchBudgetLostImpressionShare = 0.2;
  r = run({ campaigns: [capped, healthy.campaigns[1]] }, { target: { type: 'cpa', value: 30 } });
  const bw = weak(r, 'budget-limited-winners');
  assert.ok(bw, 'beats the £30 target (£22.50) and loses 20% to budget');
  assert.match(bw.detail, /Suggested daily budget £67 \(now £50\)/, 'budget raised by the share lost: 50 x 0.8 / 0.6');
  assert.ok(!weak(r, 'budget-limited') && !weak(r, 'low-impression-share'), 'not reported twice');
  r = run({ campaigns: [capped, healthy.campaigns[1]] }, { target: { type: 'cpa', value: 15 } });
  assert.ok(!weak(r, 'budget-limited-winners'), 'misses a £15 target: no growth finding');

  // 13d. Over-pinned headlines.
  const rsa = (pins) => ({ adGroupAd: { ad: { id: '1', responsiveSearchAd: { headlines: Array.from({ length: 8 }, (_, i) => ({ text: 'H' + i, ...(pins[i] ? { pinnedField: pins[i] } : {}) })) } } }, adGroup: { id: '10', name: 'Boiler Service' }, campaign: { id: '10', name: 'Services Ely' } });
  r = run({ rsaHeadlines: [rsa(['HEADLINE_1'])] });
  assert.ok(strong(r, 'over-pinned-ads'), 'one pin (the brand in position 1) is fine');
  r = run({ rsaHeadlines: [rsa(['HEADLINE_1', 'HEADLINE_2']), rsa([])] });
  assert.equal(weak(r, 'over-pinned-ads')?.priority, 'medium', 'two positions locked to one headline each, on half the ads');

  // 13e. Landing pages: 404 and 5xx are broken, a 403 (a site turning bots away) is not.
  r = run({ urlChecks: { pages: [{ url: 'https://example.co.uk/a/', ads: 3, status: 404, state: 'broken' }, { url: 'https://example.co.uk/b/', ads: 1, status: 403, state: 'blocked' }, { url: 'https://example.co.uk/', ads: 2, status: 200, state: 'ok' }], total: 3, skipped: 0 } });
  assert.equal(weak(r, 'broken-landing-pages')?.items, 1, 'one broken page');
  assert.match(weak(r, 'broken-landing-pages').detail, /not found, used by 3 ads/, 'says why and how many ads');
  r = run({ urlChecks: { pages: [{ url: 'https://example.co.uk/', ads: 2, status: 200, state: 'ok' }], total: 1, skipped: 0 } });
  assert.ok(strong(r, 'broken-landing-pages'), 'all pages load');

  // 13f. Search Partners and devices, 90 days, against the 90-day average (or the target). The Search campaign
  // alone, so the account is judged on cost per conversion.
  const seg = (net, device, spend, conv, ch = 'SEARCH') => ({ campaign: { id: '10', advertisingChannelType: ch }, segments: { adNetworkType: net, device }, metrics: { impressions: '1000', clicks: String(Math.round(spend / 2)), costMicros: micros(spend), conversions: conv, conversionsValue: 0 } });
  r = run({ campaigns: [healthy.campaigns[0]], segments90: [seg('SEARCH', 'MOBILE', 1500, 50), seg('SEARCH', 'DESKTOP', 1200, 45), seg('SEARCH_PARTNERS', 'MOBILE', 400, 2)] });
  const sp = weak(r, 'search-partners-below-average');
  assert.ok(sp && sp.atStake && sp.atStake.amount > 0, 'Search Partners at £200 a conversion against about £32: flagged with money at stake');
  assert.ok(!weak(r, 'device-below-average'), 'devices within range');
  r = run({ campaigns: [healthy.campaigns[0]], segments90: [seg('SEARCH', 'MOBILE', 1500, 15), seg('SEARCH', 'DESKTOP', 1200, 60)] });
  assert.match(weak(r, 'device-below-average')?.title || '', /^Mobile costs far more/, 'mobile at £100 against £36 average');
  r = run({ campaigns: [healthy.campaigns[0]], segments90: [seg('SEARCH', 'MOBILE', 150, 2), seg('SEARCH', 'DESKTOP', 120, 4)] });
  assert.ok(!weak(r, 'device-below-average'), 'under 10 conversions in 90 days: no call');

  // 13g. Brand searches in Performance Max, from the brand name the visitor gives.
  const pm = (t, cost, conv) => ({ campaignSearchTermView: { searchTerm: t }, campaign: { id: '20', name: 'PMax Shop' }, metrics: { impressions: '100', clicks: '10', costMicros: micros(cost), conversions: conv } });
  const pmaxSearchTerms = [pm('acme heating', 60, 6), pm('acme heating reviews', 25, 1), pm('boiler parts', 200, 8)];
  assert.ok(!weak(run({ pmaxSearchTerms }), 'pmax-brand-terms'), 'no brand campaign and no brand name: not judged');
  r = run({ pmaxSearchTerms }, { brand: 'Acme Heating' });
  assert.match(weak(r, 'pmax-brand-terms')?.detail || '', /£85 .*"acme heating"/, 'the brand name finds £85 of brand searches');

  // 13h. Change history: none at all, and campaigns off target that nobody changed.
  r = run({ changes: [] });
  assert.ok(weak(r, 'no-recent-changes'), 'no changes in 28 days on £1,500 of spend');
  const change = (cid) => ({ changeEvent: { changeDateTime: '2026-11-10 10:00:00', changeResourceType: 'CAMPAIGN_BUDGET', resourceChangeOperation: 'UPDATE', clientType: 'GOOGLE_ADS_WEB_CLIENT', campaign: `customers/222/campaigns/${cid}` } });
  r = run({ changes: [change('20')] }, { target: { type: 'cpa', value: 15 } });
  const off = weak(r, 'off-target-campaigns');
  assert.ok(off && /Services Ely.*no changes in 28 days/.test(off.detail), '£22.50 against a £15 target, untouched');
  assert.equal(off.items, 2, 'with a target, every campaign off it is listed, changed or not');
  assert.equal(off.atStake.amount, 600, 'money at stake is the spend past the target: (900 - 40 x 15) + (600 - 20 x 15)');
  assert.match(off.detail, /1 of them has had no changes/, 'and says which were left alone');
  assert.equal(r.changes.total, 1); assert.equal(r.changes.campaignsChanged, 1); assert.ok(!('byCampaign' in r.changes), 'the per-campaign map stays inside');
  r = run({ changes: [change('10'), change('20')] });
  assert.ok(!weak(r, 'off-target-campaigns') && !weak(r, 'no-recent-changes'), 'no target and on average: nothing to say');

  // 13i. Customer Match lists with almost no members.
  r = run({ customerMatch: [{ userList: { name: 'Old customers', membershipStatus: 'OPEN', sizeForSearch: '0', sizeForDisplay: '40', membershipLifeSpan: '540' } }, { userList: { name: 'All customers', membershipStatus: 'OPEN', sizeForSearch: '5200', sizeForDisplay: '6100' } }] });
  assert.match(weak(r, 'customer-match-empty')?.detail || '', /"Old customers" has fewer than 100.*540 days/, 'the small list, and how long members stay');

  // The funnel: the last 30 days against the 60 before, and which lever moved most.
  const daily = []; const t0 = Date.parse('2026-11-16T12:00:00Z');
  for (let i = 90; i >= 1; i--) { const recent = i <= 30; daily.push({ segments: { date: new Date(t0 - i * 86400000).toISOString().slice(0, 10) }, metrics: { impressions: '1000', clicks: '50', costMicros: micros(recent ? 100 : 100), conversions: recent ? 1.5 : 2 } }); }
  r = run({ campaigns: [healthy.campaigns[0]], daily90: daily });
  assert.equal(r.trend.funnel.lever.key, 'cvr', 'same cost per click, fewer conversions: conversion rate is the lever');
  assert.match(r.trend.funnel.lever.text, /rose 33%/, 'cost per conversion up a third');
  assert.equal(r.trend.funnel.recent.days, 30); assert.equal(r.trend.funnel.prior.days, 60);
  assert.ok(r.headline.some((x) => /conversion rate/.test(x)), 'the headline mentions it');

  // Headline and plan: rules write them; the plan ranks by impact (money against spend), then money, then effort.
  const ws = [
    { id: 'a', title: 'A', priority: 'low', atStake: { amount: 400 } },
    { id: 'b', title: 'B', priority: 'high' },
    { id: 'c', title: 'C', priority: 'medium', atStake: { amount: 20 } },
    { id: 'd', title: 'D', priority: 'high', atStake: { amount: 50 } },
  ];
  const plan = actionPlan(ws, { lines: [{ id: 'b', hours: 3 }, { id: 'd', hours: 0.5 }] }, 2000);
  assert.deepEqual(plan.map((p) => p.id), ['a', 'd', 'b', 'c'], '£400 on £2,000 of spend is high impact and first');
  assert.equal(plan[1].effort, 'quick'); assert.equal(plan[2].effort, 'medium'); assert.equal(plan[0].effort, null);
  for (const d of DEMOS) {
    const rr = runRules(d.data('2026-11-16'), { ...CTX, target: d.target });
    assert.ok(rr.headline.length >= 2 && rr.headline.every((x) => !/[–—]/.test(x)), `${d.id}: a headline with no long dashes`);
    assert.ok(rr.trend && rr.trend.months.length === 13, `${d.id}: 13 months of trend`);
  }
  console.log('deeper checks: double counting, negatives, budget winners, pins, landing pages, segments, brand in PMax, change history, Customer Match, funnel, plan');
}

// The demo reports show the new checks (so Lewis can review them in /admin#demos).
{
  const found = new Set();
  for (const d of DEMOS) { const rr = runRules(d.data('2026-11-16'), { ...CTX, target: d.target }); rr.weaknesses.forEach((w) => found.add(w.id)); }
  for (const id of ['double-counting', 'negatives-block-keywords', 'budget-limited-winners', 'over-pinned-ads', 'broken-landing-pages', 'search-partners-below-average', 'device-below-average', 'pmax-brand-terms', 'no-recent-changes', 'off-target-campaigns', 'customer-match-empty']) assert.ok(found.has(id), `a demo shows ${id}`);
  console.log('demo clients show all 11 new findings');
}

// The landing page check itself, with a stubbed fetch: one request per page, query strings ignored, capped.
{
  const seen = [];
  const fake = async (url) => { seen.push(url); if (url.includes('/gone')) return new Response('', { status: 404 }); if (url.includes('/bot')) return new Response('', { status: 403 }); if (url.includes('/down')) throw new Error('dns'); return new Response('', { status: 200 }); };
  const ad = (u) => ({ adGroupAd: { ad: { finalUrls: [u] } } });
  const data = { ads: [ad('https://a.example/?gclid=1'), ad('https://a.example/?utm=2'), ad('https://a.example/gone'), ad('https://a.example/bot'), ad('https://a.example/down'), ad('http://localhost/x'), ad('ftp://a.example/f')], assetGroups: [{ assetGroup: { finalUrls: ['https://a.example/'] } }] };
  assert.deepEqual(landingPages(data).map((p) => p.url), ['https://a.example/', 'https://a.example/gone', 'https://a.example/bot', 'https://a.example/down'], 'one page per address, most used first, no local or non-web addresses');
  const res = await checkUrls(data, fake);
  assert.equal(seen.length, 4, 'one request each');
  const st = Object.fromEntries(res.pages.map((p) => [p.url.split('/').pop() || 'home', p.state]));
  assert.deepEqual(st, { home: 'ok', gone: 'broken', bot: 'blocked', down: 'broken' });
  const many = { ads: Array.from({ length: URL_MAX + 7 }, (_, i) => ad('https://a.example/p' + i)) };
  const capped = await checkUrls(many, async () => new Response('', { status: 200 }));
  assert.equal(capped.pages.length, URL_MAX); assert.equal(capped.skipped, 7);
  console.log(`landing page check: 404 and no answer are broken, 403 is not checked, capped at ${URL_MAX}`);
}
console.log('All rules tests passed.');
