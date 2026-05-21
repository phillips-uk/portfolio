/**
 * landing-audit-background.js
 * Netlify Background Function — runs a full landing page audit.
 *
 * Called by landing-page-audit.html via POST { url, jobId }
 * Returns 202 immediately. Result stored in Netlify Blobs under jobId.
 * Frontend polls /.netlify/functions/landing-audit-status?id={jobId}
 *
 * Env vars: PSI_API_KEY, ANTHROPIC_API_KEY
 */

const { getStore } = require('@netlify/blobs');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return; }

  const { url, jobId } = body;
  if (!url || !jobId) return;

  const store = getStore('landing-audits');

  // Mark in progress
  await store.set(jobId, JSON.stringify({ status: 'pending' }), { ttl: 3600 });

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

    // 2. Parse HTML
    const parsed = parseHtml(html, url, isHttps, fetchError);

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

    // 4. Claude content analysis
    const claudeResult = await analyzeWithClaude(parsed);

    // 5. Build final report
    const report = buildReport(url, parsed, psiMobile, psiDesktop, claudeResult, isHttps, fetchError);

    await store.set(jobId, JSON.stringify({ status: 'complete', data: report }), { ttl: 86400 });

  } catch (e) {
    console.error('Landing audit error:', e);
    await store.set(jobId, JSON.stringify({
      status: 'error',
      message: 'Audit failed unexpectedly. Please try again.'
    }), { ttl: 3600 });
  }
};

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

  // Strip noise then get body text
  $('script, style, nav, footer, header, noscript').remove();
  const bodyText     = $('body').text().replace(/\s+/g, ' ').trim();
  const aboveFoldText = bodyText.substring(0, 500);

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

  const hasPrivacyLink = $('a').toArray().some(el => {
    const href = ($(el).attr('href') || '').toLowerCase();
    const text = $(el).text().toLowerCase();
    return href.includes('privacy') || text.includes('privacy');
  });

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
    hasViewport, hasPrivacyLink, socialProofText, authoritySignals, contactSignals
  };
}

// ─── PageSpeed Insights ───────────────────────────────────────────────────────

