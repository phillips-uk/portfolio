// Health signals for one company: dated facts from every source we hold, grouped into checks.
// Facts, never a score or a verdict: each fact says what was found and when, and `notable` marks the ones worth a look
// (a site may order or highlight them, but shows them in plain ink). Company data only.
import { liveCompany } from './live.js';

const STATUS = {
  active: 'Active', dissolved: 'Dissolved', liquidation: 'In liquidation', receivership: 'In receivership',
  administration: 'In administration', 'voluntary-arrangement': 'In a voluntary arrangement',
  'converted-closed': 'Converted or closed', 'insolvency-proceedings': 'In insolvency proceedings',
  registered: 'Registered', removed: 'Removed', closed: 'Closed', open: 'Open',
};
const CASE = {
  'compulsory-liquidation': 'Compulsory liquidation', 'creditors-voluntary-liquidation': "Creditors' voluntary liquidation",
  'members-voluntary-liquidation': "Members' voluntary liquidation", 'in-administration': 'Administration',
  'administration': 'Administration', 'corporate-voluntary-arrangement': 'Company voluntary arrangement',
  'receivership': 'Receivership', 'administrative-receiver': 'Administrative receivership',
  'moratorium': 'Moratorium', 'foreign-insolvency': 'Foreign insolvency',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const ukDate = d => d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : null;
export function money(x) {
  if (x === null || x === undefined) return null;
  const a = Math.abs(x), sign = x < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}£${(a / 1e9).toFixed(1)}bn`;
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(1)}m`;
  if (a >= 1e4) return `${sign}£${Math.round(a / 1e3)}k`;
  return `${sign}£${Math.round(a).toLocaleString('en-GB')}`;
}
const pct = (now, before) => before ? Math.round(((now - before) / Math.abs(before)) * 100) : null;
const list = names => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

