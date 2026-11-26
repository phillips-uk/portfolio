'use strict';
// v5-parts.js: every repeated part of a v5 page, written once (Lewis, 24 Nov 2026: "we edit that one button, and it changes
// across the website"; Obsidian 148). Each part here matches one Figma component (file 7YVrt8qdoW6C1K0arY6aXI, page 03
// Components) and one class in assets/v5.css. Change a part here and every page built from it follows:
//   scripts/build-quote-tool.cjs, scripts/build-check-my-quote.cjs, netlify/functions/trade-directory.js (live), and
//   scripts/build-v5-parts.cjs, which writes the parts into the hand-written pages (index.html, for-tradespeople) between
//   <!-- v5:<name> --> markers.
// A new kind of part needs Lewis's yes first, then it is added here and in Figma together.

// Seal: our own marks (Figma "V5 Seal"; .seal, .seal.sm, .seal.inv)
const SEAL = {
  record: '<svg viewBox="0 0 24 24"><path d="M4 9.25 12 5l8 4.25"/><path d="M6 10.5v6.5M10 10.5v6.5M14 10.5v6.5M18 10.5v6.5"/><path d="M4 19h16"/></svg>',
  ask: '<svg viewBox="0 0 24 24"><path d="M6.25 4.75h11.5a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-6l-4.25 3.25v-3.25H6.25a2 2 0 0 1-2-2v-7.5a2 2 0 0 1 2-2z"/><path d="M10.1 8.7a1.95 1.95 0 1 1 2.75 1.78c-.5.23-.85.7-.85 1.25v.27"/><circle class="f" cx="12" cy="14.1" r="1"/></svg>',
  identity: '<svg viewBox="0 0 24 24"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2"/><circle cx="9.25" cy="11" r="2"/><path d="M6.25 16c.5-1.5 1.6-2.25 3-2.25s2.5.75 3 2.25M14.5 10h2.75M14.5 13h2.75"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M7 4.25h7l4.25 4.25V18a1.75 1.75 0 0 1-1.75 1.75H7A1.75 1.75 0 0 1 5.25 18V6A1.75 1.75 0 0 1 7 4.25z"/><path d="M13.75 4.5V8.75H18"/><path d="m8.75 13.75 2 2 4-4.25"/></svg>',
  source: '<svg viewBox="0 0 24 24" class="s34"><path d="M11.1 4.25H5.75a1.5 1.5 0 0 0-1.5 1.5v5.35c0 .4.16.78.44 1.06l7.2 7.2a1.5 1.5 0 0 0 2.12 0l5.29-5.29a1.5 1.5 0 0 0 0-2.12l-7.2-7.2a1.5 1.5 0 0 0-1.06-.5z"/><circle class="f" cx="8.4" cy="8.4" r="1.3"/></svg>',
};
const seal = (mark, cls = '') => `<span class="seal${cls}" aria-hidden="true">${SEAL[mark]}</span>`;

// Breadcrumb (Figma "V5 Breadcrumb"; .vd-crumb): [label, href] pairs, the last without a link
const crumb = items => `<nav class="vd-crumb" aria-label="Breadcrumb">${items.map(([l, h]) => h ? `<a href="${h}">${l}</a>` : `<span class="here">${l}</span>`).join('<span aria-hidden="true">/</span>')}</nav>`;

// Button (Figma "V5 Button"; .vb): style p (primary), t (tint), w (white / on brand)
const button = ({ href, label, style = 'p', cta, attrs = '' }) => `<a class="vb vb-${style}" href="${href}"${cta ? ` data-cta="${cta}"` : ''}${attrs}>${label}</a>`;

// Arrow link (Figma "V5 Arrow link"; .v-go): the action after a sentence, never inside it
const go = (href, label, attrs = '') => `<a class="v-go" href="${href}"${attrs}>${label} <span aria-hidden="true">→</span></a>`;

// Show more (Figma "V5 Show more"; .vd-more): reveals the rest of a capped list, which stays in the page
// (no target: the button reveals its own parent)
const more = (target, label, cls = ' vchk-more') => `<button class="vd-more${cls}" type="button" data-v5-more${target ? `="${target}"` : ''}>${label}</button>`;

