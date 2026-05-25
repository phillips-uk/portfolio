/**
 * creative-status.js
 * Netlify Function — polls for creative scoring job result from Netlify Blobs.
 *
 * GET /.netlify/functions/creative-status?id={jobId}
 *   Returns job state: pending / progress / done / error
 *
 * GET /.netlify/functions/creative-status?id={jobId}&download=md
 *   Returns the Markdown report as a downloadable attachment.
 *
 * Env vars: NETLIFY_SITE_ID, NETLIFY_PERSONAL_TOKEN
 */

'use strict';

const { getStore } = require('@netlify/blobs');

// ── Blob store ────────────────────────────────────────────────────────────────

function getJobStore() {
  return getStore({
    name:   'creative-jobs',
    siteID: process.env.NETLIFY_SITE_ID,
    token:  process.env.NETLIFY_PERSONAL_TOKEN
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const params   = event.queryStringParameters || {};
  const id       = params.id       || '';
  const download = params.download || '';

  // Validate jobId: lowercase alphanumeric + hyphens, 6–32 chars
  if (!/^[a-z0-9][a-z0-9-]{4,30}[a-z0-9]$/.test(id) && !/^[a-z0-9]{6,32}$/.test(id)) {
    return json({ error: 'Invalid job ID' }, 400);
  }

  let data;
  try {
    const store = getJobStore();
    data = await store.get(id, { type: 'json' });
  } catch (e) {
    console.error('[creative-status] blob read error:', e.message);
    return json({ status: 'pending' });
  }

  if (!data) {
    return json({ status: 'pending' });
  }

  // Download mode — return Markdown report as attachment
  if (download === 'md') {
    if (data.status !== 'done' || !data.report_md) {
      return json({ error: 'Report not available yet' }, 404);
    }

    const safeId = id.replace(/[^a-z0-9-]/g, '');
    return {
      statusCode: 200,
      headers: {
        'Content-Type':              'text/markdown; charset=utf-8',
        'Content-Disposition':       `attachment; filename="creative-report-${safeId}.md"`,
        'Cache-Control':             'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body: data.report_md
    };
  }

  // Normal polling response — return full state
  // Strip report_md from polling response (large; only needed for download)
  const response = Object.assign({}, data);
  delete response.report_md;

  return json(response);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store'
    },
    body: JSON.stringify(obj)
  };
}
