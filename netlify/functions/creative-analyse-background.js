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

const SCORING_MODEL = 'claude-opus-4-5';
const MAX_FILES     = 20;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in base64 terms (actual file ~15 MB)
const TOKEN_TTL_MS  = 24 * 60 * 60 * 1000;

const DIMENSIONS = ['hook_quality', 'visual_hierarchy', 'copy_clarity', 'brand_consistency', 'fatigue_signals'];
const DIMENSION_LABELS = {
  hook_quality:       'Hook quality',
  visual_hierarchy:   'Visual hierarchy',
  copy_clarity:       'Copy clarity',
  brand_consistency:  'Brand consistency',
  fatigue_signals:    'Fatigue signals'
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

const SCORING_SYSTEM = `You are an expert paid media creative analyst. Your job is to score advertising creatives across five dimensions. You assess only what is visible in the supplied image.

DIMENSIONS — score each 1 to 10:

1. hook_quality
   Does this creative stop the scroll? Assess: pattern interrupt (unusual angle, motion blur, colour contrast, human face), emotional trigger (curiosity, desire, humour, urgency), immediate visual impact. A score of 1–3 = generic, forgettable. 7–10 = strong scroll-stop potential.

2. visual_hierarchy
   Is there a clear focal point? Is the reading order obvious without effort? Penalise competing elements, lack of contrast between subject and background, unclear where the eye should land first.

3. copy_clarity
   Can the message be understood in under two seconds? Penalise ambiguous headlines, missing or vague CTAs, copy that requires context to understand, too much text for the format. Award high scores when the value proposition is immediately legible.

4. brand_consistency
   Coherent colours, fonts, and tone consistent with a specific brand identity. A creative that could belong to any brand scores 1–4. Clear, consistent brand identity scores 7–10. Penalise mismatched palettes, inconsistent typography, or absence of any brand signals.

5. fatigue_signals
   Assess the ABSENCE of fatigued formats. High score = low fatigue risk. Penalise: plain white background product shots with no creative treatment, straight-to-camera UGC with no hook variant, generic blue/green CTA buttons with "Shop Now" or "Learn More", stock photography aesthetics, over-saturated lifestyle imagery. Award high scores to formats that feel fresh or less saturated in the category.

RESPONSE FORMAT — return only valid JSON, no markdown, no explanation outside the JSON:
{
  "hook_quality":      { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": "<null or specific issue if score <= 6>" },
  "visual_hierarchy":  { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": "<null or specific issue if score <= 6>" },
  "copy_clarity":      { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": "<null or specific issue if score <= 6>" },
  "brand_consistency": { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": "<null or specific issue if score <= 6>" },
  "fatigue_signals":   { "score": <1-10>, "rationale": "<one sentence>", "weak_signal": "<null or specific issue if score <= 6>" },
  "overall_notes": "<2-3 sentences: what works, the priority fix, one specific action>"
}`;

async function scoreCreative(client, file) {
  const isVideo = file.mediaType.startsWith('video/');

  // For video, we can only send the first frame (we receive it as an image from the background function).
  // The file.data is base64-encoded. We pass it as an image content block.
  // Supported image types for the Anthropic API: jpeg, png, gif, webp
  let imageMediaType = file.mediaType;
  if (isVideo) {
    // Videos are received as extracted frames (JPEG) from the calling context.
    // If we receive raw video data, we inform the model we can't process it.
    imageMediaType = 'image/jpeg';
  }

  // Map mediaType to Anthropic-supported type
  const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const apiMediaType = supportedTypes.includes(imageMediaType)
    ? imageMediaType
    : 'image/jpeg';

  const message = await client.messages.create({
    model: SCORING_MODEL,
    max_tokens: 1024,
    system: SCORING_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: apiMediaType,
              data: file.data
            }
          },
          {
            type: 'text',
            text: 'Score this ad creative across all five dimensions. Return only valid JSON.'
          }
        ]
      }
    ]
  });

  const raw = message.content[0]?.text || '';
  // Strip any accidental markdown fences
  const clean = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
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

  let html = `<style>
    .cr-table { width:100%; border-collapse:collapse; font-size:13px; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif }
    .cr-table th { background:#985830; color:#fff; font-weight:600; padding:11px 14px; text-align:left; white-space:nowrap; font-size:12px; letter-spacing:0.02em }
    .cr-detail-header { background:#985830; color:#fff; padding:14px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif }
    .cr-weak { display:inline-block; background:#FFF3E0; border:1px solid #FF9800; color:#E65100; border-radius:3px; padding:1px 8px; font-size:11px; font-weight:600; margin-top:6px }
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
            const weakBadge = dim.weak_signal
              ? `<br><span class="cr-weak">${escHtml(dim.weak_signal)}</span>`
              : '';
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
  md += '| # | Creative | Score | Hook | Hierarchy | Copy | Brand | Fatigue |\n';
  md += '|---|----------|-------|------|-----------|------|-------|--------|\n';
  sorted.forEach(function(f, i) {
    const r = f.result;
    const scores = DIMENSIONS.map(function(d) { return r[d] ? r[d].score : 0; });
    md += `| ${i+1} | ${f.name} | **${f.composite}** | ${scores[0]} | ${scores[1]} | ${scores[2]} | ${scores[3]} | ${scores[4]} |\n`;
  });

  md += '\n---\n\n## Detail\n\n';

  sorted.forEach(function(f) {
    const r = f.result;
    md += `### ${f.name}  \nComposite: **${f.composite} / 10**\n\n`;
    DIMENSIONS.forEach(function(d) {
      const dim = r[d] || {};
      const score = dim.score || 0;
      md += `**${DIMENSION_LABELS[d]}** — ${score}/10  \n${dim.rationale || ''}`;
      if (dim.weak_signal) md += `  \n> Weak signal: ${dim.weak_signal}`;
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
            hook_quality:      { score: 0, rationale: 'File too large to process.', weak_signal: null },
            visual_hierarchy:  { score: 0, rationale: 'File too large to process.', weak_signal: null },
            copy_clarity:      { score: 0, rationale: 'File too large to process.', weak_signal: null },
            brand_consistency: { score: 0, rationale: 'File too large to process.', weak_signal: null },
            fatigue_signals:   { score: 0, rationale: 'File too large to process.', weak_signal: null },
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
          hook_quality:      { score: 0, rationale: 'Scoring failed: ' + e.message, weak_signal: null },
          visual_hierarchy:  { score: 0, rationale: 'Scoring failed.', weak_signal: null },
          copy_clarity:      { score: 0, rationale: 'Scoring failed.', weak_signal: null },
          brand_consistency: { score: 0, rationale: 'Scoring failed.', weak_signal: null },
          fatigue_signals:   { score: 0, rationale: 'Scoring failed.', weak_signal: null },
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