// Hero photo (Figma "V5 Hero photo"; .vh-photo): a photo or screenshot with its offset outline in the brand colour behind it
// (Lewis, 24 Nov 2026, option A: replaces the seal on its corner; drawn in CSS, so each brand mode recolours it)
const heroPhoto = ({ src, srcset, sizes = '(max-width:960px) 92vw, 420px', width = 1000, height = 750, alt, style, imgClass, cls = '' }) =>
  `<figure class="vh-photo${cls}"><img${imgClass ? ` class="${imgClass}"` : ''} src="${src}" srcset="${srcset}" sizes="${sizes}" width="${width}" height="${height}" alt="${alt}"${style ? ` style="${style}"` : ''} fetchpriority="high"></figure>`;

// A picture in a section (Figma "V5 Split picture", "V5 Panel screenshot", "V5 Card screenshot"): .vsplit-pic .vf-pic,
// .vp-shot, .vd-card-shot. ratio sets an aspect-ratio style when the shape must be held before the image loads.
const picture = ({ cls, src, srcset, sizes, width, height, ratio, alt, lazy = true }) =>
  `<figure class="${cls}"><img src="${src}"${srcset ? ` srcset="${srcset}"` : ''}${sizes ? ` sizes="${sizes}"` : ''} width="${width}" height="${height}"${ratio ? ` style="${ratio}"` : ''} alt="${alt}"${lazy ? ' loading="lazy"' : ''}></figure>`;

// Trio item (Figma "V5 Trio item"; .vm li): a seal, a title and a line (phone: a shorter line, when given)
const trioItem = ({ mark, title, line, phone, link = '' }) => `<li data-v5>${seal(mark)}<div><h3 class="v-h3">${title}</h3>${phone ? `<p class="v-body dt">${line}</p><p class="v-body ph">${phone}</p>` : `<p class="v-body">${line}</p>`}${link}</div></li>`;
const trio = (items, cls = 'vm', indent = '      ') => `<ul class="${cls}">\n${items.map(i => indent + trioItem(i)).join('\n')}\n${indent.slice(2)}</ul>`;

// Tick rows (Figma "V5 Tick row"; .vf, .vchk): a title and a line, or plain lines
const tickRows = (items, attrs = ' data-v5', indent = '      ') => `<ul class="vf"${attrs}>\n${items.map(([b, s]) => `${indent}<li><b>${b}</b><span>${s}</span></li>`).join('\n')}\n${indent.slice(2)}</ul>`;
const checkList = (id, items, cap = 3) => `<ul class="vchk cap" id="${id}">${items.map(x => `<li>${x}</li>`).join('')}</ul>${more('#' + id, `Show ${items.length - cap} more`)}`;

// Question row (Figma "V5 Question row"; .vq details, .vfold): the FAQ, and every fold
const question = ({ q, a, h3 = false, after = '' }) => `<details><summary>${h3 ? `<h3>${q}</h3>` : q}</summary><p>${a}</p>${after}</details>`;
// FAQ section (Figma "Section · FAQ"; .vq): heading left, plain questions right
const faq = ({ heading, rows, id = 'faq', bg = '', attrs = '', after = '' }) => `<section class="v-sec${bg}" id="${id}"${attrs}>
  <div class="v-wrap vq">
    <h2 class="v-h2" data-v5>${heading}</h2>
    <div data-v5>
${rows.map(r => '      ' + question(r)).join('\n')}${after ? '\n      ' + after : ''}
    </div>
  </div>
</section>`;

// Closing strip (Figma "Section · Closing strip"; .vt): the last section, always on cream
const strip = ({ id, line, actions }) => `<section class="v-sec tight bg-stone" id="${id}">
  <div class="v-wrap vt">
    <p>${line}</p>
    ${actions}
  </div>
</section>`;

// Record card (Figma "V5 Record card"; .vrec): a drawn record, labelled, used as the picture for a point. rows: [fact, value]
const record = ({ title, note = 'Example only', rows, label, attrs = '' }) => `<figure class="vrec"${label ? ` role="img" aria-label="${label}"` : ''}${attrs}><p class="vrec-hd"><b>${title}</b><span>${note}</span></p><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></figure>`;
// Figures (Figma "V5 Figure", "Section · Figures"; .vfigs): real, dated figures. items: [number html, label, attrs]
const figures = (items, cls = '') => `<div class="vfigs${cls}">${items.map(([n, l, a = '']) => `<div${a}><b>${n}</b><p>${l}</p></div>`).join('')}</div>`;
// Fold (Figma "V5 Question row"; .vfold): a heading that opens to its text
const fold = (summary, body) => `<details class="vfold"><summary>${summary}</summary><div>${body}</div></details>`;

module.exports = { record, figures, fold, SEAL, seal, crumb, button, go, more, heroPhoto, picture, trioItem, trio, tickRows, checkList, question, faq, strip };
