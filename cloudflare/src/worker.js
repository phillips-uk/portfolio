// Cloudflare Worker entry for phillips-uk.com. Serves the static site from Workers Assets and runs the existing
// netlify/functions/*.js handlers unchanged through the adapter (same approach as Before You Pay).
import { toEvent, fromResult } from './netlify-adapter.js';

const loaders = {
  'audit-share':                () => import('../../netlify/functions/audit-share.js'),
  'auth-callback':              () => import('../../netlify/functions/auth-callback.js'),
  'creative-analyse-background': () => import('../../netlify/functions/creative-analyse-background.js'),
  'creative-auth':              () => import('../../netlify/functions/creative-auth.js'),
  'creative-status':            () => import('../../netlify/functions/creative-status.js'),
  'creative-upload':            () => import('../../netlify/functions/creative-upload.js'),
  'get-report':                 () => import('../../netlify/functions/get-report.js'),
  'landing-audit-background':   () => import('../../netlify/functions/landing-audit-background.js'),
  'landing-audit-status':       () => import('../../netlify/functions/landing-audit-status.js'),
  'mcc-audit':                  () => import('../../netlify/functions/mcc-audit.js'),
  'mcc-check':                  () => import('../../netlify/functions/mcc-check.js'),
  'og-image':                   () => import('../../netlify/functions/og-image.js'),
  'trigger-audit':              () => import('../../netlify/functions/trigger-audit.js'),
};

// Netlify "background functions" (name ends in -background) return 202 at once and keep running.
// Here they go through the phillips-jobs queue, whose consumer may run for minutes.
const isBackground = name => name.endsWith('-background');

const CANONICAL_HOST = 'www.phillips-uk.com';

// Mirrors netlify.toml and _redirects.
const REDIRECTS = {
  '/audit': '/google-ads-audit',
  '/shopify-google-ads-audit': '/google-ads-audit?type=shopify',
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

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (REDIRECTS[path]) return Response.redirect(new URL(REDIRECTS[path], url).href, 301);

  const direct = path.match(/^\/\.netlify\/functions\/([a-z0-9-]+)$/);
  if (direct) return runFunction(direct[1], request, url, {}, env, ctx);

  if (path === '/auth/callback') return runFunction('auth-callback', request, url, {}, env, ctx);

  const share = path.match(/^\/r\/([^/]+)$/);
  if (share) return runFunction('audit-share', request, url, { id: decodeURIComponent(share[1]) }, env, ctx);

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    globalThis.__phEnv = env; globalThis.__phCtx = ctx;
    let res = await route(request, env, ctx);
    // The workers.dev address is only for testing; keep it out of search results.
    if (new URL(request.url).hostname.endsWith('.workers.dev')) {
      res = new Response(res.body, res);
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    return res;
  },

  async queue(batch, env, ctx) {
    globalThis.__phEnv = env; globalThis.__phCtx = ctx;
    for (const msg of batch.messages) {
      try { await runJob(msg.body); } catch (err) { console.error('job failed', msg.body && msg.body.name, err && err.message); }
      msg.ack(); // never retry: a rerun would repeat paid Claude/OpenAI calls
    }
  },
};
