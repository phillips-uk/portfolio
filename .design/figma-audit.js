// figma-audit.js (v2, 24 Nov 2026; phillips-uk.com copy of the Phillips Group copy, 25 Nov 2026): the Figma half of the design-rules check (code half:
// scripts/check-v5-system.cjs). Copied from Before You Pay (.design/figma-audit.js, main 6f444df041) by the Phillips Group
// pilot; this copy changes only PREFIX ("PX") and the Phillips. colours: BRAND (amber #985830) and the palette's brand and
// wash (#985830, #F5EBD9, the Phillips. Brand mode since 25 Nov 2026). The pilot's changes stay: the palette, the brand colour the inline-link rule looks for (BRAND), and
// two rules brought in line with the code check: a legal page's reading sections may use the tight spacing (72 / 56), as
// .v-sec.tight does in code, and a phone panel that follows a tinted section may have 48 above it, as .vp-sec.vp-gap does. Everything else is BYP's, unchanged.
// Claude runs this file's contents with use_figma on the design file before showing Lewis any mock-up, and fixes every
// finding first. Lewis, 24 Nov 2026: "we need a rule to make sure everything gets checked for consistency to our design rules".
// It checks each top-level frame named "<PREFIX> ... (draft)" at 1440, 768 or 375 against:
//   A. the v5 spacing and type system (Obsidian note 146): section spacing, H1/H2 sizes, strip, buttons, FAQ, cards;
//   B. the type scale (note 146): every text size must be one of the allowed sizes for its width;
//   C. the V4 page rules (note 145): word budget, a picture every two screens, the action in the hero, one heading per
//      section (one job), no small label above a heading (the retired eyebrow), and colours from the palette only.
// Shared parts (Header, Footer, Audience switch row) are skipped: they are checked once, in their own frames.
// Conventions: sections are the frame's direct children; heroes are named "Hero..."; closing strips "For tradespeople",
// "For homeowners" or "Claim strip"; tinted panels "Panel · brand wash", "Six steps", "Quote block" or "Report block";
// FAQ rows "Q · ..."; buttons are instances of "V5 Button". A deeper page has a breadcrumb in its hero. A section whose
// name ends "(reading)" is an SEO reading section and is left out of the word budget (Lewis, 24 Nov: SEO pages keep
// real text). Pictures are image fills, "V5 Seal" marks and frames named "Picture ·", "Screenshot ·", "Illustration ·",
// "Diagram ·" or "Chart ·". A frame whose name contains "Legal" is exempt from the word and picture rules. Text inside a
// "List · ..." frame (business names, link lists: data, not prose; data-list or nav in code) or a "Folded · ..." frame (hidden
// behind a tap, a closed <details> in code) is left out of the word budget.
// D. one pattern library (Obsidian 147, 24 Nov 2026): a hero photo with its brand outline (option A, 24 Nov 2026), no seal beside a heading, "Trio" sections
//    centred, card corners 20 / 28 / 32 or pills, no small label above a card title, the closing strip on cream. Seals no
//    longer count as pictures, and a picture counts from its top to its bottom.
// Form pages ("BYP Form · ...") are tasks: no hero photo, no word or picture budget, deeper-page heading and spacing.
// Record pages ("BYP Profile · ...", "BYP Report · ...", batch 6, 24 Nov 2026): the record is the picture, so the hero
//    shows a "V5 Record card" (or, on a claimed profile, the "V5 Contact card") in place of the hero photo.
// Returns { frameName: [findings] } for frames with findings, plus a count of frames checked.
const PREFIX = 'PX';              // the site's frame prefix on its "05 Templates · Phillips." page
const BRAND = '985830';            // Phillips. amber, for the inline-link rule
const SYS = {
  section: { desk: 120, tab: 96, phone: 64 }, strip: { desk: 72, tab: 72, phone: 56 },
  hero: { desk: [88, 104], tab: [56, 72], phone: [36, 40] }, heroDeeper: { desk: [48, 88], tab: [48, 88], phone: [28, 56] },
  h1: { home: 60, other: 52, phone: 34 }, h2: { desk: 48, panel: 40, phone: 28 }, stripText: { desk: 32, tab: 28, phone: 24 },
  button: 48, headerButton: 40, faq: { pad: 24, desk: 19, phone: 17 }, card: { desk: 32, phone: 24 }, minText: 12,
  // B. type scale: the only sizes allowed (tablet frames inherit the desktop or phone scale)
  scale: { desk: [60, 52, 48, 40, 32, 22, 21, 19, 17, 15, 14, 13], phone: [34, 28, 24, 19, 18, 17, 16, 14, 13] },
  // C. V4 page rules
  words: { phone: 60, desk: 90 }, screen: { phone: 812, tab: 1024, desk: 900 },
  palette: ['f6f4ee', 'f5f2eb', 'ffffff', '14191f', '3a434e', '6e746c', '985830', 'f5ebd9', 'cfcbbf', 'e2dfd5'],
  // status colours (tone/* dot and text): allowed only inside a "Tag" frame, the small dot-and-word status mark on a
  // report or profile row. Never as a wash behind a row or card: the record stays calm (Lewis, 25 Nov 2026: "the useful
  // colours"; memory feedback-calm-record-no-verdict-colours)
  tagTones: ['0b7e58', '10a877', '4e6683', '835b03', 'e0a11a', '7a4f68', '9c6a87', '4a4f49', '8b9088'],
};
// Since 24 Nov 2026 pages are built from instances: a node's kind is its component set (or component) name, so
// "Section · Hero", "Section · Panel", "V5 Button" and so on. Old hand-built frames are still recognised by name.
const kind = n => n && n.type === 'INSTANCE' && n.mainComponent ? (n.mainComponent.parent && n.mainComponent.parent.type === 'COMPONENT_SET' ? n.mainComponent.parent.name : n.mainComponent.name) : (n ? n.name : '');
const KIND = n => n.type === 'INSTANCE' ? kind(n) : n.name;
const isStrip = n => /^(For tradespeople|For homeowners|Claim strip|Section · Closing strip)$/.test(typeof n === 'string' ? n : KIND(n));
const isPanel = n => /^(Panel · brand wash|Six steps|Quote block|Report block|Section · Panel)$/.test(typeof n === 'string' ? n : KIND(n));
const isShared = n => /^(Header|Footer|Audience|V5 Header|V5 Footer|V5 Phone action bar)/.test(KIND(n));
const VARNAME = {}; for (const v of await figma.variables.getLocalVariablesAsync()) VARNAME[v.id] = v.name;
const num = v => typeof v === 'number' ? v : null;
const hex = c => [c.r, c.g, c.b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
const fillKey = n => { const p = n.fills && n.fills[0]; if (!(p && p.type === 'SOLID' && p.visible !== false)) return 'ffffff'; const b = p.boundVariables && p.boundVariables.color; if (b) { const nm = VARNAME[b.id]; return nm === 'surface/desk' ? 'f6f4ee' : nm === 'surface/card' ? 'ffffff' : nm; } return hex(p.color); };
// Figma's visible flag is per node: a text inside a hidden frame is hidden too
const shown = n => { for (let p = n; p && p.type !== 'PAGE'; p = p.parent) if (p.visible === false) return false; return true; };
const inside = (n, root, re) => { for (let p = n.parent; p && p !== root; p = p.parent) if (re.test(p.name)) return true; return false; };
// seals are marks, not pictures (Obsidian 147): only photos, screenshots, illustrations, diagrams and charts count
const isSeal = n => n.type === 'INSTANCE' && n.mainComponent && n.mainComponent.parent && n.mainComponent.parent.name === 'V5 Seal';
const isPicture = n => ('fills' in n && Array.isArray(n.fills) && n.fills.some(p => p.type === 'IMAGE' && p.visible !== false) && !(n.parent && isSeal(n.parent)))
  || (n.type === 'FRAME' && /^(Picture|Screenshot|Illustration|Diagram|Chart) · /.test(n.name))
  || (n.type === 'INSTANCE' && /^V5 (Record card|Report part|Payment diagram|Bar chart|View card|Contact card)$/.test(kind(n)));   // a report part, a customer View card or a claimed profile's Contact card is a drawn record, like a Record card (batch 6)
const page = figma.currentPage; // run it on page 05 Templates (and any page of drafts)
const result = {}; let checked = 0;
for (const f of page.children.filter(n => n.type === 'FRAME' && new RegExp('^' + PREFIX + ' .*\\(draft\\)$').test(n.name) && [1440, 768, 375].includes(Math.round(n.width)))) {
  checked++;
  const size = f.width < 500 ? 'phone' : f.width < 1000 ? 'tab' : 'desk', out = [];
  const legal = /Legal/.test(f.name);
  // a form page ("BYP Form · ...") is a task: no hero photo, exempt from the word and picture rules like a legal page,
  // and its heading and spacing are a deeper page's (batch 5 mock-ups, 24 Nov 2026)
  const form = new RegExp('^' + PREFIX + ' Form · ').test(f.name);
  const secs = f.children.filter(c => (c.type === 'FRAME' || c.type === 'INSTANCE') && c.visible !== false && !isShared(c));
  if (f.children.some(c => c.name.startsWith('Phone action bar'))) out.push('phone action bar is inside the page: move it beside the frame');
  const hero = secs.find(s => /^Hero/.test(s.name) || KIND(s) === 'Section · Hero');
  const deeper = hero && (form || hero.findAll(n => n.type === 'TEXT' && num(n.fontSize) && n.fontSize <= 14 && /\s\/\s/.test(n.characters)).length > 0 || !!hero.findOne(n => n.type === 'INSTANCE' && kind(n) === 'V5 Breadcrumb' && shown(n)));
  const brandHero = hero && (/brand/.test(hero.name) || (hero.type === 'INSTANCE' && /Tone=Brand/.test(hero.mainComponent.name)));
  // A. spacing, headings, strips
  for (const s of secs) {
    let want;
    if (s === hero) want = (deeper ? SYS.heroDeeper : SYS.hero)[size];
    else if (isStrip(s)) want = [SYS.strip[size], SYS.strip[size]];
    else if (s.name === 'Report block') want = size === 'phone' ? [0, 0] : [0, SYS.section[size]];
    else if (isPanel(s) && size === 'phone') want = s.type === 'INSTANCE' ? [s.paddingTop === 64 ? 64 : s.paddingTop === 48 ? 48 : 0, 0] : [48, 48];   // 48: a panel that follows a tinted section (.vp-sec.vp-gap in code)
    else if (/^(Card wrap)$/.test(s.name)) want = [0, SYS.section[size]];
    else if (/^(Business list)$/.test(s.name)) want = [SYS.section[size], 40];
    else if (legal && /\(reading\)$/.test(s.name)) want = [SYS.strip[size], SYS.strip[size]];   // .v-sec.tight in code
    else want = [SYS.section[size], SYS.section[size]];
    // a desktop or tablet panel may sit flush on the section above, as .vp-sec does in code (top 0, or 120 with .vp-gap)
    if (isPanel(s) && size !== 'phone' && s.paddingTop === 0) want = [0, want[1]];
    if (s.paddingTop !== want[0] || s.paddingBottom !== want[1]) out.push(`${s.name}: spacing ${s.paddingTop}/${s.paddingBottom}, system says ${want[0]}/${want[1]}`);
    const heads = s.findAll(n => n.type === 'TEXT' && num(n.fontSize) && n.fontName.style === 'ExtraBold' && n.fontSize >= 24 && !inside(n, s, /^(Stage|Fig|Stat|Picture|Screenshot|Illustration|Diagram|Chart)/));
    for (const t of heads) {
      if (size === 'tab') continue;
      let w;
      if (s === hero) w = size === 'phone' ? SYS.h1.phone : (deeper || brandHero ? SYS.h1.other : SYS.h1.home);
      else w = size === 'phone' ? SYS.h2.phone : isPanel(s) ? SYS.h2.panel : SYS.h2.desk;
      if (t.fontSize !== w) out.push(`${s.name}: heading "${t.characters.slice(0, 24)}" ${t.fontSize}, system says ${w}`);
    }
    // C. one job per section: at most one section heading
    if (s !== hero && heads.length > 1) out.push(`${s.name}: ${heads.length} section headings; one job per section (split it, or make the rest card titles)`);
    // C. no small label above a heading (the retired eyebrow)
    for (const t of heads) { const sib = t.parent.children, i = sib.indexOf(t), prev = i > 0 ? sib[i - 1] : null;
      if (prev && prev.type === 'TEXT' && num(prev.fontSize) && prev.fontSize <= 15 && !/\s\/\s/.test(prev.characters)) out.push(`${s.name}: small label "${prev.characters.slice(0, 20)}" above a heading (no eyebrows)`); }
    if (isStrip(s)) for (const t of s.findAll(n => n.type === 'TEXT' && n.fontName.style === 'Bold')) if (t.fontSize !== SYS.stripText[size]) out.push(`${s.name}: strip text ${t.fontSize}, system says ${SYS.stripText[size]}`);
  }
  // C. the action lives in the hero
  if (hero && !legal && !hero.findOne(n => n.type === 'INSTANCE' && shown(n) && (n.name === 'V5 Button' || kind(n) === 'V5 Button' || kind(n) === 'V5 Search field' || /Hero action/.test(n.name)))) out.push('hero has no action: the main button belongs in the hero');
  // A. buttons, FAQ, cards, smallest text
  for (const b of f.findAll(n => n.type === 'INSTANCE' && shown(n) && (n.name === 'V5 Button' || kind(n) === 'V5 Button'))) {
    const inHeader = !!(function up(n) { return n && n !== f && (/^(Header|V5 Header)/.test(KIND(n)) || up(n.parent)); })(b.parent);
    const small = /Size=Small/.test(b.mainComponent.name);   // a small button (e.g. "Choose a file" in an upload zone) is 40
    const w = inHeader || small ? SYS.headerButton : SYS.button;
    if (Math.round(b.height) !== w) out.push(`button "${(b.findOne(n => n.type === 'TEXT') || {}).characters}" ${Math.round(b.height)} tall, system says ${w}`);
  }
  for (const q of f.findAll(n => shown(n) && ((n.type === 'FRAME' && n.name.startsWith('Q · ')) || (n.type === 'INSTANCE' && kind(n) === 'V5 Question row')))) { const t = q.findOne(n => n.type === 'TEXT'); const w = size === 'phone' ? SYS.faq.phone : SYS.faq.desk; if (q.paddingTop !== SYS.faq.pad || (size !== 'tab' && t && t.fontSize !== w)) { out.push(`FAQ row ${q.paddingTop} padding, question ${t && t.fontSize}; system says ${SYS.faq.pad} and ${w}`); break; } }
  if (size !== 'tab') for (const c of f.findAll(n => shown(n) && ((n.type === 'FRAME' && /^(Card · |Tool · |Checklist · |Chart · )/.test(n.name) && num(n.cornerRadius) > 0) || (n.type === 'INSTANCE' && /^V5 (Card|Bar chart|Record card)$/.test(kind(n)))))) if (c.paddingTop !== SYS.card[size]) out.push(`${c.name}: card padding ${c.paddingTop}, system says ${SYS.card[size]}`);
  const texts = secs.flatMap(s => s.findAll(n => n.type === 'TEXT' && shown(n) && !inside(n, f, /^(Picture|Screenshot|Illustration|Diagram|Chart) · /)));
  for (const t of texts) if (num(t.fontSize) && t.fontSize < SYS.minText) { out.push(`text "${t.characters.slice(0, 20)}" ${t.fontSize}, below ${SYS.minText}`); break; }
  // B. type scale
  if (size !== 'tab') { const off = {}; for (const t of texts) { const z = num(t.fontSize); if (z && !SYS.scale[size].includes(z)) (off[z] = off[z] || []).push(t.characters.slice(0, 18)); }
    for (const [z, l] of Object.entries(off)) out.push(`size ${z} is off the type scale (${l.length}×, e.g. "${l[0]}"); allowed: ${SYS.scale[size].join(', ')}`); }
  // C. no link inside a sentence: a text with an underlined or brand-coloured run among plain words (Lewis 24 Nov 2026)
  for (const t of texts) { if (/^Source/.test(t.characters)) continue; const seg = t.getStyledTextSegments(['fills', 'textDecoration']);
    if (seg.length < 2) continue; const marked = g => g.characters.trim() !== '→' && (g.textDecoration === 'UNDERLINE' || (g.fills[0] && g.fills[0].type === 'SOLID' && hex(g.fills[0].color) === BRAND));
    if (seg.some(marked) && seg.some(g => !marked(g) && g.characters.trim())) { out.push(`link inside a sentence: "${t.characters.slice(0, 30)}"`); break; } }
  // C. colours from the palette only
  const inInstance = n => { for (let p = n; p && p !== f; p = p.parent) if (p.type === 'INSTANCE') return true; return false; };
  const bad = new Set(); for (const n of secs.flatMap(s => [s, ...s.findAll(() => true)])) { if (inInstance(n) || inside(n, f, /^(Picture|Screenshot|Illustration|Diagram|Chart) · /)) continue;
    for (const p of ('fills' in n && Array.isArray(n.fills) ? n.fills : [])) if (p.type === 'SOLID' && p.visible !== false && !SYS.palette.includes(hex(p.color)) && !(SYS.tagTones.includes(hex(p.color)) && inside(n, f, /^Tag$/))) bad.add(hex(p.color));
    for (const p of ('strokes' in n && Array.isArray(n.strokes) && /^Dot$/.test(n.name) ? n.strokes : [])) if (p.type === 'SOLID' && !SYS.palette.includes(hex(p.color)) && !(SYS.tagTones.includes(hex(p.color)) && inside(n, f, /^Tag$/))) bad.add(hex(p.color)); }
  if (bad.size) out.push(`colours off the palette: #${[...bad].join(', #')}`);
  // C. word budget and pictures (not on legal pages)
  if (!legal && !form && size !== 'tab') {
    const body = secs.filter(s => !/\(reading\)$/.test(s.name));
    const words = body.flatMap(s => s.findAll(n => n.type === 'TEXT' && shown(n) && !inside(n, f, /^(Picture|Screenshot|Illustration|Diagram|Chart|List|Folded) · /))).reduce((a, t) => a + t.characters.split(/\s+/).filter(Boolean).length, 0);
    const height = body.reduce((a, s) => a + s.height, 0), screens = Math.max(1, height / SYS.screen[size]);
    if (words / screens > SYS.words[size]) out.push(`word budget: ${Math.round(words / screens)} words a screen, budget ${SYS.words[size]} (hide first: cut, or put it behind a tap)`);
    const top = f.absoluteTransform[1][2];
    const ys = f.findAll(isPicture).filter(n => shown(n) && !inside(n, f, /^(Header|Footer|Audience)/)).map(n => [n.absoluteTransform[1][2] - top, n.absoluteTransform[1][2] - top + n.height]).sort((a, b) => a[0] - b[0]);
    const start = secs.length ? secs[0].y : 0, end = secs.length ? secs[secs.length - 1].y + secs[secs.length - 1].height : f.height;
    let last = start; for (const [y, b] of [...ys.filter(([y]) => y >= start && y <= end), [end, end]]) { if (y - last > 2 * SYS.screen[size]) { out.push(`no picture for ${Math.round((y - last) / SYS.screen[size] * 10) / 10} screens (from ${Math.round(last)}px): a picture every two screens`); } last = Math.max(last, b); }
  }
  // ── one pattern library (Obsidian 147): the same section designs as the home and For tradespeople frames ──
  const recordPage = new RegExp('^' + PREFIX + ' (Profile|Report) · ').test(f.name);
  // a claimed profile's hero shows the Contact card instead (Lewis, 25 Nov 2026: contact details are what claiming adds)
  if (hero && recordPage && !hero.findOne(n => n.type === 'INSTANCE' && /^V5 (Record card|Contact card)$/.test(kind(n)) && shown(n))) out.push('record page hero has no Record card or Contact card: on a profile or report the record is the picture');
  if (hero && !legal && !form && !recordPage) { const ph = hero.findOne(n => n.type === 'INSTANCE' && kind(n) === 'V5 Hero photo' && shown(n)) || hero.findOne(n => isPicture(n) && n.width >= 200 && shown(n)); if (!ph) out.push('hero has no photo: every hero has the portrait photo with its outline'); else if (ph.type !== 'RECTANGLE' && !ph.findOne(n => n.name === 'Outline' && shown(n))) out.push('hero photo has no brand outline behind it (Lewis, 24 Nov 2026: option A)'); }
  for (const s of secs) for (const h of s.findAll(n => n.type === 'TEXT' && num(n.fontSize) && n.fontName.style === 'ExtraBold' && n.fontSize >= 24)) { const sib = h.parent.children, i = sib.indexOf(h);
    if ([sib[i - 1], sib[i + 1]].some(x => x && isSeal(x)) && h.parent.layoutMode === 'HORIZONTAL') out.push(`${s.name}: seal beside the heading "${h.characters.slice(0, 24)}" (the baseline has none)`); }
  for (const s of secs.filter(s => /^Trio/.test(s.name) || KIND(s) === 'Section · Trio')) for (const t of s.findAll(n => n.type === 'TEXT' && shown(n))) if (t.textAlignHorizontal !== 'CENTER' && size !== 'phone') { out.push(`${s.name}: trio is not centred`); break; }
  if (size !== 'tab') { const bad = new Set(); for (const c of f.findAll(n => shown(n) && (((n.type === 'FRAME') && /^(Card · |Panel|Tool · |Checklist · |Chart · )/.test(n.name)) || (n.type === 'INSTANCE' && /^V5 (Card|Record card|Bar chart|Town card)$/.test(kind(n)))) && num(n.cornerRadius) > 0)) if (![20, 28, 32].includes(c.cornerRadius) && c.cornerRadius < c.height / 2) bad.add(c.cornerRadius); if (bad.size) out.push(`card corners off the system (20, 28 photo, 32 panel, pills): ${[...bad].join(', ')}`); }
  for (const s of secs) for (const h of s.findAll(n => n.type === 'TEXT' && num(n.fontSize) && n.fontSize >= 17 && n.fontSize <= 22 && /Bold/.test(n.fontName.style))) { const sib = h.parent.children, i = sib.indexOf(h), prev = i > 0 ? sib[i - 1] : null;
    if (prev && prev.type === 'TEXT' && num(prev.fontSize) && prev.fontSize <= 15 && prev.characters.trim() && h.parent.layoutMode !== 'HORIZONTAL') { out.push(`${s.name}: small label "${prev.characters.slice(0, 20)}" above a card title (no labels)`); break; } }
  const lastSec = secs[secs.length - 1]; if (lastSec && isStrip(lastSec) && fillKey(lastSec) !== 'f6f4ee') out.push(`${lastSec.name}: the closing strip is always on cream`);
  for (let i = 1; i < secs.length; i++) if (fillKey(secs[i]) === fillKey(secs[i - 1]) && !isPanel(secs[i]) && !isPanel(secs[i - 1]) && !/^(Card wrap)$/.test(secs[i].name)) out.push(`${secs[i - 1].name} and ${secs[i].name} share a background`);
  if (out.length) result[f.name.replace(new RegExp('^' + PREFIX + ' '), '') + ' @' + Math.round(f.width)] = out;
}
return { checked, findings: result };
