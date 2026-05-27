/**
 * creative-analyse-background.js
 * Netlify Background Function — scores ad creative files with Claude.
 *
 * POST { jobId, token, files: [{ name, mediaType, data }] }
 * Returns 202 immediately (Netlify handles this for background functions).
 * Result stored in Netlify Blobs under jobId in 'creative-jobs' store.
 * Frontend polls /.netlify/functions/creative-status?id={jobId}
 *
 * Env vars: ANTHROPIC_API_KEY, NETLIFY_SITE_ID, NETLIFY_PERSONAL_TOKEN,
 *           CREATIVE_UPLOAD_PIN
 */

'use strict';

const crypto    = require('crypto');
const { getStore } = require('@netlify/blobs');
const Anthropic    = require('@anthropic-ai/sdk');

// ── Constants ─────────────────────────────────────────────────────────────────

const SCORING_MODEL = 'claude-opus-4-7';
const MAX_FILES     = 20;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in base64 terms (actual file ~15 MB)
const TOKEN_TTL_MS  = 24 * 60 * 60 * 1000;

const DIMENSIONS = ['hook_quality', 'visual_hierarchy', 'copy_clarity', 'brand_consistency', 'fatigue_signals', 'offer_clarity'];
const DIMENSION_LABELS = {
  hook_quality:       'Hook quality',
  visual_hierarchy:   'Visual hierarchy',
  copy_clarity:       'Copy clarity',
  brand_consistency:  'Brand consistency',
  fatigue_signals:    'Originality & Fatigue',
  offer_clarity:      'Offer clarity'
};

// Frame-position labels override hook_quality and offer_clarity per frame type
const FRAME_DIMENSION_LABELS = {
  opening: { hook_quality: 'Hook quality',  offer_clarity: 'Offer clarity' },
  mid:     { hook_quality: 'Retention',     offer_clarity: 'Offer clarity' },
  close:   { hook_quality: 'CTA strength',  offer_clarity: 'Offer clarity' },
};

// ── Token verification ────────────────────────────────────────────────────────
// Mirrors makeToken() in creative-auth.js

