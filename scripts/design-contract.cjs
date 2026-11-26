#!/usr/bin/env node
/* Design contract: what the v5 redesign must not break (Figma sync playbook, 24 Nov 2026).
   Copied from the Phillips Group pilot (phillips-group origin/main 02d3494, itself from Before You Pay) for phillips-uk.com
   on 25 Nov 2026 and changed only for this repo:
   - PAGES: the in-scope public pages (main pages, Insights, the Monday Brief shell, the free tools). Out of scope and left
     out on purpose: /admin, the invite pages (rate-card), the client and prospect pages (monument-*, the-loft),
     supplier-check, /desk, and the retired root pages that MOVED in cloudflare/src/worker.js 301s.
   - Page scripts are files at the repo root (not public/), and the Worker adds /consent.js to every page it tags.
   - KEEP: the hooks that must never go, whatever the design (CLAUDE.md "Analytics", "The free tools", "The Monday Brief").
   - STRUCTURE: one <h1> and one <main> per page, canonical and OG tags on www.phillips-uk.com, and the JSON-LD @ids each
     page carries today.
   For every page it lists the element ids, classes and data- attributes that its scripts reach for, and every form with
   where it sends and its field names. A redesign may change how a page looks; it must keep everything listed here, or
   change the script in the same commit and rerun this.
   Usage: node scripts/design-contract.cjs            writes .design/contract.md
          node scripts/design-contract.cjs --check    exits 1 if a hook in the saved contract, KEEP or STRUCTURE has gone */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.design', 'contract.md');
// Scripts the Worker adds to every page it tags (cloudflare/src/worker.js withGtm: CONSENT_TAG); they are not in the files.
const WORKER_SCRIPTS = ['/consent.js'];

// [address, file, family, kind]. kind: 'page' (a static file), 'template' (served by a Worker module, which may add
// attributes to <body>), 'shell' (the Brief: brief.js fills {{MAIN}} and the head).
const PAGES = [
  ['/', 'index.html', 'Main pages', 'page'],
  ['/about/', 'about/index.html', 'Main pages', 'page'],
  ['/work/', 'work/index.html', 'Main pages', 'page'],
  ['/free-checks/', 'free-checks/index.html', 'Main pages', 'page'],
  ['/consultancy/', 'consultancy/index.html', 'Main pages', 'page'],
  ['/google-ads/', 'google-ads/index.html', 'Main pages', 'page'],
  ['/local-seo/', 'local-seo/index.html', 'Main pages', 'page'],
  ['/marketing-systems/', 'marketing-systems/index.html', 'Main pages', 'page'],
  ['/web-design/', 'web-design/index.html', 'Main pages', 'page'],
  ['/privacy/', 'privacy/index.html', 'Main pages', 'page'],
  ['/terms/', 'terms/index.html', 'Main pages', 'page'],
  ['/404', '404.html', 'Main pages', 'page'],
  ['/guides/', 'guides/index.html', 'Insights', 'page'],
  ['/guides/fix-google-ads-conversion-tracking/', 'guides/fix-google-ads-conversion-tracking/index.html', 'Insights', 'page'],
  ['/guides/fix-performance-max-assets/', 'guides/fix-performance-max-assets/index.html', 'Insights', 'page'],
  ['/guides/ga4-imports-break-smart-bidding/', 'guides/ga4-imports-break-smart-bidding/index.html', 'Insights', 'page'],
  ['/guides/google-ads-audit-checklist/', 'guides/google-ads-audit-checklist/index.html', 'Insights', 'page'],
  ['/guides/google-ads-bidding-strategy/', 'guides/google-ads-bidding-strategy/index.html', 'Insights', 'page'],
  ['/guides/improve-google-ads-quality-score/', 'guides/improve-google-ads-quality-score/index.html', 'Insights', 'page'],
  ['/guides/target-cpa-few-conversions/', 'guides/target-cpa-few-conversions/index.html', 'Insights', 'page'],
  ['/updates/ (every Brief page)', 'cloudflare/private/brief-page.html', 'Monday Brief', 'shell'],
  ['/google-ads-audit', 'cloudflare/private/google-ads-check.html', 'Free tools', 'template'],
  ['/website-check/', 'cloudflare/private/website-check.html', 'Free tools', 'template'],
  ['/account/', 'cloudflare/private/account.html', 'Free tools', 'template'],
];

// Pages with the "Ask me a question" form in a #contact section.
const CONTACT = ['index.html', 'about/index.html', 'work/index.html', 'free-checks/index.html', 'consultancy/index.html',
  'google-ads/index.html', 'local-seo/index.html', 'marketing-systems/index.html', 'web-design/index.html',
  'cloudflare/private/google-ads-check.html', 'cloudflare/private/website-check.html'];
