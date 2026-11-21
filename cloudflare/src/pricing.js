// The pricing calculator behind the free tools' reports (plan: vault 01_Phillips/04_Products/Free Tools Relaunch Plan.md,
// sections 3a, 3b and 5). Every rate, rounding rule and free-use limit lives here as data in R2, never in a report or
// a page, so Lewis can change them in /admin#pricing as he learns.
//
// Storage (R2 BLOBS):
//   admin/pricing/current.json          the live settings, with their version number
//   admin/pricing/versions/<n>.json     every saved version, kept for good (a report records the version it used)
// A version is never edited after it is saved: a change is a new version, logged with who and when.
//
// Monthly management (Lewis, 21 Nov 2026): the fee is the account's estimated hours a month at the hourly rate, with a
// £500 minimum. Hours come from the account itself (a base, time per campaign by type, and time for spend), so the fee
// scales at the normal rate once the work is worth more than the minimum. An empty minimum hides the monthly option.

const CURRENT = 'admin/pricing/current.json';
const VERSIONS = 'admin/pricing/versions/';

// Fix types: what each weakness in a Google Ads report is priced as. The minutes are starting estimates made at build
// (16 Nov 2026) for Lewis to tune against real jobs; they are not prices.
// setup + perItem is the time by hand. aiSetup + aiPerItem (19 Nov 2026) is the time when the job can easily be done with
// AI help (AI drafts or makes the change, Lewis checks it); null means it can't be done quickly with AI (it needs his
// judgement about the business, the money or the site), so the job keeps the time by hand. The AI minutes are starting
// estimates for Lewis to tune in /admin#pricing, following the groups in the Google Ads Pricing Proposal (18 Nov 2026).
export const FIX_TYPES = {
  settings:  { label: 'Campaign settings',               item: 'campaigns',             setup: 15, perItem: 10,  aiSetup: 5,  aiPerItem: 2 },
  negatives: { label: 'Search term negatives',           item: 'search terms',          setup: 30, perItem: 0.5, aiSetup: 10, aiPerItem: 0.1 },
  keywords:  { label: 'Keywords',                        item: 'keywords',              setup: 20, perItem: 1,   aiSetup: 10, aiPerItem: 0.25 },
  ad_copy:   { label: 'Ads and assets',                  item: 'ad groups or assets',   setup: 20, perItem: 15,  aiSetup: 10, aiPerItem: 5 },
  tracking:  { label: 'Conversion tracking',             item: 'conversion actions',    setup: 60, perItem: 20,  aiSetup: null, aiPerItem: null },
  structure: { label: 'Account structure',               item: 'campaigns or ad groups', setup: 60, perItem: 30, aiSetup: null, aiPerItem: null },
  bidding:   { label: 'Bidding and budgets',             item: 'campaigns',             setup: 20, perItem: 15,  aiSetup: null, aiPerItem: null },
  // Shopping rules count products (the first real read, 16 Nov, had hundreds), so the time per product is small.
  shopping:  { label: 'Shopping and Performance Max',    item: 'products',              setup: 45, perItem: 0.5, aiSetup: 15, aiPerItem: 0.1 },
  // Website Check fixes (18 Nov 2026, Lewis: "implement pricing into this report, like we did for the audit"). One job
  // per kind of fix, however many checks it covers, so three speed findings are one speed job. Starting estimates for
  // Lewis to tune in /admin#pricing, the same as the Google Ads ones.
  web_speed:    { tool: 'web', label: 'Website speed',                 item: 'speed findings',   setup: 120, perItem: 0,  aiSetup: null, aiPerItem: null },
  web_mobile:   { tool: 'web', label: 'Phone layout',                  item: 'layout findings',  setup: 45,  perItem: 30, aiSetup: 20, aiPerItem: 10 },
  web_first:    { tool: 'web', label: 'Heading, place and contact button', item: 'changes',      setup: 30,  perItem: 15, aiSetup: 15, aiPerItem: 5 },
  web_contact:  { tool: 'web', label: 'Contact details and Maps link', item: 'changes',          setup: 20,  perItem: 15, aiSetup: 10, aiPerItem: 5 },
  web_search:   { tool: 'web', label: 'Search basics',                 item: 'changes',          setup: 20,  perItem: 15, aiSetup: 5,  aiPerItem: 5 },
  web_schema:   { tool: 'web', label: 'Structured data',               item: 'blocks',           setup: 45,  perItem: 15, aiSetup: 10, aiPerItem: 5 },
  web_technical:{ tool: 'web', label: 'Technical set-up',              item: 'changes',          setup: 30,  perItem: 15, aiSetup: 10, aiPerItem: 5 },
  web_tracking: { tool: 'web', label: 'Tracking enquiries',            item: 'changes',          setup: 60,  perItem: 30, aiSetup: null, aiPerItem: null },
  web_proof:    { tool: 'web', label: 'Reviews on the page',           item: 'sections',         setup: 60,  perItem: 0,  aiSetup: null, aiPerItem: null },
};