function verifyToken(token, pin, siteId) {
  if (!token || !pin || !siteId) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return false;
    const ts  = decoded.substring(0, colonIdx);
    const mac = decoded.substring(colonIdx + 1);

    // Check expiry
    const ts_num = parseInt(ts, 10);
    if (isNaN(ts_num) || Date.now() - ts_num > TOKEN_TTL_MS) return false;

    // Recompute HMAC
    const expected = crypto
      .createHmac('sha256', pin + siteId)
      .update(ts)
      .digest('hex');

    // Constant-time compare
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Blob store ────────────────────────────────────────────────────────────────

function getJobStore() {
  return getStore({
    name:   'creative-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token:  process.env.NETLIFY_PERSONAL_TOKEN
  });
}

// ── Claude scoring ────────────────────────────────────────────────────────────

const SCORING_SYSTEM = `You are an expert paid media creative analyst. Your job is to score advertising creatives across six dimensions. You assess only what is visible in the supplied image.

DIMENSIONS — score each 1 to 10:

1. hook_quality
   Interpretation depends on frame position — see the user message for context.
   For static images and non-video content: score on TWO combined factors — (a) pattern interrupt: does it stop the scroll via unusual composition, contrast, human face, or unexpected subject? and (b) emotional resonance: does it make the viewer feel something — curiosity, desire, humour, urgency, aspiration? A score of 8–10 requires both. A creative that interrupts without connecting emotionally caps at 6. A creative with emotional resonance but weak pattern interrupt caps at 7. Note in rationale which factor is limiting the score.

2. visual_hierarchy
   Is there a clear focal point? Is the reading order obvious without effort? Penalise competing elements, lack of contrast between subject and background, unclear where the eye should land first.

3. copy_clarity
   Can the message be understood in under two seconds? Penalise ambiguous headlines, missing or vague CTAs, copy that requires context to understand, too much text for the format. Award high scores when the value proposition is immediately legible. For video frames, see the user message for sound-off legibility context.

4. brand_consistency
   Coherent colours, fonts, and tone consistent with a specific brand identity. A creative that could belong to any brand scores 1–4. Clear, consistent brand identity scores 7–10. Penalise mismatched palettes, inconsistent typography, or absence of any brand signals.

5. fatigue_signals
   Score HIGH for original, fresh formats. Score LOW for saturated, overused formats. Penalise: plain white background product shots with no creative treatment, straight-to-camera UGC with no hook variant, generic "Shop Now" / "Learn More" CTAs, stock photography aesthetics, formats saturated 12+ months ago. Award high scores to formats that feel genuinely fresh or novel in the category.

6. offer_clarity
   Interpretation depends on frame position — see the user message for context.

IMPACT TIERS — for any dimension scoring 6 or below, classify the fix priority:
  "critical"  — core element missing or broken; fix before running this creative
  "high"      — significant drag on performance; fix before scaling spend
  "quick_win" — addressable in the next iteration with a small change (reword CTA, reposition element, swap background)

RESPONSE FORMAT — return only valid JSON, no markdown, no explanation outside the JSON:
{
  "hook_quality":      { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "visual_hierarchy":  { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "copy_clarity":      { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "brand_consistency": { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "fatigue_signals":   { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "offer_clarity":     { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": <null or "specific issue">, "impact": <null or "critical"|"high"|"quick_win"> },
  "overall_notes": "<2-3 sentences: what works, the priority fix, one specific action>"
}`;

// Frame-specific scoring context injected into the user message
const FRAME_SCORING_CONTEXT = {
  opening: `This is the OPENING FRAME of a video ad (first ~33% of the video).

Frame-specific dimension interpretations:
- hook_quality (PRIMARY for this frame): Assess TWO factors combined:
  1. Pattern interrupt — does this frame stop the scroll? Unusual angle, motion blur, colour contrast, human face/emotion, unexpected subject matter.
  2. Emotional resonance — does it make the viewer feel something? Curiosity, desire, humour, urgency, belonging, aspiration. A creative can interrupt without connecting.
  Score 8–10 if strong on both. Score 5–7 if strong on one but weak on the other — note in rationale which is limiting. Score 1–4 if weak on both.
- copy_clarity (sound-off legibility): In addition to standard copy clarity, assess whether the message lands with audio muted. Score 8–10 if captions, overlaid text, or visual-only storytelling fully communicates the message without sound. Score 4–6 if the viewer gets the gist but would miss nuance. Score 1–3 if the frame only makes sense with audio (voiceover-dependent, uncontextualised dialogue, no supporting text). Flag absence of captions or text support as a weak signal.
- offer_clarity: Score 7 if no explicit offer is shown — the opening frame's job is to hook attention, not sell. Only penalise (below 7) if a clumsy or confusing offer attempt actively undermines the hook. Do not flag absence of an offer as a weak signal on an opening frame.`,

  mid: `This is the MID FRAME of a video ad (~33–66% of video duration).

Frame-specific dimension interpretations:
- hook_quality (measures RETENTION for this frame, not scroll-stopping): Does this frame hold attention and develop the story? Does it build towards the offer or maintain viewer momentum? Score high if the narrative is progressing and the viewer has a clear reason to keep watching. Score low if the frame feels flat, repetitive, or like the viewer would drop off here.
- copy_clarity (sound-off legibility): Assess whether the narrative is still followable with audio muted. Score 8–10 if on-screen text, captions, or clear visual action fully carries the story. Score 4–6 if the visual content is plausible but context-dependent. Score 1–3 if the frame is completely reliant on voiceover or dialogue to make sense — a viewer watching without audio would be lost. Flag as a weak signal if no text or captioning supports the mid-section.
- offer_clarity: Partially relevant. Score moderately (5–7) if the value proposition is beginning to emerge or be hinted at. Only penalise below 5 if the mid-frame is actively confusing or contradicts the hook.`,

  close: `This is the CLOSING FRAME of a video ad (final ~33% of the video).

Frame-specific dimension interpretations:
- hook_quality (measures CTA STRENGTH for this frame): Is there a clear, compelling call-to-action? Does this frame convert? Score high (8–10) for a specific, urgent CTA with clear next steps. Score low (1–4) for a weak, generic, or absent CTA. "Shop Now" with no offer context scores no higher than 4.
- copy_clarity (sound-off legibility): The closing frame must be fully legible without audio — this is when the viewer needs to act. Score 8–10 if the CTA, offer, and next step are entirely carried by on-screen text or visuals. Score 4–6 if the CTA is visible but offer context is missing without audio. Score 1–3 if the call-to-action only makes sense with voiceover. No captions on a closing frame is a critical weak signal — flag it.
- offer_clarity (PRIMARY for this frame): The specific offer must be completely clear by the close. Penalise heavily if the price, discount, outcome, or benefit is not immediately obvious. A closing frame with no discernible offer is a critical failure.`
};

// Detect whether a filename is a video frame and return its position
function detectFrameType(filename) {
  const m = (filename || '').match(/_(opening|mid|close)\.(jpg|jpeg|png)$/i);
  if (!m) return null;
  return m[1].toLowerCase(); // 'opening' | 'mid' | 'close'
}

async function scoreCreative(client, file) {
  const isVideo = file.mediaType.startsWith('video/');
  let imageMediaType = file.mediaType;
  if (isVideo) imageMediaType = 'image/jpeg';

  const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const apiMediaType = supportedTypes.includes(imageMediaType) ? imageMediaType : 'image/jpeg';

  // Build frame-aware user prompt
  const frameType = detectFrameType(file.name);
  const frameContext = frameType ? FRAME_SCORING_CONTEXT[frameType] : null;

  const userText = frameContext
    ? `${frameContext}\n\nScore this frame across all six dimensions using the frame-specific interpretations above. Return only valid JSON.`
    : 'Score this ad creative across all six dimensions. Return only valid JSON.';

  const message = await client.messages.create({
    model: SCORING_MODEL,
    max_tokens: 2048,
    system: SCORING_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: apiMediaType, data: file.data }
          },
          { type: 'text', text: userText }
        ]
      }
    ]
  });

  const raw = message.content[0]?.text || '';
  const clean = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const result = JSON.parse(clean);

  // Attach frameType so the frontend can show contextual labels
  result._frameType = frameType || null;
  return result;
}

