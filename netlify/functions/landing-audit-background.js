/**
 * landing-audit-background.js
 * Netlify Background Function — runs a full landing page audit.
 *
 * Called by landing-page-audit.html via POST { url, jobId }
 * Returns 202 immediately. Result stored in Netlify Blobs under jobId.
 * Frontend polls /.netlify/functions/landing-audit-status?id={jobId}
 *
 * Env vars: PSI_API_KEY, ANTHROPIC_API_KEY, NETLIFY_SITE_ID, NETLIFY_PERSONAL_TOKEN
 */

const { getStore } = require('@netlify/blobs');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

function getBlobsStore () {
  return getStore({
    name:   'landing-audits',
    siteID: process.env.NETLIFY_SITE_ID,
    token:  process.env.NETLIFY_PERSONAL_TOKEN
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return; }

  const { url, jobId } = body;
  if (!url || !jobId) return;

  let store;
  try {
    store = getBlobsStore();
    await store.set(jobId, JSON.stringify({ status: 'pending' }));
  } catch (e) {
    console.error('Blobs init error:', e.message);
    return; // Nothing we can do without storage
  }

  try {
    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('bad protocol');
    } catch {
      await store.set(jobId, JSON.stringify({
        status: 'error',
        message: 'Invalid URL. Please include the full address, e.g. https://example.com/page'
      }), { ttl: 3600 });
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';

    console.log('[audit] start', url);

    // 1. Fetch HTML
    let html = '';
    let fetchError = null;
    let fetchStatus = 200;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language':           'en-GB,en;q=0.9',
          'Accept-Encoding':           'gzip, deflate, br',
          'Cache-Control':             'no-cache',
          'Pragma':                    'no-cache',
          'Sec-Fetch-Dest':            'document',
          'Sec-Fetch-Mode':            'navigate',
          'Sec-Fetch-Site':            'none',
          'Upgrade-Insecure-Requests': '1'
        }
      });
      clearTimeout(timeout);
      fetchStatus = res.status;
      if (!res.ok) {
        fetchError = `HTTP ${res.status}`;
      } else {
        html = await res.text();
      }
    } catch (e) {
      fetchError = e.message;
    }

    // Classify HTTP error codes into readable keys
    if (fetchError === 'HTTP 403' || fetchError === 'HTTP 429')
      fetchError = 'blocked';
    else if (fetchError && fetchError.startsWith('HTTP 4'))
      fetchError = 'http_client_error';
    else if (fetchError && fetchError.startsWith('HTTP 5'))
      fetchError = 'http_server_error';
    else if (fetchError && /abort|timeout/i.test(fetchError))
      fetchError = 'timeout';
    else if (fetchError)
      fetchError = 'network_error';

    // Detect bot-block pages (Cloudflare, WAFs) even when response was 200
    if (!fetchError && !!detectBotBlock(html)) {
      fetchError = 'blocked';
    }

    console.log('[audit] fetch result:', fetchError || 'ok', 'html length:', html.length);

    console.log('[audit] html fetched, length:', html.length, 'error:', fetchError || 'none');

    // 2. Parse HTML
    const parsed = parseHtml(html, url, isHttps, fetchError);

    // Extract keyword from URL slug (strongest signal — set explicitly by site owner)
    parsed.urlKeyword = extractUrlKeyword(url);

    console.log('[audit] html parsed, h1:', parsed.h1 || 'none');

    // 3 + 4. PSI kicks off immediately. Claude is awaited directly.
    //   PSI runs concurrently in the background during Claude's execution.
    //   After Claude resolves, check the psiDone flag (set by PSI's .then()).
    //   If PSI is still running, store a partial result immediately so the
    //   frontend can show findings now — then wait for PSI and store the final.
    const psiKey = process.env.PSI_API_KEY;
    let psiMobile = null, psiDesktop = null;
    let psiDone = false;

    // Fire PSI — .then() sets flag + captures results when it resolves
    const psiPromise = (psiKey
      ? Promise.allSettled([fetchPsi(url, 'mobile', psiKey), fetchPsi(url, 'desktop', psiKey)])
      : Promise.resolve([{ status: 'fulfilled', value: null }, { status: 'fulfilled', value: null }])
    ).then(([mRes, dRes]) => {
      psiMobile = mRes?.status === 'fulfilled' ? mRes.value : null;
      psiDesktop = dRes?.status === 'fulfilled' ? dRes.value : null;
      psiDone = true;
      console.log('[audit] psi done — mobile:', psiMobile ? `score ${psiMobile.score}, src: ${psiMobile.dataSource}` : 'NULL', '| desktop:', psiDesktop ? `score ${psiDesktop.score}` : 'NULL');
    });

    // Await Claude — PSI is running concurrently during this await
    const claudeResult = await analyzeWithClaude(parsed);
    // After this await resolves, all microtasks queued during Claude's execution
    // (including PSI's .then() if it finished) will have run — so psiDone is accurate

    // Keyword fallback chain
    if (!claudeResult.inferred_keyword) {
      if (parsed.urlKeyword) {
        claudeResult.inferred_keyword          = parsed.urlKeyword;
        claudeResult.keyword_confidence        = 'high';
        claudeResult.keyword_confidence_reason = 'Inferred from the URL slug — the most explicit keyword signal on the page.';
      } else if (parsed.h1) {
        claudeResult.inferred_keyword = parsed.h1.trim();
        const h1Words = parsed.h1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const titleLow = (parsed.title || '').toLowerCase();
        const ratio = h1Words.length ? h1Words.filter(w => titleLow.includes(w)).length / h1Words.length : 0;
        claudeResult.keyword_confidence        = ratio >= 0.5 ? 'high' : 'medium';
        claudeResult.keyword_confidence_reason = ratio >= 0.5
          ? 'H1 and title tag share the same core keyword — strong alignment.'
          : 'Inferred from H1 heading. Title tag alignment is partial.';
      }
    }

    console.log('[audit] claude done, keyword:', claudeResult.inferred_keyword || 'none', 'findings:', (claudeResult.findings || []).length, '| psi already done:', psiDone);

    if (!psiDone) {
      // PSI still running — store partial result so frontend can show findings now
      try {
        const partial = buildReport(url, parsed, null, null, claudeResult, isHttps, fetchError, 'pending');
        partial.psi_pending = true;
        await store.set(jobId, JSON.stringify({ status: 'partial', data: partial }));
        console.log('[audit] partial result stored — awaiting PSI');
      } catch (e) {
        console.error('[audit] partial store error:', e.message);
      }
      // Wait for PSI to finish
      await psiPromise;
    }

    const psiStatus = psiMobile ? 'ok' : 'failed';

    // PSI content fallback — when direct fetch is blocked, Googlebot bypasses WAF.
    // Populates: title, meta, tracking signals (body / H1 / trust remain unavailable).
    if (parsed.fetchFailed && psiMobile?.contentSignals) {
      const cs = psiMobile.contentSignals;
      if (cs.title)           parsed.title           = cs.title;
      if (cs.metaDescription) parsed.metaDescription = cs.metaDescription;
      parsed.hasGtm             = cs.hasGtm;
      parsed.hasGa4             = cs.hasGa4;
      parsed.hasAdsConversion   = cs.hasAdsConversion;
      parsed.hasRemarketingOnly = !cs.hasAdsConversion && cs.hasRemarketingTag;
      parsed.contentFromPsi     = true;
      console.log('[audit] psi content fallback applied — title:', cs.title || 'none');
    }

    // 5. Build final report (with PSI data now available)
    const report = buildReport(url, parsed, psiMobile, psiDesktop, claudeResult, isHttps, fetchError, psiStatus);

    console.log('[audit] report built, score:', report.health_score);
    await store.set(jobId, JSON.stringify({ status: 'complete', data: report }));

    // Write lightweight lead record so Lewis can track who is scanning
    try {
      const leadsStore = getStore({
        name:   'landing-audit-leads',
        siteID: process.env.NETLIFY_SITE_ID,
        token:  process.env.NETLIFY_PERSONAL_TOKEN
      });
      const hostname = (() => {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
      })();
      const clientName = (() => {
        const n = hostname.split('.')[0];
        return n.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      })();
      const leadKey = 'lead-' + report.audited_at.slice(0, 10) + '-' + jobId.slice(0, 8);
      await leadsStore.set(leadKey, JSON.stringify({
        jobId,
        url,
        domain:    hostname,
        clientName,
        score:     report.health_score,
        band:      report.score_band,
        keyword:   report.inferred_keyword || null,
        auditedAt: report.audited_at
      }));
      console.log('[audit] lead stored:', leadKey, hostname);
    } catch (leadErr) {
      // Non-fatal — audit result is already saved
      console.error('[audit] lead store error:', leadErr.message);
    }

    console.log('[audit] complete');

  } catch (e) {
    console.error('Landing audit error:', e.message, e.stack);
    try {
      await store.set(jobId, JSON.stringify({
        status: 'error',
        message: 'Audit failed unexpectedly. Please try again.'
      }));
    } catch (writeErr) {
      console.error('Failed to write error to blobs:', writeErr.message);
    }
  }
};

// ─── URL keyword extraction ───────────────────────────────────────────────────

function extractUrlKeyword (url) {
  try {
    const path     = new URL(url).pathname;
    const segments = path.split('/').filter(s => s && !/\.(html?|php|asp|jsp)$/i.test(s));
    if (!segments.length) return null;
    // Last segment is most specific (e.g. /swimming-lessons/childrens-swimming-lessons → childrens-swimming-lessons)
    const slug    = segments[segments.length - 1];
    const keyword = slug.replace(/[-_]+/g, ' ').trim();
    // Must be a meaningful phrase (2+ words or 6+ chars), not just an ID
    if ((keyword.split(' ').length >= 2 || keyword.length >= 6) && !/^\d+$/.test(keyword)) {
      return keyword;
    }
    return null;
  } catch { return null; }
}

