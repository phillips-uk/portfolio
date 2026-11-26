#!/usr/bin/env node
// check-v5-system.cjs: measures every "plain and proven" page (body.v5) in a real browser at 1440, 768 and 375 and fails if
// anything is off the spacing and type system or the type scale (Obsidian note 146) or the V4 page rules (note 145: word
// budget, a picture every two screens, the action in the hero, one heading per section, no eyebrows) or the one pattern
// library (Obsidian 147: the home and For tradespeople sections are the only section designs). Lewis 24 Nov 2026.
// Phillips Group copy (25 Nov 2026), from Before You Pay main 6f444df041; this is the phillips-uk.com copy (26 Nov 2026).
// Changed only where the playbook says: the page finder and the server (this site's pages are *.html and */index.html at
// the repo root, served from the root; the Worker-served tool templates map to their addresses, TEMPLATES below, and are
// found by the script that adds v5 to their bare <body>, which the Worker writes attributes onto), and the
// header button selector (the group header .vhd .vb as well as BYP's nav#site-nav .btn). SYS is unchanged.
// Run it before showing Lewis a design built in code and before every deploy of v5 pages:
//   node scripts/check-v5-system.cjs            every v5 page
//   node scripts/check-v5-system.cjs index.html privacy/index.html
// Uses this Mac's Google Chrome, headless, through its DevTools protocol: no packages, no cost. Exit code 1 on any finding.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WEB = ROOT;   // what the Worker serves (Workers Assets, the repo root)
// The tool pages are Worker templates in cloudflare/private/: their address, and the file the check serves for it
const TEMPLATES = { '/google-ads-audit': 'cloudflare/private/google-ads-check.html', '/website-check/': 'cloudflare/private/website-check.html', '/account/': 'cloudflare/private/account.html' };
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── the system, in one place (keep in step with note 146 and .design/system.md) ──
const SYS = {
  section: { desk: 120, tab: 96, phone: 64 },
  tight: { desk: 72, tab: 72, phone: 56 },
  hero: { desk: [88, 104], tab: [56, 72], phone: [36, 40] },
  heroDeeper: { desk: [48, 88], tab: [48, 88], phone: [28, 56] },
  h1: { home: 60, other: 52, phone: 34 },
  h2: { desk: 48, panel: 40, phone: 28 },
  strip: { desk: 32, tab: 28, phone: 24 },
  button: 48, headerButton: 40,
  faq: { pad: 24, desk: 19, phone: 17 },
  card: { desk: 32, phone: 24 },
  minText: 12,
  // type scale (note 146, 24 Nov 2026): the only text sizes allowed; tablet is fluid and not checked
  scale: { desk: [60, 52, 48, 40, 32, 22, 21, 19, 17, 15, 14, 13], phone: [34, 28, 24, 19, 18, 17, 16, 14, 13] },
  // V4 page rules (note 145): about 60 visible words a phone screen, a picture every two screens
  words: { phone: 60, desk: 90 }, screen: { phone: 812, desk: 900 },
};
const WIDTHS = [1440, 768, 375];