// ── Composite score ───────────────────────────────────────────────────────────

function compositeScore(result) {
  const scores = DIMENSIONS.map(d => (result[d] && typeof result[d].score === 'number') ? result[d].score : 0);
  const sum = scores.reduce(function(a, b) { return a + b; }, 0);
  return Math.round((sum / DIMENSIONS.length) * 10) / 10;
}

// ── Score colour ──────────────────────────────────────────────────────────────

function scoreClass(score) {
  if (score >= 7) return 'green';
  if (score >= 5) return 'amber';
  return 'red';
}

// ── HTML report builder ───────────────────────────────────────────────────────

function buildReportHtml(scoredFiles) {
  const sorted = scoredFiles.slice().sort(function(a, b) { return b.composite - a.composite; });

  const badgeStyle = {
    green: 'background:#E8F5E9;color:#2E7D32;',
    amber: 'background:#FFF3E0;color:#E65100;',
    red:   'background:#FFEBEE;color:#C62828;'
  };

  const barColour = {
    green: '#4CAF50',
    amber: '#FF9800',
    red:   '#F44336'
  };

  function dimBar(score) {
    const cls = scoreClass(score);
    return `<div style="height:6px;background:#E8D8C4;border-radius:3px;overflow:hidden;width:40px;margin:4px auto 0">` +
      `<div style="height:100%;width:${score * 10}%;background:${barColour[cls]};border-radius:3px"></div></div>`;
  }

  function scoreBadge(score) {
    const cls = scoreClass(score);
    return `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:38px;padding:3px 8px;border-radius:4px;font-weight:700;font-size:13px;${badgeStyle[cls]}">${score}</span>`;
  }

  // Ranked summary table
  let tableRows = '';
  sorted.forEach(function(f, i) {
    const r = f.result;
    tableRows += `<tr>
      <td style="padding:11px 14px;border-bottom:1px solid #E8D8C4;background:${i % 2 === 1 ? '#FDF6EE' : '#fff'}">${i + 1}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #E8D8C4;background:${i % 2 === 1 ? '#FDF6EE' : '#fff'};font-weight:500;font-size:12px;max-width:200px;word-break:break-all">${escHtml(f.name)}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #E8D8C4;background:${i % 2 === 1 ? '#FDF6EE' : '#fff'}">${scoreBadge(f.composite)}</td>
      ${DIMENSIONS.map(function(d) {
        const s = r[d] ? r[d].score : 0;
        return `<td style="padding:11px 14px;border-bottom:1px solid #E8D8C4;background:${i % 2 === 1 ? '#FDF6EE' : '#fff'};text-align:center">
          <span style="font-size:13px;font-weight:600;color:#1A1A1A;display:block">${s}</span>${dimBar(s)}</td>`;
      }).join('')}
    </tr>`;
  });

  function impactBadge(weakSignal, impact) {
    if (!weakSignal) return '';
    const styles = {
      critical:  'background:#FFEBEE;border:1px solid #EF9A9A;color:#B71C1C;',
      high:      'background:#FFF3E0;border:1px solid #FF9800;color:#E65100;',
      quick_win: 'background:#E8F4FD;border:1px solid #90CAF9;color:#1565C0;'
    };
    const labels = { critical: 'CRITICAL', high: 'HIGH', quick_win: 'QUICK WIN' };
    const style = styles[impact] || styles.high;
    const lbl   = labels[impact] || '';
    const prefix = lbl
      ? `<strong style="font-size:9px;letter-spacing:0.05em;margin-right:4px;">${lbl}</strong>`
      : '';
    return `<br><span style="display:inline-block;${style}border-radius:4px;padding:2px 8px;font-size:11px;margin-top:6px;">${prefix}${escHtml(weakSignal)}</span>`;
  }

  let html = `<style>
    .cr-table { width:100%; border-collapse:collapse; font-size:13px; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif }
    .cr-table th { background:#985830; color:#fff; font-weight:600; padding:11px 14px; text-align:left; white-space:nowrap; font-size:12px; letter-spacing:0.02em }
    .cr-detail-header { background:#985830; color:#fff; padding:14px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif }
  </style>`;

  html += `<div style="overflow-x:auto;border-radius:8px;border:1px solid #E8D8C4;box-shadow:0 1px 4px rgba(152,88,48,0.08);margin-bottom:32px">
    <table class="cr-table">
      <thead><tr>
        <th>#</th><th>Creative</th><th>Score</th>
        ${DIMENSIONS.map(function(d) { return `<th>${DIMENSION_LABELS[d]}</th>`; }).join('')}
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>`;

  // Detail cards
  sorted.forEach(function(f) {
    const r = f.result;
    html += `<div style="border:1px solid #E8D8C4;border-radius:8px;overflow:hidden;margin-bottom:24px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
      <div class="cr-detail-header">
        <span style="font-size:14px;font-weight:600;word-break:break-all">${escHtml(f.name)}</span>
        <span style="background:rgba(255,255,255,0.2);color:#fff;font-size:14px;font-weight:700;padding:4px 12px;border-radius:4px;white-space:nowrap">${f.composite} / 10</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="background:#FDF6EE;color:#6B6B6B;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:9px 16px;text-align:left;border-bottom:1px solid #E8D8C4">Dimension</th>
          <th style="background:#FDF6EE;color:#6B6B6B;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:9px 16px;text-align:left;border-bottom:1px solid #E8D8C4;width:60px">Score</th>
          <th style="background:#FDF6EE;color:#6B6B6B;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:9px 16px;text-align:left;border-bottom:1px solid #E8D8C4">Rationale</th>
        </tr></thead>
        <tbody>
          ${DIMENSIONS.map(function(d) {
            const dim = r[d] || {};
            const score = dim.score || 0;
            const cls   = scoreClass(score);
            const weakBadge = impactBadge(dim.weak_signal, dim.impact);
            return `<tr>
              <td style="padding:12px 16px;border-bottom:1px solid #E8D8C4;font-weight:600;color:#985830;font-size:12px;white-space:nowrap;width:140px">${DIMENSION_LABELS[d]}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #E8D8C4;text-align:center">${scoreBadge(score)}</td>
              <td style="padding:12px 16px;border-bottom:1px solid #E8D8C4;color:#1A1A1A;font-size:13px;line-height:1.5">${escHtml(dim.rationale || '')}${weakBadge}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div style="background:#FDF6EE;padding:16px 20px;border-top:1px solid #E8D8C4;font-size:13px;color:#1A1A1A;line-height:1.6">
        <strong style="color:#985830;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;display:block;margin-bottom:6px">Overall notes</strong>
        ${escHtml(r.overall_notes || '')}
      </div>
    </div>`;
  });

  return html;
}

// ── Markdown report builder ───────────────────────────────────────────────────

function buildReportMd(scoredFiles) {
  const sorted = scoredFiles.slice().sort(function(a, b) { return b.composite - a.composite; });

  let md = '# Ad Creative Scoring Report\n\n';
  md += `Generated: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC\n\n`;

  md += '## Ranked Summary\n\n';
  md += '| # | Creative | Score | Hook | Hierarchy | Copy | Brand | Originality | Offer |\n';
  md += '|---|----------|-------|------|-----------|------|-------|-------------|-------|\n';
  sorted.forEach(function(f, i) {
    const r = f.result;
    const scores = DIMENSIONS.map(function(d) { return r[d] ? r[d].score : 0; });
    md += `| ${i+1} | ${f.name} | **${f.composite}** | ${scores[0]} | ${scores[1]} | ${scores[2]} | ${scores[3]} | ${scores[4]} | ${scores[5]} |\n`;
  });

  md += '\n---\n\n## Detail\n\n';

  sorted.forEach(function(f) {
    const r = f.result;
    md += `### ${f.name}  \nComposite: **${f.composite} / 10**\n\n`;
    DIMENSIONS.forEach(function(d) {
      const dim = r[d] || {};
      const score = dim.score || 0;
      md += `**${DIMENSION_LABELS[d]}** — ${score}/10  \n${dim.rationale || ''}`;
      if (dim.weak_signal) {
        const impactLabel = dim.impact ? ` [${dim.impact.toUpperCase().replace('_', ' ')}]` : '';
        md += `  \n> Weak signal${impactLabel}: ${dim.weak_signal}`;
      }
      md += '\n\n';
    });
    md += `**Overall notes**  \n${r.overall_notes || ''}\n\n---\n\n`;
  });

  return md;
}

