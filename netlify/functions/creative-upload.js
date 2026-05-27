/**
 * creative-upload.js  —  Regular Netlify Function
 *
 * Accepts the full creative files payload, stores to Netlify Blobs,
 * and returns 200 so the frontend can then trigger the background scorer
 * with a tiny payload (just jobId + token).
 *
 * Background functions have a ~256KB body limit on this plan.
 * Regular functions accept up to 6MB — so we split the upload here.
 *
 * POST { jobId, token, files: [{ name, mediaType, data }] }
 * → 200 { ok: true }
 */

'use strict';

const crypto       = require('crypto');
const { getStore } = require('@netlify/blobs');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILES    = 20;

// Mirrors verifyToken() in creative-auth.js / creative-analyse-background.js
function verifyToken(token, pin, siteId) {
  if (!token || !pin || !siteId) return false;
  try {
    const decoded  = Buffer.from(token, 'base64url').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return false;
    const ts  = decoded.substring(0, colonIdx);
    const mac = decoded.substring(colonIdx + 1);

    const ts_num = parseInt(ts, 10);
    if (isNaN(ts_num) || Date.now() - ts_num > TOKEN_TTL_MS) return false;

    const expected = crypto
      .createHmac('sha256', pin + siteId)
      .update(ts)
      .digest('hex');

    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getJobStore() {
  return getStore({
    name:   'creative-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token:  process.env.NETLIFY_PERSONAL_TOKEN
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const { jobId, token, files } = body;

  if (!jobId || !token || !Array.isArray(files) || files.length === 0) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  if (!/^[a-z0-9]{6,32}$/.test(jobId)) {
    return { statusCode: 400, body: 'Invalid jobId format' };
  }

  const pin    = process.env.CREATIVE_UPLOAD_PIN;
  const siteId = process.env.NETLIFY_SITE_ID || 'phillips';

  if (!verifyToken(token, pin, siteId)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const fileList = files.slice(0, MAX_FILES);

  try {
    const store = getJobStore();
    // Store files under a separate key so the background function can retrieve them
    await store.set(`${jobId}-files`, JSON.stringify(fileList));
    // Pre-create the job record so the status poller doesn't get "not found" briefly
    await store.set(jobId, JSON.stringify({ status: 'pending' }));
    console.log(`[creative-upload] stored ${fileList.length} files for job ${jobId}`);
    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body:       JSON.stringify({ ok: true })
    };
  } catch (e) {
    console.error('[creative-upload] blob storage error:', e.message);
    return { statusCode: 500, body: 'Storage error — please try again.' };
  }
};
