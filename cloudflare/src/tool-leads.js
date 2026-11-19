// The free tools as leads (Lewis, 19 Nov 2026: "see who uses them"). Every completed visitor check becomes a Lead card in
// the /admin sales funnel (the same board the contact form feeds), and every start, finish and refusal is counted by day so
// /admin#site can show usage week by week. Lewis's own preview and demo runs make no card and aren't counted.
//
// Storage (R2 BLOBS):
//   admin/tool-usage/<YYYY-MM-DD>.json   { tools: { <tool>: { completed, reused, failed, blocked: { <reason>: n } } }, cards }
// Nothing here stores an IP address. The tools collect no contact details, so a card says "Anonymous" unless one is given.
import { addLead } from './pipeline.js';
import { londonDay } from './tools-gate.js';

const USAGE = 'admin/tool-usage/';
export const TOOL_NAMES = { 'website-check': 'Website Check', 'google-ads-check': 'Google Ads Check' };
// A ceiling on cards a day across both tools, so a flood that gets past the other checks can't fill the board (2,000 cards).
const MAX_CARDS_PER_DAY = 60;

const blank = () => ({ completed: 0, reused: 0, failed: 0, blocked: {} });

// One change to today's record, retried if another request saved in between.
async function bump(env, change) {
  if (!env.BLOBS) return null;
  const key = USAGE + londonDay() + '.json';
  for (let attempt = 0; attempt < 4; attempt++) {
    const obj = await env.BLOBS.get(key);
    let day = { tools: {}, cards: 0 };
    if (obj) { try { day = await obj.json(); } catch { /* start again */ } }
    day.tools = day.tools || {};
    const out = change(day);
    const ok = await env.BLOBS.put(key, JSON.stringify(day), {
      httpMetadata: { contentType: 'application/json' },
      ...(obj ? { onlyIf: { etagMatches: obj.etag } } : {}), // the day's first write has nothing to race against but itself
    });
    if (ok) return out;
  }
  return null;
}

// what: 'completed' | 'reused' | 'failed' | 'blocked' (with a reason: bot, turnstile, rate, origin, account, daily)
export async function countUse(env, tool, what, reason) {
  try {
    await bump(env, day => {
      const t = day.tools[tool] = { ...blank(), ...(day.tools[tool] || {}) };
      if (what === 'blocked') t.blocked[reason || 'other'] = (t.blocked[reason || 'other'] || 0) + 1;
      else t[what] = (t[what] || 0) + 1;
    });
  } catch (err) { console.error('tool usage', err && err.message); }
}

const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });

// The Lead card for one completed check. lead: { tool, name, website, reportUrl, checked, issues, high, total, contact }
export function leadCard(lead) {
  const tool = TOOL_NAMES[lead.tool] || lead.tool;
  const c = lead.contact || {};
  const contactLine = c.email || c.name ? [c.name, c.email].filter(Boolean).join(', ') : 'Anonymous (the tool asks for none)';
  const about = [
    `Free ${tool} completed on ${DATE.format(new Date(lead.at || Date.now()))}.`,
    '',
    `Checked: ${lead.checked}`,
    `Issues found: ${lead.issues}${lead.high ? ` (${lead.high} to fix first)` : ''}`,
    lead.total ? `Price for every fix in the report: £${lead.total.toLocaleString('en-GB')}` : null,
    `Contact: ${contactLine}`,
    `Report: ${lead.reportUrl}`,
  ].filter(l => l !== null).join('\n');
  return {
    name: lead.name,
    contact: c.name || 'Anonymous',
    email: c.email || '',
    website: lead.website || '',
    source: tool,
    nextStep: c.email ? 'Reply by email' : 'Wait for them to get in touch',
    about,
  };
}

// Makes the card (never for Lewis's own runs), within the daily ceiling. Returns the card id or null; never throws, so a
// board problem can't spoil the visitor's report.
export async function addToolLead(env, access, lead) {
  if (!access || access.admin) return null;
  try {
    const room = await bump(env, day => { if ((day.cards || 0) >= MAX_CARDS_PER_DAY) return false; day.cards = (day.cards || 0) + 1; return true; });
    if (!room) { console.warn('tool leads: daily card ceiling reached'); return null; }
    const card = await addLead(env, leadCard(lead));
    return card && card.id;
  } catch (err) {
    console.error('tool leads: board', err && err.message);
    return null;
  }
}

// Monday (London) of the week a YYYY-MM-DD day falls in.
export function weekOf(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// /admin#site: usage per tool per week, newest first, for the last `weeks` weeks (every week shown, empty ones too).
export async function usageByWeek(env, weeks = 12) {
  const from = new Date(Date.now() - weeks * 7 * 86400000);
  const firstWeek = weekOf(londonDay(from));
  const rows = new Map();
  for (let d = new Date(firstWeek + 'T12:00:00Z'); d <= new Date(); d.setUTCDate(d.getUTCDate() + 7)) {
    const w = d.toISOString().slice(0, 10);
    rows.set(w, { week: w, tools: Object.fromEntries(Object.keys(TOOL_NAMES).map(t => [t, { ...blank() }])), cards: 0 });
  }
  const keys = [];
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: USAGE, cursor });
    for (const o of page.objects) {
      const day = o.key.slice(USAGE.length, -5);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && rows.has(weekOf(day))) keys.push([day, o.key]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await Promise.all(keys.map(async ([day, key]) => {
    const obj = await env.BLOBS.get(key);
    if (!obj) return;
    let rec; try { rec = await obj.json(); } catch { return; }
    const row = rows.get(weekOf(day));
    row.cards += rec.cards || 0;
    for (const [tool, t] of Object.entries(rec.tools || {})) {
      const r = row.tools[tool] = row.tools[tool] || blank();
      r.completed += t.completed || 0; r.reused += t.reused || 0; r.failed += t.failed || 0;
      for (const [why, n] of Object.entries(t.blocked || {})) r.blocked[why] = (r.blocked[why] || 0) + n;
    }
  }));
  return [...rows.values()].sort((a, b) => (a.week < b.week ? 1 : -1));
}
