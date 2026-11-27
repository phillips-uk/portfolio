#!/usr/bin/env node
// check-admin-system.cjs: the code half of the group Admin Kit's check (Obsidian 04_Projects/Client Dashboard Kit/
// 01_Admin Kit.md; its Figma half is dash-audit.js v2 in that folder). Copied from Before You Pay's
// scripts/check-dash-system.cjs (the client kit's check, 25 Nov 2026) and changed only for the admin: the shell rule (G)
// and the screens. It serves /admin with made-up data (scripts/preview-admin.cjs), opens every place in this Mac's
// Chrome, headless, at 2000, 1440, 768 and 375, and fails on anything off the kit (Lewis 26 Nov 2026, "Yes build it"):
//   A. type scale: every visible text size is on the scale for its width (desktop and tablet 60 52 48 40 32 22 21 19 17 15 14
//      13; phone 34 28 24 19 18 17 16 14 13, note 146);
//   B. calm record: no red, amber or green (the --ok, --attn and --bad tones) in text, fills or borders: status is in words;
//   C. panels: radius 20 and padding 24 (20 on phones);
//   D. no eyebrows: no small text (15 or less) straight above a heading (19 or more);
//   E. one main action: at most one primary button on screen (inside an open drawer or centred card, only it counts);
//   F. less text: words a screen outside lists, tables, facts and the shell, 90 on desktop and tablet, 60 on phones;
//   G. the admin shell: from 1024 the sidebar (14 places at most, in named groups) and the top bar, no tab bar; below
//      1024 the top bar and the tab bar (four places and Menu), the sidebar only as the Menu sheet;
//   H. no link inside a sentence; and no sideways scroll;
//   I. wide windows: from 1024 the page fills the room beside the sidebar up to 1600 of content, then sits in the middle
//      (Lewis, 27 Nov 2026: "wide windows make sense to do if the right isn't used"; the same rule as Before You Pay's).
// Example data only, nothing sent, no cost. Run it before Lewis sees an admin change and before every deploy of one:
//   node scripts/check-admin-system.cjs              every screen below
//   node scripts/check-admin-system.cjs prospects    the screens whose name contains "prospects"
//   node scripts/check-admin-system.cjs --shots <folder>   also saves a picture of each screen it checks
// Exit code 1 on any finding.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { server } = require('./preview-admin.cjs');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── the kit, in one place (keep in step with dash-audit.js, Before You Pay's check-dash-system.cjs and admin.html) ──
const SYS = {
  scale: { desk: [60, 52, 48, 40, 32, 22, 21, 19, 17, 15, 14, 13], phone: [34, 28, 24, 19, 18, 17, 16, 14, 13] },
  words: { desk: 90, phone: 60 }, screen: { desk: 900, tab: 1024, phone: 812 },
  panel: { pad: 24, padPhone: 20, radius: 20 },
  places: 14, tabs: 5,
  wide: 1600,   // the admin's content cap on wide windows (--adm-content-max in admin.html, section 2)
};
const WIDTHS = [2000, 1440, 768, 375];
// every place in the admin; "act" opens a drawer, a card or a menu first
const SCREENS = [
  ['overview'], ['clients'], ['clients', 'former tab', "document.querySelector('#cl-tabs [data-t=former]').click()"],
  ['client/example-builders'], ['client/example-builders', 'billing tab', "document.querySelector('#c-tabs [data-t=billing]').click()"],
  ['client/example-builders', 'reports tab', "document.querySelector('#c-tabs [data-t=reports]').click()"],
  ['client/example-builders', 'edit billing drawer', "document.querySelector('#c-actions .btn.primary').click()"],
  ['doc/a10123456789abcd/example-builders'],
  ['prospects'], ['prospects', 'won tab', "document.querySelector('#p-tabs [data-t=won]').click()"],
  ['prospects', 'card drawer', "document.querySelector('.adm-deal').click()"],
  ['products'], ['links'], ['links', 'rows ticked', "document.querySelectorAll('#invites .adm-check')[0].click(); document.querySelectorAll('#invites .adm-check')[1].click()"],
  ['links', 'link drawer', "document.querySelector('#invites tr.click td.lead').click()"],
  ['links', 'new link drawer', "document.getElementById('lk-new').click()"],
  ['brief'], ['brief', 'confirm card', "document.querySelector('#br-next-a .btn.primary').click()"],
  ['list'], ['demos'], ['pricing'], ['site'], ['settings'], ['settings', 'Xero open', "document.querySelector('#st-conns button.adm-h').click()"],
  ['overview', 'switcher open', "document.querySelector((innerWidth < 1024 ? '#adm-sw-top' : '#adm-sw') + ' .adm-sw-btn').click()"],
  ['overview', 'menu sheet', "innerWidth < 1024 ? document.getElementById('adm-menu-tab').click() : 0"],
];

