'use strict';
// Design Spec v3 (Obsidian 04_Projects/Before You Pay/Brand Assets/Web Design/BYP-DESIGN-SPEC.md), Part B9 step 7: the
// Phillips. website and admin on the shared token layers, the way Before You Pay's scripts/test-tokens.cjs checks its own.
// 1. Every target carries an up-to-date copy of tokens/system.css, modes.css and brand.css (scripts/build-tokens.js).
// 2. The layers keep their jobs: brand.css holds only --brand values and is the only place the brand's hex values live;
//    system.css holds no mode colours; modes.css is the light block.
// 3. Light only (the global rule): no dark or glass mode, nothing follows the device's dark setting.
// 4. The site and admin ask only for token names: no hex colour in their CSS (white text and color-mix recipes aside,
//    and the named object colours of the drawn MacBook/iPhone/Safari and Google's own sign-in button), no old palette
//    names, and every var() they use is defined somewhere or has a fallback.
// 5. The group admin switcher block (the v5 Admin Kit switcher, meant to be the same in all five group admins) is
//    byte-for-byte unchanged.
//   node scripts/test-tokens.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const T = require('./build-tokens.js');
const ROOT = path.join(__dirname, '..');
const R = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const cutTokens = s => { const i = s.indexOf(T.START.slice(0, 20)); return i === -1 ? s : s.slice(0, i) + s.slice(s.indexOf(T.END) + T.END.length); };

// 1. up to date
for (const t of T.TARGETS) assert.equal(T.build(R(t.file), t.sources), R(t.file), `${t.file} is out of date: run node scripts/build-tokens.js`);

// 2. each layer keeps to its job
const brand = strip(R('tokens/brand.css')), system = strip(R('tokens/system.css')), modes = strip(R('tokens/modes.css'));
assert.ok([...brand.matchAll(/(--[\w-]+)\s*:/g)].every(m => /^--brand/.test(m[1])), 'brand.css holds only --brand values');
assert.match(brand, /--brand:\s*#985830/i, 'the Phillips. brand colour is the logo amber #985830');
assert.ok(!/#[0-9a-f]{6}/i.test(system.replace(/#000|#fff|#FFFFFF/gi, '')), 'system.css holds no mode colours');
const BRAND_HEX = /#985830|#7A3F1F|#F5EBD9|#D9925E/i;
assert.ok(!BRAND_HEX.test(modes + system), 'brand hex values live only in brand.css');
assert.ok(/:root\s*,\s*\[data-theme="light"\]/.test(modes), 'modes.css has the light block');

// the files in scope: the website's stylesheets and every live page (the retired tool pages and the prospect prototypes,
// which carry other businesses' brands, are not part of the Phillips. design)
const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
const SHEETS = ['agency.css', 'tools.css', 'brief.css', 'motion.css', 'guides.css', 'v5.css'];
const PAGES = ['index.html',
  ...fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'index.html')) && e.name !== 'guides').map(e => `${e.name}/index.html`),
  ...walk('guides').filter(f => f.endsWith('index.html')),
  ...['admin', 'rate-card', 'brief-page', 'google-ads-check', 'website-check'].map(n => `cloudflare/private/${n}.html`)];

// the group admin switcher: its CSS block is the switcher's own business. It replaced the liquid-glass menu on 26 Nov 2026
// (Admin Kit, Figma page 15); until the other four admins (TDO Control Room, Before You Pay, Index Point, Search Desk)
// move to it, they still carry the old menu block, so this hash is the Phillips. copy, the one the others should match.
const GM_START = '/* ===== Group admin switcher, v5', GM_END = '/* ===== end of group admin switcher ===== */';
const GM_HASH = 'e779be85855adf01a2e75d5ff97b5c810e082fd46ba22b0526f88ddd726b222b';   // = cloudflare/private/admin.html, 26 Nov 2026
const admin = R('cloudflare/private/admin.html');
const gm = admin.slice(admin.indexOf(GM_START), admin.indexOf(GM_END) + GM_END.length);
assert.equal(crypto.createHash('sha256').update(gm).digest('hex'), GM_HASH, 'the group admin switcher block must stay byte-for-byte as it is (each group admin carries the same copy)');
const withoutMenu = s => s.includes(GM_START) ? s.slice(0, s.indexOf(GM_START)) + s.slice(s.indexOf(GM_END) + GM_END.length).replace(/:root \{ --gm-[^}]*\}/, '') : s;

