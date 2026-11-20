"""Build a data load for the Phillips. data service from two free public files.

  python3 -I build.py <payment-practices.csv> <BasicCompanyData.zip> <out-dir>

Inputs (download fresh each month, never commit them):
  - Payment practices export: https://check-payment-practices.service.gov.uk/export/csv/
    (Department for Business and Trade, Open Government Licence v3.0)
  - Companies House Free Company Data Product (one file):
    https://download.companieshouse.gov.uk/en_output.html

Writes to <out-dir>:
  load.sql     creates and fills companies_next, payment_reports_next, benchmarks_next, sectors_next
  register-NNN.sql  creates and fills register_next with every company in the Companies House file (about 5.7
               million), split into files of about 100MB so each import upload stays small; load them in name order
  publish.sql  swaps the *_next tables in and keeps the old ones as *_prev
  report.json  counts and validation results; the load must not be published if "ok" is false

Company-level data only. The Companies House file also lists nothing about people that we read:
only number, name, status, postcode area, incorporation date and the first SIC code are kept.
"""
import csv, hashlib, io, json, os, re, statistics, sys, zipfile, datetime

PAY_CSV, CH_ZIP, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
TODAY = datetime.date.today().isoformat()
TAG = 'v' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')  # makes index names unique per load
MAX_END = (datetime.date.today() + datetime.timedelta(days=31)).isoformat()  # latest period end accepted

SECTIONS = {  # UK SIC 2007 sections and the divisions in each
    'A': ('Agriculture, forestry and fishing', range(1, 4)),
    'B': ('Mining and quarrying', range(5, 10)),
    'C': ('Manufacturing', range(10, 34)),
    'D': ('Electricity, gas, steam and air conditioning supply', range(35, 36)),
    'E': ('Water supply, sewerage, waste management and remediation', range(36, 40)),
    'F': ('Construction', range(41, 44)),
    'G': ('Wholesale and retail trade, repair of motor vehicles', range(45, 48)),
    'H': ('Transportation and storage', range(49, 54)),
    'I': ('Accommodation and food service activities', range(55, 57)),
    'J': ('Information and communication', range(58, 64)),
    'K': ('Financial and insurance activities', range(64, 67)),
    'L': ('Real estate activities', range(68, 69)),
    'M': ('Professional, scientific and technical activities', range(69, 76)),
    'N': ('Administrative and support service activities', range(77, 83)),
    'O': ('Public administration and defence', range(84, 85)),
    'P': ('Education', range(85, 86)),
    'Q': ('Human health and social work activities', range(86, 89)),
    'R': ('Arts, entertainment and recreation', range(90, 94)),
    'S': ('Other service activities', range(94, 97)),
    'T': ('Activities of households as employers', range(97, 99)),
    'U': ('Activities of extraterritorial organisations', range(99, 100)),
}
DIV_SECTION = {d: s for s, (_, r) in SECTIONS.items() for d in r}

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()

def norm(name):
    return re.sub(r'[^A-Z0-9]', '', name.upper())

def to_int(v, lo=None, hi=None, bad=None, field=''):
    v = (v or '').strip()
    if v == '': return None
    try: x = int(round(float(v)))
    except ValueError:
        if bad is not None: bad[field] = bad.get(field, 0) + 1
        return None
    if (lo is not None and x < lo) or (hi is not None and x > hi):
        if bad is not None: bad[field] = bad.get(field, 0) + 1
        return None
    return x

def iso_date(v):
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (v or '').strip())
    return f'{m.group(3)}-{m.group(2)}-{m.group(1)}' if m else None

def to_bool(v):
    v = (v or '').strip().lower()
    return 1 if v in ('true', 'yes') else 0 if v in ('false', 'no') else None

# ---------- 1. Payment practices reports ----------
reports, bad, names = [], {}, {}
with open(PAY_CSV, newline='', encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        num = (r['Company number'] or '').strip().upper()
        if not re.fullmatch(r'[A-Z0-9]{8}', num):
            bad['company_number'] = bad.get('company_number', 0) + 1
            continue
        end = r['End date'][:10]
        if not ('2017-01-01' <= end <= MAX_END and r['Start date'][:10] <= end):
            bad['period_dates'] = bad.get('period_dates', 0) + 1
            continue
        days = to_int(r['Average time to pay'], 0, 365, bad, 'days')
        rep = dict(
            report_id=int(r['Report Id']), company_number=num, regime=r['Policy Regime'],
            period_start=r['Start date'][:10], period_end=end, filed=r['Filing date'][:10], year=int(end[:4]),
            payments_made=to_bool(r['Payments made in reporting period']),
            days=days,
            pct30=to_int(r['% Invoices paid within 30 days'], 0, 100, bad, 'pct30'),
            pct60=to_int(r['% Invoices paid between 31 and 60 days'], 0, 100, bad, 'pct60'),
            pct_over60=to_int(r['% Invoices paid later than 60 days'], 0, 100, bad, 'pct_over60'),
            pct_late=to_int(r['% Invoices not paid within agreed terms'], 0, 100, bad, 'pct_late'),
            pct_dispute=to_int(r['% Invoices not paid due to dispute'], 0, 100, bad, 'pct_dispute'),
            terms_shortest=to_int(r['Shortest (or only) standard payment period'], 0, 3650),
            terms_longest=to_int(r['Longest standard payment period'], 0, 3650),
            terms_max=to_int(r['Maximum contractual payment period'], 0, 3650),
            payment_code=(r['Participates in payment codes'] or '').strip() or None,
            e_invoicing=to_bool(r['E-Invoicing offered']), scf=to_bool(r['Supply-chain financing offered']),
        )
        reports.append(rep)
        prev = names.get(num)
        if not prev or rep['filed'] >= prev[0]: names[num] = (rep['filed'], r['Company'].strip())

# ---------- 2. Companies House basics: every company to register.sql, reporting companies kept in memory ----------
def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, (int, float)): return repr(v)
    return "'" + str(v).replace("'", "''") + "'"

