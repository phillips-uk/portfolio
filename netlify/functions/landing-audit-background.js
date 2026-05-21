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
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      clearTimeout(timeout);
      html = await res.text();
    } catch (e) {
      fetchError = e.message;
    }

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

    console.log('[audit] psi done, mobile score:', psiMobile?.score ?? 'null', 'desktop:', psiDesktop?.score ?? 'null');

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
    const report = buildReport(url, parsed, psiMobile, psiDesktop, claudeResult, isHttps, fetchError);

    console.log('[audit] report built, score:', report.health_score);
    await store.set(jobId, JSON.stringify({ status: 'complete', data: report }));
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

// ─── HTML parsing ────────────────────────────────────────────────────────────

function parseHtml (html, url, isHttps, fetchError) {
  if (!html || fetchError) {
    return {
      fetchFailed: true, isHttps,
      title: '', metaDescription: '', h1: '', h2s: [],
      aboveFoldText: '', bodyText: '', linkCount: 0,
      formFieldCount: 0, hasAboveFoldCta: false, ctaText: '',
      hasGtm: false, hasGa4: false, hasAdsConversion: false, hasRemarketingOnly: false,
      hasViewport: false, hasPrivacyLink: false,
      socialProofText: '', authoritySignals: '', contactSignals: ''
    };
  }

  const $ = cheerio.load(html);

  const title           = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1              = $('h1').first().text().trim();
  const h2s             = $('h2').slice(0, 3).map((_, el) => $(el).text().trim()).get();
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
  const formFieldCount = $(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea'
  ).length;

  // CTA detection (first 2000 chars of body HTML)
  const bodyHtmlSnip   = ($('body').html() || '').substring(0, 2000);
  const ctaKeywordsRx  = /\b(get started|book|call|contact|buy|order|sign up|request a quote|free|apply|subscribe|download|register|claim|start|try now)\b/i;
  const hasAboveFoldCta = /(<button|<input[^>]*type=["']submit["'])/i.test(bodyHtmlSnip) || ctaKeywordsRx.test(bodyHtmlSnip.substring(0, 1000));

  let ctaText = '';
  $('button, input[type="submit"], .btn, .cta, [class*="button"]').each((_, el) => {
    if (!ctaText) {
      const t = $(el).text().trim() || $(el).attr('value') || '';
      if (t && t.length < 60) ctaText = t;
    }
  });

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

  return {
    fetchFailed: false, isHttps,
    title, metaDescription, h1, h2s,
    aboveFoldText, bodyText: bodyText.substring(0, 3000),
    linkCount, formFieldCount, hasAboveFoldCta, ctaText,
    hasGtm, hasGa4, hasAdsConversion, hasRemarketingOnly,
    hasViewport, hasPrivacyLink,
    socialProofText, authoritySignals, contactSignals,
    // Richer trust signals
    testimonialBlockCount, hasVideoContent, hasTrustBadges,
    starRatingPresent, namedTestimonialPresent
  };
}

// ─── PageSpeed Insights ───────────────────────────────────────────────────────

async function fetchPsi (url, strategy, key) {
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${key}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s — slow pages take 25-30s
  try {
    const res  = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data    = await res.json();
    const audits  = data.lighthouseResult?.audits || {};
    const cats    = data.lighthouseResult?.categories || {};
    return {
      score:      Math.round((cats.performance?.score || 0) * 100),
      lcp:        audits['largest-contentful-paint']?.numericValue ?? null,
      cls:        audits['cumulative-layout-shift']?.numericValue  ?? null,
      inp:        audits['interaction-to-next-paint']?.numericValue ?? null,
      ttfb:       audits['server-response-time']?.numericValue      ?? null,
      tapTargets: audits['tap-targets']?.score                      ?? null
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// ─── Claude analysis ─────────────────────────────────────────────────────────

async function analyzeWithClaude (parsed) {
  const prompt = `URL content to analyze for Google Ads Landing Page Experience quality.

URL slug keyword signal: ${parsed.urlKeyword || '(homepage or non-descriptive URL)'}
Title tag: ${parsed.title || '(none)'}
H1: ${parsed.h1 || '(none)'}
Meta description: ${parsed.metaDescription || '(none)'}
H2 headings: ${parsed.h2s.join(' | ') || '(none)'}
Above-fold copy (first 500 chars): ${parsed.aboveFoldText || '(none)'}
Primary CTA text: ${parsed.ctaText || '(none)'}
Total links on page: ${parsed.linkCount}
Visible form fields: ${parsed.formFieldCount}
Social proof in copy: ${parsed.socialProofText ? 'Present' : 'None detected'}
Testimonial block elements found: ${parsed.testimonialBlockCount}
Star ratings / review counts in copy: ${parsed.starRatingPresent ? 'Yes' : 'No'}
Named testimonials (real names near quotes): ${parsed.namedTestimonialPresent ? 'Detected' : 'Not detected'}
Video content present: ${parsed.hasVideoContent ? 'Yes' : 'No'}
Trust badge / accreditation text: ${parsed.hasTrustBadges ? 'Detected' : 'Not detected'}
Authority signals: ${parsed.authoritySignals || 'None detected'}
Contact signals (phone/email/address): ${parsed.contactSignals || 'None detected'}
${parsed.fetchFailed ? 'NOTE: Page fetch failed. Content analysis is limited — flag this in findings.' : ''}

Return ONLY valid JSON (no markdown fences, no explanation) matching this schema exactly:
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
  "relevance_reason": "one sentence",
  "value_proposition_clarity": "clear|weak|missing",
  "value_proposition_reason": "one sentence — what makes it clear or what is missing",
  "cta_quality": "specific|generic|missing",
  "cta_reason": "one sentence",
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
      "severity": "critical|high|medium|low",
      "title": "short issue title",
      "detail": "1-2 sentences framed as opportunity or data insight — what does fixing this unlock? Cite conversion research where relevant.",
      "fix": "one sentence fix"
    }
  ]
}

Only include a finding when there is a genuine issue. Do not manufacture findings for things that are passing. Focus on issues that affect Quality Score, Landing Page Experience, and conversion rate for paid traffic. Frame all findings as opportunity-led, not problem-led.`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping content analysis');
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: 'Content analysis unavailable.', findings: [] };
  }

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 30000 }); // 30s hard timeout
    const msg  = await anthropic.messages.create({
      model:      'claude-3-5-haiku-20241022',
      max_tokens: 3000,
      system:     'You are a PPC specialist auditing landing pages used as Google Ads destinations. Frame every finding in paid search terms — Quality Score, Landing Page Experience, CPCs, conversion rate. Be direct. No generic CRO advice. Return only valid JSON with no markdown fences.',
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

function buildReport (url, parsed, psiMobile, psiDesktop, claude, isHttps, fetchError) {
  const findings = [];

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

  // ── Mobile structure ───────────────────────────────────────────────────────
  if (!parsed.hasViewport)
    findings.push({ category: 'mobile', severity: 'high', title: 'No viewport meta tag — page may be broken on mobile', detail: 'Without a viewport meta tag, mobile browsers render the page at full desktop width and scale it down. This makes the page nearly unusable on a phone. Given that most paid search traffic is on mobile, this is likely causing high immediate bounce.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head> tag.' });

  // ── Tracking ───────────────────────────────────────────────────────────────
  if (!isHttps)
    findings.push({ category: 'tracking', severity: 'critical', title: 'Page served over HTTP — ads may be disapproved', detail: "Chrome shows this page as insecure. Google's advertising policy requires HTTPS landing pages — ads pointing to HTTP destinations are at risk of disapproval or limited delivery. Switching to HTTPS also improves trust signals for paid traffic visitors.", fix: 'Install an SSL certificate and redirect all HTTP traffic to HTTPS. Most hosting platforms include this free.' });

  if (!parsed.hasGtm)
    findings.push({ category: 'tracking', severity: 'high', title: 'No tag manager detected', detail: 'Without a tag management system, adding or updating any tracking requires a code deployment. This creates gaps in conversion data when campaigns change. Installing GTM gives you full control over all tracking without developer involvement — future changes take minutes, not days.', fix: 'Install Google Tag Manager. Add the container snippet to every page, then migrate existing tracking tags into GTM.' });

  if (!parsed.hasGa4)
    findings.push({ category: 'tracking', severity: 'high', title: 'GA4 not detected', detail: 'Without GA4, you have no visibility into post-click behaviour — what users do after your ad sends them here. GA4 also feeds audience data back into Google Ads for Smart Bidding signals. Adding it gives you session data, engagement metrics, and the ability to build retargeting audiences from this traffic.', fix: 'Add the GA4 tag via GTM. At minimum configure page view, scroll depth, and form submission events.' });

  if (!parsed.hasAdsConversion) {
    if (parsed.hasRemarketingOnly) {
      findings.push({ category: 'tracking', severity: 'medium', title: 'Remarketing tag present — no conversion event', detail: 'The data shows you can build remarketing audiences from this page, but there is no conversion event firing. Smart Bidding strategies (Target CPA, Maximise Conversions) require conversion data to optimise toward. Without it, they are effectively guessing at which clicks to bid up.', fix: 'Add a Google Ads conversion tag for your primary conversion goal via GTM and fire it on the confirmation page or success event.' });
    } else if (parsed.hasGtm) {
      findings.push({ category: 'tracking', severity: 'medium', title: 'Verify Google Ads conversion tag is firing via GTM', detail: 'GTM is installed, so a conversion tag may already be active through the container — this tool cannot inspect GTM tags from outside. If a conversion tag is not configured, Smart Bidding has no signal to optimise toward and you cannot attribute leads to specific campaigns. A quick check in Google Tag Assistant takes two minutes and rules this out.', fix: 'Open Google Tag Assistant, navigate to this page, and confirm a Google Ads conversion tag fires on your key conversion event (form submission, booking confirmation, etc.).' });
    } else {
      findings.push({ category: 'tracking', severity: 'critical', title: 'No Google Ads conversion tag found', detail: "The data shows no Google Ads conversion tag in the page source and no GTM container to fire one dynamically. Without a conversion tag, Smart Bidding strategies have no goal to optimise toward — Google's own data shows properly configured Smart Bidding delivers 35% more conversions than running without conversion data. This is the most important tracking fix for any active paid search campaign.", fix: 'Install GTM, then add a Google Ads conversion tag that fires on your primary conversion event (form submission, booking, enquiry).' });
    }
  }

  // ── Landing page experience ────────────────────────────────────────────────
  if (!parsed.h1)
    findings.push({ category: 'landing_page_experience', severity: 'critical', title: 'No H1 tag found', detail: "The H1 is one of the primary on-page signals Google uses to assess page relevance. Without it, the page has no explicit keyword anchor for Google's quality assessment — this directly affects Landing Page Experience, which is one of the three inputs to Quality Score. Adding a keyword-rich H1 is one of the fastest ways to improve relevance signals for this URL.", fix: 'Add a clear H1 that includes your primary target keyword. It should be the first prominent heading a visitor sees on the page.' });

  if (!parsed.hasPrivacyLink)
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No privacy policy link detected', detail: 'No privacy policy link was found in the accessible content of this page. If it exists in a JavaScript-rendered footer our tool may have missed it — verify in your browser. If it is genuinely missing: beyond GDPR compliance, users arriving from paid ads are actively evaluating your credibility. A visible privacy policy reduces friction for first-time visitors making a booking enquiry.', fix: 'Add a link to your privacy policy in the page footer. If one already exists via dynamic loading, no action needed — verify it renders in your browser.' });

  // ── Conversion architecture ────────────────────────────────────────────────
  if (parsed.linkCount > 20) {
    findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.linkCount} links suggest a full website page — consider a dedicated landing page`, detail: `This page has ${parsed.linkCount} links, which is typical of a full website page rather than a purpose-built landing page. Unbounce's conversion research shows dedicated landing pages — with navigation removed and a single conversion goal — outperform website pages by 25–40% for paid traffic. The opportunity here is not that something is broken, but that a dedicated landing page for this campaign could significantly improve your cost per lead.`, fix: 'Consider building a dedicated landing page for this ad campaign — same offer, same copy, but with navigation stripped and a single CTA. Your main website page remains untouched.' });
  } else if (parsed.linkCount > 10) {
    findings.push({ category: 'conversion_architecture', severity: 'low', title: `${parsed.linkCount} links competing with primary CTA`, detail: `With ${parsed.linkCount} links on the page, there are multiple exits competing with your CTA for attention. Research from WordStream shows that reducing the number of links on a landing page to a single CTA can improve conversion rate by up to 371%. Even removing the top navigation can produce measurable improvements.`, fix: 'Remove or hide the top navigation bar for paid traffic. Even a simple change like this can increase the share of visitors who reach your CTA.' });
  }

  if (parsed.formFieldCount >= 7)
    findings.push({ category: 'conversion_architecture', severity: 'high', title: `${parsed.formFieldCount}-field form — high abandonment risk`, detail: `A ${parsed.formFieldCount}-field form is a significant barrier for users who clicked an ad in a moment of intent. EConsultancy research found that reducing form fields from 11 to 4 increased conversions by 160%. For paid traffic especially, every field is a reason to leave.`, fix: 'Reduce to 3 fields maximum for the initial enquiry. You can collect additional details in the follow-up process after the first conversion event.' });
  else if (parsed.formFieldCount >= 4)
    findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.formFieldCount}-field form — reducing length could lift completions`, detail: `A ${parsed.formFieldCount}-field form is above the optimal length for paid traffic. Research shows reducing from 5 to 3 fields can improve form completion rates by 20–30%. Is every field genuinely needed before you can respond to an enquiry?`, fix: 'Review each field. If any information can be collected after first contact, remove it from this form.' });

  // ── Merge Claude content findings ──────────────────────────────────────────
  const claudeFindings = (claude.findings || []).filter(f => f.severity && f.title && f.detail && f.fix);
  findings.push(...claudeFindings);

  // ── Value proposition ──────────────────────────────────────────────────────
  if (claude.value_proposition_clarity === 'weak')
    findings.push({ category: 'landing_page_experience', severity: 'medium', title: 'Value proposition is unclear above the fold', detail: `The first thing a paid traffic visitor should be able to answer is "why here, why now?" If that answer is not obvious within 5 seconds, conversion research (Nielsen Norman Group) shows most users leave. A clear above-fold statement of what you offer, who it is for, and why you are the right choice is one of the highest-leverage copy changes on any landing page.`, fix: 'Rewrite your hero headline and subtitle to answer three questions: what you offer, who it is for, and what makes you the right choice. Make it scannable in under 5 seconds.' });
  else if (claude.value_proposition_clarity === 'missing')
    findings.push({ category: 'landing_page_experience', severity: 'high', title: 'No clear value proposition detected', detail: `Paid traffic arrives with specific intent — if the page does not immediately confirm "you are in the right place," the click is wasted. Research shows pages with a clear, differentiated value proposition above the fold convert up to 4x better than generic introductions. This is especially important for Quality Score, which assesses expected relevance from the user's perspective.`, fix: 'Add a headline that states specifically what you offer and the primary benefit. Follow it with a 1–2 sentence supporting statement that addresses the visitor's main concern.' });

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

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 100;
  let criticalCount = 0;
  // Score cap for missing conversion tag only applies when there is definitely no GTM container
  // (GTM may be firing a conversion tag we cannot see from outside)
  const noConversionAndNoGtm = !parsed.hasAdsConversion && !parsed.hasGtm;

  for (const f of findings) {
    if      (f.severity === 'critical') { score -= 20; criticalCount++; }
    else if (f.severity === 'high')     score -= 10;
    else if (f.severity === 'medium')   score -= 5;
    else if (f.severity === 'low')      score -= 2;
  }

  if      (criticalCount >= 2)   score = Math.min(score, 45);
  else if (criticalCount >= 1)   score = Math.min(score, 65);
  if      (noConversionAndNoGtm) score = Math.min(score, 65);
  score = Math.max(5, score);

  const scoreBand = score >= 80 ? 'Strong' : score >= 60 ? 'Average' : score >= 40 ? 'Needs work' : 'Critical';

  // ── Priority actions ───────────────────────────────────────────────────────
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const priorityActions = [...findings]
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
        inferred_keyword: claude.inferred_keyword,
        confidence:       claude.keyword_confidence,
        confidence_reason: claude.keyword_confidence_reason,
        intent_type:      claude.intent_type,
        specificity:      claude.keyword_specificity
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
      fetch_failed:   parsed.fetchFailed || false,
      is_js_rendered: claude.is_js_rendered_likely || false
    }
  };
}
