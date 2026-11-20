"""Turn one Companies House accounts bulk file (daily or monthly zip) into upserts for accounts_facts.

  CH_API_KEY=... python3 -I accounts.py <Accounts_Bulk_Data-YYYY-MM-DD.zip> <out.sql> [--min-staff 10]

Keeps companies whose average staff for the period is at least --min-staff (default 10). Each kept company's first
SIC code comes from the Companies House API (throttled to stay well under the 600 calls per 5 minutes limit).
Company data only. Source: https://download.companieshouse.gov.uk/en_accountsdata.html
"""
import base64, json, os, re, sys, time, urllib.request, urllib.error, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ixbrl import read_accounts

ZIP, OUT = sys.argv[1], sys.argv[2]
MIN_STAFF = int(sys.argv[sys.argv.index('--min-staff') + 1]) if '--min-staff' in sys.argv else 10
KEY = os.environ.get('CH_API_KEY', '')
AUTH = 'Basic ' + base64.b64encode((KEY + ':').encode()).decode()
GAP, last = 0.6, [0.0]
DIV_SECTION = {}
for s, lo, hi in [('A', 1, 3), ('B', 5, 9), ('C', 10, 33), ('D', 35, 35), ('E', 36, 39), ('F', 41, 43), ('G', 45, 47),
                  ('H', 49, 53), ('I', 55, 56), ('J', 58, 63), ('K', 64, 66), ('L', 68, 68), ('M', 69, 75), ('N', 77, 82),
                  ('O', 84, 84), ('P', 85, 85), ('Q', 86, 88), ('R', 90, 93), ('S', 94, 96), ('T', 97, 98), ('U', 99, 99)]:
    for d in range(lo, hi + 1): DIV_SECTION[d] = s


def sic_for(number):
    if not KEY: return None
    wait = GAP - (time.time() - last[0])
    if wait > 0: time.sleep(wait)
    last[0] = time.time()
    req = urllib.request.Request(f'https://api.company-information.service.gov.uk/company/{number}',
                                 headers={'Authorization': AUTH, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            codes = json.load(r).get('sic_codes') or []
    except urllib.error.HTTPError:
        return None
    code = next((c for c in codes if re.fullmatch(r'\d{5}', c) and c != '99999'), None)
    return code


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
        if 'AverageNumberEmployees' not in html: continue
        facts = read_accounts(html, f'{m.group(2)}-{m.group(3)}-{m.group(4)}')
        if (facts.get('employees') or 0) < MIN_STAFF: continue
        number = m.group(1).upper()
        code = sic_for(number)
        div = int(code[:2]) if code else None
        rows.append(dict(company_number=number, period_end=facts['period_end'], employees=int(facts['employees']),
                         turnover=facts.get('turnover'), cost_of_sales=facts.get('cost_of_sales'),
                         trade_debtors=facts.get('trade_debtors'), debtors=facts.get('debtors'), stock=facts.get('stock'),
                         trade_creditors=facts.get('trade_creditors'), cash=facts.get('cash'), sic_code=code,
                         division=f'{div:02d}' if div else None, section=DIV_SECTION.get(div), source_file=src))

cols = list(rows[0].keys()) if rows else []
with open(OUT, 'w') as out:
    for i in range(0, len(rows), 200):
        vals = ',\n'.join('(' + ','.join(lit(r[c]) for c in cols) + ')' for r in rows[i:i + 200])
        upd = ', '.join(f'{c} = excluded.{c}' for c in cols if c not in ('company_number', 'period_end'))
        out.write(f'INSERT INTO accounts_facts ({",".join(cols)}) VALUES\n{vals}\n'
                  f'ON CONFLICT (company_number, period_end) DO UPDATE SET {upd};\n')
print(json.dumps({'file': src, 'filings': seen, 'kept': len(rows),
                  'with_turnover': sum(1 for r in rows if r['turnover']), 'with_sic': sum(1 for r in rows if r['sic_code'])}))