// Which Website Check finding is which kind of job. A finding not listed here isn't priced (it stays in the report).
export const WEB_FIX = {
  'speed-mobile': 'web_speed', 'speed-desktop': 'web_speed', 'web-vitals': 'web_speed',
  viewport: 'web_mobile', 'zoom-blocked': 'web_mobile', 'tap-targets': 'web_mobile', 'font-size': 'web_mobile',
  'what-you-do': 'web_first', where: 'web_first', 'contact-top': 'web_first', 'delivery-returns': 'web_first',
  'contact-routes': 'web_contact', 'tap-to-call': 'web_contact', consistent: 'web_contact', 'gbp-link': 'web_contact',
  title: 'web_search', description: 'web_search', 'one-heading': 'web_search', 'alt-text': 'web_search', noindex: 'web_search',
  'local-schema': 'web_schema', 'schema-broken': 'web_schema',
  https: 'web_technical', robots: 'web_technical', sitemap: 'web_technical', 'ai-search-bots': 'web_technical',
  analytics: 'web_tracking', measurable: 'web_tracking',
  proof: 'web_proof',
};

// A Website Check report's weaknesses as priced jobs: one per kind, named after its most important finding, with the
// others counted ("and 2 more"). Weaknesses arrive most important first.
export function webFixLines(weaknesses) {
  const jobs = new Map();
  for (const w of weaknesses || []) {
    const fixType = WEB_FIX[w.id];
    if (!fixType) continue;
    const j = jobs.get(fixType);
    if (j) { j.items += 1; j.titles.push(w.title); if (w.priority === 'high') j.priority = 'high'; }
    else jobs.set(fixType, { id: fixType, fixType, items: 1, titles: [w.title], priority: w.priority });
  }
  return [...jobs.values()].map(j => ({ id: j.id, fixType: j.fixType, items: j.items, priority: j.priority,
    title: j.titles[0] + (j.items > 1 ? ` and ${j.items - 1} more` : ''), covers: j.titles }));
}

// The Website Check's price list: the same calculator, no monthly option (that belongs to Google Ads management).
export function webQuote(pricing, weaknesses, now = new Date()) {
  const lines = webFixLines(weaknesses);
  const q = quote(pricing, lines, now);
  const covers = Object.fromEntries(lines.map(l => [l.id, l.covers]));
  return { ...q, retainer: null, lines: q.lines.map(l => ({ ...l, covers: covers[l.id] || [] })) };
}