REG_COLS = ['number', 'name', 'name_norm', 'status', 'sic_code', 'division', 'section', 'postcode_area', 'incorporated']
schema = open(os.path.join(os.path.dirname(__file__), '..', 'schema.sql')).read()
class ChunkedSQL:  # writes whole statements to register-001.sql, register-002.sql, ... of about 100MB each
    def __init__(self, limit=100_000_000):
        self.limit, self.n, self.f = limit, 0, None
        self.next()
    def next(self):
        if self.f: self.f.close()
        self.n += 1
        self.f, self.size = open(os.path.join(OUT, f'register-{self.n:03d}.sql'), 'w'), 0
    def write(self, stmt):
        if self.size and self.size + len(stmt) > self.limit: self.next()
        self.f.write(stmt); self.size += len(stmt)
    def close(self): self.f.close()

reg_out = ChunkedSQL()
reg_out.write('DROP TABLE IF EXISTS register_next;\n')
reg_out.write(re.search(r'CREATE TABLE IF NOT EXISTS register \(.*?\) WITHOUT ROWID;', schema, re.S).group(0)
              .replace('IF NOT EXISTS register (', 'register_next (') + '\n')
reg_batch, reg_count = [], 0
def flush_register():
    if reg_batch:
        reg_out.write(f'INSERT INTO register_next ({",".join(REG_COLS)}) VALUES\n' + ',\n'.join(reg_batch) + ';\n')
        reg_batch.clear()

companies, seen_numbers = {}, set()
with zipfile.ZipFile(CH_ZIP) as z:
    member = next(n for n in z.namelist() if n.lower().endswith('.csv'))
    with z.open(member) as raw:
        rd = csv.reader(io.TextIOWrapper(raw, encoding='utf-8', errors='replace', newline=''))
        head = [h.strip() for h in next(rd)]
        ix = {h: i for i, h in enumerate(head)}
        for row in rd:
            if len(row) < len(head): continue
            num = row[ix['CompanyNumber']].strip().upper()
            if not re.fullmatch(r'[A-Z0-9]{8}', num) or num in seen_numbers: continue
            seen_numbers.add(num)
            sic = row[ix['SICCode.SicText_1']].strip()
            m = re.match(r'(\d{5})\s*-\s*(.+)', sic)
            code, text = (m.group(1), m.group(2).strip()) if m else (None, None)
            div = int(code[:2]) if code else None
            if code == '99999': code = text = div = None  # dormant company marker
            pc = row[ix['RegAddress.PostCode']].strip().upper()
            pm = re.match(r'([A-Z]{1,2})\d', pc)
            c = dict(
                name=row[ix['CompanyName']].strip(), status=row[ix['CompanyStatus']].strip() or None,
                sic_code=code, sic_text=text,
                division=f'{div:02d}' if div else None, section=DIV_SECTION.get(div) if div else None,
                postcode_area=pm.group(1) if pm else None,
                incorporated=iso_date(row[ix['IncorporationDate']]))
            if not c['name']: continue
            reg = dict(number=num, name_norm=norm(c['name']), **c)
            reg_batch.append('(' + ','.join(lit(reg[k]) for k in REG_COLS) + ')')
            reg_count += 1
            if len(reg_batch) >= 200: flush_register()
            if num in names: companies[num] = c
flush_register()
for idx in re.findall(r'CREATE INDEX IF NOT EXISTS (\w+) ON register\(([^)]*)\);', schema):
    reg_out.write(f'CREATE INDEX {idx[0]}_{TAG} ON register_next({idx[1]});\n')  # after the rows: faster to build
reg_out.close()

