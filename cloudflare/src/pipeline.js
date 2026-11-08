// The sales funnel on /admin (Prospects tab): deals saved in R2 at admin/pipeline.json, merged with the prospect notes
// from the latest Obsidian sync. Merge rules live in pipeline-core.mjs. Only reached after the admin session check.
// Each card can also carry comments and files (uploads or links). Upload bytes go to R2 under FILE_PREFIX/<deal id>/.
import { STAGES, NOTE_FIELDS, BASES, mergeDeals, stageOf } from './pipeline-core.mjs';

const KEY = 'admin/pipeline.json';
const INDEX = 'admin/clients-index.json';
const MAX_DEALS = 2000;
const FILE_PREFIX = 'admin/deal-files/';
const FILE_MAX = 20 * 1024 * 1024; // keep in step with FILE_MAX in cloudflare/private/admin.html
const MAX_FILES = 40;
const MAX_COMMENTS = 300;
const COMMENT_MAX = 4000;
// Shown in the browser. Anything else downloads, so an uploaded web page or SVG never runs on this site.
const INLINE = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'];

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

function hex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), x => x.toString(16).padStart(2, '0')).join('');
}
const newId = () => 'd_' + hex(8);

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

// The saved deal behind a card, and the card as the board shows it. A note-only card is saved here for the first time,
// keeping what the note says now.
function recordFor(data, notes, id, now) {
  const current = mergeDeals(data.deals, notes).find(d => d.id === id);
  if (!current) throw new BadInput('That card is no longer on the board.');
  let rec = data.deals.find(d => d.id === id);
  if (!rec) {
    const { saved: _s, note: _n, rateCard: _r, ...base } = current;
    rec = { ...base, id: newId(), createdAt: current.createdAt || now, at: {}, history: [] };
    data.deals.push(rec);
  }
  return { rec, current };
}

async function cardById(env, id, invite) {
  const out = await listDeals(env, invite);
  return out.deals.find(d => d.id === id);
}

async function updateDeal(env, id, input, invite) {
  const fields = cleanFields(input);
  const rank = typeof input.rank === 'number' && isFinite(input.rank) ? input.rank : undefined;
  const { notes } = await loadNotes(env);
  const now = new Date().toISOString();
  const saved = await mutate(env, data => {
    const { rec, current } = recordFor(data, notes, id, now);
    apply(rec, current, fields, now);
    if (rank !== undefined) rec.rank = rank;
    return rec.id;
  });
  return cardById(env, saved, invite);
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
  await deleteStored(env, id);
  return { ok: true };
}

async function deleteStored(env, id) {
  let cursor;
  do {
    const page = await env.BLOBS.list({ prefix: FILE_PREFIX + id + '/', cursor });
    if (page.objects.length) await env.BLOBS.delete(page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/* ---------- comments ---------- */

function cleanComment(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, COMMENT_MAX);
  if (!t) throw new BadInput('Write the comment first.');
  return t;
}

// Change one card's saved record (saving a note card first) and return the card as the board shows it.
// Throwing inside `change` stops the write.
async function changeCard(env, id, invite, change) {
  const { notes } = await loadNotes(env);
  const now = new Date().toISOString();
  const saved = await mutate(env, async data => {
    const { rec } = recordFor(data, notes, id, now);
    await change(rec, now);
    rec.updatedAt = now;
    return rec.id;
  });
  return cardById(env, saved, invite);
}

function commentsOf(rec) {
  if (!Array.isArray(rec.comments)) rec.comments = [];
  return rec.comments;
}

const addComment = (env, id, input, invite, who) => changeCard(env, id, invite, (rec, now) => {
  const text = cleanComment(input.text);
  const list = commentsOf(rec);
  if (list.length >= MAX_COMMENTS) throw new BadInput('This card holds as many comments as it can. Delete some old ones first.');
  list.push({ id: 'c' + hex(6), at: now, by: who || '', text });
});

const editComment = (env, id, cid, input, invite) => changeCard(env, id, invite, (rec, now) => {
  const c = commentsOf(rec).find(x => x.id === cid);
  if (!c) throw new BadInput('That comment has been deleted.');
  c.text = cleanComment(input.text);
  c.editedAt = now;
});

const deleteComment = (env, id, cid, invite) => changeCard(env, id, invite, rec => {
  rec.comments = commentsOf(rec).filter(x => x.id !== cid);
});

/* ---------- files and links ---------- */

function filesOf(rec, adding) {
  if (!Array.isArray(rec.files)) rec.files = [];
  if (adding && rec.files.length >= MAX_FILES) throw new BadInput('This card holds as many files as it can. Remove one first.');
  return rec.files;
}

const addLink = (env, id, input, invite, who) => changeCard(env, id, invite, (rec, now) => {
  const url = oneLine(input.url, 500);
  let host = '';
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) host = u.host; } catch { /* not a link */ }
  if (!host || !/^https?:\/\//i.test(url)) throw new BadInput('The link has to start with https://');
  const name = oneLine(input.name, 120) || url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  filesOf(rec, true).push({ id: 'a' + hex(8), kind: 'link', name, url, at: now, by: who || '' });
});

function cleanFileName(name) {
  name = String(name || '').replace(/[\u0000-\u001f\u007f\\/:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length > 140) {
    const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
    name = name.slice(0, 140 - ext.length).trim() + ext;
  }
  return name || 'File';
}

function cleanType(type) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t) ? t : 'application/octet-stream';
}

