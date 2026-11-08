// The sales funnel on /admin (Prospects tab): deals saved in R2 at admin/pipeline.json, merged with the prospect notes
// from the latest Obsidian sync. Merge rules live in pipeline-core.mjs. Only reached after the admin session check.
import { STAGES, NOTE_FIELDS, BASES, mergeDeals, stageOf } from './pipeline-core.mjs';

const KEY = 'admin/pipeline.json';
const INDEX = 'admin/clients-index.json';
const MAX_DEALS = 2000;

const TEXT_MAX = { name: 120, contact: 120, role: 80, email: 160, phone: 40, website: 200, source: 120, markets: 160, proposal: 500, invite: 80, nextStep: 200 };

class BadInput extends Error {}

async function loadRecords(env) {
  const obj = await env.BLOBS.get(KEY);
  if (!obj) return { data: { deals: [] }, etag: null };
  let data;
  try { data = await obj.json(); } catch { data = null; }
  if (!data || !Array.isArray(data.deals)) throw new Error('The saved funnel could not be read.');
  return { data, etag: obj.etag };
}

async function loadNotes(env) {
  const obj = await env.BLOBS.get(INDEX);
  if (!obj) return { notes: [], syncedAt: null };
  const index = await obj.json();
  return { notes: index.prospects || [], syncedAt: index.syncedAt || null };
}

// Read, change and write back, retrying if another tab saved in between.
async function mutate(env, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, etag } = await loadRecords(env);
    const result = await change(data);
    data.updatedAt = new Date().toISOString();
    const put = await env.BLOBS.put(KEY, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    });
    if (put) return result;
  }
  throw new Error('Someone else saved at the same moment. Try again.');
}

const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanFees(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((v, i) => {
    const amount = Math.round(Math.max(0, Math.min(10000000, Number(v && v.amount) || 0)) * 100) / 100;
    const qty = Math.round(Math.max(0, Math.min(1000, Number(v && v.qty) || 0)));
    return {
      id: v && typeof v.id === 'string' && /^[a-z0-9]{4,12}$/.test(v.id) ? v.id : 'f' + i + Math.random().toString(36).slice(2, 7),
      label: oneLine(v && v.label, 120),
      amount,
      basis: BASES.includes(v && v.basis) ? v.basis : 'one-off',
      qty: qty || null,
      expected: !!(v && v.expected),
    };
  }).filter(v => v.label || v.amount);
}

// Only the fields sent are checked and returned.
function cleanFields(body) {
  const out = {};
  for (const f of Object.keys(TEXT_MAX)) if (f in body) out[f] = oneLine(body[f], TEXT_MAX[f]);
  if ('stage' in body) {
    if (!STAGES.includes(body.stage)) throw new BadInput('That stage is not on the board.');
    out.stage = body.stage;
  }
  if ('about' in body) out.about = String(body.about == null ? '' : body.about).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 6000);
  if ('nextDate' in body) {
    out.nextDate = String(body.nextDate || '');
    if (out.nextDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.nextDate)) throw new BadInput('The next step date is not a date.');
  }
  if ('pricing' in body) out.pricing = body.pricing === 'choose' ? 'choose' : 'all';
  if ('values' in body) out.values = cleanFees(body.values);
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new BadInput('That email address does not look right.');
  if (out.proposal && !/^https?:\/\/\S+$/i.test(out.proposal)) throw new BadInput('The proposal link has to start with https://');
  if ('name' in out && !out.name) throw new BadInput('Add the company or person.');
  return out;
}

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return 'd_' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

const same = (a, b) => JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b);

