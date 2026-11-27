#!/usr/bin/env node
// preview-admin.cjs: the admin (/admin) on this Mac with made-up data, for looking at it and for the design check
// (scripts/check-admin-system.cjs). Every name, company and figure here is an "Example ..." sample: no real client,
// prospect, invoice or subscriber, no secrets, no Worker, nothing sent anywhere, no cost. It serves:
//   /admin                 cloudflare/private/admin.html, as the Worker does
//   /admin/api/...         answers in the shapes cloudflare/src/admin.js and its modules return (writes change the
//                          in-memory sample only, so buttons can be tried)
//   everything else        the repo's static files (fonts, logo, favicon), and a stand-in page for the tool reports
//   node scripts/preview-admin.cjs              http://127.0.0.1:8791/admin
//   node scripts/preview-admin.cjs --port 8792
// Admin Kit build, Lewis "Yes build it" 26 Nov 2026 (Obsidian 01_Phillips/03_Portfolio/Admin on the Kit (draft).md).
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');

const DAY = 864e5;
const at = (days, h = 10, m = 0) => { const d = new Date(Date.now() + days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };
const day = days => at(days).slice(0, 10);
const monday = n => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * n); return d.toISOString().slice(0, 10); };
const id16 = n => (n.toString(16) + '0123456789abcdef').slice(0, 16).padEnd(16, '0');

// eight weeks of Google Ads figures, oldest first, the last one the latest full week
function adsWeeks(cost, conv, value, trend) {
  return Array.from({ length: 8 }, (_, i) => {
    const k = 1 + trend * (i - 7) / 7, w = monday(i - 8);
    return { w, to: new Date(new Date(w).getTime() + 6 * DAY).toISOString().slice(0, 10), cost: Math.round(cost * k), conversions: Math.max(0, Math.round(conv * k)), value: value ? Math.round(value * k) : 0, clicks: Math.round(cost * k * 0.9), impressions: Math.round(cost * k * 21) };
  });
}