// The raw file is the request body; its name comes in X-File-Name (URI-encoded).
async function uploadFile(env, id, request, invite, who) {
  const tooBig = 'That file is over 20 MB. Add a link to it instead.';
  if (Number(request.headers.get('Content-Length') || 0) > FILE_MAX) throw new BadInput(tooBig);
  let name = '';
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); } catch { /* keep the default */ }
  name = cleanFileName(name);
  const type = cleanType(request.headers.get('Content-Type'));
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new BadInput('That file is empty.');
  if (bytes.byteLength > FILE_MAX) throw new BadInput(tooBig);

  // The file is stored under the saved deal's id, so a note-only card is saved first.
  const now = new Date().toISOString();
  const { data } = await loadRecords(env);
  let recId = id;
  const existing = data.deals.find(d => d.id === id);
  if (existing) filesOf({ files: existing.files }, true);
  else {
    const { notes } = await loadNotes(env);
    recId = await mutate(env, d => recordFor(d, notes, id, now).rec.id);
  }
  const fileId = 'a' + hex(8);
  const key = FILE_PREFIX + recId + '/' + fileId;
  await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await mutate(env, d => {
      const rec = d.deals.find(x => x.id === recId);
      if (!rec) throw new BadInput('That card is no longer on the board.');
      filesOf(rec, true).push({ id: fileId, kind: 'file', name, type, size: bytes.byteLength, at: now, by: who || '' });
      rec.updatedAt = now;
    });
  } catch (err) {
    await env.BLOBS.delete(key).catch(() => {});
    throw err;
  }
  return cardById(env, recId, invite);
}

async function removeFile(env, id, fid, invite) {
  const now = new Date().toISOString();
  let gone = null;
  await mutate(env, data => {
    const rec = data.deals.find(d => d.id === id);
    if (!rec) throw new BadInput('That card is no longer on the board.');
    gone = filesOf(rec).find(f => f.id === fid) || null;
    rec.files = filesOf(rec).filter(f => f.id !== fid);
    rec.updatedAt = now;
  });
  if (gone && gone.kind === 'file') {
    await env.BLOBS.delete(FILE_PREFIX + id + '/' + fid).catch(err => console.error('file delete failed', err && err.message));
  }
  return cardById(env, id, invite);
}

const rfc5987 = s => encodeURIComponent(s).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function getFile(env, id, fid, headers) {
  const { data } = await loadRecords(env);
  const rec = data.deals.find(d => d.id === id);
  const f = rec && filesOf({ files: rec.files }).find(x => x.id === fid && x.kind === 'file');
  if (!f) return json({ error: 'That file is no longer on the card.' }, 404, headers);
  const obj = await env.BLOBS.get(FILE_PREFIX + id + '/' + fid);
  if (!obj) return json({ error: 'That file could not be found.' }, 404, headers);
  const inline = INLINE.includes(f.type);
  const h = new Headers(headers);
  h.set('Content-Type', f.type === 'text/plain' ? 'text/plain; charset=utf-8' : f.type);
  h.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${rfc5987(f.name)}`);
  h.set('Content-Length', String(obj.size));
  h.set('X-Content-Type-Options', 'nosniff');
  // PDFs need the browser's own viewer; everything else is shown, if at all, with scripts switched off.
  if (f.type !== 'application/pdf') h.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  return new Response(obj.body, { headers: h });
}

// Routes under /admin/api/deals. `invite` turns an invite token into its public summary (or null); `who` is the
// signed-in admin email, kept on comments and files.
const CARD_PATH = /^\/admin\/api\/deals\/([a-z]_[a-f0-9]{16})(?:\/(delete|comments|links|files)(?:\/([a-z][a-f0-9]{12,16})(\/delete)?)?)?$/;

export async function deals(request, path, env, headers, invite, who) {
  const method = request.method;
  try {
    if (path === '/admin/api/deals' && method === 'GET') return json(await listDeals(env, invite), 200, headers);
    if (path === '/admin/api/deals' && method === 'POST') return json(await createDeal(env, await body(request), invite), 201, headers);
    const m = path.match(CARD_PATH);
    if (!m) return json({ error: 'Not found' }, 404, headers);
    const [, id, part, sub, del] = m;
    if (method === 'GET' && part === 'files' && sub && !del) return getFile(env, id, sub, headers);
    if (method !== 'POST') return json({ error: 'Not found' }, 404, headers);
    if (!part) return json(await updateDeal(env, id, await body(request), invite), 200, headers);
    if (part === 'delete' && !sub) return json(await deleteDeal(env, id), 200, headers);
    if (part === 'comments' && !sub) return json(await addComment(env, id, await body(request), invite, who), 201, headers);
    if (part === 'comments' && sub && !del) return json(await editComment(env, id, sub, await body(request), invite), 200, headers);
    if (part === 'comments' && sub && del) return json(await deleteComment(env, id, sub, invite), 200, headers);
    if (part === 'links' && !sub) return json(await addLink(env, id, await body(request), invite, who), 201, headers);
    if (part === 'files' && !sub) return json(await uploadFile(env, id, request, invite, who), 201, headers);
    if (part === 'files' && sub && del) return json(await removeFile(env, id, sub, invite), 200, headers);
    return json({ error: 'Not found' }, 404, headers);
  } catch (err) {
    if (err instanceof BadInput) return json({ error: err.message }, 400, headers);
    console.error('pipeline error', err && err.message);
    return json({ error: err && err.message ? err.message : 'Something went wrong. Try again.' }, 500, headers);
  }
}
