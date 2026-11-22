// The Website Check's rules (plan section 4). Fixed, written rules only: no AI of any kind. Each rule looks at what was
// fetched from the visitor's site (the page, robots.txt, the sitemap, llms.txt, PageSpeed Insights) and gives a
// strength or a weakness, with why it matters and where to start. Pure functions, so they can be tested without a network.
//
// A finding: { id, group, status: 'strength' | 'weakness' | 'note', priority: 'high' | 'medium' | 'low', title, detail,
//              why, start, link: { href, label } }

export const RULES_VERSION = 7; // 2 (17 Nov 2026): quotes credited to a person count as reviews. 3 (18 Nov 2026): UK-wide
// businesses aren't asked for a town, a Maps link or local business details; "Rated 4.8 on Checkatrade" counts as a review. 4
// (18 Nov 2026): the report carries a profile of the site (siteProfile). 5 (21 Nov 2026): three kinds of business
// (MODELS), chosen on the form or detected; local checks only for local businesses, delivery and returns for shops. 6
// (21 Nov 2026, Website Check v2 step 2): what Google's speed test says to fix first, accessibility and best practices
// from the same test, link previews, canonical, language, hreflang, missing pages, mixed content, security headers,
// privacy, cookie consent, company details and form length. 7 (21 Nov 2026, step 3): up to 25 pages scanned for broken
// links, redirects, titles, descriptions, headings, noindex, sitemap, thin pages, images and key pages

// What kind of business the check judges the site as (Lewis, 21 Nov 2026: not everyone who runs it is local). The visitor
// can pick one on the form; otherwise it is detected from the page (detectModel) and the report offers a switch.
export const MODELS = { local: 'a local business', national: 'a business with regional or UK-wide customers', shop: 'an online shop' };

const LINKS = {
  web: { href: '/web-design/', label: 'Web design' },
  seo: { href: '/local-seo/', label: 'Local SEO and AI search' },
  systems: { href: '/marketing-systems/', label: 'Marketing systems' },
  tracking: { href: '/guides/fix-google-ads-conversion-tracking/', label: 'Guide: fix conversion tracking' },
};

export const GROUPS = [
  ['site', 'Across the site'],
  ['speed', 'Speed'],
  ['mobile', 'Phones'],
  ['access', 'Accessibility'],
  ['first', 'First impression'],
  ['contact', 'Contact details'],
  ['search', 'Search basics'],
  ['share', 'Link previews'],
  ['technical', 'Technical'],
  ['ai', 'AI search'],
  ['measure', 'Measuring enquiries'],
  ['trust', 'Trust and legal'],
  ['proof', 'Reviews and proof'],
];

// ---------- HTML helpers (regex based: enough for these checks, no DOM in a Worker) ----------

const decode = s => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&(lsaquo|rsaquo|laquo|raquo|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo|pound|copy|reg|trade|middot|bull);/gi, (_, k) => ({ lsaquo: '‹', rsaquo: '›', laquo: '«', raquo: '»', ndash: '–', mdash: '\u2014', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' })[k.toLowerCase()]);
const squash = s => decode(s).replace(/\s+/g, ' ').trim();
const stripTags = s => squash(String(s || '').replace(/<[^>]+>/g, ' '));

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function metaContent(html, key) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    const n = (attr(t, 'name') || attr(t, 'property') || '').toLowerCase();
    if (n === key) return attr(t, 'content');
  }
  return null;
}

export function parsePage(html) {
  const raw = String(html || '');
  const noScripts = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const bodyStart = noScripts.search(/<body\b/i);
  const body = bodyStart >= 0 ? noScripts.slice(bodyStart) : noScripts;
  const text = stripTags(body);

  const title = (raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const h1s = [...noScripts.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => stripTags(m[1])).filter(Boolean);
  const links = [...noScripts.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m => ({ href: attr(m[0], 'href') || '', text: stripTags(m[0]), at: m.index }));
  const imgs = [...noScripts.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const forms = [...noScripts.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map(m => m[0]);

  const jsonLd = [];
  for (const m of raw.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonLd.push(JSON.parse(m[1].trim())); } catch { jsonLd.push({ __invalid: true }); }
  }

  const headerEnd = (() => {
    const h = body.search(/<\/header>/i);
    return h > 0 ? h : Math.min(body.length, Math.max(4000, Math.floor(body.length * 0.2)));
  })();
  const bodyOffset = bodyStart >= 0 ? bodyStart : 0;

  return {
    raw, body, text,
    lang: attr((raw.match(/<html\b[^>]*>/i) || [''])[0], 'lang'),
    title: title ? squash(title) : '',
    description: squash(metaContent(raw, 'description') || ''),
    robotsMeta: (metaContent(raw, 'robots') || '').toLowerCase(),
    viewport: metaContent(raw, 'viewport'),
    canonical: (() => { const m = raw.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i); return m ? attr(m[0], 'href') : null; })(),
    ogTitle: metaContent(raw, 'og:title'),
    ogDescription: metaContent(raw, 'og:description'),
    ogImage: metaContent(raw, 'og:image') || metaContent(raw, 'og:image:url') || metaContent(raw, 'og:image:secure_url'),
    hreflangs: [...raw.matchAll(/<link\b[^>]*hreflang\s*=[^>]*>/gi)].map(m => ({ lang: attr(m[0], 'hreflang'), href: attr(m[0], 'href') })).filter(h => h.href),
    // The footer's words (where a company number and a privacy link usually sit), else the page's last lines
    footer: (() => { const i = body.search(/<footer\b/i); return i >= 0 ? stripTags(body.slice(i)) : text.slice(-1500); })(),
    h1s, links, imgs, forms, jsonLd,
    top: { html: body.slice(0, headerEnd + 3000), text: stripTags(body.slice(0, headerEnd + 3000)).slice(0, 1500), linkLimit: bodyOffset + headerEnd + 3000 },
  };
}

// Every @type in the page's JSON-LD (including @graph), with the objects themselves.
export function schemaNodes(jsonLd) {
  const out = [];
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n['@type']) out.push(n);
    if (n['@graph']) walk(n['@graph']);
    for (const k of ['provider', 'publisher', 'author', 'brand', 'mainEntity', 'about', 'itemReviewed']) if (n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  jsonLd.forEach(walk);
  return out;
}
const typesOf = n => [].concat(n['@type'] || []).map(String);

const LOCAL_TYPES = new Set(['LocalBusiness', 'ProfessionalService', 'HomeAndConstructionBusiness', 'Plumber', 'Electrician', 'HVACBusiness', 'RoofingContractor', 'GeneralContractor', 'HousePainter', 'Locksmith', 'MovingCompany', 'Restaurant', 'CafeOrCoffeeShop', 'FoodEstablishment', 'BarOrPub', 'Bakery', 'Brewery', 'Winery', 'FastFoodRestaurant', 'IceCreamShop', 'Store', 'HairSalon', 'BeautySalon', 'NailSalon', 'DaySpa', 'HealthAndBeautyBusiness', 'TattooParlor', 'Dentist', 'MedicalBusiness', 'MedicalClinic', 'Physician', 'Optician', 'Pharmacy', 'Physiotherapy', 'LegalService', 'Attorney', 'Notary', 'AccountingService', 'FinancialService', 'InsuranceAgency', 'RealEstateAgent', 'AutoRepair', 'AutomotiveBusiness', 'AutoDealer', 'AutoBodyShop', 'LodgingBusiness', 'Hotel', 'BedAndBreakfast', 'Campground', 'SportsActivityLocation', 'ExerciseGym', 'ChildCare', 'VeterinaryCare', 'AnimalShelter', 'EmploymentAgency', 'TravelAgency', 'Florist', 'EntertainmentBusiness', 'ArtGallery', 'DryCleaningOrLaundry', 'SelfStorage', 'ShoppingCenter', 'EmergencyService', 'GovernmentOffice', 'RadioStation', 'RecyclingCenter', 'TouristInformationCenter', 'Library', 'InternetCafe', 'PawnShop', 'HomeGoodsStore', 'HardwareStore', 'GardenStore', 'PetStore', 'JewelryStore', 'ShoeStore', 'ClothingStore', 'BookStore', 'BikeStore', 'FurnitureStore', 'ElectronicsStore', 'GroceryStore', 'LiquorStore', 'MobilePhoneStore', 'OfficeEquipmentStore', 'OutletStore', 'SportingGoodsStore', 'ToyStore', 'WholesaleStore', 'ConvenienceStore', 'DepartmentStore', 'AutoPartsStore', 'ComputerStore', 'HobbyShop', 'MensClothingStore', 'MusicStore', 'TireShop']);
const isLocalType = t => LOCAL_TYPES.has(t) || /(Store|Business|Contractor|Service|Shop|Salon|Clinic|Agency)$/.test(t);

// ---------- contact detail helpers ----------

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/;
const POSTCODE_G = /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/g;
const UK_PHONE_G = /(?:\+44\s?\(?0?\)?\s?|\(?\b0)(?:\d[\s-]?\)?){9,10}\b/g;
const EMAIL_G = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const normPhone = p => { let d = String(p).replace(/[^\d+]/g, ''); if (d.startsWith('+44')) d = '0' + d.slice(3).replace(/^0/, ''); else if (d.startsWith('0044')) d = '0' + d.slice(4); return d.replace(/\D/g, ''); };
const isPhoneLike = d => /^0\d{9,10}$/.test(d);

const GBP_LINK = /(g\.page\/|maps\.app\.goo\.gl\/|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.|business\.google\.com|g\.co\/kgs|search\.google\.com\/local\/writereview)/i;
// Review services are counted only as links or embedded widgets (a name in the text may just be a former employer);
// phrases are counted in the visible text.
const REVIEW_LINKS = /(trustpilot\.com\/review|widget\.trustpilot|reviews\.io|feefo\.com|trustindex\.io|elfsight|birdeye\.com|yotpo|judge\.me|okendo|stamped\.io|checkatrade\.com\/trades|trustatrader\.com\/traders|ratedpeople\.com\/profile|mybuilder\.com\/profile|yell\.com\/biz|which\.co\.uk\/trusted-traders|search\.google\.com\/local\/reviews)/i;
// A quote credited to a named person (a <blockquote> with a <cite>), or a block whose class says testimonial or review.
const QUOTE_CITE = /<blockquote\b[^>]*>(?:(?!<\/blockquote>)[\s\S]){10,2000}?<cite\b[^>]*>([\s\S]{2,120}?)<\/cite>/i;
const REVIEW_CLASS = /class="[^"]*\b(testimonials?|reviews?)\b[^"]*"/i;
const REVIEW_TEXT = /(\brated \d(?:\.\d)? (?:out of 5 |stars? )?(?:on|by)\b|\b(?:checkatrade|trustatrader|trustpilot|capterra|feefo)\b|testimonials?\b|customer reviews|google reviews|what (?:our|my) (?:customers|clients) say|\b\d(?:\.\d)? out of 5\b|\bfive[- ]star|\b5[- ]star|★★★)/i;

// ---------- robots.txt ----------

// Is this crawler blocked from the whole site? Simple group parser: the bot's own group if it has one, otherwise '*'.
export function robotsBlocks(robotsTxt, bot) {
  if (!robotsTxt) return false;
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const line of String(robotsTxt).split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    if (!l) continue;
    const [k, ...rest] = l.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'disallow' || key === 'allow')) cur.rules.push({ key, val });
    }
  }
  const b = bot.toLowerCase();
  const group = groups.find(g => g.agents.includes(b)) || groups.find(g => g.agents.includes('*'));
  if (!group) return false;
  const allowsRoot = group.rules.some(r => r.key === 'allow' && (r.val === '/' || r.val === '/*'));
  return !allowsRoot && group.rules.some(r => r.key === 'disallow' && (r.val === '/' || r.val === '/*'));
}

// Assistants that fetch pages to answer people's questions (search), as opposed to crawlers that collect training data.
const AI_SEARCH_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Claude-User'];
const AI_TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended'];

// ---------- PageSpeed Insights ----------

