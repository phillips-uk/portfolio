// The Website Check's rules (plan section 4). Fixed, written rules only: no AI of any kind. Each rule looks at what was
// fetched from the visitor's site (the page, robots.txt, the sitemap, llms.txt, PageSpeed Insights) and gives a
// strength or a weakness, with why it matters and where to start. Pure functions, so they can be tested without a network.
//
// A finding: { id, group, status: 'strength' | 'weakness' | 'note', priority: 'high' | 'medium' | 'low', title, detail,
//              why, start, link: { href, label } }

export const RULES_VERSION = 2; // 2 (17 Nov 2026): quotes credited to a person count as reviews

const LINKS = {
  web: { href: '/web-design/', label: 'Web design' },
  seo: { href: '/local-seo/', label: 'Local SEO and AI search' },
  systems: { href: '/marketing-systems/', label: 'Marketing systems' },
  tracking: { href: '/guides/fix-google-ads-conversion-tracking/', label: 'Guide: fix conversion tracking' },
};

export const GROUPS = [
  ['speed', 'Speed'],
  ['mobile', 'Phones'],
  ['first', 'First impression'],
  ['contact', 'Contact details'],
  ['search', 'Search basics'],
  ['technical', 'Technical'],
  ['ai', 'AI search'],
  ['measure', 'Measuring enquiries'],
  ['proof', 'Reviews and proof'],
];

// ---------- HTML helpers (regex based: enough for these checks, no DOM in a Worker) ----------

const decode = s => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
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
const REVIEW_TEXT = /(testimonials?\b|customer reviews|google reviews|what (?:our|my) (?:customers|clients) say|\b\d(?:\.\d)? out of 5\b|\bfive[- ]star|\b5[- ]star|★★★)/i;

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

export function readPsi(json) {
  if (!json || !json.lighthouseResult) return null;
  const lh = json.lighthouseResult;
  const a = lh.audits || {};
  const n = id => (a[id] && typeof a[id].numericValue === 'number') ? a[id].numericValue : null;
  const score = id => (a[id] && typeof a[id].score === 'number') ? a[id].score : null;
  const field = (json.loadingExperience && json.loadingExperience.metrics && json.loadingExperience.origin_fallback !== true) ? json.loadingExperience.metrics : null;
  const f = k => field && field[k] && typeof field[k].percentile === 'number' ? field[k].percentile : null;
  return {
    performance: lh.categories && lh.categories.performance && typeof lh.categories.performance.score === 'number' ? Math.round(lh.categories.performance.score * 100) : null,
    seo: lh.categories && lh.categories.seo && typeof lh.categories.seo.score === 'number' ? Math.round(lh.categories.seo.score * 100) : null,
    accessibility: lh.categories && lh.categories.accessibility && typeof lh.categories.accessibility.score === 'number' ? Math.round(lh.categories.accessibility.score * 100) : null,
    lcp: n('largest-contentful-paint'),
    cls: n('cumulative-layout-shift'),
    tbt: n('total-blocking-time'),
    fcp: n('first-contentful-paint'),
    bytes: n('total-byte-weight'),
    targetSize: score('target-size'),
    fontSize: score('font-size'),
    field: field ? {
      lcp: f('LARGEST_CONTENTFUL_PAINT_MS'),
      inp: f('INTERACTION_TO_NEXT_PAINT'),
      cls: f('CUMULATIVE_LAYOUT_SHIFT_SCORE') != null ? f('CUMULATIVE_LAYOUT_SHIFT_SCORE') / 100 : null,
      category: json.loadingExperience.overall_category || null,
    } : null,
  };
}

const secs = ms => (Math.round(ms / 100) / 10).toFixed(1) + ' seconds';

// ---------- the rules ----------

