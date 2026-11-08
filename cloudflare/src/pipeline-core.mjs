// The sales funnel on /admin (Prospects): shared by the Worker (cloudflare/src/pipeline.js) and the Obsidian sync
// (cloudflare/scripts/sync-clients.mjs), so both merge deals the same way.
//
// A deal is either made in the admin (saved in R2, admin/pipeline.json) or comes from a prospect note in
// 03_Clients/00_Prospects. A note-linked deal is saved to R2 the first time it is edited or moved in the admin.
// From then on each field goes both ways: the side that changed it last wins. The admin stamps every field it changes
// (deal.at[field]); the sync stamps every note field when it first sees a new value (note.fieldAt[field]).
// Comments and files (deal.comments, deal.files) live on the saved deal only; a note card is saved the first time one
// is added. File bytes are in R2 under admin/deal-files/<deal id>/.

// Refining proposal: they have seen it and come back with changes, so it is being reworked before they sign.
export const STAGES = ['Lead', 'Talking', 'Proposal drafted', 'Proposal sent', 'Refining proposal', 'Won', 'Lost'];

// Deal field -> key in the prospect note's details block (frontmatter)
export const NOTE_FIELDS = {
  name: 'name',
  stage: 'stage',
  contact: 'contact',
  role: 'role',
  email: 'email',
  phone: 'phone',
  website: 'website',
  source: 'introduced_by',
  markets: 'markets',
  proposal: 'proposal',
  invite: 'rate_card_invite',
  nextStep: 'next_step',
  nextDate: 'next_date',
};

export const BASES = ['one-off', 'monthly', 'daily'];

export function stageOf(s) {
  const t = String(s || '').trim().toLowerCase();
  return STAGES.find(x => x.toLowerCase() === t) || 'Lead';
}

export const isOpen = stage => !/^(won|lost)$/i.test(stage || '');

const str = v => (v == null ? '' : String(v)).trim();

// Saved deals plus the prospect notes from the latest sync, as one list.
export function mergeDeals(records, notes) {
  records = Array.isArray(records) ? records : [];
  notes = Array.isArray(notes) ? notes : [];
  const byKey = new Map(records.filter(r => r.noteKey).map(r => [r.noteKey, r]));
  const out = [];
  const linked = new Set();
  for (const raw of notes) {
    const n = withFields(raw);
    if (!n) continue;
    linked.add(n.key);
    out.push(fromNote(n, byKey.get(n.key)));
  }
  for (const r of records) {
    if (r.noteKey && linked.has(r.noteKey)) continue;
    out.push({ ...r, saved: true, note: null });
  }
  return out;
}

// Notes synced before the funnel existed carry flat fields and no key; their doc id is the same hash of the path.
function withFields(n) {
  if (!n || !(n.key || n.doc)) return null;
  if (n.key && n.fields) return n;
  return {
    ...n,
    key: n.key || n.doc,
    fields: n.fields || {
      name: n.name, stage: n.stage, contact: n.contact, website: n.website, source: n.introducedBy, markets: n.markets,
      proposal: n.proposal, invite: n.rateCardInvite, nextStep: n.nextStep, nextDate: n.nextDate,
    },
  };
}

function fromNote(n, r) {
  const d = r
    ? { ...r, saved: true }
    : { id: 'n_' + n.key, noteKey: n.key, saved: false, about: '', pricing: 'all', values: [], history: [], rank: null, createdAt: n.updated || '', updatedAt: '' };
  const fields = n.fields || {};
  for (const f of Object.keys(NOTE_FIELDS)) {
    const noteAt = (n.fieldAt && n.fieldAt[f]) || n.updated || '';
    const recAt = (r && r.at && r.at[f]) || '';
    const useRecord = r && recAt && recAt > noteAt;
    d[f] = useRecord ? str(r[f]) : str(fields[f]);
  }
  d.stage = stageOf(d.stage);
  d.note = { key: n.key, doc: n.doc || null, link: n.link || '', title: n.title || n.name || '', updated: n.updated || '' };
  return d;
}

// The fees that count towards totals: all of them, or the expected one when the client picks one option.
export function countedFees(d) {
  const fees = Array.isArray(d.values) ? d.values.filter(v => Number(v.amount) > 0) : [];
  if (d.pricing !== 'choose' || fees.length < 2) return fees;
  return [fees.find(v => v.expected) || fees[0]];
}

// One-off total (day rates times days count here), monthly total, and day rates with no number of days.
export function dealTotals(d) {
  const t = { oneOff: 0, monthly: 0, openDays: 0 };
  for (const v of countedFees(d)) {
    const amount = Number(v.amount) || 0;
    const qty = Number(v.qty) || 0;
    if (v.basis === 'monthly') t.monthly += amount;
    else if (v.basis === 'daily') { if (qty > 0) t.oneOff += amount * qty; else t.openDays += 1; }
    else t.oneOff += amount;
  }
  return t;
}