export const DEFAULTS = {
  dayRate: 625,               // £, from the rate card
  hoursPerDay: 7,             // hourly rate = day rate / hours (£89.29)
  // Lewis, 19 Nov 2026: a flat one-hour rate to start the job(s), then each job priced on how long it takes, with AI help
  // where the fix can easily be done that way. Replaced roundToMinutes (30) and minMinutesPerFix (60), which made every
  // small fix at least an hour. New keys, so version 1's saved 30 and 60 can't bring the old minimum back.
  startMinutes: 60,           // charged once per order, whatever is ticked
  jobRoundMinutes: 15,        // each job's time rounds up to the next quarter hour
  jobMinMinutes: 15,          // and is at least this long
  monthlyMin: 500,            // £ a month, the least a monthly plan costs (Lewis, 21 Nov 2026). Empty hides the monthly option
  monthlyRound: 50,           // the monthly fee rounds to the nearest this many pounds
  // Estimated hours a month for an account, from the Google Ads Pricing Proposal (18 Nov 2026), without its AI share.
  monthlyHours: {
    base: 2,        // monthly note, check-in, tracking check
    search: 1.5,    // each non-brand or competitor Search campaign
    pmax: 1.5,      // each Performance Max campaign
    shopping: 1,    // each Shopping campaign
    other: 0.75,    // each Display, Demand Gen, Video or other campaign
    brand: 0.5,     // each brand Search campaign
    spendStep: 2500, // £ of monthly spend
    perStep: 0.5,   // hours for each spendStep above the first one
  },
  retainerMinMonths: 3,
  suggestRetainerMonths: 2,   // suggest the retainer when the one-off total is more than this many months of the fee
  quoteValidDays: 14,
  holdForReview: false,       // when on, customers see "Lewis will confirm this within one working day"
  fixTypes: FIX_TYPES,
  limits: {
    websiteChecksPerIpPerDay: 5,
    websiteCacheHours: 24,        // the same domain reuses its last result for this long
    adsChecksPerAccountDays: 30,  // one free check per Google Ads account in this many days
    adsAccountsPerLogin: 3,       // accounts per Google login or company domain, per 30 days
    agencyAccountThreshold: 5,    // a manager account with more than this many accounts is treated as an agency
    adsChecksPerDay: 40,          // daily ceiling. Explorer access allows 2,880 operations a day and a check uses about 25 to 60
  },
};

const num = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
};

// Checks a settings object from the admin form. Returns { settings } or { error }.
export function validate(input) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  const errors = [];
  const set = (key, min, max, { optional = false, target = s, from = input } = {}) => {
    if (!(key in from)) return;
    const v = num(from[key], min, max);
    if (v === null && optional) { target[key] = null; return; }
    if (v === null || Number.isNaN(v)) { errors.push(key); return; }
    target[key] = v;
  };
  set('dayRate', 1, 100000);
  set('hoursPerDay', 1, 24);
  set('startMinutes', 0, 2400);
  set('jobRoundMinutes', 1, 240);
  set('jobMinMinutes', 0, 2400);
  set('monthlyMin', 1, 100000, { optional: true });
  set('monthlyRound', 1, 1000);
  if (input.monthlyHours && typeof input.monthlyHours === 'object') {
    for (const k of Object.keys(DEFAULTS.monthlyHours)) set(k, 0, k === 'spendStep' ? 1000000 : 1000, { target: s.monthlyHours, from: input.monthlyHours });
    if (!(s.monthlyHours.spendStep > 0)) errors.push('spendStep');
  }
  set('retainerMinMonths', 1, 36);
  set('suggestRetainerMonths', 0, 36);
  set('quoteValidDays', 1, 365);
  if ('holdForReview' in input) s.holdForReview = !!input.holdForReview;
  if (input.limits && typeof input.limits === 'object') {
    for (const k of Object.keys(DEFAULTS.limits)) set(k, 0, 100000, { target: s.limits, from: input.limits });
  }
  if (input.fixTypes && typeof input.fixTypes === 'object') {
    for (const [id, ft] of Object.entries(DEFAULTS.fixTypes)) {
      const f = input.fixTypes[id];
      if (!f) continue;
      s.fixTypes[id] = { ...ft };
      set('setup', 0, 6000, { target: s.fixTypes[id], from: f });
      set('perItem', 0, 600, { target: s.fixTypes[id], from: f });
      // Empty AI time: the job can't be done quickly with AI, so it keeps the time by hand.
      set('aiSetup', 0, 6000, { target: s.fixTypes[id], from: f, optional: true });
      set('aiPerItem', 0, 600, { target: s.fixTypes[id], from: f, optional: true });
      if (typeof f.item === 'string' && f.item.trim()) s.fixTypes[id].item = f.item.trim().slice(0, 60);
    }
  }
  if (errors.length) return { error: 'Check these numbers: ' + errors.join(', ') + '.' };
  return { settings: s };
}

