// Rules for the free Google Ads check.
//
// Ported from the old Python audit (google-ads-audit-tool/worker/audit.py).
// Thresholds are kept from that file and noted where they apply.
//
// runRules(data, ctx) takes the REST rows for each query in queries.js
// ({ [queryName]: rows[] }, or undefined for a query that failed) and returns
// { strengths, weaknesses, facts }. It never calls an API.

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const LINKS = {
  tracking: '/guides/fix-google-ads-conversion-tracking/',
  ga4: '/guides/ga4-imports-break-smart-bidding/',
  bidding: '/guides/google-ads-bidding-strategy/',
  quality: '/guides/improve-google-ads-quality-score/',
  fewConversions: '/guides/target-cpa-few-conversions/',
  ads: '/google-ads/',
  systems: '/marketing-systems/',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// REST returns int64 values (cost, clicks, impressions, ids) as strings and
// doubles as numbers. Missing fields are simply absent.
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const fromMicros = (v) => num(v) / 1e6;

// Names come from the account, so strip any long dashes to keep every
// string within the site's writing rules, and keep them short.
function clean(s, max = 60) {
  let out = String(s ?? '').replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max - 3).trimEnd() + '...';
  return out;
}

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

// "Your one campaign", "Both campaigns" or "All 4 campaigns".
function allOf(n, one, many = one + 's') {
  if (n === 1) return `Your one ${one}`;
  return n === 2 ? `Both ${many}` : `All ${n} ${many}`;
}

// Verb that agrees with a count: verb(1, 'has', 'have') is 'has'.
const verb = (n, one, many) => (n === 1 ? one : many);

// "Your only ad", "Both ads", "All 4 ads" or "3 of your 6 ads", so a count of one never reads "1 of your 1 ads".
function someOf(n, total, one, many = one + 's') {
  if (total === 1) return `Your only ${one}`;
  if (n === total) return n === 2 ? `Both ${many}` : `All ${n} ${many}`;
  return `${n} of your ${total} ${many}`;
}
// The verb that goes with someOf: singular for "Your only ad" and "1 of your 6 ads".
const verbOf = (n, total, one, many) => (total === 1 || (n === 1 && total !== 1) ? one : many);

// "A", "B" and 3 more. total: how many there are in all, when that is more than the distinct names
// (two products can share a title), so "and N more" always adds up to the count in the title.
function examples(names, max = 3, total) {
  const unique = [...new Set(names.map((n) => clean(n)).filter(Boolean))];
  const shown = unique.slice(0, max).map((n) => `"${n}"`);
  const rest = Math.max(total ?? unique.length, unique.length) - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const SYMBOLS = { GBP: '£', EUR: '€', USD: '$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$' };

function moneyFormatter(currency) {
  const sym = SYMBOLS[currency] ?? `${currency} `;
  return (amount) => {
    const a = Math.abs(amount);
    const text = a < 10 && Math.round(a * 100) % 100 !== 0
      ? a.toFixed(2)
      : Math.round(a).toLocaleString('en-GB');
    return `${amount < 0 ? '-' : ''}${sym}${text}`;
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const round2 = (n) => Math.round(n * 100) / 100;
// Underscores, pipes and slashes count as spaces, so "UK_Search_Brand_Exact" reads as brand (found by the demo
// accounts, 18 Nov 2026: \b treats _ as part of a word).
const spaced = (name) => String(name || '').replace(/[_|/\\]+/g, ' ');
const isBrandName = (name) => /\bbrand\b/i.test(spaced(name));

// Same tokeniser as audit.py check_search_terms: words of 3+ letters, minus stopwords.
const TERM_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of',
  'is', 'are', 'was', 'were', 'with', 'how', 'what', 'why', 'when',
  'where', 'can', 'do', 'does', 'buy', 'get', 'best', 'cheap', 'near', 'me',
]);
function termTokens(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return new Set(words.filter((t) => t.length >= 3 && !TERM_STOPWORDS.has(t)));
}

// Same as audit.py _compute_ngrams: letters only, 2+ characters, its own stopwords.
const NGRAM_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of',
  'is', 'are', 'was', 'were', 'with', 'how', 'what', 'why', 'when',
  'where', 'can', 'do', 'does', 'i', 'my', 'me', 'be', 'it', 'its',
]);
function ngramWords(text) {
  const words = String(text || '').match(/\b[a-zA-Z]+\b/g) || [];
  return words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2 && !NGRAM_STOPWORDS.has(w));
}

// Same as audit.py check_landing_pages _tokens.
function nameTokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
}

