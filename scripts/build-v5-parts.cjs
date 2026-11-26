'use strict';
// build-v5-parts.cjs: writes the v5 parts into the Phillips. pages, between <!-- v5:<name> --> and <!-- /v5:<name> -->
// markers, so a part changed once changes everywhere (Before You Pay's pattern; this site's copy of the Phillips Group
// pilot's script, 26 Nov 2026).
//   scripts/v5-parts.cjs   Before You Pay's parts, copied unchanged
//   scripts/v5-chrome.cjs  the group header and light footer, shared by every group site (copied unchanged)
//   below                  this site's words for them: the logo, the header button, the footer columns, the "Ask me a
//                          question" form and the Monday Brief sign-up (their script hooks are in .design/contract.md)
// Everything else on the pages is hand-written.
//   node scripts/build-v5-parts.cjs           write the parts
//   node scripts/build-v5-parts.cjs --check   fail if a page is out of date
const fs = require('fs'), path = require('path');
const V = require('./v5-parts.cjs');
const C = require('./v5-chrome.cjs');
const ROOT = path.join(__dirname, '..');

// The P. tile (favicon.svg's own drawing), once per page as a symbol, used by the header and footer logos.
const MARK = fs.readFileSync(path.join(__dirname, 'px-mark.txt'), 'utf8').trim();
const DEFS = `<svg class="sr" width="0" height="0" aria-hidden="true"><symbol id="px-mark" viewBox="0 0 240 240">${MARK}</symbol></svg>`;
const LOGO = `<svg class="mark" viewBox="0 0 240 240" width="32" height="32" aria-hidden="true"><use href="#px-mark"/></svg><span>Phillips.</span>`;
const LABEL = 'Phillips. home';

// The header: the logo and one button, "Free checks" (Lewis, 26 Nov 2026: the other links live in the footer).
const header = here => C.header({ home: '/', logo: LOGO, label: LABEL, button: { href: '/free-checks/', label: 'Free checks', attrs: here === 'free-checks' ? ' aria-current="page"' : '' } });
// The footer: Services, Free checks, Phillips. The contact link goes to the form (#contact on pages that have it).
const footer = ({ contact }) => C.footer({ home: '/', logo: LOGO, label: LABEL, name: 'Phillips.', tagline: 'I plan the marketing, then I do the work.', here: 'phillips',
  cols: [
    ['Services', [['Web design', '/web-design/'], ['Local SEO', '/local-seo/'], ['Google Ads', '/google-ads/'], ['Marketing systems', '/marketing-systems/'], ['Consultancy', '/consultancy/']]],
    ['Free checks', [['Google Ads Check', '/google-ads-audit'], ['Website Check', '/website-check/'], ['Guides', '/guides/'], ['The Monday Brief', '/updates/']]],
    ['Phillips.', [['Work', '/work/'], ['About', '/about/'], ['Ask me a question', contact ? '#contact' : '/#contact']]],
  ],
  base: [['Privacy', '/privacy/'], ['Terms', '/terms/'], ['Cookie settings', '/privacy/#cookies', ' data-cookie-settings']] });

// "Ask me a question" (contact-form.js posts it to /enquiry; cloudflare/src/enquiry.js). Every hook the script and the
// Worker read stays: form.enquiry, action="/enquiry", data-location, the fields name, email, business, message, the trap
// company_url, .enquiry-foot (Turnstile goes in before it), .enquiry-status and the submit button.
const contact = ({ h, l, loc }) => `<section class="v-sec bg-stone" id="contact">
  <div class="v-wrap vf-grid">
    <div data-v5>
      <h2 class="v-h2" id="contact-title">${h}</h2>
      <p class="v-body">${l}</p>
    </div>
    <div data-v5>
      <form class="enquiry" action="/enquiry" method="post" data-location="${loc}" novalidate aria-labelledby="contact-title">
        <div class="vfield field"><label for="f-name">Your name</label><input id="f-name" name="name" autocomplete="name" maxlength="120" required></div>
        <div class="vfield field"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" maxlength="160" required></div>
        <div class="vfield field"><label for="f-business">Business or website <span class="opt">Optional</span></label><input id="f-business" name="business" autocomplete="organization" maxlength="160"></div>
        <div class="vfield field"><label for="f-message">Your question</label><textarea id="f-message" name="message" rows="5" maxlength="4000" required></textarea></div>
        <label class="enquiry-trap" aria-hidden="true">Leave this empty <input name="company_url" tabindex="-1" autocomplete="off"></label>
        <div class="enquiry-foot"><button type="submit" class="vb vb-p enquiry-btn">Send my question</button><p class="enquiry-note">I use these details only to reply to you.</p></div>
        <p class="enquiry-status" role="status" aria-live="polite"></p>
      </form>
      <p class="contact-alt">Prefer LinkedIn? ${V.go('https://www.linkedin.com/in/lewis-p-153b2119a/', 'Message me there', ' target="_blank" rel="noopener noreferrer"')}</p>
    </div>
  </div>
</section>`;