per_company = {}
for rep in reports: per_company[rep['company_number']] = per_company.get(rep['company_number'], 0) + 1
company_rows = []
for num, (_, report_name) in names.items():
    c = companies.get(num) or dict(name=report_name, status=None, sic_code=None, sic_text=None,
                                   division=None, section=None, postcode_area=None, incorporated=None)
    company_rows.append(dict(number=num, name_norm=norm(c['name']), reports=per_company[num], **c))

# ---------- 3. Benchmarks: by year of period end, all / section / division ----------
groups = {}
for rep in reports:
    if not rep['payments_made']: continue
    c = companies.get(rep['company_number'], {})
    keys = ['all'] + ([f"s-{c['section']}"] if c.get('section') else []) + ([f"d-{c['division']}"] if c.get('division') else [])
    for metric in ('days', 'pct_late', 'pct30'):
        v = rep[metric]
        if v is None: continue
        for k in keys: groups.setdefault((k, metric, rep['year']), []).append(v)
bench = []
for (k, metric, year), vals in groups.items():
    n = len(vals)
    if n < 30 and k != 'all': continue
    q = statistics.quantiles(vals, n=4, method='inclusive') if n >= 2 else [vals[0]] * 3
    bench.append(dict(dataset='payments', group_key=k, metric=metric, year=year,
                      median=round(q[1], 1), p25=round(q[0], 1), p75=round(q[2], 1), n=n))
sectors = [dict(code=f's-{s}', name=nm) for s, (nm, _) in SECTIONS.items()]
sectors += [dict(code=f'd-{d:02d}', name=f'SIC division {d:02d}') for d in sorted(DIV_SECTION)]

# ---------- 4. Validation ----------
latest_full_year = datetime.date.today().year - 1
overall = next((b for b in bench if b['group_key'] == 'all' and b['metric'] == 'days' and b['year'] == latest_full_year), None)
matched = sum(1 for c in company_rows if c['number'] in companies)
checks = {
    'reports at least 100,000': len(reports) >= 100_000,
    'companies at least 9,000': len(company_rows) >= 9_000,
    'register at least 4,000,000 companies': reg_count >= 4_000_000,
    'at least 90% of companies found in Companies House data': matched / len(company_rows) >= 0.9,
    'impossible values under 1% of reports': sum(bad.values()) < 0.01 * len(reports),
    f'overall median days for {latest_full_year} between 15 and 60': bool(overall and 15 <= overall['median'] <= 60),
}
report = dict(as_of=TODAY, reports=len(reports), companies=len(company_rows), register=reg_count, matched_in_companies_house=matched,
              benchmarks=len(bench), impossible_values=bad, checks=checks, ok=all(checks.values()),
              overall_median_days=overall, payments_sha256=sha256(PAY_CSV))

# ---------- 5. SQL ----------

def inserts(table, rows, cols, batch=200):
    for i in range(0, len(rows), batch):
        vals = ',\n'.join('(' + ','.join(lit(r[c]) for c in cols) + ')' for r in rows[i:i + batch])
        yield f'INSERT INTO {table} ({",".join(cols)}) VALUES\n{vals};\n'

DATA = ['companies', 'payment_reports', 'benchmarks', 'sectors']
with open(os.path.join(OUT, 'load.sql'), 'w') as out:
    for t in DATA:
        out.write(f'DROP TABLE IF EXISTS {t}_next;\n')
        ddl = re.search(rf'CREATE TABLE IF NOT EXISTS {t} \(.*?\n\);', schema, re.S).group(0)
        out.write(ddl.replace(f'IF NOT EXISTS {t} (', f'{t}_next (') + '\n')
        for idx in re.findall(rf'CREATE INDEX IF NOT EXISTS (\w+) ON {t}\(([^)]*)\);', schema):
            out.write(f'CREATE INDEX {idx[0]}_{TAG} ON {t}_next({idx[1]});\n')
    for t, rows in [('companies', company_rows), ('payment_reports', reports), ('benchmarks', bench), ('sectors', sectors)]:
        cols = list(rows[0].keys())
        for stmt in inserts(f'{t}_next', rows, cols): out.write(stmt)

with open(os.path.join(OUT, 'publish.sql'), 'w') as out:
    for t in DATA + ['register']:
        out.write(f'DROP TABLE IF EXISTS {t}_prev;\nALTER TABLE {t} RENAME TO {t}_prev;\nALTER TABLE {t}_next RENAME TO {t};\n')
    out.write(f"INSERT INTO dataset_versions (dataset, as_of, row_count, checksum, validated, published_at, notes) VALUES "
              f"('payments', {lit(TODAY)}, {len(reports)}, {lit(report['payments_sha256'])}, 1, datetime('now'), "
              f"{lit(f'{len(company_rows)} companies, {len(bench)} benchmarks, {reg_count} on the register')});\n")

json.dump(report, open(os.path.join(OUT, 'report.json'), 'w'), indent=2)
print(json.dumps({k: report[k] for k in ('reports', 'companies', 'register', 'matched_in_companies_house', 'benchmarks', 'impossible_values', 'checks', 'ok')}, indent=2))