// Pages with the Monday Brief sign-up.
const BRIEF = PAGES.filter(p => p[1].startsWith('guides/')).map(p => p[1]);
// Templates whose Worker module adds attributes with a literal pageHtml.replace('<body>', ...): google-ads-check.js
// (data-preview, data-signin), website-check.js (data-preview), accounts.js (data-google, data-preview).
const BODY_REPLACED = ['cloudflare/private/google-ads-check.html', 'cloudflare/private/website-check.html', 'cloudflare/private/account.html'];

// The hooks that must never go. Each entry: what it is, then the literal text that must stay in that file.
const KEEP = {};
const keep = (file, ...rows) => { (KEEP[file] = KEEP[file] || []).push(...rows); };

for (const f of CONTACT) keep(f,
  ['The contact section every CTA points at (#contact, /#contact)', 'id="contact"'],
  ['The "Ask me a question" form: class, no-JS target, where it sits (form_location)', 'class="enquiry"', 'action="/enquiry"', 'data-location="'],
  ['The fields the Worker reads (cloudflare/src/enquiry.js)', 'name="name"', 'name="email"', 'name="business"', 'name="message"'],
  ['The hidden trap field (answered "sent", nothing sent)', 'name="company_url"'],
  ['Turnstile is put in before the foot; the status line; the Send button', 'enquiry-foot', 'enquiry-status', 'type="submit"'],
  ['The form script', '/contact-form.js']);
keep('contact-form.js',
  ['Finds the forms and posts to /enquiry', "querySelectorAll('form.enquiry')", "fetch('/enquiry'"],
  ['The trap and the 3-second timer', 'company_url: form.company_url.value', 'elapsed: Date.now() - started'],
  ['Turnstile: the live sitekey, the local always-pass test key, interaction-only, the slot before the foot',
    "'0x4AAAAAAGDEt8LCJ4VVlwit'", "'1x00000000000000000000AA'", "appearance: 'interaction-only'", "form.querySelector('.enquiry-foot')"],
  ['generate_lead only after /enquiry accepts, with form_location and nothing typed', "event: 'generate_lead', form_location: data.location"]);

for (const f of BRIEF) keep(f,
  ['The Monday Brief sign-up: class, where it sits, its fields and status line', 'brief-signup', 'data-location="', 'name="email"', 'name="company_url"', 'brief-status'],
  ['The sign-up script', '/brief-form.js']);
keep('guides/index.html', ['The slot the Worker fills with the latest Brief issue (withLatestIssue)', 'data-brief-latest']);
keep('cloudflare/private/brief-page.html',
  ['The placeholders brief.js fills', '{{TITLE}}', '{{DESCRIPTION}}', '{{ROBOTS}}', '{{CANONICAL}}', '{{OGTYPE}}', '{{JSONLD}}', '{{MAIN}}'],
  ['The sign-up script (brief.js writes the forms into {{MAIN}})', '/brief-form.js']);
keep('brief-form.js',
  ['Finds the forms and posts to /subscribe (double opt-in)', "querySelectorAll('form.brief-signup')", "fetch('/subscribe'"],
  ['The trap and the timer', 'company_url: form.company_url.value', 'elapsed: Date.now() - started'],
  ['newsletter_signup with form_location only', "event: 'newsletter_signup', form_location: data.location"]);

for (const f of BODY_REPLACED) keep(f, ['A bare <body> tag: the Worker module adds its attributes by replacing this exact text (see "For the backend session")', '<body>']);
keep('cloudflare/private/google-ads-check.html',
  ['The Google Ads Check script', '/tool-google-ads-check.js'],
  ['Sign in with Google (open to everyone since 24 Nov 2026): its step and the link the Worker handles', 'id="step-google"', 'href="/tools/google-ads-check/oauth/start"'],
  ['Turnstile slot for the run', 'id="check-ts"']);
keep('tool-google-ads-check.js',
  ['Reads the Worker\'s attributes: preview (events off) and sign-in', "getAttribute('data-preview')", "getAttribute('data-signin')", 'if (preview) return;'],
  ['GA4 events (never a customer ID, account name or price)', "track('ads_check_start'", "track('ads_check_complete'", "track('ads_check_error'", "track('ads_check_fix_select'"],
  ['The server routes it calls', '/tools/google-ads-check/oauth/accounts', '/tools/google-ads-check/report/']);