// ── Escape helper ─────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return;

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return;
  }

  const { jobId, token, files } = body;
  if (!jobId || !token || !Array.isArray(files) || files.length === 0) return;

  // Validate jobId format
  if (!/^[a-z0-9]{6,32}$/.test(jobId)) return;

  // Verify token
  const pin    = process.env.CREATIVE_UPLOAD_PIN;
  const siteId = process.env.NETLIFY_SITE_ID || 'phillips';

  if (!verifyToken(token, pin, siteId)) {
    console.error('[creative-analyse] token verification failed for job', jobId);
    return;
  }

  // Clamp files
  const fileList = files.slice(0, MAX_FILES);

  // Init blob store and mark job as pending
  let store;
  try {
    store = getJobStore();
    await store.set(jobId, JSON.stringify({ status: 'pending' }));
  } catch (e) {
    console.error('[creative-analyse] blob init error:', e.message);
    return;
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const scoredFiles = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const progressPct = Math.round(((i + 0.5) / fileList.length) * 90);

      // Update progress
      await store.set(jobId, JSON.stringify({
        status:  'progress',
        percent: progressPct,
        done:    i,
        total:   fileList.length,
        message: `Scoring ${escHtml(file.name)} (${i + 1} of ${fileList.length})...`
      }));

      console.log(`[creative-analyse] scoring ${file.name} (${i + 1}/${fileList.length})`);

      // Validate file size (base64 length)
      if (file.data && file.data.length > MAX_FILE_SIZE * 1.37) { // base64 overhead
        console.warn(`[creative-analyse] ${file.name} too large, skipping`);
        scoredFiles.push({
          name:      file.name,
          composite: 0,
          result:    {
            hook_quality:      { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            visual_hierarchy:  { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            copy_clarity:      { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            brand_consistency: { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            fatigue_signals:   { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            offer_clarity:     { score: 0, rationale: 'File too large to process.', weak_signal: null, impact: null },
            overall_notes:     'This file exceeded the 20 MB size limit and could not be scored.'
          }
        });
        continue;
      }

      let result;
      try {
        result = await scoreCreative(client, file);
      } catch (e) {
        console.error(`[creative-analyse] scoring error for ${file.name}:`, e.message);
        result = {
          hook_quality:      { score: 0, rationale: 'Scoring failed: ' + e.message, weak_signal: null, impact: null },
          visual_hierarchy:  { score: 0, rationale: 'Scoring failed.', weak_signal: null, impact: null },
          copy_clarity:      { score: 0, rationale: 'Scoring failed.', weak_signal: null, impact: null },
          brand_consistency: { score: 0, rationale: 'Scoring failed.', weak_signal: null, impact: null },
          fatigue_signals:   { score: 0, rationale: 'Scoring failed.', weak_signal: null, impact: null },
          offer_clarity:     { score: 0, rationale: 'Scoring failed.', weak_signal: null, impact: null },
          overall_notes:     'An error occurred while scoring this creative. Please try again.'
        };
      }

      const composite = compositeScore(result);
      scoredFiles.push({ name: file.name, composite, result });

      console.log(`[creative-analyse] ${file.name} scored: ${composite}`);
    }

    // Build report
    const report_html = buildReportHtml(scoredFiles);
    const report_md   = buildReportMd(scoredFiles);

    await store.set(jobId, JSON.stringify({
      status:      'done',
      results:     scoredFiles,
      report_html: report_html,
      report_md:   report_md
    }));

    console.log(`[creative-analyse] job ${jobId} complete — ${scoredFiles.length} creatives scored`);

  } catch (e) {
    console.error('[creative-analyse] unexpected error:', e.message, e.stack);
    try {
      await store.set(jobId, JSON.stringify({
        status:  'error',
        message: 'Scoring failed unexpectedly. Please try again.'
      }));
    } catch (writeErr) {
      console.error('[creative-analyse] failed to write error state:', writeErr.message);
    }
  }
};
