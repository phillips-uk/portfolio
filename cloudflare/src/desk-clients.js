// Search Desk findings on the admin's client pages (Lewis, 23 Nov 2026): Phillips. clients are run in Search Desk
// through Lewis's own agency account, so the client page shows Search Desk's Account health instead of keeping its own.
// Read only, through Search Desk's ClientDesk entrypoint (binding DESK_CLIENTS, an RPC call inside Cloudflare, free).
// ClientDesk only answers for active client companies and never returns search terms or raw rows; each answer is
// cached there for 10 minutes. A client is linked to its Search Desk company on its Billing card (deskId).

const ID = /^[A-Za-z0-9_-]{6,64}$/;
export const deskIdOk = id => typeof id === 'string' && ID.test(id);

/** What a Daily view shows: the count, and the money at stake (findings not marked nosum). */
export function deskSummary(h) {
  if (!h || h.error) return null;
  const daily = (h.findings || []).filter(f => f && f.daily);
  const money = daily.reduce((a, f) => a + (!f.nosum && Number.isFinite(Number(f.money)) ? Number(f.money) : 0), 0);
  return { count: daily.length, money: Math.round(money * 100) / 100 };
}

/** The companies to link to, and the health of the linked ones, keyed by id. Never throws. */
export async function deskClients(env, ids) {
  if (!env.DESK_CLIENTS) return { ready: false, companies: [], health: {} };
  const want = [...new Set((ids || []).filter(deskIdOk))].slice(0, 25);
  try {
    const [list, sum] = await Promise.all([
      env.DESK_CLIENTS.list(),
      want.length ? env.DESK_CLIENTS.summary({ ids: want }) : { companies: [] },
    ]);
    const health = {};
    for (const h of (sum && sum.companies) || []) if (h && h.id) health[h.id] = h.error ? { id: h.id, error: h.error } : { ...h, summary: deskSummary(h) };
    return { ready: true, companies: ((list && list.companies) || []).map(c => ({ id: c.id, name: c.name })), health };
  } catch (e) {
    console.error('desk clients', e && e.message);
    return { ready: true, error: 'Search Desk did not answer. Try again in a minute.', companies: [], health: {} };
  }
}