async function fetchPsi (url, strategy, key) {
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${key}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
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

Title tag: ${parsed.title || '(none)'}
H1: ${parsed.h1 || '(none)'}
Meta description: ${parsed.metaDescription || '(none)'}
H2 headings: ${parsed.h2s.join(' | ') || '(none)'}
Above-fold copy (first 500 chars): ${parsed.aboveFoldText || '(none)'}
Primary CTA text: ${parsed.ctaText || '(none)'}
Total links on page: ${parsed.linkCount}
Visible form fields: ${parsed.formFieldCount}
Social proof signals in copy: ${parsed.socialProofText ? 'Present' : 'None detected'}
Authority signals: ${parsed.authoritySignals || 'None detected'}
Contact signals (phone/email/address): ${parsed.contactSignals || 'None detected'}
${parsed.fetchFailed ? 'NOTE: Page fetch failed. Content analysis is limited — flag this in findings.' : ''}

Return ONLY valid JSON (no markdown fences, no explanation) matching this schema exactly:
{
  "inferred_keyword": "string or null",
  "keyword_confidence": "high|low|none",
  "keyword_confidence_reason": "one sentence",
  "intent_type": "transactional|commercial|informational|navigational",
  "keyword_specificity": "specific|generic|unknown",
  "h1_quality": "clear|weak|missing",
  "h1_contains_keyword": true|false|null,
  "title_h1_aligned": true|false|null,
  "above_fold_keyword_signal": "strong|moderate|weak|none",
  "page_relevance_to_query": "strong|moderate|weak",
  "relevance_reason": "one sentence",
  "cta_quality": "specific|generic|missing",
  "cta_reason": "one sentence",
  "conversion_goal_clarity": "single|multiple|unclear",
  "social_proof_count": 0,
  "social_proof_quality": "strong|weak|none",
  "authority_signals_present": false,
  "contact_signals_present": false,
  "is_js_rendered_likely": false,
  "findings": [
    {
      "category": "keyword_clarity|landing_page_experience|conversion_architecture|trust_signals",
      "severity": "critical|high|medium|low",
      "title": "short issue title",
      "detail": "1-2 sentences of PPC-framed diagnosis. Frame in Quality Score and Landing Page Experience terms.",
      "fix": "one sentence fix"
    }
  ]
}

Only include a finding when there is a genuine issue. Do not manufacture findings for things that are passing. Focus on issues that affect Quality Score, Landing Page Experience, and conversion rate for paid traffic.`;

  try {
    const msg  = await anthropic.messages.create({
      model:      'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      system:     'You are a PPC specialist auditing landing pages used as Google Ads destinations. Frame every finding in paid search terms — Quality Score, Landing Page Experience, CPCs, conversion rate. Be direct. No generic CRO advice. Return only valid JSON with no markdown fences.',
      messages:   [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '{}';
    return JSON.parse(text);
  } catch (e) {
    console.error('Claude error:', e.message);
    return { inferred_keyword: null, keyword_confidence: 'none', keyword_confidence_reason: '', findings: [] };
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
        findings.push({ category: 'performance', severity: 'high', title: 'Slow page load — LCP over 4s', detail: `Google's Landing Page Experience score includes page speed. A ${lcpS.toFixed(1)}-second load on mobile means users who click your ads bounce before they see your offer. You're paying for those clicks.`, fix: 'Optimise images, reduce server response time, and eliminate render-blocking resources.' });
      else if (lcpS > 2.5)
        findings.push({ category: 'performance', severity: 'medium', title: `LCP ${lcpS.toFixed(1)}s — in the warning zone`, detail: `LCP of ${lcpS.toFixed(1)}s is approaching Google's threshold. Users on mobile notice the delay.`, fix: 'Optimise your largest above-fold element — typically a hero image or heading font.' });
    }

    const cls = psiMobile.cls;
    if (cls != null) {
      if (cls > 0.25)
        findings.push({ category: 'performance', severity: 'high', title: 'High layout shift (CLS)', detail: `CLS of ${cls.toFixed(3)} means elements shift after load, causing accidental taps on mobile. On a landing page with a CTA button this directly kills conversion rate.`, fix: 'Add explicit size attributes to images and reserve space for dynamic content (ads, embeds).' });
      else if (cls > 0.1)
        findings.push({ category: 'performance', severity: 'medium', title: `Layout shift detected (CLS ${cls.toFixed(3)})`, detail: `CLS of ${cls.toFixed(3)} is in the warning zone. Target below 0.1 for a good Landing Page Experience signal.`, fix: 'Identify shifting elements with Chrome DevTools Layout Shift Regions and add fixed dimensions.' });
    }

    const inp = psiMobile.inp;
    if (inp != null) {
      if (inp > 500)
        findings.push({ category: 'performance', severity: 'high', title: `Poor interaction responsiveness (INP ${Math.round(inp)}ms)`, detail: `INP of ${Math.round(inp)}ms means the page feels unresponsive to taps. This is a Landing Page Experience signal Google uses in Quality Score.`, fix: 'Reduce JavaScript execution time and minimise main thread work on page load.' });
      else if (inp > 200)
        findings.push({ category: 'performance', severity: 'medium', title: `Slow page interaction (INP ${Math.round(inp)}ms)`, detail: `INP of ${Math.round(inp)}ms is above the 200ms threshold Google considers good.`, fix: 'Profile JavaScript performance in Chrome DevTools and defer non-essential scripts.' });
    }

    const ttfb = psiMobile.ttfb;
    if (ttfb != null) {
      if (ttfb > 1800)
        findings.push({ category: 'performance', severity: 'high', title: `Slow server response (TTFB ${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms means Google's crawler sees a slow page too. Slow server response feeds into Landing Page Experience and can suppress ad delivery.`, fix: 'Upgrade hosting tier, enable CDN caching, or investigate slow database queries.' });
      else if (ttfb > 800)
        findings.push({ category: 'performance', severity: 'medium', title: `Server response time above threshold (${Math.round(ttfb)}ms)`, detail: `TTFB of ${Math.round(ttfb)}ms is above Google's 800ms threshold.`, fix: 'Enable server-side caching and review hosting configuration.' });
    }

    const ms = psiMobile.score;
    if (ms < 30)
      findings.push({ category: 'mobile', severity: 'critical', title: `Critical mobile performance score (${ms})`, detail: `Mobile performance score of ${ms} is critically low. Over 60% of paid search clicks are on mobile. This score is directly damaging Landing Page Experience and raising your CPCs.`, fix: 'Run a full Core Web Vitals audit. Address LCP and CLS first — they carry the most weight.' });
    else if (ms < 50)
      findings.push({ category: 'mobile', severity: 'high', title: `Poor mobile performance (${ms}/100)`, detail: `Mobile performance score of ${ms} is well below the threshold where it stops hurting your CPC. Most of your paid traffic is on mobile.`, fix: 'Address the LCP and CLS findings above first. Then run PageSpeed Insights for a full optimisation plan.' });
    else if (ms < 90)
      findings.push({ category: 'mobile', severity: 'medium', title: `Mobile performance score ${ms} — room to improve`, detail: `Mobile score of ${ms}. Over 60% of paid search clicks are on mobile. A sub-90 score means slower load times for your majority audience.`, fix: "Use the PageSpeed Insights report for this page to find the highest-impact quick wins." });

    if (psiMobile.tapTargets != null && psiMobile.tapTargets < 0.9)
      findings.push({ category: 'mobile', severity: 'low', title: 'Some tap targets may be too small', detail: 'Buttons or links below 48px in tap area are harder to hit accurately on mobile, reducing CTA engagement.', fix: 'Ensure all interactive elements are at least 48x48 CSS pixels with 8px spacing between them.' });
  }

  // ── Mobile structure ───────────────────────────────────────────────────────
  if (!parsed.hasViewport)
    findings.push({ category: 'mobile', severity: 'high', title: 'No viewport meta tag', detail: 'No viewport meta tag detected. Mobile browsers render the page at desktop width and scale it down — the page is likely broken on mobile.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>.' });

  // ── Tracking ───────────────────────────────────────────────────────────────
  if (!isHttps)
    findings.push({ category: 'tracking', severity: 'critical', title: 'Page served over HTTP', detail: "Google Chrome flags this page as insecure. Google's ad policy requires HTTPS landing pages — your ads may be disapproved or delivery limited.", fix: 'Install an SSL certificate and redirect all HTTP traffic to HTTPS.' });

  if (!parsed.hasGtm)
    findings.push({ category: 'tracking', severity: 'high', title: 'GTM not detected', detail: 'Without GTM, deploying or updating tracking tags requires a developer code change. This creates delays and gaps in conversion data.', fix: 'Install Google Tag Manager. Configuration takes 30 minutes and gives you control over all tracking without developer involvement.' });

  if (!parsed.hasGa4)
    findings.push({ category: 'tracking', severity: 'high', title: 'GA4 not detected', detail: 'Without GA4, you have no visibility into what users do after clicking your ad — no session data, no engagement signals, no audience building.', fix: 'Add GA4 via GTM. At minimum, configure page view, scroll depth, and form submission events.' });

  if (!parsed.hasAdsConversion) {
    if (parsed.hasRemarketingOnly)
      findings.push({ category: 'tracking', severity: 'medium', title: 'Remarketing tag found but no conversion event', detail: 'You can build remarketing audiences but cannot measure which ads are driving conversions. Smart Bidding cannot optimise toward a goal.', fix: 'Add a Google Ads conversion tag for your primary goal (form submission, phone call, or purchase) via GTM.' });
    else
      findings.push({ category: 'tracking', severity: 'critical', title: 'No Google Ads conversion tag found', detail: 'You are spending money on ads with zero ability to measure whether they work. Smart Bidding is also optimising blind — it has no conversion signal to learn from.', fix: 'Install a Google Ads conversion tag via GTM for your primary conversion goal. This is the single highest-priority fix on this page.' });
  }

  // ── Landing page experience ────────────────────────────────────────────────
  if (!parsed.h1)
    findings.push({ category: 'landing_page_experience', severity: 'critical', title: 'No H1 tag', detail: "Google's crawler gives weight to H1 text for relevance scoring. No H1 means no primary relevance signal — this is a direct Quality Score input missing.", fix: "Add a clear H1 that contains your primary target keyword. It should be the first prominent heading a visitor sees." });

  if (!parsed.hasPrivacyLink)
    findings.push({ category: 'trust_signals', severity: 'medium', title: 'No privacy policy link found', detail: 'No privacy policy link detected. Beyond GDPR compliance, its absence reduces trust for paid traffic — users who click ads are evaluating credibility before converting.', fix: 'Add a privacy policy page and link to it from the footer. One line is enough.' });

  // ── Conversion architecture ────────────────────────────────────────────────
  if (parsed.linkCount > 20)
    findings.push({ category: 'conversion_architecture', severity: 'high', title: `High attention ratio — ${parsed.linkCount} links compete with CTA`, detail: `${parsed.linkCount} clickable links dilute focus from the primary CTA. On a paid traffic landing page, every link that isn't the CTA is a potential exit.`, fix: 'Remove navigation and non-essential internal links. A dedicated landing page should have one exit: the conversion action.' });
  else if (parsed.linkCount > 10)
    findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.linkCount} links competing with primary CTA`, detail: `${parsed.linkCount} links on this page create distraction. Aim for a 5:1 or better link-to-CTA ratio for paid traffic landing pages.`, fix: 'Remove top navigation and reduce internal links to only those that support the conversion goal.' });

  if (parsed.formFieldCount >= 7)
    findings.push({ category: 'conversion_architecture', severity: 'high', title: `${parsed.formFieldCount}-field form is a significant barrier`, detail: `A ${parsed.formFieldCount}-field form has a high abandonment rate for paid traffic. Each additional field reduces completion rate.`, fix: 'Cut to 3 fields maximum. Collect additional information after the first conversion event.' });
  else if (parsed.formFieldCount >= 4)
    findings.push({ category: 'conversion_architecture', severity: 'medium', title: `${parsed.formFieldCount}-field form has friction`, detail: `A ${parsed.formFieldCount}-field form is above optimal for paid traffic conversion. Is every field essential at this stage?`, fix: 'Review each field. If it can be collected later in the process, remove it from this form.' });

  // ── Merge Claude content findings ──────────────────────────────────────────
  const claudeFindings = (claude.findings || []).filter(f => f.severity && f.title && f.detail && f.fix);
  findings.push(...claudeFindings);

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 100;
  let criticalCount = 0;
  const hasNoConversionTag = !parsed.hasAdsConversion;

  for (const f of findings) {
    if      (f.severity === 'critical') { score -= 20; criticalCount++; }
    else if (f.severity === 'high')     score -= 10;
    else if (f.severity === 'medium')   score -= 5;
    else if (f.severity === 'low')      score -= 2;
  }

  if      (criticalCount >= 2)  score = Math.min(score, 45);
  else if (criticalCount >= 1)  score = Math.min(score, 65);
  if      (hasNoConversionTag)  score = Math.min(score, 65);
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
        h1:                   parsed.h1 || null,
        title:                parsed.title || null,
        meta_description:     parsed.metaDescription || null,
        h1_contains_keyword:  claude.h1_contains_keyword ?? null,
        title_h1_aligned:     claude.title_h1_aligned ?? null,
        above_fold_signal:    claude.above_fold_keyword_signal || null,
        page_relevance:       claude.page_relevance_to_query || null,
        relevance_reason:     claude.relevance_reason || null
      },
      conversion_architecture: {
        has_cta:               parsed.hasAboveFoldCta,
        cta_text:              parsed.ctaText || null,
        cta_quality:           claude.cta_quality || null,
        cta_reason:            claude.cta_reason || null,
        link_count:            parsed.linkCount,
        form_fields:           parsed.formFieldCount,
        conversion_goal_clarity: claude.conversion_goal_clarity || null
      },
      trust_signals: {
        social_proof_quality:    claude.social_proof_quality || 'none',
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
