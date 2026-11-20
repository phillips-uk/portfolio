"""Turn one Companies House accounts bulk file (daily or monthly zip) into upserts for accounts_facts.

  python3 -I accounts.py <Accounts_Bulk_Data-YYYY-MM-DD.zip> <out.sql> [--min-staff N]

Keeps every machine-readable filing with at least one figure (all company sizes) unless --min-staff is given.
Benchmarks use only companies with 10 or more staff (accounts_benchmarks.py). Each kept company's SIC
code, division and section are filled in by the same SQL from the register table (every company, loaded monthly),
so no API calls are made.
Company data only. Source: https://download.companieshouse.gov.uk/en_accountsdata.html
"""
import json, os, re, sys, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ixbrl import read_accounts

ZIP, OUT = sys.argv[1], sys.argv[2]
FIGURES = ['employees', 'turnover', 'cost_of_sales', 'trade_debtors', 'debtors', 'stock', 'trade_creditors', 'cash',
           'creditors_within_year', 'fixed_assets', 'net_assets']
MIN_STAFF = int(sys.argv[sys.argv.index('--min-staff') + 1]) if '--min-staff' in sys.argv else 0


def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, (int, float)): return repr(round(v, 2)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


rows, seen = [], 0
src = os.path.basename(ZIP)
with zipfile.ZipFile(ZIP) as z:
    for info in z.infolist():
        m = re.search(r'_([A-Z0-9]{8})_(\d{4})(\d{2})(\d{2})\.(x?html?)$', info.filename, re.I)
        if not m: continue
        seen += 1
        html = z.read(info).decode('utf-8', 'ignore')
        if MIN_STAFF and 'AverageNumberEmployees' not in html: continue
        facts = read_accounts(html, f'{m.group(2)}-{m.group(3)}-{m.group(4)}')
        if (facts.get('employees') or 0) < MIN_STAFF: continue
        if not any(facts.get(k) is not None for k in FIGURES): continue  # nothing we can use
        number = m.group(1).upper()
        staff = facts.get('employees')
        rows.append(dict(company_number=number, period_end=facts['period_end'], employees=int(staff) if staff is not None else None,
                         turnover=facts.get('turnover'), cost_of_sales=facts.get('cost_of_sales'),
                         trade_debtors=facts.get('trade_debtors'), debtors=facts.get('debtors'), stock=facts.get('stock'),
                         trade_creditors=facts.get('trade_creditors'), cash=facts.get('cash'),
                         creditors_within_year=facts.get('creditors_within_year'), fixed_assets=facts.get('fixed_assets'),
                         net_assets=facts.get('net_assets'), source_file=src))

cols = list(rows[0].keys()) if rows else []
with open(OUT, 'w') as out:
    for i in range(0, len(rows), 200):
        vals = ',\n'.join('(' + ','.join(lit(r[c]) for c in cols) + ')' for r in rows[i:i + 200])
        upd = ', '.join(f'{c} = excluded.{c}' for c in cols if c not in ('company_number', 'period_end'))
        out.write(f'INSERT INTO accounts_facts ({",".join(cols)}) VALUES\n{vals}\n'
                  f'ON CONFLICT (company_number, period_end) DO UPDATE SET {upd};\n')
    if rows:
        out.write("UPDATE accounts_facts SET sic_code = r.sic_code, division = r.division, section = r.section "
                  f"FROM register r WHERE r.number = accounts_facts.company_number AND accounts_facts.source_file = {lit(src)};\n")
print(json.dumps({'file': src, 'filings': seen, 'kept': len(rows), 'with_turnover': sum(1 for r in rows if r['turnover'])}))
