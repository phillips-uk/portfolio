'use strict';
// v5-chrome.cjs: the group header and the light group footer, written once for every group site (the Phillips Group
// pilot, 25 Nov 2026; shared notes v5-kit.md). Copied unchanged to each site, next to scripts/v5-parts.cjs (Before You
// Pay's parts). The styles are the "Group chrome" section of tokens/v5-core.css; Figma "V5 Header" and "V5 Footer" with
// "V5 Group footer row". The footer follows the group footer template (vault 00_Footer Template - Group Sites.md).
// Each site's scripts/build-v5-parts.cjs calls these with its own logo, links and words, and writes the result between
// <!-- v5:header --> and <!-- v5:footer --> markers.

// The five businesses, always in this order (Lewis, 21 Nov 2026). key: the site's own key, for "here".
const GROUP = [
  ['tdo', 'The Director’s Office', 'https://thedirectorsoffice.uk/'],
  ['phillips', 'Phillips.', 'https://www.phillips-uk.com/'],
  ['byp', 'Before You Pay', 'https://beforeyoupay.uk/'],
  ['ip', 'Index Point', 'https://indexpoint.uk/'],
  ['sd', 'Search Desk', 'https://searchdesk.uk/'],
];
const LEGAL = name => `${name} is a trading name of PHILLIPSGROUPUK LIMITED, registered in England and Wales, company number 17567515. Registered office: 124-128 City Road, London, EC1V 2NX.`;
const a = ([label, href, attrs = '']) => `<a href="${href}"${attrs}>${label}</a>`;

// logo: the lockup's inner markup (an <svg> and the name); links: [label, href, attrs] (add class="wide" to hide one on
// phones); button: the one header button { href, label, attrs }
const header = ({ home = '/', logo, label, links = [], button }) => `<header class="vhd">
  <div class="vhd-in">
    <a class="vhd-logo" href="${home}" aria-label="${label}">${logo}</a>
    <nav class="vhd-nav" aria-label="Main">${links.map(l => a(l)).join('')}${button ? `<a class="vb vb-p" href="${button.href}"${button.attrs || ''}>${button.label}</a>` : ''}</nav>
  </div>
</header>`;

// cols: up to three [heading, [[label, href, attrs]]]; here: this site's key in GROUP (its name is semibold and not a
// link), or null on phillips-group.uk, where all five are links and the label is the group's own name; base: the bottom
// line's links after the copyright ([label, href, attrs]); note: an optional disclaimer line above the legal line.
const footer = ({ home = '/', logo, label, name, tagline, cols = [], here = null, base = [], note = '' }) => `<footer class="vgf" id="site-footer">
  <div class="vgf-in">
    <div class="vgf-top">
      <div class="vgf-brand"><a class="vhd-logo" href="${home}" aria-label="${label}">${logo}</a><p>${tagline}</p></div>
      <nav class="vgf-cols" aria-label="Footer">${cols.map(([h, ls]) => `<div><h2 class="vgf-h">${h}</h2><ul>${ls.map(l => `<li>${a(l)}</li>`).join('')}</ul></div>`).join('')}</nav>
    </div>
    <nav class="vgf-group" aria-label="Phillips Group"><span class="k">${here ? 'Part of Phillips Group' : 'Phillips Group'}</span> ${GROUP.map(([k, n, u]) => k === here ? `<b>${n}</b>` : `<a href="${u}">${n}</a>`).join(' ')}</nav>
    <div class="vgf-base"><span>&copy; 2026 ${name} <span class="l">${base.map(l => a(l)).join('')}</span></span><a class="vgf-pb" href="https://www.phillips-uk.com/" target="_blank" rel="noopener">Powered by Phillips.</a></div>
    ${note ? `<p class="vgf-note">${note}</p>\n    ` : ''}<p class="vgf-legal">${LEGAL(name)}</p>
  </div>
</footer>`;

module.exports = { GROUP, LEGAL, header, footer };
