// Demo websites for the Website Check (Lewis, 18 Nov 2026): made-up home pages, from an old DIY trade site to a
// well-built clinic, so the real report can be reviewed in /admin#demos/web before people use it. Each one runs through
// the same rules (website-check-rules.js analyse) and the same page a visitor sees. Every name, number and address is
// invented, the domains end in .example (a name reserved for examples, so none of them is a real site), and the
// report says it is a demo. Never shown to a visitor.
//
// A demo is a short description turned into the page's HTML plus what the check fetches around it (robots.txt,
// sitemap, the http redirect, llms.txt and Google's speed scores), the same input gather() hands to analyse().

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function page(s) {
  const head = [
    `<html${s.lang === false ? '' : ' lang="en-GB"'}><head><meta charset="utf-8">`,
    s.viewport ? `<meta name="viewport" content="${s.viewport}">` : '',
    s.title != null ? `<title>${esc(s.title)}</title>` : '',
    s.desc ? `<meta name="description" content="${esc(s.desc)}">` : '',
    s.noindex ? '<meta name="robots" content="noindex, nofollow">' : '',
    s.canonical !== false ? `<link rel="canonical" href="https://www.${s.domain}/">` : '',
    s.og ? `<meta property="og:title" content="${esc(s.title || '')}">` : '',
    s.ga4 === 'gtm' ? '<script>(function(w,d,s,l,i){})(window,document,"script","dataLayer","GTM-AB12CD3");</script>' : s.ga4 ? '<script async src="https://www.googletagmanager.com/gtag/js?id=G-DEMO12345"></script>' : '',
    s.platform === 'shopify' ? '<link rel="preconnect" href="https://cdn.shopify.com">' : s.platform === 'wix' ? '<link rel="preconnect" href="https://static.wixstatic.com">' : '',
    ...(s.schema || []).map((j) => `<script type="application/ld+json">${typeof j === 'string' ? j : JSON.stringify(j)}</script>`),
    '</head>',
  ].join('\n');
  const top = [
    '<body><header>',
    `<a href="/">${esc(s.name)}</a>`,
    '<nav><a href="/about/">About</a> <a href="/services/">Services</a></nav>',
    s.topContact ? `<a href="${s.topContact[0]}">${esc(s.topContact[1])}</a>` : '',
    '</header><main>',
    ...(s.h1s || []).map((h) => `<h1>${esc(h)}</h1>`),
    s.intro ? `<p>${esc(s.intro)}</p>` : '',
  ].join('\n');
  const imgs = Array.from({ length: s.images || 0 }, (_, i) => (i < (s.images || 0) * (s.altShare ?? 1) ? `<img src="/img/${i}.jpg" alt="${esc(s.name)} photo ${i + 1}">` : `<img src="/img/${i}.jpg">`)).join('\n');
  const filler = (s.sections || []).map(([h, t]) => `<section><h2>${esc(h)}</h2><p>${esc(t)}</p></section>`).join('\n');
  const proof = s.reviews ? `<section><h2>What customers say</h2><blockquote>${esc(s.reviews)}</blockquote></section>` : '';
  const contact = [
    '<section id="contact"><h2>Get in touch</h2>',
    s.phone ? (s.telLink ? `<p>Call <a href="tel:${s.phone.replace(/\s/g, '')}">${s.phone}</a></p>` : `<p>Call ${s.phone}</p>`) : '',
    ...(s.extraPhones || []).map((p) => `<p><a href="tel:${p.replace(/\s/g, '')}">${p}</a></p>`),
    s.email ? `<p>Email <a href="mailto:${s.email}">${s.email}</a></p>` : '',
    s.form ? '<form action="/send"><input type="text" name="name"><input type="email" name="email"><textarea name="message"></textarea><button>Send</button></form>' : '',
    s.address ? `<p>${esc(s.address)}</p>` : '',
    s.gbp === 'map' ? '<iframe src="https://www.google.com/maps/embed?pb=demo"></iframe>' : s.gbp ? '<p><a href="https://maps.app.goo.gl/demo123">Find us on Google Maps</a></p>' : '',
    '</section>',
  ].join('\n');
  return [head, top, imgs, filler, proof, contact, '</main><footer>', `<p>&copy; ${esc(s.name)}</p>`, '</footer></body></html>'].join('\n');
}

