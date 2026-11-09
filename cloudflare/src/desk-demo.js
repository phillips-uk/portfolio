// The Search Desk demo behind invite links (/search-desk?invite=<token>): Example Car Hire Co., the made-up company
// inside Search Desk at /desk. Each invite gets its own Search Desk share link (/desk/demo/<token>), labelled with the
// prospect's name, from Search Desk's DemoLinks entrypoint (binding DESK_LINKS, an RPC call that is never reachable
// over HTTP). Search Desk keeps the link open, makes a new one when it is close to running out, and counts its opens,
// so there is nothing to renew. The site opens the link through the DESK binding: the visitor gets Search Desk's guest
// cookie but never sees the share token, so switching an invite off in /admin (which also revokes its link) stops it.
// A guest's own look (their company's name and colours) is kept per link, so it is now per prospect.
// If Search Desk can't give or open a link, the visitor sees a calm holding page, Lewis sees what went wrong, and the
// admin shows a warning (R2 admin/desk-demo.json holds only that problem flag) until a demo opens again.
// Contract agreed with the search-desk repo on 2026-11-09 (its src DemoLinks: forInvite({ ref, label }), revoke({ ref })).

const KEY = 'admin/desk-demo.json';
const PREVIEW = 'site-preview';

// Search Desk never sees an invite token: only "site-" and the first 32 hex characters of its SHA-256
export async function deskRef(inviteToken) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(inviteToken))));
  return 'site-' + [...hash].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function deskLabel(invite) {
  return invite ? (String(invite.name || 'Invite').trim().slice(0, 60) + ' (website invite)') : 'Phillips. admin preview';
}

export async function getDeskDemo(env) {
  const obj = await env.BLOBS.get(KEY);
  return obj ? obj.json() : null;
}

// What /admin shows: only whether the last try worked
export function deskDemoSummary(d) {
  return { problem: (d && d.problem) || null };
}

// Write the problem flag only when it changes, so a working demo costs no R2 write per visit
async function noteProblem(env, problem) {
  const d = await getDeskDemo(env);
  const had = !!(d && d.problem);
  if (!problem && !had) return;
  if (problem && had && d.problem.why === problem.why) return;
  await env.BLOBS.put(KEY, JSON.stringify({ problem }), { httpMetadata: { contentType: 'application/json' } });
}

// Open this invite's share link (or the admin preview's) for this visitor. Their own cookies go along, so Phillips.
// staff signed in to Search Desk are switched to the demo company instead of getting a guest session.
// Returns { location, cookies } or { why }: 'unavailable' (no DemoLinks yet, or it threw) or 'refused' (Search Desk
// would not open the link it just gave).
export async function openDeskDemo(request, url, env, ctx, invite) {
  let result;
  let link = null;
  if (env.DESK_LINKS && env.DESK) {
    try {
      link = await env.DESK_LINKS.forInvite({ ref: invite ? await deskRef(invite.token) : PREVIEW, label: deskLabel(invite) });
    } catch (err) {
      console.error('desk demo link failed', err && err.message);
    }
  }
  if (!link || typeof link.token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(link.token)) result = { why: 'unavailable' };
  else {
    try {
      const res = await env.DESK.fetch(new Request(new URL('/desk/demo/' + link.token, url.origin), {
        method: 'GET', redirect: 'manual',
        headers: { Cookie: request.headers.get('Cookie') || '', 'User-Agent': request.headers.get('User-Agent') || '' },
      }));
      const loc = res.headers.get('Location') || '';
      if (res.status >= 300 && res.status < 400 && /^\/desk(?:[/?#]|$)/.test(loc) && !loc.startsWith('/desk/demo/')) {
        result = { location: loc, cookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
      } else result = { why: 'refused' };
    } catch (err) {
      console.error('desk demo open failed', err && err.message);
      result = { why: 'unavailable' };
    }
  }
  const problem = result.why ? { why: result.why, at: new Date().toISOString() } : null;
  ctx.waitUntil(noteProblem(env, problem).catch(err => console.error('desk demo status failed', err && err.message)));
  return result;
}

// Switching an invite off in /admin also switches off its Search Desk link, which signs its guests out at once.
// Switching it back on needs nothing: the next open makes a new link.
export async function revokeDeskDemo(env, invite) {
  if (!env.DESK_LINKS || !invite) return;
  try { await env.DESK_LINKS.revoke({ ref: await deskRef(invite.token) }); }
  catch (err) { console.error('desk demo revoke failed', err && err.message); }
}