keep('cloudflare/private/website-check.html', ['The Website Check script', '/tool-website-check.js']);
keep('tool-website-check.js',
  ['Reads the Worker\'s preview attribute (events off)', "getAttribute('data-preview')"],
  ['GA4 events (never an address)', "track('website_check_start'", "track('website_check_complete'", "track('website_check_error'", "track('website_check_fix_select'"],
  ['The server routes it calls', '/tools/website-check/run', '/tools/website-check/sample', '/tools/website-check/report/', '/account/save', '/account/me']);
keep('cloudflare/private/account.html',
  ['Google Identity Services and the account script', 'accounts.google.com/gsi/client', '/tool-account.js'],
  ['The sign-in states the script shows and hides', 'id="acct-signin"', 'id="acct-confirm"', 'id="acct-home"', 'id="gsi-btn"']);
keep('tool-account.js', ['Reads the Worker\'s attributes', "getAttribute('data-google')"]);

keep('privacy/index.html',
  ['The one email address, written in by email.js from a placeholder (never plain in the HTML)', 'data-email', '/email.js'],
  ['The cookies anchor the footer link points at', 'id="cookies"']);
keep('email.js', ['Fills a[data-email] from parts', "querySelectorAll('a[data-email]')", "['contact', 'phillips-uk.com'].join('@')"]);
for (const [, f] of PAGES) keep(f,
  ['Cookie settings opens from the footer', 'data-cookie-settings'],
  ['Powered by Phillips. in the footer', 'Powered by Phillips.']);
keep('consent.js',
  ['The banner posts the choice to /api/consent', '/api/consent'],
  ['Any element with data-cookie-settings opens Cookie settings', 'data-cookie-settings']);
keep('cloudflare/src/worker.js',
  ['withGtm: the container and the consent banner on every tagged page (Search Console is verified through GTM)', 'function withGtm(', "'GTM-WS5CP6NW'", 'CONSENT_TAG'],
  ['The Insights hub gets the latest Brief issue', "path === '/guides'", 'withLatestIssue']);

// One <h1> and one <main>, canonical and OG on www.phillips-uk.com, and the JSON-LD @ids. Known gaps today are listed in
// EXCEPT with the reason; the v5 build removes them, and then the entry comes out of this list.
const EXCEPT = {
  'cloudflare/private/account.html': {
    h1: 'three states (sign in, confirm, your websites) each carry an <h1>; two are hidden at a time',
    main: 'a stray second <main id="main"> before the menu drawer (bug, fixed in the v5 build)',
    seo: 'noindex, private to each visitor: no canonical or OG tags',
  },
  '404.html': { seo: 'noindex: no canonical or OG tags' },
  'cloudflare/private/brief-page.html': { h1: 'the <h1> comes from brief.js in {{MAIN}}', seo: 'brief.js fills canonical and OG per page' },
};

