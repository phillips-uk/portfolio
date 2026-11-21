// Landing page status check for the Google Ads Check (21 Nov 2026). Each distinct final URL in the account's ads and
// Performance Max asset groups gets one GET, capped at MAX pages, a few at a time, each with a timeout. Only the status
// is kept; the page itself is never read or stored. Nothing here touches the Google Ads account.
//
// What counts as broken: 404 and 410 (gone), 5xx (server error), or no answer at all (DNS or connection failure).
// 401, 403 and 429 mean the site turned an automated visitor away, which says nothing about real visitors, so those
// are "not checked". A timeout is noted but not called broken: one slow answer from here is not proof.

export const MAX = 20;
const TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; PhillipsAdsCheck/1.0; +https://www.phillips-uk.com/google-ads-audit)';

// Distinct pages (query strings and fragments ignored), most used first, from the raw query rows.
export function landingPages(data) {
  const count = new Map();
  const add = (u) => {
    let url;
    try { url = new URL(String(u)); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname) || url.hostname.endsWith('.local')) return;
    const key = url.origin + url.pathname;
    count.set(key, (count.get(key) || 0) + 1);
  };
  for (const r of data.ads || []) for (const u of r.adGroupAd?.ad?.finalUrls || []) add(u);
  for (const r of data.assetGroups || []) for (const u of r.assetGroup?.finalUrls || []) add(u);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([url, ads]) => ({ url, ads }));
}

async function one(url, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
    const s = res.status;
    const state = s === 404 || s === 410 || s >= 500 ? 'broken' : s === 401 || s === 403 || s === 429 ? 'blocked' : s >= 400 ? 'blocked' : 'ok';
    return { status: s, state };
  } catch (err) {
    return { status: 0, state: ctl.signal.aborted ? 'timeout' : 'broken', error: ctl.signal.aborted ? 'timeout' : 'no answer' };
  } finally {
    clearTimeout(timer);
  }
}

// [{ url, ads, status, state }] for up to MAX pages, plus how many were left out. fetchImpl is injectable for tests.
export async function checkUrls(data, fetchImpl = fetch) {
  const pages = landingPages(data);
  const list = pages.slice(0, MAX);
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = { ...list[i], ...(await one(list[i].url, fetchImpl)) };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return { pages: out, total: pages.length, skipped: Math.max(0, pages.length - list.length) };
}