export const hourlyRate = s => s.dayRate / s.hoursPerDay;

// Merges saved settings over the defaults, so a setting added in code later always has a value.
function withDefaults(saved) {
  const s = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...saved };
  s.limits = { ...DEFAULTS.limits, ...(saved && saved.limits) };
  s.monthlyHours = { ...DEFAULTS.monthlyHours, ...(saved && saved.monthlyHours) };
  delete s.retainerFee; // replaced by monthlyMin on 21 Nov 2026
  s.fixTypes = {};
  for (const [id, ft] of Object.entries(DEFAULTS.fixTypes)) s.fixTypes[id] = { ...ft, ...(saved && saved.fixTypes && saved.fixTypes[id]) };
  return s;
}

// The live settings: { version, savedAt, savedBy, settings }. Version 0 is the built-in starting values.
export async function getPricing(env) {
  const obj = env.BLOBS ? await env.BLOBS.get(CURRENT) : null;
  if (!obj) return { version: 0, savedAt: null, savedBy: null, note: 'Starting values', settings: withDefaults({}) };
  try {
    const cur = await obj.json();
    return { ...cur, settings: withDefaults(cur.settings) };
  } catch {
    return { version: 0, savedAt: null, savedBy: null, note: 'Starting values', settings: withDefaults({}) };
  }
}

export async function getVersion(env, n) {
  if (!Number(n)) return { version: 0, savedAt: null, savedBy: null, note: 'Starting values', settings: withDefaults({}) };
  const obj = await env.BLOBS.get(VERSIONS + Number(n) + '.json');
  if (!obj) return null;
  const v = await obj.json();
  return { ...v, settings: withDefaults(v.settings) };
}

export async function listVersions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: VERSIONS, cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const m = o.customMetadata || {};
      out.push({ version: Number(m.version || o.key.slice(VERSIONS.length).replace('.json', '')), savedAt: m.savedAt || o.uploaded, savedBy: m.savedBy || '', note: m.note || '' });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.version - a.version);
}