export async function healthSignals(number, env, ctx, { paymentsData, groupData }) {
  const live = await liveCompany(number, env, ctx);
  if (live.error) return live;
  const [pay, grp, gazetteFrom] = await Promise.all([
    paymentsData(number, env).catch(() => null),
    groupData(number, env).catch(() => null),
    env.DB.prepare('SELECT MIN(published) AS d FROM insolvency_notices').first('d').catch(() => null),
  ]);
  const c = live.company;
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const checks = [];
  const check = (id, label, facts) => checks.push({ id, label, found: facts.some(f => f.notable), facts });

  // 1. Status
  {
    const f = [];
    const st = STATUS[c.status] || c.status;
    f.push({ text: `Status: ${st}`, date: c.ceased_on, notable: c.status !== 'active' });
    if (c.incorporated) f.push({ text: `Incorporated ${ukDate(c.incorporated)}`, date: c.incorporated,
      notable: false, note: c.incorporated > daysAgo(730) ? 'under two years old' : undefined });
    check('status', 'Company status', f);
  }

  // 2. Filing with Companies House
  {
    const f = [];
    if (c.accounts_overdue) f.push({ text: `Accounts overdue: due ${ukDate(c.next_accounts_due)}`, date: c.next_accounts_due, notable: true });
    else if (c.next_accounts_due) f.push({ text: `Accounts next due ${ukDate(c.next_accounts_due)}`, date: c.next_accounts_due, notable: false });
    if (c.confirmation_statement_overdue)
      f.push({ text: `Confirmation statement overdue: due ${ukDate(c.next_confirmation_statement_due)}`, date: c.next_confirmation_statement_due, notable: true });
    else if (c.next_confirmation_statement_due)
      f.push({ text: `Confirmation statement next due ${ukDate(c.next_confirmation_statement_due)}`, date: c.next_confirmation_statement_due, notable: false });
    if (c.office_in_dispute) f.push({ text: 'Registered office address is in dispute', date: null, notable: true });
    if (!f.length && c.status !== 'active') f.push({ text: 'No filing deadlines: the company is no longer active', date: null, notable: false });
    if (c.office_undeliverable) f.push({ text: 'Post to the registered office has been returned as undeliverable', date: null, notable: true });
    check('filing', 'Filing with Companies House', f);
  }

  // 3. Insolvency
  {
    const f = [];
    for (const n of live.insolvency_notices.slice(0, 5))
      f.push({ text: `${n.type}, The Gazette`, date: n.published, url: n.url, notable: n.published >= daysAgo(730) });
    for (const k of live.insolvency_cases?.cases || []) {
      const dates = Object.entries(k.dates || {}).sort((a, b) => b[1].localeCompare(a[1]));
      f.push({ text: `${CASE[k.type] || k.type} recorded at Companies House`, date: dates[0]?.[1] || null, notable: true });
    }
    if (!f.length && c.has_insolvency_history)
      f.push({ text: 'Companies House records insolvency history', date: null, notable: true });
    if (!f.length) f.push({ text: `No insolvency notices in The Gazette${gazetteFrom ? ` since ${ukDate(gazetteFrom)}` : ''}`, date: null, notable: false });
    check('insolvency', 'Insolvency', f);
  }

  // 4. Secured lending (charges)
  {
    const f = [];
    const ch = live.charges;
    for (const r of ch.recent.slice(0, 5)) {
      const who = r.holders.length ? `, held by ${list(r.holders)}` : r.holders_not_listed ? ', held by a private individual' : '';
      f.push({ text: r.event === 'created' ? `New charge registered${who}` : `Charge satisfied${who}`, date: r.date,
               notable: r.event === 'created' });
    }
    if (ch.outstanding) {
      const who = ch.holders.length ? `, held by ${list(ch.holders)}` : '';
      const extra = ch.holders_not_listed ? ` (${ch.holders_not_listed} held by private individuals)` : '';
      f.push({ text: `${ch.outstanding} outstanding charge${ch.outstanding > 1 ? 's' : ''}${who}${extra}`, date: ch.latest_created, notable: false });
    } else f.push({ text: 'No outstanding charges', date: null, notable: false });
    check('charges', 'Secured lending', f);
  }

  // 5. Latest accounts, against the year before (the comparative column of the same filing)
  {
    const f = [];
    const a = live.accounts;
    if (!a) f.push({ text: 'No accounts filed yet', date: null, notable: false });
    else if (!a.machine_readable || !a.figures) f.push({ text: `Accounts to ${ukDate(a.made_up_to)} filed as a scanned or PDF document; figures not read`, date: a.made_up_to, notable: false });
    else {
      const x = a.figures, p = a.prior || {};
      const end = ukDate(x.period_end);
      const line = (label, now, before, notable, fmt = money) => {
        if (now === undefined || now === null) return;
        const change = before !== undefined && before !== null ? pct(now, before) : null;
        const tail = change === null ? '' : change === 0 ? ', unchanged on the year before' : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% from ${fmt(before)}`;
        f.push({ text: `${label} ${fmt(now)}${tail}`, date: x.period_end, notable: !!notable(now, before, change) });
      };
      line('Turnover', x.turnover, p.turnover, (n, b, ch) => ch !== null && ch <= -25);
      line('Cash', x.cash, p.cash, (n, b, ch) => ch !== null && ch <= -50 && Math.abs(b) >= 10000);
      if (x.net_assets !== undefined && x.net_assets < 0)
        f.push({ text: `Net liabilities of ${money(-x.net_assets)}`, date: x.period_end, notable: true });
      else line('Net assets', x.net_assets, p.net_assets, (n, b, ch) => ch !== null && ch <= -25 && Math.abs(b) >= 10000);
      if (x.employees !== undefined) line('Staff', x.employees, p.employees, () => false, n => String(Math.round(n)));
      if (f.length) f.unshift({ text: `Accounts to ${end}${a.prior?.period_end ? `, compared with ${ukDate(a.prior.period_end)}` : ''}`, date: x.period_end, notable: false });
      else f.push({ text: `Accounts to ${end} carry no headline figures we can read`, date: x.period_end, notable: false });
    }
    if (a?.made_up_to && a.made_up_to < daysAgo(640) && c.status === 'active')
      f.push({ text: `Latest accounts are to ${ukDate(a.made_up_to)}, over 21 months ago`, date: a.made_up_to, notable: !c.accounts_overdue });
    check('accounts', 'Latest accounts', f);
  }

  // 6. Paying suppliers (large companies only report)
  if (pay?.latest) {
    const l = pay.latest, b = pay.benchmark?.metrics?.days;
    const f = [{ text: `Pays suppliers in ${l.days} days on average`, date: l.period_end,
                 notable: !!(b && l.days > b.p75), note: `reporting period to ${ukDate(l.period_end)}` }];
    if (b) f.push({ text: `${pay.benchmark.group_name}: middle half ${Math.round(b.p25)} to ${Math.round(b.p75)} days (${b.n} companies, ${pay.benchmark.year})`, date: null, notable: false });
    if (l.pct_late !== null && l.pct_late !== undefined) f.push({ text: `${l.pct_late}% of payments made late`, date: l.period_end, notable: l.pct_late >= 50 });
    check('payments', 'Paying suppliers', f);
  }

  // 7. Group
  if (grp?.top_parent) {
    const t = grp.top_parent;
    const f = [{ text: `Part of a group; top parent we can see: ${t.name}${t.number ? '' : ` (${t.country || 'outside the UK'})`}`, date: null, notable: false }];
    if (t.number && t.status && t.status !== 'Active')
      f.push({ text: `Parent company status: ${t.status}`, date: null, notable: true });
    check('group', 'Group', f);
  }

  const found = checks.filter(k => k.found).length;
  return {
    company: { number, name: c.name, status: c.status, incorporated: c.incorporated, postcode_area: c.postcode_area,
               division: c.division, section: c.section },
    as_of: today,
    summary: { checks: checks.length, with_notable_facts: found },
    checks,
    basis: 'Facts from public records, each with its date. Not a credit score or a credit opinion.',
    source: 'Companies House; The Gazette; Department for Business and Trade payment practices reporting',
    licence: 'Contains public sector information licensed under the Open Government Licence v3.0',
  };
}
