/**
 * landing-audit-status.js
 * Netlify Function — polls for landing audit result stored in Netlify Blobs.
 *
 * GET /.netlify/functions/landing-audit-status?id={jobId}
 *
 * Returns:
 *   { status: 'pending' }               — still running
 *   { status: 'complete', data: {...} } — audit complete
 *   { status: 'error', message: '...' } — audit failed
 */

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const id = (event.queryStringParameters || {}).id || '';

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return json({ error: 'Invalid job ID' }, 400);
  }

  try {
    const store = getStore({
      name:   'landing-audits',
      siteID: process.env.NETLIFY_SITE_ID,
      token:  process.env.NETLIFY_PERSONAL_TOKEN
    });
    const data  = await store.get(id, { type: 'json' });

    if (!data) return json({ status: 'pending' });

    return json(data);
  } catch (e) {
    console.error('Status error:', e.message);
    return json({ status: 'pending' });
  }
};

function json (data, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store'
    },
    body: JSON.stringify(data)
  };
}
