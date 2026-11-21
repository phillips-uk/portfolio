// Read the headline figures from an iXBRL accounts document (UK GAAP / FRS 102 taxonomy names, plus IFRS fallbacks).
// Only facts for the balance sheet date / period ending on `periodEnd` are used. Dimensional facts are ignored except
// "within one year" maturity, which is how creditors (and some debtors) are tagged.

const FIELDS = {
  turnover: ['TurnoverRevenue', 'Revenue', 'TurnoverGrossOperatingRevenue'],
  cost_of_sales: ['CostSales', 'CostOfSales'],
  trade_debtors: ['TradeDebtorsTradeReceivables', 'TradeReceivables', 'CurrentTradeReceivables'],
  debtors: ['Debtors', 'TradeAndOtherReceivables', 'TradeAndOtherCurrentReceivables'],
  stock: ['TotalInventories', 'Stocks', 'Inventories', 'CurrentInventories'],
  cash: ['CashBankOnHand', 'CashAndCashEquivalents'],
  trade_creditors: ['TradeCreditorsTradePayables', 'TradePayables', 'CurrentTradePayables'],
  creditors_within_year: ['Creditors', 'TradeAndOtherCurrentPayables'],
  fixed_assets: ['PropertyPlantEquipment', 'FixedAssets'],
  net_assets: ['NetAssetsLiabilities', 'Equity'],
  employees: ['AverageNumberEmployeesDuringPeriod', 'AverageNumberOfEmployees'],
};

export function readAccounts(html, periodEnd) {
  const contexts = {};
  const ctxRe = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/gi;
  let m;
  while ((m = ctxRe.exec(html))) {
    const body = m[2];
    const end = (body.match(/<(?:xbrli:)?(?:instant|endDate)>\s*([\d-]{10})/i) || [])[1];
    const dims = [...body.matchAll(/<xbrldi:explicitMember[^>]*dimension="([^"]+)"[^>]*>([^<]+)</gi)].map(d => [d[1], d[2].trim()]);
    const typed = /<xbrldi:typedMember/i.test(body);
    contexts[m[1]] = { end, dims, typed };
  }
  if (!periodEnd) periodEnd = Object.values(contexts).map(c => c.end).filter(Boolean).sort().pop();

  const found = {};  // field -> { plain, withinYear }
  const factRe = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi;
  while ((m = factRe.exec(html))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]+)"/i) || [])[1];
    const ctx = contexts[(attrs.match(/\bcontextRef="([^"]+)"/i) || [])[1]];
    if (!name || !ctx || ctx.end !== periodEnd || ctx.typed) continue;
    const local = name.split(':').pop();
    const field = Object.keys(FIELDS).find(f => FIELDS[f].includes(local));
    if (!field) continue;
    // "Current" is tagged as maturity within one year, as current financial instruments, or both.
    const isCurrent = ([dim, val]) => (/Maturit/i.test(dim) && /WithinOneYear/i.test(val)) || (/CurrentNon-?current/i.test(dim) && /:?CurrentFinancialInstruments$/i.test(val));
    const withinYear = ctx.dims.length > 0 && ctx.dims.every(isCurrent);
    if (ctx.dims.length && !withinYear) continue;
    const value = toNumber(attrs, m[2]);
    if (value === null) continue;
    const slot = (found[field] ||= {});
    const key = withinYear ? 'withinYear' : 'plain';
    if (slot[key] === undefined) slot[key] = value;
  }
  const out = { period_end: periodEnd || null };
  for (const f of Object.keys(FIELDS)) {
    const s = found[f];
    if (!s) continue;
    // Creditors are only meaningful "within one year"; for the rest the undimensioned figure wins.
    out[f] = f === 'creditors_within_year' ? (s.withinYear ?? null) : (s.plain ?? s.withinYear);
    // Some filers present costs and liabilities as negatives.
    if (['cost_of_sales', 'trade_creditors', 'creditors_within_year'].includes(f) && out[f] < 0) out[f] = -out[f];
    if (out[f] === null || out[f] === undefined) delete out[f];
  }
  return withRatios(out);
}

function toNumber(attrs, inner) {
  const text = inner.replace(/<[^>]+>/g, '').trim();
  const format = (attrs.match(/\bformat="([^"]+)"/i) || [])[1] || '';
  let x;
  if (text === '-' || text === '' || /zerodash|fixed-zero|nocontent/i.test(format)) x = 0;
  else {
    const commaDecimal = /numcommadecimal|num-comma-decimal/i.test(format);
    const digits = commaDecimal ? text.replace(/[.\s]/g, '').replace(',', '.') : text.replace(/[,\s]/g, '');
    x = Number(digits.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(x)) return null;
  }
  const scale = Number((attrs.match(/\bscale="(-?\d+)"/i) || [])[1] || 0);
  if (scale) x *= 10 ** scale;
  if (/\bsign="-"/i.test(attrs)) x = -x;
  return x;
}

export function withRatios(a) {
  const days = (num, den) => (num !== undefined && den > 0 ? Math.round((365 * num) / den) : undefined);
  const r = { ...a };
  r.debtor_days = days(a.trade_debtors ?? undefined, a.turnover);
  r.stock_days = days(a.stock, a.cost_of_sales);
  r.creditor_days = days(a.trade_creditors, a.cost_of_sales);
  for (const k of ['debtor_days', 'stock_days', 'creditor_days']) if (r[k] === undefined) delete r[k];
  return r;
}

// Prior-year figures from the comparative column of the same filing (the latest date 300 to 430 days earlier).
export const PRIOR = ['turnover', 'cash', 'net_assets', 'trade_debtors', 'employees'];
export function readPrior(html, periodEnd) {
  if (!periodEnd) return {};
  const pe = Date.parse(periodEnd);
  const ends = [...html.matchAll(/<(?:xbrli:)?(?:instant|endDate)>\s*([\d-]{10})/gi)].map(m => m[1])
    .filter(d => { const gap = (pe - Date.parse(d)) / 864e5; return gap >= 300 && gap <= 430; }).sort();
  const prior = ends.pop();
  if (!prior) return {};
  const f = readAccounts(html, prior);
  const out = Object.fromEntries(PRIOR.filter(k => f[k] !== undefined && f[k] !== null).map(k => [k, f[k]]));
  return Object.keys(out).length ? { period_end: prior, ...out } : {};
}
