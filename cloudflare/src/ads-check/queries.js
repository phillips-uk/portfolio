// GAQL queries for the free Google Ads check.
//
// Written for the Google Ads REST API, v24 (the caller sets the version):
//   POST https://googleads.googleapis.com/v24/customers/{id}/googleAds:searchStream
// Every field and enum value below was checked against the v24 client library
// types. Two fields the old Python audit used do not exist and were replaced:
//   campaign.learning_stage_info  -> campaign.bidding_strategy_system_status
//   customer_asset.asset_type     -> customer_asset.field_type
//
// Performance data covers the last 30 days, as the old audit did. Since 21 Nov 2026 a few reads look further back:
// 90 days for the network and device split and the funnel, 13 months for the monthly trend, 28 days of change
// history. Those carry date placeholders ({TODAY}, {YESTERDAY}, {D28}, {D90}, {M13}) that queriesFor() fills in.
// Settings and structure queries have no date range, so they list everything
// that is switched on today, whether or not it spent.

const q = (s) => s.replace(/\s+/g, ' ').trim();

export const QUERIES = {
  // Account currency and the enhanced conversions for leads flag.
  // (enhanced_conversions_for_leads_enabled exists in v24 but is gone by v26,
  // which uses conversion_tracking_setting.enablement_setting instead.)
  customer: q(`
    SELECT customer.id, customer.currency_code,
           customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
           customer.conversion_tracking_setting.accepted_customer_data_terms
    FROM customer
  `),

  // Every conversion action that has not been removed.
  conversionActions: q(`
    SELECT conversion_action.resource_name, conversion_action.id,
           conversion_action.name, conversion_action.status,
           conversion_action.type, conversion_action.category,
           conversion_action.primary_for_goal,
           conversion_action.include_in_conversions_metric,
           conversion_action.attribution_model_settings.attribution_model
    FROM conversion_action
    WHERE conversion_action.status != 'REMOVED'
  `),

  // Conversions recorded per conversion action in the last 30 days.
  // Rows are per campaign; the rules add them up per action.
  conversionStats: q(`
    SELECT campaign.id, segments.conversion_action,
           metrics.all_conversions, metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
  `),

  // Enabled campaigns with settings, budget and 30-day performance.
  campaigns: q(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
           campaign.advertising_channel_type,
           campaign.bidding_strategy_type, campaign.bidding_strategy,
           campaign.bidding_strategy_system_status,
           campaign.maximize_conversions.target_cpa_micros,
           campaign.network_settings.target_search_network,
           campaign.network_settings.target_content_network,
           campaign.geo_target_type_setting.positive_geo_target_type,
           campaign.campaign_budget,
           campaign_budget.amount_micros, campaign_budget.explicitly_shared,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value,
           metrics.search_impression_share,
           metrics.search_budget_lost_impression_share,
           metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `),

  // Every enabled keyword, with its Quality Score. No date range, so keywords
  // that had no traffic are included (needed for empty and oversized ad groups).
  keywords: q(`
    SELECT ad_group_criterion.criterion_id,
           ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type,
           ad_group_criterion.quality_info.quality_score,
           ad_group.id, ad_group.name,
           campaign.id, campaign.name,
           campaign.advertising_channel_type, campaign.bidding_strategy_type
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),

  // 30-day keyword performance, joined to `keywords` on ad group id + criterion id.
  keywordStats: q(`
    SELECT ad_group.id, ad_group_criterion.criterion_id,
           metrics.impressions, metrics.clicks,
           metrics.cost_micros, metrics.conversions
    FROM keyword_view
    WHERE segments.date DURING LAST_30_DAYS
      AND ad_group_criterion.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),

  // Campaign-level negative keywords (one row per negative).
  negativeKeywords: q(`
    SELECT campaign.id
    FROM campaign_criterion
    WHERE campaign_criterion.negative = TRUE
      AND campaign_criterion.type = 'KEYWORD'
      AND campaign.status = 'ENABLED'
  `),

  // Shared negative keyword lists attached to campaigns.
  negativeKeywordLists: q(`
    SELECT campaign.id, shared_set.id, shared_set.type, shared_set.member_count
    FROM campaign_shared_set
    WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
      AND campaign_shared_set.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),

  // Account-level negative keyword list (applies to every campaign).
  accountNegativeLists: q(`
    SELECT customer_negative_criterion.id,
           customer_negative_criterion.type,
           customer_negative_criterion.negative_keyword_list.shared_set
    FROM customer_negative_criterion
    WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'
  `),

  // Search terms that cost more than 0.50 in the last 30 days, top 300 by cost.
  // Used for the wasted search terms rule (cost over 3, no conversions) and
  // the repeated word patterns rule, as in the old audit.
  searchTerms: q(`
    SELECT search_term_view.search_term,
           campaign.id, campaign.name, ad_group.name,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM search_term_view
    WHERE segments.date DURING LAST_30_DAYS
      AND metrics.cost_micros > 500000
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 300
  `),

  // When conversions come in: day of week by hour of day (the account's time zone), last 30 days, for the report's
  // heatmap. One row per campaign, day and hour; the rules add them up.
  dayHour: q(`
    SELECT segments.day_of_week, segments.hour,
           metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status = 'ENABLED'
      AND metrics.impressions > 0
  `),

  // Performance Max search terms with cost (campaign_search_term_view, v24): search_term_view leaves Performance Max
  // out. Used only for the words-and-phrases (n-gram) finding and table; the keyword-based search term checks stay on
  // Search campaigns, since Performance Max has no keywords to compare with.
  pmaxSearchTerms: q(`
    SELECT campaign_search_term_view.search_term,
           campaign.id, campaign.name,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign_search_term_view
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status = 'ENABLED'
      AND metrics.cost_micros > 500000
    ORDER BY metrics.cost_micros DESC
    LIMIT 300
  `),

  // Spend and conversions per Performance Max asset group, last 30 days, for the structure diagram (optional).
  assetGroupStats: q(`
    SELECT asset_group.id, campaign.id,
           metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM asset_group
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status = 'ENABLED'
      AND asset_group.status = 'ENABLED'
  `),

  // Performance Max asset groups and their ad strength.
  assetGroups: q(`
    SELECT asset_group.id, asset_group.name, asset_group.ad_strength,
           asset_group.final_urls,
           campaign.id, campaign.name
    FROM asset_group
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status = 'ENABLED'
      AND asset_group.status = 'ENABLED'
  `),

  // Every enabled ad in an enabled ad group: type, strength, final URLs, paths.
  ads: q(`
    SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad_strength,
           ad_group_ad.ad.final_urls,
           ad_group_ad.ad.responsive_search_ad.path1,
           ad_group_ad.ad.responsive_search_ad.path2,
           ad_group.id, ad_group.name,
           campaign.id, campaign.name, campaign.advertising_channel_type
    FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),

  // Sitelinks and callouts at account level.
  customerAssets: q(`
    SELECT customer_asset.field_type, customer_asset.status
    FROM customer_asset
    WHERE customer_asset.status = 'ENABLED'
      AND customer_asset.field_type IN ('SITELINK', 'CALLOUT')
  `),

  // Sitelinks and callouts at campaign level.
  campaignAssets: q(`
    SELECT campaign.id, campaign.status, campaign_asset.status, campaign_asset.field_type
    FROM campaign_asset
    WHERE campaign_asset.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND campaign_asset.field_type IN ('SITELINK', 'CALLOUT')
  `),

  // Enabled ad groups in Search campaigns.
  adGroups: q(`
    SELECT ad_group.id, ad_group.name, campaign.id, campaign.name
    FROM ad_group
    WHERE ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND campaign.advertising_channel_type = 'SEARCH'
  `),

  // Audiences added to Search ad groups (observation or targeting).
  audienceCriteria: q(`
    SELECT campaign.id, ad_group.id, ad_group_criterion.type
    FROM ad_group_criterion
    WHERE ad_group_criterion.type IN ('USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AUDIENCE')
      AND ad_group_criterion.status != 'REMOVED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND campaign.advertising_channel_type = 'SEARCH'
  `),

  // Campaign-level device and ad schedule bid adjustments, and audiences.
  campaignCriteria: q(`
    SELECT campaign.id, campaign_criterion.type,
           campaign_criterion.bid_modifier, campaign_criterion.device.type,
           campaign_criterion.status
    FROM campaign_criterion
    WHERE campaign_criterion.type IN ('DEVICE', 'AD_SCHEDULE', 'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AUDIENCE')
      AND campaign_criterion.status != 'REMOVED'
      AND campaign.status = 'ENABLED'
      AND campaign.advertising_channel_type = 'SEARCH'
  `),

  // Products with impressions in Shopping and Performance Max, last 30 days.
  products: q(`
    SELECT campaign.status, segments.product_item_id, segments.product_title,
           segments.product_type_l1, segments.product_brand,
           segments.product_custom_attribute0,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM shopping_performance_view
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status = 'ENABLED'
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `),
  // ---- Added 21 Nov 2026 (Propel Max review, "What we should do"). All read only, all optional. ----

  // Negative keywords with their text, at campaign, ad group and shared-list level: do any block the account's own
  // keywords? (The older negativeKeywords read only counts them per campaign.)
  campaignNegatives: q(`
    SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign_criterion.negative = TRUE
      AND campaign_criterion.type = 'KEYWORD'
      AND campaign.status = 'ENABLED'
  `),
  adGroupNegatives: q(`
    SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.negative = TRUE
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),
  sharedNegatives: q(`
    SELECT shared_set.id, shared_criterion.keyword.text, shared_criterion.keyword.match_type
    FROM shared_criterion
    WHERE shared_criterion.type = 'KEYWORD'
      AND shared_set.type = 'NEGATIVE_KEYWORDS'
      AND shared_set.status = 'ENABLED'
    LIMIT 10000
  `),

  // Responsive search ad headlines with their pins, for the over-pinned check.
  rsaHeadlines: q(`
    SELECT ad_group_ad.ad.id, ad_group.id, ad_group.name, campaign.id, campaign.name,
           ad_group_ad.ad.responsive_search_ad.headlines
    FROM ad_group_ad
    WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
      AND ad_group_ad.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
  `),

  // 90 days by network (Google Search or Search Partners) and device, per campaign.
  segments90: q(`
    SELECT campaign.id, campaign.advertising_channel_type,
           segments.ad_network_type, segments.device,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '{D90}' AND '{YESTERDAY}'
      AND campaign.status = 'ENABLED'
      AND metrics.impressions > 0
  `),

  // The whole account by day for 90 days: the funnel (CTR, CPC, conversion rate), last 30 days against the 60 before.
  daily90: q(`
    SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '{D90}' AND '{YESTERDAY}'
  `),

  // The whole account by month for 13 months (this month so far included), for the trend.
  monthly13: q(`
    SELECT segments.month, metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '{M13}' AND '{YESTERDAY}'
  `),

  // Change history, last 28 days (the API allows up to 30). The user's email is deliberately not read.
  changes: q(`
    SELECT change_event.change_date_time, change_event.change_resource_type,
           change_event.resource_change_operation, change_event.client_type,
           change_event.campaign
    FROM change_event
    WHERE change_event.change_date_time >= '{D28} 00:00:00'
      AND change_event.change_date_time <= '{TODAY} 23:59:59'
    ORDER BY change_event.change_date_time DESC
    LIMIT 1000
  `),

  // Customer Match lists and how many matched members they have.
  customerMatch: q(`
    SELECT user_list.id, user_list.name, user_list.membership_status,
           user_list.size_for_search, user_list.size_for_display,
           user_list.membership_life_span
    FROM user_list
    WHERE user_list.type = 'CRM_BASED'
  `),
};