// Google's speed scores in the shape readPsi() returns.
const speed = (perf, o = {}) => ({ performance: perf, seo: o.seo ?? 92, accessibility: o.a11y ?? 88, lcp: o.lcp ?? (perf >= 90 ? 1800 : perf >= 50 ? 3600 : 7400), cls: o.cls ?? 0.04, tbt: o.tbt ?? (perf >= 90 ? 80 : 420), fcp: 1500, bytes: o.bytes ?? 1800000, targetSize: o.targetSize ?? 1, fontSize: o.fontSize ?? 1, field: o.field ?? null });

function input(s) {
  const url = `${s.https === false ? 'http' : 'https'}://www.${s.domain}/`;
  return {
    url, finalUrl: url, html: page(s),
    robots: s.robots === undefined ? `User-agent: *\nAllow: /\nSitemap: https://www.${s.domain}/sitemap.xml\n` : s.robots,
    sitemap: s.sitemap !== false, httpRedirects: s.https === false ? false : s.httpRedirects !== false,
    llms: Boolean(s.llms), robotsHeader: '',
    psi: { mobile: s.psi[0], desktop: s.psi[1] },
  };
}

const local = (o) => ({ '@context': 'https://schema.org', '@type': o.type || 'LocalBusiness', name: o.name, url: `https://www.${o.domain}/`, ...(o.phone ? { telephone: o.phone } : {}), ...(o.town ? { address: { '@type': 'PostalAddress', streetAddress: o.street || '1 High Street', addressLocality: o.town, postalCode: o.postcode } } : {}), ...(o.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: o.rating, reviewCount: o.count } } : {}) });

// 1. A local trade's old site, built years ago and left: no phone layout, not tap-to-call, slow, no tracking.
const TRADES = {
  domain: 'plumbing-demo.example', name: 'Demo Plumbing & Heating', title: 'Home', lang: false, canonical: false,
  h1s: ['Welcome'], intro: 'We have been in business for over 20 years. No job too small.',
  phone: '01353 000 111', telLink: false, email: 'info@plumbing-demo.example', address: '1 High Street, Ely CB7 4AA',
  images: 8, altShare: 0.2, sections: [['Our services', 'Boilers, bathrooms, leaks and more.']],
  https: true, httpRedirects: false, robots: null, sitemap: false,
  psi: [speed(24, { lcp: 8900, targetSize: 0, fontSize: 0, a11y: 61 }), speed(58)],
};

// 2. A salon on a website builder: tidy enough, booking link at the top, but no reviews, no Maps link, no analytics.
const SALON = {
  domain: 'salon-demo.example', name: 'Demo Hair Studio', platform: 'wix',
  title: 'Demo Hair Studio | Hair salon in Cambridge', desc: 'Cuts, colour and styling in Cambridge. Book online in a minute.',
  viewport: 'width=device-width, initial-scale=1', h1s: ['Hair salon in Cambridge'], intro: 'Cuts, colour and styling by a small team.',
  topContact: ['/book/', 'Book now'], phone: '01223 000 222', telLink: true,
  images: 12, altShare: 0.9, sections: [['Prices', 'Cut and finish from £45.'], ['The team', 'Four stylists, each with ten years or more.']],
  schema: [local({ type: 'HairSalon', name: 'Demo Hair Studio', domain: 'salon-demo.example', town: 'Cambridge', postcode: 'CB1 1AA' })],
  psi: [speed(54, { lcp: 4100 }), speed(81)],
};