// Apply changed fields to a saved deal, stamping each one so the merge with the note knows the admin changed it last.
function apply(rec, current, fields, now) {
  rec.at = rec.at || {};
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  for (const [f, v] of Object.entries(fields)) {
    if (same(current[f], v)) continue;
    if (f === 'stage') rec.history.push({ at: now, from: current.stage || null, to: v });
    rec[f] = v;
    if (f in NOTE_FIELDS) rec.at[f] = now;
  }
  rec.updatedAt = now;
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

async function withInvites(env, deals, invite) {
  const cache = new Map();
  for (const d of deals) {
    if (!d.invite) { d.rateCard = null; continue; }
    if (!cache.has(d.invite)) cache.set(d.invite, await invite(d.invite));
    d.rateCard = cache.get(d.invite);
  }
  return deals;
}

async function listDeals(env, invite) {
  const [{ data }, { notes, syncedAt }] = await Promise.all([loadRecords(env), loadNotes(env)]);
  const deals = mergeDeals(data.deals, notes);
  return { deals: await withInvites(env, deals, invite), syncedAt, savedAt: data.updatedAt || null };
}

async function createDeal(env, input, invite) {
  const fields = cleanFields(input);
  if (!fields.name) throw new BadInput('Add the company or person.');
  const now = new Date().toISOString();
  const deal = await mutate(env, data => {
    if (data.deals.length >= MAX_DEALS) throw new BadInput('The funnel is full. Delete some old lost deals first.');
    const stage = fields.stage || 'Lead';
    const inStage = data.deals.filter(d => stageOf(d.stage) === stage && typeof d.rank === 'number');
    const rec = {
      id: newId(), noteKey: null, name: '', contact: '', role: '', email: '', phone: '', website: '', source: '', markets: '',
      proposal: '', invite: '', nextStep: '', nextDate: '', about: '', pricing: 'all', values: [],
      ...fields, stage,
      rank: typeof input.rank === 'number' && isFinite(input.rank) ? input.rank : (inStage.length ? Math.min(...inStage.map(d => d.rank)) - 1 : 0),
      createdAt: now, updatedAt: now, at: {}, history: [{ at: now, from: null, to: stage }],
    };
    data.deals.push(rec);
    return rec;
  });
  const [merged] = await withInvites(env, [{ ...deal, saved: true, note: null }], invite);
  return merged;
}

async function updateDeal(env, id, input, invite) {
  const fields = cleanFields(input);
  const rank = typeof input.rank === 'number' && isFinite(input.rank) ? input.rank : undefined;
  const { notes } = await loadNotes(env);
  const now = new Date().toISOString();
  const saved = await mutate(env, data => {
    const merged = mergeDeals(data.deals, notes);
    const current = merged.find(d => d.id === id);
    if (!current) throw new BadInput('That card is no longer on the board.');
    let rec = data.deals.find(d => d.id === id);
    if (!rec) {
      // A note-only card, saved for the first time: keep what the note says now, then apply the change.
      const { saved: _s, note: _n, rateCard: _r, ...base } = current;
      rec = { ...base, id: newId(), createdAt: current.createdAt || now, at: {}, history: [] };
      data.deals.push(rec);
    }
    apply(rec, current, fields, now);
    if (rank !== undefined) rec.rank = rank;
    return rec.id;
  });
  const out = await listDeals(env, invite);
  return out.deals.find(d => d.id === saved);
}

async function deleteDeal(env, id) {
  const { notes } = await loadNotes(env);
  const linked = new Set(notes.map(n => n.key || n.doc));
  await mutate(env, data => {
    const rec = data.deals.find(d => d.id === id);
    if (!rec) throw new BadInput('That card is no longer on the board.');
    if (rec.noteKey && linked.has(rec.noteKey)) throw new BadInput('This card comes from an Obsidian note. Move it to Lost instead, or delete the note.');
    data.deals = data.deals.filter(d => d.id !== id);
  });
  return { ok: true };
}

// Routes under /admin/api/deals. `invite` turns an invite token into its public summary (or null).
export async function deals(request, path, env, headers, invite) {
  const method = request.method;
  try {
    if (path === '/admin/api/deals' && method === 'GET') return json(await listDeals(env, invite), 200, headers);
    if (path === '/admin/api/deals' && method === 'POST') return json(await createDeal(env, await body(request), invite), 201, headers);
    const m = path.match(/^\/admin\/api\/deals\/([a-z]_[a-f0-9]{16})(\/delete)?$/);
    if (m && method === 'POST' && m[2]) return json(await deleteDeal(env, m[1]), 200, headers);
    if (m && method === 'POST') return json(await updateDeal(env, m[1], await body(request), invite), 200, headers);
    return json({ error: 'Not found' }, 404, headers);
  } catch (err) {
    if (err instanceof BadInput) return json({ error: err.message }, 400, headers);
    console.error('pipeline error', err && err.message);
    return json({ error: err && err.message ? err.message : 'Something went wrong. Try again.' }, 500, headers);
  }
}