export async function savePricing(env, settings, email, note) {
  const cur = await getPricing(env);
  const version = (cur.version || 0) + 1;
  const record = { version, savedAt: new Date().toISOString(), savedBy: email, note: String(note || '').slice(0, 200), settings };
  const meta = { version: String(version), savedAt: record.savedAt, savedBy: email, note: record.note };
  await env.BLOBS.put(VERSIONS + version + '.json', JSON.stringify(record), { httpMetadata: { contentType: 'application/json' }, customMetadata: meta });
  await env.BLOBS.put(CURRENT, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return record;
}

// Findings that sit in a job type with AI time but need Lewis's judgement throughout, so they keep the time by hand
// (the "Human" group in the Google Ads Pricing Proposal, 18 Nov 2026, where its job type is otherwise AI-assisted).
export const HUMAN_ONLY = new Set(['low-quality-score', 'no-audiences', 'shopping-wasted-spend']);

const roundUp = (s, raw) => { const step = s.jobRoundMinutes || 1; return Math.max(s.jobMinMinutes || 0, Math.ceil(raw / step) * step); };
const hasAi = ft => ft && ft.aiSetup != null && ft.aiPerItem != null && Number.isFinite(Number(ft.aiSetup)) && Number.isFinite(Number(ft.aiPerItem));

// Minutes for one job by hand: set-up plus minutes per item, rounded up.
export function humanMinutes(s, fixType, items) {
  const ft = s.fixTypes[fixType];
  if (!ft) return null;
  return roundUp(s, ft.setup + ft.perItem * Math.max(1, Math.round(Number(items) || 1)));
}

// Minutes for one job as priced: the AI-assisted time where the job type has one, otherwise the time by hand.
export function fixMinutes(s, fixType, items) {
  const ft = s.fixTypes[fixType];
  if (!ft) return null;
  if (!hasAi(ft)) return humanMinutes(s, fixType, items);
  return Math.min(humanMinutes(s, fixType, items), roundUp(s, Number(ft.aiSetup) + Number(ft.aiPerItem) * Math.max(1, Math.round(Number(items) || 1))));
}

// Estimated monthly management for an account: { hours, fee, atMinimum, campaigns }. workload is { spend, campaigns:
// [{ channel, brand }] } from the rules (runRules().workload). Without one (older reports), only the base hours count.
const CHANNEL = { SEARCH: 'search', PERFORMANCE_MAX: 'pmax', SHOPPING: 'shopping' };
export function monthlyEstimate(s, workload) {
  if (s.monthlyMin == null) return null;
  const h = s.monthlyHours;
  const camps = (workload && workload.campaigns) || [];
  let hours = h.base;
  for (const c of camps) hours += c.brand ? h.brand : (h[CHANNEL[c.channel]] ?? h.other);
  const spend = Number(workload && workload.spend) || 0;
  if (h.spendStep > 0 && spend > h.spendStep) hours += h.perStep * (spend - h.spendStep) / h.spendStep;
  hours = Math.round(hours * 10) / 10;
  const step = s.monthlyRound || 1;
  const byHours = Math.round(hours * hourlyRate(s) / step) * step;
  const fee = Math.max(s.monthlyMin, byHours);
  return { hours, fee, atMinimum: byHours <= s.monthlyMin, campaigns: camps.length, estimated: !!workload };
}

// Prices a list of weaknesses: [{ id, title, fixType, items, fromPrice, priority }].
// Returns the one-hour start (charged once when anything is ticked), the lines, the total for everything, and whether to
// show and suggest the monthly option. Each line also carries its time by hand (humanMinutes) so the admin preview can
// show the saving.
export function quote(pricing, weaknesses, now = new Date(), workload = null) {
  const s = pricing.settings;
  const rate = hourlyRate(s);
  const lines = [];
  for (const w of weaknesses) {
    const minutes = HUMAN_ONLY.has(w.id) ? humanMinutes(s, w.fixType, w.items) : fixMinutes(s, w.fixType, w.items);
    if (minutes == null) continue;
    const hours = minutes / 60;
    const human = humanMinutes(s, w.fixType, w.items);
    lines.push({
      id: w.id, title: w.title, fixType: w.fixType, fixLabel: s.fixTypes[w.fixType].label,
      items: Math.max(1, Math.round(Number(w.items) || 1)), itemLabel: w.itemLabel || s.fixTypes[w.fixType].item,
      minutes, hours, price: Math.round(hours * rate), fromPrice: !!w.fromPrice,
      ai: minutes < human, humanMinutes: human, humanPrice: Math.round(human / 60 * rate),
      ticked: w.priority === 'high',
    });
  }
  const startMinutes = Number(s.startMinutes) || 0;
  const start = { minutes: startMinutes, hours: startMinutes / 60, price: Math.round(startMinutes / 60 * rate) };
  const jobs = lines.reduce((a, l) => a + l.price, 0);
  const total = lines.length ? start.price + jobs : 0;
  const est = monthlyEstimate(s, workload);
  const retainer = est ? {
    fee: est.fee, hours: est.hours, atMinimum: est.atMinimum, minimum: s.monthlyMin, estimated: est.estimated,
    minMonths: s.retainerMinMonths, suggestMonths: s.suggestRetainerMonths,
    suggested: total > est.fee * s.suggestRetainerMonths,
  } : null;
  return {
    version: pricing.version || 0,
    hourlyRate: Math.round(rate * 100) / 100,
    start, lines, total,
    totalHours: lines.length ? start.hours + lines.reduce((a, l) => a + l.hours, 0) : 0,
    // the same jobs, every one by hand (no AI time), without the start: for the admin preview only
    humanTotal: lines.reduce((a, l) => a + l.humanPrice, 0),
    retainer,
    holdForReview: !!s.holdForReview,
    validUntil: new Date(now.getTime() + s.quoteValidDays * 86400000).toISOString().slice(0, 10),
  };
}

// Sample account sizes for the preview in /admin, so a change can be seen before it is saved. These are made-up
// accounts for the preview only, never shown to a customer.
export const SAMPLES = {
  website: {
    label: 'Website, old local trade site (sample)',
    weaknesses: webFixLines([
      { id: 'speed-mobile', title: 'Slow on a phone', priority: 'high' }, { id: 'viewport', title: 'Not set up for phone screens', priority: 'high' },
      { id: 'analytics', title: 'No Google Analytics or Tag Manager found', priority: 'high' }, { id: 'tap-to-call', title: 'The phone number isn’t tap-to-call', priority: 'medium' },
      { id: 'title', title: 'The page title is very short', priority: 'medium' }, { id: 'description', title: 'No meta description', priority: 'medium' },
      { id: 'local-schema', title: 'No local business details for search engines', priority: 'medium' }, { id: 'sitemap', title: 'No sitemap found', priority: 'low' },
    ]),
  },
  small: {
    label: 'Small account (sample)',
    workload: { spend: 1000, campaigns: [{ channel: 'SEARCH', brand: false }] },
    weaknesses: [
      { id: 'sample-location', title: 'Location targeting reaches people outside your area', fixType: 'settings', items: 2, priority: 'high' },
      { id: 'sample-negatives', title: 'Search terms that never turn into enquiries', fixType: 'negatives', items: 60, priority: 'high' },
      { id: 'sample-ads', title: 'Ad groups with only one ad', fixType: 'ad_copy', items: 3, priority: 'medium' },
      { id: 'sample-tracking', title: 'Enquiries are not recorded as conversions', fixType: 'tracking', items: 1, priority: 'high', fromPrice: true },
    ],
  },
  medium: {
    label: 'Medium account (sample)',
    workload: { spend: 15540, campaigns: [
      { channel: 'SEARCH', brand: false }, { channel: 'SEARCH', brand: false }, { channel: 'SEARCH', brand: false }, { channel: 'SEARCH', brand: false },
      { channel: 'PERFORMANCE_MAX' }, { channel: 'PERFORMANCE_MAX' }, { channel: 'SHOPPING' }, { channel: 'DISPLAY' }, { channel: 'DEMAND_GEN' },
      { channel: 'SEARCH', brand: true },
    ] },
    weaknesses: [
      { id: 'sample-location', title: 'Location targeting reaches people outside your area', fixType: 'settings', items: 6, priority: 'high' },
      { id: 'sample-negatives', title: 'Search terms that never turn into enquiries', fixType: 'negatives', items: 300, priority: 'high' },
      { id: 'sample-keywords', title: 'Keywords with a low Quality Score', fixType: 'keywords', items: 80, priority: 'medium' },
      { id: 'sample-ads', title: 'Ad groups with only one ad', fixType: 'ad_copy', items: 12, priority: 'medium' },
      { id: 'sample-tracking', title: 'Micro conversions counted as primary', fixType: 'tracking', items: 4, priority: 'high' },
      { id: 'sample-structure', title: 'Campaigns mixing unrelated services', fixType: 'structure', items: 4, priority: 'medium' },
      { id: 'sample-bidding', title: 'Smart bidding with too few conversions', fixType: 'bidding', items: 3, priority: 'medium' },
    ],
  },
};