// Queries that can fail on some accounts (no Shopping, no Performance Max,
// no shared lists, access limits). The caller should pass `undefined` for a
// failed optional query; the rules then skip whatever depends on it.
export const OPTIONAL = new Set([
  'assetGroupStats',
  'dayHour',
  'pmaxSearchTerms',
  'negativeKeywordLists',
  'accountNegativeLists',
  'assetGroups',
  'customerAssets',
  'campaignAssets',
  'audienceCriteria',
  'campaignCriteria',
  'products',
  'campaignNegatives',
  'adGroupNegatives',
  'sharedNegatives',
  'rsaHeadlines',
  'segments90',
  'daily90',
  'monthly13',
  'changes',
  'customerMatch',
]);

// The dates the dated queries need, from today's date in London ('YYYY-MM-DD').
export function datesFor(today) {
  const d = new Date(today + 'T12:00:00Z');
  const day = (n) => new Date(d.getTime() - n * 86400000).toISOString().slice(0, 10);
  const m13 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
  return { TODAY: today, YESTERDAY: day(1), D28: day(28), D90: day(90), M13: m13 };
}

// Every query with its dates filled in.
export function queriesFor(today) {
  const dates = datesFor(today);
  const out = {};
  for (const [name, gaql] of Object.entries(QUERIES)) out[name] = gaql.replace(/\{([A-Z0-9]+)\}/g, (all, k) => dates[k] ?? all);
  return out;
}
