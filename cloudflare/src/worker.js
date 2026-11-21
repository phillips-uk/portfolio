// Cloudflare Worker entry for phillips-uk.com. Serves the static site from Workers Assets and runs the existing
// netlify/functions/*.js handlers unchanged through the adapter (same approach as Before You Pay).
import { toEvent, fromResult } from './netlify-adapter.js';
import { isRateCardPath, rateCard, invitePing } from './rate-card.js';
import { isMonumentDataPath, monumentData } from './monument-data.js';
import { isSupplierCheckPath, supplierCheck } from './supplier-check.js';
import { isAdminPath, admin } from './admin.js';
import { enquiry } from './enquiry.js';
import { toolAccess } from './tool-access.js';
import { isBriefPath, brief, sitemapWithIssues, withLatestIssue, scheduled as briefScheduled } from './brief.js';
import { isWebsiteCheckPath, websiteCheck, cleanupWebsiteChecks, setSelfHandler } from './website-check.js';
import { isAdsCheckPath, adsCheck, cleanupAdsChecks } from './google-ads-check.js';
import { isSignInPath, googleSignIn } from './google-signin.js';
import { cleanupToolRates } from './tools-gate.js';

const loaders = {
  'audit-share':                () => import('../../netlify/functions/audit-share.js'),
  'auth-callback':              () => import('../../netlify/functions/auth-callback.js'),
  'creative-analyse-background': () => import('../../netlify/functions/creative-analyse-background.js'),
  'creative-auth':              () => import('../../netlify/functions/creative-auth.js'),
  'creative-status':            () => import('../../netlify/functions/creative-status.js'),
  'creative-upload':            () => import('../../netlify/functions/creative-upload.js'),
  'get-report':                 () => import('../../netlify/functions/get-report.js'),
  'mcc-audit':                  () => import('../../netlify/functions/mcc-audit.js'),
  'mcc-check':                  () => import('../../netlify/functions/mcc-check.js'),
  'og-image':                   () => import('../../netlify/functions/og-image.js'),
  'trigger-audit':              () => import('../../netlify/functions/trigger-audit.js'),
};

// Netlify "background functions" (name ends in -background) return 202 at once and keep running.
// Here they go through the phillips-jobs queue, whose consumer may run for minutes.
const isBackground = name => name.endsWith('-background');

const CANONICAL_HOST = 'www.phillips-uk.com';