export function analyse(input) {
  const out = [];
  const add = f => out.push(f);
  const p = parsePage(input.html);
  const nodes = schemaNodes(p.jsonLd);
  const types = nodes.flatMap(typesOf);
  const local = nodes.find(n => typesOf(n).some(isLocalType));
  const finalUrl = new URL(input.finalUrl || input.url);
  const textLower = p.text.toLowerCase();

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
        why: 'Most local searches happen on a phone, and a fast page keeps people reading.', start: 'Keep new images and add-ons light so it stays this way.', link: LINKS.web });
      else add({ id: 'speed-mobile', group: 'speed', status: 'weakness', priority: ms < 50 ? 'high' : 'medium',
        title: ms < 50 ? 'Slow on a phone' : 'Could be faster on a phone',
        detail: `Google’s speed test scores the page ${ms} out of 100 on a phone (90 or more is good).${lcpNote}`,
        why: 'People on phones leave slow pages before they read anything, and Google takes speed into account.',
        start: 'Start with the largest images: resize and compress them, and remove add-ons and scripts the page doesn’t need.', link: LINKS.web });
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
    detail: 'The page has no main heading (H1).', why: 'Visitors and search engines both look for one clear line that says what the business does.', start: 'Add one heading at the top that says what you do and where, in the words customers search for.', link: LINKS.seo });
  else if (h1.split(/\s+/).length < 3) add({ id: 'what-you-do', group: 'first', status: 'weakness', priority: 'medium', title: 'The main heading doesn’t say much',
    detail: `The main heading is “${h1.slice(0, 80)}”.`, why: 'A heading of one or two words rarely tells a new visitor what you do.', start: 'Rewrite it to say what you do and where, for example “Plumber in Ely for boiler repairs and bathrooms”.', link: LINKS.seo });
  else add({ id: 'what-you-do', group: 'first', status: 'strength', priority: 'medium', title: 'A clear main heading',
    detail: `The main heading reads “${h1.slice(0, 100)}”.`, why: 'Visitors see straight away what the page is about.', start: 'Check it uses the words your customers would search for.', link: LINKS.seo });

  // Where: a town or area near the top. Without a list of every place, look for the business's own locality from its
  // structured data, a postcode, or "in <Place>" in the title, heading or description.
  const localities = [];
  for (const n of nodes) {
    const addr = n.address && (Array.isArray(n.address) ? n.address : [n.address]);
    if (addr) for (const a of addr) if (a && a.addressLocality) localities.push(String(a.addressLocality));
    const area = n.areaServed && (Array.isArray(n.areaServed) ? n.areaServed : [n.areaServed]);
    if (area) for (const a of area) { const name = typeof a === 'string' ? a : a && a.name; if (name) localities.push(String(name)); }
  }
  const topBits = [p.title, h1, p.description, p.top.text].join(' ');
  const foundPlace = localities.find(l => l.length > 2 && topBits.toLowerCase().includes(l.toLowerCase()))
    || (topBits.match(/\b(?:in|across|around|near|serving|based in|covering)\s+((?:[A-Z][a-z]+)(?:[\s-](?:[A-Z][a-z]+|upon|on|under|in|le))*)/) || [])[1]
    || (POSTCODE.test(p.top.text) ? 'a postcode' : null);
  const notPlaces = /^(The|Our|Your|Every|All|Business|Home|Stock|Store|Touch|Time|Style|Love|Need|Store|January|February|March|April|May|June|July|August|September|October|November|December)$/;
  if (foundPlace && !notPlaces.test(foundPlace.split(/\s/)[0])) add({ id: 'where', group: 'first', status: 'strength', priority: 'medium', title: 'Says where you work',
    detail: `Near the top of the page I found “${foundPlace}”.`, why: 'Local customers, Google and AI assistants all look for the place before they trust a local business.', start: 'Keep the town or area in the page title and main heading.', link: LINKS.seo });
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
  const postcodes = [...new Set((p.text.match(POSTCODE_G) || []).map(s => s.replace(/\s+/g, ' ').toUpperCase()))];
  const contactForm = p.forms.find(f => /type\s*=\s*["']?(email|tel)|<textarea/i.test(f));
  const routes = [phones.length && 'a phone number', (emails.length || mailtos.length) && 'an email address', contactForm && 'a contact form'].filter(Boolean);
  if (routes.length) add({ id: 'contact-routes', group: 'contact', status: 'strength', priority: 'high', title: 'Contact details on the page',
    detail: `I found ${routes.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`, why: 'Different customers prefer different ways to get in touch.', start: telLinks.length || !phones.length ? 'Nothing to do here.' : 'Make the phone number a tap-to-call link (tel:).', link: LINKS.web });
  else add({ id: 'contact-routes', group: 'contact', status: 'weakness', priority: 'high', title: 'No phone, email or contact form on this page',
    detail: 'I couldn’t find a phone number, an email address or a contact form on the page I checked.', why: 'A visitor who wants to get in touch has to go looking, and many won’t.', start: 'Put at least one contact route on every page, ideally in the header and footer.', link: LINKS.web });
  if (phones.length && !telLinks.length) add({ id: 'tap-to-call', group: 'contact', status: 'weakness', priority: 'medium', title: 'The phone number isn’t tap-to-call',
    detail: 'The number is written on the page but isn’t a link.', why: 'On a phone, one tap to call is the easiest enquiry there is, and a link can be counted in Google Analytics.', start: 'Wrap the number in a tel: link.', link: LINKS.web });
  if (postcodes.length) add({ id: 'address', group: 'contact', status: 'strength', priority: 'low', title: 'An address on the page',
    detail: `I found the postcode ${postcodes[0]}${postcodes.length > 1 ? ` and ${postcodes.length - 1} more` : ''}.`, why: 'An address helps Google tie the site to the place, and reassures customers you are real.', start: 'Make sure it matches your Google Business Profile exactly.', link: LINKS.seo });
  else add({ id: 'address', group: 'contact', status: 'note', priority: 'low', title: 'No address on the page',
    detail: 'I couldn’t find a postcode on the page.', why: 'If customers visit you, an address helps. If you go to them, naming the area you cover is enough.', start: 'If you have premises, add the full address to the footer, written the same way as on your Google Business Profile.', link: LINKS.seo });
  const schemaPhones = [...new Set(nodes.map(n => n.telephone).filter(Boolean).map(normPhone).filter(isPhoneLike))];
  const mismatch = schemaPhones.filter(sp => phones.length && !phones.includes(sp));
  if (mismatch.length) add({ id: 'consistent', group: 'contact', status: 'weakness', priority: 'medium', title: 'The phone number in the page code differs from the one on the page',
    detail: 'The structured data (the business details written for search engines) has a different phone number from the one visitors see.', why: 'Google and AI assistants trust a business more when its details match everywhere.', start: 'Use one number and update it in the structured data, the page and your Google Business Profile.', link: LINKS.seo });
  else if (telLinks.length > 2) add({ id: 'consistent', group: 'contact', status: 'note', priority: 'low', title: `${telLinks.length} different phone numbers`,
    detail: `The page links to ${telLinks.length} different phone numbers.`, why: 'That can be right (an office and a mobile), but too many can confuse customers and search engines.', start: 'Check each one is meant to be there.', link: LINKS.seo });
  const gbp = p.links.find(l => GBP_LINK.test(l.href)) || (/<iframe\b[^>]*google\.[a-z.]+\/maps/i.test(p.raw) ? { href: 'map' } : null);
  if (gbp) add({ id: 'gbp-link', group: 'contact', status: 'strength', priority: 'medium', title: 'Links to Google Maps or your Business Profile',
    detail: gbp.href === 'map' ? 'The page has a Google map.' : 'The page links to your Google Maps listing or Business Profile.', why: 'It connects the website and the profile, and makes reviews and directions one tap away.', start: 'Make sure the link opens your own profile.', link: LINKS.seo });
  else add({ id: 'gbp-link', group: 'contact', status: 'weakness', priority: 'medium', title: 'No link to your Google Business Profile',
    detail: 'I couldn’t find a link to Google Maps or a Google Business Profile.', why: 'The profile is what shows in the map results for local searches. Linking both ways helps Google connect them, and sends customers to your reviews.', start: 'Link to your profile from the footer or contact section. If you don’t have one yet, set it up first.', link: LINKS.seo });

  // Search basics: title, description, one heading, structured data, indexing
  const tl = p.title.length;
  if (!tl) add({ id: 'title', group: 'search', status: 'weakness', priority: 'high', title: 'No page title',
    detail: 'The page has no title.', why: 'The title is the blue headline in Google’s results; without one Google makes one up.', start: 'Write a title of about 50 to 60 characters: what you do, where, and your name.', link: LINKS.seo });
  else if (tl < 15 || tl > 65) add({ id: 'title', group: 'search', status: 'weakness', priority: 'medium', title: tl < 15 ? 'The page title is very short' : 'The page title is long',
    detail: `The title is “${p.title.slice(0, 120)}” (${tl} characters).`, why: tl < 15 ? 'A short title wastes the space that tells searchers what you do.' : 'Google cuts titles off at around 60 characters, so the end may not show.', start: 'Aim for about 50 to 60 characters: what you do, where, and your name.', link: LINKS.seo });
  else add({ id: 'title', group: 'search', status: 'strength', priority: 'medium', title: 'A page title of a good length',
    detail: `“${p.title}” (${tl} characters).`, why: 'It fits in Google’s results without being cut off.', start: 'Check it names what you do and where.', link: LINKS.seo });
  const dl = p.description.length;
  if (!dl) add({ id: 'description', group: 'search', status: 'weakness', priority: 'medium', title: 'No meta description',
    detail: 'The page has no description for search results.', why: 'Google may show a random bit of the page under your title instead of a line that makes people click.', start: 'Write one or two sentences (up to about 155 characters) on what you do, where and why to choose you.', link: LINKS.seo });
  else if (dl < 50 || dl > 170) add({ id: 'description', group: 'search', status: 'weakness', priority: 'low', title: dl < 50 ? 'The meta description is short' : 'The meta description is long',
    detail: `It is ${dl} characters.`, why: dl < 50 ? 'There is room to say more about why someone should click.' : 'Google cuts it off at around 155 characters.', start: 'Aim for about 120 to 155 characters.', link: LINKS.seo });
  else add({ id: 'description', group: 'search', status: 'strength', priority: 'low', title: 'A meta description of a good length',
    detail: `It is ${dl} characters.`, why: 'It gives Google a ready-made line to show under your title.', start: 'Nothing to do here.', link: LINKS.seo });
  if (p.h1s.length > 1) add({ id: 'one-heading', group: 'search', status: 'weakness', priority: 'low', title: `${p.h1s.length} main headings`,
    detail: `The page has ${p.h1s.length} H1 headings.`, why: 'One main heading makes the page’s subject clear to search engines and screen readers.', start: 'Keep one H1 and make the others H2.', link: LINKS.seo });

  if (local) {
    const missing = ['name', 'address', 'telephone', 'url'].filter(k => !local[k]);
    add({ id: 'local-schema', group: 'search', status: missing.length > 1 ? 'weakness' : 'strength', priority: 'medium',
      title: missing.length > 1 ? 'Business details for search engines are incomplete' : 'Business details written for search engines',
      detail: `The page describes the business as ${typesOf(local).join(', ')} in structured data` + (missing.length ? `, without ${missing.join(', ').replace(/, ([^,]*)$/, ' or $1')}.` : '.'),
      why: 'Structured data tells Google and AI assistants your name, area and contact details in a form they read reliably.',
      start: missing.length ? 'Add the missing details to the LocalBusiness structured data.' : 'Keep it matching your Google Business Profile.', link: LINKS.seo });
  } else add({ id: 'local-schema', group: 'search', status: 'weakness', priority: 'medium',
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
    detail: `robots.txt blocks ${blockedSearch.join(', ')}, which fetch pages to answer people’s questions.`, why: 'Customers who ask ChatGPT, Perplexity or Claude for a local business can’t be shown yours if the assistant can’t read it.', start: 'Allow these crawlers in robots.txt (check your host or Cloudflare settings, which sometimes block them for you).', link: LINKS.seo });
  else add({ id: 'ai-search-bots', group: 'ai', status: 'strength', priority: 'medium', title: 'AI assistants can read the site',
    detail: 'robots.txt doesn’t block the crawlers that ChatGPT, Perplexity and Claude use to answer questions.', why: 'Your pages can be read and cited when someone asks an assistant for a business like yours.', start: 'Nothing to do here.', link: LINKS.seo });
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

  // Reviews and proof
  const ratingSchema = nodes.some(n => n.aggregateRating || typesOf(n).includes('Review') || typesOf(n).includes('AggregateRating'));
  const cited = p.raw.match(QUOTE_CITE);
  const reviewSign = (p.text.match(REVIEW_TEXT) || p.raw.match(REVIEW_LINKS) || [])[0]
    || (cited ? 'a quote from ' + stripTags(cited[1]).trim() : null)
    || (p.raw.match(REVIEW_CLASS) ? 'a testimonials or reviews block' : null);
  if (ratingSchema || reviewSign) add({ id: 'proof', group: 'proof', status: 'strength', priority: 'medium', title: 'Reviews or proof on the page',
    detail: ratingSchema ? 'The page shows ratings or reviews, marked up for search engines.' : `I found signs of reviews or testimonials (“${String(reviewSign).slice(0, 40)}”).`,
    why: 'New customers look for proof that others were happy.', start: 'Keep them recent, and link to where people can read more.', link: LINKS.seo });
  else add({ id: 'proof', group: 'proof', status: 'weakness', priority: 'medium', title: 'No reviews or testimonials on the page',
    detail: 'I couldn’t find reviews, testimonials, star ratings or a review service on the page.', why: 'People choosing a local business look for proof that others were happy before they get in touch.', start: 'Ask recent customers for Google reviews and show a few on the page, with a link to read them all.', link: LINKS.seo });

  const order = { high: 0, medium: 1, low: 2 };
  const strengths = out.filter(f => f.status === 'strength');
  const weaknesses = out.filter(f => f.status === 'weakness').sort((a, b) => order[a.priority] - order[b.priority]);
  const notes = out.filter(f => f.status === 'note');
  return {
    rulesVersion: RULES_VERSION,
    page: { title: p.title, h1, lang: p.lang || null },
    strengths, weaknesses, notes,
    counts: { strengths: strengths.length, weaknesses: weaknesses.length, high: weaknesses.filter(w => w.priority === 'high').length },
  };
}
