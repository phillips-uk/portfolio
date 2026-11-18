// Demo clients for the Google Ads Check (Lewis, 18 Nov 2026): a set of made-up accounts, from a one-campaign local
// trade to a national retailer, so the real report can be reviewed in /admin#demos against every kind of account
// before people use it. Each one runs through the same rules and the same page a client sees. Every name, figure and
// search is invented; the report header says "made up", and none of this is ever shown to a visitor.
//
// A demo is a short description (spec) turned into the same rows the Google Ads API returns, by buildAccount().

import { SAMPLE_DATA } from './sample.js';
import { SAMPLE_MULTI } from './sample-multi.js';

const micros = (pounds) => String(Math.round(pounds * 1e6));
const pad = (n) => String(n).padStart(2, '0');
const r1 = (n) => Math.round(n * 10) / 10;

const ATTR = { dda: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN', last: 'GOOGLE_ADS_LAST_CLICK' };

// When conversions come in, as a weight for each hour of the day.
const SHAPES = {
  office: [0, 0, 0, 0, 0, 0, 1, 3, 7, 9, 9, 8, 7, 7, 7, 6, 6, 5, 4, 3, 2, 1, 1, 0],
  evening: [0, 0, 0, 0, 0, 0, 1, 2, 4, 5, 5, 5, 5, 5, 5, 5, 6, 7, 9, 10, 10, 8, 5, 2],
  shop: [1, 1, 0, 0, 0, 0, 1, 2, 4, 5, 6, 6, 7, 7, 6, 6, 6, 7, 8, 10, 11, 10, 7, 3],
};
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

function dayHourRows(shape, totalConv, totalSpend, weekend) {
  const w = SHAPES[shape]; if (!w) return [];
  const dayW = DAYS.map((_, i) => (i === 5 ? weekend[0] : i === 6 ? weekend[1] : 1));
  const sum = w.reduce((a, b) => a + b, 0) * dayW.reduce((a, b) => a + b, 0);
  const rows = [];
  DAYS.forEach((d, di) => w.forEach((x, h) => {
    if (!x) return;
    const share = (x * dayW[di]) / sum;
    rows.push({ segments: { dayOfWeek: d, hour: h }, metrics: { clicks: String(Math.max(1, Math.round(share * totalSpend / 1.9))), costMicros: micros(share * totalSpend), conversions: r1(share * totalConv * ((di + h) % 3 === 0 ? 1.3 : 0.85)) } });
  }));
  return rows;
}

function products(spec, cid, cname) {
  const p = spec.products; if (!p) return [];
  const out = [];
  for (let i = 1; i <= p.count; i++) {
    const type = p.types[i % p.types.length];
    const single = type.replace(/s$/, '');
    const wasted = i > p.count - (p.wasted || 0);
    const short = i <= (p.short || 0);
    out.push({
      segments: {
        productItemId: `${spec.key}-${i}`,
        productTitle: short ? `${single} ${i}` : `${p.brand} ${single} ${i}, ${p.detail}`,
        productTypeL1: i > p.count - (p.wasted || 0) - (p.noType || 0) && i <= p.count - (p.wasted || 0) ? '' : type,
        productBrand: p.brand,
        productCustomAttribute0: p.labels ? (i % 5 === 0 ? 'hero' : i % 3 === 0 ? 'clearance' : 'core') : '',
      },
      metrics: {
        impressions: String(800 + (i % 40) * 60), clicks: String(10 + (i % 25)),
        costMicros: micros(wasted ? p.wasteCost || 70 : (p.avgCost || 40) * (0.5 + (i % 7) / 6)),
        conversions: wasted ? 0 : 1 + (i % 4), conversionsValue: wasted ? 0 : (1 + (i % 4)) * (p.price || 60),
      },
      campaign: { id: cid, name: cname },
    });
  }
  return out;
}

export function buildAccount(spec) {
  const cust = spec.customerId;
  const CA = (id) => `customers/${cust}/conversionActions/${id}`;
  const campaigns = spec.campaigns;
  const byId = new Map(campaigns.map((c) => [c.id, c]));

  const out = {
    customer: [{ customer: { id: cust, currencyCode: 'GBP', conversionTrackingSetting: { enhancedConversionsForLeadsEnabled: Boolean(spec.enhancedLeads) } } }],
    conversionActions: (spec.goals || []).map((g) => ({ conversionAction: {
      resourceName: CA(g.id), id: g.id, name: g.name, status: g.status || 'ENABLED', type: g.type || 'WEBPAGE', category: g.category,
      primaryForGoal: g.primary !== false, includeInConversionsMetric: g.primary !== false, attributionModelSettings: { attributionModel: ATTR[g.attribution || 'dda'] },
    } })),
    conversionStats: [],
    campaigns: [], keywords: [], keywordStats: [], ads: [], adGroups: [],
    negativeKeywords: [], negativeKeywordLists: [], accountNegativeLists: [],
    searchTerms: [], pmaxSearchTerms: [], assetGroups: [], assetGroupStats: [],
    customerAssets: [], campaignAssets: [], audienceCriteria: [], campaignCriteria: [],
    products: [],
  };
  if (spec.noGoals) { out.conversionActions = []; }

  for (const c of campaigns) {
    const type = c.type || 'SEARCH';
    const bid = c.bid || 'MAXIMIZE_CONVERSIONS';
    const conv = c.conv || 0;
    const camp = {
      resourceName: `customers/${cust}/campaigns/${c.id}`, id: c.id, name: c.name, status: 'ENABLED', advertisingChannelType: type,
      biddingStrategyType: bid, biddingStrategySystemStatus: c.learning ? 'LEARNING_NEW' : 'ENABLED',
      networkSettings: { targetSearchNetwork: type === 'SEARCH', targetContentNetwork: Boolean(c.display) },
      geoTargetTypeSetting: { positiveGeoTargetType: c.geo || 'PRESENCE' },
      campaignBudget: `customers/${cust}/campaignBudgets/${c.id}`,
    };
    if (bid === 'MAXIMIZE_CONVERSIONS' && c.tcpa !== false && conv > 0) camp.maximizeConversions = { targetCpaMicros: micros(Math.round(c.spend / conv)) };
    if (bid === 'MAXIMIZE_CONVERSION_VALUE' && c.troas !== false) camp.maximizeConversionValue = { targetRoas: c.troas || 4 };
    out.campaigns.push({
      campaign: camp,
      campaignBudget: { amountMicros: micros(c.budget || Math.ceil(c.spend / 28)) },
      metrics: {
        impressions: String(Math.round(c.spend * (type === 'SEARCH' ? 22 : 90))), clicks: String(Math.round(c.spend / (c.cpc || 1.9))), costMicros: micros(c.spend),
        conversions: conv, conversionsValue: c.value || 0,
        ...(type === 'SEARCH' ? { searchImpressionShare: c.sis ?? 0.64, searchBudgetLostImpressionShare: c.lostBudget ?? 0.06, searchRankLostImpressionShare: c.lostRank ?? 0.3 } : {}),
      },
    });
    if (conv > 0 && c.goal && !spec.noGoals) out.conversionStats.push({ campaign: { id: c.id }, segments: { conversionAction: CA(c.goal) }, metrics: { allConversions: conv, conversions: conv } });

    // Search: ad groups, keywords, ads
    const groups = c.groups || [];
    const kwTotal = groups.reduce((s, g) => s + g.kw.length, 0) || 1;
    groups.forEach((g, gi) => {
      const ag = `${c.id}${pad(gi + 1)}`;
      out.adGroups.push({ adGroup: { id: ag, name: g.name }, campaign: { id: c.id, name: c.name } });
      g.kw.forEach((text, ki) => {
        const id = `${ag}${pad(ki + 1)}`;
        const qs = Array.isArray(g.qs) ? g.qs[ki % g.qs.length] : (g.qs ?? 7);
        out.keywords.push({
          adGroupCriterion: { criterionId: id, keyword: { text, matchType: g.match || (ki === 0 ? 'EXACT' : 'PHRASE') }, ...(qs ? { qualityInfo: { qualityScore: qs } } : {}) },
          adGroup: { id: ag, name: g.name }, campaign: { id: c.id, name: c.name, advertisingChannelType: 'SEARCH', biddingStrategyType: bid },
        });
        out.keywordStats.push({ adGroup: { id: ag }, adGroupCriterion: { criterionId: id }, metrics: { impressions: String(Math.round(c.spend * 18 / kwTotal)), clicks: String(Math.round(c.spend / 1.9 / kwTotal)), costMicros: micros(c.spend * 0.85 / kwTotal), conversions: r1(conv * 0.85 / kwTotal) } });
      });
      (g.ads || ['GOOD', 'EXCELLENT']).forEach((strength, ai) => out.ads.push({
        adGroupAd: { ad: { id: `${ag}${ai}`, type: 'RESPONSIVE_SEARCH_AD', finalUrls: [`https://www.example.co.uk${g.url || '/'}`], ...(g.path === false ? {} : { responsiveSearchAd: { path1: g.name.split(' ')[0].toLowerCase() } }) }, adStrength: strength },
        adGroup: { id: ag, name: g.name }, campaign: { id: c.id, name: c.name, advertisingChannelType: 'SEARCH' },
      }));
      if (type === 'SEARCH' && c.audiences !== false && gi === 0) out.audienceCriteria.push({ campaign: { id: c.id }, adGroup: { id: ag }, adGroupCriterion: { type: 'USER_LIST' } });
    });
    if ((type === 'SEARCH' || type === 'SHOPPING') && c.negatives !== false) out.negativeKeywords.push({ campaign: { id: c.id } });

    // Performance Max: asset groups with strength, spend and conversions
    (c.assets || []).forEach(([name, strength, share, agConv], ai) => {
      const id = `${c.id}${pad(ai + 1)}`;
      out.assetGroups.push({ assetGroup: { id, name, adStrength: strength }, campaign: { id: c.id, name: c.name } });
      out.assetGroupStats.push({ assetGroup: { id }, campaign: { id: c.id }, metrics: { costMicros: micros(c.spend * share), conversions: agConv ?? r1(conv * share) } });
    });
  }

  // Products belong to the first Shopping or PMax campaign with a feed
  const feedCamp = campaigns.find((c) => c.feed);
  if (feedCamp) out.products = products(spec, feedCamp.id, feedCamp.name);

  (spec.terms || []).forEach(([t, cid, cost, conv]) => out.searchTerms.push({ searchTermView: { searchTerm: t }, campaign: { id: cid, name: byId.get(cid).name }, adGroup: { name: 'x' }, metrics: { impressions: String(Math.round(cost * 9)), clicks: String(Math.max(1, Math.round(cost / 2))), costMicros: micros(cost), conversions: conv } }));
  (spec.pmaxTerms || []).forEach(([t, cid, cost, conv]) => out.pmaxSearchTerms.push({ campaignSearchTermView: { searchTerm: t }, campaign: { id: cid, name: byId.get(cid).name }, metrics: { impressions: String(Math.round(cost * 9)), clicks: String(Math.max(1, Math.round(cost / 1.6))), costMicros: micros(cost), conversions: conv, conversionsValue: conv * (spec.products?.price || 0) } }));

  if (spec.sitelinks) out.customerAssets.push({ customerAsset: { fieldType: 'SITELINK', status: 'ENABLED' } }, { customerAsset: { fieldType: 'CALLOUT', status: 'ENABLED' } });

  const totalConv = campaigns.reduce((s, c) => s + (c.conv || 0), 0);
  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  out.dayHour = dayHourRows(spec.dayHour || 'office', totalConv, totalSpend, spec.weekend || [0.6, 0.4]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The demo clients
// ---------------------------------------------------------------------------------------------------------------

// 1. A local trade, one campaign, set up years ago and left: small, enquiries, basic, lots to fix.
const TRADES = {
  key: 'trades', customerId: '501', enhancedLeads: false, dayHour: 'office', weekend: [0.5, 0.2],
  goals: [
    { id: '1', name: 'Contact form', category: 'SUBMIT_LEAD_FORM', attribution: 'last' },
    { id: '2', name: 'Calls from ads', category: 'PHONE_CALL_LEAD', type: 'AD_CALL', attribution: 'last' },
  ],
  campaigns: [
    { id: '1', name: 'Campaign #1', bid: 'MANUAL_CPC', budget: 22, spend: 655, conv: 9, goal: '1', display: true, geo: 'PRESENCE_OR_INTEREST', sis: 0.28, lostBudget: 0.41, negatives: false, audiences: false,
      groups: [{ name: 'Ad group 1', url: '/', match: 'BROAD', qs: [4, 5, 3, 6, 5], ads: ['POOR'], path: false,
        kw: ['plumber', 'plumbers near me', 'emergency plumber', 'boiler repair', 'boiler service', 'heating engineer', 'blocked drain', 'leaking tap', 'bathroom fitter', 'radiator repair', 'gas engineer', 'central heating', 'plumbing', 'local plumber', 'cheap plumber', '24 hour plumber', 'boiler installation', 'power flush'] }] },
  ],
  terms: [['plumber jobs near me', '1', 34, 0], ['plumbing apprenticeship', '1', 28, 0], ['how to fix a leaking tap', '1', 22, 0], ['boiler manual', '1', 19, 0], ['emergency plumber', '1', 60, 4], ['plumbers near me', '1', 74, 3], ['gas engineer salary', '1', 17, 0], ['diy bathroom fitting', '1', 15, 0]],
};

// 2. A small online shop: Performance Max and brand Search, mostly sound, a few feed and asset gaps.
const SHOP = {
  key: 'shop', customerId: '502', enhancedLeads: false, dayHour: 'shop', weekend: [1, 1.1], sitelinks: true,
  goals: [{ id: '1', name: 'Purchase', category: 'PURCHASE' }, { id: '2', name: 'Add to basket', category: 'ADD_TO_CART', primary: false }],
  products: { brand: 'Example', types: ['Candles', 'Diffusers', 'Gift sets'], count: 42, short: 6, wasted: 5, wasteCost: 45, avgCost: 28, price: 32, labels: false, detail: 'hand poured, 40 hour burn, gift boxed' },
  campaigns: [
    { id: '1', name: 'PMax | All products', type: 'PERFORMANCE_MAX', bid: 'MAXIMIZE_CONVERSION_VALUE', troas: 3.5, budget: 52, spend: 1540, conv: 61, value: 5960, goal: '1', feed: true,
      assets: [['Candles', 'GOOD', 0.58], ['Diffusers', 'AVERAGE', 0.27], ['Gift sets', 'GOOD', 0.15]] },
    { id: '2', name: 'Search | Brand', bid: 'MAXIMIZE_CONVERSIONS', budget: 12, spend: 310, conv: 26, value: 980, goal: '1', sis: 0.88, lostBudget: 0.02,
      groups: [{ name: 'Brand', url: '/', kw: ['example candles', 'example candle company', 'example candles discount code'] }] },
  ],
  terms: [['example candles', '2', 160, 15], ['example candle company', '2', 88, 8]],
  pmaxTerms: [['soy candles', '1', 180, 9], ['luxury scented candles', '1', 150, 7], ['reed diffuser', '1', 120, 4], ['candle gift set', '1', 96, 6], ['candle making kit', '1', 64, 0], ['how to make candles', '1', 41, 0], ['candle wax wholesale', '1', 38, 0]],
};

// 3. A new account with no conversion tracking yet: the report has to cope with no conversions at all.
const NEW = {
  key: 'new', customerId: '503', noGoals: true, dayHour: 'office', weekend: [0.4, 0.2],
  campaigns: [
    { id: '1', name: 'Physio - Search - Back pain', bid: 'MAXIMIZE_CLICKS', budget: 8, spend: 228, conv: 0, sis: 0.35, lostBudget: 0.3,
      groups: [{ name: 'Back pain', url: '/back-pain/', kw: ['back pain physio', 'sports massage', 'physiotherapist near me'], qs: [6, 5, 7] }] },
    { id: '2', name: 'Physio - Search - Sports injury', bid: 'MAXIMIZE_CLICKS', budget: 6, spend: 154, conv: 0, sis: 0.4, lostBudget: 0.22,
      groups: [{ name: 'Sports injury', url: '/sports-injury/', kw: ['sports injury clinic', 'knee physio', 'running injury physio'], qs: [7, 6, 6] }] },
  ],
  terms: [['physio near me', '1', 42, 0], ['physio jobs', '1', 18, 0], ['sports massage near me', '2', 30, 0], ['free physio exercises', '1', 12, 0]],
};

// 5. A clinic that's run well: mid-size, enquiries, mostly healthy, so the report leads with what's working.
const CLINIC_SERVICES = [['Implants', 1650, 21], ['Invisalign', 1420, 24], ['Emergency', 760, 31], ['Whitening', 520, 14]];
const CLINIC = {
  key: 'clinic', customerId: '505', enhancedLeads: true, dayHour: 'evening', weekend: [0.7, 0.4], sitelinks: true,
  goals: [
    { id: '1', name: 'Booking request', category: 'BOOK_APPOINTMENT' },
    { id: '2', name: 'Calls from ads', category: 'PHONE_CALL_LEAD', type: 'AD_CALL' },
  ],
  campaigns: [
    { id: '1', name: 'Dental - Search - Brand', bid: 'MAXIMIZE_CONVERSIONS', budget: 14, spend: 390, conv: 48, goal: '1', sis: 0.92, lostBudget: 0.01,
      groups: [{ name: 'Brand', url: '/', kw: ['example dental', 'example dental clinic', 'example dental reviews'], qs: [9, 9, 8] }] },
    ...CLINIC_SERVICES.map(([s, spend, conv], i) => ({ id: String(i + 2), name: `Dental - Search - ${s}`, bid: 'MAXIMIZE_CONVERSIONS', budget: Math.ceil(spend / 28), spend, conv, goal: i % 2 ? '2' : '1', sis: 0.58, lostBudget: 0.04,
      groups: [{ name: `${s}`, url: `/${s.toLowerCase()}/`, kw: [`${s.toLowerCase()} dentist`, `${s.toLowerCase()} cost`, `${s.toLowerCase()} near me`, `private ${s.toLowerCase()}`], qs: [8, 7, 9, 7] }, { name: `${s} prices`, url: `/${s.toLowerCase()}/prices/`, kw: [`${s.toLowerCase()} price`, `${s.toLowerCase()} finance`], qs: [7, 8] }] })),
    { id: '6', name: 'Dental - PMax - New patients', type: 'PERFORMANCE_MAX', bid: 'MAXIMIZE_CONVERSIONS', budget: 40, spend: 1110, conv: 19, goal: '1',
      assets: [['Implants', 'GOOD', 0.55], ['Invisalign', 'EXCELLENT', 0.45]] },
  ],
  terms: [['dental implants cost', '2', 150, 6], ['invisalign near me', '3', 130, 7], ['emergency dentist', '4', 120, 12], ['teeth whitening price', '5', 70, 3], ['dental nurse jobs', '4', 22, 0]],
  pmaxTerms: [['dental implants', '6', 160, 5], ['clear aligners', '6', 120, 4], ['nhs dentist', '6', 48, 0]],
};

// 7. A national retailer: big, online sales, complex. 26 campaigns, a large feed, many asset groups.
const CATS = ['Tents', 'Jackets', 'Boots', 'Backpacks', 'Sleeping bags', 'Climbing'];
const STR = ['EXCELLENT', 'GOOD', 'GOOD', 'AVERAGE', 'GOOD', 'POOR', 'AVERAGE', 'GOOD', 'EXCELLENT'];
const RETAILER = {
  key: 'retailer', customerId: '507', enhancedLeads: false, dayHour: 'shop', weekend: [1.1, 1.2], sitelinks: true,
  goals: [
    { id: '1', name: 'Purchase', category: 'PURCHASE' },
    { id: '2', name: 'Store visits', category: 'STORE_VISIT', type: 'STORE_VISITS', primary: false },
    { id: '3', name: 'Newsletter sign-up', category: 'SIGNUP', primary: false },
  ],
  products: { brand: 'Example Outdoor', types: ['Tents', 'Jackets', 'Boots', 'Backpacks', 'Sleeping bags', 'Climbing gear', 'Stoves', 'Accessories'], count: 640, short: 38, noType: 26, wasted: 84, wasteCost: 95, avgCost: 52, price: 110, labels: true, detail: 'waterproof, lightweight, 2 year guarantee' },
  campaigns: [
    { id: '1', name: 'UK_Search_Brand_Exact', bid: 'TARGET_IMPRESSION_SHARE', spend: 3900, conv: 610, value: 72400, goal: '1', sis: 0.95, lostBudget: 0,
      groups: [{ name: 'Brand', url: '/', kw: ['example outdoor', 'example outdoor uk', 'example outdoor discount code'], qs: [10, 9, 8] }] },
    { id: '2', name: 'UK_Search_Brand_Products', bid: 'MAXIMIZE_CONVERSION_VALUE', troas: 6, spend: 2100, conv: 190, value: 23100, goal: '1', sis: 0.81,
      groups: [{ name: 'Brand plus product', url: '/', kw: ['example outdoor tents', 'example outdoor jackets', 'example outdoor boots'], qs: [9, 8, 8] }] },
    ...CATS.map((cat, i) => ({ id: String(3 + i), name: `UK_Search_Generic_${cat.replace(' ', '')}`, bid: 'MAXIMIZE_CONVERSION_VALUE', troas: 4, spend: [6200, 5400, 4800, 3100, 2600, 1900][i], conv: [88, 96, 70, 51, 30, 12][i], value: [9400, 10900, 8200, 5100, 3300, 1300][i], goal: '1', sis: 0.42, lostBudget: i === 0 ? 0.24 : 0.07, lostRank: 0.34,
      groups: [0, 1, 2].map((g) => ({ name: `${cat} ${['general', 'women', 'men'][g]}`, url: `/${cat.toLowerCase().replace(' ', '-')}/`, kw: [`${cat.toLowerCase()}`, `buy ${cat.toLowerCase()}`, `${cat.toLowerCase()} sale`, `best ${cat.toLowerCase()}`, `${cat.toLowerCase()} uk`], qs: i === 5 ? [3, 4, 3, 5, 4] : [7, 6, 8, 7, 6], ads: i === 5 ? ['AVERAGE'] : ['GOOD', 'GOOD'] })) })),
    { id: '9', name: 'UK_Search_Competitor_All', bid: 'MAXIMIZE_CONVERSIONS', spend: 1400, conv: 9, goal: '1', sis: 0.21,
      groups: [{ name: 'Competitors', url: '/compare/', kw: ['trailpeak tents', 'summitline jackets', 'ridgeway boots'], qs: [3, 3, 4] }] },
    ...CATS.map((cat, i) => ({ id: String(10 + i), name: `UK_PMax_${cat.replace(' ', '')}`, type: 'PERFORMANCE_MAX', bid: 'MAXIMIZE_CONVERSION_VALUE', troas: 4.5, spend: [9800, 8700, 7900, 4200, 3600, 2100][i], conv: [260, 240, 190, 110, 72, 25][i], value: [28100, 26200, 20900, 11800, 7600, 2500][i], goal: '1', feed: i === 0,
      assets: Array.from({ length: [9, 8, 7, 6, 5, 5][i] }, (_, a) => [`${cat} ${['bestsellers', 'new in', 'sale', 'premium', 'women', 'men', 'kids', 'bundles', 'clearance'][a]}`, STR[(a + i) % STR.length], [0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05, 0.04, 0.02][a]]) })),
    ...['Tents & camping', 'Clothing', 'Footwear', 'Packs & bags', 'Everything else'].map((g, i) => ({ id: String(16 + i), name: `UK_Shopping_${g.replace(/[ &]+/g, '')}`, type: 'SHOPPING', bid: i === 4 ? 'MANUAL_CPC' : 'MAXIMIZE_CONVERSION_VALUE', troas: 4, spend: [3100, 2800, 2300, 1600, 2400][i], conv: [61, 58, 44, 29, 11][i], value: [6800, 6300, 4900, 3100, 1100][i], goal: '1' })),
    { id: '21', name: 'UK_Display_Remarketing_30d', type: 'DISPLAY', spend: 1900, conv: 41, value: 4400, goal: '1' },
    { id: '22', name: 'UK_Display_Remarketing_Basket', type: 'DISPLAY', spend: 900, conv: 33, value: 3500, goal: '1' },
    { id: '23', name: 'UK_DemandGen_Prospecting_Hiking', type: 'DEMAND_GEN', spend: 2600, conv: 22, value: 2300, goal: '1' },
    { id: '24', name: 'UK_DemandGen_Prospecting_Camping', type: 'DEMAND_GEN', spend: 1800, conv: 14, value: 1500, goal: '1', learning: true },
    { id: '25', name: 'UK_YouTube_Brand_Awareness', type: 'VIDEO', bid: 'TARGET_CPM', spend: 2400, conv: 4, value: 420, goal: '1' },
    { id: '26', name: 'UK_Search_Generic_Stoves', bid: 'MANUAL_CPC', spend: 640, conv: 0, goal: '1', sis: 0.3, display: true,
      groups: [{ name: 'Stoves', url: '/', match: 'BROAD', kw: ['camping stove', 'gas stove', 'stove', 'cooker'], qs: [5, 4, 3, 4], ads: ['POOR'] }] },
  ],
  terms: [['4 man tent', '3', 210, 6], ['waterproof jacket women', '4', 190, 7], ['walking boots men', '5', 170, 5], ['tent pegs', '3', 60, 1], ['tent repair kit diy', '3', 44, 0], ['jacket size guide', '4', 38, 0], ['boot polish', '5', 31, 0], ['camping stove', '26', 96, 0], ['stove repair', '26', 74, 0], ['used tents for sale', '3', 52, 0], ['trailpeak tents', '9', 120, 1]],
  pmaxTerms: [['family tent', '10', 420, 14], ['tent sale', '10', 380, 11], ['rain jacket', '11', 350, 13], ['hiking boots', '12', 330, 10], ['tent hire', '10', 120, 0], ['camping near me', '10', 96, 0], ['boot repair shop', '12', 70, 0], ['jacket alterations', '11', 58, 0], ['backpack', '13', 210, 6], ['sleeping bag', '14', 160, 4]],
};

// 8. A national home improvements firm: big, enquiries, complex. Services by region, imported qualified leads.
const SERVICES = ['Windows', 'Doors', 'Conservatories', 'Roofing', 'Solar'];
const REGIONS = ['North', 'Midlands', 'South'];
let nid = 3;
const NATIONAL = {
  key: 'national', customerId: '508', enhancedLeads: true, dayHour: 'evening', weekend: [0.9, 0.6], sitelinks: true,
  goals: [
    { id: '1', name: 'Quote form', category: 'REQUEST_QUOTE' },
    { id: '2', name: 'Calls from ads', category: 'PHONE_CALL_LEAD', type: 'AD_CALL' },
    { id: '3', name: 'Qualified lead (CRM import)', category: 'QUALIFIED_LEAD', type: 'UPLOAD_CLICKS' },
    { id: '4', name: 'Brochure download', category: 'DOWNLOAD' },
    { id: '5', name: 'Survey booked (CRM import)', category: 'CONVERTED_LEAD', type: 'UPLOAD_CLICKS' },
  ],
  campaigns: [
    { id: '1', name: 'GB | Search | Brand', bid: 'MAXIMIZE_CONVERSIONS', spend: 2100, conv: 310, goal: '1', sis: 0.93, lostBudget: 0.01,
      groups: [{ name: 'Brand', url: '/', kw: ['example home improvements', 'example windows', 'example home improvements reviews'], qs: [10, 9, 9] }] },
    { id: '2', name: 'GB | Search | Competitor', bid: 'MAXIMIZE_CONVERSIONS', spend: 1300, conv: 14, goal: '1', sis: 0.19,
      groups: [{ name: 'Competitors', url: '/why-us/', kw: ['brightframe windows', 'homeshield doors', 'sunroom direct'], qs: [3, 4, 3] }] },
    ...SERVICES.flatMap((s, si) => REGIONS.map((reg, ri) => {
      const spend = [[3200, 2600, 2900], [1500, 1200, 1400], [2200, 1700, 2500], [1800, 1500, 1600], [2600, 1900, 3100]][si][ri];
      const conv = [[61, 44, 52], [30, 22, 27], [24, 16, 31], [33, 25, 29], [14, 9, 0]][si][ri];
      const id = String(nid++);
      return { id, name: `GB | Search | ${s} | ${reg}`, bid: 'MAXIMIZE_CONVERSIONS', tcpa: si === 2 ? false : undefined, spend, conv, goal: ri === 1 ? '2' : '1', sis: 0.47, lostBudget: si === 0 ? 0.31 : 0.08, lostRank: 0.29, learning: si === 4 && ri === 2,
        groups: [{ name: `${s} ${reg}`, url: `/${s.toLowerCase()}/`, kw: [`${s.toLowerCase()} ${reg.toLowerCase()}`, `${s.toLowerCase()} prices`, `new ${s.toLowerCase()}`, `${s.toLowerCase()} installers`, `${s.toLowerCase()} quote`], qs: si === 4 ? [4, 5, 3, 5, 4] : [7, 8, 6, 7, 7], ads: si === 1 ? ['AVERAGE'] : ['GOOD', 'EXCELLENT'] },
          { name: `${s} ${reg} offers`, url: si === 3 ? '/' : `/${s.toLowerCase()}/offers/`, kw: [`${s.toLowerCase()} deals`, `cheap ${s.toLowerCase()}`], qs: [6, 5] }] };
    })),
    { id: '18', name: 'GB | PMax | Windows & Doors', type: 'PERFORMANCE_MAX', bid: 'MAXIMIZE_CONVERSIONS', spend: 4200, conv: 70, goal: '1',
      assets: [['Windows', 'GOOD', 0.42], ['Doors', 'AVERAGE', 0.26], ['Composite doors', 'GOOD', 0.2], ['Bi-folds', 'POOR', 0.12]] },
    { id: '19', name: 'GB | PMax | Solar & Roofing', type: 'PERFORMANCE_MAX', bid: 'MAXIMIZE_CONVERSIONS', spend: 3100, conv: 31, goal: '1',
      assets: [['Solar panels', 'GOOD', 0.48], ['Battery storage', 'AVERAGE', 0.22], ['Roofing', 'GOOD', 0.2], ['Fascias', 'POOR', 0.1]] },
    { id: '20', name: 'GB | DemandGen | Homeowners', type: 'DEMAND_GEN', spend: 1900, conv: 11, goal: '4' },
    { id: '21', name: 'GB | Display | Remarketing', type: 'DISPLAY', spend: 800, conv: 16, goal: '1' },
  ],
  terms: [['upvc windows prices', '3', 220, 6], ['window fitter jobs', '3', 66, 0], ['diy window repair', '3', 48, 0], ['conservatory roof replacement', '9', 160, 3], ['solar panel grants', '15', 140, 0], ['how do solar panels work', '15', 96, 0], ['free solar panels', '17', 120, 0], ['roofer near me', '12', 150, 5], ['brightframe windows', '2', 88, 1]],
  pmaxTerms: [['new windows', '18', 300, 9], ['front doors', '18', 220, 6], ['solar panels cost', '19', 260, 5], ['solar panel cleaning', '19', 80, 0], ['door handle replacement', '18', 64, 0], ['window cleaning', '18', 58, 0]],
};

// The list shown in /admin#demos, in the order Lewis reads it: small to big.
export const DEMOS = [
  { id: 'trades', name: 'Local trade, one campaign', size: 'Small', model: 'Enquiries', build: 'Basic', note: 'One Search campaign set up years ago: manual bids, broad match, no negatives. Lots to fix.', data: () => buildAccount(TRADES) },
  { id: 'new', name: 'New account, no tracking', size: 'Small', model: 'Enquiries', build: 'Basic', note: 'Two Search campaigns and no conversion tracking at all. Tests the report with no conversions.', data: () => buildAccount(NEW) },
  { id: 'shop', name: 'Small online shop', size: 'Small', model: 'Online sales', build: 'Basic', note: 'Performance Max and brand Search on a 42-product feed. Mostly sound, some feed and asset gaps.', data: () => buildAccount(SHOP) },
  { id: 'problem', name: 'Service business, problems', size: 'Small', model: 'Enquiries', build: 'Mixed', note: 'The original sample: three Search campaigns and a Performance Max one, with tracking and bidding problems.', data: () => SAMPLE_DATA },
  { id: 'clinic', name: 'Clinic, run well', size: 'Mid', model: 'Enquiries', build: 'Mixed', note: 'Six campaigns, tidy and healthy. The report should lead with what is working.', data: () => buildAccount(CLINIC) },
  { id: 'mixed', name: 'Shop and services, ten campaigns', size: 'Mid', model: 'Sales and enquiries', build: 'Complex', note: 'Ten campaigns of six types, mostly healthy, a few things to fix.', data: () => SAMPLE_MULTI },
  { id: 'national', name: 'National home improvements', size: 'Large', model: 'Enquiries', build: 'Complex', note: '21 campaigns: services by region, imported qualified leads, budget limits, a learning campaign.', data: () => buildAccount(NATIONAL) },
  { id: 'retailer', name: 'National outdoor retailer', size: 'Large', model: 'Online sales', build: 'Complex', note: '26 campaigns of six types, a 640-product feed, 40 asset groups, about £90k a month.', data: () => buildAccount(RETAILER) },
];

// ?sample=1 and ?sample=2 from before the demo list still work.
export function findDemo(id) {
  const key = id === '1' || id === 'small' ? 'problem' : id === '2' || id === 'multi' ? 'mixed' : id;
  return DEMOS.find((d) => d.id === key) || DEMOS.find((d) => d.id === 'problem');
}