async function chrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admcheck-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
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
  const W = innerWidth, size = W < 620 ? 'phone' : W < 1024 ? 'tab' : 'desk', out = [];
  const px = v => Math.round(parseFloat(v));
  const vis = el => { if (!el || !el.isConnected) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (el.closest('details:not([open])') && !el.closest('summary')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (el.offsetParent !== null || cs.position === 'fixed' || cs.position === 'sticky'); };
  const where = el => (el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase()).slice(0, 40);
  const app = document.querySelector('#app');
  if (!app || app.hidden) return ['the admin did not open (signed-out screen showing)'];
  if (document.documentElement.scrollWidth > W + 1) out.push(`sideways scroll: page is ${document.documentElement.scrollWidth}px wide`);
  // I. wide windows: the page uses the room beside the sidebar (up to the cap) and sits in the middle of it
  { const pg = document.querySelector('#adm-page'), mn = document.querySelector('.app > .main');
    if (W >= 1024 && pg && mn) {
      const m = mn.getBoundingClientRect(), r = pg.getBoundingClientRect(), padX = px(getComputedStyle(pg).paddingLeft) + px(getComputedStyle(pg).paddingRight);
      const want = Math.min(m.width, SYS.wide + padX);
      if (r.width < want - 2) out.push(`wide window: the page is ${Math.round(r.width)}px wide where ${Math.round(want)}px fits`);
      if (Math.abs((r.left - m.left) - (m.right - r.right)) > 2) out.push(`wide window: the page sits ${Math.round(r.left - m.left)}px from the left and ${Math.round(m.right - r.right)}px from the right`);
    } }
  // an open drawer or centred card is the screen: only it is checked for main buttons and words
  const layer = [...document.querySelectorAll('#cf, .adm-dw-wrap')].filter(e => !e.hidden).pop() || null;
  const texts = []; { const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) { const el = n.parentElement; if (!n.textContent.trim() || !el || !vis(el) || el.closest('script, style, [aria-hidden="true"], .dash-sr, #signin')) continue;
      if (parseFloat(getComputedStyle(el).fontSize) === 0) continue;
      texts.push([n, el]); } }
  // A. type scale (tablet uses the desktop scale)
  { const scale = SYS.scale[size === 'phone' ? 'phone' : 'desk'], off = {};
    for (const [n, el] of texts) { const z = Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2; if (!scale.includes(z)) (off[z] = off[z] || []).push(n.textContent.trim().slice(0, 18) + ' (' + where(el) + ')'); }
    for (const [z, l] of Object.entries(off)) out.push(`size ${z}px is off the type scale (${l.length}×, e.g. "${l[0]}")`); }
  // B. calm record: no verdict colours
  { const root = getComputedStyle(document.documentElement), bad = {};
    for (const t of ['--ok', '--ok-wash', '--ok-dot', '--attn', '--attn-wash', '--attn-dot', '--bad', '--bad-wash', '--bad-dot']) { const v = root.getPropertyValue(t).trim(); if (!v) continue; const p = document.createElement('i'); p.style.color = v; document.body.appendChild(p); bad[getComputedStyle(p).color] = t; p.remove(); }
    const hits = new Set();
    for (const el of document.body.querySelectorAll('*')) { if (!vis(el)) continue; const cs = getComputedStyle(el);
      for (const k of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor']) { const c = cs[k]; if (bad[c] && !(k !== 'color' && k !== 'backgroundColor' && parseFloat(cs[k.replace('Color', 'Width')]) === 0)) hits.add(bad[c] + ' on ' + where(el)); }
      for (const pe of ['::before', '::after']) { const ps = getComputedStyle(el, pe); if (ps.content !== 'none' && bad[ps.backgroundColor]) hits.add(bad[ps.backgroundColor] + ' on ' + where(el) + pe); } }
    if (hits.size) out.push(`verdict colour (say it in words, ink and brand only): ${[...hits].slice(0, 4).join('; ')}${hits.size > 4 ? ' and ' + (hits.size - 4) + ' more' : ''}`); }
  // C. panels
  { const bad = new Set(), want = size === 'phone' ? SYS.panel.padPhone : SYS.panel.pad;
    for (const p of [...app.querySelectorAll('.dash-panel')].filter(vis)) { const cs = getComputedStyle(p);
      if (px(cs.borderTopLeftRadius) !== SYS.panel.radius) bad.add(`${where(p)} radius ${px(cs.borderTopLeftRadius)}`);
      if (px(cs.paddingLeft) !== want) bad.add(`${where(p)} padding ${px(cs.paddingLeft)}`); }
    if (bad.size) out.push(`panels off the kit (radius ${SYS.panel.radius}, padding ${want}): ${[...bad].slice(0, 4).join(', ')}`); }
  // D. no eyebrows
  for (const h of [...document.querySelectorAll('h1, h2, h3')].filter(vis)) { if (parseFloat(getComputedStyle(h).fontSize) < 19) continue; const p = h.previousElementSibling;
    if (p && vis(p) && !p.matches('.dash-back, nav, button, a.btn, img, svg') && !p.children.length && p.textContent.trim() && p.textContent.trim().length < 40 && parseFloat(getComputedStyle(p).fontSize) <= 15) out.push(`small label "${p.textContent.trim().slice(0, 20)}" above "${h.textContent.trim().slice(0, 20)}" (no eyebrows)`); }
  // E. one main action: a main button is filled with the brand colour, whatever its class says
  { const probe = document.createElement('i'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--brand'); document.body.appendChild(probe); const brand = getComputedStyle(probe).color; probe.remove();
    const scope = layer || app, mains = [...scope.querySelectorAll('a, button')].filter(b => vis(b) && b.textContent.trim() && getComputedStyle(b).backgroundColor === brand && !b.disabled);
    if (mains.length > 1) out.push(`${mains.length} main buttons on one screen (${mains.slice(0, 3).map(b => '"' + b.textContent.trim().slice(0, 20) + '"').join(', ')}): keep one, make the rest White or Tint`); }
  // F. less text (lists, tables, facts, menus, forms and the shell don't count; a document's own text is the page)
  if (!layer) { const DATA = '.dash-rows, .dash-facts, .adm-qs, .adm-chs, .adm-hs, .adm-h-more, .adm-board, .adm-table, .dash-stats, .dash-tabs, .adm-steps, .side, .top, .tabbar, label, select, button, .btn, .dash-menu, .dash-tag, .pr-fields, .sc-chart, .sc-legend, .dm-pick, .doc, .adm-perf, .lk-list, .dash-notice, .pr-savebar';
    let words = 0; for (const [n, el] of texts) { if (el.closest(DATA) || el.closest('.adm-dw-wrap, #cf')) continue; words += n.textContent.split(/\s+/).filter(Boolean).length; }
    const page = document.querySelector('#adm-page'), h = page ? page.getBoundingClientRect().height : innerHeight, screens = Math.max(1, h / SYS.screen[size]);
    const per = Math.round(words / screens), budget = SYS.words[size === 'phone' ? 'phone' : 'desk'];
    if (per > budget) out.push(`word budget: ${per} words a screen, budget ${budget} (hide first: cut, or put it behind a tap)`); }
  // G. the admin shell
  { const side = document.querySelector('#adm-side'), top = document.querySelector('#adm-top'), bar = document.querySelector('#tabbar'), sheet = document.body.classList.contains('adm-sheet');
    if (!vis(top) && !sheet) out.push('no top bar');
    const places = [...side.querySelectorAll('.nav a[data-view]')];
    if (places.length > SYS.places) out.push(`${places.length} places in the sidebar, ${SYS.places} at most`);
    if (side.querySelectorAll('.adm-grp').length && [...side.querySelectorAll('.adm-grp')].some(g => /[A-Z]{2}/.test(g.textContent) || getComputedStyle(g).textTransform === 'uppercase')) out.push('group names in capitals (sentence case only)');
    if (W >= 1024) { if (!vis(side)) out.push('desktop: no sidebar'); if (vis(bar)) out.push('desktop: the tab bar shows'); }
    else { if (vis(side) && !sheet) out.push('below 1024: the sidebar shows (only as the Menu sheet)'); if (!vis(bar)) out.push('below 1024: no tab bar');
      const t = [...bar.children].filter(vis); if (t.length > SYS.tabs) out.push(`${t.length} items on the tab bar, ${SYS.tabs} at most`);
      if (!/Menu/.test((t[t.length - 1] || {}).textContent || '')) out.push('below 1024: the last tab is not Menu'); } }
  // H. no link inside a sentence
  for (const l of [...document.querySelectorAll('#adm-page a, .adm-dw a')].filter(vis)) {
    if (l.closest('.btn, .dash-go, .dash-back, nav, .side, .top, .tabbar, .dash-menu, .dash-row, .adm-ch, summary, .dash-ph2, .adm-table td.lead, .cm-text, .dash-stat, .att') || l.matches('.btn, .dash-go, .dash-back, .dash-stat, .dash-row, .adm-ch')) continue;
    const p = l.parentElement; if (!p || !/^(P|H1|H2|H3|DD|SPAN|LI|DIV|TD)$/.test(p.tagName)) continue;
    const all = p.textContent.replace(/\s+/g, ' ').trim(), own = [...p.querySelectorAll('a')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' ');
    if (all !== own) { out.push(`link inside a sentence: "${all.slice(0, 50)}" (make the sentence plain and put the link after it)`); break; }
  }
  return out;
};

(async () => {
  const args = process.argv.slice(2), si = args.indexOf('--shots'), shots = si === -1 ? null : args.splice(si, 2)[1];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const want = args;
  const list = SCREENS.filter(s => !want.length || want.some(w => (s[0] + ' ' + (s[1] || '')).includes(w)));
  const srv = server(); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/admin`;
  const c = await chrome();
  let total = 0;
  try {
    for (const [hash, label, act] of list) {
      for (const w of WIDTHS) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 620 ? 812 : w < 1024 ? 1024 : 900, deviceScaleFactor: 1, mobile: w < 768 });
        c.events.length = 0;
        await c.send('Page.navigate', { url: base + '?t=' + Date.now() + '#' + hash });
        for (let i = 0; i < 100 && !c.events.includes('Page.loadEventFired'); i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 1500));
        if (act) { await c.send('Runtime.evaluate', { expression: act }); await new Promise(r => setTimeout(r, 600)); }
        const r = await c.send('Runtime.evaluate', { expression: `(${AUDIT.toString()})(${JSON.stringify(SYS)})`, awaitPromise: true, returnByValue: true });
        const found = (r.result && r.result.result && r.result.result.value) || [`could not measure: ${JSON.stringify(r.result && r.result.exceptionDetails || r.error).slice(0, 300)}`];
        total += found.length;
        if (shots) { const img = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); if (img.result) fs.writeFileSync(path.join(shots, `${(hash + (label ? '-' + label : '')).replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')}@${w}.png`), Buffer.from(img.result.data, 'base64')); }
        console.log(`${found.length ? 'FAIL' : 'ok  '} ${hash}${label ? ' (' + label + ')' : ''} @${w}${found.length ? '\n  - ' + found.join('\n  - ') : ''}`);
      }
    }
  } finally { c.close(); srv.close(); }
  console.log(total ? `\n${total} finding(s): off the Admin Kit` : `\nall ${list.length} screen(s) on the Admin Kit at ${WIDTHS.join(', ')}`);
  process.exit(total ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
