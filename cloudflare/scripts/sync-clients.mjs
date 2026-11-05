#!/usr/bin/env node
// Sends a summary of the Obsidian client and prospect folders to the phillips-uk.com admin page.
//   node cloudflare/scripts/sync-clients.mjs            build and upload
//   node cloudflare/scripts/sync-clients.mjs --dry-run  print the summary only
// Only summaries go up (key facts, health scores, open tasks, note titles and dates). Full notes stay in the vault,
// and every item links back to Obsidian with an obsidian:// address. Runs on a schedule from a launchd agent.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const VAULT = process.env.VAULT || `${process.env.HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Brain`;
const VAULT_NAME = 'My Brain';
const CLIENTS = '03_Clients';
const PROSPECTS = '00_Prospects';
const R2_KEY = 'phillips-blobs/admin/clients-index.json';
const ACCOUNT_ID = '9cd423eee8986ecc6f22f6fa3a17878b';
const LINKED = new Set(['.md', '.pdf']);
const dryRun = process.argv.includes('--dry-run');

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
      return { title: title(f.name), date: fileDate(f), link: obsidian(fileRel) };
    }).sort((a, b) => b.date.localeCompare(a.date));
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
    brainDumpLink: files.some(f => f.dir === abs && f.name === 'Brain Dump.md') ? obsidian(`${rel}/Brain Dump.md`) : null,
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
    };
  }).filter(Boolean);
}

const clientFolders = readdirSync(join(VAULT, CLIENTS), { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d+_/.test(d.name) && !/^00_/.test(d.name))
  .map(d => d.name).sort();

const index = {
  syncedAt: new Date().toISOString(),
  clients: clientFolders.map(client),
  prospects: prospects(),
};

if (dryRun) {
  console.log(JSON.stringify(index, null, 2));
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'ph-sync-'));
const file = join(tmp, 'clients-index.json');
writeFileSync(file, JSON.stringify(index));
try {
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', R2_KEY, '--file', file, '--content-type', 'application/json', '--remote'], {
    cwd: join(dirname(new URL(import.meta.url).pathname), '..', '..'),
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  console.log(`Synced ${index.clients.length} clients and ${index.prospects.length} prospects at ${index.syncedAt}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
