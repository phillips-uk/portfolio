// A made-up account with ten campaigns of six types, for the admin-only preview of the Google Ads Check report
// (?sample=2 on the preview, Lewis 18 Nov 2026: "what if a client has 10 campaigns with various types?"). It is
// mostly healthy, so the report shows what's working as well as a few things to fix. Every name and figure is
// invented; the report says it is a sample and it is never shown to a visitor.

const micros = (pounds) => String(Math.round(pounds * 1e6));
const CA = (id) => `customers/333/conversionActions/${id}`;

// id, name, type, bidding, daily budget, 30-day spend, conversions, value
const CAMPAIGNS = [
  ['1', 'Search - Brand - UK', 'SEARCH', 'TARGET_IMPRESSION_SHARE', 25, 610, 64, 0],
  ['2', 'Search - Boilers - Install', 'SEARCH', 'MAXIMIZE_CONVERSIONS', 95, 2640, 46, 0],
  ['3', 'Search - Boilers - Service', 'SEARCH', 'MAXIMIZE_CONVERSIONS', 55, 1420, 39, 0],
  ['4', 'Search - Bathrooms - Fitting', 'SEARCH', 'MAXIMIZE_CONVERSIONS', 70, 1810, 13, 0],
  ['5', 'Search - Competitor - UK', 'SEARCH', 'MAXIMIZE_CONVERSIONS', 30, 720, 5, 0],
  ['6', 'PMax - Shop - Bestsellers', 'PERFORMANCE_MAX', 'MAXIMIZE_CONVERSION_VALUE', 150, 4230, 121, 14100],
  ['7', 'PMax - Shop - New lines', 'PERFORMANCE_MAX', 'MAXIMIZE_CONVERSION_VALUE', 55, 1490, 18, 2620],
  ['8', 'Shopping - Shop - Catch-all', 'SHOPPING', 'MAXIMIZE_CLICKS', 35, 880, 21, 1790],
  ['9', 'Display - Remarketing - 30 day', 'DISPLAY', 'MAXIMIZE_CONVERSIONS', 20, 510, 9, 0],
  ['10', 'Demand Gen - Prospecting - UK', 'DEMAND_GEN', 'MAXIMIZE_CONVERSIONS', 45, 1230, 6, 0],
];

// Search ad groups: id, campaign id, name, landing page, keywords
const SEARCH_GROUPS = [
  ['11', '1', 'Brand', '/', ['example heating', 'example heating reviews', 'example heating phone number']],
  ['21', '2', 'Combi boiler install', '/boilers/combi-installation/', ['combi boiler installation', 'new combi boiler cost', 'combi boiler fitted']],
  ['22', '2', 'Boiler replacement', '/boilers/replacement/', ['boiler replacement', 'replace old boiler', 'boiler replacement cost']],
  ['31', '3', 'Boiler service', '/boilers/servicing/', ['boiler service', 'annual boiler service', 'boiler servicing near me']],
  ['41', '4', 'Bathroom fitting', '/bathrooms/fitting/', ['bathroom fitters', 'bathroom fitting cost', 'new bathroom installation']],
  ['51', '5', 'Competitors', '/compare/', ['heatfast boilers', 'boilerline installs']],
];

const campaignRow = ([id, name, channel, bidding, budget, spend, conversions, value]) => ({
  campaign: {
    resourceName: `customers/333/campaigns/${id}`, id, name, status: 'ENABLED', advertisingChannelType: channel,
    biddingStrategyType: bidding, biddingStrategySystemStatus: 'ENABLED',
    networkSettings: { targetSearchNetwork: channel === 'SEARCH', targetContentNetwork: false },
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
    campaignBudget: `customers/333/campaignBudgets/${id}`,
    ...(bidding === 'MAXIMIZE_CONVERSIONS' && channel === 'SEARCH' ? { maximizeConversions: { targetCpaMicros: micros(Math.round(spend / Math.max(conversions, 1))) } } : {}),
  },
  campaignBudget: { amountMicros: micros(budget) },
  metrics: {
    impressions: String(Math.round(spend * 22)), clicks: String(Math.round(spend / 1.9)), costMicros: micros(spend),
    conversions, conversionsValue: value,
    ...(channel === 'SEARCH' ? { searchImpressionShare: 0.62, searchBudgetLostImpressionShare: 0.08, searchRankLostImpressionShare: 0.3 } : {}),
  },
});