// The Monday Brief sign-up (brief-form.js posts it to /subscribe; double opt-in). The sign-up wording is unchanged.
const brief = ({ loc, h = 'What changed in marketing last week, every Monday.', l = 'One email every Monday morning on what changed in the ad and search platforms, and what it means for your account.' }) => `<section class="v-sec" id="brief">
  <div class="v-wrap vf-grid">
    <div data-v5>
      <h2 class="v-h2" id="brief-title">${h}</h2>
      <p class="v-body">${l}</p>
    </div>
    <div data-v5>
      <form class="brief-signup" action="/subscribe" method="post" data-location="${loc}" novalidate aria-labelledby="brief-title">
        <div class="brief-row"><div class="vfield field"><label for="brief-email-${loc}">Email</label><input id="brief-email-${loc}" name="email" type="email" autocomplete="email" inputmode="email" maxlength="160" required></div><button type="submit" class="vb vb-p brief-btn">Get the Brief</button></div>
        <label class="brief-trap" aria-hidden="true">Leave this empty <input name="company_url" tabindex="-1" autocomplete="off"></label>
        <p class="v-fine">One email every Monday morning on what changed in the ad and search platforms, and what it means for your account. I email you first to confirm. Unsubscribe any time.</p>
        <p class="v-fine"><a class="v-go" href="/privacy/">Privacy notice <span aria-hidden="true">→</span></a></p>
        <p class="brief-status" role="status" aria-live="polite"></p>
      </form>
    </div>
  </div>
</section>`;

// Each page: its key (for the header's current link), whether it has the contact form, and its own parts.
const page = (here, o = {}) => ({
  'defs': () => DEFS,
  'header': () => header(here),
  'footer': () => footer({ contact: !!o.contact }),
  ...(o.contact ? { 'contact': () => contact(o.contact) } : {}),
  ...(o.brief ? { 'brief': () => brief(o.brief) } : {}),
  ...(o.parts || {}),
});

const PAGES = {
  'privacy/index.html': page('privacy', { parts: { crumb: () => V.crumb([['Home', '/'], ['Privacy']]) } }),
  'terms/index.html': page('terms', { parts: { crumb: () => V.crumb([['Home', '/'], ['Terms']]) } }),
  '404.html': page('404'),
  'about/index.html': page('about', { contact: { h: 'Ask me a question.', l: 'I can do the marketing instead of a hire, or work alongside your team. Tell me about the business and what you want to change, and I’ll reply by email.', loc: 'about' } }),
  'work/index.html': page('work', { contact: { h: 'Want work like this?', l: 'Write a few lines about your business and what you’d like to change, and anything you want to ask. I’ll reply by email.', loc: 'work' } }),
  'google-ads/index.html': page('google-ads', { contact: { h: 'Ask me a question about Google Ads.', l: 'Write a few lines about the business, what you’d like to change and anything you want to ask. I’ll reply by email.', loc: 'google-ads' }, parts: { crumb: () => V.crumb([['Home', '/'], ['Google Ads']]) } }),
  'web-design/index.html': page('web-design', { contact: { h: 'Tell me about your website.', l: 'Write a few lines about the business, what you’d like to change and anything you want to ask. I’ll reply by email.', loc: 'web-design' }, parts: { crumb: () => V.crumb([['Home', '/'], ['Web design']]) } }),
  'local-seo/index.html': page('local-seo', { contact: { h: 'Find out where you stand.', l: 'Write a few lines about the business, what you’d like to change and anything you want to ask. I’ll reply by email.', loc: 'local-seo' }, parts: { crumb: () => V.crumb([['Home', '/'], ['Local SEO']]) } }),
  'marketing-systems/index.html': page('marketing-systems', { contact: { h: 'Tell me where things slip.', l: 'Write a few lines about the business, what you’d like to change and anything you want to ask. I’ll reply by email.', loc: 'marketing-systems' }, parts: { crumb: () => V.crumb([['Home', '/'], ['Marketing systems']]) } }),
  'consultancy/index.html': page('consultancy', { contact: { h: 'Talk about what you need.', l: 'Write a few lines about the company, the channels and what you need help with. I’ll reply by email.', loc: 'consultancy' }, parts: { crumb: () => V.crumb([['Home', '/'], ['Consultancy']]) } }),
  'free-checks/index.html': page('free-checks', { contact: { h: 'Ask me a question.', l: 'Tell me about the business and what you’d like to change. If you’ve run a check, mention it. I’ll reply by email.', loc: 'free-checks' } }),
};

function build(rel, html) {
  for (const [name, make] of Object.entries(PAGES[rel])) {
    const a = `<!-- v5:${name} -->`, b = `<!-- /v5:${name} -->`, i = html.indexOf(a), j = html.indexOf(b);
    if (i < 0 || j < i) throw new Error(`${rel}: markers for "${name}" missing`);
    html = html.slice(0, i + a.length) + make() + html.slice(j);
  }
  return html;
}

if (require.main === module) {
  const check = process.argv.includes('--check'); let stale = 0;
  for (const rel of Object.keys(PAGES)) {
    const f = path.join(ROOT, rel), was = fs.readFileSync(f, 'utf8'), now = build(rel, was);
    if (check) { if (now !== was) { stale++; console.error(`${rel}: out of date, run node scripts/build-v5-parts.cjs`); } }
    else if (now !== was) { fs.writeFileSync(f, now); console.log(`${rel}: parts written`); }
  }
  if (stale) process.exit(1);
  if (check) console.log('v5 parts: pages up to date');
}
module.exports = { build, PAGES, contact, brief, header, footer, LOGO, DEFS };