// 3. An online shop on Shopify: reviews and tracking in place, but heavy apps make it slow, and images lack text.
const SHOP = {
  domain: 'candles-demo.example', name: 'Demo Candle Co.', platform: 'shopify', ga4: 'gtm', og: true,
  title: 'Demo Candle Co. | Hand-poured soy candles, made in Suffolk', desc: 'Hand-poured soy candles, reed diffusers and gift sets. Free UK delivery over £40.',
  viewport: 'width=device-width, initial-scale=1', h1s: ['Hand-poured soy candles', 'Bestsellers'], intro: 'Made in small batches in Suffolk and sent all over the UK.',
  topContact: ['/pages/contact', 'Contact'], email: 'hello@candles-demo.example', form: true,
  images: 24, altShare: 0.35, reviews: '"Beautiful scent and lovely packaging." 4.9 out of 5 from 1,200 reviews',
  schema: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Demo Candle Co.', url: 'https://www.candles-demo.example/', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.9, reviewCount: 1200 } }],
  llms: false,
  psi: [speed(38, { lcp: 6200, tbt: 1300, bytes: 6400000, field: { lcp: 3900, inp: 310, cls: 0.06, category: 'SLOW' } }), speed(72)],
};

// 4. A clinic built properly: fast, clear, tracked, local details right everywhere. The report should lead with good news.
const CLINIC = {
  domain: 'dental-demo.example', name: 'Demo Dental', ga4: 'gtm', og: true, llms: true,
  title: 'Demo Dental | Private dentist in Ely, Cambridgeshire', desc: 'Private dentist in Ely: implants, Invisalign, emergency appointments. New patients welcome. Book online or call.',
  viewport: 'width=device-width, initial-scale=1', h1s: ['Private dentist in Ely, Cambridgeshire'], intro: 'Implants, Invisalign and emergency appointments, with evening and Saturday slots.',
  topContact: ['tel:01353000333', 'Call 01353 000 333'], phone: '01353 000 333', telLink: true, email: 'hello@dental-demo.example', form: true,
  address: '2 Market Street, Ely CB7 4BB', gbp: true, images: 10, altShare: 1,
  reviews: '"Calm, kind and on time." 4.9 out of 5 from 310 Google reviews',
  sections: [['Treatments', 'Implants, Invisalign, whitening and check-ups.'], ['New patients', 'Book online and we will call to confirm.']],
  schema: [local({ type: 'Dentist', name: 'Demo Dental', domain: 'dental-demo.example', phone: '01353 000 333', town: 'Ely', street: '2 Market Street', postcode: 'CB7 4BB', rating: 4.9, count: 310 })],
  psi: [speed(94, { field: { lcp: 1900, inp: 120, cls: 0.02, category: 'FAST' } }), speed(99)],
};

// 5. A site relaunched with launch-day mistakes: still set to noindex, AI assistants blocked, schema broken, two phone numbers.
const RELAUNCH = {
  domain: 'builders-demo.example', name: 'Demo Builders', ga4: true,
  title: 'Demo Builders | Extensions and loft conversions in Peterborough', desc: 'Extensions, loft conversions and renovations across Peterborough. Free quotes.',
  viewport: 'width=device-width, initial-scale=1', noindex: true, h1s: ['Extensions and loft conversions in Peterborough'],
  topContact: ['/quote/', 'Get a free quote'], phone: '01733 000 444', telLink: true, form: true, address: 'Unit 3, Example Park, Peterborough PE1 1AA',
  images: 14, altShare: 0.8, reviews: '"Finished on time and on budget." Rated 4.8 on Checkatrade',
  schema: [local({ type: 'HomeAndConstructionBusiness', name: 'Demo Builders', domain: 'builders-demo.example', phone: '01733 000 999', town: 'Peterborough', postcode: 'PE1 1AA' }), '{ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [ ]'],
  robots: 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n',
  psi: [speed(71), speed(93)],
};

