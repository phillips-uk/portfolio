#!/usr/bin/env node
// Sends a summary of the Obsidian client and prospect folders to the phillips-uk.com admin page.
//   node cloudflare/scripts/sync-clients.mjs            build and upload
//   node cloudflare/scripts/sync-clients.mjs --dry-run  print the summary only
// Summaries go up (key facts, health scores, open tasks, note titles and dates), plus the latest file of each report
// type, each profile, brain dump and prospect note so the admin page can show them. Older files stay in the vault.
// Every item also links back to Obsidian with an obsidian:// address. Runs on a schedule from a launchd agent.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const VAULT = process.env.VAULT || `${process.env.HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Brain`;
const VAULT_NAME = 'My Brain';
const CLIENTS = '03_Clients';
const PROSPECTS = '00_Prospects';
const R2_KEY = 'phillips-blobs/admin/clients-index.json';
const R2_DOCS = 'phillips-blobs/admin/docs.json';
const DOC_MAX = 400 * 1024;
// Never upload a note that looks like it holds a credential.
const SECRET = /shpat_[a-f0-9]{10}|shpss_|sk-ant-|sk-[A-Za-z0-9]{20}|GOCSPX-|AIza[0-9A-Za-z_-]{30}|\bre_[A-Za-z0-9]{20}|xox[bp]-|ghp_[A-Za-z0-9]{20}|-----BEGIN [A-Z ]*PRIVATE KEY/;
const ACCOUNT_ID = '9cd423eee8986ecc6f22f6fa3a17878b';
const LINKED = new Set(['.md', '.pdf']);
const dryRun = process.argv.includes('--dry-run');

// The latest file of each report type, each client profile and brain dump, and each prospect note are copied up so the
// admin page can show them. Older files stay in the vault only.
const docs = {};
function addDoc(rel, docTitle, date) {
  if (!rel.endsWith('.md')) return null;
  const text = readText(join(VAULT, rel));
  if (!text || text.length > DOC_MAX) return null;
  if (SECRET.test(text)) { console.error(`Not uploading ${rel}: it looks like it contains a key or password.`); return null; }
  const id = createHash('sha1').update(rel).digest('hex').slice(0, 16);
  docs[id] = { title: docTitle, date: date || '', path: rel, obsidian: obsidian(rel), markdown: text };
  return id;
}
// Weekly Google Ads, GA4 and Search Console numbers, written by google-ads-automation/client_metrics.py.
const METRICS_FILE = process.env.METRICS_FILE || `${process.env.HOME}/Projects/google-ads-automation/reports/client-metrics.json`;

