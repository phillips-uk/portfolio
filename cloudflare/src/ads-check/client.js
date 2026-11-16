// Google Ads API over REST for the Google Ads Check, through the Phillips. manager account (495-618-4074).
// Reads only, plus the two link changes the manager-link route needs: accept the visitor's invitation, then end the
// link once the read is done. Nothing in a visitor's account is ever changed.
//
// Worker secrets (none of them are in the repo; never log them):
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN   an OAuth client and a refresh token for a
//                                                                             login that can use the manager account
//   GOOGLE_ADS_DEVELOPER_TOKEN (optional)       since Sep 2026 API access sits on the Cloud project that owns the client
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (optional)     defaults to the Phillips. manager account
//   GOOGLE_ADS_API_VERSION (optional)           defaults to v24, as Search Desk uses
// When the "Phillips. Tools" Cloud project exists, its OAuth client and refresh token replace the first three.

export const MANAGER_ID = '4956184074';
export const MANAGER_ID_SHOWN = '495-618-4074';

export class AdsError extends Error {
  constructor(message, kind = 'api', status = 0, code = '') { super(message); this.kind = kind; this.status = status; this.code = code; }
}

const version = env => env.GOOGLE_ADS_API_VERSION || 'v24';
const manager = env => String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || MANAGER_ID).replace(/\D/g, '');

export function configured(env) {
  return !!(env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET && env.GOOGLE_ADS_REFRESH_TOKEN);
}

let cached = { token: null, exp: 0 };
async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60e3) return cached.token;
  if (!configured(env)) throw new AdsError('The Google Ads connection is not set up yet.', 'setup');
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_ADS_CLIENT_ID, client_secret: env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    if (res.ok || (res.status !== 429 && res.status < 500)) break;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1) ** 2));
  }
  if (!res.ok) throw new AdsError(`Google refused the API sign-in (HTTP ${res.status}).`, 'auth', res.status);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return cached.token;
}

function errorOf(body) {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? (j.find(x => x.error) || {}).error : j.error;
    if (!e) return null;
    const errs = (e.details || []).flatMap(d => d.errors || []);
    const msg = errs.map(x => x.message).filter(Boolean)[0];
    const code = errs.map(x => Object.values(x.errorCode || {})[0]).filter(Boolean)[0] || '';
    return { text: (msg || e.message || 'Google Ads API error').slice(0, 300), code: String(code) };
  } catch { return null; }
}

// Every call is counted, so a report can say how many operations it used (Explorer allows 2,880 a day).
export function meter() { return { ops: 0 }; }

async function call(env, m, path, body, login) {
  const headers = { Authorization: 'Bearer ' + await accessToken(env), 'Content-Type': 'application/json', 'login-customer-id': login || manager(env) };
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN) headers['developer-token'] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  let res, text;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (m) m.ops++;
    res = await fetch(`https://googleads.googleapis.com/${version(env)}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    text = await res.text();
    if (res.status !== 429 && res.status < 500) break;
    await new Promise(r => setTimeout(r, 800 * (attempt + 1) ** 2));
  }
  if (!res.ok) {
    const e = errorOf(text);
    throw new AdsError((e && e.text) || `Google Ads API error (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? 'auth' : 'api', res.status, e && e.code);
  }
  return text;
}

// Runs a GAQL query on one account and returns every row (REST JSON: camelCase, micros as strings).
export async function gaql(env, m, customerId, query) {
  if (!/^\d{10}$/.test(String(customerId))) throw new AdsError('Bad customer ID', 'input');
  const text = await call(env, m, `customers/${customerId}/googleAds:searchStream`, { query });
  const batches = text.trim() ? JSON.parse(text) : [];
  const failed = Array.isArray(batches) && batches.find(b => b.error);
  if (failed) { const e = errorOf(text); throw new AdsError((e && e.text) || 'Google Ads API error', 'api', 0, e && e.code); }
  return (Array.isArray(batches) ? batches : [batches]).flatMap(b => b.results || []);
}

// The link between this account and the Phillips. manager account, as the manager sees it: PENDING when the visitor has
// sent the invitation, ACTIVE when linked. { status, managerLinkId } or null.
export async function linkStatus(env, m, customerId) {
  const rows = await gaql(env, m, manager(env), `SELECT customer_client_link.client_customer, customer_client_link.manager_link_id, customer_client_link.status FROM customer_client_link WHERE customer_client_link.client_customer = 'customers/${customerId}'`);
  const order = { ACTIVE: 0, PENDING: 1 };
  const live = rows.map(r => r.customerClientLink).filter(l => l && (l.status === 'ACTIVE' || l.status === 'PENDING')).sort((a, b) => order[a.status] - order[b.status]);
  return live.length ? { status: live[0].status, managerLinkId: String(live[0].managerLinkId) } : null;
}

// Accepts the visitor's invitation. The manager's side of the link is a CustomerClientLink; if Google wants the
// client's side instead (a CustomerManagerLink, reachable once the manager is invited), that is tried second.
export async function acceptLink(env, m, customerId, managerLinkId) {
  const mgr = manager(env);
  try {
    await call(env, m, `customers/${mgr}/customerClientLinks:mutate`, {
      operation: { update: { resourceName: `customers/${mgr}/customerClientLinks/${customerId}~${managerLinkId}`, status: 'ACTIVE' }, updateMask: 'status' },
    });
    return 'client-link';
  } catch (first) {
    try {
      await call(env, m, `customers/${customerId}/customerManagerLinks:mutate`, {
        operations: [{ update: { resourceName: `customers/${customerId}/customerManagerLinks/${mgr}~${managerLinkId}`, status: 'ACTIVE' }, updateMask: 'status' }],
      });
      return 'manager-link';
    } catch (second) {
      console.error('ads-check: accept failed', first.code || first.message, '|', second.code || second.message);
      throw new AdsError('I couldn’t accept the invitation. Please check it was sent to ' + MANAGER_ID_SHOWN + ' and try again.', 'link');
    }
  }
}

// Ends the link once the read is done (the manager can end it from the client's side once linked). Best effort, and
// logged if it fails so Lewis can remove it by hand.
export async function endLink(env, m, customerId, managerLinkId) {
  const mgr = manager(env);
  try {
    await call(env, m, `customers/${customerId}/customerManagerLinks:mutate`, {
      operations: [{ update: { resourceName: `customers/${customerId}/customerManagerLinks/${mgr}~${managerLinkId}`, status: 'INACTIVE' }, updateMask: 'status' }],
    });
    return true;
  } catch (err) {
    console.error('ads-check: UNLINK FAILED, remove by hand', customerId, err.code || err.message);
    return false;
  }
}