// Google Tag Manager on every public page, so a new page can never go untracked: any HTML page served from the site's
// files (or a /r/ share page) that does not already load the container gets it added on the way out. Pages that carry
// it already are left as they are. Invite pages (rate-card.js adds gtag.js itself), /admin and Search Desk (/desk)
// never come through here. Analytics notes: vault 01_Phillips/07_Analytics.
const GTM_ID = 'GTM-WS5CP6NW';
const GTM_HEAD = `<!-- Google Tag Manager (added by the Worker) --><script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');</script>`;
const GTM_BODY = `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;

function withGtm(res) {
  const type = res.headers.get('Content-Type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  let has = false;
  let tail = '';
  return new HTMLRewriter()
    .on('script', {
      element(el) { if ((el.getAttribute('src') || '').includes(GTM_ID)) has = true; },
      // Inline script text can arrive in pieces, so look across the joins too.
      text(t) { tail = (tail + t.text).slice(-64); if (tail.includes(GTM_ID)) has = true; if (t.lastInTextNode) tail = ''; },
    })
    .on('head', { element(el) { el.onEndTag(end => { if (!has) end.before(GTM_HEAD, { html: true }); }); } })
    .on('body', { element(el) { if (!has) el.prepend(GTM_BODY, { html: true }); } })
    .transform(res);
}

// Mirrors netlify.toml and _redirects.
const REDIRECTS = {
  '/audit': '/google-ads-audit',
  '/shopify-google-ads-audit': '/google-ads-audit?type=shopify',
  // The old CV (it carries Lewis's personal address) is no longer served (2026-11-16): the file stays in the repo but is
  // in .assetsignore, and old links land on /about/.
  '/lewis-phillips-cv.pdf': '/about/',
};

// Creative scoring was retired with the free tools' relaunch (16 Nov 2026); its pages stay in the repo. Since 20 Nov 2026
// its addresses redirect permanently to the free checks, so Google drops the old page from its index.
const PAUSED = {};

// The old tool addresses, since the relaunch (16 Nov 2026): permanent redirects to the Website Check and the Google Ads
// Check. The old .html files are redirected too, so the retired pages are never served.
const MOVED = {
  '/google-ads-audit-report': '/google-ads-audit',
  '/landing-page-audit': '/website-check/',
  '/landing-page-audit-report': '/website-check/',
  '/creative-analysis': '/free-checks/',
  '/creative-analysis-demo': '/free-checks/',
  '/creative-analysis-report': '/free-checks/',
  // Names people type or AI assistants guess for the free checks (20 Nov 2026)
  '/google-ads-check': '/google-ads-audit',
  '/free-google-ads-audit': '/google-ads-audit',
  '/google-ads-audit-tool': '/google-ads-audit',
  '/ppc-audit': '/google-ads-audit',
  '/website-checker': '/website-check/',
  '/website-audit': '/website-check/',
  '/free-website-check': '/website-check/',
  '/free-website-audit': '/website-check/',
};

function getHandler(mod) {
  return mod.handler || (mod.default && mod.default.handler);
}

async function runFunction(name, request, url, extraQuery, env, ctx) {
  const load = loaders[name];
  if (!load) return new Response('Not found', { status: 404 });
  const event = await toEvent(request, url, extraQuery);

  if (isBackground(name)) {
    // Both background payloads are small (a job id or URL plus a Google token), well under the 128KB message cap.
    if (env.JOBS) await env.JOBS.send({ name, event });
    else ctx.waitUntil(runJob({ name, event })); // local dev without a queue binding
    return new Response(null, { status: 202 });
  }

  const handler = getHandler(await load());
  return fromResult(await handler(event, {}));
}

async function runJob({ name, event }) {
  const handler = getHandler(await loaders[name]());
  await handler(event, {});
}

// Functions sometimes fire a request without awaiting it. A Worker cancels such work once the response is sent,
// so keep every outgoing request alive until it settles.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const p = realFetch(input, init);
  if (globalThis.__phCtx) globalThis.__phCtx.waitUntil(p.then(() => {}, () => {}));
  return p;
};

async function route(request, env, ctx) {
  const url = new URL(request.url);

  // Apex to www and http to https, as Netlify did (301, path and query kept).
  const isSiteHost = url.hostname === 'phillips-uk.com' || url.hostname === CANONICAL_HOST;
  if (isSiteHost && (url.hostname !== CANONICAL_HOST || url.protocol === 'http:')) {
    url.hostname = CANONICAL_HOST;
    url.protocol = 'https:';
    return Response.redirect(url.href, 301);
  }

  // Search Desk, the product: its own Worker (search-desk), reached through a service binding
  if ((url.pathname === '/desk' || url.pathname.startsWith('/desk/')) && env.DESK) return env.DESK.fetch(request);

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  const bare = path.replace(/\.html$/, '');
  if (MOVED[bare]) return Response.redirect(new URL(MOVED[bare], url).href, 301);
  // One address per tool page: /website-check/ (with the slash) and /google-ads-audit (without), no .html
  if (bare === '/website-check' && url.pathname !== '/website-check/') return Response.redirect(new URL('/website-check/' + url.search, url).href, 301);
  if (bare === '/google-ads-audit' && url.pathname !== '/google-ads-audit') return Response.redirect(new URL('/google-ads-audit' + url.search, url).href, 301);

  // The Website Check (tools-gate.js says who may use it; while private, everyone else is redirected)
  if (isWebsiteCheckPath(path)) {
    const res = await websiteCheck(request, url, env);
    if (res) return path.startsWith('/tools/') ? res : withGtm(res);
    return Response.redirect(new URL('/web-design/', url).href, 302);
  }

  // "Sign in with Google" for the Google Ads Check (cloudflare/src/google-signin.js): Lewis only until Google verifies the app
  if (isSignInPath(path)) return googleSignIn(request, url, env, path);
  // The Google Ads Check, the same way (keeps /google-ads-audit, which has the search impressions history)
  if (isAdsCheckPath(path)) {
    const res = await adsCheck(request, url, env);
    if (res) return path.startsWith('/tools/') ? res : withGtm(res);
    return Response.redirect(new URL('/google-ads/', url).href, 302);
  }

  const pausedTo = PAUSED[bare];
  if (pausedTo) return Response.redirect(new URL(pausedTo, url).href, 302);

  if (REDIRECTS[path]) return Response.redirect(new URL(REDIRECTS[path], url).href, 301);

  const direct = path.match(/^\/\.netlify\/functions\/([a-z0-9-]+)$/);
  if (direct) return runFunction(direct[1], request, url, {}, env, ctx);

  if (path === '/auth/callback') return runFunction('auth-callback', request, url, {}, env, ctx);

  // The "Ask me a question" form (cloudflare/src/enquiry.js)
  if (path === '/enquiry') return request.method === 'POST' ? enquiry(request, env) : new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  // The sign-in check on the paused free tools' pages (cloudflare/src/tool-access.js)
  if (path === '/tool-access') return toolAccess(request, env);

  // The Monday Brief: sign-up, confirmation, issue pages and archive (cloudflare/src/brief.js)
  if (isBriefPath(url.pathname)) {
    const res = await brief(request, url, env);
    if (res) return withGtm(res);
  }
  if (path === '/sitemap.xml') return sitemapWithIssues(await env.ASSETS.fetch(request), env);
  // The Insights hub shows the latest Monday Brief issue
  if (path === '/guides') return withGtm(await withLatestIssue(await env.ASSETS.fetch(request), env));

  // Supplier health check demo, on the Phillips. data service (cloudflare/src/supplier-check.js); noindex, not linked yet
  if (isSupplierCheckPath(url.pathname.replace(/\/+$/, '') || '/')) {
    const res = await supplierCheck(request, url, env, ctx);
    return (res.headers.get('Content-Type') || '').startsWith('text/html') ? withGtm(res) : res;
  }
  if (isMonumentDataPath(path)) return monumentData(request, url, env, ctx);
  if (isRateCardPath(path)) return rateCard(request, url, env, ctx);
  if (path === '/invite-ping' && request.method === 'POST') return invitePing(request, env);
  if (isAdminPath(path)) return admin(request, url, env);

  const share = path.match(/^\/r\/([^/]+)$/);
  if (share) return withGtm(await runFunction('audit-share', request, url, { id: decodeURIComponent(share[1]) }, env, ctx));

  // One address per page, with a permanent redirect (the asset server's own is a temporary 307): /about to /about/,
  // and /about/index.html to /about/ (20 Nov 2026)
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname !== '/') {
    if (url.pathname.endsWith('/index.html')) return Response.redirect(new URL(url.pathname.slice(0, -10) + url.search, url).href, 301);
    if (!url.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      const probe = await env.ASSETS.fetch(new Request(new URL(url.pathname + '/', url).href, { method: 'HEAD' }));
      if (probe.status === 200) return Response.redirect(new URL(url.pathname + '/' + url.search, url).href, 301);
    }
  }
  return withGtm(await env.ASSETS.fetch(request));
}

// Security headers on every response (2026-11-16), added only where a route hasn't set its own (the admin and the
// rate card set stricter ones). No CSP here: it would need GTM, fonts and every tool page listed, so it is a separate job.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function withSecurityHeaders(res) {
  if (!res || res.status === 101 || res.webSocket) return res;
  const missing = Object.keys(SECURITY_HEADERS).filter(h => !res.headers.has(h));
  if (!missing.length) return res;
  const out = new Response(res.body, res);
  for (const h of missing) out.headers.set(h, SECURITY_HEADERS[h]);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    globalThis.__phEnv = env; globalThis.__phCtx = ctx;
    setSelfHandler(async (req) => withSecurityHeaders(await route(req, env, ctx))); // Website Check on this site itself
    let res = await route(request, env, ctx);
    // The workers.dev address is only for testing; keep it out of search results.
    if (new URL(request.url).hostname.endsWith('.workers.dev')) {
      res = new Response(res.body, res);
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    return withSecurityHeaders(res);
  },

  // Cron triggers (wrangler.jsonc): the Monday Brief send at 07:00 UK time and Lewis's Friday and Sunday notes.
  async scheduled(controller, env, ctx) {
    globalThis.__phEnv = env; globalThis.__phCtx = ctx;
    ctx.waitUntil(briefScheduled(controller, env));
    // Weekly tidy of the free tools' saved reports and counters (Monday's early run only)
    if (controller.cron === '0 6 * * MON') ctx.waitUntil(Promise.all([cleanupWebsiteChecks(env), cleanupAdsChecks(env), cleanupToolRates(env)]).catch(err => console.error('tools cleanup', err && err.message)));
  },

  async queue(batch, env, ctx) {
    globalThis.__phEnv = env; globalThis.__phCtx = ctx;
    for (const msg of batch.messages) {
      try { await runJob(msg.body); } catch (err) { console.error('job failed', msg.body && msg.body.name, err && err.message); }
      msg.ack(); // never retry: a rerun would repeat paid Claude/OpenAI calls
    }
  },
};