// What Google's test says to fix for speed, in plain words (Lewis, 21 Nov 2026: say what to fix, not just "could be
// faster"). Lighthouse 13 calls these "insights"; the older audit names are kept in case the API runs an older version.
// [title, where to start]. Audits not listed here are left out rather than shown in Google's own jargon.
const IMAGES = ['Images are bigger than they need to be', 'Resize images to the size they show at, compress them, and save photos as WebP or AVIF.'];
const BLOCKING = ['Some files hold up the first view', 'Load scripts with “defer”, and put the small amount of CSS the first screen needs in the page itself.'];
const CACHE = ['Files are cached for only a short time', 'Set long cache times for images, CSS and scripts, so return visits load faster.'];
const SERVER = ['The page is slow to start loading', 'Turn on compression and caching at your host, and remove any redirects before the page.'];
const LCP_IMG = ['The main image is found late', 'Don’t lazy-load the main image at the top of the page, and mark it as high priority.'];
const FONTS = ['Text waits for web fonts to load', 'Use font-display: swap, so text shows straight away in a standard font.'];
const THIRD = ['Third-party scripts slow the page', 'Remove add-ons, chat widgets and trackers you don’t use, and load the rest after the page.'];
const BUSY = ['Scripts keep the phone busy', 'Cut heavy scripts and add-ons: they delay taps and scrolling.'];
const SHIFT = ['Parts of the page jump while loading', 'Give images and embeds a fixed width and height, and reserve space for banners.'];
const MINIFY = ['Code files aren’t minified', 'Turn on minification in your website builder, host or plugin.'];
export const SPEED_FIXES = {
  'image-delivery-insight': IMAGES, 'uses-optimized-images': IMAGES, 'modern-image-formats': IMAGES, 'uses-responsive-images': IMAGES,
  'offscreen-images': ['Images further down load straight away', 'Lazy-load the images below the first screen.'],
  'render-blocking-insight': BLOCKING, 'render-blocking-resources': BLOCKING,
  'cache-insight': CACHE, 'uses-long-cache-ttl': CACHE,
  'document-latency-insight': SERVER, 'server-response-time': SERVER, 'uses-text-compression': SERVER, redirects: SERVER,
  'lcp-discovery-insight': LCP_IMG, 'prioritize-lcp-image': LCP_IMG, 'lcp-lazy-loaded': LCP_IMG,
  'font-display-insight': FONTS, 'font-display': FONTS,
  'third-parties-insight': THIRD, 'third-party-summary': THIRD,
  'unused-javascript': ['The page loads code it doesn’t use', 'Remove unused apps and plugins, and load scripts only on the pages that need them.'],
  'unused-css-rules': ['The page loads styles it doesn’t use', 'Remove unused CSS, often left behind by themes and plugins.'],
  'unminified-css': MINIFY, 'unminified-javascript': MINIFY,
  'legacy-javascript-insight': ['Code for old browsers is sent to every visitor', 'Ask your developer to stop sending code meant for old browsers to modern ones.'],
  'legacy-javascript': ['Code for old browsers is sent to every visitor', 'Ask your developer to stop sending code meant for old browsers to modern ones.'],
  'duplicated-javascript-insight': ['The same code is loaded twice', 'Remove the duplicate scripts.'], 'duplicated-javascript': ['The same code is loaded twice', 'Remove the duplicate scripts.'],
  'bootup-time': BUSY, 'mainthread-work-breakdown': BUSY,
  'cls-culprits-insight': SHIFT, 'layout-shift-elements': SHIFT, 'unsized-images': SHIFT,
  'dom-size-insight': ['The page is built from a very large number of parts', 'Simplify the page: fewer nested blocks, sliders and hidden sections.'],
  'dom-size': ['The page is built from a very large number of parts', 'Simplify the page: fewer nested blocks, sliders and hidden sections.'],
  'modern-http-insight': ['The server uses an older connection type', 'Ask your host to turn on HTTP/2 or HTTP/3.'],
};

// Accessibility and best-practice audits Google's test failed, in plain words. Checks the report already makes itself
// (alt text, page language, page title, zoom, tap size, https) are left out so nothing is said twice.
const A11Y_WORDS = {
  'color-contrast': ['some text is hard to read against its background', 'Darken light grey text, and check text placed over images.'],
  'link-in-text-block': ['links in the text stand out by colour alone', 'Underline links in paragraphs.'],
  label: ['some form fields have no label', 'Give every form field a visible label.'],
  'form-field-multiple-labels': ['some form fields have more than one label', 'Give each form field one label.'],
  'select-name': ['some form fields have no label', 'Give every form field a visible label.'],
  'button-name': ['some buttons have no name a screen reader can say', 'Give icon-only buttons a text label (aria-label).'],
  'input-button-name': ['some buttons have no name a screen reader can say', 'Give icon-only buttons a text label (aria-label).'],
  'link-name': ['some links have no text a screen reader can say', 'Give icon-only links a text label (aria-label).'],
  'heading-order': ['headings skip levels', 'Use headings in order: one H1, then H2s, then H3s.'],
  'empty-heading': ['some headings are empty', 'Remove empty headings or put text in them.'],
  'landmark-one-main': ['the main content isn’t marked as such for screen readers', 'Wrap the main content in a <main> element.'],
  'frame-title': ['embedded maps or videos have no title', 'Add a title to each embedded frame.'],
  'html-lang-valid': ['the page language code isn’t valid', 'Use a standard code such as lang="en-GB".'],
  list: ['some lists are built wrongly', 'Use ul or ol with li items only.'], listitem: ['some lists are built wrongly', 'Use ul or ol with li items only.'],
  'video-caption': ['videos have no captions', 'Add captions to videos.'],
  bypass: ['there is no way to skip straight to the main content', 'Add a “Skip to content” link at the top.'],
  tabindex: ['the keyboard order is forced in places', 'Remove positive tabindex values.'],
  'meta-refresh': ['the page reloads or moves on by itself', 'Remove the timed refresh.'],
  'svg-img-alt': ['some images have no description', 'Add a title or aria-label to images drawn in SVG.'],
};
const ARIA = ['some accessibility attributes (ARIA) are used wrongly', 'Correct or remove the ARIA attributes Google’s test lists.'];
const BP_WORDS = {
  'errors-in-console': 'errors show in the browser’s console',
  deprecations: 'the page uses browser features that are being removed',
  'image-aspect-ratio': 'some images are stretched or squashed',
  'image-size-responsive': 'some images look blurry on sharp screens',
  'paste-preventing-inputs': 'some fields stop visitors pasting',
  doctype: 'the page has no doctype, so browsers may show it in an older mode',
  charset: 'the page doesn’t declare its character set',
  'geolocation-on-start': 'it asks for the visitor’s location as soon as it opens',
  'notification-on-start': 'it asks to send notifications as soon as it opens',
  'third-party-cookies': 'it sets third-party cookies, which some browsers block',
  'inspector-issues': 'the browser flags problems with the page in its developer tools',
};

const KIB = 1024;
function speedFixes(a) {
  const found = [];
  for (const [id, words] of Object.entries(SPEED_FIXES)) {
    const x = a[id];
    if (!x || typeof x.score !== 'number' || x.score >= 0.9) continue;
    const ms = x.metricSavings || {};
    const save = Math.max(ms.LCP || 0, ms.FCP || 0);
    const tbt = ms.TBT || 0;
    const bytes = x.numericUnit === 'byte' ? x.numericValue || 0 : (x.details && x.details.overallSavingsBytes) || 0;
    const shift = ms.CLS || 0;
    if (save < 50 && tbt < 100 && bytes < 10 * KIB && shift < 0.05 && !(x.score < 0.5 && /dom-size|modern-http/.test(id))) continue;
    found.push({ id, title: words[0], start: words[1], ms: Math.round(save), tbt: Math.round(tbt), bytes: Math.round(bytes), shift, weight: save + tbt / 2 + bytes / KIB / 2 + shift * 2000 });
  }
  // One line per plain-words title (the old and new names, or two script audits, say the same thing)
  const seen = new Set();
  return found.sort((x, y) => y.weight - x.weight).filter(f => !seen.has(f.title) && seen.add(f.title)).slice(0, 5).map(({ weight, ...f }) => f);
}

const failed = (a, ids) => ids.filter(id => a[id] && typeof a[id].score === 'number' && a[id].score < 1 && a[id].scoreDisplayMode !== 'informative' && a[id].scoreDisplayMode !== 'notApplicable' && a[id].scoreDisplayMode !== 'manual');

export function readPsi(json) {
  if (!json || !json.lighthouseResult) return null;
  const lh = json.lighthouseResult;
  const a = lh.audits || {};
  const n = id => (a[id] && typeof a[id].numericValue === 'number') ? a[id].numericValue : null;
  const score = id => (a[id] && typeof a[id].score === 'number') ? a[id].score : null;
  const cat = k => lh.categories && lh.categories[k] && typeof lh.categories[k].score === 'number' ? Math.round(lh.categories[k].score * 100) : null;
  const field = (json.loadingExperience && json.loadingExperience.metrics && json.loadingExperience.origin_fallback !== true) ? json.loadingExperience.metrics : null;
  const f = k => field && field[k] && typeof field[k].percentile === 'number' ? field[k].percentile : null;
  const ariaIds = Object.keys(a).filter(id => /^aria-|^duplicate-id-aria$/.test(id));
  return {
    performance: cat('performance'), seo: cat('seo'), accessibility: cat('accessibility'), bestPractices: cat('best-practices'),
    lcp: n('largest-contentful-paint'),
    cls: n('cumulative-layout-shift'),
    tbt: n('total-blocking-time'),
    fcp: n('first-contentful-paint'),
    bytes: n('total-byte-weight'),
    targetSize: score('target-size'),
    fontSize: score('font-size'),
    fixes: speedFixes(a),
    failed: {
      a11y: [...failed(a, Object.keys(A11Y_WORDS)), ...(failed(a, ariaIds).length ? ['aria'] : [])],
      bp: failed(a, Object.keys(BP_WORDS)),
      robotsTxt: score('robots-txt') === 0,
      crawlable: score('crawlable-anchors') === 0,
    },
    field: field ? {
      lcp: f('LARGEST_CONTENTFUL_PAINT_MS'),
      inp: f('INTERACTION_TO_NEXT_PAINT'),
      cls: f('CUMULATIVE_LAYOUT_SHIFT_SCORE') != null ? f('CUMULATIVE_LAYOUT_SHIFT_SCORE') / 100 : null,
      category: json.loadingExperience.overall_category || null,
    } : null,
  };
}

// "about 300 KB less to download" or "about 1.2 seconds sooner", from Google's own estimate
const aboutSecs = ms => { const v = Math.round(ms / 100) / 10; return v === 1 ? '1 second' : String(v) + ' seconds'; };
export function savingWords(fx) {
  if (fx.ms >= 100) return `about ${aboutSecs(fx.ms)} sooner`;
  if (fx.bytes >= 10 * KIB) { const kb = fx.bytes / 1000; return `about ${kb >= 1000 ? (Math.round(kb / 100) / 10).toFixed(1) + ' MB' : (kb >= 100 ? Math.round(kb / 10) * 10 : Math.round(kb)) + ' KB'} less to download`; }
  if (fx.tbt >= 100) return `about ${aboutSecs(fx.tbt)} less waiting`;
  return null;
}

const secs = ms => (Math.round(ms / 100) / 10).toFixed(1) + ' seconds';

// ---------- area scores (Website Check v2 step 4, 22 Nov 2026) ----------
// Six areas out of 100, so people can see progress when they check again after fixes. Each area starts at 100 and loses
// points for each fix in it (fix first 25, worth fixing 12, small 5), never below 0; an area with no checks has no score.
// Notes don't count. Speed is Google's own phone score when the test answered. Worked out when a report is shown, so
// older reports get them too. (A weighted share of checks passed was tried first: too harsh where an area had few passes.)
export const AREAS = [
  ['seo', 'Search'], ['speed', 'Speed'], ['ux', 'User experience'], ['technical', 'Technical'], ['ai', 'AI search'], ['trust', 'Trust'],
];
const AREA_OF_GROUP = { speed: 'speed', search: 'seo', share: 'seo', site: 'seo', mobile: 'ux', access: 'ux', first: 'ux', contact: 'ux', technical: 'technical', measure: 'technical', ai: 'ai', trust: 'trust', proof: 'trust' };
const AREA_OF_ID = { 'site-broken-links': 'technical', 'site-redirects': 'technical', 'site-sitemap': 'technical', 'site-key-pages': 'trust', 'local-schema': 'ai', 'schema-broken': 'ai', 'gbp-link': 'trust', address: 'trust', consistent: 'trust', 'delivery-returns': 'trust' };
export const areaOf = f => AREA_OF_ID[f.id] || AREA_OF_GROUP[f.group] || 'technical';
const DEDUCT = { high: 25, medium: 12, low: 5 };

export function areaScores(r) {
  const out = {};
  for (const [id, label] of AREAS) out[id] = { id, label, checks: 0, lost: 0, fixes: 0, high: 0 };
  for (const f of [...(r.strengths || []), ...(r.weaknesses || [])]) {
    const a = out[areaOf(f)];
    a.checks += 1;
    if (f.status !== 'strength') { a.fixes += 1; a.lost += DEDUCT[f.priority] || 5; if (f.priority === 'high') a.high += 1; }
  }
  const phone = r.speed && r.speed.mobile && r.speed.mobile.performance;
  return AREAS.map(([id]) => {
    const a = out[id];
    const score = id === 'speed' && typeof phone === 'number' ? phone : a.checks ? Math.max(0, 100 - a.lost) : null;
    return { id, label: a.label, score, fixes: a.fixes, high: a.high, from: id === 'speed' && typeof phone === 'number' ? 'google' : 'checks' };
  });
}

// ---------- before and after (v3 item 1, 22 Nov 2026) ----------
// A short record of a check, kept with the domain for a year so the next check of the same site can say what changed.
// No page content, only scores and which checks passed.
export function snapshot(r) {
  return {
    id: r.id, checkedAt: r.checkedAt, model: r.model || null, rulesVersion: r.rulesVersion,
    areas: areaScores(r).map(a => ({ id: a.id, score: a.score })),
    weak: Object.fromEntries((r.weaknesses || []).map(f => [f.id, f.title])),
    strong: (r.strengths || []).map(f => f.id),
  };
}