const jsCache = {};
function readLocalScript(src) {
  const clean = src.split('?')[0];
  if (!clean.startsWith('/')) return '';
  const f = path.join(ROOT, clean);
  if (!(clean in jsCache)) jsCache[clean] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  return jsCache[clean];
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function analyse(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const scripts = WORKER_SCRIPTS.map(readLocalScript);
  const srcs = [...WORKER_SCRIPTS.map(s => s + ' (added by the Worker)')];
  html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
    const m = attrs.match(/src="([^"]+)"/);
    if (m) { srcs.push(m[1].split('?')[0]); scripts.push(readLocalScript(m[1])); }
    else if (!/application\/(ld\+)?json/.test(attrs)) scripts.push(body);
    return '';
  });
  const js = scripts.join('\n');
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const ids = [...new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))];
  const idHooks = ids.filter(id => new RegExp(`['"\`#]${esc(id)}['"\`\\s.\\[:,)]`).test(js));
  const classes = [...new Set([...markup.matchAll(/\sclass="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)))].filter(Boolean);
  const classHooks = classes.filter(c => new RegExp(`(\\.${esc(c)}\\b)|(classList\\.(contains|toggle|add|remove)\\(['"]${esc(c)}['"])|(getElementsByClassName\\(['"]${esc(c)}['"])`).test(js));
  const dataAttrs = [...new Set([...markup.matchAll(/\s(data-[a-z0-9-]+)=?/g)].map(m => m[1]))]
    .filter(a => js.includes(a) || js.includes(a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())));
  const forms = [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(m => {
    const a = m[1];
    const get = k => (a.match(new RegExp(`\\s${k}="([^"]*)"`)) || [])[1] || '';
    const names = [...new Set([...m[2].matchAll(/\sname="([^"]+)"/g)].map(x => x[1]))];
    return { id: get('id'), cls: get('class'), action: get('action') || '(script)', method: (get('method') || 'get').toLowerCase(), names, where: get('data-location') };
  });
  const events = [...new Set([...js.matchAll(/(?:track\(|event:\s*)'([a-z_]+)'/g)].map(m => m[1]))].filter(e => !/^gtm\./.test(e));
  return { srcs, idHooks, classHooks, dataAttrs, forms, events };
}

function structure(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const head = (html.match(/<head>[\s\S]*?<\/head>/) || [''])[0];
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  return {
    h1: (html.match(/<h1[\s>]/g) || []).length,
    main: (html.match(/<main[\s>]/g) || []).length,
    canonical: (head.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || '',
    og: ['og:url', 'og:title', 'og:description'].filter(k => head.includes(`property="${k}"`)),
    ids: [...new Set([...ld.matchAll(/"@id"\s*:\s*"([^"]+)"/g)].map(m => m[1]))].sort(),
  };
}

function structureProblems(file, saved) {
  const s = structure(file);
  const ex = EXCEPT[file] || {};
  const out = [];
  if (!ex.h1 && s.h1 !== 1) out.push(`${file}: ${s.h1} <h1> (one per page)`);
  if (!ex.main && s.main !== 1) out.push(`${file}: ${s.main} <main> (one per page)`);
  if (!ex.seo) {
    if (!/^https:\/\/www\.phillips-uk\.com\//.test(s.canonical)) out.push(`${file}: canonical missing or not on https://www.phillips-uk.com/`);
    for (const k of ['og:url', 'og:title', 'og:description']) if (!s.og.includes(k)) out.push(`${file}: ${k} missing`);
  }
  for (const id of saved || []) if (!s.ids.includes(id)) out.push(`${file}: JSON-LD @id ${id} gone`);
  return out;
}

function keepMissing() {
  const out = [];
  for (const [file, rows] of Object.entries(KEEP)) {
    const p = path.join(ROOT, file);
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    for (const [what, ...needles] of rows) for (const n of needles) if (!src.includes(n)) out.push(`${file}: ${what}: "${n}"`);
  }
  return out;
}

const rows = PAGES.map(([label, file, family, kind]) => ({ label, file, family, kind, ...analyse(file), st: structure(file) }));

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) { console.error('No saved contract; run without --check first.'); process.exit(1); }
  const saved = fs.readFileSync(OUT, 'utf8');
  let missing = 0;
  for (const block of saved.split('\n### ').slice(1)) {
    const file = (block.match(/^File: `([^`]+)`/m) || [])[1];
    if (!file || !fs.existsSync(path.join(ROOT, file))) continue;
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const id of ((block.match(/^- Ids: (.*)$/m) || [])[1] || '').match(/`#[^`]+`/g) || []) {
      const v = id.slice(2, -1);
      if (!html.includes(`id="${v}"`)) { console.log(`MISSING ${file}: #${v}`); missing++; }
    }
    for (const c of ((block.match(/^- Classes: (.*)$/m) || [])[1] || '').match(/`\.[^`]+`/g) || []) {
      const v = c.slice(2, -1);
      if (!new RegExp(`class="[^"]*(?<![\\w-])${esc(v)}(?![\\w-])`).test(html)) { console.log(`MISSING ${file}: .${v}`); missing++; }
    }
    for (const a of ((block.match(/^- Data attributes: (.*)$/m) || [])[1] || '').match(/`data-[^`]+`/g) || []) {
      const v = a.slice(1, -1);
      if (!html.includes(v)) { console.log(`MISSING ${file}: ${v}`); missing++; }
    }
    const ids = (((block.match(/^- JSON-LD @ids: (.*)$/m) || [])[1] || '').match(/`[^`]+`/g) || []).map(x => x.slice(1, -1));
    for (const m of structureProblems(file, ids)) { console.log(`STRUCTURE ${m}`); missing++; }
  }
  for (const m of keepMissing()) { console.log(`MISSING ${m}`); missing++; }
  console.log(missing ? `${missing} hook(s) gone` : 'contract ok');
  process.exit(missing ? 1 : 0);
}

const fmt = (arr, pre) => arr.length ? arr.map(x => '`' + pre + x + '`').join(', ') : 'none';
let md = `# Design contract: Phillips. (phillips-uk.com)\n\nGenerated by \`node scripts/design-contract.cjs\` on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand; rerun it.\n\n`;
md += 'What the v5 redesign must keep. Change how a page looks freely; keep every hook below, or change the script in the same commit and rerun this. `node scripts/design-contract.cjs --check` fails if a hook has gone from its page, and always checks the fixed lists in "Always kept" and "Structure".\n\n';
md += `Scope: ${PAGES.length} files (${[...new Set(PAGES.map(p => p[2]))].map(f => `${f}: ${PAGES.filter(p => p[2] === f).length}`).join(', ')}). Out of scope: /admin, the invite pages (rate-card), client and prospect pages (monument-*, the-loft), supplier-check, /desk, emails and OG cards, and the retired root pages (creative-analysis*, google-ads-audit*.html, landing-page-audit*), which cloudflare/src/worker.js MOVED 301s. report.css and report-pdf.js belong to the retired landing page audit only.\n\n`;
md += '## Always kept (KEEP in the script)\n\nChecked on every run, whatever the page looks like. The rules behind them: `CLAUDE.md` (Analytics, The free tools, The Monday Brief). Files under `cloudflare/src/` are listed because the front end depends on them; the front-end session never edits them.\n\n';
for (const [file, list] of Object.entries(KEEP)) {
  md += `### \`${file}\`\n\n`;
  for (const [what, ...needles] of list) md += `- ${what}: ${needles.map(n => '`' + n + '`').join(', ')}\n`;
  md += '\n';
}
md += '## Structure\n\nEvery page: one `<h1>`, one `<main>`, a canonical on `https://www.phillips-uk.com/`, `og:url`, `og:title`, `og:description`, and the JSON-LD `@id`s it carries today (`#business` and `/about/#lewis` are the two entities; new pages point at them). Known gaps, which the v5 build closes and then removes from `EXCEPT`:\n\n';
for (const [file, ex] of Object.entries(EXCEPT)) md += `- \`${file}\`: ${Object.entries(ex).map(([k, v]) => `${k}: ${v}`).join('; ')}\n`;
md += '\n## Contract that lives in code\n\nNot covered page by page: the Worker (`cloudflare/src/worker.js`: redirects, `MOVED`, `withGtm`, the consent defaults), the form and tool servers (`enquiry.js`, `google-ads-check.js`, `google-signin.js`, `website-check.js`, `accounts.js`, `brief.js`), and the markup `brief.js` writes into the Brief shell (classes `brief-*` and `bi-*`; restyle them in `brief.css`, never rename them from the front end). The three tool templates get attributes on `<body>` from their module (`data-preview`, `data-signin`, `data-google`) by replacing the literal `<body>`.\n\n';
md += '## Page by page\n\nThe scripts each page loads (the Worker adds `/consent.js` to every page it tags), the element ids, classes and `data-` attributes those scripts reach for, each form with where it sends and its field names, the GA4 events its scripts push, and its structure.\n\n';
for (const fam of [...new Set(rows.map(r => r.family))]) {
  md += `## ${fam}\n\n`;
  for (const r of rows.filter(x => x.family === fam)) {
    md += `### ${r.label}\n\nFile: \`${r.file}\` (${r.kind})\n\n`;
    md += `- Scripts: ${fmt(r.srcs.filter(s => s.startsWith('/') || s.startsWith('http')), '')}\n`;
    md += `- Ids: ${fmt(r.idHooks, '#')}\n`;
    md += `- Classes: ${fmt(r.classHooks, '.')}\n`;
    md += `- Data attributes: ${fmt(r.dataAttrs, '')}\n`;
    md += `- Forms: ${r.forms.length ? r.forms.map(f => `${f.id ? '`#' + f.id + '` ' : ''}${f.cls ? '`.' + f.cls.split(/\s+/)[0] + '` ' : ''}${f.method.toUpperCase()} \`${f.action}\`${f.where ? ` (form_location \`${f.where}\`)` : ''} (fields: ${f.names.map(n => '`' + n + '`').join(', ') || 'none'})`).join('; ') : 'none'}\n`;
    md += `- GA4 events: ${fmt(r.events, '')}\n`;
    md += `- Structure: ${r.st.h1} h1, ${r.st.main} main, canonical ${r.st.canonical ? '`' + r.st.canonical.replace('https://www.phillips-uk.com', '') + '`' : 'none'}, OG ${r.st.og.length}/3\n`;
    md += `- JSON-LD @ids: ${fmt(r.st.ids, '')}\n\n`;
  }
}
const gone = keepMissing();
const bad = rows.flatMap(r => structureProblems(r.file, r.st.ids));
if (gone.length || bad.length) { console.error('Not written:\n  ' + [...gone, ...bad].join('\n  ')); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${rows.length} pages, ${rows.reduce((n, r) => n + r.idHooks.length + r.classHooks.length + r.dataAttrs.length, 0)} hooks, ${rows.reduce((n, r) => n + r.forms.length, 0)} forms, ${Object.values(KEEP).flat().length} always-kept groups`);