const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  + '\n' + [...html.matchAll(/\sstyle="([^"]*)"/g)].map(m => `x{${m[1]}}`).join('\n');
const sources = [...SHEETS.map(f => [f, cutTokens(R(f))]), ...PAGES.map(f => [f, cutTokens(styleOf(withoutMenu(R(f))))])];

// 3. light only
for (const [f, css] of sources) assert.ok(!/prefers-color-scheme|data-theme="(dark|glass)"/.test(strip(css)), `${f}: light only (no dark mode, no glass mode)`);
for (const f of ['motion.js', 'showcase.js', 'contact-form.js', 'brief-form.js']) assert.ok(!/prefers-color-scheme|dataset\.theme|data-theme/.test(R(f)), `${f}: light only`);

// 4a. no hex colours outside the tokens
const colourProp = /^(color|fill|stroke|caret-color|stop-color)$/;
for (const [f, src] of sources) {
  const c = strip(src).replace(/url\([^)]*\)/g, 'url()');
  for (const m of c.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    let j = m.index; while (j > 0 && !'{;'.includes(c[j - 1])) j--;
    const decl = c.slice(j, m.index), prop = (decl.match(/^\s*([\w-]+)\s*:/) || [])[1] || '';
    if (/^--(dev|gsi)-/.test(prop)) continue;   // the drawn devices' and Google's button's own colours, named once
    const white = /^#fff(fff)?$/i.test(m[0]), mix = decl.lastIndexOf('color-mix('), inMix = mix !== -1 && (decl.slice(mix).split('(').length > decl.slice(mix).split(')').length);
    assert.ok(white && (colourProp.test(prop) || inMix), `${f}: ${m[0]} in "${decl.trim().slice(0, 70)}" should be a token (var(--...))`);
  }
}
// 4b. no old palette names
const OLD = /var\(--(amber[\w-]*|cream|border|white|mid|ink-3|on-ink[\w-]*|faint|good[\w-]*|warn[\w-]*|font(-sans)?|radius|shadow-card|shadow-raised)\)/;
for (const [f, src] of sources) { const m = src.match(OLD); assert.ok(!m, `${f}: ${m && m[0]} is an old colour name; use the token`); }
const scriptsOf = html => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
for (const f of PAGES) { const m = scriptsOf(R(f)).match(OLD); assert.ok(!m, `${f} (script): ${m && m[0]} is an old colour name`); }
// 4c. every var() is defined (the tokens, a declaration in the site's CSS, or set at run time with a fallback)
const declared = s => new Set([...s.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const names = new Set([...['system', 'modes', 'brand'].flatMap(n => [...declared(R(`tokens/${n}.css`))]), ...sources.flatMap(([, s]) => [...declared(s)]), ...declared(gm)]);   // any names the switcher block declares count as defined
for (const [f, src] of sources) for (const m of src.matchAll(/var\((--[\w-]+)\s*([,)])/g)) assert.ok(names.has(m[1]) || m[2] === ',', `${f}: var(${m[1]}) is not defined`);

// every live page gets the tokens: from agency.css, guides.css or its own copy
for (const f of PAGES) {
  const h = R(f);
  assert.ok(/\/agency\.css\?v=\d+/.test(h) || /\/guides\.css\?v=\d+/.test(h) || /\/v5\.css\?v=\d+/.test(h) || h.includes(T.START), `${f} loads no token layer`);
}

execFile();
function execFile() { require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-tokens.js'), '--check'], { stdio: 'pipe' }); }
console.log(`tokens: all checks passed (${T.TARGETS.length} targets up to date; ${sources.length} stylesheets and pages on tokens, light only; group admin switcher unchanged)`);