// What changed since the last check of the same site, judged as the same kind of business. Fixed: was a fix, now passes
// (or no longer comes up). New: passed last time, now a fix. A check added since then counts as neither. Scores are only
// compared when the rules were the same, since new checks move them.
export function compareChecks(prev, r) {
  if (!prev || !prev.checkedAt || prev.id === r.id || (prev.model || null) !== (r.model || null)) return null;
  const nowWeak = new Map((r.weaknesses || []).map(f => [f.id, f.title]));
  // A fix shows as what passes now ("The canonical tag points to this page"), or the old problem when it no longer comes up
  const nowStrong = new Map((r.strengths || []).map(f => [f.id, f.title]));
  const fixed = Object.entries(prev.weak || {}).filter(([id]) => !nowWeak.has(id)).map(([id, title]) => ({ id, title: nowStrong.get(id) || title, was: title }));
  const added = [...nowWeak].filter(([id]) => (prev.strong || []).includes(id)).map(([id, title]) => ({ id, title }));
  const still = Object.keys(prev.weak || {}).filter(id => nowWeak.has(id)).length;
  const sameRules = prev.rulesVersion === r.rulesVersion;
  const now = Object.fromEntries(areaScores(r).map(a => [a.id, a.score]));
  const areas = sameRules ? (prev.areas || []).map(a => ({ id: a.id, before: a.score, after: now[a.id] ?? null })).filter(a => a.before != null && a.after != null) : [];
  return { checkedAt: prev.checkedAt, sameRules, fixed, added, still, areas };
}

// ---------- the site scan (rules v7, Website Check v2 step 3) ----------
// Up to 25 pages: the home page, then pages its links lead to (the menu first) and pages from the sitemap. gather()
// fetches them; pageFacts() keeps what the site-wide rules need, so the report never holds whole pages.

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|docx?|xlsx?|pptx?|csv|mp4|mov|mp3|wav|xml|txt|css|js|json|woff2?|ttf|eot)$/i;
// Pages a visitor reaches only mid-purchase or signed in: any part of the address
const SKIP_PATH = /(^|\/)(cart|basket|checkout|account|account-login|login|logout|signin|sign-in|register|my-account|order-summary|wp-admin|wp-login\.php|wp-json|cdn-cgi|search|feed)(\/|$)/i;
const bareHost = h => String(h || '').toLowerCase().replace(/^www\./, '');

