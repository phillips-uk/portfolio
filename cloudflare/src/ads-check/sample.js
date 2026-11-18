// A made-up account for the admin-only preview of the Google Ads Check report (?sample=1 on the preview), so the layout
// and prices can be reviewed before a real account is read. Same data as the "problem account" in rules.test.mjs.
// Never shown to a visitor, and the report says it is a sample.
const micros = (pounds) => String(Math.round(pounds * 1e6));
const CA = (id) => `customers/111/conversionActions/${id}`;

// Made-up clicks and conversions by day and hour for the sample's heatmap: busy on weekday mornings and evenings,
// quiet overnight and on Sundays. Fixed numbers (no randomness), so the preview looks the same every time.
function sampleDayHour() {
  const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  const shape = [0, 0, 0, 0, 0, 0, 1, 3, 6, 7, 6, 5, 5, 5, 4, 4, 5, 6, 7, 8, 6, 4, 2, 1];
  const rows = [];
  days.forEach((d, di) => shape.forEach((w, h) => {
    if (!w) return;
    const day = di === 6 ? 0.4 : di === 5 ? 0.7 : 1;
    const clicks = Math.round(w * 2 * day);
    const conversions = Math.round(((w * day) / 11) * ((di + h) % 3 === 0 ? 1.4 : 0.8) * 10) / 10;
    rows.push({ segments: { dayOfWeek: d, hour: h }, metrics: { clicks: String(clicks), costMicros: micros(clicks * 2.2), conversions: (h >= 8 && h <= 20) ? conversions : 0 } });
  }));
  return rows;
}

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
  dayHour: sampleDayHour(),
};

// ---------------------------------------------------------------------------
// Fixture 2: a mostly healthy account
// ---------------------------------------------------------------------------

export const SAMPLE_DATA = problem;