function pages() {
  const args = process.argv.slice(2);
  if (args.length) return args;
  const files = execSync(`grep -rlE --include='*.html' '<body class="([a-z0-9 -]* )?v5( [a-z0-9 -]*)?"|classList\\.add\\(.v5.\\)' "${ROOT}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude --exclude-dir=_design --exclude-dir=.wrangler || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(f => path.relative(ROOT, f));
  return files.filter(f => !f.startsWith('cloudflare/') || Object.values(TEMPLATES).includes(f));
}

function serve() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    let f = TEMPLATES[p] ? path.join(ROOT, TEMPLATES[p]) : path.join(WEB, p);
    if (!f.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch { if (fs.existsSync(f + '.html')) f += '.html'; }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(buf);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function chrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5check-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  // Up to 90s: a busy Mac took about 30s to start Chrome on 26 Nov 2026; the check carries on as soon as Chrome is ready.
  for (let i = 0; i < 900 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  if (!fs.existsSync(portFile)) { proc.kill(); throw new Error('headless Chrome did not start within 90 seconds: the Mac may be very busy, try again shortly'); }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageT = list.find(t => t.type === 'page');
  const ws = new WebSocket(pageT.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const wait = new Map(), events = [];
  ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } else if (d.method) events.push(d.method); });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  return { send, events, close: () => { try { ws.close(); } catch {} proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} } };
}

// Runs inside the page. Returns a list of findings.
const AUDIT = async (SYS) => {
  // load every image first, lazy or not, so pictures are measured at their real size
  await Promise.all([...document.images].map(i => { i.loading = 'eager'; return i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 3000); }); }));
  const W = innerWidth, size = W < 761 ? 'phone' : W <= 960 ? 'tab' : 'desk', out = [];
  const px = v => Math.round(parseFloat(v)), near = (a, b) => Math.abs(a - b) <= 1;
  // folded text (inside a closed <details>, outside its summary) is not on screen, whatever offsetParent says
  const vis = el => (el.offsetParent !== null || getComputedStyle(el).position === 'fixed') && !(el.closest('details:not([open])') && !el.closest('summary'));
  const where = el => (el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : el.tagName.toLowerCase()).slice(0, 40);
  if (document.documentElement.scrollWidth > W + 1) out.push(`sideways scroll: page is ${document.documentElement.scrollWidth}px wide`);
  // sections
  // a form step (section.step) is one screen of a form, not a page section: the form page sets its spacing
  const secs = [...document.querySelectorAll('main > section, main > header')].filter(vis).filter(s => !s.matches('.step'));
  for (const s of secs) {
    const cs = getComputedStyle(s), t = px(cs.paddingTop), b = px(cs.paddingBottom);
    let want;
    if (s.matches('.vh')) want = (s.matches('.vd-hero') ? SYS.heroDeeper : SYS.hero)[size];
    else if (s.matches('.tight')) want = [SYS.tight[size], SYS.tight[size]];
    else if (s.matches('.vp-sec')) want = [s.matches('.vp-gap') ? (size === 'phone' ? 48 : SYS.section[size]) : 0, size === 'phone' ? 0 : SYS.section[size]];
    else want = [SYS.section[size], SYS.section[size]];
    if (!near(t, want[0]) || !near(b, want[1])) out.push(`section ${where(s)}: spacing ${t}/${b}, system says ${want[0]}/${want[1]}`);
  }
  // neighbouring sections change background (a tinted panel inside a section counts as the change)
  const bg = el => { let c = getComputedStyle(el).backgroundColor; return c === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : c; };
  for (let i = 1; i < secs.length; i++) if (bg(secs[i]) === bg(secs[i - 1]) && ![secs[i], secs[i - 1]].some(x => x.querySelector('.vp') || x.matches('.vp-sec'))) out.push(`sections ${where(secs[i - 1])} and ${where(secs[i])} share a background`);
  // a wash panel straight after the hero or a section of another colour needs its own space above it (.vp-gap), or it sits on that section (Lewis, 26 Nov 2026, on every site)
  for (let i = 1; i < secs.length; i++) if (secs[i].matches('.vp-sec') && !secs[i].matches('.vp-gap') && bg(secs[i]) !== bg(secs[i - 1])) out.push(`panel ${where(secs[i])} sits straight on ${where(secs[i - 1])}: add .vp-gap for space above it`);
  // neighbouring sections never share a layout (Lewis, 26 Nov 2026: "everything is very left to right ... it needs a bit of
  // visual diversity, especially the ones next to each other"). Heading-left splits, FAQs and the contact form are one
  // family; a mirrored split (.vf-grid.flip), a stacked FAQ (.vq.stack), panels, and each grid (trio, cards, figures) are
  // their own. Reading sections (legal pages, guide text) are left out.
  { const layout = s => { if (s.matches('[data-reading]') && !s.querySelector('.vq')) return null;
      if (s.querySelector('.vp')) return s.querySelector('.vp.rev') ? 'panel, picture first' : 'panel';
      const g = s.querySelector('.vf-grid'), q = s.querySelector('.vq');
      if (g && g.matches('.flip')) return 'mirrored split'; if (q && q.matches('.stack')) return 'stacked';
      if (g || q || s.id === 'contact') return 'heading left, content right';
      const k = ['.vm', '.vcards', '.vco-grid', '.vfigs', '.vt'].find(c => s.querySelector(c)); return k ? 'grid ' + k : null; };
    for (let i = 1; i < secs.length; i++) { const a = layout(secs[i - 1]), b = layout(secs[i]);
      if (a && a === b) out.push(`sections ${where(secs[i - 1])} and ${where(secs[i])} share a layout (${a}): neighbours differ`); } }
  // headings
  const h1 = document.querySelector('main h1');
  if (h1 && !h1.closest('.vdone, .card-msg')) { const want = size === 'phone' ? SYS.h1.phone : size === 'tab' ? null : (h1.closest('.vd-hero, .bg-brand, .vform-page, .funnel') ? SYS.h1.other : SYS.h1.home); const f = px(getComputedStyle(h1).fontSize); if (want && !near(f, want)) out.push(`h1 is ${f}px, system says ${want}`); }
  if (size !== 'tab') for (const h of [...document.querySelectorAll('main .v-h2')].filter(vis)) { const want = size === 'phone' ? SYS.h2.phone : h.closest('.vp') ? SYS.h2.panel : SYS.h2.desk; const f = px(getComputedStyle(h).fontSize); if (!near(f, want)) out.push(`heading "${h.textContent.trim().slice(0, 30)}" is ${f}px, system says ${want}`); }
  for (const p of [...document.querySelectorAll('.vt > p, .vd-strip-h')].filter(vis)) { const want = SYS.strip[size]; const f = px(getComputedStyle(p).fontSize); if (!near(f, want)) out.push(`strip text is ${f}px, system says ${want}`); }
  // buttons
  for (const b of [...document.querySelectorAll('main .vb')].filter(vis)) { const h = Math.round(b.getBoundingClientRect().height); if (!near(h, SYS.button)) out.push(`button "${b.textContent.trim().slice(0, 24)}" is ${h}px tall, system says ${SYS.button}`); }
  const nb = document.querySelector('nav#site-nav .btn, .vhd .vb'); if (nb) { const h = Math.round(nb.getBoundingClientRect().height); if (!near(h, SYS.headerButton)) out.push(`header button is ${h}px tall, system says ${SYS.headerButton}`); }
  // FAQ
  for (const d of [...document.querySelectorAll('.vq details')].filter(vis)) { const p = px(getComputedStyle(d).paddingTop), f = px(getComputedStyle(d.querySelector('summary')).fontSize), want = size === 'phone' ? SYS.faq.phone : SYS.faq.desk; if (p !== SYS.faq.pad || (size !== 'tab' && !near(f, want))) { out.push(`FAQ row padding ${p}, question ${f}px; system says ${SYS.faq.pad} and ${want}`); break; } }
  // cards
  if (size !== 'tab') for (const c of [...document.querySelectorAll('.vd-card')].filter(vis)) { const p = px(getComputedStyle(c).paddingTop); if (p !== SYS.card[size]) { out.push(`card padding ${p}, system says ${SYS.card[size]}`); break; } }
  // smallest text
  const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) { if (!n.textContent.trim() || !n.parentElement || !vis(n.parentElement)) continue; const f = parseFloat(getComputedStyle(n.parentElement).fontSize); if (f < SYS.minText) { out.push(`text "${n.textContent.trim().slice(0, 24)}" is ${f}px, below ${SYS.minText}`); break; } }
  // ── V4 page rules and the type scale (Lewis, 24 Nov 2026: "everything gets checked for consistency to our design rules") ──
  const main = document.querySelector('main') || document.body;
  // legal pages, and form pages (data-page="form": tasks, like the Figma "BYP Form" frames) are exempt from the hero photo,
  // word and picture rules (batch 5, 24 Nov 2026)
  const legal = document.body.dataset.page === 'legal' || document.body.dataset.page === 'form';
  const drawn = el => { const r = el.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) return true; return !!el.closest('figure:not(figcaption), [data-drawing], [aria-hidden="true"]') && !el.closest('figcaption'); };
  if (size !== 'tab') {
    const off = {}; const tw = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) { const el = n.parentElement; if (!n.textContent.trim() || !el || !vis(el) || drawn(el)) continue;
      const z = Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2; if (!SYS.scale[size].includes(z)) (off[z] = off[z] || []).push(n.textContent.trim().slice(0, 18)); }
    for (const [z, l] of Object.entries(off)) out.push(`size ${z}px is off the type scale (${l.length}×, e.g. "${l[0]}")`);
  }
  // the action lives in the hero
  const hero = main.querySelector(':scope > .vh, :scope > header.vh, :scope > section.vh');
  if (hero && !legal && !hero.querySelector('a.vb, button.vb, form, .vd-search')) out.push('hero has no action: the main button belongs in the hero');
  // one job per section, and no small label above a heading (the retired eyebrow)
  for (const s of secs) { const hs = [...s.querySelectorAll('.v-h2')].filter(vis); if (hs.length > 1) out.push(`section ${where(s)}: ${hs.length} section headings, one job per section`); }
  for (const h of [...main.querySelectorAll('h1, .v-h2')].filter(vis)) { const p = h.previousElementSibling;
    if (p && vis(p) && !p.matches('.vd-crumb, nav') && p.textContent.trim() && parseFloat(getComputedStyle(p).fontSize) <= 15) out.push(`small label "${p.textContent.trim().slice(0, 20)}" above a heading (no eyebrows)`); }
  // ── one pattern library (Lewis 24 Nov 2026: "check if the rest of the pages follow the exact same design protocol";
  // Obsidian 147). The home and For tradespeople pages are the baseline; every other page reuses their sections. ──
  const isStone = el => el.matches('.bg-stone');
  if (hero && !legal) {
    // record pages (profiles, the example report; body data-page="record", batch 6): the record is the picture, so the hero shows a
    // drawn Record card (.vrec) in place of the photo, as the Figma audit's record-page rule says
    if (document.body.dataset.page === 'record') { if (!hero.querySelector('.vrec')) out.push('record page hero has no Record card (.vrec): on a profile or report the record is the picture'); }
    else if (!hero.querySelector('.vh-photo img')) out.push('hero has no photo: every hero has the portrait photo with its outline (.vh-photo)');
    else { const o = getComputedStyle(hero.querySelector('.vh-photo'), '::before'); if (o.content === 'none' || !(parseFloat(o.borderTopWidth) > 0)) out.push('hero photo has no brand outline behind it (Lewis, 24 Nov 2026: option A)'); }
  }
  // ── the homepage template (Lewis, 26 Nov 2026: "BYP is the template that should be followed for all websites", the three
  // selling points second; scope "Selling points second"). Every group homepage: the hero with three short checks under its
  // action (ul.vc, three li), then straight after it one heading and a trio of three (ul.vm, not .four), each a seal, a
  // title and a line. After that the site keeps its own sections. The same block runs on every group site's check
  // (copied from phillips-group 417a0f1 into phillips-uk.com, 27 Nov 2026). ──
  if (hero && location.pathname === '/') {
    const vc = hero.querySelector('ul.vc');
    if (!vc || vc.querySelectorAll(':scope > li').length !== 3) out.push(`homepage template: the hero needs three short checks under its action (ul.vc), it has ${vc ? vc.querySelectorAll(':scope > li').length : 'none'}`);
    const next = secs[secs.indexOf(hero) + 1], vm = next && next.querySelector('ul.vm'), items = vm ? [...vm.querySelectorAll(':scope > li')] : [];
    if (!next || !vm || vm.matches('.four') || items.length !== 3 || items.some(li => !li.querySelector('.seal') || !li.querySelector('h3'))) out.push(`homepage template: the section after the hero (${next ? where(next) : 'none'}) must be the three selling points: one heading and a trio of three, each a seal, a title and a line`);
    else if ([...next.querySelectorAll('.v-h2')].length !== 1 || next.querySelector('.vb, .v-body:not(.vm .v-body)')) out.push(`homepage template: the selling points section ${where(next)} holds only its heading and the trio (no intro, no button)`);
  }
  for (const h of [...main.querySelectorAll('.v-h2')].filter(vis)) { const p = h.previousElementSibling;
    if (p && p.matches('.seal')) out.push(`seal beside the heading "${h.textContent.trim().slice(0, 24)}": the baseline has none`); }
  if (size === 'desk') for (const m of [...main.querySelectorAll('.vm')].filter(vis)) { const s = m.closest('section'), h = s && s.querySelector('.v-h2');
    if ((h && getComputedStyle(h).textAlign !== 'center') || getComputedStyle(m).textAlign !== 'center') out.push(`trio in ${where(s)} is not centred: heading and items centre, as on the homepage`); }
  for (const h of [...main.querySelectorAll('h3, .v-h3')].filter(vis)) { const p = h.previousElementSibling;
    if (p && vis(p) && !p.matches('.seal, img, figure, svg') && p.textContent.trim() && parseFloat(getComputedStyle(p).fontSize) <= 15) out.push(`small label "${p.textContent.trim().slice(0, 20)}" above a card title (no labels)`); }
  for (const h of [...main.querySelectorAll('section .v-h2')].filter(vis)) { const p = h.nextElementSibling;
    if (!p || p.tagName !== 'P' || !vis(p) || drawn(p)) continue; const cs = getComputedStyle(p), f = px(cs.fontSize), w = +cs.fontWeight, want = size === 'phone' ? [16, 18] : [17, 21];
    if (size !== 'tab' && (w !== 400 || !want.includes(f))) out.push(`intro under "${h.textContent.trim().slice(0, 24)}" is ${w} ${f}px, the baseline is 400 at ${want[0]}`); }
  const radiusOk = el => { const r = el.getBoundingClientRect(), v = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0; if (!v) return true;
    if (/%$/.test(getComputedStyle(el).borderTopLeftRadius) || v >= Math.min(r.width, r.height) / 2 - 1) return true; return [20, 28, 32].includes(Math.round(v)); };
  const cardish = el => { const cs = getComputedStyle(el); return (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== getComputedStyle(el.parentElement).backgroundColor) || (parseFloat(cs.borderLeftWidth) > 0 && parseFloat(cs.borderRightWidth) > 0); };
  { const bad = new Set(); for (const el of main.querySelectorAll('div, li, aside, a, details, ul, ol, figure, section')) {
      if (!vis(el) || el.closest('[aria-hidden="true"], #qc-app, .qx-example, .seal, .vb, [data-picture], .qa-doc') || el.getBoundingClientRect().height < 40) continue;
      if (cardish(el) && !radiusOk(el)) bad.add(Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius)) + 'px (' + where(el) + ')'); }
    if (bad.size) out.push(`card corners off the system (20, 28 photo, 32 panel, pills): ${[...bad].slice(0, 4).join(', ')}`); }
  for (const s of secs) if (s.querySelector(':scope > .vt, :scope .v-wrap.vt') && !isStone(s)) out.push(`closing strip ${where(s)} is not on cream: the strip is always bg-stone`);
  { const f = main.querySelector('#faq'); if (f && vis(f) && !f.querySelector('.vq')) out.push('FAQ is not the baseline split (.vq: heading left, plain questions right)'); }
  // word budget and a picture every two screens (legal pages and SEO reading sections are exempt from the budget)
  if (!legal && size !== 'tab') {
    const H = document.documentElement.scrollHeight, top = (secs[0] ? secs[0].getBoundingClientRect().top + scrollY : 0);
    const end = secs.length ? secs[secs.length - 1].getBoundingClientRect().bottom + scrollY : H;
    let words = 0; const ww = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n; (n = ww.nextNode());) { const el = n.parentElement; if (!el || !vis(el) || el.closest('[data-reading], .v-reading, nav, [data-list]') || drawn(el)) continue; words += n.textContent.split(/\s+/).filter(Boolean).length; }
    const readH = [...main.querySelectorAll('[data-reading], .v-reading')].reduce((a, r) => a + r.getBoundingClientRect().height, 0);
    const screens = Math.max(1, (end - top - readH) / SYS.screen[size]);
    if (words / screens > SYS.words[size]) out.push(`word budget: ${Math.round(words / screens)} words a screen, budget ${SYS.words[size]} (hide first)`);
    // seals are marks, not pictures (Obsidian 147): only photos, screenshots, illustrations and charts count
    const pics = [...main.querySelectorAll('img, svg, picture, video, canvas, figure, [data-picture]')].filter(el => vis(el) && !el.closest('a.vb, button, .vb, .seal') &&el.getBoundingClientRect().width >= 48 && el.getBoundingClientRect().height >= 48)
      // each picture is a span, top to bottom: a screen counts as pictured while any of a picture is on it
      .flatMap(el => { const t = el.getBoundingClientRect().top + scrollY, h = el.getBoundingClientRect().height; const st = el.closest('*') && [el, ...(function up(e, o = []) { for (let p = e.parentElement; p && p !== main; p = p.parentElement) o.push(p); return o; })(el)].find(x => getComputedStyle(x).position === 'sticky');
      // a sticky picture stays on screen down its whole container, so it counts at every screen of it
      if (!st) return [[t, t + h]]; const box = st.parentElement.getBoundingClientRect(); return [[t, Math.max(t + h, box.bottom + scrollY)]]; })
      .sort((a, b) => a[0] - b[0]);
    // a case article (body data-page="article") is a long read: its reading sections show every real picture the case has
    // and are exempt from the picture guide, as legal pages are, so no filler image is added to meet it (Lewis, 21 Nov 2026)
    if (document.body.dataset.page === 'article') { for (const r of main.querySelectorAll('[data-reading]')) { const b = r.getBoundingClientRect(); pics.push([b.top + scrollY, b.bottom + scrollY]); } pics.sort((a, b) => a[0] - b[0]); }
    let last = top; for (const [y, b] of [...pics.filter(([y]) => y >= top && y <= end), [end, end]]) { if (y - last > 2 * SYS.screen[size]) out.push(`no picture for ${Math.round((y - last) / SYS.screen[size] * 10) / 10} screens (from ${Math.round(last)}px): a picture every two screens`); last = Math.max(last, b); }
  }
  // no link inside a sentence (Lewis 24 Nov 2026: "hyperlinked green text ... shouldn't be part of the design"): a sentence
  // is plain text and its action sits after it (.v-go or a button). Source citations (.qc-from, "Source:") are the exception,
  // and so are the cross-references inside the reviewed legal wording (data-page="legal" reading sections, batch 4).
  for (const l of [...main.querySelectorAll('a')].filter(vis)) {
    if (l.closest('body[data-page="legal"] [data-reading]')) continue;
    if (l.closest('.vb, .v-go, .vd-link, nav, figure, [data-list], .qc-from, .vd-crumb, summary') || l.matches('.vb, .v-go, .vd-link')) continue;
    const p = l.parentElement; if (!p || !/^(P|H1|H2|H3|DD|SPAN|STRONG|B|EM)$/.test(p.tagName)) continue;
    const all = p.textContent.replace(/\s+/g, ' ').trim(), own = [...p.querySelectorAll('a')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' ');
    if (all !== own && !/^Source/.test(all)) { out.push(`link inside a sentence: "${all.slice(0, 40)}" (make the sentence plain and put the link after it)`); break; }
  }
  // phone action bar: never over a closing strip or the footer, never two copies of one button on screen
  const bar = document.querySelector('.vbar');
  if (bar && size === 'phone') {
    for (const el of [...document.querySelectorAll('.vt, #site-footer')]) {
      el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 350));
      if (bar.classList.contains('on')) out.push(`phone bar shows over ${where(el)}`);
    }
    window.scrollTo(0, 0);
  }
  return out;
};

(async () => {
  const list = pages();
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/`;
  const c = await chrome();
  let total = 0;
  try {
    for (const p of list) {
      for (const w of WIDTHS) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
        c.events.length = 0;
        const tpl = Object.keys(TEMPLATES).find(k => TEMPLATES[k] === p);
        await c.send('Page.navigate', { url: (tpl ? base.replace(/\/$/, '') + tpl : base + p.replace(/index\.html$/, '').replace(/\.html$/, '')) + '?motion=off' });
        for (let i = 0; i < 100 && !c.events.includes('Page.loadEventFired'); i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 600));
        const r = await c.send('Runtime.evaluate', { expression: `(${AUDIT.toString()})(${JSON.stringify(SYS)})`, awaitPromise: true, returnByValue: true });
        const found = (r.result && r.result.result && r.result.result.value) || [`could not measure: ${JSON.stringify(r.result && r.result.exceptionDetails || r.error).slice(0, 200)}`];
        total += found.length;
        console.log(`${found.length ? 'FAIL' : 'ok  '} ${p} @${w}${found.length ? '\n  - ' + found.join('\n  - ') : ''}`);
      }
    }
  } finally { c.close(); srv.close(); }
  console.log(total ? `\n${total} finding(s): off the v5 system (note 146)` : `\nall ${list.length} page(s) on the v5 system at ${WIDTHS.join(', ')}`);
  process.exit(total ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