function fixtures() {
  const clients = [
    { slug: 'example-builders', name: 'Example Builders Ltd', status: 'Active · Google Ads', website: 'https://example-builders.co.uk', businessType: 'Builder', industry: 'Construction', overall: '8/10',
      health: [{ area: 'Conversion tracking', score: '9/10', status: 'Tags firing on the order page' }, { area: 'Budget pacing', score: '8/10', status: 'November spend against the plan' }, { area: 'Search terms', score: '6/10', status: 'Monthly review of what people searched' }],
      sections: [{ name: 'Weekly report', count: 4, items: [{ title: 'Week of ' + day(-9).slice(8) + ' Nov', date: day(-2), doc: id16(0xa1) }] }, { name: 'Search term review', count: 2, items: [{ title: 'October searches', date: day(-23), doc: id16(0xa2) }] }, { name: 'Tracking audit', count: 1, items: [{ title: 'Every tag checked', date: day(-14), doc: id16(0xa3) }] }],
      openTasks: ['Add negatives from the review', 'Check the Christmas budget'], openTaskCount: 2, profileDoc: id16(0xa4), brainDumpDoc: id16(0xa5), profileUpdated: day(-2),
      metrics: { ads: { currency: 'GBP', weeks: adsWeeks(1200, 31, 0, 0.3) } } },
    { slug: 'example-bakery', name: 'Example Bakery Ltd', status: 'Active · Google Ads and website', website: 'https://example-bakery.co.uk', businessType: 'Bakery', overall: '9/10',
      health: [{ area: 'Conversion tracking', score: '9/10', status: 'Orders counted' }], sections: [{ name: 'Weekly report', count: 6, items: [{ title: 'Week of 17 Nov', date: day(-2), doc: id16(0xb1) }] }],
      openTasks: ['Swap the December ads'], openTaskCount: 1, profileDoc: id16(0xb4), metrics: { ads: { currency: 'GBP', weeks: adsWeeks(900, 44, 3100, 0.1) } } },
    { slug: 'example-dental', name: 'Example Dental Practice', status: 'Active · Local search', website: 'https://example-dental.co.uk', businessType: 'Dentist', overall: '6/10',
      health: [{ area: 'Tracking', score: '5/10', status: 'The booking form is not counted' }], sections: [{ name: 'Tracking audit', count: 1, items: [{ title: 'Booking form', date: day(-12), doc: id16(0xc1) }] }],
      openTasks: ['Fix the booking form tag'], openTaskCount: 1, metrics: { ads: { currency: 'GBP', weeks: adsWeeks(700, 0, 0, -0.4).map((w, i) => i > 5 ? { ...w, conversions: 0 } : w) } } },
    { slug: 'example-garage', name: 'Example Garage Ltd', status: 'Active · Google Ads', website: 'https://example-garage.co.uk', businessType: 'Garage', overall: '8/10',
      health: [], sections: [{ name: 'Weekly report', count: 3, items: [{ title: 'Week of 17 Nov', date: day(-2), doc: id16(0xd1) }] }], openTasks: [], openTaskCount: 0, metrics: { ads: { currency: 'GBP', weeks: adsWeeks(600, 18, 0, 0.05) } } },
    { slug: 'example-florist', name: 'Example Florist', status: 'Onboarding · Shopping feed', website: 'https://example-florist.co.uk', businessType: 'Florist',
      health: [], sections: [], openTasks: ['Send the access request', 'Agree the first report day'], openTaskCount: 2 },
    { slug: 'example-plumbing', name: 'Example Plumbing Ltd', status: 'Active · Google Ads', website: 'https://example-plumbing.co.uk', businessType: 'Plumber', overall: '8/10',
      health: [{ area: 'Budget pacing', score: '8/10', status: 'On plan' }], sections: [{ name: 'Weekly report', count: 5, items: [{ title: 'Week of 17 Nov', date: day(-3), doc: id16(0xe1) }] }], openTasks: [], openTaskCount: 0, metrics: { ads: { currency: 'GBP', weeks: adsWeeks(1500, 52, 0, 0.5) } } },
    { slug: 'example-joinery', name: 'Example Joinery Ltd', status: 'Paused', businessType: 'Joiner', health: [], sections: [], openTasks: [], openTaskCount: 0 },
  ];
  const billing = {
    today: day(0),
    clients: {
      'example-builders': { fee: 400, cadence: 'monthly', day: 1, start: '2026-03-01', xeroContactId: 'x1', xeroContactName: 'Example Builders Ltd', deskId: 'ws_example01', deskName: 'Example Builders Ltd', money: { invoiced12m: 3600, paid12m: 3200, owed: 400, recent: [{ id: 'i1', number: 'INV-0042', total: 400, date: day(-25), due: day(5), status: 'AUTHORISED' }, { id: 'i2', number: 'INV-0037', total: 400, date: day(-56), due: day(-26), status: 'PAID' }] } },
      'example-bakery': { fee: 450, cadence: 'monthly', day: 1, start: '2026-06-01', xeroContactId: 'x2', xeroContactName: 'Example Bakery Ltd', money: { invoiced12m: 2700, paid12m: 2700, owed: 0, recent: [{ id: 'i3', number: 'INV-0041', total: 450, date: day(-25), due: day(-5), status: 'PAID' }] } },
      'example-dental': { fee: 350, cadence: 'monthly', day: 15, start: '2026-08-15' },
      'example-garage': { fee: 300, cadence: 'monthly', day: 1, start: '2026-09-01' },
      'example-florist': { fee: 250, cadence: 'monthly', day: 5, start: day(9) },
      'example-plumbing': { fee: 400, cadence: 'monthly', day: 1, start: '2026-10-01' },
      'example-joinery': { fee: 300, cadence: 'monthly', former: true, formerAt: at(-40) },
    },
    revenue: { monthly: 1900, payers: 5, upcoming: 250, nextStart: day(9), invoicedMonth: 2150, paidYear: 19400, owed: 400, overdue: 0, openCount: 1 },
    xero: { ready: true, connected: true, tenantName: 'Example Group Ltd', connectedAt: at(-30), syncedAt: at(0, 5, 15), lastError: null, untagged: 0, contacts: [{ id: 'x1', name: 'Example Builders Ltd' }, { id: 'x2', name: 'Example Bakery Ltd' }, { id: 'x3', name: 'Example Dental Practice' }] },
  };
  const deal = (n, name, stage, o) => ({ id: 'd_' + id16(0x1000 + n), name, stage, rank: n, saved: true, values: [], pricing: 'all', comments: [], files: [], history: [{ to: 'Lead', at: at(-20) }], updatedAt: at(-3), ...o });
  const deals = [
    deal(1, 'Example Cafe Ltd', 'Lead', { contact: 'Sam Example', role: 'Owner', email: 'sam@example.com', nextStep: 'Call back', nextDate: day(2), values: [{ id: 'f1', label: 'Google Ads set-up', amount: 600, basis: 'one-off' }] }),
    deal(2, 'Example Gym Ltd', 'Lead', { contact: 'Alex Example', nextStep: 'Reply to their enquiry', values: [{ id: 'f2', label: 'Website and local search', amount: 1100, basis: 'one-off' }], source: 'Website Check' }),
    deal(3, 'Example Salon', 'Talking', { contact: 'Jo Example', nextStep: 'Meeting', nextDate: day(6), values: [{ id: 'f3', label: 'Local search', amount: 450, basis: 'monthly' }], comments: [{ id: 'c1', text: 'Wants to start in January.', at: at(-4) }] }),
    deal(4, 'Example Vets Ltd', 'Talking', { contact: 'Pat Example', nextStep: 'Send the rate card', nextDate: day(-1), values: [{ id: 'f4', label: 'Google Ads', amount: 800, basis: 'monthly' }], rateCard: { views: 0, createdAt: at(-6), link: 'http://127.0.0.1/rate-card?invite=example' } }),
    deal(5, 'Example Hotel Ltd', 'Proposal drafted', { contact: 'Chris Example', nextStep: 'Finish the draft', nextDate: day(4), values: [{ id: 'f5', label: 'Website rebuild', amount: 2400, basis: 'one-off' }], files: [{ id: 'fl1', kind: 'file', name: 'Brief.pdf', type: 'application/pdf', size: 240000, at: at(-5) }] }),
    deal(6, 'Example Brewery Ltd', 'Proposal sent', { contact: 'Robin Example', email: 'robin@example.com', nextStep: 'Follow up', nextDate: day(-2), values: [{ id: 'f6', label: 'Shopping feed', amount: 700, basis: 'one-off' }], history: [{ to: 'Lead', at: at(-20) }, { from: 'Talking', to: 'Proposal sent', at: at(-3, 15, 40) }], updatedAt: at(-3, 15, 40) }),
    deal(7, 'Example Opticians', 'Proposal sent', { contact: 'Lee Example', nextStep: 'Waiting on their reply', values: [{ id: 'f7', label: 'Google Ads', amount: 900, basis: 'one-off' }] }),
    deal(8, 'Example Estate Agents', 'Refining proposal', { contact: 'Kim Example', nextStep: 'Revised proposal with the second option priced on its own, plus the tracking audit as a one-off; they want it before their board meets on Thursday so the figures can go in the pack', nextDate: day(7), values: [{ id: 'f8', label: 'Ads and tracking', amount: 1300, basis: 'one-off' }] }),
    deal(9, 'Example Kitchens Ltd', 'Won', { contact: 'Dee Example', values: [{ id: 'f9', label: 'Google Ads', amount: 500, basis: 'monthly' }] }),
    deal(10, 'Example Tutors', 'Lost', { contact: 'Mo Example', nextStep: 'Went with someone else' }),
  ];
  const inv = (n, name, pages, o) => {
    const token = 'tok' + id16(0x2000 + n);
    const base = { token, name, note: '', createdAt: at(-10 - n), startsAt: at(-10 - n), expiresAt: at(20 + n * 3), state: 'active', archived: false, views: 0, previews: 0, browsers: 0, lastViewedAt: null, lastCountry: '', pages, pageViews: {}, ...o };
    base.links = Object.fromEntries(pages.map(k => [k, 'http://127.0.0.1:8791/' + k + '?invite=' + token])); base.link = base.links[pages[0]];
    return base;
  };
  const invites = [
    inv(1, 'Example Dental Practice', ['rate-card'], { views: 6, browsers: 1, lastViewedAt: at(0, 10, 12), lastCountry: 'GB', note: 'From the Ely meetup' }),
    inv(2, 'Example Brewery Ltd', ['rate-card', 'search-desk'], { views: 9, browsers: 2, lastViewedAt: at(-3, 15, 2), lastCountry: 'GB', pageViews: { 'rate-card': 5, 'search-desk': 4 } }),
    inv(3, 'Example Florist', ['rate-card'], { views: 2, browsers: 1, lastViewedAt: at(-5), lastCountry: 'GB', expiresAt: at(1, 23, 59) }),
    inv(4, 'Example Opticians', ['search-desk'], {}),
    inv(5, 'Example Hotel Ltd', ['monument'], { state: 'scheduled', startsAt: at(3), expiresAt: at(40) }),
    inv(6, 'Example Old Lead', ['rate-card'], { archived: true, archivedAt: at(-30), state: 'expired', views: 3, browsers: 1 }),
  ];
  const brief = {
    issues: [
      { date: monday(1), title: 'Google Ads changes for December', items: 6, webOnly: false, problems: [], status: 'draft', approvedAt: null, changedSinceApproval: false, publishedAt: null, sentAt: null, lastError: null, canSendNow: false },
      { date: monday(0), title: 'Search Console and local search', items: 5, webOnly: false, problems: [], status: 'sent', publishedAt: at(-2, 7), sentAt: at(-2, 7), changedSinceApproval: false, lastError: null, canSendNow: false },
      { date: monday(-1), title: 'Performance Max reports', items: 7, webOnly: false, problems: [], status: 'sent', publishedAt: at(-9, 7), sentAt: at(-9, 7), changedSinceApproval: false, lastError: null, canSendNow: false },
    ],
    subscribers: { confirmed: 41, pending: 3, others: 39, unsynced: 0 }, startedAt: at(-11, 7), list: { ok: true }, today: day(0),
  };
  const subscribers = { pendingDays: 7, unsubscribes: { ok: true }, rows: [
    { email: 'reader.one@example.com', status: 'confirmed', createdAt: at(-1), confirmedAt: at(-1), location: 'home', page: '/', listSynced: true },
    { email: 'reader.two@example.com', status: 'pending', createdAt: at(-2), location: 'guide', page: '/guides/example/' },
    { email: 'reader.three@example.com', status: 'confirmed', createdAt: at(-12), confirmedAt: at(-12), location: 'google-ads-check', page: '/google-ads-audit', listSynced: true },
    { email: 'reader.four@example.com', status: 'unsubscribed', createdAt: at(-30), confirmedAt: at(-30), location: 'updates-hero', page: '/updates/' },
    { email: 'you@example.com', status: 'confirmed', createdAt: at(-15), confirmedAt: at(-15), location: 'home', page: '/', own: true, listSynced: true },
  ] };
  const weeks = Array.from({ length: 8 }, (_, i) => ({ week: monday(-i), cards: [3, 2, 4, 1, 2, 0, 1, 2][i], tools: { 'website-check': { completed: [12, 9, 14, 7, 8, 5, 6, 4][i], reused: i % 3, failed: 0, blocked: i === 0 ? { bot: 3, rate: 1 } : { bot: 2 } }, 'google-ads-check': { completed: [4, 3, 5, 2, 2, 1, 0, 1][i], blocked: {} } } }));
  const site = { audits: { total: 42, last7: 5, last30: 18 }, recent: [
    { domain: 'example-garage.co.uk', score: 72, band: 'good', keyword: 'mot ely', auditedAt: at(-1), report: '/r/example1' },
    { domain: 'example-florist.co.uk', score: 58, band: 'fair', keyword: 'florist cambridge', auditedAt: at(-3), report: '/r/example2' },
    { domain: 'example-cafe.co.uk', score: 81, band: 'good', keyword: '', auditedAt: at(-6), report: null },
  ] };
  const desk = { ready: true, companies: [{ id: 'ws_example01', name: 'Example Builders Ltd' }, { id: 'ws_example02', name: 'Example Bakery Ltd' }], health: { ws_example01: { id: 'ws_example01', currency: 'GBP', dataOk: true, dates: { from: day(-7), to: day(-1) }, link: 'https://www.phillips-uk.com/desk/', last30: { spend: 4800, conversions: 124, value: null },
    findings: [{ daily: true, head: 'Search terms to add as negatives', campaign: 'Search, Builders', money: 120, per: 'a month' }, { daily: true, head: 'Budget runs out before 3pm', campaign: 'Search, Extensions', money: 80, per: 'a week' }], summary: { count: 2, money: 200 } } } };
  const docs = {};
  for (const c of clients) for (const s of c.sections) for (const it of s.items) if (it.doc) docs[it.doc] = { title: it.title, date: it.date, path: '03_Clients/' + c.name + '/' + s.name + '/' + it.title + '.md', obsidian: 'obsidian://open?vault=Example', markdown: '# ' + it.title + '\n\nAn example report. Every figure on this page is made up.\n\n## What changed\n\n- Spend held level on the week before.\n- Two new search terms added as negatives.\n\n| Campaign | Spend | Conversions |\n|---|---|---|\n| Search, Builders | £820 | 21 |\n| Search, Extensions | £380 | 10 |\n\n> **Next week**\n> Check the Christmas budget.\n' };
  // the data shape check's last result, in the shape cloudflare/src/shape-check.js stores (made-up rows only)
  const fld = (field, label, expect, examples = []) => ({ field, label, expect, count: examples.length, examples });
  const shape = { ranAt: at(0, 5, 15), by: 'daily', ms: 1840, calls: 3, tables: [
    { key: 'prospects', label: 'Prospects', where: 'Saved cards in the funnel (R2)', unit: ['card', 'cards'], checked: true, rows: deals.length, checkedAt: at(0, 5, 15), odd: 2, fields: [
      fld('id', 'Card ID', 'd_ and 16 letters or figures'), fld('name', 'Name', 'the company or person'),
      fld('stage', 'Stage', 'one of the seven stages on the board', [{ id: deals[6].id, name: deals[6].name, href: '#prospects/' + deals[6].id, found: '"Negotiating"' }]),
      fld('values', 'Fees', 'a list of fees, amounts as numbers', [{ id: deals[2].id, name: deals[2].name, href: '#prospects/' + deals[2].id, found: 'amount saved as text' }]),
      fld('nextDate', 'Next step date', 'empty or a date'), fld('email', 'Email', 'empty or an email address'), fld('lists', 'Comments, files, history', 'each a list')] },
    { key: 'accounts', label: 'Accounts', where: 'Visitors’ accounts (D1)', unit: ['account', 'accounts'], checked: true, rows: 37, checkedAt: at(0, 5, 15), odd: 0, fields: [
      fld('email', 'Email', 'a lower-case email address'), fld('created_at', 'Created', 'a date and time')] },
    { key: 'checks', label: 'Saved checks', where: 'Checks kept with an account (D1)', unit: ['check', 'checks'], checked: false, rowsRead: 0,
      reason: 'the read failed after 0 rows, even in small pieces (query took too long)', last: { checkedAt: at(-1, 5, 15), odd: 0, rows: 112 } },
  ] };
  return { clients, billing, deals, invites, brief, subscribers, weeks, site, desk, docs, shape };
}