// ─── N-gram keyword analysis ─────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','of','is','it','as','by',
  'if','up','we','my','do','so','be','us','am','no','go','me','he','i','s',
  'are','was','for','not','you','all','any','can','had','her','one','our','out',
  'get','has','him','his','how','its','may','new','now','see','two','way','who',
  'did','man','put','say','she','too','use','also','back','been','come','does',
  'each','even','from','give','good','have','here','just','know','like','long',
  'make','many','more','most','much','must','name','need','only','open','over',
  'same','seem','some','such','take','than','that','them','then','there','they',
  'this','time','very','well','were','what','when','where','will','with','your',
  'about','after','again','along','being','below','could','every','first','found',
  'going','great','group','into','large','later','learn','light','might','never',
  'often','other','place','right','small','sound','still','study','their','these',
  'thing','think','those','three','until','using','while','world','would','years'
]);

// Marketing-quality adjectives that appear in page copy but are never the
// first word of a real search query (e.g. "quality children" is not a query).
// Filter these out as first-word of 2-grams unless the phrase is in the URL.
const QUERY_NOISE_MODIFIERS = new Set([
  'quality', 'excellent', 'exceptional', 'outstanding', 'superb', 'amazing',
  'fantastic', 'wonderful', 'perfect', 'premium', 'trusted', 'award',
  'leading', 'dedicated', 'expert', 'experienced', 'friendly', 'affordable',
  'professional', 'accredited', 'certified', 'qualified', 'reliable'
]);