function isHomepage(url) {
  try {
    return new URL(url).pathname.replace(/\//g, '') === '';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Turn the raw rows into a simple model of the account
// ---------------------------------------------------------------------------

function buildModel(data, ctx) {
  const has = (name) => Array.isArray(data[name]);
  const rows = (name) => (Array.isArray(data[name]) ? data[name] : []);

  const customer = rows('customer')[0]?.customer || {};
  const currency = ctx.currency || customer.currencyCode || 'GBP';

  // Campaigns (one row each; add up just in case the API splits them).
  const campaignMap = new Map();
  for (const r of rows('campaigns')) {
    const c = r.campaign || {};
    const m = r.metrics || {};
    const id = String(c.id ?? c.resourceName ?? '');
    if (!id) continue;
    let cam = campaignMap.get(id);
    if (!cam) {
      cam = {
        id,
        name: c.name || 'Unnamed campaign',
        channel: c.advertisingChannelType || 'UNKNOWN',
        bidding: c.biddingStrategyType || 'UNKNOWN',
        portfolio: Boolean(c.biddingStrategy),
        systemStatus: c.biddingStrategySystemStatus || null,
        targetCpa: fromMicros(c.maximizeConversions?.targetCpaMicros),
        contentNetwork: c.networkSettings?.targetContentNetwork === true,
        geoType: c.geoTargetTypeSetting?.positiveGeoTargetType || null,
        budgetId: c.campaignBudget || null,
        budget: fromMicros(r.campaignBudget?.amountMicros),
        impressions: 0, clicks: 0, spend: 0, conversions: 0, convValue: 0,
        sis: 0, sisBudgetLost: 0, sisRankLost: 0,
      };
      campaignMap.set(id, cam);
    }
    cam.impressions += num(m.impressions);
    cam.clicks += num(m.clicks);
    cam.spend += fromMicros(m.costMicros);
    cam.conversions += num(m.conversions);
    cam.convValue += num(m.conversionsValue);
    cam.sis = num(m.searchImpressionShare) || cam.sis;
    cam.sisBudgetLost = num(m.searchBudgetLostImpressionShare) || cam.sisBudgetLost;
    cam.sisRankLost = num(m.searchRankLostImpressionShare) || cam.sisRankLost;
  }
  const campaigns = [...campaignMap.values()];

  // Keywords, joined to their 30-day stats.
  const kwStats = new Map();
  for (const r of rows('keywordStats')) {
    const key = `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`;
    const s = kwStats.get(key) || { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
    s.impressions += num(r.metrics?.impressions);
    s.clicks += num(r.metrics?.clicks);
    s.cost += fromMicros(r.metrics?.costMicros);
    s.conversions += num(r.metrics?.conversions);
    kwStats.set(key, s);
  }
  const keywords = rows('keywords').map((r) => {
    const crit = r.adGroupCriterion || {};
    const key = `${r.adGroup?.id}~${crit.criterionId}`;
    const s = kwStats.get(key) || { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
    const qs = num(crit.qualityInfo?.qualityScore);
    return {
      key,
      text: crit.keyword?.text || '',
      matchType: crit.keyword?.matchType || 'UNKNOWN',
      qs: qs > 0 ? qs : null,
      campaignId: String(r.campaign?.id ?? ''),
      campaign: r.campaign?.name || '',
      channel: r.campaign?.advertisingChannelType || 'UNKNOWN',
      bidding: r.campaign?.biddingStrategyType || 'UNKNOWN',
      agId: String(r.adGroup?.id ?? ''),
      adGroup: r.adGroup?.name || '',
      ...s,
    };
  });

  // Conversion actions with 30-day totals.
  const convTotals = new Map();
  for (const r of rows('conversionStats')) {
    const key = r.segments?.conversionAction;
    if (!key) continue;
    convTotals.set(key, (convTotals.get(key) || 0) + num(r.metrics?.allConversions));
  }
  const conversionActions = rows('conversionActions').map((r) => {
    const ca = r.conversionAction || {};
    const primary = ca.includeInConversionsMetric !== undefined
      ? ca.includeInConversionsMetric === true
      : ca.primaryForGoal === true;
    return {
      resourceName: ca.resourceName,
      name: ca.name || 'Unnamed action',
      status: ca.status || 'UNKNOWN',
      type: ca.type || 'UNKNOWN',
      category: ca.category || null,
      primary,
      model: ca.attributionModelSettings?.attributionModel || null,
      allConversions: convTotals.get(ca.resourceName) || 0,
    };
  });

  // Search terms, added up per term.
  const termMap = new Map();
  for (const r of rows('searchTerms')) {
    const text = r.searchTermView?.searchTerm;
    if (!text) continue;
    const t = termMap.get(text) || { term: text, campaigns: new Set(), byCampaign: new Map(), impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0 };
    t.campaigns.add(r.campaign?.name || '');
    t.byCampaign.set(r.campaign?.name || '', (t.byCampaign.get(r.campaign?.name || '') || 0) + fromMicros(r.metrics?.costMicros));
    t.impressions += num(r.metrics?.impressions);
    t.clicks += num(r.metrics?.clicks);
    t.cost += fromMicros(r.metrics?.costMicros);
    t.conversions += num(r.metrics?.conversions);
    t.convValue += num(r.metrics?.conversionsValue);
    termMap.set(text, t);
  }
  const searchTerms = [...termMap.values()].sort((a, b) => b.cost - a.cost);

  // Performance Max search terms (an optional read), added up per term the same way. Only the n-gram finding and
  // table use them.
  const pmaxMap = new Map();
  for (const r of rows('pmaxSearchTerms')) {
    const text = r.campaignSearchTermView?.searchTerm;
    if (!text) continue;
    const t = pmaxMap.get(text) || { term: text, campaigns: new Set(), byCampaign: new Map(), impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0 };
    t.campaigns.add(r.campaign?.name || '');
    t.byCampaign.set(r.campaign?.name || '', (t.byCampaign.get(r.campaign?.name || '') || 0) + fromMicros(r.metrics?.costMicros));
    t.impressions += num(r.metrics?.impressions);
    t.clicks += num(r.metrics?.clicks);
    t.cost += fromMicros(r.metrics?.costMicros);
    t.conversions += num(r.metrics?.conversions);
    t.convValue += num(r.metrics?.conversionsValue);
    pmaxMap.set(text, t);
  }
  const pmaxSearchTerms = [...pmaxMap.values()].sort((a, b) => b.cost - a.cost);

  const ads = rows('ads').map((r) => ({
    id: String(r.adGroupAd?.ad?.id ?? ''),
    type: r.adGroupAd?.ad?.type || 'UNKNOWN',
    strength: r.adGroupAd?.adStrength || null,
    finalUrls: r.adGroupAd?.ad?.finalUrls || [],
    path1: r.adGroupAd?.ad?.responsiveSearchAd?.path1 || '',
    path2: r.adGroupAd?.ad?.responsiveSearchAd?.path2 || '',
    agId: String(r.adGroup?.id ?? ''),
    adGroup: r.adGroup?.name || '',
    campaignId: String(r.campaign?.id ?? ''),
    campaign: r.campaign?.name || '',
    channel: r.campaign?.advertisingChannelType || 'UNKNOWN',
  }));

  const adGroups = rows('adGroups').map((r) => ({
    id: String(r.adGroup?.id ?? ''),
    name: r.adGroup?.name || '',
    campaignId: String(r.campaign?.id ?? ''),
    campaign: r.campaign?.name || '',
  }));

  // Products, added up per item id.
  const productMap = new Map();
  for (const r of rows('products')) {
    const s = r.segments || {};
    const id = s.productItemId || s.productTitle;
    if (!id) continue;
    const p = productMap.get(id) || {
      id, title: s.productTitle || '', type: s.productTypeL1 || '', label: s.productCustomAttribute0 || '',
      impressions: 0, clicks: 0, spend: 0, conversions: 0, convValue: 0,
    };
    p.impressions += num(r.metrics?.impressions);
    p.clicks += num(r.metrics?.clicks);
    p.spend += fromMicros(r.metrics?.costMicros);
    p.conversions += num(r.metrics?.conversions);
    p.convValue += num(r.metrics?.conversionsValue);
    productMap.set(id, p);
  }
  const products = [...productMap.values()].sort((a, b) => b.spend - a.spend);

  // The visitor's own target (optional, 21 Nov 2026): { type: 'cpa' | 'roas', value }. ROAS as a ratio (4 = 400%).
  const t = ctx.target;
  const target = t && (t.type === 'cpa' || t.type === 'roas') && Number(t.value) > 0 ? { type: t.type, value: Number(t.value) } : null;

  return {
    has,
    rows,
    customer,
    currency,
    target,
    brand: ctx.brand ? String(ctx.brand).slice(0, 40) : null,
    today: ctx.today || null,
    urlChecks: data.urlChecks || null,
    money: moneyFormatter(currency),
    campaigns,
    keywords,
    conversionActions,
    searchTerms,
    pmaxSearchTerms,
    ads,
    adGroups,
    products,
    totalSpend: campaigns.reduce((s, c) => s + c.spend, 0),
    totalClicks: campaigns.reduce((s, c) => s + c.clicks, 0),
  };
}

// ---------------------------------------------------------------------------
// Rules. Each one calls out.weak(...) and/or out.strong(...).
// ---------------------------------------------------------------------------

// What the account takes to run each month, for the monthly fee (pricing.js monthlyEstimate): campaigns that spent in
// the last 30 days, by type, and the 30-day spend. Brand Search counts separately because it needs little time.
function workload(m) {
  const live = m.campaigns.filter((c) => c.spend > 0);
  return { spend: Math.round(m.totalSpend), campaigns: live.map((c) => ({ channel: c.channel, brand: c.channel === 'SEARCH' && isBrandName(c.name) })) };
}

// 1. Conversion foundation (audit.py check_conversions)
function ruleConversions(m, out) {
  if (!m.has('conversionActions')) return;
  const actions = m.conversionActions;
  const enabled = actions.filter((a) => a.status === 'ENABLED');
  const primary = enabled.filter((a) => a.primary);

  // 1a. No conversion actions at all (audit.py: critical).
  if (enabled.length === 0) {
    out.weak({
      id: 'conversion-tracking-missing',
      category: 'tracking',
      priority: 'high',
      title: 'No conversion tracking set up',
      detail: actions.length
        ? `Your account has ${plural(actions.length, 'conversion action')}, but none of them are switched on.`
        : 'Your account has no conversion actions, so it cannot see which clicks turn into enquiries or sales.',
      why: 'Without conversion tracking you cannot tell which spend brings in business, and Smart Bidding has nothing to aim for.',
      start: 'Set up one conversion action for your main goal, such as a form enquiry, a phone call or a purchase.',
      startLink: LINKS.tracking,
      fixType: 'tracking',
      items: 1,
      itemLabel: 'accounts',
      fromPrice: true,
    });
    return;
  }

  if (primary.length === 0) {
    out.weak({
      id: 'no-primary-conversions',
      category: 'tracking',
      priority: 'high',
      title: 'No conversion action counts as a main goal',
      detail: `You have ${plural(enabled.length, 'conversion action')} switched on, but none is set as primary, so none feeds the Conversions column.`,
      why: 'Smart Bidding and your reports only use primary conversions, so right now they have no goal to work towards.',
      start: 'In Goals, mark the actions that mean real business (enquiries, calls, sales) as primary.',
      startLink: LINKS.tracking,
      fixType: 'tracking',
      items: enabled.length,
      itemLabel: 'conversion actions',
      fromPrice: false,
    });
  } else if (m.has('conversionStats') && m.totalClicks > 0) {
    // 1a. Primary actions recording nothing in the last 30 days.
    // audit.py only checks primary actions; secondary ones are ignored.
    const silent = primary.filter((a) => a.allConversions === 0);
    const recording = primary.filter((a) => a.allConversions > 0);
    if (silent.length) {
      const all = recording.length === 0;
      out.weak({
        id: 'silent-conversion-actions',
        category: 'tracking',
        priority: all ? 'high' : 'medium',
        title: all
          ? 'Your conversion tracking has recorded nothing in 30 days'
          : `${plural(silent.length, 'main conversion action')} recorded nothing in 30 days`,
        detail: `${all && primary.length === 1
          ? 'Your one primary conversion action recorded no conversions'
          : all
            ? `None of your ${primary.length} primary conversion actions recorded a conversion`
            : `${silent.length} of your ${primary.length} primary conversion actions recorded no conversions`} in the last 30 days, while your ads had ${m.totalClicks.toLocaleString('en-GB')} clicks. ${silent.length === 1 ? 'Action' : 'Actions'} with no data: ${examples(silent.map((a) => a.name))}.`,
        why: all
          ? 'If the tag is broken, every report and every automated bid is working without knowing what brings in business.'
          : 'Silent primary actions give Smart Bidding an incomplete picture of what is working.',
        start: 'Test each silent action with Tag Assistant or GTM preview, and switch off any you no longer use.',
        startLink: LINKS.tracking,
        fixType: 'tracking',
        items: silent.length,
        itemLabel: 'conversion actions',
        fromPrice: true,
      });
    } else {
      out.strong({
        id: 'conversion-tracking',
        category: 'tracking',
        priority: 'high',
        title: 'Conversion tracking records enquiries or sales',
        detail: `${allOf(primary.length, 'primary conversion action')} recorded conversions in the last 30 days.`,
      });
    }
  }

  if (primary.length) {
    // 1b. Attribution model. audit.py's list (LAST_CLICK, FIRST_CLICK, LINEAR,
    // TIME_DECAY, POSITION_BASED) never matched the real enum names, which carry
    // a prefix such as GOOGLE_ADS_LAST_CLICK, so match on the ending instead.
    const OUTDATED = ['LAST_CLICK', 'FIRST_CLICK', 'LINEAR', 'TIME_DECAY', 'POSITION_BASED'];
    const outdated = primary.filter((a) => a.model && OUTDATED.some((s) => a.model.endsWith(s)));
    const modelName = (mdl) => mdl.replace(/^GOOGLE_(ADS|SEARCH_ATTRIBUTION)_/, '').toLowerCase().replace(/_/g, ' ');
    if (outdated.length) {
      const models = [...new Set(outdated.map((a) => modelName(a.model)))];
      out.weak({
        id: 'attribution-model',
        category: 'tracking',
        priority: 'medium',
        title: `${plural(outdated.length, 'main conversion action')} on an old attribution model`,
        detail: `${examples(outdated.map((a) => a.name))} ${outdated.length === 1 ? 'uses' : 'use'} ${models.join(' and ')} attribution rather than data-driven.`,
        why: 'Rule-based models give the credit to one click, so Smart Bidding undervalues the searches that start a journey.',
        start: 'Open each primary action in Goals and change its attribution model to data-driven.',
        startLink: LINKS.tracking,
        fixType: 'tracking',
        items: outdated.length,
        itemLabel: 'conversion actions',
        fromPrice: false,
      });
    } else if (primary.some((a) => a.model)) {
      out.strong({
        id: 'attribution-model',
        category: 'tracking',
        priority: 'medium',
        title: 'Your main conversions use data-driven attribution',
        detail: `No primary conversion action uses a rule-based model such as last click (${primary.length} checked).`,
      });
    }

    // 1c. Low-intent actions set as primary (audit.py: critical).
    // ENGAGEMENT replaces audit.py's ENGAGED_VISIT, SESSION and SCROLL, which are
    // not real category values. UNKNOWN is dropped: it means "not known to this
    // API version", not "low intent".
    const MICRO = new Set(['PAGE_VIEW', 'ENGAGEMENT', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'DOWNLOAD']);
    const micro = primary.filter((a) => MICRO.has(a.category));
    if (micro.length) {
      out.weak({
        id: 'micro-conversions-primary',
        category: 'tracking',
        priority: 'high',
        title: `${plural(micro.length, 'low-value action')} counted as a main goal`,
        detail: `${examples(micro.map((a) => a.name))} ${micro.length === 1 ? 'is' : 'are'} set as primary, so ${micro.length === 1 ? 'it counts' : 'they count'} in your Conversions column alongside real enquiries or sales.`,
        why: 'Smart Bidding will chase page views or basket adds instead of the results that pay the bills.',
        start: 'Set these actions to secondary so they are still reported but no longer steer bids.',
        startLink: LINKS.ga4,
        fixType: 'tracking',
        items: micro.length,
        itemLabel: 'conversion actions',
        fromPrice: false,
      });
    } else {
      out.strong({
        id: 'micro-conversions-primary',
        category: 'tracking',
        priority: 'high',
        title: 'Your main goals are real enquiries or sales',
        detail: `No primary conversion action is a page view, basket add or other low-value action (${primary.length} checked).`,
      });
    }

    // 1d. Enhanced conversions. The API (v24) only shows the account setting for
    // leads, so this runs for accounts whose main goals are leads. Shopify's
    // Google & YouTube app sends customer data itself (audit.py exception).
    const SHOPIFY = ['app purchase', 'shopping app', 'google shopping app'];
    const shopifyApp = actions.some((a) => SHOPIFY.some((s) => a.name.toLowerCase().includes(s)));
    const LEAD = new Set(['SUBMIT_LEAD_FORM', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD', 'CONVERTED_LEAD', 'CONTACT', 'REQUEST_QUOTE', 'BOOK_APPOINTMENT', 'SIGNUP']);
    const leadActions = primary.filter((a) => LEAD.has(a.category));
    const setting = m.customer.conversionTrackingSetting || {};
    if (shopifyApp) {
      out.strong({
        id: 'enhanced-conversions',
        category: 'tracking',
        priority: 'medium',
        title: 'Shopify sends customer data with each sale',
        detail: 'Your purchases are tracked by the Google & YouTube app for Shopify, which passes hashed customer details with each conversion.',
      });
    } else if (m.has('customer') && leadActions.length) {
      if (setting.enhancedConversionsForLeadsEnabled === true) {
        out.strong({
          id: 'enhanced-conversions',
          category: 'tracking',
          priority: 'medium',
          title: 'Enhanced conversions for leads is on',
          detail: 'Your account sends hashed contact details with lead conversions, which helps it count leads that cookies miss.',
        });
      } else {
        out.weak({
          id: 'enhanced-conversions',
          category: 'tracking',
          priority: 'medium',
          title: 'Enhanced conversions for leads is off',
          detail: `Your account has ${plural(leadActions.length, 'lead conversion action')} as main goals, but enhanced conversions for leads is not switched on.`,
          why: 'Without it, leads from people who block cookies or switch devices go uncounted, and bidding sees fewer results than you get.',
          start: 'Switch it on in Goals settings, then make sure your enquiry form passes the email address to the tag.',
          startLink: LINKS.tracking,
          fixType: 'tracking',
          items: leadActions.length,
          itemLabel: 'conversion actions',
          fromPrice: true,
        });
      }
    }
  }
}

// 2. Campaigns and budget (audit.py check_campaigns)
function ruleCampaigns(m, out) {
  if (!m.has('campaigns')) return;
  const money = m.money;
  const camps = m.campaigns;
  const hasPrimary = m.conversionActions.some((a) => a.status === 'ENABLED' && a.primary);

  // 2a. Spend with no conversions: over 10 in 30 days, not Performance Max.
  // Skipped when there is no tracking at all, which is reported on its own.
  if (hasPrimary || !m.has('conversionActions')) {
    const eligible = camps.filter((c) => c.spend > 10 && c.channel !== 'PERFORMANCE_MAX');
    const zero = eligible.filter((c) => c.conversions === 0);
    if (zero.length) {
      const wasted = zero.reduce((s, c) => s + c.spend, 0);
      out.weak({
        id: 'spend-no-conversions',
        category: 'structure',
        priority: 'high',
        title: `${plural(zero.length, 'campaign')} spending with no conversions`,
        detail: `${money(wasted)} spent in the last 30 days with no recorded conversions: ${examples(zero.map((c) => c.name))}.`,
        atStake: (() => { const cpa = accountCpa(m); const hit = cpa ? zero.filter((c) => c.spend >= cpa) : []; return cpa ? atStake(hit.reduce((s, c) => s + c.spend, 0), 'Campaigns past your cost per conversion with none', Object.fromEntries(hit.map((c) => [c.name, c.spend]))) : null; })(),
        why: 'Either the targeting is wrong or the tracking is broken, and in both cases that money is not traceable to any business.',
        start: 'Check the tracking fires for these campaigns first, then pause or rebuild the ones that still show nothing.',
        startLink: LINKS.tracking,
        fixType: 'structure',
        items: zero.length,
        itemLabel: 'campaigns',
        fromPrice: false,
      });
    } else if (eligible.length) {
      out.strong({
        id: 'spend-no-conversions',
        category: 'structure',
        priority: 'high',
        title: 'Every campaign that spends brings in conversions',
        detail: `${allOf(eligible.length, 'campaign')} outside Performance Max that spent more than ${money(10)} in the last 30 days recorded conversions. Performance Max is checked by product and asset group.`,
      });
    }
  }

  // 2b. Budget cap: average daily spend at 98% or more of a daily budget over 30
  // (audit.py), else Search impression share under 40% on campaigns spending over 5.
  // Shared budgets are judged on the spend of every campaign that shares them.
  const byBudget = new Map();
  for (const c of camps) {
    const key = c.budgetId || `own:${c.id}`;
    const b = byBudget.get(key) || { budget: c.budget, spend: 0, campaigns: [] };
    b.spend += c.spend;
    b.campaigns.push(c);
    byBudget.set(key, b);
  }
  // Held back but beating the target or average (13c): reported on their own with a suggested budget, and left out here.
  const winners = budgetWinners(m);
  const winIds = new Set(winners.list.map((w) => w.c.id));
  reportBudgetWinners(m, out, winners);
  let constrained = [];
  for (const b of byBudget.values()) {
    const daily = b.spend / 30;
    if (b.budget > 30 && daily > 0 && daily >= b.budget * 0.98) constrained.push(...b.campaigns);
  }
  constrained = constrained.filter((c) => !winIds.has(c.id));
  const search = camps.filter((c) => c.channel === 'SEARCH');
  const lowSis = search.filter((c) => c.sis > 0 && c.sis < 0.4 && c.spend > 5 && !winIds.has(c.id));
  if (winIds.size && !constrained.length && !lowSis.length) {
    // nothing more to say about budgets
  } else if (constrained.length) {
    const c0 = constrained[0];
    out.weak({
      id: 'budget-limited',
      category: 'bidding',
      priority: 'medium',
      title: `${plural(constrained.length, 'campaign')} held back by budget`,
      detail: constrained.length === 1
        ? `"${clean(c0.name)}" averaged ${money(c0.spend / 30)} a day over the last 30 days against a daily budget of ${money(c0.budget)}.`
        : `${examples(constrained.map((c) => c.name))} spend their full daily budget. For example, "${clean(c0.name)}" averaged ${money(c0.spend / 30)} a day against a daily budget of ${money(c0.budget)}.`,
      why: 'When the budget runs out early, your ads stop showing and competitors take the searches you were paying to reach.',
      start: 'Raise the budget if your cost per enquiry or sale is healthy; if not, tighten targeting first.',
      startLink: LINKS.bidding,
      fixType: 'bidding',
      items: constrained.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (lowSis.length) {
    const avg = lowSis.reduce((s, c) => s + c.sis, 0) / lowSis.length;
    out.weak({
      id: 'low-impression-share',
      category: 'bidding',
      priority: 'medium',
      title: `Your ads show for under 40% of searches in ${plural(lowSis.length, 'campaign')}`,
      detail: `Average search impression share is ${pct(avg)} across ${examples(lowSis.map((c) => c.name))}.`,
      why: 'Low impression share means you are missing most of the people searching for what you sell.',
      start: 'Check whether the share is lost to budget (raise it) or to ad rank (improve ads, landing pages and bids).',
      startLink: LINKS.quality,
      fixType: 'bidding',
      items: lowSis.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (camps.some((c) => c.spend > 0)) {
    out.strong({
      id: 'budget-limited',
      category: 'bidding',
      priority: 'medium',
      title: 'No campaigns are held back by budget',
      detail: 'None of your campaigns use up the full daily budget, and none of your Search campaigns show for less than 40% of searches.',
    });
  }

  // 2c. Learning phase. The API has no learning_stage_info field (audit.py used one
  // that does not exist), so this reads bidding_strategy_system_status.
  const learning = camps.filter((c) => c.spend > 0 && c.systemStatus
    && (c.systemStatus.startsWith('LEARNING_') || c.systemStatus === 'LIMITED_BY_DATA'));
  const withStatus = camps.filter((c) => c.spend > 0 && c.systemStatus);
  if (learning.length) {
    const limited = learning.filter((c) => c.systemStatus === 'LIMITED_BY_DATA').length;
    out.weak({
      id: 'learning-phase',
      category: 'bidding',
      priority: 'medium',
      title: `${plural(learning.length, 'campaign')} still learning or short of data`,
      detail: `${examples(learning.map((c) => c.name))} ${learning.length === 1 ? 'is' : 'are'} in the Smart Bidding learning phase${limited ? `, and ${limited} ${limited === 1 ? 'is' : 'are'} limited by too little conversion data` : ''}.`,
      why: 'While a strategy is learning, costs swing around, and every big change starts the learning again.',
      start: 'Hold off on budget, target and strategy changes until learning ends, and make sure each campaign gets enough conversions.',
      startLink: LINKS.fewConversions,
      fixType: 'bidding',
      items: learning.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (withStatus.some((c) => c.systemStatus === 'ENABLED')) {
    out.strong({
      id: 'learning-phase',
      category: 'bidding',
      priority: 'medium',
      title: 'Smart Bidding has settled in',
      detail: 'None of your campaigns are stuck in the learning phase.',
    });
  }

  // 2d. Manual CPC with 30+ conversions in 30 days (audit.py: Search and Display).
  const manualReady = camps.filter((c) => c.bidding.includes('MANUAL_CPC') && c.conversions >= 30
    && (c.channel === 'SEARCH' || c.channel === 'DISPLAY'));
  if (manualReady.length) {
    out.weak({
      id: 'manual-cpc-ready-for-smart-bidding',
      category: 'bidding',
      priority: 'medium',
      title: `${plural(manualReady.length, 'campaign')} on manual bids with enough data for Smart Bidding`,
      detail: `${examples(manualReady.map((c) => c.name))} recorded ${Math.round(manualReady.reduce((s, c) => s + c.conversions, 0))} conversions in 30 days but still ${manualReady.length === 1 ? 'uses' : 'use'} manual CPC.`,
      why: 'With 30 or more conversions a month, Smart Bidding can use signals in each auction that manual bids cannot see.',
      start: 'Move to Maximise conversions with a target CPA set a little above your current cost per conversion.',
      startLink: LINKS.bidding,
      fixType: 'bidding',
      items: manualReady.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (camps.some((c) => c.conversions >= 30)) {
    out.strong({
      id: 'manual-cpc-ready-for-smart-bidding',
      category: 'bidding',
      priority: 'medium',
      title: 'Bidding suits your conversion volume',
      detail: 'None of your campaigns with 30 or more conversions a month are still on manual bids.',
    });
  }
}

// 3. Keywords (audit.py check_keywords)
function ruleKeywords(m, out) {
  if (!m.has('keywords')) return;
  const money = m.money;
  const kws = m.keywords;
  if (!kws.length) return;

  // 3a. Quality Score 3 or below with more than 1 spent (audit.py).
  const scored = kws.filter((k) => k.qs !== null);
  const lowQs = scored.filter((k) => k.qs <= 3 && k.cost > 1);
  if (lowQs.length) {
    const spend = lowQs.reduce((s, k) => s + k.cost, 0);
    out.weak({
      id: 'low-quality-score',
      category: 'keywords',
      priority: 'high',
      title: `${plural(lowQs.length, 'keyword')} with a Quality Score of 3 or below`,
      detail: `${money(spend)} spent in 30 days on keywords scored 3 or below out of 10, such as ${examples(lowQs.sort((a, b) => b.cost - a.cost).map((k) => k.text))}.`,
      why: 'A low Quality Score means you pay more for each click than a competitor with a better matched ad and page.',
      start: 'For each one, check the ad mentions the keyword and the landing page answers the search, and pause any scored 1 or 2.',
      startLink: LINKS.quality,
      fixType: 'keywords',
      items: lowQs.length,
      itemLabel: 'keywords',
      fromPrice: false,
    });
  } else if (scored.length) {
    out.strong({
      id: 'low-quality-score',
      category: 'keywords',
      priority: 'high',
      title: 'No spending keywords with a poor Quality Score',
      detail: `No keyword that spent in the last 30 days has a Quality Score below 4 (${plural(scored.length, 'keyword')} scored).`,
    });
  }

  // 3b. Same keyword and match type in more than one ad group.
  const seen = new Map();
  for (const k of kws) {
    const key = `${k.text.toLowerCase()}|${k.matchType}`;
    const s = seen.get(key) || { text: k.text, groups: new Set() };
    s.groups.add(k.agId);
    seen.set(key, s);
  }
  const dupes = [...seen.values()].filter((s) => s.groups.size > 1);
  if (dupes.length) {
    out.weak({
      id: 'duplicate-keywords',
      category: 'keywords',
      priority: 'medium',
      title: `${plural(dupes.length, 'keyword')} repeated across ad groups`,
      detail: `The same keyword and match type appear in more than one ad group, for example ${examples(dupes.map((d) => d.text))}.`,
      why: 'Your own ad groups compete for the same search, which pushes up costs and splits the data bidding learns from.',
      start: 'Keep each keyword in the one ad group that fits it best and remove the copies.',
      startLink: null,
      fixType: 'keywords',
      items: dupes.length,
      itemLabel: 'keywords',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'duplicate-keywords',
      category: 'keywords',
      priority: 'medium',
      title: 'No duplicate keywords',
      detail: kws.length === 1 ? 'Your only keyword appears in one ad group.' : `Each of your ${plural(kws.length, 'keyword')} appears in only one ad group.`,
    });
  }

  // 3c. Broad match on manual bidding with spend. audit.py's manual set, plus
  // ENHANCED_CPC, which Google has turned into plain manual CPC.
  const MANUAL = new Set(['MANUAL_CPC', 'MANUAL_CPM', 'MANUAL_CPV', 'TARGET_IMPRESSION_SHARE', 'ENHANCED_CPC']);
  const broadManual = kws.filter((k) => k.matchType === 'BROAD' && MANUAL.has(k.bidding) && k.cost > 0);
  if (broadManual.length) {
    const camps = [...new Set(broadManual.map((k) => k.campaign))];
    const spend = broadManual.reduce((s, k) => s + k.cost, 0);
    out.weak({
      id: 'broad-match-manual-bidding',
      category: 'keywords',
      priority: 'high',
      title: `Broad match on manual bids in ${plural(camps.length, 'campaign')}`,
      detail: `${plural(broadManual.length, 'broad match keyword')} spent ${money(spend)} in 30 days on manual bidding, in ${examples(camps)}.`,
      why: 'Broad match relies on Smart Bidding to filter out poor searches, and on manual bids nothing does that job.',
      start: 'Either move these campaigns to Smart Bidding, or change the keywords to phrase or exact match.',
      startLink: LINKS.bidding,
      fixType: 'bidding',
      items: camps.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'broad-match-manual-bidding',
      category: 'keywords',
      priority: 'high',
      title: 'Broad match is paired with Smart Bidding',
      detail: 'No broad match keywords are spending on manual bids.',
    });
  }

  // 3d. Search campaigns with spend and no negative keywords. Shared lists and
  // an account-level list also count (audit.py only looked at campaign negatives).
  if (m.has('negativeKeywords') && m.has('campaigns')) {
    const covered = new Set(m.rows('negativeKeywords').map((r) => String(r.campaign?.id)));
    for (const r of m.rows('negativeKeywordLists')) covered.add(String(r.campaign?.id));
    const accountList = m.rows('accountNegativeLists').length > 0;
    const searchCamps = m.campaigns.filter((c) => c.channel === 'SEARCH' && c.impressions > 0);
    const missing = accountList ? [] : searchCamps.filter((c) => !covered.has(c.id));
    if (missing.length) {
      out.weak({
        id: 'no-negative-keywords',
        category: 'keywords',
        priority: 'high',
        title: `${plural(missing.length, 'Search campaign')} with no negative keywords`,
        detail: `${examples(missing.map((c) => c.name))} ${missing.length === 1 ? 'has' : 'have'} no negative keywords and no negative keyword list.`,
        why: 'Without negatives, every loosely related search can trigger your ads and use up budget.',
        start: 'Go through the search terms report and add the irrelevant searches as negatives, starting with the most expensive.',
        startLink: null,
        fixType: 'negatives',
        items: missing.length,
        itemLabel: 'campaigns',
        fromPrice: false,
      });
    } else if (searchCamps.length) {
      out.strong({
        id: 'no-negative-keywords',
        category: 'keywords',
        priority: 'high',
        title: 'Every Search campaign has negative keywords',
        detail: `${allOf(searchCamps.length, 'active Search campaign')} ${verb(searchCamps.length, 'has', 'have')} negative keywords to block searches you do not want.`,
      });
    }
  }
}

// 4. Search terms (audit.py check_search_terms and _compute_ngrams)
// Every word and phrase of 1 to 3 words across the search terms, with what the terms containing it cost and brought in.
// Shared by the n-gram finding and the report's n-gram table (audit.py _compute_ngrams).
// Guards on the "costing money" n-grams (Lewis, 18 Nov 2026, after the Lee Renée run listed "rings" and "earrings"
// as words to block). 1. Relevance first: a word or phrase that shares a word with what the account sells (product
// titles and types, keywords, asset group, campaign and ad group names) is never put forward as a negative; it is the
// business's own vocabulary, and whether it pays is a bidding question, not a blocking one. Plurals match singulars.
// 2. Enough evidence: it must have spent at least the account's average cost per conversion with none, so one sale's
// worth of spend without a sale is not called waste. With no conversions in the account the old £2 floor stays.
const plainWord = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
function ownWords(m) {
  const vocab = new Set();
  const add = (text) => ngramWords(text).forEach((w) => vocab.add(plainWord(w)));
  m.products.forEach((p) => { add(p.title); add(p.type); });
  m.keywords.forEach((k) => add(k.text));
  m.campaigns.forEach((c) => add(c.name));
  m.adGroups.forEach((g) => add(g.name));
  m.rows('assetGroups').forEach((r) => add(r.assetGroup?.name));
  return vocab;
}
function wasteGuard(m) {
  const conv = m.campaigns.reduce((s, c) => s + c.conversions, 0);
  const cpa = conv > 0 ? m.totalSpend / conv : null;
  const vocab = ownWords(m);
  return {
    min: cpa ? Math.max(2, cpa) : 2,
    cpa,
    ownWord: (ngram) => ngram.split(' ').some((w) => vocab.has(plainWord(w))),
  };
}

// What a finding could cost over the next 30 days if nothing changes (Lewis, 18 Nov 2026: in place of a price, and
// left empty when the sum isn't solid). Only spend the last 30 days already shows coming back with nothing, and only
// past the account's own cost per conversion, so a quiet stretch isn't counted as loss. Null when the account has no
// conversions to measure against, or when nothing clears the bar.
function accountCpa(m) {
  const conv = m.campaigns.reduce((s, c) => s + c.conversions, 0);
  return conv > 0 ? m.totalSpend / conv : null;
}
// by: how the amount splits across campaigns, keyed by campaign name ({ name: weight }, scaled to the amount here).
// The action plan uses it so money in a campaign already counted higher up the list is not counted again.
// mayOverlap: the rows don't say which campaign the money sits in (products), so the plan shows it in full with a note.
function atStake(amount, basis, by, mayOverlap) {
  if (!(amount >= 1)) return null;
  const out = { amount: round2(amount), basis };
  if (mayOverlap) out.mayOverlap = true;
  if (by) {
    const entries = [...(by instanceof Map ? by.entries() : Object.entries(by))].filter(([, v]) => v > 0);
    const total = entries.reduce((t, [, v]) => t + v, 0);
    if (total > 0) out.byCampaign = Object.fromEntries(entries.map(([k, v]) => [k, round2((amount * v) / total)]));
  }
  return out;
}
// Adds up search-term cost per campaign name.
function termSplit(terms) {
  const by = new Map();
  for (const t of terms) for (const [k, v] of t.byCampaign || []) by.set(k, (by.get(k) || 0) + v);
  return by;
}

function ngramTerms(m) { return m.searchTerms.concat(m.pmaxSearchTerms || []); }
function ngramAgg(m) {
  const agg = new Map();
  for (const t of ngramTerms(m)) {
    const words = ngramWords(t.term);
    const seenHere = new Set();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const ng = words.slice(i, i + n).join(' ');
        if (seenHere.has(ng)) continue;
        seenHere.add(ng);
        const a = agg.get(ng) || { ngram: ng, n, cost: 0, conversions: 0, convValue: 0, clicks: 0, termCount: 0 };
        a.cost += t.cost;
        a.conversions += t.conversions;
        a.convValue += t.convValue || 0;
        a.clicks += t.clicks || 0;
        a.termCount += 1;
        agg.set(ng, a);
      }
    }
  }
  return agg;
}

// The report's n-gram table (the old audit report showed the same): repeated words and phrases that spent with no
// conversions, and the ones that bring conversions in. Each needs 2 or more search terms. Top 20 of each.
function ngramTable(m) {
  const terms = ngramTerms(m);
  if (!terms.length) return null;
  const rows = [...ngramAgg(m).values()].filter((a) => a.termCount >= 2);
  const shape = (a) => ({ text: clean(a.ngram, 50), n: a.n, terms: a.termCount, clicks: a.clicks, cost: round2(a.cost), conversions: Math.round(a.conversions * 10) / 10 });
  const guard = wasteGuard(m);
  const unconverted = rows.filter((a) => a.conversions === 0 && a.cost >= 2);
  const wasted = unconverted.filter((a) => a.cost >= guard.min && !guard.ownWord(a.ngram)).sort((a, b) => b.cost - a.cost).slice(0, 20).map(shape);
  const ownLeftOut = unconverted.filter((a) => a.cost >= guard.min && guard.ownWord(a.ngram)).length;
  const performing = rows.filter((a) => a.conversions > 0).sort((a, b) => b.conversions - a.conversions || a.cost - b.cost).slice(0, 20).map(shape);
  return { searchTerms: m.searchTerms.length, pmaxSearchTerms: (m.pmaxSearchTerms || []).length, wasted, performing,
    minSpend: round2(guard.min), costPerConversion: guard.cpa ? round2(guard.cpa) : null, ownLeftOut, wastedSpend: round2(terms.filter((t) => t.conversions === 0).reduce((s, t) => s + t.cost, 0)) };
}

// When conversions come in: day of week by hour (account time zone), last 30 days. Null when the read failed or is empty.
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
function dayHourTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const grid = () => DAYS.map(() => new Array(24).fill(0));
  const conv = grid(), clicks = grid(), cost = grid();
  for (const r of rows) {
    const d = DAYS.indexOf(r.segments?.dayOfWeek);
    const h = Number(r.segments?.hour);
    if (d < 0 || !(h >= 0 && h < 24)) continue;
    conv[d][h] += num(r.metrics?.conversions);
    clicks[d][h] += num(r.metrics?.clicks);
    cost[d][h] += fromMicros(r.metrics?.costMicros);
  }
  const r1 = (g) => g.map((row) => row.map((v) => Math.round(v * 10) / 10));
  const totalConv = conv.flat().reduce((s, v) => s + v, 0);
  const totalClicks = clicks.flat().reduce((s, v) => s + v, 0);
  if (!totalClicks && !totalConv) return null;
  return { conversions: r1(conv), clicks: clicks.map((row) => row.map((v) => Math.round(v))), cost: cost.map((row) => row.map(round2)), totalConversions: Math.round(totalConv * 10) / 10 };
}

function ruleSearchTerms(m, out) {
  if (!m.has('searchTerms')) return;
  const money = m.money;

  // Terms over 3 with fewer than 0.5 conversions, top 50 by cost (audit.py).
  const terms = m.searchTerms.filter((t) => t.cost > 3 && t.conversions < 0.5).slice(0, 50);
  const kwTokens = new Set();
  for (const k of m.keywords) for (const t of termTokens(k.text)) kwTokens.add(t);

  if (!terms.length) {
    if (m.searchTerms.length) {
      out.strong({
        id: 'search-term-waste',
        category: 'search-terms',
        priority: 'high',
        title: 'No search terms wasting money',
        detail: `None of your ${plural(m.searchTerms.length, 'search term')} with spend cost more than ${money(3)} without a conversion in the last 30 days.`,
      });
    }
  } else {
    // A term shares no word with any keyword: off target. A term that does is
    // treated as brand or navigational and not counted as waste (audit.py).
    const overlaps = (t) => [...termTokens(t.term)].some((w) => kwTokens.has(w));
    const irrelevant = kwTokens.size ? terms.filter((t) => !overlaps(t)) : terms;
    const related = kwTokens.size ? terms.filter(overlaps) : [];

    if (irrelevant.length) {
      const waste = irrelevant.reduce((s, t) => s + t.cost, 0);
      const share = m.totalSpend > 0 ? waste / m.totalSpend : 0;
      // audit.py: over 300 or over 5% of spend is critical, 50 or more is high,
      // otherwise medium. Critical and high both map to high here.
      const priority = waste >= 50 || share > 0.05 ? 'high' : 'medium';
      const shareText = m.totalSpend > 0 ? ` (${(share * 100).toFixed(1)}% of your spend)` : '';
      const relatedText = related.length === 1
        ? ' One more search term with no conversions shares words with your keywords, so it is left out.'
        : related.length > 1
          ? ` Another ${related.length} search terms with no conversions share words with your keywords, so they are left out.`
          : '';
      out.weak({
        id: 'search-term-waste',
        category: 'search-terms',
        priority,
        title: kwTokens.size
          ? `${plural(irrelevant.length, 'off-target search term')} with no conversions`
          : `${plural(irrelevant.length, 'search term')} spending with no conversions`,
        detail: `${money(waste)}${shareText} spent in 30 days on searches ${kwTokens.size ? 'that share no words with your keywords' : 'that brought no conversions'}, such as ${examples(irrelevant.map((t) => t.term), 4)}.${relatedText}`,
        atStake: kwTokens.size ? atStake(waste, 'Searches with no link to your keywords', termSplit(irrelevant)) : null,
        why: 'These searches have cost money, brought nothing and have no link to what you sell, so blocking them saves budget straight away.',
        start: 'Add these searches as negative keywords, then check the search terms report every week.',
        startLink: null,
        fixType: 'negatives',
        items: irrelevant.length,
        itemLabel: 'search terms',
        fromPrice: false,
      });
    } else {
      const spend = related.reduce((s, t) => s + t.cost, 0);
      out.strong({
        id: 'search-term-waste',
        category: 'search-terms',
        priority: 'high',
        title: 'Your search terms stay on topic',
        detail: related.length === 1
          ? `Your one search term that spent without a conversion (${money(spend)}) shares words with your keywords, so it does not look off target.`
          : `All ${related.length} search terms that spent without a conversion (${money(spend)} in total) share words with your keywords, so none look off target.`,
      });
    }
  }

  // N-gram patterns: words and phrases of 1 to 3 words seen in 2+ terms with
  // 1+ spend; wasted means no conversions and 2+ spend; top 15; reported when
  // the total reaches 5 (audit.py _compute_ngrams and _score_ngrams).
  const agg = ngramAgg(m);
  const guard = wasteGuard(m);
  const wasted = [...agg.values()]
    .filter((a) => a.termCount >= 2 && a.conversions === 0 && a.cost >= guard.min && !guard.ownWord(a.ngram))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 15);
  const total = wasted.reduce((s, a) => s + a.cost, 0);
  if (wasted.length && total >= 5) {
    const top = wasted.slice(0, 3).map((a) => `"${clean(a.ngram)}" (${money(a.cost)})`).join(', ');
    out.weak({
      id: 'ngram-waste',
      category: 'search-terms',
      priority: 'low',
      title: `${plural(wasted.length, 'repeated word', 'repeated words and phrases')} with spend and no conversions`,
      detail: `Across ${plural(ngramTerms(m).length, 'search term')}${(m.pmaxSearchTerms || []).length ? ' in Search and Performance Max' : ''}, these words keep coming up in searches that never convert: ${top}.`,
      atStake: (() => { const hit = ngramTerms(m).filter((t) => t.conversions === 0 && wasted.some((a) => (' ' + ngramWords(t.term).join(' ') + ' ').includes(' ' + a.ngram + ' '))); return atStake(hit.reduce((s, t) => s + t.cost, 0), 'Searches containing these words', termSplit(hit)); })(),
      why: 'One negative keyword on a repeated word blocks every search that contains it, including ones you have not seen yet.',
      start: 'Check each word is never useful to you, then add it as a negative keyword at account level.',
      startLink: null,
      fixType: 'negatives',
      items: wasted.length,
      itemLabel: 'words and phrases',
      fromPrice: false,
    });
  }
}

// 5. Automation (audit.py check_automation)
function ruleAutomation(m, out) {
  const money = m.money;

  // 5a. Performance Max asset group strength.
  if (m.has('assetGroups')) {
    const groups = m.rows('assetGroups').map((r) => ({
      name: r.assetGroup?.name || '',
      strength: r.assetGroup?.adStrength || 'UNSPECIFIED',
    }));
    const WEAK = new Set(['POOR', 'AVERAGE', 'PENDING', 'UNSPECIFIED']); // audit.py
    const weak = groups.filter((g) => WEAK.has(g.strength));
    const poor = weak.filter((g) => g.strength === 'POOR');
    if (weak.length) {
      out.weak({
        id: 'pmax-asset-strength',
        category: 'ads',
        priority: poor.length ? 'medium' : 'low',
        title: `${plural(weak.length, 'Performance Max asset group')} rated below Good`,
        detail: `${someOf(weak.length, groups.length, 'asset group')} ${verbOf(weak.length, groups.length, 'is', 'are')} not rated Good or Excellent${poor.length ? ` (${poor.length} rated Poor)` : ''}: ${examples(weak.map((g) => g.name), 3, weak.length)}.`,
        why: 'Weak asset groups give Google fewer combinations to build ads from, so they show less often.',
        start: 'Add more headlines, descriptions, images and a video to each weak group until it reaches Good.',
        startLink: LINKS.ads,
        fixType: 'ad_copy',
        items: weak.length,
        itemLabel: 'asset groups',
        fromPrice: false,
      });
    } else if (groups.length) {
      out.strong({
        id: 'pmax-asset-strength',
        category: 'ads',
        priority: 'medium',
        title: 'Performance Max asset groups are rated Good or better',
        detail: `${allOf(groups.length, 'asset group')} ${verb(groups.length, 'has', 'have')} Good or Excellent ad strength.`,
      });
    }
  }

  // 5b. Maximise conversions with no target CPA and over 50 spent (audit.py).
  // Portfolio strategies are skipped, as their target is not on the campaign.
  if (m.has('campaigns')) {
    const maxConv = m.campaigns.filter((c) => c.bidding === 'MAXIMIZE_CONVERSIONS' && c.spend > 50 && !c.portfolio);
    const noTarget = maxConv.filter((c) => !(c.targetCpa > 0));
    if (noTarget.length) {
      const spend = noTarget.reduce((s, c) => s + c.spend, 0);
      out.weak({
        id: 'max-conversions-no-target',
        category: 'bidding',
        priority: 'medium',
        title: `${plural(noTarget.length, 'campaign')} on Maximise conversions with no target`,
        detail: `${examples(noTarget.map((c) => c.name))} spent ${money(spend)} in 30 days with no target cost per conversion.`,
        why: 'Without a target, Google aims to spend the whole budget, even when the extra conversions cost far more.',
        start: 'Set a target CPA on each one, based on its actual cost per conversion over the last 30 days.',
        startLink: LINKS.fewConversions,
        fixType: 'bidding',
        items: noTarget.length,
        itemLabel: 'campaigns',
        fromPrice: false,
      });
    } else if (maxConv.length) {
      out.strong({
        id: 'max-conversions-no-target',
        category: 'bidding',
        priority: 'medium',
        title: 'Smart Bidding has cost targets',
        detail: `${allOf(maxConv.length, 'campaign')} on Maximise conversions ${verb(maxConv.length, 'has', 'have')} a target CPA set.`,
      });
    }
  }
}

// 6. Ads (audit.py check_ads and the RSA path part of check_landing_pages)
function ruleAds(m, out) {
  if (!m.has('ads')) return;
  const searchAds = m.ads.filter((a) => a.channel === 'SEARCH');
  const isRsa = (a) => a.type.includes('RESPONSIVE_SEARCH');
  const WEAK = new Set(['POOR', 'AVERAGE']);

  // 6a. Ad groups with a single ad, brand groups excluded (audit.py). Only flags
  // the ones whose ad is not rated Good or Excellent: audit.py passes a strong
  // single RSA, as it already rotates up to 15 headlines.
  const byGroup = new Map();
  for (const a of searchAds) {
    const g = byGroup.get(a.agId) || { name: a.adGroup, campaign: a.campaign, ads: [] };
    g.ads.push(a);
    byGroup.set(a.agId, g);
  }
  const singles = [...byGroup.values()].filter((g) => g.ads.length === 1 && !isBrandName(g.name) && !isBrandName(g.campaign));
  const singleWeak = singles.filter((g) => !['GOOD', 'EXCELLENT'].includes(g.ads[0].strength));
  const singleWeakIds = new Set(singleWeak.map((g) => g.ads[0].id));
  if (singleWeak.length) {
    out.weak({
      id: 'single-weak-ad',
      category: 'ads',
      priority: 'medium',
      title: `${plural(singleWeak.length, 'ad group')} with one ad that is not rated Good`,
      detail: `${singleWeak.length === 1 ? 'This ad group runs' : 'These ad groups run'} a single ad rated below Good: ${examples(singleWeak.map((g) => g.name), 3, singleWeak.length)}.`,
      why: 'One weak ad gives Google little to test, so the ad group cannot find a better message.',
      start: 'Improve the existing ad to Good (more headlines and descriptions, less pinning), or add a second ad with a different angle.',
      startLink: LINKS.quality,
      fixType: 'ad_copy',
      items: singleWeak.length,
      itemLabel: 'ad groups',
      fromPrice: false,
    });
  } else if (byGroup.size) {
    out.strong({
      id: 'single-weak-ad',
      category: 'ads',
      priority: 'medium',
      title: 'Every ad group has enough ads to test',
      detail: `Outside brand ad groups, ${byGroup.size === 1 ? 'your only Search ad group with ads has' : `each of your ${byGroup.size} Search ad groups with ads has`} two or more ads, or one ad rated Good or Excellent.`,
    });
  }

  // 6b. RSAs rated Poor or Average. Ads already counted in 6a are left out so
  // the same ad is not priced twice.
  const rsas = searchAds.filter(isRsa);
  const weakRsas = rsas.filter((a) => WEAK.has(a.strength));
  const weakRest = weakRsas.filter((a) => !singleWeakIds.has(a.id));
  if (weakRest.length) {
    const groups = new Set(weakRest.map((a) => a.agId)).size;
    out.weak({
      id: 'weak-rsa-strength',
      category: 'ads',
      priority: 'medium',
      title: `${plural(weakRest.length, 'responsive search ad')} rated Poor or Average`,
      detail: `${someOf(weakRest.length, rsas.length, 'responsive search ad')} ${verbOf(weakRest.length, rsas.length, 'is', 'are')} rated Poor or Average, in ${groups === 1 ? 'the ad group' : `${plural(groups, 'ad group')}:`} ${examples(weakRest.map((a) => a.adGroup))}.`,
      why: 'Ads rated below Good enter fewer auctions and give Google fewer combinations to test.',
      start: 'Fill all 15 headlines and 4 descriptions, use the keyword in two or three headlines and avoid pinning.',
      startLink: LINKS.quality,
      fixType: 'ad_copy',
      items: weakRest.length,
      itemLabel: 'ads',
      fromPrice: false,
    });
  } else if (rsas.length && !weakRsas.length) {
    out.strong({
      id: 'weak-rsa-strength',
      category: 'ads',
      priority: 'medium',
      title: 'Your search ads are rated Good or Excellent',
      detail: `No responsive search ad is rated Poor or Average (${rsas.length} checked).`,
    });
  }

  // 6c. Sitelinks and callouts, at account or campaign level (audit.py only
  // looked at account level). Only checked when Search or Performance Max runs.
  if (m.has('customerAssets') || m.has('campaignAssets')) {
    const types = new Set();
    for (const r of m.rows('customerAssets')) types.add(r.customerAsset?.fieldType);
    for (const r of m.rows('campaignAssets')) types.add(r.campaignAsset?.fieldType);
    const relevant = m.campaigns.some((c) => c.channel === 'SEARCH' || c.channel === 'PERFORMANCE_MAX') || searchAds.length > 0;
    const missing = [];
    if (!types.has('SITELINK')) missing.push('sitelinks');
    if (!types.has('CALLOUT')) missing.push('callouts');
    if (relevant && missing.length) {
      out.weak({
        id: 'missing-sitelinks-callouts',
        category: 'ads',
        priority: 'medium',
        title: `No ${missing.join(' or ')} on your ads`,
        detail: `Your account has no active ${missing.join(' or ')} at account or campaign level.`,
        why: 'They make your ad bigger on the page and give people more reasons to click, at no extra cost per click.',
        start: missing.includes('sitelinks')
          ? 'Add four or more sitelinks to your key pages, and callouts for what makes you different.'
          : 'Add callouts for what makes you different, such as guarantees, experience or delivery.',
        startLink: LINKS.ads,
        fixType: 'ad_copy',
        items: missing.length,
        itemLabel: 'asset types',
        fromPrice: false,
      });
    } else if (relevant) {
      out.strong({
        id: 'missing-sitelinks-callouts',
        category: 'ads',
        priority: 'medium',
        title: 'Sitelinks and callouts are in place',
        detail: 'Your ads have sitelinks and callouts to make them larger and more useful.',
      });
    }
  }

  // 6d. RSAs with no display path: more than half of them (audit.py).
  const allRsas = m.ads.filter(isRsa);
  if (allRsas.length) {
    const noPath = allRsas.filter((a) => !a.path1 && !a.path2);
    const share = noPath.length / allRsas.length;
    if (share > 0.5) {
      out.weak({
        id: 'rsa-display-paths',
        category: 'ads',
        priority: 'low',
        title: `${pct(share)} of your search ads have no display path`,
        detail: `${someOf(noPath.length, allRsas.length, 'responsive search ad')} ${verbOf(noPath.length, allRsas.length, 'shows', 'show')} only your domain in the web address line.`,
        why: 'A short path such as /plumbing/ely tells people the click leads to what they searched for.',
        start: 'Add path 1 for the service and path 2 for the place or detail on each ad.',
        startLink: null,
        fixType: 'ad_copy',
        items: noPath.length,
        itemLabel: 'ads',
        fromPrice: false,
      });
    } else {
      out.strong({
        id: 'rsa-display-paths',
        category: 'ads',
        priority: 'low',
        title: 'Your ads use display paths',
        detail: `${someOf(allRsas.length - noPath.length, allRsas.length, 'responsive search ad')} ${verbOf(allRsas.length - noPath.length, allRsas.length, 'shows', 'show')} a path after your domain.`,
      });
    }
  }
}

// 7. Ad groups (audit.py check_ad_groups)
function ruleAdGroups(m, out) {
  if (!m.has('keywords')) return;
  const perGroup = new Map();
  for (const k of m.keywords) {
    const g = perGroup.get(k.agId) || { name: k.adGroup, count: 0 };
    g.count += 1;
    perGroup.set(k.agId, g);
  }

  // 7a. More than 20 keywords in one ad group (audit.py).
  const bloated = [...perGroup.values()].filter((g) => g.count > 20).sort((a, b) => b.count - a.count);
  if (bloated.length) {
    out.weak({
      id: 'bloated-ad-groups',
      category: 'structure',
      priority: 'medium',
      title: `${plural(bloated.length, 'ad group')} with more than 20 keywords`,
      detail: `${examples(bloated.map((g) => g.name))} ${bloated.length === 1 ? 'holds' : 'hold'} more than 20 keywords. The largest has ${bloated[0].count}.`,
      why: 'One ad cannot speak to that many different searches, so relevance and Quality Score drop across the group.',
      start: 'Split each large ad group by theme, such as service, product or place, so one ad fits every keyword in it.',
      startLink: LINKS.quality,
      fixType: 'structure',
      items: bloated.length,
      itemLabel: 'ad groups',
      fromPrice: false,
    });
  } else if (perGroup.size) {
    out.strong({
      id: 'bloated-ad-groups',
      category: 'structure',
      priority: 'medium',
      title: 'Ad groups are tightly themed',
      detail: `No ad group has more than 20 keywords (${plural(perGroup.size, 'ad group')} checked).`,
    });
  }

  // 7b. Enabled Search ad groups with no enabled keywords.
  if (m.has('adGroups') && m.adGroups.length) {
    const empty = m.adGroups.filter((g) => !perGroup.has(g.id));
    if (empty.length) {
      out.weak({
        id: 'empty-ad-groups',
        category: 'structure',
        priority: 'low',
        title: `${plural(empty.length, 'live ad group')} with no keywords`,
        detail: `${examples(empty.map((g) => g.name))} ${empty.length === 1 ? 'is' : 'are'} switched on but ${empty.length === 1 ? 'has' : 'have'} no active keywords, so ${empty.length === 1 ? 'it cannot' : 'they cannot'} show ads.`,
        why: 'Empty ad groups add clutter and make it harder to see where the budget actually goes.',
        start: 'Pause or remove them, or add keywords if they are meant to run.',
        startLink: null,
        fixType: 'structure',
        items: empty.length,
        itemLabel: 'ad groups',
        fromPrice: false,
      });
    } else {
      out.strong({
        id: 'empty-ad-groups',
        category: 'structure',
        priority: 'low',
        title: 'No empty ad groups',
        detail: `${allOf(m.adGroups.length, 'live Search ad group')} ${verb(m.adGroups.length, 'has', 'have')} keywords.`,
      });
    }
  }
}

// 8. Landing pages (audit.py check_landing_pages, homepage part)
function ruleLandingPages(m, out) {
  if (!m.has('ads')) return;
  if (m.has('campaigns') && !m.campaigns.some((c) => c.channel === 'SEARCH')) return;
  const searchAds = m.ads.filter((a) => a.channel === 'SEARCH');
  if (!searchAds.length) return;

  // Brand campaign: "brand" in the name, or every keyword word appears in the
  // campaign name (audit.py). Brand ads going to the homepage is expected.
  const kwTokensByCampaign = new Map();
  for (const k of m.keywords) {
    if (k.channel !== 'SEARCH') continue;
    const set = kwTokensByCampaign.get(k.campaignId) || new Set();
    for (const t of nameTokens(k.text)) set.add(t);
    kwTokensByCampaign.set(k.campaignId, set);
  }
  const isBrandCampaign = (id, name) => {
    if (String(name || '').toLowerCase().includes('brand')) return true;
    const kw = kwTokensByCampaign.get(id);
    if (!kw || !kw.size) return false;
    const allowed = new Set([...nameTokens(name), 'the', 'a', 'an', 'and', 'or']);
    return [...kw].every((t) => allowed.has(t));
  };

  let brandUrls = 0;
  const scored = [];
  for (const a of searchAds) {
    const brand = isBrandCampaign(a.campaignId, a.campaign);
    for (const url of a.finalUrls) {
      if (!url) continue;
      if (brand) brandUrls += 1;
      else scored.push({ url, ad: a });
    }
  }
  if (!scored.length) return;

  const home = scored.filter((s) => isHomepage(s.url));
  const share = home.length / scored.length;
  const brandNote = brandUrls ? ` Brand campaigns are left out, as the homepage suits them.` : '';
  if (share > 0.5) {
    const groups = [...new Set(home.map((s) => s.ad.agId))];
    out.weak({
      id: 'homepage-landing-pages',
      category: 'ads',
      priority: 'high',
      title: `${pct(share)} of your non-brand ads go to the homepage`,
      detail: `${home.length} of ${scored.length} final URLs on non-brand Search ads point to your homepage, across ${plural(groups.length, 'ad group')}.${brandNote}`,
      why: 'People who click an ad for one service and land on a general page often leave before they find it.',
      start: 'Point each ad group at the page that matches its keywords, and build one where none exists.',
      startLink: LINKS.quality,
      fixType: 'structure',
      items: groups.length,
      itemLabel: 'ad groups',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'homepage-landing-pages',
      category: 'ads',
      priority: 'high',
      title: 'Ads send people to the right pages',
      detail: `${scored.length - home.length} of ${scored.length} final URLs on non-brand Search ads go to a specific page rather than the homepage.${brandNote}`,
    });
  }
}

// 9. Audiences (audit.py check_audiences). Ad group and campaign level both count.
function ruleAudiences(m, out) {
  if (!m.has('campaigns')) return;
  if (!m.has('audienceCriteria') && !m.has('campaignCriteria')) return;
  const search = m.campaigns.filter((c) => c.channel === 'SEARCH' && c.spend > 5);
  if (!search.length) return;
  const AUDIENCE = new Set(['USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AUDIENCE']);
  const covered = new Set();
  for (const r of m.rows('audienceCriteria')) covered.add(String(r.campaign?.id));
  for (const r of m.rows('campaignCriteria')) {
    if (AUDIENCE.has(r.campaignCriterion?.type)) covered.add(String(r.campaign?.id));
  }
  const missing = search.filter((c) => !covered.has(c.id));
  const missingSpend = missing.reduce((s, c) => s + c.spend, 0);
  if (missing.length) {
    out.weak({
      id: 'no-audiences',
      category: 'settings',
      priority: missingSpend > 20 ? 'medium' : 'low', // audit.py: over 20 spent is medium
      title: `${plural(missing.length, 'Search campaign')} with no audiences added`,
      detail: `${examples(missing.map((c) => c.name))} ${missing.length === 1 ? 'has' : 'have'} no remarketing, customer or interest audiences, not even in observation mode. ${missing.length === 1 ? 'It' : 'They'} spent ${m.money(missingSpend)} in 30 days.`,
      why: 'Audiences in observation mode do not limit who sees your ads, but they show how past visitors and customers perform and give bidding more to go on.',
      start: 'Add your website visitors and customer lists to each Search campaign in observation mode.',
      startLink: null,
      fixType: 'settings',
      items: missing.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'no-audiences',
      category: 'settings',
      priority: 'medium',
      title: 'Search campaigns have audiences added',
      detail: `${allOf(search.length, 'active Search campaign')} ${verb(search.length, 'has', 'have')} audiences added, so you can see how past visitors and customers perform.`,
    });
  }
}

// 10. Device and ad schedule bid adjustments (audit.py check_bidding).
function ruleBidAdjustments(m, out) {
  if (!m.has('campaigns') || !m.has('campaignCriteria')) return;
  // Search campaigns with more than 50 spent (audit.py).
  const search = m.campaigns.filter((c) => c.channel === 'SEARCH' && c.spend > 50);
  if (!search.length) return;
  const adjusted = new Map();
  for (const r of m.rows('campaignCriteria')) {
    const cc = r.campaignCriterion || {};
    const id = String(r.campaign?.id);
    const a = adjusted.get(id) || { device: false, schedule: false };
    // A modifier of 1.0 means no change. audit.py skipped 0 (a device switched
    // off entirely), which is a deliberate adjustment, so 0 counts here.
    const changed = cc.bidModifier !== undefined && cc.bidModifier !== null && num(cc.bidModifier) !== 1;
    if (cc.type === 'DEVICE' && changed) a.device = true;
    if (cc.type === 'AD_SCHEDULE' && changed) a.schedule = true;
    adjusted.set(id, a);
  }
  const manual = search.filter((c) => c.bidding.includes('MANUAL') || c.bidding.includes('ENHANCED_CPC'));
  const noDevice = search.filter((c) => !adjusted.get(c.id)?.device);
  const noSchedule = search.filter((c) => !adjusted.get(c.id)?.schedule);

  if (!manual.length) {
    out.strong({
      id: 'bid-adjustments',
      category: 'bidding',
      priority: 'medium',
      title: 'Smart Bidding adjusts bids by device and time',
      detail: `${allOf(search.length, 'main Search campaign')} ${verb(search.length, 'uses', 'use')} Smart Bidding, which sets bids for each device and hour on its own.`,
    });
    return;
  }

  // audit.py flags only when manual bidding is in use and no campaign has any adjustment.
  if (noDevice.length === search.length) {
    out.weak({
      id: 'no-device-adjustments',
      category: 'bidding',
      priority: 'medium',
      title: 'No device bid adjustments on manual campaigns',
      detail: `${examples(manual.map((c) => c.name))} ${manual.length === 1 ? 'uses' : 'use'} manual bids with the same bid on mobile, desktop and tablet.`,
      why: 'Phones and computers usually convert at different rates, so one bid for all of them overpays on one and underbids on the other.',
      start: 'Segment the last 90 days by device, then lower bids where the cost per conversion is higher.',
      startLink: LINKS.bidding,
      fixType: 'bidding',
      items: manual.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'no-device-adjustments',
      category: 'bidding',
      priority: 'medium',
      title: 'Device bid adjustments are in place',
      detail: noDevice.length === 0
        ? `${allOf(search.length, 'main Search campaign')} ${verb(search.length, 'has', 'have')} device bid adjustments.`
        : `${someOf(search.length - noDevice.length, search.length, 'main Search campaign')} ${verbOf(search.length - noDevice.length, search.length, 'has', 'have')} device bid adjustments.`,
    });
  }

  if (noSchedule.length === search.length) {
    out.weak({
      id: 'no-schedule-adjustments',
      category: 'bidding',
      priority: 'low',
      title: 'No time of day bid adjustments on manual campaigns',
      detail: `${examples(manual.map((c) => c.name))} ${manual.length === 1 ? 'bids' : 'bid'} the same at every hour and on every day of the week.`,
      why: 'Most accounts have hours or days that convert much worse, and manual bids keep paying full price for them.',
      start: 'Run a day and hour report for the last 90 days and lower bids in the hours that rarely convert.',
      startLink: LINKS.bidding,
      fixType: 'bidding',
      items: manual.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  }
}

// 11. Shopping feed (audit.py check_feed_health). Only for Shopping and Performance Max.
function ruleShopping(m, out) {
  if (!m.has('products') || !m.has('campaigns')) return;
  if (!m.campaigns.some((c) => c.channel === 'PERFORMANCE_MAX' || c.channel === 'SHOPPING')) return;
  const products = m.products;
  if (!products.length) return;
  const money = m.money;
  const total = products.length;
  const totalSpend = products.reduce((s, p) => s + p.spend, 0);
  const converting = products.filter((p) => p.conversions > 0);

  // 11a. Products over 3 spent with no conversions. Over 30% of product spend and
  // over 15 is high; over 15% and over 8 is medium (audit.py).
  const wasted = products.filter((p) => p.spend > 3 && p.conversions === 0).sort((a, b) => b.spend - a.spend);
  const wastedSpend = wasted.reduce((s, p) => s + p.spend, 0);
  const share = totalSpend > 0 ? wastedSpend / totalSpend : 0;
  if ((share > 0.3 && wastedSpend > 15) || (share > 0.15 && wastedSpend > 8)) {
    out.weak({
      id: 'shopping-wasted-spend',
      category: 'shopping',
      priority: share > 0.3 && wastedSpend > 15 ? 'high' : 'medium',
      title: `${plural(wasted.length, 'product')} spent ${money(wastedSpend)} with no sales`,
      detail: `${pct(share)} of your product spend in the last 30 days brought no conversions. The biggest are ${examples(wasted.map((p) => clean(p.title, 40)), 3, wasted.length)}.`,
      atStake: (() => { const cpa = accountCpa(m); return cpa ? atStake(wasted.filter((p) => p.spend >= cpa).reduce((s, p) => s + p.spend, 0), 'Products past your cost per conversion with no sale', null, true) : null; })(),
      why: 'Money spent on products that never sell is money not spent on the ones that do.',
      start: 'Check price and product page for each, then exclude the ones that still do not sell from your listing groups.',
      startLink: null,
      fixType: 'shopping',
      items: wasted.length,
      itemLabel: 'products',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'shopping-wasted-spend',
      category: 'shopping',
      priority: 'high',
      title: 'Product spend goes on products that sell',
      detail: `${someOf(converting.length, total, 'active product')} recorded conversions, and only ${pct(share)} of product spend went on items with none.`,
    });
  }

  // 11b. Missing product type on products with over 20 impressions: over 25% (audit.py).
  const noType = products.filter((p) => !p.type && p.impressions > 20);
  if (noType.length / total > 0.25) {
    out.weak({
      id: 'shopping-missing-product-type',
      category: 'shopping',
      priority: 'medium',
      title: `${plural(noType.length, 'product')} with no product type`,
      detail: `${pct(noType.length / total)} of your active products have no product type, such as ${examples(noType.map((p) => clean(p.title, 40)))}.`,
      why: 'Without a product type you cannot split products into groups, so you cannot bid more on the categories that sell.',
      start: 'Add a product type to every product in your feed, grouped by category.',
      startLink: null,
      fixType: 'shopping',
      items: noType.length,
      itemLabel: 'products',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'shopping-missing-product-type',
      category: 'shopping',
      priority: 'medium',
      title: 'Products are sorted by type',
      detail: 'Your active products have product types, so they can be grouped and bid on by category.',
    });
  }

  // 11c. Titles under 25 characters: more than 3 and more than 15% (audit.py).
  const short = products.filter((p) => p.title.length < 25 && p.impressions > 20);
  if (short.length > Math.max(3, total * 0.15)) {
    out.weak({
      id: 'shopping-short-titles',
      category: 'shopping',
      priority: 'low',
      title: `${plural(short.length, 'product')} with titles under 25 characters`,
      detail: `Short titles match fewer searches. Examples: ${examples(short.map((p) => p.title))}.`,
      why: 'The title is the main thing Google matches to a search, and a short one leaves out the words people use.',
      start: 'Rewrite titles to 60 to 100 characters with the product type, material, style and brand.',
      startLink: null,
      fixType: 'shopping',
      items: short.length,
      itemLabel: 'products',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'shopping-short-titles',
      category: 'shopping',
      priority: 'low',
      title: 'Product titles are descriptive',
      detail: short.length
        ? `Only ${plural(short.length, 'active product')} ${short.length === 1 ? 'has' : 'have'} a title under 25 characters.`
        : 'None of your active products has a title under 25 characters.',
    });
  }

  // 11d. No custom label 0 on over 50% of products (audit.py).
  const noLabel = products.filter((p) => !p.label && p.impressions > 20);
  if (noLabel.length / total > 0.5) {
    out.weak({
      id: 'shopping-no-custom-labels',
      category: 'shopping',
      priority: 'low',
      title: `${pct(noLabel.length / total)} of products have no custom label`,
      detail: `${someOf(noLabel.length, total, 'active product')} ${verbOf(noLabel.length, total, 'has', 'have')} no custom label 0, so ${noLabel.length === 1 ? 'it is' : 'they are'} all treated the same in bidding.`,
      why: 'Custom labels let you bid harder on best sellers and high-margin lines, and pull back on the rest.',
      start: 'Add a simple label in your feed, such as "hero" for your top sellers and "standard" for the rest.',
      startLink: null,
      fixType: 'shopping',
      items: noLabel.length,
      itemLabel: 'products',
      fromPrice: false,
    });
  } else {
    out.strong({
      id: 'shopping-no-custom-labels',
      category: 'shopping',
      priority: 'low',
      title: 'Products have custom labels',
      detail: 'Most active products carry custom label 0, so you can group them into bidding tiers.',
    });
  }
}

// 12. Campaign settings. Not in audit.py: added for the free check because they
// are simple, common and readable from the same campaign query.
function ruleSettings(m, out) {
  if (!m.has('campaigns')) return;
  const spending = m.campaigns.filter((c) => c.spend > 0);

  // 12a. Location option set to "presence or interest".
  const withGeo = spending.filter((c) => c.geoType);
  const interest = withGeo.filter((c) => c.geoType === 'PRESENCE_OR_INTEREST' || c.geoType === 'SEARCH_INTEREST');
  if (interest.length) {
    out.weak({
      id: 'location-presence',
      category: 'settings',
      priority: 'medium',
      title: `${plural(interest.length, 'campaign')} also ${verb(interest.length, 'reaches', 'reach')} people outside your locations`,
      detail: `${examples(interest.map((c) => c.name))} ${interest.length === 1 ? 'is' : 'are'} set to reach people in, or interested in, your locations, so ${interest.length === 1 ? 'it can' : 'they can'} show to people elsewhere.`,
      why: 'Your ads can show to people who are not in the places you target, such as someone abroad searching about them. If you only sell, deliver or work there, those clicks rarely turn into business.',
      start: 'In each campaign\'s location options, choose "Presence: people in or regularly in your included locations".',
      startLink: LINKS.ads,
      fixType: 'settings',
      items: interest.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (withGeo.length) {
    out.strong({
      id: 'location-presence',
      category: 'settings',
      priority: 'medium',
      title: 'Location targeting reaches people in your area',
      detail: `${allOf(withGeo.length, 'campaign')} that spent ${verb(withGeo.length, 'is', 'are')} set to people in, or regularly in, your locations.`,
    });
  }

  // 12b. Search campaigns that also show on the Display Network.
  const search = spending.filter((c) => c.channel === 'SEARCH');
  const display = search.filter((c) => c.contentNetwork);
  if (display.length) {
    out.weak({
      id: 'search-display-network',
      category: 'settings',
      priority: 'medium',
      title: `${plural(display.length, 'Search campaign')} also showing on the Display Network`,
      detail: `${examples(display.map((c) => c.name))} ${display.length === 1 ? 'has' : 'have'} the Display Network switched on, so the budget also pays for banner ads on other websites.`,
      why: 'Display clicks usually convert far worse than search clicks, and they share the same budget and reports.',
      start: 'Untick the Display Network in each Search campaign\'s settings, and run display as its own campaign if you want it.',
      startLink: LINKS.ads,
      fixType: 'settings',
      items: display.length,
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  } else if (search.length) {
    out.strong({
      id: 'search-display-network',
      category: 'settings',
      priority: 'medium',
      title: 'Search campaigns stay on search',
      detail: `No Search campaign that spent also shows on the Display Network (${search.length} checked).`,
    });
  }
}

// ---------------------------------------------------------------------------
// How the account is built (Lewis, 18 Nov 2026: show the client we read it the right way). Fixed rules on the
// account's own data, never a guess beyond it: the business model from the main conversion goals and Shopping, what it
// sells from its product types (else its Search ad group names), the campaigns grouped by type and role (brand,
// non-brand, competitor, remarketing), and whether the campaign names follow one pattern.
// ---------------------------------------------------------------------------

const CHANNEL_LABEL = {
  SEARCH: 'Search', PERFORMANCE_MAX: 'Performance Max', SHOPPING: 'Shopping', DISPLAY: 'Display',
  VIDEO: 'YouTube', DEMAND_GEN: 'Demand Gen', DISCOVERY: 'Demand Gen', MULTI_CHANNEL: 'App', LOCAL: 'Local',
  SMART: 'Smart', HOTEL: 'Hotel', TRAVEL: 'Travel', LOCAL_SERVICES: 'Local Services',
};
const SALE_CATS = new Set(['PURCHASE', 'STORE_SALE']);
const LEAD_CATS = new Set(['SUBMIT_LEAD_FORM', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD', 'CONVERTED_LEAD', 'CONTACT', 'REQUEST_QUOTE', 'BOOK_APPOINTMENT', 'SIGNUP', 'GET_DIRECTIONS']);
const SEPARATORS = [' | ', '|', ' - ', ' \u2013 ', '-', '_', ':', '/', '>'];
const titleCase = (t) => String(t || '').trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function campaignRole(c, kwTokensByCampaign) {
  const n = spaced(c.name).toLowerCase();
  if (/remarket|rmkt|retarget|\brlsa\b/.test(n)) return 'Remarketing';
  if (/competitor|\bcomp\b|conquest/.test(n)) return 'Competitor';
  if (c.channel !== 'SEARCH') return null;
  if (/\bbrand(ed)?\b/.test(n) && !/non[- ]?brand|generic/.test(n)) return 'Brand';
  const kw = kwTokensByCampaign.get(c.id);
  if (kw && kw.size) {
    const allowed = new Set([...nameTokens(c.name), 'the', 'a', 'an', 'and', 'or']);
    if ([...kw].every((t) => allowed.has(t))) return 'Brand';
  }
  return 'Non-brand';
}

function namingPattern(names) {
  if (names.length < 2) return null;
  let best = null;
  for (const sep of SEPARATORS) {
    const withSep = names.filter((n) => n.includes(sep));
    if (withSep.length / names.length < 0.8) continue;
    const counts = withSep.map((n) => n.split(sep).length);
    const common = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const share = withSep.filter((n) => n.split(sep).length === common).length / names.length;
    if (!best || share > best.share) best = { separator: sep.trim() || sep, parts: common, share };
  }
  return best && best.share >= 0.6 ? { separator: best.separator, parts: best.parts, consistent: best.share >= 0.8 } : { separator: null, parts: 0, consistent: false };
}

// What it sells from Search ad group names, busiest first. Words that qualify many different names (regions, "prices",
// "offers", "men") are dropped, then repeats and default names ("Ad group 1") are left out, so "Windows North",
// "Windows South" and "Implants prices" read as "Windows" and "Implants" (demo accounts, 18 Nov 2026).
function sellsFromGroups(names) {
  const orig = names.map((g) => spaced(g).split(/[\s,&+-]+/).filter(Boolean));
  const words = orig.map((ws) => ws.map((w) => w.toLowerCase()));
  const heads = new Map();
  words.forEach((ws) => ws.forEach((w) => { const others = ws.filter((x) => x !== w).join(' '); if (!heads.has(w)) heads.set(w, new Set()); heads.get(w).add(others); }));
  const modifier = (w) => heads.get(w).size >= 3 && words.filter((ws) => ws[0] === w).length < 2;
  const out = [];
  words.forEach((ws, i) => {
    if (/^ad ?group \d*$/i.test(names[i].trim())) return;
    const kept = orig[i].filter((w, j) => !modifier(ws[j]));
    const label = titleCase(clean((kept.length ? kept : orig[i]).join(' '), 28));
    if (label && !out.some((o) => o.toLowerCase() === label.toLowerCase())) out.push(label);
  });
  return out.slice(0, 4);
}

function accountProfile(m) {
  const live = m.campaigns.filter((c) => c.spend > 0 || c.impressions > 0);
  if (!live.length) return null;
  const total = live.reduce((s, c) => s + c.spend, 0) || 1;

  // Business model: the categories of the main (primary, enabled) conversion goals, plus Shopping or products.
  const primary = m.conversionActions.filter((a) => a.status === 'ENABLED' && a.primary);
  const sales = primary.some((a) => SALE_CATS.has(a.category)) || live.some((c) => c.channel === 'SHOPPING') || m.products.length > 0;
  const leads = primary.some((a) => LEAD_CATS.has(a.category));
  const model = sales && leads ? 'both' : sales ? 'shop' : leads ? 'leads' : 'unknown';
  const tracksValue = live.some((c) => c.convValue > 0);

  // What it sells: product types by spend, else the busiest Search ad group names (not brand ones).
  let sells = [], sellsFrom = null;
  const byType = new Map();
  m.products.forEach((p) => { if (p.type) byType.set(p.type, (byType.get(p.type) || 0) + p.spend + p.impressions / 1e4); });
  if (byType.size) { sells = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => titleCase(clean(t, 28))); sellsFrom = 'product types'; }
  else {
    const byGroup = new Map();
    m.keywords.filter((k) => k.channel === 'SEARCH' && !isBrandName(k.adGroup) && !isBrandName(k.campaign) && !/competitor|\bcomp\b|conquest|remarket|rlsa/i.test(spaced(k.adGroup + ' ' + k.campaign))).forEach((k) => byGroup.set(k.adGroup, (byGroup.get(k.adGroup) || 0) + k.impressions + 1));
    if (byGroup.size) { sells = sellsFromGroups([...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)); sellsFrom = sells.length ? 'ad groups' : null; }
  }

  // Campaigns grouped by type, Search split by role.
  const kwTokensByCampaign = new Map();
  for (const k of m.keywords) {
    if (k.channel !== 'SEARCH') continue;
    const set = kwTokensByCampaign.get(k.campaignId) || new Set();
    for (const t of nameTokens(k.text)) set.add(t);
    kwTokensByCampaign.set(k.campaignId, set);
  }
  const agByCampaign = new Map(); m.adGroups.forEach((g) => agByCampaign.set(g.campaignId, (agByCampaign.get(g.campaignId) || 0) + 1));
  const kwByCampaign = new Map(); m.keywords.forEach((k) => kwByCampaign.set(k.campaignId, (kwByCampaign.get(k.campaignId) || 0) + 1));
  const assetByCampaign = new Map(); m.rows('assetGroups').forEach((r) => { const id = String(r.campaign?.id ?? ''); assetByCampaign.set(id, (assetByCampaign.get(id) || 0) + 1); });
  // One level down for Performance Max (Lewis, 18 Nov 2026): each asset group with its strength and, when the optional
  // read worked, its share of the campaign's spend and its conversions. Biggest first; unknown spend keeps API order.
  const agStats = new Map();
  m.rows('assetGroupStats').forEach((r) => {
    const id = String(r.assetGroup?.id ?? ''); if (!id) return;
    const st = agStats.get(id) || { spend: 0, conversions: 0 };
    st.spend += fromMicros(r.metrics?.costMicros); st.conversions += num(r.metrics?.conversions);
    agStats.set(id, st);
  });
  const STRENGTH = { EXCELLENT: 'Excellent', GOOD: 'Good', AVERAGE: 'Average', POOR: 'Poor', PENDING: 'Pending' };
  const agByCamp = new Map();
  m.rows('assetGroups').forEach((r) => {
    const cid = String(r.campaign?.id ?? ''); const id = String(r.assetGroup?.id ?? '');
    const list = agByCamp.get(cid) || [];
    const st = agStats.get(id);
    list.push({ name: clean(r.assetGroup?.name || 'Unnamed asset group', 40), strength: STRENGTH[r.assetGroup?.adStrength] || null,
      spend: st ? round2(st.spend) : null, conversions: st ? Math.round(st.conversions * 10) / 10 : null });
    agByCamp.set(cid, list);
  });
  const hasAgStats = m.has('assetGroupStats');
  const groups = new Map();
  for (const c of live.sort((a, b) => b.spend - a.spend)) {
    const role = campaignRole(c, kwTokensByCampaign);
    const label = (CHANNEL_LABEL[c.channel] || titleCase(String(c.channel).toLowerCase().replace(/_/g, ' '))) + (role && c.channel === 'SEARCH' ? ` · ${role}` : '');
    const g = groups.get(label) || { label, channel: c.channel, role, spend: 0, conversions: 0, campaigns: [] };
    const inside = c.channel === 'PERFORMANCE_MAX' ? plural(assetByCampaign.get(c.id) || 0, 'asset group')
      : c.channel === 'SEARCH' ? `${plural(agByCampaign.get(c.id) || 0, 'ad group')}, ${plural(kwByCampaign.get(c.id) || 0, 'keyword')}` : null;
    g.spend += c.spend; g.conversions += c.conversions;
    let children = null;
    if (c.channel === 'PERFORMANCE_MAX' && agByCamp.has(c.id)) {
      const kids = agByCamp.get(c.id).slice();
      const campSpend = kids.reduce((x, k) => x + (k.spend || 0), 0);
      if (hasAgStats) kids.sort((a, b) => (b.spend || 0) - (a.spend || 0));
      children = kids.map((k) => ({ ...k, share: hasAgStats && campSpend > 0 ? Math.round(((k.spend || 0) / campSpend) * 1000) / 10 : null }));
    }
    g.campaigns.push({ name: clean(c.name, 48), role: c.channel === 'SEARCH' ? null : role, spend: round2(c.spend), share: Math.round((c.spend / total) * 1000) / 10, conversions: Math.round(c.conversions * 10) / 10, cpa: c.conversions > 0 ? round2(c.spend / c.conversions) : null, inside, children });
    groups.set(label, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, spend: round2(g.spend), share: Math.round((g.spend / total) * 1000) / 10, conversions: Math.round(g.conversions * 10) / 10 }))
    .sort((a, b) => b.spend - a.spend);

  // One sentence: what it is, and where the money goes.
  const who = { shop: 'An online shop', leads: 'A business that wins enquiries', both: 'A business that sells online and takes enquiries', unknown: 'An advertiser' }[model];
  const main = list[0];
  const mainName = main.label.replace(' · ', ' ').replace('Search Non-brand', 'non-brand Search').replace('Search Brand', 'brand Search');
  let summary = `${who}, spending ${Math.round(main.share)}% of its budget on ${mainName}`;
  if (list[1]) summary += list[1].share < 10 ? `, with a small ${list[1].label.replace('Search · Brand', 'brand Search').replace('Search · Non-brand', 'non-brand Search').replace(' · ', ' ')} campaign alongside` : ` and ${Math.round(list[1].share)}% on ${list[1].label.replace('Search · Brand', 'brand Search').replace('Search · Non-brand', 'non-brand Search').replace(' · ', ' ')}`;
  summary += '.';

  return { model, tracksValue, sells, sellsFrom, summary, naming: namingPattern(live.map((c) => c.name)), campaigns: live.length, groups: list };
}

// ---------------------------------------------------------------------------
// 13. Deeper checks (21 Nov 2026, from the Propel Max review "What we should do"). Same fixed-rule approach, same
// Google Ads reads, nothing guessed. Where a check needs a yardstick it uses the visitor's own target when they gave
// one, else the account's own average, and says which.
// ---------------------------------------------------------------------------

const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);
const idOf = (resource) => String(resource || '').split('/').pop();

// What the account is judged on: cost per conversion, or return on ad spend for accounts whose conversions carry
// real sale values. The visitor's target wins; else the account's own 30-day figure.
function yardstick(m) {
  const spend = m.totalSpend;
  const conv = sum(m.campaigns, (c) => c.conversions);
  const value = sum(m.campaigns, (c) => c.convValue);
  const t = m.target;
  const kind = t ? t.type : (value > 0 && value >= spend * 0.5 ? 'roas' : 'cpa');
  if (kind === 'roas') {
    const avg = spend > 0 && value > 0 ? value / spend : null;
    return { kind, value: t ? t.value : avg, average: avg, source: t ? 'target' : 'average' };
  }
  const avg = conv > 0 ? spend / conv : null;
  return { kind, value: t ? t.value : avg, average: avg, source: t ? 'target' : 'average' };
}
const roasText = (r) => `${Math.round(r * 100)}%`;
function yardText(m, y) {
  if (y.kind === 'roas') return `${y.source === 'target' ? 'your target return on ad spend' : 'your average return on ad spend'} of ${roasText(y.value)}`;
  return `${y.source === 'target' ? 'your target cost per conversion' : 'your average cost per conversion'} of ${m.money(y.value)}`;
}
// How a slice (campaign, device, network) does against the yardstick. ratio > 1 is worse; excess is spend past it.
function against(y, s) {
  if (!y.value) return null;
  if (y.kind === 'roas') {
    const roas = s.spend > 0 ? s.value / s.spend : 0;
    return { ratio: roas > 0 ? y.value / roas : Infinity, excess: Math.max(0, s.spend - s.value / y.value), figure: roas };
  }
  const cpa = s.conversions > 0 ? s.spend / s.conversions : Infinity;
  return { ratio: cpa / y.value, excess: Math.max(0, s.spend - s.conversions * y.value), figure: cpa };
}
const figureText = (m, y, f) => (y.kind === 'roas' ? `a return of ${roasText(f)}` : Number.isFinite(f) ? `${m.money(f)} a conversion` : 'no conversions');

// 13a. Double-counted conversions: two primary actions recording the same kind of result, worst when one is the
// Google Ads tag and the other a Google Analytics 4 import of the same event.
const ACTION_SOURCE = (t) => (/^GOOGLE_ANALYTICS_4/.test(t) ? 'ga4' : /^UNIVERSAL_ANALYTICS/.test(t) ? 'ua' : /^WEBPAGE/.test(t) ? 'tag' : /^UPLOAD/.test(t) ? 'import' : /CALL/.test(t) ? 'call' : 'other');
const SOURCE_LABEL = { ga4: 'Google Analytics 4 import', ua: 'Analytics import', tag: 'Google Ads tag', import: 'offline import', call: 'calls', other: 'other source' };
function ruleDoubleCounting(m, out) {
  if (!m.has('conversionActions') || !m.has('conversionStats')) return;
  const live = m.conversionActions.filter((a) => a.status === 'ENABLED' && a.primary && a.allConversions > 0);
  const groups = new Map();
  for (const a of live) {
    const key = a.category === 'PURCHASE' ? 'PURCHASE' : LEAD_CATS.has(a.category) ? a.category : null;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const hits = [];
  for (const [cat, list] of groups) {
    if (list.length < 2) continue;
    const sources = new Set(list.map((a) => ACTION_SOURCE(a.type)));
    const mixed = (sources.has('ga4') || sources.has('ua')) && sources.has('tag');
    // Two lead forms can be two real forms; two purchase actions, or a tag plus an Analytics copy, rarely are.
    if (cat !== 'PURCHASE' && !mixed) continue;
    const counts = list.map((a) => a.allConversions).sort((a, b) => b - a);
    const similar = counts[1] >= counts[0] * 0.5;
    hits.push({ cat, list, mixed, similar });
  }
  const purchases = groups.get('PURCHASE') || [];
  if (!hits.length) {
    if (purchases.length === 1) {
      out.strong({ id: 'double-counting', category: 'tracking', priority: 'high', title: 'Each sale is counted once', detail: `One primary purchase action, "${clean(purchases[0].name)}", records your sales, so none is counted twice.` });
    }
    return;
  }
  const h = hits[0];
  const desc = (a) => `"${clean(a.name)}" (${SOURCE_LABEL[ACTION_SOURCE(a.type)]}, ${Math.round(a.allConversions)} in 30 days)`;
  const kind = h.cat === 'PURCHASE' ? 'sales' : 'leads';
  out.weak({
    id: 'double-counting',
    category: 'tracking',
    priority: h.mixed || h.similar ? 'high' : 'medium',
    title: `${kind === 'sales' ? 'Sales' : 'Leads'} may be counted twice`,
    detail: `${h.list.slice(0, 3).map(desc).join(' and ')} are ${h.list.length === 2 ? 'both' : 'all'} main goals for the same kind of result.${h.similar ? ' Their counts are close, which is what the same result recorded twice looks like.' : ''}${hits.length > 1 ? ` The same applies to ${plural(hits.length - 1, 'other goal type')}.` : ''}`,
    why: 'If both actions count the same sale or enquiry, Google Ads reports too many conversions and each one looks cheaper than it is. Smart Bidding uses the inflated count too, because both are main goals.',
    start: 'Check both actions against your real sales or enquiries. Keep the more reliable one as primary and set the other to secondary.',
    startLink: LINKS.ga4,
    fixType: 'tracking',
    items: sum(hits, (x) => x.list.length - 1),
    itemLabel: 'conversion actions',
    fromPrice: false,
  });
}

// 13b. Negative keywords that block the account's own keywords. Matching follows Google's rules for negatives:
// exact blocks only the same words, phrase blocks the words in that order, broad blocks all the words in any order.
const kwWords = (t) => String(t || '').toLowerCase().replace(/^[+\s]+/, '').replace(/[^\p{L}\p{N}'&]+/gu, ' ').trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^\+/, ''));
function negBlocks(neg, kw) {
  const n = neg.words, k = kw;
  if (!n.length || !k.length) return false;
  if (neg.match === 'EXACT') return n.join(' ') === k.join(' ');
  if (neg.match === 'PHRASE') {
    for (let i = 0; i + n.length <= k.length; i++) if (n.every((w, j) => k[i + j] === w)) return true;
    return false;
  }
  const set = new Set(k);
  return n.every((w) => set.has(w));
}
function ruleNegativeConflicts(m, out) {
  if (!m.has('campaignNegatives') && !m.has('adGroupNegatives') && !m.has('sharedNegatives')) return;
  const neg = (text, match, level) => ({ text: clean(text, 50), words: kwWords(text), match: match || 'BROAD', level });
  const byCampaign = new Map(), byAdGroup = new Map(), byList = new Map();
  const push = (map, key, v) => { if (!map.has(key)) map.set(key, []); map.get(key).push(v); };
  for (const r of m.rows('campaignNegatives')) if (r.campaignCriterion?.keyword?.text) push(byCampaign, String(r.campaign?.id), neg(r.campaignCriterion.keyword.text, r.campaignCriterion.keyword.matchType, 'campaign'));
  for (const r of m.rows('adGroupNegatives')) if (r.adGroupCriterion?.keyword?.text) push(byAdGroup, String(r.adGroup?.id), neg(r.adGroupCriterion.keyword.text, r.adGroupCriterion.keyword.matchType, 'ad group'));
  for (const r of m.rows('sharedNegatives')) if (r.sharedCriterion?.keyword?.text) push(byList, String(r.sharedSet?.id), neg(r.sharedCriterion.keyword.text, r.sharedCriterion.keyword.matchType, 'list'));
  const listsByCampaign = new Map();
  for (const r of m.rows('negativeKeywordLists')) push(listsByCampaign, String(r.campaign?.id), String(r.sharedSet?.id));
  const accountLists = m.rows('accountNegativeLists').map((r) => idOf(r.customerNegativeCriterion?.negativeKeywordList?.sharedSet)).filter(Boolean);
  const blocked = [];
  for (const k of m.keywords) {
    const words = kwWords(k.text);
    const lists = [...(listsByCampaign.get(k.campaignId) || []), ...accountLists];
    const candidates = [
      ...(byCampaign.get(k.campaignId) || []),
      ...(byAdGroup.get(k.agId) || []),
      ...lists.flatMap((id) => (byList.get(id) || []).map((n) => ({ ...n, level: accountLists.includes(id) ? 'account list' : 'list' }))),
    ];
    const hit = candidates.find((n) => negBlocks(n, words));
    if (hit) blocked.push({ k, n: hit });
  }
  const anyNegatives = byCampaign.size + byAdGroup.size + byList.size > 0;
  if (!blocked.length) {
    if (anyNegatives && m.keywords.length) out.strong({ id: 'negatives-block-keywords', category: 'keywords', priority: 'medium', title: 'Your negatives leave your own keywords alone', detail: `None of your negative keywords blocks any of your ${m.keywords.length.toLocaleString('en-GB')} keywords.` });
    return;
  }
  const show = blocked.slice(0, 3).map(({ k, n }) => `"${clean(k.text, 40)}" in "${clean(k.campaign, 40)}" (blocked by "${n.text}", a ${n.match.toLowerCase()} match negative on the ${n.level})`);
  const negs = new Set(blocked.map((b) => `${b.n.level}|${b.n.text}|${b.n.match}`));
  out.weak({
    id: 'negatives-block-keywords',
    category: 'keywords',
    priority: blocked.length >= 5 ? 'high' : 'medium',
    title: `${plural(negs.size, 'negative keyword')} ${verb(negs.size, 'blocks', 'block')} your own keywords`,
    detail: `${plural(blocked.length, 'keyword')} can never show because a negative stops ${verb(blocked.length, 'it', 'them')}: ${show.join('; ')}${blocked.length > 3 ? `; and ${blocked.length - 3} more` : ''}.`,
    why: 'A keyword your own negative blocks can never show an ad, so searches you meant to reach are lost without any warning in the account.',
    start: 'Check where each negative applies and its match type. Narrow or remove it if it blocks searches you want; if the block is intended, pause the keyword.',
    startLink: null,
    fixType: 'negatives',
    items: negs.size,
    itemLabel: 'negative keywords',
    fromPrice: false,
  });
}

// 13c. Budget-limited campaigns that beat the target (or the account's average): the clean growth move. Called from
// ruleCampaigns so the older "held back by budget" finding leaves these out. A campaign counts as held back when it
// spends its whole daily budget, or loses 10% or more of its searches to budget.
function budgetWinners(m) {
  const y = yardstick(m);
  if (!y.value) return { y, list: [] };
  const list = [];
  for (const c of m.campaigns) {
    if (c.conversions < 5 || c.budget <= 0) continue;
    const full = c.budget > 0 && c.spend / 30 >= c.budget * 0.98;
    const lost = c.channel === 'SEARCH' ? c.sisBudgetLost : 0;
    if (!full && lost < 0.1) continue;
    const a = against(y, { spend: c.spend, conversions: c.conversions, value: c.convValue });
    if (!a || a.ratio > 0.9) continue;
    // How far the budget could go: the searches lost to budget, as a share of the ones it already gets, capped at half again.
    const factor = c.channel === 'SEARCH' && c.sis > 0 && lost > 0 ? Math.min(1.5, (c.sis + lost) / c.sis) : 1.2;
    const suggested = Math.ceil(c.budget * factor);
    list.push({ c, a, lost, factor, suggested, more: c.conversions * (factor - 1) });
  }
  list.sort((p, q) => q.more - p.more);
  return { y, list };
}
function reportBudgetWinners(m, out, w) {
  const { y, list } = w;
  if (!list.length) return;
  const line = ({ c, a, lost, suggested }) => `"${clean(c.name, 45)}": ${figureText(m, y, a.figure)}${lost >= 0.1 ? `, ${pct(lost)} of searches lost to budget` : ', spending its full budget'}. Suggested daily budget ${m.money(suggested)} (now ${m.money(c.budget)})`;
  const more = Math.round(sum(list, (x) => x.more));
  const extra = sum(list, (x) => (x.suggested - x.c.budget) * 30.4);
  out.weak({
    id: 'budget-limited-winners',
    category: 'bidding',
    priority: 'medium',
    title: `${plural(list.length, 'campaign')} ${verb(list.length, 'beats', 'beat')} ${y.source === 'target' ? 'your target' : 'your average'} but ${verb(list.length, 'is', 'are')} held back by budget`,
    detail: `${list.slice(0, 3).map(line).join('. ')}.${list.length > 3 ? ` And ${list.length - 3} more.` : ''} Judged against ${yardText(m, y)}. At the recent cost per conversion, about ${m.money(extra)} more a month would mean around ${more || 1} more ${verb(more || 1, 'conversion', 'conversions')}, if the extra searches convert as well.`,
    why: 'These campaigns met the mark over the last 30 days while running out of budget, so they are the first place to test more spend.',
    start: 'Raise the budget in small steps and check the cost per conversion holds once late conversions have come in.',
    startLink: LINKS.bidding,
    fixType: 'bidding',
    items: list.length,
    itemLabel: 'campaigns',
    fromPrice: false,
  });
}

// 13d. Over-pinned responsive search ads: two or more of the three headline positions locked to one headline each, or
// three quarters or more of the headlines pinned.
function ruleOverPinned(m, out) {
  if (!m.has('rsaHeadlines')) return;
  const ads = m.rows('rsaHeadlines').map((r) => {
    const hs = r.adGroupAd?.ad?.responsiveSearchAd?.headlines || [];
    const pins = {};
    for (const h of hs) if (h.pinnedField && /^HEADLINE_\d$/.test(h.pinnedField)) pins[h.pinnedField] = (pins[h.pinnedField] || 0) + 1;
    const pinned = Object.values(pins).reduce((a, b) => a + b, 0);
    const locked = Object.values(pins).filter((n) => n === 1).length;
    return { adGroup: r.adGroup?.name || '', campaign: r.campaign?.name || '', total: hs.length, pinned, locked };
  }).filter((a) => a.total > 0);
  if (!ads.length) return;
  const over = ads.filter((a) => a.locked >= 2 || (a.total >= 3 && a.pinned / a.total >= 0.75));
  if (!over.length) {
    out.strong({ id: 'over-pinned-ads', category: 'ads', priority: 'low', title: 'Your ads leave Google room to test headlines', detail: `None of your ${plural(ads.length, 'responsive search ad')} ${verb(ads.length, 'has', 'have')} its headlines pinned so tightly that only a few combinations can show.` });
    return;
  }
  const e = over[0];
  out.weak({
    id: 'over-pinned-ads',
    category: 'ads',
    priority: over.length / ads.length >= 0.5 ? 'medium' : 'low',
    title: `${plural(over.length, 'ad')} with most headlines pinned`,
    detail: `${someOf(over.length, ads.length, 'responsive search ad')} ${verbOf(over.length, ads.length, 'has', 'have')} headlines pinned so that only a few combinations can show. For example, the ad in "${clean(e.adGroup, 40)}" has ${e.pinned} of its ${e.total} headlines pinned${e.locked >= 2 ? `, with ${e.locked} positions fixed to one headline each` : ''}.`,
    why: 'Pinning limits the headline combinations Google can show and test, and it lowers the ad strength rating.',
    start: 'Keep pins only where wording must appear in a set place, such as a required line, and unpin the rest.',
    startLink: LINKS.ads,
    fixType: 'ad_copy',
    items: over.length,
    itemLabel: 'ads',
    fromPrice: false,
  });
}

// 13e. Landing pages that don't load. The status check itself runs in google-ads-check.js (urls.js) and hands its
// result in as data.urlChecks; the demo accounts carry made-up results.
function ruleBrokenUrls(m, out) {
  const u = m.urlChecks;
  if (!u || !Array.isArray(u.pages) || !u.pages.length) return;
  const broken = u.pages.filter((p) => p.state === 'broken');
  const checked = u.pages.filter((p) => p.state === 'ok' || p.state === 'broken').length;
  if (!broken.length) {
    if (checked) out.strong({ id: 'broken-landing-pages', category: 'ads', priority: 'high', title: 'Your landing pages load', detail: `All ${plural(checked, 'landing page')} checked answered normally${u.skipped ? ` (the ${checked} your ads use most)` : ''}.` });
    return;
  }
  const why = (p) => (p.status === 404 ? 'not found' : p.status === 410 ? 'gone' : p.status >= 500 ? `server error ${p.status}` : 'no answer');
  out.weak({
    id: 'broken-landing-pages',
    category: 'ads',
    priority: 'high',
    title: `${plural(broken.length, 'landing page')} returned an error`,
    detail: `Of the ${plural(u.pages.length, 'page')} your ads link to that were checked, ${broken.length === 1 ? 'one' : broken.length} failed: ${broken.slice(0, 3).map((p) => `${clean(p.url, 70)} (${why(p)}${p.ads > 1 ? `, used by ${p.ads} ads` : ''})`).join('; ')}${broken.length > 3 ? `; and ${broken.length - 3} more` : ''}. Checked on ${m.today || 'the day of the report'}.`,
    why: 'If visitors see the same error, they cannot buy or enquire, and the clicks are still paid for. Google may also disapprove ads that point to a broken page.',
    start: 'Open each address yourself. If it is broken, point the ads at a working page or redirect the old address.',
    startLink: null,
    fixType: 'ad_copy',
    items: broken.length,
    itemLabel: 'pages',
    fromPrice: false,
  });
}

// 13f. Search Partners and devices, 90 days, against the yardstick (the visitor's target, else the 90-day average).
const DEVICE_LABEL = { MOBILE: 'Mobile', DESKTOP: 'Computers', TABLET: 'Tablets', CONNECTED_TV: 'TV screens', OTHER: 'Other devices' };
const NETWORK_LABEL = { SEARCH: 'Google Search', SEARCH_PARTNERS: 'Search Partners', CONTENT: 'Display Network', YOUTUBE_SEARCH: 'YouTube', YOUTUBE_WATCH: 'YouTube', YOUTUBE: 'YouTube', MIXED: 'Performance Max (mixed)', GOOGLE_TV: 'Google TV' };
function segmentTable(m) {
  if (!m.has('segments90')) return null;
  const rows = m.rows('segments90');
  if (!rows.length) return null;
  const add = (map, key, channel, r) => {
    const s = map.get(key) || { key, spend: 0, conversions: 0, value: 0, clicks: 0, impressions: 0 };
    s.spend += fromMicros(r.metrics?.costMicros); s.conversions += num(r.metrics?.conversions); s.value += num(r.metrics?.conversionsValue);
    s.clicks += num(r.metrics?.clicks); s.impressions += num(r.metrics?.impressions);
    map.set(key, s);
  };
  const devices = new Map(), networks = new Map(), searchOnly = new Map();
  for (const r of rows) {
    const ch = r.campaign?.advertisingChannelType;
    add(devices, r.segments?.device || 'OTHER', ch, r);
    add(networks, r.segments?.adNetworkType || 'MIXED', ch, r);
    if (ch === 'SEARCH') add(searchOnly, r.segments?.adNetworkType || 'SEARCH', ch, r);
  }
  const total = { spend: sum([...devices.values()], (s) => s.spend), conversions: sum([...devices.values()], (s) => s.conversions), value: sum([...devices.values()], (s) => s.value) };
  const shape = (s, labels) => ({ label: labels[s.key] || titleCase(String(s.key).toLowerCase().replace(/_/g, ' ')), key: s.key, spend: round2(s.spend), conversions: Math.round(s.conversions * 10) / 10, value: round2(s.value), clicks: s.clicks, share: total.spend ? Math.round((s.spend / total.spend) * 1000) / 10 : 0, cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null, roas: s.spend > 0 && s.value > 0 ? Math.round((s.value / s.spend) * 100) / 100 : null });
  const order = (map, labels) => [...map.values()].filter((s) => s.spend > 0 || s.conversions > 0).sort((a, b) => b.spend - a.spend).map((s) => shape(s, labels));
  return { days: 90, total: { spend: round2(total.spend), conversions: Math.round(total.conversions * 10) / 10, value: round2(total.value) }, devices: order(devices, DEVICE_LABEL), networks: order(networks, NETWORK_LABEL), search: [...searchOnly.values()] };
}
function ruleSegments(m, out, seg) {
  if (!seg || seg.total.conversions < 10) return;
  const y30 = yardstick(m);
  const avg90 = y30.kind === 'roas' ? (seg.total.spend ? seg.total.value / seg.total.spend : null) : seg.total.spend / seg.total.conversions;
  const y = { kind: y30.kind, value: m.target ? m.target.value : avg90, source: m.target ? 'target' : 'average' };
  if (!y.value) return;
  const minSpend = y.kind === 'cpa' ? y.value * 2 : Math.max(50, seg.total.spend * 0.03);
  const weak = (s) => { const a = against(y, s); return a && s.spend >= minSpend && a.ratio >= 1.5 ? a : null; };
  // Spend per campaign name for the rows that match, so the plan can tell where this money overlaps other findings.
  const nameOf = new Map(m.campaigns.map((c) => [String(c.id), c.name]));
  const splitBy = (test) => {
    const by = new Map();
    for (const r of m.rows('segments90')) if (test(r)) { const k = nameOf.get(String(r.campaign?.id)) || String(r.campaign?.id); by.set(k, (by.get(k) || 0) + fromMicros(r.metrics?.costMicros)); }
    return by;
  };

  // Search Partners, Search campaigns only.
  const partners = seg.search.find((s) => s.key === 'SEARCH_PARTNERS');
  const pa = partners && weak(partners);
  if (pa) {
    out.weak({
      id: 'search-partners-below-average',
      category: 'settings',
      priority: pa.excess / 3 >= m.totalSpend * 0.05 ? 'medium' : 'low',
      title: 'Search Partners cost far more per conversion',
      detail: `Over 90 days your Search campaigns spent ${m.money(partners.spend)} on Search Partners sites for ${figureText(m, y, pa.figure)}, against ${yardText(m, y)}.`,
      atStake: atStake(pa.excess / 3, `Search Partners spend past ${y.source === 'target' ? 'your target' : 'your average'}`, splitBy((r) => r.campaign?.advertisingChannelType === 'SEARCH' && r.segments?.adNetworkType === 'SEARCH_PARTNERS')),
      why: 'Search Partners are other sites in Google\'s Search Network that show your Search ads. The spend is easy to miss because it sits inside your Search campaigns.',
      start: 'Segment your Search campaigns by network to see which ones it affects. If the gap holds, untick "Include Google search partners" in those campaigns.',
      startLink: null,
      fixType: 'settings',
      items: Math.max(1, m.campaigns.filter((c) => c.channel === 'SEARCH' && c.spend > 0).length),
      itemLabel: 'campaigns',
      fromPrice: false,
    });
  }

  // Devices, all campaigns.
  const raw = new Map(); for (const r of m.rows('segments90')) {
    const k = r.segments?.device || 'OTHER';
    const s = raw.get(k) || { key: k, spend: 0, conversions: 0, value: 0 };
    s.spend += fromMicros(r.metrics?.costMicros); s.conversions += num(r.metrics?.conversions); s.value += num(r.metrics?.conversionsValue);
    raw.set(k, s);
  }
  const bad = [...raw.values()].filter((s) => s.spend >= seg.total.spend * 0.1).map((s) => ({ s, a: weak(s) })).filter((x) => x.a);
  if (bad.length && bad.length < raw.size) {
    const excess = sum(bad, (x) => x.a.excess);
    const names = bad.map((x) => (DEVICE_LABEL[x.s.key] || x.s.key).toLowerCase());
    out.weak({
      id: 'device-below-average',
      category: 'bidding',
      priority: excess / 3 >= m.totalSpend * 0.05 ? 'medium' : 'low',
      title: `${titleCase(names.join(' and '))} ${verb(bad.length, 'costs', 'cost')} far more per conversion`,
      detail: `Over 90 days: ${bad.map((x) => `${(DEVICE_LABEL[x.s.key] || x.s.key).toLowerCase()} took ${pct(x.s.spend / seg.total.spend)} of spend at ${figureText(m, y, x.a.figure)}`).join('; ')}. Judged against ${yardText(m, y)}.`,
      atStake: atStake(excess / 3, `${titleCase(names.join(' and '))} spend past ${y.source === 'target' ? 'your target' : 'your average'}`, splitBy((r) => bad.some((x) => x.s.key === (r.segments?.device || 'OTHER')))),
      why: 'When one device converts much worse, the cause is often the page, the form or the tracking on that device.',
      start: `Try your own site, form and checkout on ${names.join(' and ')}, and check the conversion tag fires there. On manual bids, a lower bid for ${bad.length === 1 ? 'that device' : 'those devices'} is an option; Smart Bidding already weighs devices itself.`,
      startLink: null,
      fixType: 'bidding',
      items: bad.length,
      itemLabel: 'devices',
      fromPrice: false,
    });
  }
}

// 13g. Brand searches inside Performance Max. The brand is the name the visitor typed, else the words every brand
// Search keyword starts with. Only reported when there is a brand to compare with.
function brandPhrase(m) {
  if (m.brand) return kwWords(m.brand).map(plainWord);
  const kwTokens = new Map();
  for (const k of m.keywords) { if (!kwTokens.has(k.campaignId)) kwTokens.set(k.campaignId, new Set()); nameTokens(k.text).forEach((t) => kwTokens.get(k.campaignId).add(t)); }
  const brandIds = new Set(m.campaigns.filter((c) => campaignRole(c, kwTokens) === 'Brand').map((c) => c.id));
  const lists = m.keywords.filter((k) => brandIds.has(k.campaignId)).map((k) => kwWords(k.text).map(plainWord));
  if (lists.length < 2) return null;
  const prefix = [];
  for (let i = 0; ; i++) {
    const w = lists[0][i];
    if (!w || !lists.every((l) => l[i] === w)) break;
    prefix.push(w);
  }
  const phrase = prefix.length ? prefix : null;
  return phrase && phrase.join(' ').length >= 3 ? phrase : null;
}
function rulePmaxBrand(m, out) {
  if (!m.has('pmaxSearchTerms') || !m.pmaxSearchTerms.length) return;
  const brand = brandPhrase(m);
  if (!brand) return;
  const hit = (t) => { const w = kwWords(t).map(plainWord); for (let i = 0; i + brand.length <= w.length; i++) if (brand.every((b, j) => w[i + j] === b)) return true; return false; };
  const terms = m.pmaxSearchTerms.filter((t) => hit(t.term));
  const spend = sum(terms, (t) => t.cost);
  const all = sum(m.pmaxSearchTerms, (t) => t.cost);
  if (spend < 20) return;
  const kwTokens = new Map();
  for (const k of m.keywords) { if (!kwTokens.has(k.campaignId)) kwTokens.set(k.campaignId, new Set()); nameTokens(k.text).forEach((t) => kwTokens.get(k.campaignId).add(t)); }
  const brandSearch = m.campaigns.find((c) => c.channel === 'SEARCH' && campaignRole(c, kwTokens) === 'Brand' && c.spend > 0);
  const camps = new Set(terms.flatMap((t) => [...t.campaigns]));
  out.weak({
    id: 'pmax-brand-terms',
    category: 'search-terms',
    priority: spend >= all * 0.1 ? 'medium' : 'low',
    title: 'Performance Max is paying for searches for your own name',
    detail: `${m.money(spend)} of Performance Max search spend in the last 30 days (${pct(spend / (all || 1))} of it) went on searches containing "${brand.join(' ')}", such as ${examples(terms.map((t) => t.term), 3, terms.length)}.${brandSearch ? ` You also run a brand campaign, "${clean(brandSearch.name, 40)}".` : ''}`,
    why: 'People searching for your name already know you. Their sales make Performance Max look better at finding new customers than it is.',
    start: 'If you want Performance Max to work on new customers, add your brand as a brand exclusion in its campaign settings, and decide whether its Shopping ads should still show.',
    startLink: null,
    fixType: 'settings',
    items: camps.size || 1,
    itemLabel: 'campaigns',
    fromPrice: false,
  });
}

// 13h. Change history, last 28 days: a short summary for the report, and two findings. Campaigns well off the
// yardstick that nobody changed in 28 days, and an account nobody changed at all.
const CHANGE_LABEL = { CAMPAIGN_BUDGET: 'Budgets', CAMPAIGN: 'Campaign settings', AD_GROUP: 'Ad groups', AD_GROUP_CRITERION: 'Keywords and targeting', CAMPAIGN_CRITERION: 'Campaign targeting', AD_GROUP_AD: 'Ads', AD: 'Ads', AD_GROUP_BID_MODIFIER: 'Bid adjustments', ASSET: 'Assets', CAMPAIGN_ASSET: 'Assets', AD_GROUP_ASSET: 'Assets', CUSTOMER_ASSET: 'Assets', ASSET_SET: 'Assets', ASSET_SET_ASSET: 'Assets', CAMPAIGN_ASSET_SET: 'Assets', ASSET_GROUP: 'Asset groups', ASSET_GROUP_ASSET: 'Asset groups', CAMPAIGN_SHARED_SET: 'Negative lists', SHARED_SET: 'Negative lists', SHARED_CRITERION: 'Negative lists' };
const AUTO_CLIENTS = new Set(['GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION', 'GOOGLE_ADS_AUTOMATED_RULE']);
function changeSummary(m) {
  if (!m.has('changes')) return null;
  const rows = m.rows('changes');
  const byType = new Map(), byCampaign = new Map();
  let last = null, auto = 0;
  for (const r of rows) {
    const e = r.changeEvent || {};
    const label = CHANGE_LABEL[e.changeResourceType] || 'Other';
    byType.set(label, (byType.get(label) || 0) + 1);
    const cid = idOf(e.campaign);
    if (cid) byCampaign.set(cid, (byCampaign.get(cid) || 0) + 1);
    if (AUTO_CLIENTS.has(e.clientType)) auto++;
    const at = String(e.changeDateTime || '').slice(0, 10);
    if (at && (!last || at > last)) last = at;
  }
  return {
    days: 28, total: rows.length, truncated: rows.length >= 1000, last, auto,
    byType: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })),
    campaignsChanged: m.campaigns.filter((c) => c.spend > 0 && byCampaign.has(c.id)).length,
    campaignsSpending: m.campaigns.filter((c) => c.spend > 0).length,
    byCampaign,
  };
}
function ruleChanges(m, out, ch) {
  if (!ch) return;
  if (ch.total === 0 && m.totalSpend >= 300) {
    out.weak({
      id: 'no-recent-changes',
      category: 'structure',
      priority: 'low',
      title: 'No changes to the account in 28 days',
      detail: `The change history shows no changes at all in the last 28 days, while the account spent ${m.money(m.totalSpend)} in the last 30.`,
      why: 'Searches, competitors and costs move every week, so an account nobody looks at slowly drifts from what it was set up to do.',
      start: 'Set aside a short slot each week to read the search terms, add negatives and check spend against results.',
      startLink: null,
      fixType: 'structure',
      items: 1,
      itemLabel: 'accounts',
      fromPrice: false,
    });
  }
  const y = yardstick(m);
  if (!y.value || ch.truncated) return;
  const limit = y.source === 'target' ? 1.3 : 1.5;
  const minSpend = y.kind === 'cpa' ? y.value * 2 : 100;
  const off = m.campaigns
    // On return on ad spend, only campaigns whose conversions carry a value are judged (lead campaigns in a mixed
    // account have none); campaigns with no conversions at all are reported by spend-no-conversions already.
    .filter((c) => c.spend >= minSpend && !(c.conversions === 0 && c.channel !== 'PERFORMANCE_MAX') && (y.kind !== 'roas' || c.convValue > 0))
    .map((c) => ({ c, a: against(y, { spend: c.spend, conversions: c.conversions, value: c.convValue }) }))
    .filter((x) => x.a && x.a.ratio >= limit);
  const still = off.filter((x) => !ch.byCampaign.has(x.c.id));
  const list = y.source === 'target' ? off : still;
  if (!list.length) return;
  const excess = sum(list, (x) => x.a.excess);
  out.weak({
    id: 'off-target-campaigns',
    category: 'structure',
    priority: excess >= m.totalSpend * 0.1 ? 'high' : 'medium',
    title: y.source === 'target'
      ? `${plural(list.length, 'campaign')} missed your target by a wide margin`
      : `${plural(list.length, 'campaign')} well below your average, with no recent changes`,
    detail: `${list.slice(0, 3).map((x) => `"${clean(x.c.name, 45)}" at ${figureText(m, y, x.a.figure)}${ch.byCampaign.has(x.c.id) ? '' : ', no changes in 28 days'}`).join('; ')}${list.length > 3 ? `; and ${list.length - 3} more` : ''}. Judged against ${yardText(m, y)} over the last 30 days.${y.source === 'target' && still.length ? ` ${still.length === list.length ? (list.length === 1 ? 'It has' : 'None of them has') : `${still.length} of them ${verb(still.length, 'has', 'have')}`} had no changes in 28 days.` : ''}`,
    atStake: atStake(excess, `Spend past ${y.source === 'target' ? 'your target' : 'your average'} in these campaigns`, Object.fromEntries(list.map((x) => [x.c.name, x.a.excess]))),
    why: 'These campaigns cost far more per result than the account can afford, and the money at stake is what the same results would have cost at that level.',
    start: 'For each one, check conversion volume and tracking first, then search terms, bids and the landing page. If nothing explains the gap, move budget to the campaigns that meet it.',
    startLink: LINKS.bidding,
    fixType: 'bidding',
    items: list.length,
    itemLabel: 'campaigns',
    fromPrice: false,
  });
}

// 13i. Customer Match lists with almost no matched members: the uploads have stopped or never matched. (The API has
// no "last uploaded" date, so this reads the matched size and, where set, how long members stay on the list.)
function ruleCustomerMatch(m, out) {
  if (!m.has('customerMatch')) return;
  const lists = m.rows('customerMatch').map((r) => r.userList || {}).filter((l) => l.membershipStatus !== 'CLOSED');
  if (!lists.length) return;
  const size = (l) => Math.max(num(l.sizeForSearch), num(l.sizeForDisplay));
  const small = lists.filter((l) => size(l) < 100);
  if (!small.length) {
    out.strong({ id: 'customer-match-empty', category: 'settings', priority: 'low', title: 'Your Customer Match lists have members', detail: `${allOf(lists.length, 'Customer Match list')} ${verb(lists.length, 'has', 'have')} 100 or more matched members.` });
    return;
  }
  const life = small.map((l) => num(l.membershipLifeSpan)).filter((d) => d > 0 && d < 10000);
  out.weak({
    id: 'customer-match-empty',
    category: 'settings',
    priority: 'low',
    title: `${plural(small.length, 'Customer Match list')} with few matched members`,
    detail: `${examples(small.map((l) => l.name || 'Unnamed list'))} ${verb(small.length, 'has', 'have')} fewer than 100 matched members.${life.length ? ` Members drop off after ${Math.min(...life)} days unless the list is uploaded again.` : ''}`,
    why: 'A list this small may be too small to use for ads. Low numbers come from poor matching, members expiring, or uploads that stopped.',
    start: 'Check the list in Audience manager. If you still use it, refresh it with customer data you have permission to share, or remove it.',
    startLink: null,
    fixType: 'settings',
    items: small.length,
    itemLabel: 'lists',
    fromPrice: false,
  });
}

// ---------------------------------------------------------------------------
// The longer view: 13 months by month, and the funnel for the last 30 days against the 60 before.
// ---------------------------------------------------------------------------

function rates(s) {
  return {
    ...s,
    spend: round2(s.spend), value: round2(s.value), conversions: Math.round(s.conversions * 10) / 10,
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    cpc: s.clicks > 0 ? s.spend / s.clicks : null,
    cvr: s.clicks > 0 ? s.conversions / s.clicks : null,
    cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
    roas: s.spend > 0 && s.value > 0 ? Math.round((s.value / s.spend) * 100) / 100 : null,
    aov: s.conversions > 0 && s.value > 0 ? round2(s.value / s.conversions) : null,
  };
}
const blank = () => ({ impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0, days: 0 });
const addRow = (s, r) => { s.impressions += num(r.metrics?.impressions); s.clicks += num(r.metrics?.clicks); s.spend += fromMicros(r.metrics?.costMicros); s.conversions += num(r.metrics?.conversions); s.value += num(r.metrics?.conversionsValue); };

function trendTable(m) {
  const today = m.today;
  let months = null;
  if (m.has('monthly13') && m.rows('monthly13').length) {
    const by = new Map();
    for (const r of m.rows('monthly13')) {
      const k = String(r.segments?.month || '').slice(0, 7);
      if (!k) continue;
      if (!by.has(k)) by.set(k, blank());
      addRow(by.get(k), r);
    }
    const thisMonth = today ? today.slice(0, 7) : null;
    months = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, s]) => {
      const r = rates(s);
      return { month, spend: r.spend, conversions: r.conversions, value: r.value, cpa: r.cpa, roas: r.roas, partial: month === thisMonth };
    });
  }
  let funnel = null;
  if (m.has('daily90') && m.rows('daily90').length && today) {
    const cut = new Date(new Date(today + 'T12:00:00Z').getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const recent = blank(), prior = blank();
    const seen = { recent: new Set(), prior: new Set() };
    for (const r of m.rows('daily90')) {
      const d = String(r.segments?.date || '');
      if (!d) continue;
      const k = d >= cut ? 'recent' : 'prior';
      addRow(k === 'recent' ? recent : prior, r);
      seen[k].add(d);
    }
    recent.days = seen.recent.size; prior.days = seen.prior.size;
    const R = rates(recent), P = rates(prior);
    funnel = { recent: R, prior: P, lever: lever(m, R, P) };
  }
  if (!months && !funnel) return null;
  return { months, funnel, kind: yardstick(m).kind };
}

// Which part of the funnel moved the cost per conversion (or the return) most: cost per click, conversion rate or,
// for sales, the value per sale. Each is a factor of the result, so the change splits cleanly on a log scale.
function lever(m, R, P) {
  if (!(R.conversions >= 10 && P.conversions >= 10 && R.cpc && P.cpc && R.cvr && P.cvr)) return { key: null, text: 'Too few conversions in one of the two periods to say which part of the funnel moved.' };
  const y = yardstick(m);
  const parts = [
    { key: 'cpc', name: 'cost per click', d: -Math.log(R.cpc / P.cpc), from: m.money(P.cpc), to: m.money(R.cpc) },
    { key: 'cvr', name: 'conversion rate', d: Math.log(R.cvr / P.cvr), from: `${(P.cvr * 100).toFixed(1)}%`, to: `${(R.cvr * 100).toFixed(1)}%` },
  ];
  if (y.kind === 'roas' && R.aov && P.aov) parts.push({ key: 'aov', name: 'value per sale', d: Math.log(R.aov / P.aov), from: m.money(P.aov), to: m.money(R.aov) });
  // Each d is how much better that part made the result, on a log scale; together they are the whole change.
  const total = sum(parts, (p) => p.d);
  const top = parts.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  const what = y.kind === 'roas' ? 'return on ad spend' : 'cost per conversion';
  const change = y.kind === 'roas' ? Math.exp(total) - 1 : Math.exp(-total) - 1;
  if (Math.abs(change) < 0.05) return { key: null, text: `Your ${what} has held steady against the 60 days before (within 5%).` };
  return {
    key: top.key,
    better: total > 0,
    text: `Your ${what} ${change > 0 ? 'rose' : 'fell'} ${pct(Math.abs(change))} against the 60 days before. Most of that came from ${top.name}, which went from ${top.from} to ${top.to}.`,
  };
}

// ---------------------------------------------------------------------------
// The written headline and the ranked action list (rules write them, no AI).
// ---------------------------------------------------------------------------

// Impact from the money at stake against the monthly spend, never below what the finding's priority says.
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };
export function actionPlan(weaknesses, quote, spend30) {
  const lines = new Map(((quote && quote.lines) || []).map((l) => [l.id, l]));
  const plan = weaknesses.map((w, i) => {
    const amount = w.atStake ? w.atStake.amount : 0;
    const share = spend30 > 0 ? amount / spend30 : 0;
    const byMoney = share >= 0.1 ? 'high' : share >= 0.03 ? 'medium' : 'low';
    const impact = IMPACT_RANK[byMoney] < IMPACT_RANK[w.priority] ? byMoney : w.priority;
    const l = lines.get(w.id);
    const hours = l ? Math.round(l.hours * 100) / 100 : null;
    const effort = hours == null ? null : hours <= 1 ? 'quick' : hours <= 4 ? 'medium' : 'larger';
    return { id: w.id, title: w.title, impact, atStake: amount || null, hours, effort, i };
  });
  const E = { quick: 0, medium: 1, larger: 2 };
  plan.sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || (b.atStake || 0) - (a.atStake || 0) || (E[a.effort] ?? 1) - (E[b.effort] ?? 1) || a.i - b.i);
  // Findings can cover the same spend (a campaign off target and the mobile clicks inside it). Going down the list,
  // each campaign keeps the largest sum counted for it so far, and a later item only adds what goes past that: in one
  // campaign the bigger estimate is taken to include the smaller. So the figures can be read one after another
  // without counting the same money twice. A finding with no campaign split is shown in full.
  const counted = new Map();
  return plan.map(({ i, ...p }, n) => {
    const by = weaknesses[i].atStake && weaknesses[i].atStake.byCampaign;
    if (p.atStake && weaknesses[i].atStake.mayOverlap && counted.size) p.mayOverlap = true;
    if (p.atStake && by) {
      let fresh = 0;
      for (const [k, v] of Object.entries(by)) { const had = counted.get(k) || 0; if (v > had) { fresh += v - had; counted.set(k, v); } }
      if (fresh < p.atStake - 0.5) {
        p.gross = p.atStake;
        p.atStake = fresh >= 1 ? Math.round(fresh * 100) / 100 : null;
        p.overlap = true;
      }
    }
    return { rank: n + 1, ...p };
  });
}

function headline(m, facts, weaknesses, trend) {
  const s = [];
  const y = yardstick(m);
  if (facts.spend30 > 0) {
    if (y.kind === 'roas' && facts.conversionValue30 > 0) {
      const r = facts.conversionValue30 / facts.spend30;
      s.push(`In the last 30 days you spent ${m.money(facts.spend30)} and Google Ads recorded ${m.money(facts.conversionValue30)} in conversion value, a return on ad spend of ${roasText(r)}${m.target ? `, ${r >= m.target.value ? 'at or above' : 'below'} your ${roasText(m.target.value)} target` : ''}.`);
    } else if (facts.conversions30 > 0) {
      s.push(`In the last 30 days you spent ${m.money(facts.spend30)} and Google Ads recorded ${facts.conversions30.toLocaleString('en-GB')} ${facts.conversions30 === 1 ? 'conversion' : 'conversions'}, ${m.money(facts.costPerConversion30)} each${m.target && m.target.type === 'cpa' ? `, ${facts.costPerConversion30 <= m.target.value ? 'within' : 'above'} your ${m.money(m.target.value)} target` : ''}.`);
    } else {
      s.push(`In the last 30 days you spent ${m.money(facts.spend30)} and Google Ads recorded no conversions.`);
    }
  }
  if (trend && trend.funnel && trend.funnel.lever && trend.funnel.lever.key) s.push(trend.funnel.lever.text);
  // The single biggest sum, not a total: findings can overlap (a campaign and its products), so adding them up would
  // count the same spend twice.
  const money = weaknesses.filter((w) => w.atStake && w.atStake.amount > 0).sort((a, b) => b.atStake.amount - a.atStake.amount);
  if (money.length) s.push(`The most money at stake is in "${money[0].title}": an estimated ${m.money(money[0].atStake.amount)} over the next 30 days if nothing changes (${money[0].atStake.basis.replace(/^(Spend|Searches|Campaigns|Products)\b/, (w) => w.toLowerCase())}).`);
  const first = actionPlan(weaknesses, null, facts.spend30)[0];
  if (first && first.id !== money[0]?.id) s.push(`I'd start with "${first.title}".`);
  else if (first) s.push("That's where I'd start.");
  else if (facts.spend30 > 0) s.push('I found nothing to fix in the checks I could run.');
  return s;
}

// ---------------------------------------------------------------------------
// Facts for the report header and the estimates
// ---------------------------------------------------------------------------

function buildFacts(m) {
  const spend = m.totalSpend;
  const conversions = m.campaigns.reduce((s, c) => s + c.conversions, 0);
  const convValue = m.campaigns.reduce((s, c) => s + c.convValue, 0);
  const impressions = m.campaigns.reduce((s, c) => s + c.impressions, 0);
  const scored = m.keywords.filter((k) => k.qs !== null);
  const qsImps = scored.reduce((s, k) => s + k.impressions, 0);
  const avgQs = scored.length
    ? Math.round((qsImps > 0
      ? scored.reduce((s, k) => s + k.qs * k.impressions, 0) / qsImps
      : scored.reduce((s, k) => s + k.qs, 0) / scored.length) * 10) / 10
    : null;
  const search = m.campaigns.filter((c) => c.channel === 'SEARCH' && c.impressions > 0 && c.sis > 0);
  const sImps = search.reduce((s, c) => s + c.impressions, 0);
  const searchOnly = m.campaigns.filter((c) => c.channel === 'SEARCH');
  const soImps = searchOnly.reduce((s, c) => s + c.impressions, 0);
  const soClicks = searchOnly.reduce((s, c) => s + c.clicks, 0);
  const enabledActions = m.conversionActions.filter((a) => a.status === 'ENABLED');

  return {
    currency: m.currency,
    campaigns: m.campaigns.length,
    activeCampaigns: m.campaigns.filter((c) => c.impressions > 0).length,
    channels: [...new Set(m.campaigns.map((c) => c.channel))].sort(),
    adGroups: m.adGroups.length,
    keywords: m.keywords.length,
    ads: m.ads.length,
    responsiveSearchAds: m.ads.filter((a) => a.type.includes('RESPONSIVE_SEARCH')).length,
    assetGroups: m.rows('assetGroups').length,
    searchTerms: m.searchTerms.length,
    products: m.products.length,
    conversionActions: enabledActions.length,
    primaryConversionActions: enabledActions.filter((a) => a.primary).length,
    spend30: round2(spend),
    clicks30: m.totalClicks,
    impressions30: impressions,
    conversions30: Math.round(conversions * 10) / 10,
    conversionValue30: round2(convValue),
    costPerConversion30: conversions > 0 ? round2(spend / conversions) : null,
    searchCtr: soImps > 0 ? Math.round((soClicks / soImps) * 1000) / 10 : null,
    searchImpressionShare: sImps > 0
      ? Math.round((search.reduce((s, c) => s + c.sis * c.impressions, 0) / sImps) * 1000) / 10
      : null,
    avgQualityScore: avgQs,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const FIX_TYPES = new Set(['settings', 'negatives', 'ad_copy', 'tracking', 'structure', 'bidding', 'shopping', 'keywords']);

export function runRules(data = {}, ctx = {}) {
  const m = buildModel(data || {}, ctx);
  const strengths = [];
  const weaknesses = [];
  const out = {
    weak(f) {
      if (!FIX_TYPES.has(f.fixType)) throw new Error(`Unknown fixType on ${f.id}`);
      const items = Math.max(1, Math.round(Number(f.items) || 0));
      weaknesses.push({ ...f, items, fromPrice: f.fromPrice === true, startLink: f.startLink ?? null });
    },
    strong(f) {
      strengths.push({
        id: f.id, category: f.category, priority: f.priority,
        title: f.title, detail: f.detail, why: f.why ?? null,
        start: f.start ?? null, startLink: f.startLink ?? null,
      });
    },
  };

  ruleConversions(m, out);
  ruleDoubleCounting(m, out);
  ruleCampaigns(m, out);
  ruleSettings(m, out);
  ruleKeywords(m, out);
  ruleSearchTerms(m, out);
  ruleAutomation(m, out);
  ruleAds(m, out);
  ruleAdGroups(m, out);
  ruleLandingPages(m, out);
  ruleAudiences(m, out);
  ruleBidAdjustments(m, out);
  ruleShopping(m, out);
  ruleNegativeConflicts(m, out);
  ruleOverPinned(m, out);
  ruleBrokenUrls(m, out);
  const segments = segmentTable(m);
  ruleSegments(m, out, segments);
  rulePmaxBrand(m, out);
  const changes = changeSummary(m);
  ruleChanges(m, out, changes);
  ruleCustomerMatch(m, out);

  // Stable sort: high, medium, low, keeping rule order within each.
  weaknesses.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const facts = buildFacts(m);
  const trend = trendTable(m);
  const y = yardstick(m);
  return {
    strengths, weaknesses, facts, profile: accountProfile(m), ngrams: ngramTable(m), dayHour: dayHourTable(data && data.dayHour), workload: workload(m),
    trend, segments: segments ? { days: segments.days, total: segments.total, devices: segments.devices, networks: segments.networks } : null,
    changes: changes ? (({ byCampaign, ...c }) => c)(changes) : null,
    urls: m.urlChecks ? { checked: m.urlChecks.pages.length, total: m.urlChecks.total, broken: m.urlChecks.pages.filter((p) => p.state === 'broken').length, notChecked: m.urlChecks.pages.filter((p) => p.state === 'blocked' || p.state === 'timeout').length } : null,
    target: m.target, yardstick: y.value ? { kind: y.kind, value: round2(y.value), source: y.source } : null,
    headline: headline(m, facts, weaknesses, trend),
  };
}