const keywords = [];
const keywordStats = [];
SEARCH_GROUPS.forEach(([ag, cid, agName, , words], gi) => {
  const cname = CAMPAIGNS.find((c) => c[0] === cid)[1];
  words.forEach((text, i) => {
    const id = `${ag}${i}`;
    keywords.push({
      adGroupCriterion: { criterionId: id, keyword: { text, matchType: i === 0 ? 'EXACT' : 'PHRASE' }, qualityInfo: { qualityScore: cid === '5' ? 3 : 7 + (i % 3) } },
      adGroup: { id: ag, name: agName },
      campaign: { id: cid, name: cname, advertisingChannelType: 'SEARCH', biddingStrategyType: CAMPAIGNS.find((c) => c[0] === cid)[3] },
    });
    keywordStats.push({ adGroup: { id: ag }, adGroupCriterion: { criterionId: id }, metrics: { impressions: '900', clicks: '45', costMicros: micros(cid === '5' ? 90 : 60 + gi * 5), conversions: cid === '5' ? 0.5 : 3 } });
  });
});

const ads = [];
SEARCH_GROUPS.forEach(([ag, cid, agName, url]) => {
  const cname = CAMPAIGNS.find((c) => c[0] === cid)[1];
  const strengths = cid === '4' ? ['AVERAGE'] : ['GOOD', 'EXCELLENT'];
  strengths.forEach((strength, i) => ads.push({
    adGroupAd: { ad: { id: `${ag}${i}`, type: 'RESPONSIVE_SEARCH_AD', finalUrls: [`https://www.example.co.uk${url}`], responsiveSearchAd: { path1: agName.split(' ')[0].toLowerCase() } }, adStrength: strength },
    adGroup: { id: ag, name: agName },
    campaign: { id: cid, name: cname, advertisingChannelType: 'SEARCH' },
  }));
});

// Products: 24 in four types, most selling, four with very short titles.
const TYPES = ['Boilers', 'Radiators', 'Bathroom suites', 'Heating controls'];
const products = [];
for (let i = 1; i <= 24; i++) {
  const type = TYPES[i % 4];
  products.push({
    segments: {
      productItemId: `ex-${i}`,
      productTitle: i <= 4 ? `${type.split(' ')[0]} ${i}` : `${type.replace(/s$/, '')} model ${i}, energy rated, with fittings and 5 year warranty`,
      productTypeL1: type, productBrand: 'Example', productCustomAttribute0: i <= 6 ? 'hero' : 'standard',
    },
    metrics: { impressions: String(2000 + i * 50), clicks: String(60 + i), costMicros: micros(i <= 20 ? 120 + i * 4 : 14), conversions: i <= 20 ? 4 + (i % 5) : 0, conversionsValue: i <= 20 ? 600 + i * 20 : 0 },
  });
}

// When conversions come in: weekday working hours and evenings, quieter weekends.
const dayHour = [];
['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].forEach((d, di) => {
  [0, 0, 0, 0, 0, 0, 1, 3, 6, 8, 8, 7, 7, 6, 6, 6, 6, 7, 8, 9, 8, 5, 3, 1].forEach((w, h) => {
    if (!w) return;
    const day = di === 6 ? 0.5 : di === 5 ? 0.75 : 1;
    dayHour.push({ segments: { dayOfWeek: d, hour: h }, metrics: { clicks: String(Math.round(w * 9 * day)), costMicros: micros(w * 16 * day), conversions: Math.round(w * day * ((di + h) % 4 === 0 ? 0.55 : 0.33) * 10) / 10 } });
  });
});

const term = (t, cid, cost, conv) => ({ searchTermView: { searchTerm: t }, campaign: { id: cid, name: CAMPAIGNS.find((c) => c[0] === cid)[1] }, adGroup: { name: 'x' }, metrics: { impressions: '300', clicks: String(Math.round(cost / 2)), costMicros: micros(cost), conversions: conv } });
const pterm = (t, cost, conv) => ({ campaignSearchTermView: { searchTerm: t }, campaign: { id: '6', name: 'PMax - Shop - Bestsellers' }, metrics: { impressions: '400', clicks: String(Math.round(cost / 1.5)), costMicros: micros(cost), conversions: conv, conversionsValue: conv * 120 } });

