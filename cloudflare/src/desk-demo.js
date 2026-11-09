// The Search Desk demo behind invite links (/search-desk?invite=<token>): Example Car Hire Co., the made-up company
// inside Search Desk at /desk. Every invite goes through one Search Desk share link (/desk/demo/<token>, made in
// Search Desk > Workspaces > Example Car Hire Co. > Share links, 7, 30 or 90 days) that Lewis pastes into /admin > Links.
// It is kept in R2 at admin/desk-demo.json, never in a page, and opened here through the DESK service binding: the
// visitor gets Search Desk's guest session cookie but never sees the share token, so switching an invite off still
// stops new visits. When Search Desk turns the link down (run out, switched off, mistyped) the visitor sees a calm
// locked page, Lewis sees what to renew, and the admin shows a warning until it works again.

const KEY = 'admin/desk-demo.json';
// Same shape as Search Desk's own tokens (src/auth.js in the search-desk repo)
const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
export const DESK_DAYS = [7, 30, 90];

export async function getDeskDemo(env) {
  const obj = await env.BLOBS.get(KEY);
  return obj ? obj.json() : null;
}

async function putDeskDemo(env, d) {
  await env.BLOBS.put(KEY, JSON.stringify(d), { httpMetadata: { contentType: 'application/json' } });
}

// A pasted share link, or just its token
export function shareToken(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/desk\/demo\/([^/?#\s]+)/);
  const t = m ? m[1] : s;
  return SHARE_TOKEN.test(t) ? t : null;
}

// What /admin shows: never the whole token, so it can't be sent to a prospect by mistake
export function deskDemoSummary(d) {
  if (!d || !d.token) return { set: false, problem: d && d.problem || null };
  return {
    set: true,
    hint: d.token.slice(0, 4) + '…' + d.token.slice(-4),
    savedAt: d.savedAt,
    days: d.days || null,
    expiresAt: d.days ? new Date(Date.parse(d.savedAt) + d.days * 86400000).toISOString() : null,
    problem: d.problem || null,
  };
}

export async function saveDeskDemo(env, body, email) {
  const token = shareToken(body.link);
  if (!token) return { error: 'That is not a Search Desk share link. Copy it from Share links: it looks like phillips-uk.com/desk/demo/…' };
  const days = DESK_DAYS.includes(Number(body.days)) ? Number(body.days) : 90;
  const d = { token, days, savedAt: new Date().toISOString(), savedBy: email, problem: null };
  await putDeskDemo(env, d);
  return deskDemoSummary(d);
}

// Write the problem flag only when it changes, so a working link costs no R2 write per visit. Read again first, and
// only touch the link this visit tried: a new link saved meanwhile must never be overwritten by the old one.
async function noteProblem(env, tried, problem) {
  const had = !!(tried && tried.problem);
  if (!problem && !had) return;
  if (problem && had && tried.problem.why === problem.why) return;
  const now = await getDeskDemo(env);
  if ((now && now.token) !== (tried && tried.token)) return;
  await putDeskDemo(env, { ...(now || {}), problem });
}

// Open the share link for this visitor. Their own cookies go along, so Phillips. staff signed in to Search Desk are
// switched to the demo company instead of getting a guest session. Returns { location, cookies } or { why }.
export async function openDeskDemo(request, url, env, ctx) {
  const d = await getDeskDemo(env);
  let result;
  if (!d || !d.token) result = { why: 'missing' };
  else if (!env.DESK) result = { why: 'unreachable' };
  else {
    try {
      const res = await env.DESK.fetch(new Request(new URL('/desk/demo/' + d.token, url.origin), {
        method: 'GET', redirect: 'manual',
        headers: { Cookie: request.headers.get('Cookie') || '', 'User-Agent': request.headers.get('User-Agent') || '' },
      }));
      const loc = res.headers.get('Location') || '';
      if (res.status >= 300 && res.status < 400 && /^\/desk(?:[/?#]|$)/.test(loc) && !loc.startsWith('/desk/demo/')) {
        result = { location: loc, cookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
      } else result = { why: 'refused' };
    } catch (err) {
      console.error('desk demo open failed', err && err.message);
      result = { why: 'unreachable' };
    }
  }
  const problem = result.why ? { why: result.why, at: new Date().toISOString() } : null;
  ctx.waitUntil(noteProblem(env, d, problem).catch(err => console.error('desk demo status failed', err && err.message)));
  return result;
}
