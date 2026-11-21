"""Read headline figures from an iXBRL accounts document. Mirrors src/ixbrl.js; keep the two in step."""
import re

FIELDS = {
    'turnover': ('TurnoverRevenue', 'Revenue', 'TurnoverGrossOperatingRevenue'),
    'cost_of_sales': ('CostSales', 'CostOfSales'),
    'trade_debtors': ('TradeDebtorsTradeReceivables', 'TradeReceivables', 'CurrentTradeReceivables'),
    'debtors': ('Debtors', 'TradeAndOtherReceivables', 'TradeAndOtherCurrentReceivables'),
    'stock': ('TotalInventories', 'Stocks', 'Inventories', 'CurrentInventories'),
    'cash': ('CashBankOnHand', 'CashAndCashEquivalents'),
    'trade_creditors': ('TradeCreditorsTradePayables', 'TradePayables', 'CurrentTradePayables'),
    'creditors_within_year': ('Creditors', 'TradeAndOtherCurrentPayables'),
    'fixed_assets': ('PropertyPlantEquipment', 'FixedAssets'),
    'net_assets': ('NetAssetsLiabilities', 'Equity'),
    'employees': ('AverageNumberEmployeesDuringPeriod', 'AverageNumberOfEmployees'),
}
LOOKUP = {n: f for f, names in FIELDS.items() for n in names}
CTX = re.compile(r'<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>(.*?)</(?:xbrli:)?context>', re.S | re.I)
END = re.compile(r'<(?:xbrli:)?(?:instant|endDate)>\s*([\d-]{10})', re.I)
DIM = re.compile(r'<xbrldi:explicitMember[^>]*dimension="([^"]+)"[^>]*>([^<]+)<', re.I)
FACT = re.compile(r'<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>', re.S | re.I)
ATTR = lambda a, k: (re.search(r'\b' + k + r'="([^"]*)"', a, re.I) or [None, None])[1]


def to_number(attrs, inner):
    text = re.sub(r'<[^>]+>', '', inner).strip()
    fmt = ATTR(attrs, 'format') or ''
    if text in ('-', '') or re.search(r'zerodash|fixed-zero|nocontent', fmt, re.I):
        x = 0.0
    else:
        if re.search(r'numcommadecimal|num-comma-decimal', fmt, re.I):
            text = re.sub(r'[.\s]', '', text).replace(',', '.')
        else:
            text = re.sub(r'[,\s]', '', text)
        text = re.sub(r'[^\d.]', '', text)
        try: x = float(text)
        except ValueError: return None
    sc = ATTR(attrs, 'scale')
    if sc and re.fullmatch(r'-?\d+', sc): x *= 10 ** int(sc)
    if ATTR(attrs, 'sign') == '-': x = -x
    return x


def is_current(dim, val):
    # "Current" is tagged as maturity within one year, as current financial instruments, or both.
    return ('Maturit' in dim and 'WithinOneYear' in val) or (
        re.search(r'CurrentNon-?current', dim, re.I) is not None and val.split(':')[-1] == 'CurrentFinancialInstruments')


def read_accounts(html, period_end=None):
    contexts = {}
    for cid, body in CTX.findall(html):
        m = END.search(body)
        contexts[cid] = (m.group(1) if m else None, [(d.strip(), v.strip()) for d, v in DIM.findall(body)], 'xbrldi:typedMember' in body)
    if not period_end:
        ends = sorted(e for e, _, _ in contexts.values() if e)
        period_end = ends[-1] if ends else None
    found = {}
    for attrs, inner in FACT.findall(html):
        name, cref = ATTR(attrs, 'name'), ATTR(attrs, 'contextRef')
        if not name or cref not in contexts: continue
        end, dims, typed = contexts[cref]
        if end != period_end or typed: continue
        field = LOOKUP.get(name.split(':')[-1])
        if not field: continue
        within = bool(dims) and all(is_current(d, v) for d, v in dims)
        if dims and not within: continue
        v = to_number(attrs, inner)
        if v is None: continue
        found.setdefault(field, {}).setdefault('within' if within else 'plain', v)
    out = {'period_end': period_end}
    for f, s in found.items():
        v = s.get('within') if f == 'creditors_within_year' else s.get('plain', s.get('within'))
        # Some filers present costs and liabilities as negatives.
        if v is not None: out[f] = abs(v) if f in ('cost_of_sales', 'trade_creditors', 'creditors_within_year') else v
    return with_ratios(out)


def with_ratios(a):
    def days(num, den):
        return round(365 * num / den) if num is not None and den and den > 0 else None
    r = dict(a)
    for k, v in (('debtor_days', days(a.get('trade_debtors'), a.get('turnover'))),
                 ('stock_days', days(a.get('stock'), a.get('cost_of_sales'))),
                 ('creditor_days', days(a.get('trade_creditors'), a.get('cost_of_sales')))):
        if v is not None: r[k] = v
    return r


PRIOR = ('turnover', 'cash', 'net_assets', 'trade_debtors', 'employees')


def prior_end(html, period_end):
    """The comparative period in the same filing: the latest date at least 300 days before period_end."""
    from datetime import date
    if not period_end: return None
    pe = date.fromisoformat(period_end)
    ends = set()
    for _, body in CTX.findall(html):
        m = END.search(body)
        if not m: continue
        try: d = date.fromisoformat(m.group(1))
        except ValueError: continue
        if 300 <= (pe - d).days <= 430: ends.add(d)
    return max(ends).isoformat() if ends else None


def read_prior(html, period_end):
    """Prior-year figures from the comparative column, or {} when the filing has none."""
    pe = prior_end(html, period_end)
    if not pe: return {}
    f = read_accounts(html, pe)
    out = {k: f[k] for k in PRIOR if f.get(k) is not None}
    return {'prior_period_end': pe, **{'prior_' + k: v for k, v in out.items()}} if out else {}