async function pricingData() {
  const P = await import(path.join(ROOT, 'cloudflare/src/pricing.js'));
  const current = { version: 3, savedAt: at(-5), savedBy: 'you@example.com', settings: JSON.parse(JSON.stringify(P.DEFAULTS)) };
  return { P, data: { current, versions: [{ version: 3, savedAt: at(-5), savedBy: 'you@example.com', note: 'Monthly minimum to £500' }, { version: 2, savedAt: at(-9), savedBy: 'you@example.com', note: 'AI times' }],
    hourlyRate: Math.round(P.hourlyRate(current.settings) * 100) / 100, samples: Object.fromEntries(Object.entries(P.SAMPLES).map(([k, v]) => [k, v.label])), reports: [] } };
}

function server() {
  const F = fixtures();
  let pricing = null;
  const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' };
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/', post = req.method === 'POST';
    if (p === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(ROOT, 'cloudflare/private/admin.html'))); }
    if (p === '/admin/api/me') return json(res, { email: 'you@example.com' });
    if (p === '/admin/api/logout') return json(res, { ok: true });
    if (p === '/admin/api/clients') return json(res, { syncedAt: at(0, 6), metricsAt: at(0, 6), metricsPeriod: { fullWeek: true }, clients: F.clients });
    if (p === '/admin/api/invites' && !post) return json(res, { invites: F.invites, deskDemo: {} });
    if (p === '/admin/api/invites' && post) { const b = await readBody(req); const n = { ...F.invites[0], token: 'tok' + Date.now().toString(16), name: b.name, note: b.note || '', views: 0, browsers: 0, lastViewedAt: null, pages: b.pages, createdAt: new Date().toISOString(), archived: false, state: 'active' }; n.links = Object.fromEntries(b.pages.map(k => [k, 'http://127.0.0.1:8791/' + k + '?invite=' + n.token])); n.link = n.links[b.pages[0]]; F.invites.unshift(n); return json(res, n, 201); }
    let m = p.match(/^\/admin\/api\/invites\/([^/]+)(?:\/(revoke|restore|archive|unarchive|dates))?$/);
    if (m) {
      const i = F.invites.find(x => x.token === m[1]); if (!i) return json(res, { error: 'That link no longer exists.' }, 404);
      if (!m[2]) return json(res, { ...i, visits: i.views ? [{ at: i.lastViewedAt, page: i.pages[0], device: 'Computer', os: 'Mac', browser: 'Safari', city: 'Ely', region: 'England', country: 'GB', secs: 140, scroll: 80, from: 'mail.google.com' }] : [], recent: [] });
      if (m[2] === 'revoke') i.state = 'revoked'; if (m[2] === 'restore') i.state = 'active'; if (m[2] === 'archive') i.archived = true; if (m[2] === 'unarchive') i.archived = false;
      if (m[2] === 'dates') { const b = await readBody(req); i.startsAt = b.from ? b.from + 'T00:00:00Z' : null; i.expiresAt = b.until ? b.until + 'T23:59:59Z' : null; }
      return json(res, i);
    }
    if (p === '/admin/api/site') return json(res, F.site);
    if (p === '/admin/api/deals' && !post) return json(res, { deals: F.deals });
    if (p === '/admin/api/deals' && post) { const b = await readBody(req); const d = { ...b, id: 'd_' + Date.now().toString(16).padEnd(16, '0').slice(0, 16), saved: true, comments: [], files: [], history: [{ to: b.stage, at: new Date().toISOString() }], updatedAt: new Date().toISOString() }; F.deals.push(d); return json(res, d); }
    m = p.match(/^\/admin\/api\/deals\/([^/]+)(\/.*)?$/);
    if (m && post) {
      const d = F.deals.find(x => x.id === m[1]); if (!d) return json(res, { error: 'That card is no longer on the board.' }, 404);
      const b = await readBody(req);
      if (!m[2]) { if (b.stage && b.stage !== d.stage) d.history = (d.history || []).concat([{ from: d.stage, to: b.stage, at: new Date().toISOString() }]); Object.assign(d, b, { updatedAt: new Date().toISOString() }); }
      else if (m[2] === '/delete') { F.deals.splice(F.deals.indexOf(d), 1); return json(res, { ok: true }); }
      else if (m[2] === '/comments') d.comments = (d.comments || []).concat([{ id: 'c' + Date.now(), text: b.text, at: new Date().toISOString() }]);
      return json(res, d);
    }
    if (p === '/admin/api/brief' && !post) return json(res, F.brief);
    if (p === '/admin/api/brief/subscribers') return json(res, F.subscribers);
    m = p.match(/^\/admin\/api\/brief\/(\d{4}-\d{2}-\d{2})\/(page|email|test|approve|withdraw|send-now)$/);
    if (m) {
      const i = F.brief.issues.find(x => x.date === m[1]);
      if (m[2] === 'page' || m[2] === 'email') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><title>Example issue</title><p style="font:16px system-ui;padding:24px">The issue preview, from the Worker in the real admin.</p>'); }
      if (m[2] === 'test') return json(res, { ok: true, to: 'you@example.com' });
      if (m[2] === 'approve') { i.status = 'approved'; i.canSendNow = false; } if (m[2] === 'withdraw') i.status = 'draft';
      return json(res, { ok: true });
    }
    if (p === '/admin/api/tool-usage') return json(res, { weeks: F.weeks });
    if (p === '/admin/api/billing' && !post) return json(res, F.billing);
    m = p.match(/^\/admin\/api\/billing\/([^/]+)(\/former)?$/);
    if (m && post) { const b = await readBody(req); F.billing.clients[m[1]] = m[2] ? { ...F.billing.clients[m[1]], former: b.former, formerAt: b.former ? new Date().toISOString() : null } : { ...F.billing.clients[m[1]], ...b, fee: b.fee === '' ? null : Number(b.fee), day: Number(b.day) || null }; return json(res, F.billing); }
    if (p === '/admin/api/xero/sync') return json(res, F.billing);
    if (p === '/admin/api/settings') return json(res, { email: { month: day(0).slice(0, 7), sent: 142, cap: 900 } });
    // the data shape check (cloudflare/src/shape-check.js): one table to fix, one as expected, one not checked
    if (p === '/admin/api/health/shape') { if (post) F.shape.ranAt = new Date().toISOString(), F.shape.by = 'now'; return json(res, { result: F.shape }); }
    if (p === '/admin/api/desk') return json(res, F.desk);
    m = p.match(/^\/admin\/api\/doc\/([a-f0-9]{16})$/);
    if (m) return F.docs[m[1]] ? json(res, { id: m[1], ...F.docs[m[1]], syncedAt: at(0, 6) }) : json(res, { error: 'That document is no longer in the latest sync. Open it in Obsidian instead.' }, 404);
    if (p.startsWith('/admin/api/pricing')) {
      if (!pricing) pricing = await pricingData();
      if (p === '/admin/api/pricing' && !post) return json(res, pricing.data);
      if (p === '/admin/api/pricing/preview') { const b = await readBody(req); const v = pricing.P.validate(b.settings || {}); if (v.error) return json(res, { error: v.error }, 400); const s = pricing.P.SAMPLES[b.sample] || pricing.P.SAMPLES.small || Object.values(pricing.P.SAMPLES)[0]; return json(res, { label: s.label, quote: pricing.P.quote({ version: 'preview', settings: v.settings }, s.weaknesses, new Date(), s.workload || null), hourlyRate: Math.round(pricing.P.hourlyRate(v.settings) * 100) / 100 }); }
      return json(res, { error: 'Not in the preview' }, 404);
    }
    if (p.startsWith('/admin/api/')) return json(res, { ok: true });
    if (p === '/tools/google-ads-check/demos') return json(res, { demos: [{ id: 'trades', name: 'Example Trades Co', size: 'Small', model: 'Leads', build: 'Search', note: 'A made-up local trades account.' }, { id: 'shop', name: 'Example Shop Ltd', size: 'Medium', model: 'Sales', build: 'Shopping', note: 'A made-up online shop.' }] });
    if (p === '/tools/website-check/demos') return json(res, { demos: [{ id: 'cafe', name: 'Example Cafe', size: 'Small', model: 'Local', build: 'Old site', note: 'A made-up cafe website.' }] });
    if (p === '/google-ads-audit' || p === '/website-check') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><meta charset="utf-8"><title>Example report</title><p style="font:16px system-ui;padding:24px">The tool report, served by the Worker in the real admin.</p>'); }
    let f = path.join(ROOT, decodeURIComponent(p));
    if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(buf); });
  });
}

module.exports = { server };

if (require.main === module) {
  const i = process.argv.indexOf('--port'), port = i !== -1 ? Number(process.argv[i + 1]) : 8791;
  server().listen(port, '127.0.0.1', () => console.log(`admin preview with example data: http://127.0.0.1:${port}/admin`));
}