const obsidian = rel => `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`;
const clean = s => s.replace(/\s+—\s+|\s+–\s+/g, ' · ').replace(/[*_`]/g, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').trim();

function realName(name) {
  // iCloud keeps files it has not downloaded as ".Name.ext.icloud".
  return name.startsWith('.') && name.endsWith('.icloud') ? name.slice(1, -7) : name;
}

function listFiles(dirAbs) {
  let out = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.obsidian') continue;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) { if (!entry.name.startsWith('.')) out = out.concat(listFiles(abs)); continue; }
    const name = realName(entry.name);
    if (name.startsWith('.')) continue;
    out.push({ abs, name, dir: dirAbs });
  }
  return out;
}

function fileDate(f) {
  const m = f.name.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try { return statSync(f.abs).mtime.toISOString().slice(0, 10); } catch { return ''; }
}

function title(name) {
  let t = basename(name, extname(name)).replace(/\d{4}-\d{2}-\d{2}/, '');
  if (/_/.test(t) && !/\s/.test(t.trim())) {
    const words = { ga4: 'GA4', seo: 'SEO', sc: 'Search Console', sqr: 'SQR', lp: 'LP', gtm: 'GTM', ppc: 'PPC', roas: 'ROAS' };
    t = t.split(/_+/).map(w => words[w.toLowerCase()] || w).join(' ');
  }
  t = clean(t).replace(/^[\s·-]+|[\s·-]+$/g, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : basename(name);
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function section(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
}

function tableRows(block) {
  return block.split('\n').filter(l => /^\|/.test(l) && !/^\|\s*-/.test(l)).map(l => l.split('|').slice(1, -1).map(c => clean(c)));
}

function bullets(block, max) {
  return block.split('\n').filter(l => /^\s*[-*] /.test(l)).map(l => clean(l.replace(/^\s*[-*] (\[.\] )?/, ''))).filter(Boolean).slice(0, max);
}

function readText(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

function client(folder) {
  const rel = `${CLIENTS}/${folder}`;
  const abs = join(VAULT, rel);
  const files = listFiles(abs);
  const profilePath = `${rel}/Client Profile.md`;
  const profile = readText(join(VAULT, profilePath));
  const fm = frontmatter(profile);
  const h1 = (profile.match(/^# (.+)$/m) || [])[1] || '';
  const name = clean(h1.replace(/^Client Profile\s*[—–-]\s*/, '')) || folder.replace(/^\d+_/, '');

  const overview = {};
  for (const [k, v] of tableRows(section(profile, 'Overview'))) if (k && v && k !== 'Field') overview[k.toLowerCase()] = v;

  const healthBlock = section(profile, 'Account Health');
  const health = tableRows(healthBlock).filter(r => r[0] && r[0] !== 'Area').map(r => ({ area: r[0], score: r[1] || '', status: r[2] || '' }));
  const overall = (healthBlock.match(/Overall health:\s*([0-9.]+\s*\/\s*10)/i) || [])[1] || '';

  const tasksBlock = section(profile, 'Open Tasks');
  const openTasks = bullets(tasksBlock, 5);
  const openTaskCount = tasksBlock.split('\n').filter(l => /^\s*[-*] /.test(l)).length;

  const groups = new Map();
  for (const f of files) {
    const sub = f.dir === abs ? 'Notes' : f.dir.slice(abs.length + 1).split('/')[0];
    if (f.dir === abs && (f.name === 'Client Profile.md' || f.name === 'Brain Dump.md')) continue;
    if (!groups.has(sub)) groups.set(sub, []);
    groups.get(sub).push(f);
  }
  const sections = [...groups.entries()].map(([sub, list]) => {
    const linked = list.filter(f => LINKED.has(extname(f.name).toLowerCase()) && !/^Invoices$/i.test(sub));
    const items = linked.map(f => {
      const fileRel = `${rel}/${f.dir === abs ? '' : f.dir.slice(abs.length + 1) + '/'}${f.name}`;
      return { title: title(f.name), date: fileDate(f), link: obsidian(fileRel), rel: fileRel };
    }).sort((a, b) => b.date.localeCompare(a.date));
    if (items[0]) items[0].doc = addDoc(items[0].rel, items[0].title, items[0].date);
    items.forEach(it => { delete it.rel; });
    return { name: sub, count: list.length, latestDate: items[0] ? items[0].date : (list.map(fileDate).sort().pop() || ''), items: items.slice(0, 5), private: /^Invoices$/i.test(sub) };
  }).sort((a, b) => (b.latestDate || '').localeCompare(a.latestDate || ''));

  const dates = files.map(fileDate).filter(Boolean).sort();
  return {
    slug: folder.replace(/^\d+_/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name,
    folder,
    status: overview.status || '',
    website: overview.website || '',
    businessType: overview['business type'] || '',
    industry: overview.industry || '',
    profileUpdated: fm.updated || '',
    lastActivity: dates[dates.length - 1] || '',
    overall,
    health,
    openTasks,
    openTaskCount,
    fileCount: files.length,
    sections,
    profileLink: profile ? obsidian(profilePath) : null,
    profileDoc: profile ? addDoc(profilePath, `${name}: client profile`, fm.updated || '') : null,
    brainDumpLink: files.some(f => f.dir === abs && f.name === 'Brain Dump.md') ? obsidian(`${rel}/Brain Dump.md`) : null,
    brainDumpDoc: files.some(f => f.dir === abs && f.name === 'Brain Dump.md') ? addDoc(`${rel}/Brain Dump.md`, `${name}: brain dump`, '') : null,
  };
}

function prospects() {
  const rel = `${CLIENTS}/${PROSPECTS}`;
  let names = [];
  try { names = readdirSync(join(VAULT, rel)); } catch { return []; }
  return names.map(realName).filter(n => n.endsWith('.md') && !n.startsWith('00_')).map(n => {
    const text = readText(join(VAULT, rel, n));
    const fm = frontmatter(text);
    if (fm.type && fm.type !== 'prospect') return null;
    return {
      name: fm.name || basename(n, '.md'),
      stage: fm.stage || 'Lead',
      contact: fm.contact || '',
      introducedBy: fm.introduced_by || '',
      website: fm.website || '',
      markets: fm.markets || '',
      proposal: /^https?:\/\//.test(fm.proposal || '') ? fm.proposal : '',
      rateCardInvite: fm.rate_card_invite || '',
      nextStep: fm.next_step || '',
      nextDate: fm.next_date || '',
      updated: fm.updated || '',
      link: obsidian(`${rel}/${n}`),
      doc: addDoc(`${rel}/${n}`, fm.name || basename(n, '.md'), fm.updated || ''),
    };
  }).filter(Boolean);
}

const clientFolders = readdirSync(join(VAULT, CLIENTS), { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d+_/.test(d.name) && !/^00_/.test(d.name))
  .map(d => d.name).sort();

let metrics = null;
try { metrics = JSON.parse(readFileSync(METRICS_FILE, 'utf8')); } catch { /* no numbers yet */ }

const index = {
  syncedAt: new Date().toISOString(),
  metricsAt: metrics ? metrics.generatedAt : null,
  metricsPeriod: metrics ? metrics.period || null : null,
  clients: clientFolders.map(folder => {
    const c = client(folder);
    const m = metrics && metrics.clients && metrics.clients[folder];
    if (m) c.metrics = { ads: m.ads || null, ga4: m.ga4 || null, gsc: m.gsc || null, errors: m.errors || [] };
    return c;
  }),
  prospects: prospects(),
};

if (dryRun) {
  console.log(JSON.stringify({ ...index, docs: Object.fromEntries(Object.entries(docs).map(([id, d]) => [id, { title: d.title, path: d.path, bytes: d.markdown.length }])) }, null, 2));
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'ph-sync-'));
function upload(key, data) {
  const file = join(tmp, basename(key));
  writeFileSync(file, JSON.stringify(data));
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', key, '--file', file, '--content-type', 'application/json', '--remote'], {
    cwd: join(dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
try {
  upload(R2_DOCS, { syncedAt: index.syncedAt, docs });
  upload(R2_KEY, index);
  console.log(`Synced ${index.clients.length} clients, ${index.prospects.length} prospects and ${Object.keys(docs).length} documents at ${index.syncedAt}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