// 6. A busy restaurant: a map and reviews, but zoom is switched off, buttons are small and real visitors find it slow.
const RESTAURANT = {
  domain: 'bistro-demo.example', name: 'Demo Bistro',
  title: 'Demo Bistro | Restaurant in Bury St Edmunds, open seven days for lunch and dinner', desc: 'Seasonal food in Bury St Edmunds.',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no', h1s: ['Seasonal food in Bury St Edmunds'],
  topContact: ['/book/', 'Book a table'], phone: '01284 000 555', telLink: true, extraPhones: ['01284 000 556', '07700 900 557'],
  address: '5 Abbeygate Street, Bury St Edmunds IP33 1AA', gbp: 'map', images: 20, altShare: 0.5,
  reviews: '"The best Sunday lunch in town." 4.7 out of 5 on Google',
  schema: [local({ type: 'Restaurant', name: 'Demo Bistro', domain: 'bistro-demo.example', phone: '01284 000 555', town: 'Bury St Edmunds', postcode: 'IP33 1AA' })],
  psi: [speed(63, { targetSize: 0, field: { lcp: 3100, inp: 260, cls: 0.21, category: 'AVERAGE' } }), speed(88)],
};

// 7. A national company: fast on a computer, slower on a phone, no place named (it works everywhere), contact form only.
const NATIONAL = {
  domain: 'software-demo.example', name: 'Demo Software Ltd', ga4: 'gtm', og: true, llms: true,
  title: 'Demo Software | Rota and payroll software for care homes, trusted by 900 UK care providers', desc: 'Rota, timesheets and payroll in one place for care homes and home care agencies across the UK. Book a demo, see pricing, or start a free 30-day trial with your own data and team today.',
  viewport: 'width=device-width, initial-scale=1', h1s: ['Rota and payroll software for care homes'], intro: 'Used by 900 care providers across the UK.',
  topContact: ['/demo/', 'Book a demo'], form: true, images: 16, altShare: 0.9,
  reviews: '"Saved our managers a day a week." Rated 4.6 on Capterra',
  schema: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Demo Software Ltd', url: 'https://www.software-demo.example/' }],
  psi: [speed(61, { tbt: 690 }), speed(96)],
};

const SITES = { trades: TRADES, salon: SALON, shop: SHOP, clinic: CLINIC, relaunch: RELAUNCH, restaurant: RESTAURANT, national: NATIONAL };

// The list shown in /admin#demos/web.
export const WEBSITE_DEMOS = [
  { id: 'trades', name: 'Local trade, old site', size: 'Small', model: 'Local service', build: 'Old', note: 'Built years ago and left: no phone layout, not tap-to-call, slow, no tracking, no sitemap.' },
  { id: 'salon', name: 'Salon on a website builder', size: 'Small', model: 'Local service', build: 'Template', note: 'Tidy, with booking at the top, but no reviews, no Maps link and no analytics.' },
  { id: 'shop', name: 'Online shop on Shopify', size: 'Small', model: 'Online sales', build: 'Template', note: 'Reviews and tracking in place, but heavy apps make it slow; images lack text.' },
  { id: 'clinic', name: 'Clinic, built properly', size: 'Mid', model: 'Local service', build: 'Custom', note: 'Fast, clear and tracked, local details right. The report should lead with good news.' },
  { id: 'relaunch', name: 'Builder after a relaunch', size: 'Mid', model: 'Local service', build: 'Custom', note: 'Launch-day mistakes: still set to noindex, AI assistants blocked, broken schema, two phone numbers.' },
  { id: 'restaurant', name: 'Busy restaurant', size: 'Mid', model: 'Local service', build: 'Template', note: 'Map and reviews, but zoom is off, buttons are small and real visitors find it slow.' },
  { id: 'national', name: 'National software company', size: 'Large', model: 'Leads, nationwide', build: 'Custom', note: 'Fast on a computer, slower on a phone, no place named, form only, long title and description.' },
].map((d) => ({ ...d, input: () => input({ ...SITES[d.id] }) }));

export function findWebsiteDemo(id) {
  return WEBSITE_DEMOS.find((d) => d.id === id) || WEBSITE_DEMOS[0];
}