export const SAMPLE_MULTI = {
  customer: [{ customer: { id: '333', currencyCode: 'GBP', conversionTrackingSetting: { enhancedConversionsForLeadsEnabled: true } } }],
  conversionActions: [
    { conversionAction: { resourceName: CA(1), id: '1', name: 'Online order', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
    { conversionAction: { resourceName: CA(2), id: '2', name: 'Quote request', status: 'ENABLED', type: 'WEBPAGE', category: 'REQUEST_QUOTE', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
    { conversionAction: { resourceName: CA(3), id: '3', name: 'Calls from ads', status: 'ENABLED', type: 'AD_CALL', category: 'PHONE_CALL_LEAD', primaryForGoal: true, includeInConversionsMetric: true, attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' } } },
  ],
  conversionStats: [
    { campaign: { id: '6' }, segments: { conversionAction: CA(1) }, metrics: { allConversions: 160, conversions: 160 } },
    { campaign: { id: '2' }, segments: { conversionAction: CA(2) }, metrics: { allConversions: 120, conversions: 120 } },
    { campaign: { id: '3' }, segments: { conversionAction: CA(3) }, metrics: { allConversions: 60, conversions: 60 } },
  ],
  campaigns: CAMPAIGNS.map(campaignRow),
  keywords,
  keywordStats,
  negativeKeywords: ['1', '2', '3', '4', '5'].map((id) => ({ campaign: { id } })),
  negativeKeywordLists: [],
  accountNegativeLists: [],
  searchTerms: [
    term('combi boiler installation cost', '2', 140, 6), term('boiler service near me', '3', 90, 5), term('bathroom fitters near me', '4', 110, 2),
    term('example heating', '1', 60, 9), term('heatfast boilers reviews', '5', 70, 0), term('boiler engineer jobs', '2', 38, 0),
    term('plumbing apprenticeship', '3', 26, 0), term('diy bathroom tiling', '4', 31, 0),
  ],
  pmaxSearchTerms: [
    pterm('combi boiler', 260, 9), pterm('combi boiler deals', 120, 4), pterm('towel radiator', 140, 5), pterm('designer radiator', 90, 2),
    pterm('smart thermostat', 80, 3), pterm('boiler manual pdf', 70, 0), pterm('free boiler manual', 66, 0), pterm('bathroom suite', 150, 4),
  ],
  assetGroups: [
    ['61', '6', 'Combi boilers', 'EXCELLENT'], ['62', '6', 'Radiators', 'GOOD'], ['63', '6', 'Bathroom suites', 'GOOD'], ['64', '6', 'Heating controls', 'AVERAGE'],
    ['71', '7', 'New boilers', 'GOOD'], ['72', '7', 'New radiators', 'POOR'], ['73', '7', 'Smart controls', 'AVERAGE'],
  ].map(([id, cid, name, adStrength]) => ({ assetGroup: { id, name, adStrength }, campaign: { id: cid, name: CAMPAIGNS.find((c) => c[0] === cid)[1] } })),
  assetGroupStats: [
    ['61', '6', 1900, 62], ['62', '6', 1150, 31], ['63', '6', 760, 20], ['64', '6', 420, 8],
    ['71', '7', 820, 12], ['72', '7', 430, 3], ['73', '7', 240, 3],
  ].map(([id, cid, spend, conv]) => ({ assetGroup: { id }, campaign: { id: cid }, metrics: { costMicros: micros(spend), conversions: conv } })),
  ads,
  customerAssets: [{ customerAsset: { fieldType: 'SITELINK', status: 'ENABLED' } }, { customerAsset: { fieldType: 'CALLOUT', status: 'ENABLED' } }],
  campaignAssets: [],
  adGroups: SEARCH_GROUPS.map(([id, cid, name]) => ({ adGroup: { id, name }, campaign: { id: cid, name: CAMPAIGNS.find((c) => c[0] === cid)[1] } })),
  audienceCriteria: ['1', '2', '3', '4', '5'].map((cid) => ({ campaign: { id: cid }, adGroup: { id: SEARCH_GROUPS.find((g) => g[1] === cid)[0] }, adGroupCriterion: { type: 'USER_LIST' } })),
  campaignCriteria: [],
  products,
  dayHour,
};
