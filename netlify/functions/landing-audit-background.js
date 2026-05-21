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

    // 3. PSI parallel (mobile + desktop)
    const psiKey = process.env.PSI_API_KEY;
    let psiMobile = null, psiDesktop = null;
    if (psiKey) {
      const [mRes, dRes] = await Promise.allSettled([
        fetchPsi(url, 'mobile', psiKey),
        fetchPsi(url, 'desktop', psiKey)
      ]);
      psiMobile  = mRes.status === 'fulfilled' ? mRes.value : null;
      psiDesktop = dRes.status === 'fulfilled' ? dRes.value : null;
    }

    const psiStatus = psiMobile ? 'ok' : 'failed';
    console.log('[audit] psi done — mobile:', psiMobile ? `score ${psiMobile.score}, src: ${psiMobile.dataSource}` : 'NULL', '| desktop:', psiDesktop ? `score ${psiDesktop.score}` : 'NULL');

    // PSI content fallback — when direct fetch is blocked, use Lighthouse's Chrome render.
    // Googlebot bypasses Cloudflare/WAF, so this gives us what Google actually sees.
    // Populates: title, meta, tracking signals. Body text / H1 / trust signals remain unavailable.
    if (parsed.fetchFailed && psiMobile?.contentSignals) {
      const cs = psiMobile.contentSignals;
      if (cs.title)           parsed.title           = cs.title;
      if (cs.metaDescription) parsed.metaDescription = cs.metaDescription;
      parsed.hasGtm             = cs.hasGtm;
      parsed.hasGa4             = cs.hasGa4;
      parsed.hasAdsConversion   = cs.hasAdsConversion;
      parsed.hasRemarketingOnly = !cs.hasAdsConversion && cs.hasRemarketingTag;
      parsed.contentFromPsi     = true;
      console.log('[audit] psi content fallback applied — title:', cs.title || 'none', 'gtm:', cs.hasGtm, 'ga4:', cs.hasGa4);
    }

    // 4. Claude content analysis
    const claudeResult = await analyzeWithClaude(parsed);

    // Keyword fallback chain: URL slug → H1 → title (in descending confidence)
    if (!claudeResult.inferred_keyword) {
      if (parsed.urlKeyword) {
        // URL slug is the strongest signal — chosen explicitly by the site owner
        claudeResult.inferred_keyword        = parsed.urlKeyword;
        claudeResult.keyword_confidence      = 'high';
        claudeResult.keyword_confidence_reason = 'Inferred from the URL slug — the most explicit keyword signal on the page.';
      } else if (parsed.h1) {
        claudeResult.inferred_keyword = parsed.h1.trim();
        const h1Words    = parsed.h1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const titleLower = (parsed.title || '').toLowerCase();
        const matchCount = h1Words.filter(w => titleLower.includes(w)).length;
        const matchRatio = h1Words.length > 0 ? matchCount / h1Words.length : 0;
        claudeResult.keyword_confidence        = matchRatio >= 0.5 ? 'high' : 'medium';
        claudeResult.keyword_confidence_reason = matchRatio >= 0.5
          ? 'H1 and title tag share the same core keyword — strong alignment.'
          : 'Inferred from H1 heading. Title tag alignment is partial.';
      }
    }

    console.log('[audit] claude done, keyword:', claudeResult.inferred_keyword || 'none', 'findings:', (claudeResult.findings || []).length);

    // 5. Build final report
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
    .filter(([, count]) => count >= 2)
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
  const htmlSafe  = html  || '';
  const urlLower  = (url  || '').toLowerCase();

  // Platform detection from HTML signals
  let platform = null;
  if (/cdn\.shopify\.com|myshopify\.com|Shopify\.theme|Shopify\.config|\/cdn\/shop\//i.test(htmlSafe))
    platform = 'shopify';
  else if (/class=["'][^"']*woocommerce|wp-content\/plugins\/woo/i.test(htmlSafe))
    platform = 'woocommerce';
  else if (/bigcommerce\.com|bc-sf-filter/i.test(htmlSafe))
    platform = 'bigcommerce';
  else if (/\bmagento\b|Mage\.Cookies|mage\//i.test(htmlSafe))
    platform = 'magento';

  // URL-based page subtype
  let subtype = null;
  if (/\/collections\/[^/?#]+/i.test(urlLower))                     subtype = 'collection';
  else if (/\/products\/[^/?#]+/i.test(urlLower))                   subtype = 'product';
  else if (/\/category\/|\/categories\/|\/cat\//i.test(urlLower))   subtype = 'collection';
  else if (/\/p\/[^/?#]+|\/item\/[^/?#]+/i.test(urlLower))         subtype = 'product';

  // Structured data — strong eCommerce signals
  const hasProductSchema   = /"@type"\s*:\s*"Product"/i.test(htmlSafe);
  const hasOfferSchema     = /"@type"\s*:\s*"Offer"/i.test(htmlSafe);
  const hasItemListSchema  = /"@type"\s*:\s*"ItemList"/i.test(htmlSafe);

  // Content signals
  const hasAddToCart    = /add.to.cart|addtocart|add_to_cart/i.test(htmlSafe);
  const hasPriceEl      = /itemprop=["']price["']|data-product-price|class=["'][^"']*price/i.test(htmlSafe);
  const hasOgProduct    = /<meta[^>]+property=["']og:type["'][^>]+content=["']product/i.test(htmlSafe);

  let ecomScore = 0;
  if (platform)                              ecomScore += 5;
  if (subtype)                               ecomScore += 3;
  if (hasProductSchema || hasOfferSchema)    ecomScore += 3;
  if (hasItemListSchema)                     ecomScore += 2;
  if (hasAddToCart)                          ecomScore += 2;
  if (hasPriceEl)                            ecomScore += 1;
  if (hasOgProduct)                          ecomScore += 2;

  return {
    type:     ecomScore >= 3 ? 'ecommerce' : 'lead_gen',
    platform: platform,
    subtype:  subtype || (ecomScore >= 3 ? 'generic' : null)
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

  // Strip noise then get body text
  $('script, style, nav, footer, header, noscript').remove();
  const bodyText     = $('body').text().replace(/\s+/g, ' ').trim();
  const aboveFoldText = bodyText.substring(0, 500);

  // Star rating detection (post-strip body text)
  const starRatingRx = /★{3,}|☆{3,}|\d+\.?\d*\s*(stars?|out of 5|\/5)|rated\s+\d+|\d+\s*reviews?/i;
  const starRatingPresent = starRatingRx.test(bodyText);

  // Named testimonial — a real name pattern adjacent to testimonial blocks
  const namedTestimonialPresent = testimonialBlockCount > 0
    && /[A-Z][a-z]+\s+[A-Z][a-z]+|[A-Z][a-z]+,\s*(parent|customer|client|mum|dad|swimmer|member)/i.test(bodyText);

  const linkCount      = $('a[href]').length;
  const imageCount     = $('img').length;
  const formFieldCount = $(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea'
  ).length;

  // CTA detection (first 2000 chars of body HTML)
  const bodyHtmlSnip   = ($('body').html() || '').substring(0, 2000);
  const ctaKeywordsRx  = /\b(get started|book|call|contact|buy|order|sign up|request a quote|free|apply|subscribe|download|register|claim|start|try now)\b/i;
  const hasAboveFoldCta = /(<button|<input[^>]*type=["']submit["'])/i.test(bodyHtmlSnip) || ctaKeywordsRx.test(bodyHtmlSnip.substring(0, 1000));

  // All CTA button texts (deduplicated, for Claude)
  const ctaTexts = [];
  $('button, input[type="submit"], .btn, .cta, [class*="button"], a[class*="btn"], a[class*="cta"]').each((_, el) => {
    const t = $(el).text().trim() || $(el).attr('value') || '';
    if (t && t.length < 80 && !ctaTexts.includes(t)) ctaTexts.push(t);
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
  // For eCommerce: strip product card headings from the source text before counting phrases.
  // Page descriptions, above-fold copy and SEO content are kept — only the grid product
  // titles (which pollute frequency counts) are removed.
  const urlSlug = extractUrlKeyword(url) || '';
  let ngramBodyText = bodyText;
  if (pageTypeInfo.type === 'ecommerce') {
    // Strip entire product card containers — not just headings.
    // Product cards contain titles, material variants, prices and colour swatches
    // that all pollute N-gram frequency counts with noise unrelated to the page keyword.
    // Page description copy, above-fold text and SEO content sit outside these containers
    // and are preserved.
    $(
      '[class*="product-card"],' +
      '[class*="card-wrapper"],' +
      '[class*="product-item"]:not(main):not(article):not(section),' +
      '[class*="product-tile"],' +
      '[class*="product-loop"],' +
      '[class*="grid__item"],' +
      'li.product,' +
      '[class*="productItem"],' +
      '[class*="collection-item"]'
    ).remove();
    ngramBodyText = $('body').text().replace(/\s+/g, ' ').trim();
  }
  const topNgrams = computeTopNgrams(ngramBodyText, urlSlug, h1, title);

  return {
    fetchFailed: false, isHttps,
    title, metaDescription, h1, h2s, h3s,
    aboveFoldText, bodyText: bodyText.substring(0, 5000),
    linkCount, navLinkCount, formFieldCount, hasAboveFoldCta, ctaText, ctaTexts,
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
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s — slow pages take 25-30s
  try {
    const res  = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(`[psi] ${strategy} attempt ${attempt} failed — HTTP ${res.status}`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 4000));
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
      await new Promise(r => setTimeout(r, 4000));
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
- DO assess: product/category keyword relevance, CTA clarity (Add to Cart / Buy Now / Shop), product trust signals (reviews, ratings, returns policy), and ad-to-page message match
- Conversion friction = purchase friction, not lead capture friction`
    : '';

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

Above-fold copy (first 500 chars):
${parsed.aboveFoldText || '(none)'}

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
Form fields:              ${parsed.formFieldCount}
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
      "severity": "pass|critical|high|medium|low",
      "title": "short, specific title — reference page content where possible",
      "detail": "2-3 sentences. For issues: what is happening on this page, why it hurts conversion, what fixing it unlocks — cite conversion data where relevant. For pass findings: what is working and why it matters for paid traffic.",
      "fix": "one sentence — specific action, not a generic recommendation"
    }
  ]
}`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping content analysis');
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: 'Content analysis unavailable.', findings: [] };
  }

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 45000 }); // 45s — Sonnet needs more room
    const msg  = await anthropic.messages.create({
      model:      'claude-3-5-sonnet-20241022',
      max_tokens: 5000,
      system:     'You are a PPC conversion specialist. You audit landing pages used as Google Ads destinations. Every finding must be grounded in the actual page content provided — specific, not generic. Frame all analysis in paid search terms: Quality Score, Landing Page Experience, conversion rate, CPA. Return only valid JSON with no markdown fences.',
      messages:   [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '{}';
    return JSON.parse(text);
  } catch (e) {
    console.error('Claude error:', e.message);
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: 'Content analysis failed.', findings: [] };
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
        findings.push({ category: 'performance', severity: 'high', title: `Slow mobile load — LCP ${lcpS.toFixed(1)}s`, detail: `Google's own research shows that as load time increases from 1s to 5s, the probability of bounce rises by 90%. At ${lcpS.toFixed(1)}s LCP on mobile, a significant share of your paid traffic is leaving before your offer loads — and you're paying for every one of those clicks. Fixing this could materially reduce wasted ad spend.`, fix: 'Optimise images to WebP, reduce server response time, and eliminate render-blocking JavaScript and CSS.' });
      else if (lcpS > 2.5)
        findings.push({ category: 'performance', severity: 'medium', title: `LCP ${lcpS.toFixed(1)}s — approaching the warning threshold`, detail: `LCP of ${lcpS.toFixed(1)}s is in Google's "Needs improvement" range. It isn't a critical problem yet, but improving it to under 2.5s would strengthen your Landing Page Experience signal and reduce mobile bounce.`, fix: 'Optimise your largest above-fold element — typically the hero image or heading font.' });
    }

    const cls = psiMobile.cls;
    if (cls != null) {
      if (cls > 0.25)
        findings.push({ category: 'performance', severity: 'high', title: `High layout shift (CLS ${cls.toFixed(3)})`, detail: `A CLS of ${cls.toFixed(3)} means the page moves after it loads. On mobile, this causes accidental taps on the wrong elements. Google links high CLS to lower engagement and worse Landing Page Experience scores — fixing it is a direct Quality Score improvement lever.`, fix: 'Add explicit width and height to images and reserve space for dynamic elements (banners, embeds, fonts).' });
      else if (cls > 0.1)
        findings.push({ category: 'performance', severity: 'medium', title: `Layout shift in warning zone (CLS ${cls.toFixed(3)})`, detail: `CLS of ${cls.toFixed(3)} is above the 0.1 threshold Google considers good. Getting below 0.1 would move this into a passing Landing Page Experience signal.`, fix: 'Identify shifting elements using Chrome DevTools Layout Shift Regions, then add fixed dimensions.' });
    }

    const inp = psiMobile.inp;
    if (inp != null) {
      if (inp > 500)
        findings.push({ category: 'performance', severity: 'high', title: `Page feels unresponsive on mobile (INP ${Math.round(inp)}ms)`, detail: `INP measures how quickly the page responds to a tap or click. At ${Math.round(inp)}ms, users experience a noticeable delay before anything happens. Google includes this in Landing Page Experience assessment — improving responsiveness can reduce frustration-driven exits from paid traffic.`, fix: 'Reduce JavaScript execution on page load. Defer or async non-essential scripts.' });
      else if (inp > 200)
        findings.push({ category: 'performance', severity: 'medium', title: `Interaction responsiveness needs improvement (INP ${Math.round(inp)}ms)`, detail: `INP of ${Math.round(inp)}ms is above Google's 200ms threshold. Bringing this into the "Good" range would improve the mobile experience for paid traffic and strengthen the Landing Page Experience signal.`, fix: 'Profile JavaScript performance in Chrome DevTools and defer non-essential interaction handlers.' });
    }

    const ttfb = psiMobile.ttfb;
    if (ttfb != null) {
      if (ttfb > 1800)
        findings.push({ category: 'performance', severity: 'high', title: `Slow server response (TTFB ${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms is the time before the browser receives its first byte from your server. Google's crawler experiences this delay too — and it feeds into Landing Page Experience scoring. A faster server means faster everything else on the page.`, fix: 'Upgrade hosting, enable server-side caching, or move to a CDN-backed infrastructure.' });
      else if (ttfb > 800)
        findings.push({ category: 'performance', severity: 'medium', title: `Server response time above target (${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms is above Google's 800ms good threshold. Getting below 800ms would remove this as a drag on your overall performance score.`, fix: 'Enable server-side caching and check for slow database queries or unoptimised hosting.' });
    }

    const ms = psiMobile.score;
    if (ms < 30)
      findings.push({ category: 'mobile', severity: 'critical', title: `Critical mobile score — ${ms}/100`, detail: `A mobile score of ${ms} places this page in Google's lowest performance band. Over 60% of paid search clicks come from mobile — this score is actively degrading your Landing Page Experience, which feeds directly into Quality Score and CPCs. Improving it to 50+ could reduce CPCs and increase the volume of clicks you receive at the same budget.`, fix: 'Address LCP and CLS first — they carry the most weight in the performance score. Use PageSpeed Insights for the full optimisation list.' });
    else if (ms < 50)
      findings.push({ category: 'mobile', severity: 'high', title: `Poor mobile score — ${ms}/100`, detail: `Mobile score of ${ms} is in the "Poor" band. With over 60% of paid search clicks on mobile, this is hurting the majority of your ad traffic. Moving from "Poor" to "Needs improvement" (50+) will reduce bounce from mobile clicks and strengthen your Landing Page Experience signal.`, fix: 'Work through the LCP and CLS findings in this report first. Then run PageSpeed Insights for additional quick wins.' });
    else if (ms < 90)
      findings.push({ category: 'mobile', severity: 'medium', title: `Mobile score ${ms}/100 — room to improve`, detail: `Mobile score of ${ms} is in the "Needs improvement" band. Over 60% of paid search clicks are on mobile — getting above 90 would move this into Google's "Good" range and remove it as a drag on Landing Page Experience.`, fix: 'Run PageSpeed Insights for this page and action the highest-opportunity items in the Diagnostics section.' });

    if (psiMobile.tapTargets != null && psiMobile.tapTargets < 0.9)
      findings.push({ category: 'mobile', severity: 'low', title: 'Some tap targets may be too small for mobile', detail: 'PageSpeed data shows some interactive elements may be below the recommended 48x48px touch target size. Small tap targets cause misclicks on mobile, which can redirect users away from your CTA.', fix: 'Ensure all buttons and links are at least 48x48 CSS pixels with 8px of space between them.' });
  }

  // ── Tracking — runs even for blocked pages when PSI content signals available ─
  // (PSI scans all loaded network requests, so tracking detection is accurate
  //  even when Cloudflare blocks our direct fetch)
  if (!parsed.fetchFailed || parsed.contentFromPsi) {

  // HTTPS — always check, regardless of page type
  if (!isHttps)
    findings.push({ category: 'tracking', severity: 'critical', title: 'Page served over HTTP — ads may be disapproved', detail: "Chrome shows this page as insecure. Google's advertising policy requires HTTPS landing pages — ads pointing to HTTP destinations are at risk of disapproval or limited delivery. Switching to HTTPS also improves trust signals for paid traffic visitors.", fix: 'Install an SSL certificate and redirect all HTTP traffic to HTTPS. Most hosting platforms include this free.' });

  if (isEcommerce && knownPlatform) {
    // Known eCommerce platforms (Shopify, WooCommerce, etc.) commonly use server-side GTM,
    // platform pixels, or Customer Events APIs that aren't visible in the page HTML.
    // Flagging absent tags here produces false positives — tracking is handled by the Google Ads Audit.
    const platformName = knownPlatform.charAt(0).toUpperCase() + knownPlatform.slice(1);
    findings.push({
      category: 'tracking',
      severity: 'info',
      title: `Tracking scan limited — ${platformName} store detected`,
      detail: `${platformName} stores commonly use server-side GTM, platform pixels, or Customer Events APIs that are not visible in the page HTML. GTM, GA4, and Google Ads conversion events may all be active without appearing in the static source. This scanner cannot verify them from the outside.`,
      fix: `Verify your conversion tracking is firing correctly in Google Tag Assistant. For a full tracking health check against your Google Ads account, use the Google Ads Audit tool at phillips-uk.com/google-ads-audit.`
    });
  } else {
    // Lead gen or generic eCommerce — run standard tracking checks

    if (!parsed.hasGtm)
      findings.push({ category: 'tracking', severity: 'high', title: 'No tag manager detected', detail: 'Without a tag management system, adding or updating any tracking requires a code deployment. This creates gaps in conversion data when campaigns change. Installing GTM gives you full control over all tracking without developer involvement — future changes take minutes, not days.', fix: 'Install Google Tag Manager. Add the container snippet to every page, then migrate existing tracking tags into GTM.' });

    if (!parsed.hasGa4) {
      if (parsed.hasGtm) {
        findings.push({ category: 'tracking', severity: 'medium', title: 'GA4 not detected in page source — verify it is firing via GTM', detail: 'GTM is installed, so GA4 may already be active inside the container — this tool cannot inspect GTM tags from outside the page. If GA4 is genuinely missing, you lose all post-click behavioural data and the audience signals that feed Smart Bidding. A quick check in Google Tag Assistant will confirm whether the GA4 tag is firing.', fix: 'Open Google Tag Assistant, navigate to this page, and confirm a GA4 Configuration tag fires on page load. If it is not there, add it inside GTM.' });
      } else {
        findings.push({ category: 'tracking', severity: 'high', title: 'GA4 not detected', detail: 'Without GA4, you have no visibility into post-click behaviour — what users do after your ad sends them here. GA4 also feeds audience data back into Google Ads for Smart Bidding signals. Adding it gives you session data, engagement metrics, and the ability to build retargeting audiences from this traffic.', fix: 'Add the GA4 tag via GTM. At minimum configure page view, scroll depth, and form submission events.' });
      }
    }

    if (!parsed.hasAdsConversion) {
      if (parsed.hasRemarketingOnly) {
        findings.push({ category: 'tracking', severity: 'medium', title: 'Remarketing tag present — no conversion event', detail: 'The data shows you can build remarketing audiences from this page, but there is no conversion event firing. Smart Bidding strategies (Target CPA, Maximise Conversions) require conversion data to optimise toward. Without it, they are effectively guessing at which clicks to bid up.', fix: 'Add a Google Ads conversion tag for your primary conversion goal via GTM and fire it on the confirmation page or success event.' });
      } else if (parsed.hasGtm) {
        findings.push({ category: 'tracking', severity: 'medium', title: 'Verify Google Ads conversion tag is firing via GTM', detail: 'GTM is installed, so a conversion tag may already be active through the container — this tool cannot inspect GTM tags from outside. If a conversion tag is not configured, Smart Bidding has no signal to optimise toward and you cannot attribute leads to specific campaigns. A quick check in Google Tag Assistant takes two minutes and rules this out.', fix: 'Open Google Tag Assistant, navigate to this page, and confirm a Google Ads conversion tag fires on your key conversion event (form submission, booking confirmation, etc.).' });
      } else {
        findings.push({ category: 'tracking', severity: 'critical', title: 'No Google Ads conversion tag found', detail: "The data shows no Google Ads conversion tag in the page source and no GTM container to fire one dynamically. Without a conversion tag, Smart Bidding strategies have no goal to optimise toward — Google's own data shows properly configured Smart Bidding delivers 35% more conversions than running without conversion data. This is the most important tracking fix for any active paid search campaign.", fix: 'Install GTM, then add a Google Ads conversion tag that fires on your primary conversion event (form submission, booking, enquiry).' });
      }
    }

  } // end tracking checks

  } // end tracking block

  // ── HTML-only findings — require direct page content (skip for blocked pages) ─
  if (!parsed.fetchFailed) {

  // ── Landing page experience ────────────────────────────────────────────────
  if (!parsed.h1)
    findings.push({ category: 'landing_page_experience', severity: 'critical', title: 'No H1 tag found', detail: "The H1 is one of the primary on-page signals Google uses to assess page relevance. Without it, the page has no explicit keyword anchor for Google's quality assessment — this directly affects Landing Page Experience, which is one of the three inputs to Quality Score. Adding a keyword-rich H1 is one of the fastest ways to improve relevance signals for this URL.", fix: 'Add a clear H1 that includes your primary target keyword. It should be the first prominent heading a visitor sees on the page.' });

  if (!parsed.hasPrivacyLink)
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No privacy policy link detected', detail: 'No privacy policy link was found in the accessible content of this page. If it exists in a JavaScript-rendered footer our tool may have missed it — verify in your browser. If it is genuinely missing: beyond GDPR compliance, users arriving from paid ads are actively evaluating your credibility. A visible privacy policy reduces friction for first-time visitors making a booking enquiry.', fix: 'Add a link to your privacy policy in the page footer. If one already exists via dynamic loading, no action needed — verify it renders in your browser.' });

  // ── Conversion architecture ────────────────────────────────────────────────
  // Link count — eCommerce pages (collection/product grids) have many links by design
  if (!isEcommerce) {
    if (parsed.linkCount > 20) {
      findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.linkCount} links suggest a full website page — consider a dedicated landing page`, detail: `This page has ${parsed.linkCount} links, which is typical of a full website page rather than a purpose-built landing page. Unbounce's conversion research shows dedicated landing pages — with navigation removed and a single conversion goal — outperform website pages by 25–40% for paid traffic. The opportunity here is not that something is broken, but that a dedicated landing page for this campaign could significantly improve your cost per lead.`, fix: 'Consider building a dedicated landing page for this ad campaign — same offer, same copy, but with navigation stripped and a single CTA. Your main website page remains untouched.' });
    } else if (parsed.linkCount > 10) {
      findings.push({ category: 'conversion_architecture', severity: 'low', title: `${parsed.linkCount} links competing with primary CTA`, detail: `With ${parsed.linkCount} links on the page, there are multiple exits competing with your CTA for attention. Research from WordStream shows that reducing the number of links on a landing page to a single CTA can improve conversion rate by up to 371%. Even removing the top navigation can produce measurable improvements.`, fix: 'Remove or hide the top navigation bar for paid traffic. Even a simple change like this can increase the share of visitors who reach your CTA.' });
    }
  }

  // Form length — not applicable to eCommerce pages (no lead capture form expected)
  if (!isEcommerce) {
    if (parsed.formFieldCount >= 7)
      findings.push({ category: 'conversion_architecture', severity: 'high', title: `${parsed.formFieldCount}-field form — high abandonment risk`, detail: `A ${parsed.formFieldCount}-field form is a significant barrier for users who clicked an ad in a moment of intent. EConsultancy research found that reducing form fields from 11 to 4 increased conversions by 160%. For paid traffic especially, every field is a reason to leave.`, fix: 'Reduce to 3 fields maximum for the initial enquiry. You can collect additional details in the follow-up process after the first conversion event.' });
    else if (parsed.formFieldCount >= 4)
      findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.formFieldCount}-field form — adds friction for paid traffic`, detail: `Paid search visitors are less patient than organic ones — they clicked an ad in a moment of intent and expect a fast path to what they want. A ${parsed.formFieldCount}-field form introduces friction at exactly that moment. Each extra field reduces your conversion rate and raises your effective CPA, weakening the case for increasing bids. Every field that can be deferred should be.`, fix: 'Reduce to the minimum fields needed for first contact. Collect any additional information after the initial enquiry, not before.' });
  }

  // ── Merge Claude content findings ──────────────────────────────────────────
  const claudeFindings = (claude.findings || []).filter(f => f.severity && f.title && f.detail && f.fix);
  findings.push(...claudeFindings);

  // ── Value proposition ──────────────────────────────────────────────────────
  if (claude.value_proposition_clarity === 'weak')
    findings.push({ category: 'landing_page_experience', severity: 'medium', title: 'Value proposition is unclear above the fold', detail: `The first thing a paid traffic visitor should be able to answer is "why here, why now?" If that answer is not obvious within 5 seconds, conversion research (Nielsen Norman Group) shows most users leave. A clear above-fold statement of what you offer, who it is for, and why you are the right choice is one of the highest-leverage copy changes on any landing page.`, fix: 'Rewrite your hero headline and subtitle to answer three questions: what you offer, who it is for, and what makes you the right choice. Make it scannable in under 5 seconds.' });
  else if (claude.value_proposition_clarity === 'missing')
    findings.push({ category: 'landing_page_experience', severity: 'high', title: 'No clear value proposition detected', detail: `Paid traffic arrives with specific intent — if the page does not immediately confirm "you are in the right place," the click is wasted. Research shows pages with a clear, differentiated value proposition above the fold convert up to 4x better than generic introductions. This is especially important for Quality Score, which assesses expected relevance from the user's perspective.`, fix: 'Add a headline that states specifically what you offer and the primary benefit. Follow it with a 1-2 sentence supporting statement that addresses the visitor\'s main concern.' });

  // ── Message match ──────────────────────────────────────────────────────────
  if (claude.message_match_strength === 'weak')
    findings.push({ category: 'landing_page_experience', severity: 'high', title: 'Weak message match between page and likely ad copy', detail: `Message match is one of the most predictable conversion levers in paid search. When the language on the landing page echoes the ad that drove the click, Google research shows post-click engagement and conversion rate both improve significantly. Weak alignment between the page headline and the ad intent also reduces Quality Score.`, fix: 'Mirror your primary ad headline in the page H1, and use the same language (keyword, offer framing, call to action) in your above-fold copy. Visitors should feel they landed exactly where they expected.' });

  // ── CTA specificity ────────────────────────────────────────────────────────
  if (claude.cta_specificity === 'generic' && parsed.hasAboveFoldCta)
    findings.push({ category: 'conversion_architecture', severity: 'low', title: 'CTA could be more specific', detail: `Generic CTAs like "Submit" or "Click here" underperform specific action-oriented language. WordStream research found that personalised or outcome-focused CTAs outperform generic button text by up to 202%. A CTA that tells the visitor exactly what happens next reduces hesitation.`, fix: `Replace generic CTA text with a specific outcome: "Book Your Free Trial", "Get Your Quote in 2 Minutes", or similar language tied to your conversion goal.` });

  // ── Risk reducer ───────────────────────────────────────────────────────────
  if (claude.risk_reducer_present === false && !parsed.hasRemarketingOnly)
    findings.push({ category: 'trust_signals', severity: 'low', title: 'No risk reducer present', detail: `First-time visitors from paid ads are evaluating risk alongside opportunity. A risk reducer (satisfaction guarantee, no-commitment trial, clear cancellation policy, or money-back promise) directly addresses the hesitation that prevents conversion. EConsultancy research shows risk reducers increase enquiry conversion by 10–15% in service-category landing pages.`, fix: 'Add a brief risk statement near your CTA: a guarantee, a free first session, a "no obligation" commitment, or similar. Even a single sentence reduces the friction of saying yes.' });

  // ── Social proof quality ───────────────────────────────────────────────────
  if (claude.social_proof_quality === 'none' && parsed.testimonialBlockCount === 0 && !parsed.starRatingPresent)
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No social proof detected', detail: `Visitors from paid ads have not heard of you before. Social proof (reviews, star ratings, testimonials with names) is the fastest way to reduce scepticism. BrightLocal research shows 91% of consumers read online reviews before contacting a local service business. Pages with visible social proof convert significantly better than pages relying on copy alone.`, fix: 'Add at least 3 testimonials with names (and photos if possible) above or near your CTA. If you have Google reviews, embed the rating and review count on the page.' });
  else if (claude.social_proof_quality === 'weak' || (parsed.testimonialBlockCount > 0 && !parsed.namedTestimonialPresent))
    findings.push({ category: 'trust_signals', severity: 'low', title: 'Social proof present but could be stronger', detail: `Anonymous testimonials or generic review statements carry less weight than named, specific social proof. Research shows testimonials with a name, role, and specific outcome are 3x more credible than generic quotes. For local service businesses, a named parent or customer removes a significant trust barrier.`, fix: 'Upgrade anonymous testimonials to include the reviewer\'s name and specific outcome ("My son went from nervous to confident in 4 weeks — Jane P., parent"). Photos increase trust further.' });

  } // end !parsed.fetchFailed content block

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 100;
  let criticalCount = 0;
  // Score cap for missing conversion tag only applies when page was actually analysed
  // (when fetch failed, hasAdsConversion/hasGtm are false by default — cap would be misleading)
  // eCommerce pages with known platforms use server-side tracking — cap would be a false penalty
  const noConversionAndNoGtm = !parsed.fetchFailed && !isEcommerce && !knownPlatform && !parsed.hasAdsConversion && !parsed.hasGtm;

  for (const f of findings) {
    if      (f.severity === 'critical') { score -= 20; criticalCount++; }
    else if (f.severity === 'high')     score -= 10;
    else if (f.severity === 'medium')   score -= 5;
    else if (f.severity === 'low')      score -= 2;
    // 'pass' = positive finding, green display, no score change
    // 'info' = contextual note, blue display, no score change
  }

  if      (criticalCount >= 2)   score = Math.min(score, 45);
  else if (criticalCount >= 1)   score = Math.min(score, 65);
  if      (noConversionAndNoGtm) score = Math.min(score, 65);
  score = Math.max(5, score);

  const scoreBand = score >= 80 ? 'Strong' : score >= 60 ? 'Average' : score >= 40 ? 'Needs work' : 'Critical';

  // ── Priority actions — exclude pass/info contextual findings ──────────────
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const priorityActions = [...findings]
    .filter(f => f.severity !== 'pass' && f.severity !== 'info')
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
    .slice(0, 3)
    .map(f => ({ severity: f.severity, category: f.category, title: f.title, fix: f.fix }));

  return {
    url,
    audited_at: new Date().toISOString(),
    health_score: score,
    score_band: scoreBand,
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
