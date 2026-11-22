// Cookie choices (22 Nov 2026): the group standard (Phillips Group's phillips-group repo, src/worker.js), without
// advertising, because the GTM container (GTM-WS5CP6NW, version 12) fires Google Analytics only.
// Every HTML page that loads Google gets, as the first thing in its <head> (so before any container or gtag.js):
// 1. CONSENT_HEAD, an inline script that reads the ph_consent cookie ("<statistics 0|1>.<wording version>") and sets
//    Google Consent Mode defaults: statistics on unless the visitor turned them off, advertising always denied. With
//    statistics off, GA4 is switched off altogether (ga-disable).
// 2. CONSENT_TAG, /consent.js: the banner, Cookie settings (the footer link) and the call to /api/consent.
// If advertising tags are ever added to GTM, this needs the advertising choice from The Director's Office's version
// first (thedirectorsoffice repo, public/consent.js).
import { jsonResponse } from './tools-gate.js';

export const GA_ID = 'G-P8648KZWNP';
const COOKIE = 'ph_consent';

export const CONSENT_HEAD = `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}(function(){` +
  `var m=document.cookie.match(/(?:^|; )${COOKIE}=([^;]+)/),p=m?decodeURIComponent(m[1]).split("."):null;if(p&&p.length<2)p=null;` +
  `var s=!p||p[0]!=="0";window.phConsent={stats:s,chosen:!!p,version:p?p[1]:null};` +
  `if(!s)window["ga-disable-${GA_ID}"]=true;` +
  `gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:s?"granted":"denied"});` +
  `gtag("set","ads_data_redaction",true);})();</script>`;
export const CONSENT_TAG = `<script src="/consent.js?v=1" defer></script>`;

// POST /api/consent: sets the visitor's cookie choice from the server, so it lasts its 180 days in Safari too.
// Nothing is stored or logged.
export async function consentChoice(request, url) {
  if (request.method !== 'POST') return jsonResponse({ ok: false }, 405, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (origin) {
    let same = false;
    try { same = new URL(origin).host === url.host; } catch { /* not a URL */ }
    if (!same) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }
  let b;
  try { b = await request.json(); } catch { return jsonResponse({ ok: false, error: 'bad request' }, 400); }
  const wording = String((b && b.wording) || '');
  if (!b || typeof b.statistics !== 'boolean' || !/^[0-9a-z-]{1,20}$/.test(wording)) return jsonResponse({ ok: false, error: 'bad request' }, 400);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const cookie = `${COOKIE}=${b.statistics ? 1 : 0}.${wording}; Max-Age=15552000; Path=/; SameSite=Lax${secure}`;
  return jsonResponse({ ok: true, statistics: b.statistics }, 200, { 'Set-Cookie': cookie });
}