// A link as a page on the same site worth scanning, or null. Query strings are left out (filters, tracking codes).
export function internalUrl(href, base) {
  if (!href || /^(#|mailto:|tel:|sms:|javascript:|data:)/i.test(href)) return null;
  let u;
  try { u = new URL(href, base); } catch { return null; }
  const b = new URL(base);
  if (!/^https?:$/.test(u.protocol) || bareHost(u.hostname) !== bareHost(b.hostname)) return null;
  if (u.search || SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
  u.hash = '';
  return u.href;
}
export const pageKey = url => { try { const u = new URL(url); return bareHost(u.hostname) + (u.pathname.replace(/\/+$/, '') || '/'); } catch { return url; } };

// Does robots.txt let a crawler fetch this path? The crawler's own group, else '*'; longest matching rule wins, Allow on a tie.
export function robotsAllows(robotsTxt, bot, path) {
  if (!robotsTxt) return true;
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const line of String(robotsTxt).split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    if (!l) continue;
    const [k, ...rest] = l.split(':');
    const key = k.trim().toLowerCase(), val = rest.join(':').trim();
    if (key === 'user-agent') { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; }
    else { lastWasAgent = false; if (cur && (key === 'disallow' || key === 'allow') && val) cur.rules.push({ allow: key === 'allow', val }); }
  }
  const b = bot.toLowerCase();
  const group = groups.find(g => g.agents.some(a => a !== '*' && b.includes(a))) || groups.find(g => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    const re = new RegExp('^' + r.val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.val.length > best.val.length || (r.val.length === best.val.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// What the site-wide rules need from one fetched page.
export function pageFacts({ url, status, finalUrl, hops = 0, html = '', robotsHeader = '', isHtml = true }) {
  const out = { url, path: new URL(url).pathname, status, hops, finalUrl: finalUrl || url };
  if (!isHtml || !html || status !== 200) return out;
  const p = parsePage(html);
  const links = [...new Set(p.links.map(l => internalUrl(l.href, out.finalUrl)).filter(Boolean))].slice(0, 300);
  return {
    ...out, html: true, title: p.title, description: p.description, h1Count: p.h1s.length, h1: (p.h1s[0] || '').slice(0, 120),
    words: p.text ? p.text.split(/\s+/).length : 0, noindex: /noindex/.test(p.robotsMeta) || /noindex/i.test(robotsHeader),
    canonical: p.canonical || null, imgs: p.imgs.length, noAlt: p.imgs.filter(t => attr(t, 'alt') === null).length, links,
    linkTexts: p.links.map(l => (l.text + ' ' + l.href).toLowerCase()).join(' | ').slice(0, 20000),
  };
}

// Site-wide findings from the scanned pages (input.pages, home page first) and the extra link checks (input.linkChecks).
function siteFindings(input, add, model, homeLinksText, hasContact) {
  const pages = (input.pages || []).filter(Boolean);
  if (pages.length < 2) return null;
  const html = pages.filter(pg => pg.html);
  const shortPath = pg => (pg.path || '/').length > 48 ? pg.path.slice(0, 45) + '…' : (pg.path || '/');
  // "/a, /b and 2 more": addresses as they are, at most n named
  const few = (arr, n = 3) => list([...arr.slice(0, n), ...(arr.length > n ? [`${arr.length - n} more`] : [])]);
  const fromPath = u => { try { return new URL(u).pathname; } catch { return u; } };

  // Broken links: scanned pages and link checks that answered 4xx or 5xx (or not at all)
  const broken = [...pages.filter(pg => pg.status >= 400), ...(input.linkChecks || []).filter(c => c.status >= 400 || c.status === 0)];
  if (broken.length) add({ id: 'site-broken-links', group: 'site', status: 'weakness', priority: 'high', title: `${broken.length === 1 ? 'A link leads' : broken.length + ' links lead'} to a page that doesn’t work`,
    detail: `Not working: ${few(broken.map(b => fromPath(b.url) + (b.status ? ` (${b.status})` : ' (no answer)')))}` + (broken[0].from ? `, linked from ${fromPath(broken[0].from)}` : '') + '.',
    why: 'Visitors hit a dead end, and search engines see a site that isn’t looked after.', start: 'Fix or remove each broken link, or redirect the old address to the right page.', link: LINKS.web });
  else add({ id: 'site-broken-links', group: 'site', status: 'strength', priority: 'medium', title: 'No broken links found',
    detail: `Every page and link I tried (${pages.length + (input.linkChecks || []).length}) answered.`, why: 'None of the links I tried led to a dead end.', start: 'Check again after you move or delete pages.', link: LINKS.web });

  // Links to addresses that redirect, and chains of two or more redirects
  const redirected = [...pages.slice(1), ...(input.linkChecks || [])].filter(pg => pg.hops > 0 && pg.status < 400);
  const chains = redirected.filter(pg => pg.hops >= 2);
  if (chains.length) add({ id: 'site-redirects', group: 'site', status: 'weakness', priority: 'medium', title: 'Some links pass through several redirects',
    detail: `${few(chains.map(c => fromPath(c.url)))} redirect${chains.length === 1 ? 's' : ''} more than once before reaching a page.`, why: 'Each hop slows the page down, and search engines may stop following.', start: 'Point links and redirects straight at the final address.', link: LINKS.web });
  else if (redirected.length >= 3) add({ id: 'site-redirects', group: 'site', status: 'weakness', priority: 'low', title: 'Links point to old addresses that redirect',
    detail: `${redirected.length} links go to an address that redirects, such as ${fromPath(redirected[0].url)}.`, why: 'Each one adds a small delay. Linking to the final address is quicker.', start: 'Update your menu and page links to the final addresses.', link: LINKS.web });

  // Titles and descriptions: missing or the same on several pages
  const dupes = key => { const m = new Map(); for (const pg of html) { const v = (pg[key] || '').trim().toLowerCase(); if (v) m.set(v, [...(m.get(v) || []), pg]); } return [...m.values()].filter(g => g.length > 1); };
  const noTitle = html.filter(pg => !pg.title), dupTitles = dupes('title');
  if (noTitle.length || dupTitles.length) add({ id: 'site-titles', group: 'site', status: 'weakness', priority: 'medium', title: noTitle.length ? `${noTitle.length} page${noTitle.length === 1 ? ' has' : 's have'} no title` : 'Several pages share the same title',
    detail: [noTitle.length && `No title on ${few(noTitle.map(shortPath))}.`, dupTitles.length && `${dupTitles.reduce((a, g) => a + g.length, 0)} pages share ${dupTitles.length === 1 ? 'one title' : dupTitles.length + ' titles'}, for example “${dupTitles[0][0].title.slice(0, 60)}” on ${few(dupTitles[0].map(shortPath), 2)}.`].filter(Boolean).join(' '),
    why: 'Google shows the title as the headline in its results. Pages with the same title compete with each other and look alike to searchers.', start: 'Give every page its own title that names what that page is about.', link: LINKS.seo });
  else add({ id: 'site-titles', group: 'site', status: 'strength', priority: 'low', title: 'Every page I read has its own title',
    detail: `All ${html.length} pages I read have a title, and no two are the same.`, why: 'Each page can be found for what it is about.', start: 'Keep it that way for new pages.', link: LINKS.seo });
  const noDesc = html.filter(pg => !pg.description), dupDesc = dupes('description');
  if (noDesc.length >= 2 || dupDesc.length) add({ id: 'site-descriptions', group: 'site', status: 'weakness', priority: 'low', title: noDesc.length >= 2 ? `${noDesc.length} pages have no meta description` : 'Several pages share the same description',
    detail: [noDesc.length >= 2 && `No description on ${few(noDesc.map(shortPath))}.`, dupDesc.length && `${dupDesc.reduce((a, g) => a + g.length, 0)} pages share the same description.`].filter(Boolean).join(' '),
    why: 'Google may show a random line from the page instead of one that makes people click.', start: 'Write one or two sentences for each main page on what it offers.', link: LINKS.seo });

  // Main headings
  const noH1 = html.filter(pg => !pg.h1Count), manyH1 = html.filter(pg => pg.h1Count > 1);
  if (noH1.length + manyH1.length >= 2) add({ id: 'site-headings', group: 'site', status: 'weakness', priority: 'low', title: 'Main headings missing or doubled on some pages',
    detail: [noH1.length && `No main heading on ${few(noH1.map(shortPath))}.`, manyH1.length && `More than one on ${few(manyH1.map(shortPath))}.`].filter(Boolean).join(' '),
    why: 'One clear main heading tells visitors and search engines what each page is about.', start: 'Give each page one H1 and make the others H2.', link: LINKS.seo });

  // Pages hidden from Google: a fault when the sitemap lists them, a note when they are only linked
  const hidden = html.slice(1).filter(pg => pg.noindex);
  const hiddenListed = hidden.filter(pg => pg.inSitemap);
  if (hiddenListed.length) add({ id: 'site-noindex', group: 'site', status: 'weakness', priority: 'medium', title: 'The sitemap lists pages that ask Google not to list them',
    detail: `${few(hiddenListed.map(shortPath))} ${hiddenListed.length === 1 ? 'is' : 'are'} in the sitemap but carr${hiddenListed.length === 1 ? 'ies' : 'y'} a “noindex” instruction.`, why: 'It sends Google mixed signals, and a page you want found may be left out.', start: 'Remove noindex from pages you want in Google, or take the others out of the sitemap.', link: LINKS.seo });
  else if (hidden.length) add({ id: 'site-noindex', group: 'site', status: 'note', priority: 'low', title: `${hidden.length} page${hidden.length === 1 ? ' asks' : 's ask'} Google not to list ${hidden.length === 1 ? 'it' : 'them'}`,
    detail: `${few(hidden.map(shortPath))} carr${hidden.length === 1 ? 'ies' : 'y'} a “noindex” instruction.`, why: 'Fine for thank-you or private pages, but a mistake on pages you want found.', start: 'Check each one is meant to be hidden.', link: LINKS.seo });

  // Sitemap pages that redirect or fail
  const badListed = pages.filter(pg => pg.inSitemap && (pg.status >= 400 || pg.hops > 0 || pg.status === 0));
  if (badListed.length) add({ id: 'site-sitemap', group: 'site', status: 'weakness', priority: 'medium', title: 'The sitemap lists addresses that redirect or fail',
    detail: `In the sitemap: ${few(badListed.map(pg => fromPath(pg.url) + (pg.status >= 400 ? ` (${pg.status})` : ' (redirects)')))}.`, why: 'Google expects the sitemap to list only live, final addresses, and trusts it less when it doesn’t.', start: 'Regenerate the sitemap so it lists only pages that load directly. Most website builders do this automatically.', link: LINKS.seo });

  // Thin pages: very few words (contact, thank-you and legal pages are expected to be short)
  const thin = html.slice(1).filter(pg => pg.words < 150 && !/contact|thank|privacy|terms|cookie|legal|login|cart|basket|search|book|404/i.test(pg.path));
  if (thin.length >= 2) add({ id: 'site-thin', group: 'site', status: 'weakness', priority: 'low', title: `${thin.length} pages have very little text`,
    detail: `Under 150 words: ${few(thin.map(pg => shortPath(pg) + ` (${pg.words})`))}.`, why: 'Short pages give search engines and AI assistants little to go on.', start: 'Add a few useful paragraphs to each one, or merge it into a fuller page.', link: LINKS.seo });

  // Images without descriptions across the site
  const imgs = html.reduce((a, pg) => a + (pg.imgs || 0), 0), noAlt = html.reduce((a, pg) => a + (pg.noAlt || 0), 0);
  if (imgs >= 10 && noAlt / imgs > 0.3) add({ id: 'site-alt', group: 'site', status: 'weakness', priority: 'low', title: 'Many images across the site have no description',
    detail: `${noAlt} of ${imgs} images on the pages I read have no alt text.`, why: 'Screen readers and image search rely on it.', start: 'Add a short alt description to each image that shows something meaningful.', link: LINKS.web });

  // Key pages: contact, about, privacy (by link text or address on any page read)
  // A page counts when it is linked or was found (in the sitemap). Contact details on the home page are enough without a
  // contact page.
  const allLinks = [homeLinksText, ...html.map(pg => pg.linkTexts || ''), ...pages.map(pg => pg.path || '')].join(' | ');
  const missingKey = [!hasContact && !/contact|get in touch|enquir/.test(allLinks) && 'a contact page',
    model !== 'shop' && !/\babout\b|our story|who we are|who-we-are|our-story|meet the team|\/team\b/.test(allLinks) && 'an about page',
    !/privacy/.test(allLinks) && 'a privacy policy'].filter(Boolean);
  if (missingKey.length) add({ id: 'site-key-pages', group: 'site', status: 'weakness', priority: missingKey.includes('a contact page') ? 'medium' : 'low', title: missingKey.length === 1 ? `No ${missingKey[0].replace(/^an? /, '')} found` : 'I couldn’t find some pages people look for',
    detail: `On the ${pages.length} pages I read, I couldn’t find ${list(missingKey)} or a link to one.`, why: 'People look for these before they get in touch or buy, and they help search engines and AI assistants trust the business.', start: 'If they exist, link them from your menu or footer. If not, add them.', link: LINKS.web });

  return {
    pages: pages.length, sitemapPages: input.sitemapCount || 0,
    list: pages.map(pg => ({ path: pg.path, status: pg.status, hops: pg.hops || 0, title: pg.title ? pg.title.slice(0, 80) : null, words: pg.words ?? null, noindex: !!pg.noindex, inSitemap: !!pg.inSitemap })),
  };
}

// ---------- the rules ----------

// How the page reads to a visitor (Lewis, 18 Nov 2026: the report should show "I get it" before the list of fixes).
// Fixed rules on what the page itself says, nothing guessed beyond it: what kind of business (its structured data,
// else a shop's tell-tale signs), where (the place the "where" check found, or UK-wide), how people get in touch, what
// it is built on, and the pieces Google and a phone visitor see first. Drawn on the report's ink panel.
const PLATFORMS = [
  ['Shopify', /cdn\.shopify\.com|myshopify\.com/i], ['Wix', /static\.wixstatic\.com|wix\.com\b/i], ['Squarespace', /squarespace\.com/i],
  ['WordPress', /wp-content\/|wp-includes\//i], ['Webflow', /webflow\.(?:com|io)/i], ['GoDaddy', /img1\.wsimg\.com/i], ['Framer', /framerusercontent\.com/i],
];
const TYPE_WORDS = { LocalBusiness: 'Local business', HomeAndConstructionBusiness: 'Building and home services firm', ProfessionalService: 'Professional services firm',
  HealthAndBeautyBusiness: 'Health and beauty business', FoodEstablishment: 'Food and drink business', MedicalBusiness: 'Medical practice', AutomotiveBusiness: 'Motor trade business',
  Organization: 'Company', Corporation: 'Company', OnlineStore: 'Online shop', OnlineBusiness: 'Online business', LegalService: 'Legal services firm', Attorney: 'Solicitor',
  EmergencyService: 'Emergency service', EntertainmentBusiness: 'Entertainment business', LodgingBusiness: 'Place to stay', SportsActivityLocation: 'Sports venue' };
const REACH = { 'a phone number': 'phone', 'an email address': 'email', 'a contact form': 'a contact form' };
const typeWords = t => TYPE_WORDS[t] || t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(.)(.*)$/, (m, a, b) => a + b.toLowerCase());
const list = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

function siteProfile({ p, h1, nodes, types, local, foundPlace, wide, routes, contactTop, postcodes, finalUrl, platform, shopSigns, model, modelFrom }) {
  const org = nodes.find(n => typesOf(n).some(t => /^(Organization|Corporation|OnlineStore|OnlineBusiness)$/.test(t)));
  let kind, kindFrom;
  if (local) { const t = typesOf(local).find(isLocalType); kind = typeWords(t); kindFrom = 'structured data'; }
  else if (shopSigns || model === 'shop') { kind = 'Online shop'; kindFrom = platform === 'Shopify' ? 'Shopify' : shopSigns ? 'the page' : 'your answer'; }
  else if (org) { kind = 'Company'; kindFrom = 'structured data'; }
  else { kind = null; kindFrom = null; }
  // A postcode alone reads better as the town written before it ("Ely CB7 4AA" gives "Ely").
  const town = postcodes[0] && (p.text.match(new RegExp('([A-Z][a-z]+(?:[ -][A-Z][a-z]+)*)\\s*,?\\s*' + postcodes[0].replace(' ', '\\s*'))) || [])[1];
  const place = foundPlace === 'a postcode' ? (town || postcodes[0] || null) : foundPlace || (wide ? 'Across the UK' : null);
  const reach = routes.map(r => REACH[r] || r);
  const who = kind ? (/^[AEIOU]/.test(kind) ? 'An ' : 'A ') + kind.toLowerCase() : 'A business';
  const where = place === 'Across the UK' ? ' working across the UK' : place ? ' in ' + place : ', with no town named near the top';
  const how = reach.length ? `, reached by ${list(reach)}.` : ', with no phone, email or form on this page.';
  const fromTitle = (p.title.split(/\s[|\-:\u2013]\s/)[0] || '').trim();
  const name = (local && local.name) || (org && org.name) || (/^(home|welcome|index|untitled|home page)$/i.test(fromTitle) ? '' : fromTitle) || null;
  return {
    summary: who + where + how,
    kind, kindFrom, place, wide: !!wide, reach, platform, name: name ? String(name).slice(0, 60) : null, model, modelFrom,
    google: { title: p.title || null, description: p.description || null, url: finalUrl.host.replace(/^www\./, '') + (finalUrl.pathname === '/' ? '' : finalUrl.pathname.replace(/\/$/, '').split('/').join(' \u203a ')) },
    firstScreen: { h1: h1 || null, cta: contactTop ? { text: (contactTop.text || contactTop.href.replace(/^(tel|mailto):/i, '')).slice(0, 40), kind: /^tel:/i.test(contactTop.href) ? 'call' : /^mailto:/i.test(contactTop.href) ? 'email' : 'link' } : null },
  };
}

export function analyse(input) {
  const out = [];
  const add = f => out.push(f);
  const p = parsePage(input.html);
  const nodes = schemaNodes(p.jsonLd);
  const types = nodes.flatMap(typesOf);
  const local = nodes.find(n => typesOf(n).some(isLocalType));
  const finalUrl = new URL(input.finalUrl || input.url);
  const textLower = p.text.toLowerCase();
  const platform = (PLATFORMS.find(([, re]) => re.test(p.raw)) || [null])[0];
  const shopSigns = platform === 'Shopify' || types.some(t => /^(Product|Offer|OnlineStore)$/.test(t)) || /\badd to (?:cart|basket|bag)\b/i.test(p.text);
  const postcodes = [...new Set((p.text.match(POSTCODE_G) || []).map(s => s.replace(/\s+/g, ' ').toUpperCase()))];
  const gbp = p.links.find(l => GBP_LINK.test(l.href)) || (/<iframe\b[^>]*google\.[a-z.]+\/maps/i.test(p.raw) ? { href: 'map' } : null);
  const orgTypes = types.filter(t => /^(Organization|Corporation|OnlineStore|OnlineBusiness)$/.test(t));

  // Where: a town or area near the top. Without a list of every place, look for the business's own locality from its
  // structured data, a postcode, or "in <Place>" in the title, heading or description.
  const localities = [];
  for (const n of nodes) {
    const addr = n.address && (Array.isArray(n.address) ? n.address : [n.address]);
    if (addr) for (const a of addr) if (a && a.addressLocality) localities.push(String(a.addressLocality));
    const area = n.areaServed && (Array.isArray(n.areaServed) ? n.areaServed : [n.areaServed]);
    if (area) for (const a of area) { const name = typeof a === 'string' ? a : a && a.name; if (name) localities.push(String(name)); }
  }
  // Joined with a mark the place pattern can't cross, so a title ending "Suffolk" and a heading starting "Hand-poured"
  // don't read as a place called "Suffolk Hand" (found by the demo websites, 18 Nov 2026).
  const topBits = [p.title, p.h1s[0] || '', p.description, p.top.text].join(' \u00b7 ');
  const foundPlace = localities.find(l => l.length > 2 && topBits.toLowerCase().includes(l.toLowerCase()))
    || (topBits.match(/\b(?:in|across|around|near|serving|based in|covering)\s+((?:[A-Z][a-z]+)(?:[\s-](?:[A-Z][a-z]+|upon|on|under|in|le))*)/) || [])[1]
    || (POSTCODE.test(p.top.text) ? 'a postcode' : null);
  // A business that serves the whole country (an online shop, a national firm) says so instead of naming a town
  // (found by the demo websites, 18 Nov 2026). Only when the page has no postcode, so a local firm with premises still
  // gets asked for its town, its Maps link and its local business details.
  const wide = !POSTCODE.test(p.text) && /\b(?:across|throughout|all over|around) the (?:uk|united kingdom|country)\b|\bnationwide\b|\buk[- ]wide\b|\buk delivery\b|\bdeliver(?:y|ed|ing)? (?:across|to|throughout) the uk\b|\b\d[\d,]* uk \w+/i.test(topBits);
  const notPlaces = /^(The|Our|Your|Every|All|Business|Home|Stock|Store|Touch|Time|Style|Love|Need|Store|January|February|March|April|May|June|July|August|September|October|November|December)$/;
  const place = foundPlace && !notPlaces.test(foundPlace.split(/\s/)[0]) ? foundPlace : null;
  // The kind of business: the visitor's answer, else a shop's tell-tale signs, else a site that says it works across the
  // UK (or names no place and describes itself as a company), else local, which keeps the local checks for the sites that
  // most need them (an old trade site rarely has structured data).
  const detected = shopSigns ? 'shop'
    : (wide || (!local && !postcodes.length && !place && !gbp && orgTypes.length)) ? 'national' : 'local';
  const model = MODELS[input.model] ? input.model : detected;
  const modelFrom = MODELS[input.model] ? 'chosen' : 'detected';
  const isLocal = model === 'local';
  // The words that change with the kind of business: what a heading or title should say, and who is looking for proof.
  const W = {
    local: { say: 'what you do and where', title: 'your business name, what you do and where you work', who: 'a local business', proofWhy: 'People choosing a local business look for proof that others were happy before they get in touch.', proofStart: 'Ask recent customers for Google reviews and show a few on the page, with a link to read them all.', example: '“Plumber in Ely for boiler repairs and bathrooms”' },
    national: { say: 'what you do and who it is for', title: 'your business name, what you do and who you help', who: 'a business like yours', proofWhy: 'Buyers look for proof, such as reviews, case studies or client names, before they get in touch.', proofStart: 'Add two or three short case studies or client quotes with names, and a rating from a review site if you have one.', example: '“Payroll software for care homes”' },
    shop: { say: 'what you sell', title: 'your shop name and what you sell', who: 'products like yours', proofWhy: 'Shoppers look for reviews before they buy from a shop they don’t know.', proofStart: 'Show product reviews and an overall rating from a review service, with a link to read them all.', example: '“Hand-poured soy candles and gift sets”' },
  }[model];

  // Speed (PageSpeed Insights, the same lab test Google's own tool runs, plus real visitors' data when Google has it)
  const m = input.psi && input.psi.mobile;
  const d = input.psi && input.psi.desktop;
  if (!m && !d) {
    add({ id: 'speed-unmeasured', group: 'speed', status: 'note', priority: 'low', title: 'Speed could not be measured this time',
      detail: 'Google’s speed test did not answer for this page. Everything else below was checked as normal.',
      why: 'Speed matters, so it is worth checking again later.', start: 'Run the check again tomorrow, or test the page at pagespeed.web.dev.', link: LINKS.web });
  } else {
    const ms = m && m.performance;
    if (ms != null) {
      const lcp = m.field && m.field.lcp != null ? m.field.lcp : m.lcp;
      const lcpNote = lcp != null ? ` The main content took about ${secs(lcp)} to appear on a phone${m.field && m.field.lcp != null ? ' for real visitors' : ' in the test'}.` : '';
      if (ms >= 90) add({ id: 'speed-mobile', group: 'speed', status: 'strength', priority: 'medium', title: 'Fast on a phone',
        detail: `Google’s speed test scores the page ${ms} out of 100 on a phone.${lcpNote}`,
        why: isLocal ? 'Most local searches happen on a phone, and a fast page keeps people reading.' : 'Most visitors arrive on a phone, and a fast page keeps people reading.', start: 'Keep new images and add-ons light so it stays this way.', link: LINKS.web });
      else {
        // What Google's own test says would help most, with its estimated saving (rules v6)
        const fixes = (m.fixes || []).slice(0, 3);
        add({ id: 'speed-mobile', group: 'speed', status: 'weakness', priority: ms < 50 ? 'high' : 'medium',
          title: ms < 50 ? 'Slow on a phone' : 'Could be faster on a phone',
          detail: `Google’s speed test scores the page ${ms} out of 100 on a phone (90 or more is good).${lcpNote}`,
          why: 'People on phones leave slow pages before they read anything, and Google takes speed into account.',
          start: fixes.length ? fixes[0].start : 'Start with the largest images: resize and compress them, and remove add-ons and scripts the page doesn’t need.',
          items: fixes.length ? fixes.map(fx => ({ text: fx.title, note: savingWords(fx) })) : undefined,
          itemsLabel: fixes.length ? 'What Google’s test says to fix first' : undefined, link: LINKS.web });
      }
    }
    const ds = d && d.performance;
    if (ds != null) {
      if (ds >= 90) add({ id: 'speed-desktop', group: 'speed', status: 'strength', priority: 'low', title: 'Fast on a computer',
        detail: `Google’s speed test scores the page ${ds} out of 100 on a computer.`, why: 'Visitors at a desk get a quick first look too.', start: 'Nothing to do here.', link: LINKS.web });
      else add({ id: 'speed-desktop', group: 'speed', status: 'weakness', priority: ds < 50 ? 'medium' : 'low', title: 'Could be faster on a computer',
        detail: `Google’s speed test scores the page ${ds} out of 100 on a computer (90 or more is good).`,
        why: 'A slow page on a large screen usually means heavy images or scripts, which hurt phones even more.', start: 'The same fixes as for phones help here: lighter images and fewer scripts.', link: LINKS.web });
    }
    // Core Web Vitals from real visitors (Chrome's field data), when Google has enough of it for this page
    const f = m && m.field;
    if (f && (f.lcp != null || f.inp != null || f.cls != null)) {
      const bad = [];
      if (f.lcp != null && f.lcp > 2500) bad.push(`the main content appears after ${secs(f.lcp)} (good is 2.5 seconds or less)`);
      if (f.inp != null && f.inp > 200) bad.push(`taps take ${Math.round(f.inp)} milliseconds to respond (good is 200 or less)`);
      if (f.cls != null && f.cls > 0.1) bad.push(`the layout jumps while loading (a shift score of ${f.cls.toFixed(2)}, good is 0.1 or less)`);
      if (!bad.length) add({ id: 'web-vitals', group: 'speed', status: 'strength', priority: 'medium', title: 'Passes Google’s page experience checks for real visitors',
        detail: 'Chrome’s data from real visitors on phones shows loading, response to taps and layout stability all in Google’s “good” range.',
        why: 'These are the measures Google uses for page experience.', start: 'Nothing to do here.', link: LINKS.web });
      else add({ id: 'web-vitals', group: 'speed', status: 'weakness', priority: 'medium', title: 'Real visitors on phones have a slower experience than Google wants',
        detail: 'From Chrome’s data on real visitors: ' + bad.join('; ') + '.',
        why: 'These are the measures Google uses for page experience, and they reflect what customers actually feel.', start: 'Fix the slowest measure first; the speed test at pagespeed.web.dev lists what causes it.', link: LINKS.web });
    }
  }

  // Phones
  const vp = (p.viewport || '').toLowerCase();
  if (!vp || !vp.includes('width=device-width')) add({ id: 'viewport', group: 'mobile', status: 'weakness', priority: 'high', title: 'Not set up for phone screens',
    detail: vp ? 'The page has a viewport tag, but it does not set the width to the phone’s screen.' : 'The page has no viewport tag, so phones show it as a shrunken desktop page.',
    why: 'Visitors have to pinch and zoom to read it, and Google checks pages as a phone would.', start: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page head.', link: LINKS.web });
  else add({ id: 'viewport', group: 'mobile', status: 'strength', priority: 'medium', title: 'Set up for phone screens',
    detail: 'The page tells phones to fit it to their screen width.', why: 'Text and buttons show at a readable size without zooming.', start: 'Nothing to do here.', link: LINKS.web });
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp)) add({ id: 'zoom-blocked', group: 'mobile', status: 'weakness', priority: 'low', title: 'Zooming is switched off on phones',
    detail: 'The viewport tag stops visitors from zooming in.', why: 'People with poorer eyesight can’t enlarge the text.', start: 'Remove user-scalable=no and maximum-scale=1 from the viewport tag.', link: LINKS.web });
  if (m && m.targetSize != null && m.targetSize < 1) add({ id: 'tap-targets', group: 'mobile', status: 'weakness', priority: 'low', title: 'Some buttons or links are small to tap',
    detail: 'Google’s test found tap targets on a phone that are too small or too close together.', why: 'Small targets lead to mis-taps, which is frustrating on the page that should bring the enquiry.', start: 'Make buttons and links at least 24 pixels in each direction, with space around them.', link: LINKS.web });
  if (m && m.fontSize != null && m.fontSize < 1) add({ id: 'font-size', group: 'mobile', status: 'weakness', priority: 'medium', title: 'Text is small on a phone',
    detail: 'Google’s test found text below a comfortable reading size on a phone.', why: 'If people have to zoom to read, many won’t.', start: 'Use at least 16 pixels for body text.', link: LINKS.web });

  // First impression: what you do, where, and how to get in touch, near the top
  const h1 = p.h1s[0] || '';
  if (!h1) add({ id: 'what-you-do', group: 'first', status: 'weakness', priority: 'high', title: 'No main heading saying what you do',
    detail: 'The page has no main heading (H1).', why: 'Visitors and search engines both look for one clear line that says what the business does.', start: `Add one heading at the top that says ${W.say}, in the words customers search for.`, link: LINKS.seo });
  else if (h1.split(/\s+/).length < 3) add({ id: 'what-you-do', group: 'first', status: 'weakness', priority: 'medium', title: 'The main heading doesn’t say much',
    detail: `The main heading is “${h1.slice(0, 80)}”.`, why: 'A heading of one or two words rarely tells a new visitor what you do.', start: `Rewrite it to say ${W.say}, for example ${W.example}.`, link: LINKS.seo });
  else add({ id: 'what-you-do', group: 'first', status: 'strength', priority: 'medium', title: 'A clear main heading',
    detail: `The main heading reads “${h1.slice(0, 100)}”.`, why: 'Visitors see straight away what the page is about.', start: 'Check it uses the words your customers would search for.', link: LINKS.seo });

  if (!isLocal) { /* a place, a postcode or none: not judged for a UK-wide business or a shop */ }
  else if (place) add({ id: 'where', group: 'first', status: 'strength', priority: 'medium', title: 'Says where you work',
    detail: foundPlace === 'a postcode' ? 'Near the top of the page I found a postcode.' : `Near the top of the page I found “${foundPlace}”.`, why: 'Local customers, Google and AI assistants all look for the place before they trust a local business.', start: 'Keep the town or area in the page title and main heading.', link: LINKS.seo });
  else add({ id: 'where', group: 'first', status: 'weakness', priority: 'high', title: 'Doesn’t say where you work near the top',
    detail: 'I couldn’t find a town, area or postcode in the page title, main heading, description or opening lines.',
    why: 'People search for a service plus a place, and a page that never names the place is hard to match to those searches.', start: 'Name your town and the area you cover in the title, the main heading and the first paragraph.', link: LINKS.seo });

  const topLinks = p.links.filter(l => l.at < p.top.linkLimit);
  const contactTop = topLinks.find(l => /^tel:|^mailto:|^sms:|wa\.me\/|whatsapp/i.test(l.href) || /\b(contact|get in touch|call|book|quote|enquir|message|ask)\b/i.test(l.text));
  if (contactTop) add({ id: 'contact-top', group: 'first', status: 'strength', priority: 'high', title: 'A way to get in touch near the top',
    detail: `The top of the page has “${(contactTop.text || contactTop.href.replace(/^(tel|mailto):/i, '')).slice(0, 60)}”.`, why: 'Ready customers can act without scrolling.', start: 'Keep it on every page, including on phones.', link: LINKS.web });
  else add({ id: 'contact-top', group: 'first', status: 'weakness', priority: 'high', title: 'No quick way to get in touch at the top',
    detail: 'I couldn’t find a phone link, an email link or a contact button in the header or the opening part of the page.', why: 'Customers who are ready to call or ask should not have to hunt for how.', start: 'Add a contact button or a tap-to-call number to the header.', link: LINKS.web });

  // Contact details: phone, email, address, consistent, and a link to the Google Business Profile
  const telLinks = [...new Set(p.links.filter(l => /^tel:/i.test(l.href)).map(l => normPhone(l.href.slice(4))).filter(isPhoneLike))];
  const textPhones = [...new Set((p.text.match(UK_PHONE_G) || []).map(normPhone).filter(isPhoneLike))];
  const phones = [...new Set([...telLinks, ...textPhones])];
  const mailtos = p.links.filter(l => /^mailto:/i.test(l.href));
  const emails = [...new Set([...(p.text.match(EMAIL_G) || []), ...mailtos.map(l => l.href.slice(7).split('?')[0])].map(e => e.toLowerCase()).filter(e => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/sentry|wixpress|example\./.test(e)))];
  const contactForm = p.forms.find(f => /type\s*=\s*["']?(email|tel)|<textarea/i.test(f));
  const routes = [phones.length && 'a phone number', (emails.length || mailtos.length) && 'an email address', contactForm && 'a contact form'].filter(Boolean);
  if (routes.length) add({ id: 'contact-routes', group: 'contact', status: 'strength', priority: 'high', title: 'Contact details on the page',
    detail: `I found ${routes.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`, why: 'Different customers prefer different ways to get in touch.', start: telLinks.length || !phones.length ? 'Nothing to do here.' : 'Make the phone number a tap-to-call link (tel:).', link: LINKS.web });
  else add({ id: 'contact-routes', group: 'contact', status: 'weakness', priority: 'high', title: 'No phone, email or contact form on this page',
    detail: 'I couldn’t find a phone number, an email address or a contact form on the page I checked.', why: 'A visitor who wants to get in touch has to go looking, and many won’t.', start: 'Put at least one contact route on every page, ideally in the header and footer.', link: LINKS.web });
  if (phones.length && !telLinks.length) add({ id: 'tap-to-call', group: 'contact', status: 'weakness', priority: 'medium', title: 'The phone number isn’t tap-to-call',
    detail: 'The number is written on the page but isn’t a link.', why: 'On a phone, one tap to call is the easiest enquiry there is, and a link can be counted in Google Analytics.', start: 'Wrap the number in a tel: link.', link: LINKS.web });
  if (postcodes.length) add({ id: 'address', group: 'contact', status: 'strength', priority: 'low', title: 'An address on the page',
    detail: `I found the postcode ${postcodes[0]}${postcodes.length > 1 ? ` and ${postcodes.length - 1} more` : ''}.`,
    why: isLocal ? 'An address helps Google tie the site to the place, and reassures customers you are real.' : 'It reassures visitors there is a real business behind the site.',
    start: isLocal ? 'Make sure it matches your Google Business Profile exactly.' : 'Nothing to do here.', link: LINKS.seo });
  else if (model === 'shop') add({ id: 'address', group: 'contact', status: 'note', priority: 'low', title: 'No business address on this page',
    detail: 'I couldn’t find a postcode on the page.', why: 'If you sell online to UK consumers, you must give your business address before they order, and shoppers look for one before buying from a shop they don’t know.',
    start: 'Make sure your full address is on your contact page or in your terms, and link to it from the footer.', link: LINKS.web });
  else if (isLocal) add({ id: 'address', group: 'contact', status: 'note', priority: 'low', title: 'No address on the page',
    detail: 'I couldn’t find a postcode on the page.', why: 'If customers visit you, an address helps. If you go to them, naming the area you cover is enough.', start: 'If you have premises, add the full address to the footer, written the same way as on your Google Business Profile.', link: LINKS.seo });
  const schemaPhones = [...new Set(nodes.map(n => n.telephone).filter(Boolean).map(normPhone).filter(isPhoneLike))];
  const mismatch = schemaPhones.filter(sp => phones.length && !phones.includes(sp));
  if (mismatch.length) add({ id: 'consistent', group: 'contact', status: 'weakness', priority: 'medium', title: 'The phone number in the page code differs from the one on the page',
    detail: 'The structured data (the business details written for search engines) has a different phone number from the one visitors see.', why: 'Google and AI assistants trust a business more when its details match everywhere.', start: isLocal ? 'Use one number and update it in the structured data, the page and your Google Business Profile.' : 'Use one number and update it in the structured data and on the page.', link: LINKS.seo });
  else if (telLinks.length > 2) add({ id: 'consistent', group: 'contact', status: 'note', priority: 'low', title: `${telLinks.length} different phone numbers`,
    detail: `The page links to ${telLinks.length} different phone numbers.`, why: 'That can be right (an office and a mobile), but too many can confuse customers and search engines.', start: 'Check each one is meant to be there.', link: LINKS.seo });
  if (gbp) add({ id: 'gbp-link', group: 'contact', status: 'strength', priority: isLocal ? 'medium' : 'low', title: 'Links to Google Maps or your Business Profile',
    detail: gbp.href === 'map' ? 'The page has a Google map.' : 'The page links to your Google Maps listing or Business Profile.', why: 'It connects the website and the profile, and makes reviews and directions one tap away.', start: 'Make sure the link opens your own profile.', link: LINKS.seo });
  else if (isLocal) add({ id: 'gbp-link', group: 'contact', status: 'weakness', priority: 'medium', title: 'No link to your Google Business Profile',
    detail: 'I couldn’t find a link to Google Maps or a Google Business Profile.', why: 'The profile is what shows in the map results for local searches. Linking both ways helps Google connect them, and sends customers to your reviews.', start: 'Link to your profile from the footer or contact section. If you don’t have one yet, set it up first.', link: LINKS.seo });

  // Search basics: title, description, one heading, structured data, indexing
  const tl = p.title.length;
  if (!tl) add({ id: 'title', group: 'search', status: 'weakness', priority: 'high', title: 'No page title',
    detail: 'The page has no title.', why: 'The title is the blue headline in Google’s results; without one Google makes one up.', start: `Write a title of about 50 to 60 characters: ${W.title}.`, link: LINKS.seo });
  else if (tl < 15 || tl > 65) add({ id: 'title', group: 'search', status: 'weakness', priority: 'medium', title: tl < 15 ? 'The page title is very short' : 'The page title is long',
    detail: `The title is “${p.title.slice(0, 120)}” (${tl} characters).`, why: tl < 15 ? 'A short title wastes the space that tells searchers what you do.' : 'Google cuts titles off at around 60 characters, so the end may not show.', start: `Aim for about 50 to 60 characters: ${W.title}.`, link: LINKS.seo });
  else add({ id: 'title', group: 'search', status: 'strength', priority: 'medium', title: 'A page title of a good length',
    detail: `“${p.title}” (${tl} characters).`, why: 'It fits in Google’s results without being cut off.', start: `Check it names ${W.say}.`, link: LINKS.seo });
  const dl = p.description.length;
  if (!dl) add({ id: 'description', group: 'search', status: 'weakness', priority: 'medium', title: 'No meta description',
    detail: 'The page has no description for search results.', why: 'Google may show a random bit of the page under your title instead of a line that makes people click.', start: `Write one or two sentences (up to about 155 characters) on ${W.say} and why to choose you.`, link: LINKS.seo });
  else if (dl < 50 || dl > 170) add({ id: 'description', group: 'search', status: 'weakness', priority: 'low', title: dl < 50 ? 'The meta description is short' : 'The meta description is long',
    detail: `It is ${dl} characters.`, why: dl < 50 ? 'There is room to say more about why someone should click.' : 'Google cuts it off at around 155 characters.', start: 'Aim for about 120 to 155 characters.', link: LINKS.seo });
  else add({ id: 'description', group: 'search', status: 'strength', priority: 'low', title: 'A meta description of a good length',
    detail: `It is ${dl} characters.`, why: 'It gives Google a ready-made line to show under your title.', start: 'Nothing to do here.', link: LINKS.seo });
  if (p.h1s.length > 1) add({ id: 'one-heading', group: 'search', status: 'weakness', priority: 'low', title: `${p.h1s.length} main headings`,
    detail: `The page has ${p.h1s.length} H1 headings.`, why: 'One main heading makes the page’s subject clear to search engines and screen readers.', start: 'Keep one H1 and make the others H2.', link: LINKS.seo });

  if (local && isLocal) {
    const missing = ['name', 'address', 'telephone', 'url'].filter(k => !local[k]);
    add({ id: 'local-schema', group: 'search', status: missing.length > 1 ? 'weakness' : 'strength', priority: 'medium',
      title: missing.length > 1 ? 'Business details for search engines are incomplete' : 'Business details written for search engines',
      detail: `The page describes the business as ${typesOf(local).join(', ')} in structured data` + (missing.length ? `, without ${missing.join(', ').replace(/, ([^,]*)$/, ' or $1')}.` : '.'),
      why: 'Structured data tells Google and AI assistants your name, area and contact details in a form they read reliably.',
      start: missing.length ? 'Add the missing details to the LocalBusiness structured data.' : 'Keep it matching your Google Business Profile.', link: LINKS.seo });
  } else if (!isLocal && (orgTypes.length || local)) add({ id: 'local-schema', group: 'search', status: 'strength', priority: 'medium',
    title: 'Business details written for search engines',
    detail: `The page describes the business as ${[...new Set(orgTypes.length ? orgTypes : typesOf(local))].join(', ')} in structured data.`,
    why: 'Structured data tells Google and AI assistants your name and details in a form they read reliably.', start: 'Add your logo, contact details and social profiles to it if they aren’t there yet.', link: LINKS.seo });
  else if (!isLocal) add({ id: 'local-schema', group: 'search', status: 'weakness', priority: 'low',
    title: 'No business details for search engines',
    detail: types.length ? `The page has structured data (${[...new Set(types)].slice(0, 4).join(', ')}) but nothing describing the business itself.` : 'The page has no structured data.',
    why: 'Organization structured data tells Google and AI assistants your name, logo and contact details in a form they read reliably.',
    start: model === 'shop' ? 'Add Organization (or OnlineStore) structured data with your name, logo, website and contact details.' : 'Add Organization structured data with your name, logo, website and contact details.', link: LINKS.seo });
  else add({ id: 'local-schema', group: 'search', status: 'weakness', priority: 'medium',
    title: 'No local business details for search engines',
    detail: types.length ? `The page has structured data (${[...new Set(types)].slice(0, 4).join(', ')}) but nothing marking it as a local business.` : 'The page has no structured data.',
    why: 'LocalBusiness structured data tells Google and AI assistants your name, area and contact details in a form they read reliably.',
    start: 'Add LocalBusiness structured data (or a closer type, such as Plumber) with your name, address or area, phone and website.', link: LINKS.seo });
  if (p.jsonLd.some(j => j && j.__invalid)) add({ id: 'schema-broken', group: 'search', status: 'weakness', priority: 'medium', title: 'Some structured data is broken',
    detail: 'At least one block of structured data on the page isn’t valid JSON, so search engines ignore it.', why: 'Whatever it was meant to say is lost.', start: 'Test the page in Google’s Rich Results Test and fix the block it flags.', link: LINKS.seo });

  const noindex = /noindex/.test(p.robotsMeta) || /noindex/i.test(input.robotsHeader || '');
  if (noindex) add({ id: 'noindex', group: 'search', status: 'weakness', priority: 'high', title: 'This page asks Google not to list it',
    detail: 'The page carries a “noindex” instruction.', why: 'Google will drop it from search results, so nobody can find it there.', start: 'Remove the noindex tag, unless hiding the page is deliberate.', link: LINKS.seo });

  const noAlt = p.imgs.filter(t => attr(t, 'alt') === null).length;
  if (p.imgs.length >= 3 && noAlt / p.imgs.length > 0.3) add({ id: 'alt-text', group: 'search', status: 'weakness', priority: 'low', title: 'Many images have no description',
    detail: `${noAlt} of ${p.imgs.length} images have no alt text.`, why: 'Screen readers and image search rely on it.', start: 'Add a short alt description to each image that shows something meaningful.', link: LINKS.web });

  // Technical: HTTPS, robots.txt, sitemap
  if (finalUrl.protocol !== 'https:') add({ id: 'https', group: 'technical', status: 'weakness', priority: 'high', title: 'Not on a secure (https) address',
    detail: 'The page loads over http, not https.', why: 'Browsers mark http pages as “Not secure”, which puts customers off, and Google prefers https.', start: 'Turn on an SSL certificate (most hosts include one free) and redirect http to https.', link: LINKS.web });
  else if (input.httpRedirects === false) add({ id: 'https', group: 'technical', status: 'weakness', priority: 'medium', title: 'The http address doesn’t move visitors to https',
    detail: 'The page works on https, but the plain http address doesn’t redirect to it.', why: 'Old links and typed addresses may land on the insecure version.', start: 'Set a permanent redirect from http to https at your host.', link: LINKS.web });
  else add({ id: 'https', group: 'technical', status: 'strength', priority: 'medium', title: 'Secure (https)',
    detail: input.httpRedirects ? 'The page is on https, and the http address redirects to it.' : 'The page is on https.', why: 'Browsers show it as secure.', start: 'Nothing to do here.', link: LINKS.web });
  if (input.robots == null) add({ id: 'robots', group: 'technical', status: 'note', priority: 'low', title: 'No robots.txt file',
    detail: 'The site has no robots.txt.', why: 'Search engines then crawl everything, which is fine for most small sites. The file is also where you point them to your sitemap.', start: 'Add a robots.txt with a Sitemap: line.', link: LINKS.seo });
  else if (robotsBlocks(input.robots, 'Googlebot')) add({ id: 'robots', group: 'technical', status: 'weakness', priority: 'high', title: 'robots.txt blocks Google from the whole site',
    detail: 'The robots.txt file tells Google’s crawler not to visit any page.', why: 'Google can’t read the site, so it can’t show it properly in search.', start: 'Remove the “Disallow: /” rule that applies to Googlebot or to every crawler.', link: LINKS.seo });
  if (input.sitemap) add({ id: 'sitemap', group: 'technical', status: 'strength', priority: 'low', title: 'A sitemap',
    detail: 'The site has an XML sitemap.', why: 'It helps search engines find every page, including new ones.', start: 'Submit it in Google Search Console if you haven’t.', link: LINKS.seo });
  else add({ id: 'sitemap', group: 'technical', status: 'weakness', priority: 'low', title: 'No sitemap found',
    detail: 'I couldn’t find a sitemap in robots.txt or at /sitemap.xml.', why: 'Without one, search engines rely on links to find pages, and new ones can take longer to appear.', start: 'Most website builders make one automatically: switch it on and submit it in Google Search Console.', link: LINKS.seo });

  // AI search: assistants that answer questions, training crawlers, llms.txt
  const blockedSearch = AI_SEARCH_BOTS.filter(b => robotsBlocks(input.robots, b));
  const blockedTraining = AI_TRAINING_BOTS.filter(b => robotsBlocks(input.robots, b));
  if (blockedSearch.length) add({ id: 'ai-search-bots', group: 'ai', status: 'weakness', priority: 'medium', title: 'Some AI assistants are blocked from reading the site',
    detail: `robots.txt blocks ${blockedSearch.join(', ')}, which fetch pages to answer people’s questions.`, why: `Customers who ask ChatGPT, Perplexity or Claude about ${W.who} can’t be shown yours if the assistant can’t read it.`, start: 'Allow these crawlers in robots.txt (check your host or Cloudflare settings, which sometimes block them for you).', link: LINKS.seo });
  else add({ id: 'ai-search-bots', group: 'ai', status: 'strength', priority: 'medium', title: 'AI assistants can read the site',
    detail: 'robots.txt doesn’t block the crawlers that ChatGPT, Perplexity and Claude use to answer questions.', why: `Your pages can be read and cited when someone asks an assistant about ${W.who}.`, start: 'Nothing to do here.', link: LINKS.seo });
  if (blockedTraining.length) add({ id: 'ai-training-bots', group: 'ai', status: 'note', priority: 'low', title: 'AI training crawlers are blocked',
    detail: `robots.txt blocks ${blockedTraining.join(', ')}, which collect pages to train AI models.`, why: 'That is a reasonable choice and doesn’t stop the assistants above from reading the site to answer questions.', start: 'No change needed unless you want your pages used for training.', link: LINKS.seo });
  if (input.llms) add({ id: 'llms-txt', group: 'ai', status: 'strength', priority: 'low', title: 'An llms.txt file',
    detail: 'The site has an llms.txt file summarising it for AI tools.', why: 'It is a newer, optional file that gives AI tools a short, accurate summary of the business.', start: 'Keep it up to date when your services change.', link: LINKS.seo });
  else add({ id: 'llms-txt', group: 'ai', status: 'note', priority: 'low', title: 'No llms.txt file',
    detail: 'The site has no llms.txt.', why: 'It is a newer, optional file, and few small sites have one. It gives AI tools a short, accurate summary of the business.', start: 'Add a plain text file at /llms.txt with who you are, what you do, where, and links to your main pages.', link: LINKS.seo });

  // Measuring enquiries
  const ga4 = /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(p.raw);
  const gtm = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i.test(p.raw);
  const platformAnalytics = /cdn\.shopify\.com|static\.wixstatic\.com|squarespace\.com\/universal/i.test(p.raw);
  if (ga4 || gtm) add({ id: 'analytics', group: 'measure', status: 'strength', priority: 'high', title: `${gtm ? 'Google Tag Manager' : 'Google Analytics'} is on the page`,
    detail: `I found ${[ga4 && 'Google Analytics', gtm && 'Google Tag Manager'].filter(Boolean).join(' and ')}. From outside I can’t see which actions are counted as enquiries.`,
    why: 'With it in place, form sends and phone taps can be counted, so you know what brings enquiries.', start: 'Check in Google Analytics that form sends and phone taps are recorded as key events.', link: LINKS.tracking });
  else add({ id: 'analytics', group: 'measure', status: 'weakness', priority: 'high', title: 'No Google Analytics or Tag Manager found',
    detail: platformAnalytics ? 'Your website platform may have its own visitor stats, but I couldn’t find Google Analytics or Google Tag Manager.' : 'I couldn’t find Google Analytics or Google Tag Manager on the page.',
    why: 'Without it you can’t see which pages, searches or ads bring enquiries, and Google Ads can’t learn from them.', start: 'Add Google Tag Manager, then set up Google Analytics and count form sends and phone taps.', link: LINKS.systems });
  const measurable = [contactForm && 'a form', telLinks.length && 'tap-to-call links', mailtos.length && 'email links'].filter(Boolean);
  if (!measurable.length && routes.length) add({ id: 'measurable', group: 'measure', status: 'weakness', priority: 'low', title: 'Enquiries can’t be counted from this page',
    detail: 'The contact details are plain text rather than a form or links.', why: 'Analytics can count a form sent or a link tapped, but not someone copying a number.', start: 'Use a contact form and tel: and mailto: links.', link: LINKS.systems });

  // Online shops: delivery and returns, the two things shoppers check before they buy (a link or a mention on the page)
  if (model === 'shop') {
    const said = re => p.links.some(l => re.test(l.text) || re.test(l.href)) || re.test(p.text);
    const delivery = said(/\b(deliver(?:y|ies)|shipping|postage)\b/i), returns = said(/\b(returns?|refunds?|exchanges?)\b/i);
    const missing = [!delivery && 'delivery', !returns && 'returns'].filter(Boolean);
    if (!missing.length) add({ id: 'delivery-returns', group: 'proof', status: 'strength', priority: 'medium', title: 'Delivery and returns information',
      detail: 'The page links to or mentions both delivery and returns.', why: 'Shoppers check delivery costs and the returns policy before they buy.', start: 'Keep the costs and timescales up to date.', link: LINKS.web });
    else add({ id: 'delivery-returns', group: 'proof', status: 'weakness', priority: 'medium', title: `No ${missing.join(' or ')} information on the page`,
      detail: `I couldn’t find a link to, or a mention of, ${missing.join(' or ')} information.`, why: 'Shoppers check delivery costs and the returns policy before they buy, and many leave a shop that hides them.',
      start: 'Link your delivery and returns pages from the footer, and mention free delivery or easy returns near the top if you offer them.', link: LINKS.web });
  }

  // Reviews and proof
  const ratingSchema = nodes.some(n => n.aggregateRating || typesOf(n).includes('Review') || typesOf(n).includes('AggregateRating'));
  const cited = p.raw.match(QUOTE_CITE);
  const reviewSign = (p.text.match(REVIEW_TEXT) || p.raw.match(REVIEW_LINKS) || [])[0]
    || (cited ? 'a quote from ' + stripTags(cited[1]).trim() : null)
    || (p.raw.match(REVIEW_CLASS) ? 'a testimonials or reviews block' : null);
  if (ratingSchema || reviewSign) add({ id: 'proof', group: 'proof', status: 'strength', priority: 'medium', title: 'Reviews or proof on the page',
    detail: ratingSchema ? 'The page shows ratings or reviews, marked up for search engines.' : `I found signs of reviews or testimonials (“${String(reviewSign).slice(0, 40)}”).`,
    why: model === 'shop' ? 'Shoppers trust a shop more when they can see others were happy.' : 'New customers look for proof that others were happy.', start: 'Keep them recent, and link to where people can read more.', link: LINKS.seo });
  else add({ id: 'proof', group: 'proof', status: 'weakness', priority: 'medium', title: 'No reviews or testimonials on the page',
    detail: 'I couldn’t find reviews, testimonials, star ratings or a review service on the page.', why: W.proofWhy, start: W.proofStart, link: LINKS.seo });

  // ---------- rules v6 (Website Check v2 step 2, 21 Nov 2026) ----------

  // Accessibility, from Google's test (the phone run), in plain words; checks made elsewhere in the report are left out
  if (m && m.accessibility != null) {
    const seenA = new Set();
    const a11y = (m.failed && m.failed.a11y || []).map(id => id === 'aria' ? ARIA : A11Y_WORDS[id]).filter(w => w && !seenA.has(w[0]) && seenA.add(w[0]));
    const sA = m.accessibility;
    if (sA >= 90 && !a11y.length) add({ id: 'accessibility', group: 'access', status: 'strength', priority: 'low', title: 'Passes Google’s accessibility checks',
      detail: `Google’s accessibility test scores the page ${sA} out of 100.`, why: 'Google’s automated test found nothing to fix.', start: 'Nothing to do here.', link: LINKS.web });
    else if (sA < 90 || a11y.length) add({ id: 'accessibility', group: 'access', status: 'weakness', priority: sA < 70 ? 'medium' : 'low',
      title: sA < 70 ? 'Hard to use for some visitors' : 'A few accessibility gaps',
      detail: `Google’s accessibility test scores the page ${sA} out of 100 (90 or more is good).` + (a11y.length ? ` It found that ${list(a11y.slice(0, 3).map(w => w[0]))}.` : ''),
      why: 'Many visitors have poor eyesight or use a keyboard or a screen reader, and the same fixes make the page easier for everyone.',
      start: a11y.length ? a11y[0][1] : 'Run the page through pagespeed.web.dev and fix the accessibility items it lists.',
      items: a11y.length > 1 ? a11y.slice(1, 3).map(w => ({ text: w[1] })) : undefined, itemsLabel: a11y.length > 1 ? 'Then' : undefined, link: LINKS.web });
  }

  // Best practices, from the same test (browser errors, stretched images, old features)
  if (m && m.bestPractices != null) {
    const bp = (m.failed && m.failed.bp || []).map(id => BP_WORDS[id]).filter(Boolean);
    if (m.bestPractices >= 90 && !bp.length) add({ id: 'best-practices', group: 'technical', status: 'strength', priority: 'low', title: 'Passes Google’s best-practice checks',
      detail: `Google’s best-practice test scores the page ${m.bestPractices} out of 100.`, why: 'Google’s test found no browser errors, stretched images or outdated features.', start: 'Nothing to do here.', link: LINKS.web });
    else add({ id: 'best-practices', group: 'technical', status: 'weakness', priority: 'low', title: 'Some browser warnings',
      detail: `Google’s best-practice test scores the page ${m.bestPractices} out of 100 (90 or more is good).` + (bp.length ? ` It found that ${list(bp.slice(0, 3))}.` : ''),
      why: 'These are often small bugs that make the page look or work worse in some browsers.', start: 'Ask whoever built the site to fix the items listed under Best practices at pagespeed.web.dev.', link: LINKS.web });
    if (m.failed && m.failed.robotsTxt && input.robots != null) add({ id: 'robots-errors', group: 'technical', status: 'weakness', priority: 'low', title: 'robots.txt has errors',
      detail: 'Google’s test found lines in robots.txt it can’t read.', why: 'Search engines may ignore rules you meant them to follow.', start: 'Check the file in Google Search Console’s robots.txt report and fix the lines it flags.', link: LINKS.seo });
  }

  // Link text and links search engines can't follow
  const VAGUE = /^(click here|click|here|read more|more|learn more|find out more|more info|more information|see more|this|link|go|details)$/i;
  const realLinks = p.links.filter(l => l.href && !/^#/.test(l.href) && !/^(tel|mailto|sms):/i.test(l.href));
  const vague = realLinks.filter(l => VAGUE.test(l.text.replace(/[.›»→>\s]+$/, '').trim()));
  if (vague.length) add({ id: 'link-text', group: 'search', status: 'weakness', priority: 'low', title: `${vague.length === 1 ? 'A link says' : vague.length + ' links say'} only “${vague[0].text.slice(0, 20)}”`,
    detail: `Links such as “${vague[0].text.slice(0, 20)}” don’t say where they go.`, why: 'Search engines and screen readers use link text to understand the page they lead to.', start: 'Rewrite them to name the page, for example “See our boiler prices”.', link: LINKS.seo });
  const jsLinks = p.links.filter(l => /^javascript:/i.test(l.href));
  if (jsLinks.length) add({ id: 'crawlable-links', group: 'search', status: 'weakness', priority: 'low', title: 'Some links can’t be followed by search engines',
    detail: `${jsLinks.length} link${jsLinks.length === 1 ? ' uses' : 's use'} “javascript:” instead of a web address.`, why: 'Search engines only follow real addresses, so the pages behind these links may not be found.', start: 'Give each link a real href to the page it opens.', link: LINKS.seo });

  // Indexing: canonical, language, language versions, missing pages
  const bare = h => String(h || '').toLowerCase().replace(/^www\./, '');
  const path = u => u.pathname.replace(/\/+$/, '') || '/';
  let canon = null;
  try { canon = p.canonical ? new URL(p.canonical, finalUrl) : null; } catch { canon = 'bad'; }
  if (!p.canonical) add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'low', title: 'No canonical tag',
    detail: 'The page doesn’t say which address is its main one.', why: 'The same page can often be reached at several addresses (with and without www, with tracking codes). The tag tells Google which one to list.', start: 'Add <link rel="canonical" href="…"> with the page’s own address. Most website builders have a setting for it.', link: LINKS.seo });
  else if (canon === 'bad') add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'medium', title: 'The canonical tag isn’t a valid address',
    detail: `It reads “${String(p.canonical).slice(0, 80)}”.`, why: 'Google ignores it, so it may pick a different address to list.', start: 'Set it to the page’s own full address.', link: LINKS.seo });
  else if (bare(canon.hostname) !== bare(finalUrl.hostname)) add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'high', title: 'The canonical tag points to another website',
    detail: `It points to ${canon.hostname}, not ${finalUrl.hostname}.`, why: 'Google may treat that address as the real page and leave this one out of its results. It is a common mistake after moving from a test site.', start: 'Change the canonical tag to this site’s own address.', link: LINKS.seo });
  else if (canon.protocol !== finalUrl.protocol) add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'medium', title: 'The canonical tag points to the insecure (http) address',
    detail: `It points to ${canon.href.slice(0, 80)}.`, why: 'It asks Google to list the http version, which redirects or shows as “Not secure”.', start: 'Change it to the https address.', link: LINKS.seo });
  else if (path(canon) !== path(finalUrl)) add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'medium', title: 'The canonical tag points to a different page',
    detail: `This page’s canonical tag points to ${path(canon)}.`, why: 'Google may list that page instead of this one, or not list this one at all.', start: 'Point it to this page’s own address, unless it is deliberately a copy.', link: LINKS.seo });
  else if (canon.hostname !== finalUrl.hostname) add({ id: 'canonical', group: 'search', status: 'weakness', priority: 'low', title: 'The canonical tag uses the other version of your address',
    detail: `The page is at ${finalUrl.hostname}, but the canonical tag says ${canon.hostname}.`, why: 'Search engines get mixed signals about which version to list.', start: 'Use the same version (with or without www) everywhere, and redirect the other.', link: LINKS.seo });
  else add({ id: 'canonical', group: 'search', status: 'strength', priority: 'low', title: 'The canonical tag points to this page',
    detail: 'The page names its own address as the main one.', why: 'It tells Google which address you want listed.', start: 'Nothing to do here.', link: LINKS.seo });

  if (!p.lang) add({ id: 'lang', group: 'search', status: 'weakness', priority: 'low', title: 'The page doesn’t say what language it is in',
    detail: 'The <html> tag has no lang attribute.', why: 'Screen readers use it to pronounce words, and browsers and search engines use it to offer translation.', start: 'Add lang="en-GB" to the <html> tag.', link: LINKS.web });
  else add({ id: 'lang', group: 'search', status: 'strength', priority: 'low', title: 'The page language is set',
    detail: `The page says it is in “${p.lang}”.`, why: 'Screen readers pronounce words correctly and translation works.', start: 'Nothing to do here.', link: LINKS.web });

  if (p.hreflangs.length) {
    const self = p.hreflangs.some(h => { try { const u = new URL(h.href, finalUrl); return bare(u.hostname) === bare(finalUrl.hostname) && path(u) === path(finalUrl); } catch { return false; } });
    if (self) add({ id: 'hreflang', group: 'search', status: 'strength', priority: 'low', title: 'Language versions are listed',
      detail: `The page lists ${p.hreflangs.length} language or country version${p.hreflangs.length === 1 ? '' : 's'}, including itself.`, why: 'Google can show each visitor the right version.', start: 'Make sure every version lists all the others too.', link: LINKS.seo });
    else add({ id: 'hreflang', group: 'search', status: 'weakness', priority: 'low', title: 'The language versions don’t include this page',
      detail: `The page lists ${p.hreflangs.length} language or country version${p.hreflangs.length === 1 ? '' : 's'} (hreflang), but not its own address.`, why: 'Google ignores hreflang tags that don’t include the page itself.', start: 'Add an hreflang line for this page’s own address.', link: LINKS.seo });
  }

  if (input.missingStatus === 200) add({ id: 'soft-404', group: 'technical', status: 'weakness', priority: 'medium', title: 'Missing pages look like normal pages',
    detail: 'I asked for a page that doesn’t exist, and the site answered as if it did (status 200, not 404).', why: 'Google can waste time on pages that aren’t there, and visitors following a broken link don’t get a clear “page not found”.', start: 'Set the site to answer missing pages with a 404 status and a helpful “page not found” page.', link: LINKS.web });
  else if (input.missingStatus >= 300 && input.missingStatus < 400) add({ id: 'soft-404', group: 'technical', status: 'weakness', priority: 'low', title: 'Missing pages redirect instead of saying “not found”',
    detail: `I asked for a page that doesn’t exist, and the site redirected (status ${input.missingStatus}).`, why: 'Google treats a redirect to the home page as a missing page anyway, and visitors are left wondering where they are.', start: 'Answer missing pages with a 404 status and a page that helps people find what they wanted.', link: LINKS.web });
  else if (input.missingStatus === 404 || input.missingStatus === 410) add({ id: 'soft-404', group: 'technical', status: 'strength', priority: 'low', title: 'Missing pages say “not found”',
    detail: `A page that doesn’t exist answers with status ${input.missingStatus}.`, why: 'Search engines drop missing pages cleanly.', start: 'Make sure the page-not-found page links to your main pages.', link: LINKS.web });

  // Security: files loaded over http on an https page, and the basic security headers (a note, never a fault)
  if (finalUrl.protocol === 'https:') {
    const insecure = [];
    for (const t of p.raw.matchAll(/<(img|script|iframe|source|video|audio|embed|link)\b[^>]*>/gi)) {
      const tag = t[0];
      const url = t[1].toLowerCase() === 'link' ? (/stylesheet/i.test(attr(tag, 'rel') || '') ? attr(tag, 'href') : null) : attr(tag, 'src');
      if (url && /^http:\/\//i.test(url)) insecure.push(url);
    }
    if (insecure.length) add({ id: 'mixed-content', group: 'technical', status: 'weakness', priority: 'medium', title: 'Some files load over insecure http',
      detail: `${insecure.length} image${insecure.length === 1 ? ', script or other file loads' : 's, scripts or other files load'} from an http address, for example ${insecure[0].slice(0, 70)}.`,
      why: 'Browsers block or warn about these on a secure page, so images can go missing and the padlock can show a warning.', start: 'Change those addresses to https.', link: LINKS.web });
    const hd = input.headers;
    if (hd) {
      const missingH = [!hd.hsts && 'HSTS (tells browsers to always use https)', !/nosniff/i.test(hd.nosniff) && 'X-Content-Type-Options', !hd.frame && !/frame-ancestors/i.test(hd.csp) && 'protection against being shown inside other sites', !hd.referrer && 'a Referrer-Policy'].filter(Boolean);
      if (!missingH.length) add({ id: 'security-headers', group: 'technical', status: 'strength', priority: 'low', title: 'Security headers in place',
        detail: 'The site sends HSTS, X-Content-Type-Options, frame protection and a Referrer-Policy.', why: 'They make some common attacks harder.', start: 'Nothing to do here.', link: LINKS.web });
      else add({ id: 'security-headers', group: 'technical', status: 'note', priority: 'low', title: 'Some security headers are missing',
        detail: `The site doesn’t send ${list(missingH)}.`, why: 'They are small settings at your host that make some attacks harder. Many small sites don’t have them all, so this is a note, not a fault.', start: 'Ask your host or developer to add them.', link: LINKS.web });
    }
  }

  // Link previews (Open Graph): how the page looks when shared on LinkedIn, WhatsApp or Facebook
  const og = [['a title', p.ogTitle], ['a description', p.ogDescription], ['an image', p.ogImage]];
  const ogMissing = og.filter(([, v]) => !v).map(([k]) => k);
  if (!ogMissing.length) add({ id: 'social-tags', group: 'share', status: 'strength', priority: 'low', title: 'Link previews set up',
    detail: 'The page has an Open Graph title, description and image.', why: 'LinkedIn, WhatsApp and Facebook can show your picture and words when someone shares the page.', start: 'Check the image still looks right at 1200 by 630 pixels.', link: LINKS.web });
  else add({ id: 'social-tags', group: 'share', status: 'weakness', priority: 'low', title: ogMissing.length === 3 ? 'No link preview set up' : 'The link preview is incomplete',
    detail: ogMissing.length === 3 ? 'I couldn’t find an Open Graph title, description or image.' : `The page’s Open Graph tags have no ${list(ogMissing.map(k => k.replace(/^an? /, '')))}.`,
    why: 'When someone shares the page on LinkedIn, WhatsApp or Facebook, the preview is what they see first. Without these tags the app guesses, often badly.',
    start: 'Add og:title, og:description and og:image (1200 by 630 pixels). Most website builders have a social sharing setting.', link: LINKS.web });

  // Trust and UK basics: privacy policy, cookie consent, company details
  const ga4Tag = /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(p.raw);
  const gtmTag = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i.test(p.raw);
  const otherTrackers = [/connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init/i, /static\.hotjar\.com|hotjar\.com\/c\/hotjar/i, /clarity\.ms\/tag/i, /analytics\.tiktok\.com/i, /snap\.licdn\.com\/li\.lms-analytics/i, /googleadservices\.com\/pagead\/conversion|gtag\(\s*['"]config['"]\s*,\s*['"]AW-/i]
    .some(re => re.test(p.raw));
  const tracking = ga4Tag || gtmTag || otherTrackers;
  const collects = tracking || p.forms.some(fm => /type\s*=\s*["']?(email|tel)|<textarea/i.test(fm));
  const privacyLink = p.links.find(l => /privacy/i.test(l.text) || /privacy/i.test(l.href));
  if (privacyLink) add({ id: 'privacy', group: 'trust', status: 'strength', priority: 'low', title: 'A privacy policy is linked',
    detail: `The page links to “${(privacyLink.text || privacyLink.href).slice(0, 40)}”.`, why: 'Visitors can see how their details are used.', start: 'Keep it up to date when you add new forms or tracking.', link: LINKS.web });
  else if (collects) add({ id: 'privacy', group: 'trust', status: 'weakness', priority: 'medium', title: 'No privacy policy linked from this page',
    detail: `The page ${tracking ? 'uses tracking' : 'has a form'}, but I couldn’t find a link to a privacy policy.`, why: 'Under UK GDPR, people must be told how their personal details are used when you collect them. It also reassures them.', start: 'Add a privacy notice and link it from the footer and beside your enquiry form.', link: LINKS.web });

  const CONSENT = /cookiebot|onetrust|otSDKStub|cookieyes|cookie-script|termly|iubenda|complianz|usercentrics|quantcast\.mgr|didomi|osano|cookiefirst|cookiecontrol|civicuk|cookie-law-info|cookie-notice|borlabs|klaro|tarteaucitron|cmp\.|consentmanager|gtag\(\s*['"]consent['"]\s*,\s*['"]default|Shopify\.customerPrivacy|privacy-banner/i;
  const consentText = /\b(we use cookies|this (?:site|website) uses cookies|accept (?:all )?cookies|reject (?:all )?(?:non-essential )?cookies|cookie (?:settings|preferences|consent)|manage cookies)\b/i;
  const consent = CONSENT.test(p.raw) || consentText.test(p.text);
  if (tracking && consent) add({ id: 'cookie-consent', group: 'trust', status: 'strength', priority: 'low', title: 'A cookie consent tool',
    detail: 'The page has tracking and signs of a cookie consent tool.', why: 'Visitors can be asked before tracking starts.', start: 'Check that rejecting is as easy as accepting, and that tracking waits for a yes.', link: LINKS.tracking });
  else if (tracking && !ga4Tag && !otherTrackers) add({ id: 'cookie-consent', group: 'trust', status: 'note', priority: 'low', title: 'Check your cookie banner',
    detail: 'The page loads Google Tag Manager, but I couldn’t see a cookie banner in its code. Banners added through Tag Manager don’t show from outside.', why: 'UK rules require consent before advertising cookies and most other tracking, with a few exceptions.', start: 'Open the site in a private window and check a banner appears before tracking starts.', link: LINKS.tracking });
  else if (tracking) add({ id: 'cookie-consent', group: 'trust', status: 'weakness', priority: 'medium', title: 'Tracking, but no cookie banner I can see',
    detail: 'The page loads tracking, but I couldn’t find a cookie banner or consent tool in its code.', why: 'UK rules require consent before advertising cookies and most other tracking, with a few exceptions.', start: 'Add a consent tool so tracking waits until visitors accept, with rejecting as easy as accepting.', link: LINKS.tracking });

  // A limited company's website must show its registered name, number, place of registration and registered office
  // (the Company, LLP and Business (Names and Trading Disclosures) Regulations 2015). Judged on this page's footer and the
  // business's structured data, so a supplier named in the text doesn't count.
  const orgName = String((nodes.find(n => n.legalName) || {}).legalName || (local && local.name) || (nodes.find(n => typesOf(n).some(t => /^(Organization|Corporation)$/.test(t))) || {}).name || '');
  const ltd = (p.footer.match(/\b[A-Z][\w&'.-]*(?:\s[A-Z][\w&'.-]*){0,4}\s(?:Ltd|Limited|LLP|PLC|plc)\b\.?/) || orgName.match(/^.*\b(?:Ltd|Limited|LLP|PLC|plc)\b\.?/) || [])[0];
  if (ltd) {
    const number = /\b(?:company|registration|registered|reg\.?)\s*(?:no\.?|number|num\.?|#)?\s*[:.]?\s*(?:SC|NI|OC|SO|NC|R0)?\d{6,8}\b/i.test(p.text) || /registered in (?:england|scotland|wales|northern ireland)[^.]{0,80}?\b(?:SC|NI|OC|SO|NC)?\d{6,8}\b/i.test(p.text);
    const office = /registered (?:office|address)/i.test(p.text);
    if (number && office) add({ id: 'company-details', group: 'trust', status: 'strength', priority: 'low', title: 'Company details shown',
      detail: 'I found a company number and a registered office.', why: 'UK law requires them on a company’s website, and they reassure customers.', start: 'Check the full registered name and where it is registered are there too.', link: LINKS.web });
    else add({ id: 'company-details', group: 'trust', status: 'weakness', priority: number ? 'low' : 'medium', title: number ? 'No registered office address found' : 'No company number on this page',
      detail: `The page names a company (“${ltd.trim().slice(0, 50)}”) but I couldn’t find its ${number ? 'registered office address' : 'company number or registered office'}.`,
      why: 'UK companies and LLPs must show their registered name, number, where they are registered and their registered office address on their website. It also reassures customers.',
      start: 'Add one line to the footer: the company name, “registered in England and Wales” (or Scotland, or Northern Ireland), the company number and the registered office address.', link: LINKS.web });
  }

  // Conversion: a long contact form loses people
  const formFields = contactForm ? [...contactForm.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].filter(t => t[1].toLowerCase() !== 'input' || !/type\s*=\s*["']?(hidden|submit|button|image|reset|checkbox|radio)\b/i.test(t[0])).length : 0;
  if (formFields > 6) add({ id: 'form-length', group: 'contact', status: 'weakness', priority: 'low', title: 'The contact form is long',
    detail: `The form asks for ${formFields} things.`, why: 'Each extra field loses some people. A name, a way to reply and a message is usually enough for a first enquiry.', start: 'Cut it to what you need to reply, and ask the rest when you do.', link: LINKS.web });

  const scan = siteFindings(input, add, model, p.links.map(l => (l.text + ' ' + l.href).toLowerCase()).join(' | '), routes.length > 0);

  const order = { high: 0, medium: 1, low: 2 };
  const strengths = out.filter(f => f.status === 'strength');
  const weaknesses = out.filter(f => f.status === 'weakness').sort((a, b) => order[a.priority] - order[b.priority]);
  const notes = out.filter(f => f.status === 'note');
  return {
    rulesVersion: RULES_VERSION,
    page: { title: p.title, h1, lang: p.lang || null },
    model, modelFrom, detected, scan,
    profile: siteProfile({ p, h1, nodes, types, local, foundPlace: place || (foundPlace === 'a postcode' ? foundPlace : null), wide: wide || (model === 'national' && !place), routes, contactTop, postcodes, finalUrl, platform, shopSigns, model, modelFrom }),
    strengths, weaknesses, notes,
    counts: { strengths: strengths.length, weaknesses: weaknesses.length, high: weaknesses.filter(w => w.priority === 'high').length },
  };
}