function computeTopNgrams (bodyText, urlSlug, h1, title) {
  const urlLower   = (urlSlug  || '').toLowerCase();
  const h1Lower    = (h1       || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const titleLower = (title    || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  const words = bodyText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  const counts = {};
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const gram = words.slice(i, i + n).join(' ');
      counts[gram] = (counts[gram] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .filter(([phrase, count]) => {
      if (count < 2) return false;
      // Strip 2-grams where first word is a pure marketing-quality adjective
      // that never forms a meaningful search query (e.g. "quality children").
      // Exception: keep if the phrase appears in the URL (intentionally targeted).
      const pw = phrase.split(' ');
      if (pw.length === 2 && QUERY_NOISE_MODIFIERS.has(pw[0])) {
        if (!urlLower.includes(pw[0])) return false;
      }
      return true;
    })
    .map(([phrase, count]) => {
      const pw     = phrase.split(' ');
      const inUrl  = pw.every(w => urlLower.includes(w));
      const inH1   = pw.every(w => h1Lower.includes(w));
      const inTitle = pw.every(w => titleLower.includes(w));
      const bonus  = (inUrl ? 3 : 0) + (inH1 ? 3 : 0) + (inTitle ? 1 : 0);
      return { phrase, count, inUrl, inH1, inTitle, _score: count + bonus * 2 };
    })
    .sort((a, b) => b._score - a._score || b.count - a.count)
    .slice(0, 5)
    .map(({ phrase, count, inUrl, inH1, inTitle }) => ({ phrase, count, inUrl, inH1, inTitle }));
}

// ─── Bot-block detection ─────────────────────────────────────────────────────

function detectBotBlock (html) {
  if (!html) return false;
  // Cloudflare challenge / block pages
  if (/cf-error-details|cf_chl_opt|_cf_chl_enter/i.test(html))          return 'cloudflare';
  if (/Ray ID:[\s\S]{0,80}Cloudflare/i.test(html))                       return 'cloudflare';
  // Title-based signals (Cloudflare + generic WAFs)
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText  = titleMatch ? titleMatch[1].toLowerCase() : '';
  if (/just a moment|attention required/i.test(titleText))               return 'cloudflare';
  if (/access denied|403 forbidden|blocked/i.test(titleText))            return 'waf';
  // H1-level block messages
  if (/<h1[^>]*>[^<]*(sorry.*blocked|you have been blocked|access denied|403 forbidden)[^<]*<\/h1>/i.test(html)) return 'blocked';
  // Common WAF vendors
  if (/Incapsula incident|sucuri-cloudproxy|Barracuda Networks/i.test(html)) return 'waf';
  return false;
}

// ─── Page type detection ─────────────────────────────────────────────────────

function detectPageType (html, url) {
  const htmlSafe = html  || '';
  const urlLower = (url  || '').toLowerCase();

  // ── Platform detection ────────────────────────────────────────────────────
  // Platform is used ONLY to contextualise the tracking section and the H1 finding.
  // It has NO bearing on page type classification — Shopify/WooCommerce sites host
  // both product pages and lead-gen/service pages, and loose HTML signals in theme
  // JS can produce false positives if we score platform toward eCommerce.
  let platform = null;
  if (/cdn\.shopify\.com|myshopify\.com|Shopify\.theme|Shopify\.config|\/cdn\/shop\//i.test(htmlSafe))
    platform = 'shopify';
  else if (/class=["'][^"']*woocommerce|wp-content\/plugins\/woo/i.test(htmlSafe))
    platform = 'woocommerce';
  else if (/bigcommerce\.com|bc-sf-filter/i.test(htmlSafe))
    platform = 'bigcommerce';
  else if (/\bmagento\b|Mage\.Cookies|mage\//i.test(htmlSafe))
    platform = 'magento';

  // ── URL-based subtype — unambiguous signal ────────────────────────────────
  let subtype = null;
  if      (/\/collections\/[^/?#]+/i.test(urlLower))                   subtype = 'collection';
  else if (/\/products\/[^/?#]+/i.test(urlLower))                      subtype = 'product';
  else if (/\/cart\b|\/checkout\b/i.test(urlLower))                    subtype = 'cart';
  else if (/\/category\/|\/categories\/|\/cat\//i.test(urlLower))      subtype = 'collection';
  else if (/\/p\/[^/?#]+|\/item\/[^/?#]+/i.test(urlLower))            subtype = 'product';

  // ── Schema — only inside JSON-LD blocks, never loose JS strings ───────────
  // Scanning raw HTML for "@type":"Product" produces false positives from theme JS.
  // Restrict to actual <script type="application/ld+json"> blocks only.
  const jsonLdContent = (htmlSafe.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [])
    .map(s => s.replace(/<[^>]+>/g, '')).join('\n');
  const hasProductSchema  = /"@type"\s*:\s*"Product"/i.test(jsonLdContent);
  const hasOfferSchema    = /"@type"\s*:\s*"Offer"/i.test(jsonLdContent);
  const hasItemListSchema = /"@type"\s*:\s*"ItemList"/i.test(jsonLdContent);

  // ── Add-to-cart — only actual submit buttons, not JS strings ─────────────
  const hasAddToCart = /name=["']add["'][^>]*type=["']submit["']|type=["']submit["'][^>]*add.to.cart|<button[^>]*>\s*Add to (Cart|Bag)/i.test(htmlSafe);

  // ── og:type product ───────────────────────────────────────────────────────
  const hasOgProduct = /<meta[^>]+property=["']og:type["'][^>]+content=["']product["']/i.test(htmlSafe)
                    || /<meta[^>]+content=["']product["'][^>]+property=["']og:type["']/i.test(htmlSafe);

  // ── Classification ────────────────────────────────────────────────────────
  // KNOWN PLATFORMS (Shopify, WooCommerce, etc.): use URL only.
  // Theme JS bundles are loaded on every page regardless of its purpose —
  // /pages/, /blogs/, /policies/ all contain add-to-cart strings, price
  // classes, and product schema fragments from the global theme. Only the
  // URL path is unambiguously set by the site owner for the page's purpose.
  //
  // UNKNOWN PLATFORMS: use schema + content signals (no theme JS noise).
  let isEcommerce;
  if (platform) {
    isEcommerce = !!subtype; // /products/, /collections/, /cart, /checkout only
  } else {
    isEcommerce = !!(subtype || hasProductSchema || hasOfferSchema || hasItemListSchema || hasAddToCart || hasOgProduct);
  }

  return {
    type:     isEcommerce ? 'ecommerce' : 'lead_gen',
    platform: platform,
    subtype:  subtype || (isEcommerce ? 'generic' : null)
  };
}

// ─── HTML parsing ────────────────────────────────────────────────────────────

function parseHtml (html, url, isHttps, fetchError) {
  if (!html || fetchError) {
    return {
      fetchFailed: true, fetchError: fetchError || null, isHttps,
      pageTypeInfo: detectPageType('', url),
      title: '', metaDescription: '', h1: '', h2s: [], h3s: [],
      aboveFoldText: '', bodyText: '', linkCount: 0, navLinkCount: 0,
      formFieldCount: 0, hasAboveFoldCta: false, ctaText: '', ctaTexts: [],
      hasGtm: false, hasGa4: false, hasAdsConversion: false, hasRemarketingOnly: false,
      hasViewport: false, hasPrivacyLink: false,
      socialProofText: '', authoritySignals: '', contactSignals: '',
      hasPricing: false, pricingText: '', aboveFoldPhonePresent: false,
      imageCount: 0, hasSocialLinks: false,
      testimonialBlockCount: 0, hasVideoContent: false, hasTrustBadges: false,
      starRatingPresent: false, namedTestimonialPresent: false,
      topNgrams: []
    };
  }

  const $ = cheerio.load(html);

  const title           = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1              = $('h1').first().text().trim();
  const h2s             = $('h2').map((_, el) => $(el).text().trim()).get().filter(t => t).slice(0, 8);
  const h3s             = $('h3').map((_, el) => $(el).text().trim()).get().filter(t => t).slice(0, 5);
  const hasViewport     = $('meta[name="viewport"]').length > 0;

  // Privacy link — must be checked BEFORE stripping footer/nav
  const hasPrivacyLink = $('a').toArray().some(el => {
    const href = ($(el).attr('href') || '').toLowerCase();
    const text = $(el).text().toLowerCase();
    return href.includes('privacy') || text.includes('privacy');
  });

  // Structural trust signals — check BEFORE stripping (testimonial divs survive, but be safe)
  const testimonialBlockCount = $(
    'blockquote, [class*="testimonial"], [class*="review"], [class*="feedback"], [class*="quote"]'
  ).length;

  const hasVideoContent = $('video').length > 0
    || $('iframe[src*="youtube.com"], iframe[src*="youtu.be"], iframe[src*="vimeo.com"]').length > 0;

  // Trust badges — scan raw HTML (catches alt text, hidden labels, schema markup)
  const trustBadgeRx = /as seen in|featured in|swim england|ofsted|insured|certified|accredited|member of|regulated|fca approved|iso[ -]?\d+/i;
  const hasTrustBadges = trustBadgeRx.test(html);

  // Nav link count — must be checked BEFORE stripping nav
  const navLinkCount = $('nav a').length;

  // Above-fold text — extract from <main> before stripping nav, so Shopify/ecommerce
  // mobile menu drawers (menu-drawer, details[data-disclosure], etc.) are excluded.
  // These custom elements sit before <main> in the DOM and pollute a raw body slice.
  const $mainEl = $('main, [role="main"], #MainContent, #main-content, #content, .main-content').first();
  let aboveFoldText;
  if ($mainEl.length) {
    // Clone main, strip any nested nav-like elements, then take first 500 chars
    const $mainClone = $mainEl.clone();
    $mainClone.find(
      'nav, header, [class*="nav-"], [class*="-nav"], [id*="nav"], [id*="menu"],' +
      'menu-drawer, details[data-disclosure], [class*="drawer"], [class*="mobile-menu"],' +
      'script, style, noscript'
    ).remove();
    const mainText = $mainClone.text().replace(/\s+/g, ' ').trim();
    aboveFoldText = mainText.length > 80 ? mainText.substring(0, 500) : null;
  }

  // Strip noise then get body text
  $('script, style, nav, footer, header, noscript').remove();
  let bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  // Strip GTM Tag Assistant / click-tracking overlay UI (injected into DOM during GTM setup,
  // CSS-hidden for real visitors but present in raw HTML and confuses content analysis)
  bodyText = bodyText
    .replace(/Custom Event Setup\s*[×x]\s*Click on the elements[\s\S]{0,400}?Finish Setup/gi, '')
    .replace(/Track New Element\s*Selected Elements \(\d+\)/gi, '')
    .replace(/\s+/g, ' ').trim();
  // Fall back to body text if main element wasn't found or was empty
  if (!aboveFoldText) aboveFoldText = bodyText.substring(0, 500);

  // Star rating detection (post-strip body text)
  const starRatingRx = /★{3,}|☆{3,}|\d+\.?\d*\s*(stars?|out of 5|\/5)|rated\s+\d+|\d+\s*reviews?/i;
  const starRatingPresent = starRatingRx.test(bodyText);

  // Named testimonial — a real name pattern adjacent to testimonial blocks
  const namedTestimonialPresent = testimonialBlockCount > 0
    && /[A-Z][a-z]+\s+[A-Z][a-z]+|[A-Z][a-z]+,\s*(parent|customer|client|mum|dad|swimmer|member)/i.test(bodyText);

  const linkCount      = $('a[href]').length;
  const imageCount     = $('img').length;
  // Count max fields in a single form — prevents double-counting when the same
  // form appears twice (e.g. sticky header + page body copy both embedding the form)
  let formFieldCount = 0;
  const formEls = $('form');
  if (formEls.length > 0) {
    formEls.each((_, form) => {
      const n = $(form).find(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea'
      ).length;
      if (n > formFieldCount) formFieldCount = n;
    });
  } else {
    formFieldCount = $('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea').length;
  }
  // Collect unique input types across ALL forms — passed to Claude so it can't
  // incorrectly claim fields are missing when they exist in a sibling form
  const formFieldTypeSet = new Set();
  $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, select').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? ($(el).attr('type') || 'text').toLowerCase() : tag;
    formFieldTypeSet.add(type);
  });
  // Detect JavaScript-rendered forms that Cheerio can't parse from static HTML.
  // Squarespace, HubSpot, Typeform etc. inject form markup at runtime — static parse
  // sees 0 fields and falsely concludes there's no form.
  let jsFormPlatform = null;
  if (formFieldCount === 0) {
    if (/sqs-block-form|sqs-form|data-block-type=["']form/i.test(html))                   jsFormPlatform = 'Squarespace';
    else if (/hbspt\.forms|hbspt-form|hs-form-iframe|data-form-id/i.test(html))           jsFormPlatform = 'HubSpot';
    else if (/data-tf-widget|typeform\.com\/to\//i.test(html))                             jsFormPlatform = 'Typeform';
    else if (/gform_wrapper|gform_[0-9]/i.test(html))                                     jsFormPlatform = 'Gravity Forms';
    else if (/wpcf7-form\b/i.test(html))                                                   jsFormPlatform = 'Contact Form 7';
    else if (/data-netlify=["']true["']/i.test(html))                                      jsFormPlatform = 'Netlify Forms';
    else if (/jotform\.com|static\.jotform\.com/i.test(html))                             jsFormPlatform = 'JotForm';
    else if (/class=["'][^"']*form-block[^"']*["']|data-form-guid|forminator-form/i.test(html)) jsFormPlatform = 'embedded form block';
    if (jsFormPlatform) {
      formFieldCount = 3; // representative — prevents false "no form" finding
    }
  }
  const formFieldTypes = jsFormPlatform
    ? `js-rendered ${jsFormPlatform} (not parseable from static HTML — form confirmed from page structure)`
    : formFieldTypeSet.size > 0 ? [...formFieldTypeSet].join(', ') : 'none detected';

  // CTA detection (first 2000 chars of body HTML)
  const bodyHtmlSnip   = ($('body').html() || '').substring(0, 2000);
  const ctaKeywordsRx  = /\b(get started|book|call|contact|buy|order|sign up|request a quote|free|apply|subscribe|download|register|claim|start|try now)\b/i;
  const hasAboveFoldCta = /(<button|<input[^>]*type=["']submit["'])/i.test(bodyHtmlSnip) || ctaKeywordsRx.test(bodyHtmlSnip.substring(0, 1000));

  // All CTA button texts (deduplicated, for Claude)
  // Exclude known analytics/tag-manager UI strings injected into the DOM
  const ctaToolNoise = /^(track new element|add a tag|preview|submit|debug|tag assistant|fire|variable|trigger|pause|resume|recording|gtm|google tag|element visibility)$/i;
  const ctaTexts = [];
  $('button, input[type="submit"], .btn, .cta, [class*="button"], a[class*="btn"], a[class*="cta"]').each((_, el) => {
    const t = $(el).text().trim() || $(el).attr('value') || '';
    if (t && t.length < 80 && !ctaTexts.includes(t) && !ctaToolNoise.test(t)) ctaTexts.push(t);
  });
  const ctaText = ctaTexts[0] || '';

  // Pricing detection
  const pricingRx   = /£[\d,]+(?:\.\d{2})?|\$[\d,]+(?:\.\d{2})?|€[\d,]+(?:\.\d{2})?|\d+\s*(?:per month|\/month|\/mo|p\/m|per year|\/year)|from\s+£\d+/i;
  const hasPricing  = pricingRx.test(bodyText);
  const pricingText = hasPricing ? (bodyText.match(pricingRx)?.[0] || '') : '';

  // Above-fold phone
  const phoneRx             = /(?:\+44\s?|0)[0-9][\d\s\-\(\)]{8,}/;
  const aboveFoldPhonePresent = phoneRx.test(aboveFoldText);

  // Social media links in body HTML
  const hasSocialLinks = /facebook\.com|twitter\.com|(?:^|\/)x\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com/i.test($('body').html() || '');

  // Tracking detection (raw HTML scan)
  const hasGtm           = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(html);
  const hasGa4           = /gtag\.js|gtag\(['"]config['"],\s*['"]G-/i.test(html);
  const hasAdsConversion = /gtag\(['"]event['"],\s*['"]conversion['"]/i.test(html)
                        || /googleads\.g\.doubleclick\.net/i.test(html)
                        || /['"](AW-\d+)['"]/i.test(html);
  const hasRemarketingTag = /remarketing|allow_ad_personalization/i.test(html);
  const hasRemarketingOnly = !hasAdsConversion && hasRemarketingTag;

  const socialProofRx  = /testimonial|review|star rating|\d+\s*(reviews?|stars?)|said about|our clients|customers say|recommend/i;
  const socialProofText = socialProofRx.test(bodyText) ? bodyText.substring(0, 2000) : '';

  const authorityRx     = /award|certif|accredit|partner|member|press|featured|as seen|recognised|qualified|licensed/i;
  const authoritySignals = authorityRx.test(bodyText) ? 'present' : '';

  const contactRx      = /\+?[\d\s\-\(\)]{7,}|[\w.]+@[\w.]+\.\w+|call us|contact us|phone|email us/i;
  const contactSignals  = contactRx.test(bodyText) ? 'present' : '';

  // Detect page type (eCommerce vs lead gen) — used to suppress irrelevant findings
  const pageTypeInfo = detectPageType(html, url);

  // N-gram keyword analysis
  // Strip noise elements before computing phrase frequency — nav, footer, social links,
  // and (for eCommerce) product card grids all pollute counts with off-topic text.
  const urlSlug = extractUrlKeyword(url) || '';

  // Always strip: navigation, footer, social icons, cookie banners, script/style content
  $(
    'nav, header nav, footer, [role="navigation"], [role="contentinfo"],' +
    '[class*="footer"], [id*="footer"],' +
    '[class*="nav-"], [class*="-nav"], [id*="nav"],' +
    '[class*="cookie"], [class*="gdpr"], [class*="banner"],' +
    '[class*="social"], [class*="share-"], [class*="-share"],' +
    '[aria-label*="social" i], [aria-label*="navigation" i],' +
    'script, style, noscript'
  ).remove();

  // eCommerce: also strip product card grids (product titles / prices / swatches)
  if (pageTypeInfo.type === 'ecommerce') {
    $(
      '[class*="product-card"], [class*="card-wrapper"],' +
      '[class*="product-item"]:not(main):not(article):not(section),' +
      '[class*="product-tile"], [class*="product-loop"],' +
      '[class*="grid__item"], li.product,' +
      '[class*="productItem"], [class*="collection-item"]'
    ).remove();
  }

  let ngramBodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const topNgrams = computeTopNgrams(ngramBodyText, urlSlug, h1, title);

  return {
    fetchFailed: false, isHttps,
    title, metaDescription, h1, h2s, h3s,
    aboveFoldText, bodyText: bodyText.substring(0, 5000),
    linkCount, navLinkCount, formFieldCount, formFieldTypes, hasAboveFoldCta, ctaText, ctaTexts,
    hasGtm, hasGa4, hasAdsConversion, hasRemarketingOnly,
    hasViewport, hasPrivacyLink,
    socialProofText, authoritySignals, contactSignals,
    // Richer trust signals
    testimonialBlockCount, hasVideoContent, hasTrustBadges,
    starRatingPresent, namedTestimonialPresent,
    // New content signals
    hasPricing, pricingText, aboveFoldPhonePresent, imageCount, hasSocialLinks,
    // Page type
    pageTypeInfo,
    // Keyword analysis
    topNgrams
  };
}

// ─── PageSpeed Insights ───────────────────────────────────────────────────────

async function fetchPsi (url, strategy, key, attempt = 1) {
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${key}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s — mobile Lighthouse needs longer; two-phase rendering absorbs the wait
  try {
    const res  = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[psi] ${strategy} attempt ${attempt} failed — HTTP ${res.status}`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        return fetchPsi(url, strategy, key, attempt + 1);
      }
      return null;
    }
    const data    = await res.json();
    const audits  = data.lighthouseResult?.audits || {};
    const cats    = data.lighthouseResult?.categories || {};
    // Scan all network request URLs — same signals as HTML source scanning
    // but from Lighthouse's full Chrome render (bypasses bot protection)
    const networkUrls = (audits['network-requests']?.details?.items || [])
      .map(i => i.url || '').join('\n');

    // CrUX (real-user field data) is returned alongside Lighthouse lab data.
    // When Lighthouse fails to run on a page, use CrUX as fallback for core metrics.
    const crux = data.loadingExperience?.metrics || {};
    const lcpLab  = audits['largest-contentful-paint']?.numericValue ?? null;
    const clsLab  = audits['cumulative-layout-shift']?.numericValue  ?? null;
    const inpLab  = audits['interaction-to-next-paint']?.numericValue ?? null;
    const lcpCrux = crux.LARGEST_CONTENTFUL_PAINT_MS?.percentile     ?? null;
    const clsCrux = crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
                      ? crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null;
    const inpCrux = crux.INTERACTION_TO_NEXT_PAINT?.percentile        ?? null;
    const labScore = Math.round((cats.performance?.score || 0) * 100);
    console.log(`[psi] ${strategy} ok — lab score: ${labScore}, lcp: ${lcpLab ?? 'lab-null, crux: ' + lcpCrux}`);
    return {
      score:      labScore,
      lcp:        lcpLab  ?? lcpCrux,
      cls:        clsLab  ?? clsCrux,
      inp:        inpLab  ?? inpCrux,
      ttfb:       audits['server-response-time']?.numericValue      ?? null,
      tapTargets: audits['tap-targets']?.score                      ?? null,
      dataSource: lcpLab != null ? 'lighthouse' : lcpCrux != null ? 'crux' : 'none',
      // Content signals extracted from Google's rendering engine
      // Used as fallback when direct page fetch is blocked
      contentSignals: {
        title:            audits['document-title']?.displayValue   || null,
        metaDescription:  audits['meta-description']?.displayValue || null,
        hasGtm:           /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i.test(networkUrls),
        hasGa4:           /gtag\/js\?id=G-|google-analytics\.com\/g\/collect|analytics\.js/i.test(networkUrls),
        hasAdsConversion: /googleads\.g\.doubleclick|googleadservices\.com\/pagead\/conversion|AW-\d{7,}/i.test(networkUrls),
        hasRemarketingTag:/googlesyndication\.com|doubleclick\.net\/activity|allow_ad_personalization/i.test(networkUrls),
        hasHttps:         /^https:/i.test(url)
      }
    };
  } catch (e) {
    clearTimeout(timeout);
    console.error(`[psi] ${strategy} attempt ${attempt} exception:`, e.message);
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 2000));
      return fetchPsi(url, strategy, key, attempt + 1);
    }
    return null;
  }
}

// ─── Claude analysis ─────────────────────────────────────────────────────────

async function analyzeWithClaude (parsed) {
  const pageType = parsed.pageTypeInfo || {};
  const pageTypeLabel = pageType.type === 'ecommerce'
    ? `eCommerce${pageType.platform ? ' (' + pageType.platform + ')' : ''}${pageType.subtype ? ' — ' + pageType.subtype + ' page' : ''}`
    : 'Lead generation / service page';

  const isEcommercePrompt = pageType.type === 'ecommerce';
  const h2List   = (parsed.h2s  || []).join(' | ') || '(none)';
  const h3List   = (parsed.h3s  || []).join(' | ') || '(none)';
  const ctaList  = (parsed.ctaTexts || [parsed.ctaText]).filter(Boolean).join(' | ') || '(none)';
  const bodyLen  = (parsed.bodyText || '').length;

  const fetchWarning = parsed.contentFromPsi
    ? '\n⚠️ IMPORTANT: Direct page fetch was blocked (bot protection). Title and meta description came from Google\'s PageSpeed Insights engine. Body text, H1, trust signals, and CTA copy are unavailable. Limit findings to what you can infer from title, meta, and URL. Do NOT flag content-related issues you cannot verify.'
    : parsed.fetchFailed
      ? '\n⚠️ IMPORTANT: Page fetch failed entirely. Content analysis is unavailable. Return empty findings array and set all content fields to null.'
      : '';

  const ecommerceContext = isEcommercePrompt
    ? `\n\nECOMMERCE CONTEXT — frame everything for paid Shopping/Search/PMAX campaigns:
- Do NOT flag: missing contact forms, missing phone numbers, high link counts, or absence of lead-gen CTAs
- Do NOT flag: missing 'Add to Cart', 'Quick View', or 'Quick Shop' buttons on collection/category pages — clicking through to a product detail page is standard ecommerce behaviour, not a CTA problem
- DO assess: product/category keyword relevance, page-to-ad message match, product trust signals (reviews, ratings, returns policy), and whether the collection page clearly communicates the range and value of products
- Conversion friction = purchase friction, not lead capture friction`
    : `\n\nLEAD GEN / SERVICE PAGE CONTEXT:
- Do NOT flag multiple location-specific CTAs (e.g. "Book East Molesey", "Book Cobham") as decision paralysis or CTA fragmentation — for multi-location local service businesses, location selection IS the product choice and presenting locations side-by-side is standard, expected UX. Only flag CTA issues if the primary conversion action is genuinely unclear or absent.
- Form detection note: if formFieldTypes contains "js-rendered", a real form exists on the page but was loaded via JavaScript and is not parseable from static HTML. Do NOT flag a missing form in this case.`;

  const prompt = `You are a senior PPC conversion specialist auditing a landing page that receives paid Google Ads traffic. Your job is to identify specifically what is and is not working on THIS page — not to give generic CRO advice.

PAGE TYPE: ${pageTypeLabel}${ecommerceContext}${fetchWarning}

━━━ PAGE CONTENT ━━━
Title tag:         ${parsed.title || '(none)'}
H1:                ${parsed.h1 || '(none)'}
Meta description:  ${parsed.metaDescription || '(none)'}
URL keyword:       ${parsed.urlKeyword || '(none)'}

H2 headings:  ${h2List}
H3 headings:  ${h3List}

CTA / button text: ${ctaList}
⚠️ NOTE: CTA text is extracted as raw DOM text — dropdown options and lists appear concatenated without spaces (e.g. 'FeaturedBest sellingPrice low to high' is a correctly rendered sort dropdown, not broken UI). Do NOT flag spacing or formatting issues in sort/filter/dropdown text — the actual rendered UI has proper spacing. Only flag CTA issues you can verify are real problems, not extraction artifacts.

Above-fold copy (first 500 chars of main content area):
${parsed.aboveFoldText || '(none)'}
⚠️ NOTE: Above-fold text is extracted from the page's <main> content element, not the raw body — navigation menus, mobile drawers, and header elements are excluded before this slice is taken. If you still see navigation-style text (e.g. menu item lists, "Skip to content"), treat it as a DOM extraction edge-case and do NOT flag it as a critical or high finding about above-fold content.

Full page body (${bodyLen} chars):
${parsed.bodyText || '(none)'}

━━━ CONTENT SIGNALS ━━━
Pricing visible:          ${parsed.hasPricing ? 'YES — ' + (parsed.pricingText || '') : 'No'}
Phone above fold:         ${parsed.aboveFoldPhonePresent ? 'Yes' : 'No'}
Images on page:           ${parsed.imageCount != null ? parsed.imageCount : 'Unknown'}
Navigation links:         ${parsed.navLinkCount != null ? parsed.navLinkCount + (parsed.navLinkCount > 5 ? ' (full navigation present)' : ' (minimal)') : 'Unknown'}
Social media links:       ${parsed.hasSocialLinks ? 'Yes' : 'No'}
Testimonial blocks:       ${parsed.testimonialBlockCount}
Star ratings in copy:     ${parsed.starRatingPresent ? 'Yes' : 'No'}
Named testimonials:       ${parsed.namedTestimonialPresent ? 'Detected' : 'No'}
Video content:            ${parsed.hasVideoContent ? 'Yes' : 'No'}
Trust badges / accreditations: ${parsed.hasTrustBadges ? 'Detected' : 'No'}
Form fields (max in one form): ${parsed.formFieldCount} — input types across page: ${parsed.formFieldTypes || 'unknown'}
Total page links:         ${parsed.linkCount}

━━━ YOUR THREE-PART ANALYSIS ━━━

PART 1 — WHAT IS WORKING (severity: "pass")
What on this page works well for paid ad conversion? Look for: clear keyword alignment, good message match, strong social proof, specific CTA, risk reducers, pricing transparency, relevant trust signals. Only credit things you can actually see — do not give generic compliments.

PART 2 — WHAT IS HURTING (severity: critical/high/medium/low)
What is actively damaging conversion rate or Quality Score? Be specific — if a CTA button says "SEND", name it. If the headline is generic, quote it. If the form is above the value prop, say so. Reference actual content.

PART 3 — WHAT IS MISSING (severity: critical/high/medium/low)
What would you expect on a high-converting page of this type that is clearly absent here? Only flag genuine gaps that would materially affect paid traffic performance — not every element suits every page.

RULES:
- Maximum 12 findings total (pass + issues combined)
- Every finding must be specific to THIS page — no template advice
- If you see something specific (a CTA text, a headline, a section), quote or reference it
- Do NOT flag things you cannot verify from the content above
- Prioritise findings by impact on Google Ads Quality Score and conversion rate
- Do NOT generate findings about: H1 presence or absence (covered by structural checks), total link count or navigation menu presence (covered separately), or form field count (covered separately)
- If is_js_rendered_likely is true: for any finding that relies on content signals (copy, CTAs, trust signals, phone numbers, forms), end the detail sentence with " — note: this page renders via JavaScript, so manual visual confirmation is recommended before acting on this finding." Do not add this note to performance or tracking findings.
- Do NOT flag a standard website header or navigation menu as critical or high severity — navigation is expected on full website pages. If above-fold content is predominantly navigation with little else, flag at medium severity maximum
- Be honest and calibrated — do not overstate. LOW findings must use measured language: "may reduce", "can affect", "tends to lower". Reserve "directly harms" and "significantly damages" for critical/high findings only
- Use severity "suggest" (not "low") for best-practice recommendations — improvements that would help but are not genuine problems. Use "low" only for minor but real issues that actually hurt performance. "suggest" findings do not affect the score.
- In 'detail': lead with what you actually observed on THIS page (quote specific text, name specific elements, cite specific counts). Then explain the impact. Do not open with a generic claim.
- In 'impact': be realistic. Say "typically improves", "can reduce", "tends to lift". Avoid absolute guarantees. Name the specific metric (conversion rate, CPA, Quality Score, bounce rate) but keep the claim proportionate to the severity level
- If citing conversion uplift percentages, frame them as benchmark estimates, not guarantees — e.g. "benchmark data suggests X" or "research indicates X range", not "X% improvement". Do not present ranges as precise outcomes.
- Do NOT state that a specific page element "directly reduces CPCs" or "improves Quality Score" in isolation. Separate primary impact (conversion rate, CPA, lead capture) from secondary signal effects. Quality Score is a diagnostic with three components (Expected CTR, Ad Relevance, Landing Page Experience) — individual page elements contribute to the overall picture, not directly to CPCs. You may say "can contribute to a stronger Landing Page Experience signal" but avoid claiming a specific element will mechanically change CPCs or Quality Score.

Return ONLY valid JSON (no markdown, no fences):
{
  "inferred_keyword": "string or null",
  "keyword_confidence": "high|medium|low|none",
  "keyword_confidence_reason": "one sentence",
  "intent_type": "transactional|commercial|informational|navigational",
  "keyword_specificity": "specific|generic|unknown",
  "h1_quality": "clear|weak|missing",
  "h1_contains_keyword": true|false|null,
  "title_h1_aligned": true|false|null,
  "above_fold_keyword_signal": "strong|moderate|weak|none",
  "page_relevance_to_query": "strong|moderate|weak",
  "relevance_reason": "one sentence — reference actual page content",
  "value_proposition_clarity": "clear|weak|missing",
  "value_proposition_reason": "one sentence — reference actual copy or its absence",
  "cta_quality": "specific|generic|missing",
  "cta_reason": "one sentence — reference actual CTA text if visible",
  "cta_specificity": "specific|generic|missing",
  "conversion_goal_clarity": "single|multiple|unclear",
  "message_match_strength": "strong|moderate|weak",
  "message_match_reason": "one sentence",
  "risk_reducer_present": true|false,
  "risk_reducer_type": "guarantee|free trial|no commitment|social proof|certification|null",
  "urgency_present": true|false,
  "social_proof_type": "star_ratings|testimonials|case_studies|logos|stats|none",
  "social_proof_count": 0,
  "social_proof_quality": "strong|weak|none",
  "named_testimonials": true|false,
  "authority_signals_present": false,
  "contact_signals_present": false,
  "is_js_rendered_likely": false,
  "findings": [
    {
      "category": "keyword_clarity|landing_page_experience|conversion_architecture|trust_signals",
      "severity": "pass|critical|high|medium|low|suggest",
      "title": "short, specific title — reference page content where possible",
      "detail": "2-3 sentences. Lead with what you actually observed on this page (quote the specific text, name the specific element, cite the specific count). Then explain why it matters for conversion or Quality Score. Keep language proportionate to severity.",
      "fix": "one sentence — specific action referencing the actual element, not a generic recommendation",
      "impact": "one sentence — name the specific metric (conversion rate, CPA, Quality Score, bounce rate) and use proportionate language: 'can improve', 'tends to reduce', 'may lift'. For pass findings: what this element contributes. Reserve 'directly harms' for critical findings only.",
      "effort": "low|medium|high — estimated implementation effort: 'low' = copy/content change, no developer needed (rewrite a headline, add a testimonial, change button text); 'medium' = design or simple dev work (add a form, create a new page section, optimise images); 'high' = significant technical work (Core Web Vitals, tracking implementation, server changes, major restructure)"
    }
  ]
}`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping content analysis');
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: 'Content analysis unavailable.', findings: [] };
  }

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 90000 }); // 90s — sonnet depth worth the wait; two-phase rendering means user sees results before PSI anyway
    const msg  = await anthropic.messages.create({
      model:      'claude-sonnet-4-5-20250929',
      max_tokens: 5000,
      system:     'You are a PPC conversion specialist. You audit landing pages used as Google Ads destinations. Every finding must be grounded in the actual page content provided — specific, not generic. Frame all analysis in paid search terms: Quality Score, Landing Page Experience, conversion rate, CPA. Return only valid JSON with no markdown fences.',
      messages:   [{ role: 'user', content: prompt }]
    });
    const raw = msg.content[0]?.text || '{}';
    console.log('[claude] raw response first 300 chars:', raw.substring(0, 300));
    // Strip markdown fences Claude sometimes adds despite instructions
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    try {
      const parsed = JSON.parse(text);
      console.log('[claude] parsed ok, findings:', (parsed.findings || []).length, 'value_prop:', parsed.value_proposition_clarity, 'message_match:', parsed.message_match_strength);
      return parsed;
    } catch (parseErr) {
      console.error('[claude] JSON.parse failed:', parseErr.message, '— attempting fallback extraction');
      // Second attempt: extract first {...} block in case of extra prose
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const result = JSON.parse(match[0]);
        console.log('[claude] fallback extraction succeeded');
        return result;
      }
      throw parseErr;
    }
  } catch (e) {
    console.error('[claude] error:', e.message);
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: 'Content analysis failed.', findings: [], _debug_error: e.message };
  }
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport (url, parsed, psiMobile, psiDesktop, claude, isHttps, fetchError, psiStatus) {
  const findings = [];
  const fetchErr  = parsed.fetchError || null;
  const isBlocked = parsed.fetchFailed && (fetchErr === 'blocked');
  const isTimeout = parsed.fetchFailed && (fetchErr === 'timeout');
  const isUnreachable = parsed.fetchFailed && (fetchErr === 'network_error' || fetchErr === 'http_server_error' || fetchErr === 'http_client_error');
  const pageTypeInfo  = parsed.pageTypeInfo || { type: 'lead_gen', platform: null, subtype: null };
  const isEcommerce   = pageTypeInfo.type === 'ecommerce';
  const knownPlatform = pageTypeInfo.platform; // null for generic eCommerce

  // ── Fetch-failure notices (shown first so they anchor the rest of the report) ─
  if (isBlocked) {
    findings.push({
      category: 'landing_page_experience',
      severity: 'high',
      title: 'Page blocked our content scanner (bot protection detected)',
      detail: 'This page uses Cloudflare, a WAF, or another bot-protection system that blocked the server-side fetch used for content analysis. Performance data is still real — it comes from Google\'s PageSpeed Insights API, which uses Googlebot and bypasses these protections. Keyword inference, trust signals, CTA detection, and tracking checks are unavailable for this audit.',
      fix: 'Performance findings below are accurate. For content analysis, open the page in a browser and check keyword clarity, trust signals, and CTA manually against the checklist at phillips-uk.com/landing-page-audit.'
    });
  } else if (isTimeout) {
    findings.push({
      category: 'landing_page_experience',
      severity: 'high',
      title: 'Page did not respond in time — content checks unavailable',
      detail: 'The page took longer than 10 seconds to respond to our content fetch, so keyword inference, trust signals, and CTA analysis could not run. This slow response affects paid traffic directly — if the page is this slow to a server, it will be this slow to visitors on mobile networks too. Performance data from PageSpeed Insights is still shown below.',
      fix: 'Check the page loads in under 3 seconds on a simulated 4G connection. Review server response time (TTFB) and eliminate any blocking resources in the page head.'
    });
  } else if (isUnreachable) {
    findings.push({
      category: 'landing_page_experience',
      severity: 'high',
      title: 'Page could not be reached — content checks unavailable',
      detail: `The page returned an error (${fetchErr === 'http_client_error' ? 'HTTP 4xx' : fetchErr === 'http_server_error' ? 'HTTP 5xx' : 'network error'}) when our scanner tried to fetch it. Content-based checks are unavailable. If this URL is live and accessible in a browser, it may be returning different responses to server-side requests. PageSpeed Insights performance data may still be available below.`,
      fix: 'Verify the URL is correct and publicly accessible without login. If the page is live in a browser, the server may be rejecting non-browser requests — check your server logs or CDN rules.'
    });
  }

  // ── Technical Performance ──────────────────────────────────────────────────
  if (psiMobile) {
    const lcpS = psiMobile.lcp != null ? psiMobile.lcp / 1000 : null;
    if (lcpS !== null) {
      if (lcpS > 4)
        findings.push({ category: 'performance', severity: 'high', title: `Slow mobile load — LCP ${lcpS.toFixed(1)}s`, detail: `Google's own research shows that as load time increases from 1s to 5s, the probability of bounce rises by 90%. At ${lcpS.toFixed(1)}s LCP on mobile, a significant share of your paid traffic is leaving before your offer loads — and you're paying for every one of those clicks. Fixing this could materially reduce wasted ad spend.`, fix: 'Optimise images to WebP, reduce server response time, and eliminate render-blocking JavaScript and CSS.', impact: "Every second over 2.5s LCP costs paid clicks — Google's data shows bounce probability rises 90% between 1s and 5s, directly inflating your effective CPA." });
      else if (lcpS > 2.5)
        findings.push({ category: 'performance', severity: 'medium', title: `LCP ${lcpS.toFixed(1)}s — approaching the warning threshold`, detail: `LCP of ${lcpS.toFixed(1)}s is in Google's "Needs improvement" range. It isn't a critical problem yet, but improving it to under 2.5s would strengthen your Landing Page Experience signal and reduce mobile bounce.`, fix: 'Optimise your largest above-fold element — typically the hero image or heading font.', impact: "Improving LCP to under 2.5s moves it into Google's 'Good' range, strengthening Landing Page Experience and reducing CPCs through Quality Score improvement." });
    }

    const cls = psiMobile.cls;
    if (cls != null) {
      if (cls > 0.25)
        findings.push({ category: 'performance', severity: 'high', title: `High layout shift (CLS ${cls.toFixed(3)})`, detail: `A CLS of ${cls.toFixed(3)} means the page moves after it loads. On mobile, this causes accidental taps on the wrong elements. Google links high CLS to lower engagement and worse Landing Page Experience scores — fixing it is a direct Quality Score improvement lever.`, fix: 'Add explicit width and height to images and reserve space for dynamic elements (banners, embeds, fonts).', impact: "High layout shift causes accidental misclicks on mobile paid traffic and directly degrades Landing Page Experience — fixing it improves Quality Score and reduces bounce." });
      else if (cls > 0.1)
        findings.push({ category: 'performance', severity: 'medium', title: `Layout shift in warning zone (CLS ${cls.toFixed(3)})`, detail: `CLS of ${cls.toFixed(3)} is above the 0.1 threshold Google considers good. Getting below 0.1 would move this into a passing Landing Page Experience signal.`, fix: 'Identify shifting elements using Chrome DevTools Layout Shift Regions, then add fixed dimensions.', impact: "Getting CLS below 0.1 moves this into Google's 'Good' range and removes it as a Landing Page Experience drag on Quality Score." });
    }

    const inp = psiMobile.inp;
    if (inp != null) {
      if (inp > 500)
        findings.push({ category: 'performance', severity: 'high', title: `Page feels unresponsive on mobile (INP ${Math.round(inp)}ms)`, detail: `INP measures how quickly the page responds to a tap or click. At ${Math.round(inp)}ms, users experience a noticeable delay before anything happens. Google includes this in Landing Page Experience assessment — improving responsiveness can reduce frustration-driven exits from paid traffic.`, fix: 'Reduce JavaScript execution on page load. Defer or async non-essential scripts.', impact: "Sluggish page response frustrates paid visitors and weakens Landing Page Experience — improving INP directly reduces friction for mobile ad traffic." });
      else if (inp > 200)
        findings.push({ category: 'performance', severity: 'medium', title: `Interaction responsiveness needs improvement (INP ${Math.round(inp)}ms)`, detail: `INP of ${Math.round(inp)}ms is above Google's 200ms threshold. Bringing this into the "Good" range would improve the mobile experience for paid traffic and strengthen the Landing Page Experience signal.`, fix: 'Profile JavaScript performance in Chrome DevTools and defer non-essential interaction handlers.', impact: "Bringing INP under 200ms strengthens Landing Page Experience and keeps paid visitors engaged after they click your ad." });
    }

    const ttfb = psiMobile.ttfb;
    if (ttfb != null) {
      if (ttfb > 1800)
        findings.push({ category: 'performance', severity: 'high', title: `Slow server response (TTFB ${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms is the time before the browser receives its first byte from your server. Google's crawler experiences this delay too — and it feeds into Landing Page Experience scoring. A faster server means faster everything else on the page.`, fix: 'Upgrade hosting, enable server-side caching, or move to a CDN-backed infrastructure.', impact: "Server response time affects every page element — improving TTFB is the single change that speeds up everything else and strengthens Landing Page Experience." });
      else if (ttfb > 800)
        findings.push({ category: 'performance', severity: 'medium', title: `Server response time above target (${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms is above Google's 800ms good threshold. Getting below 800ms would remove this as a drag on your overall performance score.`, fix: 'Enable server-side caching and check for slow database queries or unoptimised hosting.', impact: "Getting TTFB under 800ms moves server response into Google's 'Good' range and removes it as a drag on the overall performance score." });
    }

    const ms = psiMobile.score;
    if (ms < 30)
      findings.push({ category: 'mobile', severity: 'critical', title: `Critical mobile score — ${ms}/100`, detail: `A mobile score of ${ms} places this page in Google's lowest performance band. Over 60% of paid search clicks come from mobile — this score is actively degrading your Landing Page Experience, which feeds directly into Quality Score and CPCs. Improving it to 50+ could reduce CPCs and increase the volume of clicks you receive at the same budget.`, fix: 'Address LCP and CLS first — they carry the most weight in the performance score. Use PageSpeed Insights for the full optimisation list.', impact: "Over 60% of paid search clicks are on mobile — a critical score here is the primary driver of wasted ad spend and high CPAs." });
    else if (ms < 50)
      findings.push({ category: 'mobile', severity: 'high', title: `Poor mobile score — ${ms}/100`, detail: `Mobile score of ${ms} is in the "Poor" band. With over 60% of paid search clicks on mobile, this is hurting the majority of your ad traffic. Moving from "Poor" to "Needs improvement" (50+) will reduce bounce from mobile clicks and strengthen your Landing Page Experience signal.`, fix: 'Work through the LCP and CLS findings in this report first. Then run PageSpeed Insights for additional quick wins.', impact: "Improving mobile performance directly reduces bounce on the majority of your paid clicks — mobile score is a direct input to Landing Page Experience." });
    else if (ms < 90)
      findings.push({ category: 'mobile', severity: 'medium', title: `Mobile score ${ms}/100 — room to improve`, detail: `Mobile score of ${ms} is in the "Needs improvement" band. Over 60% of paid search clicks are on mobile — getting above 90 would move this into Google's "Good" range and remove it as a drag on Landing Page Experience.`, fix: 'Run PageSpeed Insights for this page and action the highest-opportunity items in the Diagnostics section.', impact: "Getting above 90 moves mobile performance into Google's 'Good' range, strengthening Landing Page Experience and contributing to Quality Score." });

    if (psiMobile.tapTargets != null && psiMobile.tapTargets < 0.9)
      findings.push({ category: 'mobile', severity: 'low', title: 'Some tap targets may be too small for mobile', detail: 'PageSpeed data shows some interactive elements may be below the recommended 48x48px touch target size. Small tap targets cause misclicks on mobile, which can redirect users away from your CTA.', fix: 'Ensure all buttons and links are at least 48x48 CSS pixels with 8px of space between them.', impact: "Misclicks on small tap targets send mobile paid visitors away from your CTA — fixing this reduces wasted ad spend on mobile." });
  }

  // ── HTTPS — always check, regardless of page type ─────────────────────────
  if (!parsed.fetchFailed || parsed.contentFromPsi) {
    if (!isHttps)
      findings.push({ category: 'landing_page_experience', severity: 'critical', title: 'Page served over HTTP — ads may be disapproved', detail: "Chrome shows this page as insecure. Google's advertising policy requires HTTPS landing pages — ads pointing to HTTP destinations are at risk of disapproval or limited delivery. Switching to HTTPS also improves trust signals for paid traffic visitors.", fix: 'Install an SSL certificate and redirect all HTTP traffic to HTTPS. Most hosting platforms include this free.', impact: "Google's ad policy can disapprove or limit delivery for ads pointing to HTTP pages — fixing this unblocks ad delivery and removes a trust barrier simultaneously." });
  }

  // ── HTML-only findings — require direct page content (skip for blocked pages) ─
  if (!parsed.fetchFailed) {

  // ── Landing page experience ────────────────────────────────────────────────
  if (!parsed.h1) {
    const isShopify = knownPlatform === 'shopify';
    findings.push({
      category: 'landing_page_experience',
      severity: 'critical',
      title: 'No H1 tag found' + (isShopify ? ' — common Shopify theme issue' : ''),
      detail: isShopify
        ? "The main heading on this page is likely coded as an H2, not an H1 — a pattern common across Shopify themes where the site logo/brand name is treated as the implicit H1, demoting all content headings by one level. Google uses the H1 as a primary relevance signal for Landing Page Experience and Quality Score. This is straightforward to fix in the Shopify theme editor without changing how the heading looks visually."
        : "The H1 is one of the primary on-page signals Google uses to assess page relevance. Without it, the page has no explicit keyword anchor for Google's quality assessment — this directly affects Landing Page Experience, which is one of the three inputs to Quality Score. Adding a keyword-rich H1 is one of the fastest ways to improve relevance signals for this URL.",
      fix: isShopify
        ? 'In your Shopify theme editor, find the page template (pages/default or similar) and change the main heading tag from <h2> to <h1>. This is a template-level change — it applies to all pages using that template.'
        : 'Add a clear H1 that includes your primary target keyword. It should be the first prominent heading a visitor sees on the page.',
      impact: isShopify
        ? "The H1 is a primary relevance signal for Landing Page Experience — this single template change improves keyword clarity for every page using that template."
        : "Adding a keyword-rich H1 is one of the fastest Quality Score improvements available — it directly strengthens the relevance assessment Google applies to this URL."
    });
  }

  if (!parsed.hasPrivacyLink)
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No privacy policy link detected', detail: 'No privacy policy link was found in the accessible content of this page. If it exists in a JavaScript-rendered footer our tool may have missed it — verify in your browser. If it is genuinely missing: beyond GDPR compliance, users arriving from paid ads are actively evaluating your credibility. A visible privacy policy reduces friction for first-time visitors making a booking enquiry.', fix: 'Add a link to your privacy policy in the page footer. If one already exists via dynamic loading, no action needed — verify it renders in your browser.', impact: "First-time paid visitors scan for trust signals — a visible privacy policy reduces hesitation at the conversion point without requiring any copy changes." });

  // ── Conversion architecture ────────────────────────────────────────────────
  // Link count — eCommerce pages (collection/product grids) have many links by design
  if (!isEcommerce) {
    if (parsed.linkCount > 20) {
      findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.linkCount} links suggest a full website page — consider a dedicated landing page`, detail: `This page has ${parsed.linkCount} links, which is typical of a full website page rather than a purpose-built landing page. Dedicated landing pages — with navigation stripped and a single conversion goal — typically outperform full website pages for paid traffic, because they reduce distraction and align tightly to a single intent. The opportunity here is not that something is broken, but that a purpose-built page for this campaign could improve your cost per lead.`, fix: 'Consider building a dedicated landing page for this ad campaign — same offer, same copy, but with navigation stripped and a single CTA. Your main website page remains untouched.', impact: "Dedicated landing pages typically outperform full website pages for paid traffic by reducing exit routes and keeping focus on a single conversion goal — building a stripped campaign page is the highest-leverage structural change available." });
    } else if (parsed.linkCount > 10) {
      findings.push({ category: 'conversion_architecture', severity: 'suggest', title: `Consider reducing navigation for paid traffic`, detail: `With ${parsed.linkCount} links on the page, there are multiple exits competing with your CTA for attention. Hiding the top navigation for paid traffic is a common A/B test that can produce measurable conversion rate improvements.`, fix: 'Test a version of this page with navigation hidden — same content, just fewer exit routes. It does not need to be permanent.', impact: "Reducing navigation for paid traffic is worth testing — even a modest improvement in conversion rate compounds across ad spend." });
    }
  }

  // Form length — not applicable to eCommerce pages (no lead capture form expected)
  if (!isEcommerce) {
    if (parsed.formFieldCount >= 7)
      findings.push({ category: 'conversion_architecture', severity: 'high', title: `${parsed.formFieldCount}-field form — high abandonment risk`, detail: `A ${parsed.formFieldCount}-field form is a significant barrier for users who clicked an ad in a moment of intent. EConsultancy research found that reducing form fields from 11 to 4 increased conversions by 160%. For paid traffic especially, every field is a reason to leave.`, fix: 'Reduce to 3 fields maximum for the initial enquiry. You can collect additional details in the follow-up process after the first conversion event.', impact: "Reducing to 3 fields is the single highest-leverage friction reduction on a form-based landing page — field reduction consistently outperforms copy and design changes for CPA reduction." });
    else if (parsed.formFieldCount >= 4)
      findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.formFieldCount}-field form — adds friction for paid traffic`, detail: `Paid search visitors are less patient than organic ones — they clicked an ad in a moment of intent and expect a fast path to what they want. A ${parsed.formFieldCount}-field form introduces friction at exactly that moment. Each extra field reduces your conversion rate and raises your effective CPA, weakening the case for increasing bids. Every field that can be deferred should be.`, fix: 'Reduce to the minimum fields needed for first contact. Collect any additional information after the initial enquiry, not before.', impact: "Each field removed from a paid traffic form measurably reduces CPA — even removing one optional field moves conversion rate at scale." });
  }

  // ── Merge Claude content findings ──────────────────────────────────────────
  // Topics already covered by hardcoded structural rules — filter Claude duplicates
  const hardcodedTopicsCovered = new Set();
  if (!parsed.h1) hardcodedTopicsCovered.add('h1');
  if (!isEcommerce && parsed.linkCount > 10) hardcodedTopicsCovered.add('link_count');
  if (!isEcommerce && parsed.formFieldCount >= 4) hardcodedTopicsCovered.add('form_fields');

  const claudeFindings = (claude.findings || []).filter(f => {
    if (!f.severity || !f.title || !f.detail || !f.fix) return false;
    const text = (f.title + ' ' + (f.detail || '') + ' ' + (f.fix || '')).toLowerCase();
    if (hardcodedTopicsCovered.has('h1') && /\bh[- ]?1\b/.test(text)) return false;
    if (hardcodedTopicsCovered.has('link_count') && /(\d+\s+links?|navigation.*links?|links?.*navigation|above.fold.*nav|nav.*above.fold|too many links?|link.*competing|competing.*link)/.test(text)) return false;
    if (hardcodedTopicsCovered.has('form_fields') && /(\d+[\s-]field|\bform\s+fields?\b|\bform\s+length\b|\btoo many fields?\b)/.test(text)) return false;
    // Navigation/header findings must not be critical or high — cap at medium
    const isNavFinding = /(navigation|header|nav menu|nav bar|above.fold.*nav|nav.*above.fold)/.test(text);
    if (isNavFinding && (f.severity === 'critical' || f.severity === 'high')) {
      f.severity = 'medium';
    }
    return true;
  });
  findings.push(...claudeFindings);

  // Helper — true if Claude already generated a finding about this topic
  // (prevents hardcoded fallbacks from duplicating Claude's specific findings)
  const claudeCovers = (category, keywords) =>
    claudeFindings.some(f => f.category === category &&
      keywords.some(k => (f.title + ' ' + (f.detail || '')).toLowerCase().includes(k.toLowerCase())));

  // ── Value proposition ──────────────────────────────────────────────────────
  if (claude.value_proposition_clarity === 'weak' && !claudeCovers('landing_page_experience', ['value prop', 'proposition', 'above the fold', 'above fold']))
    findings.push({ category: 'landing_page_experience', severity: 'medium', title: 'Value proposition is unclear above the fold', detail: `The first thing a paid traffic visitor should be able to answer is "why here, why now?" If that answer is not obvious within 5 seconds, conversion research (Nielsen Norman Group) shows most users leave. A clear above-fold statement of what you offer, who it is for, and why you are the right choice is one of the highest-leverage copy changes on any landing page.`, fix: 'Rewrite your hero headline and subtitle to answer three questions: what you offer, who it is for, and what makes you the right choice. Make it scannable in under 5 seconds.', impact: "Pages with a clear above-fold value proposition convert up to 4x better than generic ones — rewriting the hero copy is the highest-leverage content change available." });
  else if (claude.value_proposition_clarity === 'missing' && !claudeCovers('landing_page_experience', ['value prop', 'proposition', 'above the fold', 'above fold']))
    findings.push({ category: 'landing_page_experience', severity: 'high', title: 'No clear value proposition detected', detail: `Paid traffic arrives with specific intent — if the page does not immediately confirm "you are in the right place," the click is wasted. Research shows pages with a clear, differentiated value proposition above the fold convert up to 4x better than generic introductions. This is especially important for Quality Score, which assesses expected relevance from the user's perspective.`, fix: 'Add a headline that states specifically what you offer and the primary benefit. Follow it with a 1-2 sentence supporting statement that addresses the visitor\'s main concern.', impact: "Paid traffic that can't immediately understand your offer bounces — adding a clear above-fold statement directly reduces wasted spend and improves conversion rate." });

  // ── Message match ──────────────────────────────────────────────────────────
  if (claude.message_match_strength === 'weak' && !claudeCovers('landing_page_experience', ['message match', 'ad copy', 'headline']))
    findings.push({ category: 'landing_page_experience', severity: 'high', title: 'Weak message match between page and likely ad copy', detail: `Message match is one of the most predictable conversion levers in paid search. When the language on the landing page echoes the ad that drove the click, Google research shows post-click engagement and conversion rate both improve significantly. Weak alignment between the page headline and the ad intent also reduces Quality Score.`, fix: 'Mirror your primary ad headline in the page H1, and use the same language (keyword, offer framing, call to action) in your above-fold copy. Visitors should feel they landed exactly where they expected.', impact: "Strong message match between ad and page improves conversion rate by 20-30% and strengthens Quality Score — it's the most reliable lever for CPC reduction." });

  // ── CTA specificity ────────────────────────────────────────────────────────
  if (claude.cta_specificity === 'generic' && parsed.hasAboveFoldCta && !claudeCovers('conversion_architecture', ['cta', 'call to action', 'button']))
    findings.push({ category: 'conversion_architecture', severity: 'suggest', title: 'CTA could be more specific', detail: `Generic CTAs like "Submit" or "Click here" underperform specific action-oriented language. WordStream research found that personalised or outcome-focused CTAs outperform generic button text by up to 202%. A CTA that tells the visitor exactly what happens next reduces hesitation.`, fix: `Replace generic CTA text with a specific outcome: "Book Your Free Trial", "Get Your Quote in 2 Minutes", or similar language tied to your conversion goal.`, impact: "Specific CTAs outperform generic ones by up to 202% — this is a one-line copy change with measurable conversion rate impact." });

  // ── Risk reducer ───────────────────────────────────────────────────────────
  if (claude.risk_reducer_present === false && !parsed.hasRemarketingOnly && !claudeCovers('trust_signals', ['risk', 'guarantee', 'no commitment', 'no obligation']))
    findings.push({ category: 'trust_signals', severity: 'suggest', title: 'Consider adding a risk reducer near the CTA', detail: `First-time visitors from paid ads are evaluating risk alongside opportunity. A risk reducer (satisfaction guarantee, no-commitment trial, clear cancellation policy, or money-back promise) directly addresses the hesitation that prevents conversion.`, fix: 'Add a brief risk statement near your CTA: a guarantee, a free first session, a "no obligation" commitment, or similar. Even a single sentence reduces the friction of saying yes.', impact: "Risk reducers typically increase enquiry conversion by 10-15% for service pages — a one-sentence addition near the CTA requires no design work." });

  // ── Social proof quality ───────────────────────────────────────────────────
  if (claude.social_proof_quality === 'none' && parsed.testimonialBlockCount === 0 && !parsed.starRatingPresent && !claudeCovers('trust_signals', ['social proof', 'testimonial', 'review', 'rating']))
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No social proof detected', detail: `Visitors from paid ads have not heard of you before. Social proof (reviews, star ratings, testimonials with names) is the fastest way to reduce scepticism. BrightLocal research shows 91% of consumers read online reviews before contacting a local service business. Pages with visible social proof convert significantly better than pages relying on copy alone.`, fix: 'Add at least 3 testimonials with names (and photos if possible) above or near your CTA. If you have Google reviews, embed the rating and review count on the page.', impact: "Social proof is consistently the highest-ROI trust addition for paid landing pages — testimonials directly reduce scepticism from visitors who have never heard of you." });
  else if ((claude.social_proof_quality === 'weak' || (parsed.testimonialBlockCount > 0 && !parsed.namedTestimonialPresent)) && !claudeCovers('trust_signals', ['social proof', 'testimonial', 'review', 'rating']))
    findings.push({ category: 'trust_signals', severity: 'suggest', title: 'Social proof could be stronger', detail: `Anonymous testimonials or generic review statements carry less weight than named, specific social proof. Research shows testimonials with a name, role, and specific outcome are 3x more credible than generic quotes.`, fix: 'Upgrade anonymous testimonials to include the reviewer\'s name and specific outcome ("My son went from nervous to confident in 4 weeks — Jane P., parent"). Photos increase trust further.', impact: "Named, specific testimonials are 3x more credible than anonymous ones — worth upgrading without needing to change page structure." });

  } // end !parsed.fetchFailed content block

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 100;
  let criticalCount = 0;
  for (const f of findings) {
    if      (f.severity === 'critical') { score -= 20; criticalCount++; }
    else if (f.severity === 'high')     score -= 10;
    else if (f.severity === 'medium')   score -= 5;
    else if (f.severity === 'low')      score -= 2;
    // 'suggest' = best-practice recommendation, no score deduction
    // 'pass'    = positive finding, green display, no score change
    // 'info'    = contextual note, blue display, no score change
  }

  if      (criticalCount >= 2) score = Math.min(score, 45);
  else if (criticalCount >= 1) score = Math.min(score, 65);
  score = Math.max(5, score);

  const scoreBand = score >= 80 ? 'Strong' : score >= 60 ? 'Average' : score >= 40 ? 'Needs work' : 'Critical';

  // ── Priority actions — exclude pass/info contextual findings ──────────────
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const priorityActions = [...findings]
    .filter(f => f.severity !== 'pass' && f.severity !== 'info' && f.severity !== 'suggest')
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
    .slice(0, 3)
    .map(f => ({ severity: f.severity, category: f.category, title: f.title, fix: f.fix }));

  return {
    url,
    audited_at: new Date().toISOString(),
    health_score: score,
    score_band: scoreBand,
    _debug_claude_error: claude._debug_error || null,
    inferred_keyword:         claude.inferred_keyword || null,
    keyword_confidence:       claude.keyword_confidence || 'none',
    keyword_confidence_reason: claude.keyword_confidence_reason || '',
    intent_type:              claude.intent_type || 'unknown',
    priority_actions: priorityActions,
    categories: {
      performance: {
        mobile_score:  psiMobile?.score  ?? null,
        desktop_score: psiDesktop?.score ?? null,
        lcp:  psiMobile?.lcp  != null ? (psiMobile.lcp / 1000).toFixed(2) + 's' : null,
        cls:  psiMobile?.cls  != null ? psiMobile.cls.toFixed(3)               : null,
        inp:  psiMobile?.inp  != null ? Math.round(psiMobile.inp) + 'ms'       : null,
        ttfb: psiMobile?.ttfb != null ? Math.round(psiMobile.ttfb) + 'ms'      : null
      },
      keyword_clarity: {
        inferred_keyword:  claude.inferred_keyword,
        confidence:        claude.keyword_confidence,
        confidence_reason: claude.keyword_confidence_reason,
        intent_type:       claude.intent_type,
        specificity:       claude.keyword_specificity,
        top_ngrams:        parsed.topNgrams || []
      },
      landing_page_experience: {
        h1:                        parsed.h1 || null,
        title:                     parsed.title || null,
        meta_description:          parsed.metaDescription || null,
        h1_contains_keyword:       claude.h1_contains_keyword ?? null,
        title_h1_aligned:          claude.title_h1_aligned ?? null,
        above_fold_signal:         claude.above_fold_keyword_signal || null,
        page_relevance:            claude.page_relevance_to_query || null,
        relevance_reason:          claude.relevance_reason || null,
        value_proposition_clarity: claude.value_proposition_clarity || null,
        value_proposition_reason:  claude.value_proposition_reason || null,
        message_match_strength:    claude.message_match_strength || null,
        message_match_reason:      claude.message_match_reason || null
      },
      conversion_architecture: {
        has_cta:                 parsed.hasAboveFoldCta,
        cta_text:                parsed.ctaText || null,
        cta_quality:             claude.cta_quality || null,
        cta_specificity:         claude.cta_specificity || null,
        cta_reason:              claude.cta_reason || null,
        link_count:              parsed.linkCount,
        form_fields:             parsed.formFieldCount,
        conversion_goal_clarity: claude.conversion_goal_clarity || null,
        urgency_present:         claude.urgency_present ?? false
      },
      trust_signals: {
        social_proof_quality:    claude.social_proof_quality || 'none',
        social_proof_type:       claude.social_proof_type || 'none',
        named_testimonials:      claude.named_testimonials ?? parsed.namedTestimonialPresent,
        testimonial_blocks:      parsed.testimonialBlockCount,
        star_rating_present:     parsed.starRatingPresent,
        has_video_content:       parsed.hasVideoContent,
        has_trust_badges:        parsed.hasTrustBadges,
        risk_reducer_present:    claude.risk_reducer_present ?? false,
        risk_reducer_type:       claude.risk_reducer_type || null,
        authority_signals:       claude.authority_signals_present ?? false,
        has_privacy_link:        parsed.hasPrivacyLink,
        contact_signals:         claude.contact_signals_present ?? false,
        https:                   isHttps
      },
      tracking: {
        gtm:              parsed.hasGtm,
        ga4:              parsed.hasGa4,
        ads_conversion:   parsed.hasAdsConversion,
        remarketing_only: parsed.hasRemarketingOnly
      },
      mobile: {
        score:         psiMobile?.score ?? null,
        has_viewport:  parsed.hasViewport,
        tap_targets_ok: psiMobile?.tapTargets != null ? psiMobile.tapTargets >= 0.9 : null
      }
    },
    findings,
    page_meta: {
      title:          parsed.title,
      h1:             parsed.h1,
      meta_description: parsed.metaDescription,
      fetch_failed:     parsed.fetchFailed    || false,
      fetch_error:      parsed.fetchError     || null,
      content_from_psi: parsed.contentFromPsi || false,
      is_blocked:       isBlocked,
      is_timeout:       isTimeout,
      is_unreachable:   isUnreachable,
      is_js_rendered:   claude.is_js_rendered_likely || false,
      page_type:          pageTypeInfo.type    || 'lead_gen',
      ecommerce_platform: pageTypeInfo.platform || null,
      page_subtype:       pageTypeInfo.subtype  || null,
      psi_status:         psiStatus            || 'unknown'
    }
  };
}
