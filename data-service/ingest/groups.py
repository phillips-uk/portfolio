"""Build company ownership (group structure) tables from the Companies House PSC snapshot.

  python3 -I groups.py <out-dir> <psc-snapshot-..._1ofN.zip> [more parts ...]

Source: https://download.companieshouse.gov.uk/en_pscdata.html (free, daily, JSON lines, Open Government Licence v3.0).
Company data only: we keep owners that are companies or other legal persons, and skip every record about an
individual (kind "individual-...") without reading it further. Ceased owners are left out.

Writes to <out-dir>:
  owners-NNN.sql  creates and fills company_owners_next, in files of about 100MB
  publish.sql     swaps company_owners_next in, keeping company_owners_prev
  report.json     counts and checks; do not publish if "ok" is false
"""
import datetime, json, os, re, sys, zipfile

OUT, PARTS = sys.argv[1], sys.argv[2:]
os.makedirs(OUT, exist_ok=True)
TAG = 'v' + datetime.datetime.now().strftime('%Y%m%d%H%M%S')
UK = re.compile(r'united kingdom|england|wales|scotland|northern ireland|great britain|\buk\b|companies house|cardiff', re.I)
CH_NUMBER = re.compile(r'^(SC|NI|OC|SO|NC|R0|LP|SL|NL|FC|SF|NF|GE|IP|SP|RS|NP|IC|SI|NO|NV|NA|SA|SE|SR|ES|NR|RC|IS|FE|GS|AC|ZC|SZ|NZ|SG|SN|CE|CS)?(\d{1,8})$')


def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, int): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def owner_number(ident):
    """Companies House number for a UK-registered owner, normalised to 8 characters, else None."""
    reg = re.sub(r'[\s.\-/]', '', (ident.get('registration_number') or '')).upper()
    where = ' '.join(str(ident.get(k) or '') for k in ('country_registered', 'place_registered', 'legal_authority'))
    m = CH_NUMBER.match(reg)
    if not m or not UK.search(where): return None
    prefix, digits = m.group(1) or '', m.group(2)
    width = 8 - len(prefix)
    if len(digits) > width: return None
    return prefix + digits.zfill(width)


def control(natures):
    """Shorten natures of control to the share band, e.g. '75-100', plus flags for votes and board control."""
    out = []
    for n in natures or []:
        m = re.search(r'ownership-of-shares-(\d+)-to-(\d+)-percent', n)
        if m and f'shares {m.group(1)}-{m.group(2)}%' not in out: out.append(f'shares {m.group(1)}-{m.group(2)}%')
    if any('voting-rights' in n for n in natures or []): out.append('votes')
    if any('appoint-and-remove-directors' in n for n in natures or []): out.append('board')
    if any('significant-influence' in n for n in natures or []): out.append('influence')
    return ', '.join(out) or None


class ChunkedSQL:
    def __init__(self, limit=100_000_000):
        self.limit, self.n, self.f = limit, 0, None
        self.next()
    def next(self):
        if self.f: self.f.close()
        self.n += 1
        self.f, self.size = open(os.path.join(OUT, f'owners-{self.n:03d}.sql'), 'w'), 0
    def write(self, stmt):
        if self.size and self.size + len(stmt) > self.limit: self.next()
        self.f.write(stmt); self.size += len(stmt)
    def close(self): self.f.close()


COLS = ['company_number', 'owner_name', 'owner_number', 'owner_country', 'owner_kind', 'control', 'notified_on']
schema = open(os.path.join(os.path.dirname(__file__), '..', 'schema.sql')).read()
ddl = re.search(r'CREATE TABLE IF NOT EXISTS company_owners \(.*?\n\);', schema, re.S).group(0)
out = ChunkedSQL()
out.write('DROP TABLE IF EXISTS company_owners_next;\n' + ddl.replace('IF NOT EXISTS company_owners (', 'company_owners_next (') + '\n')

counts = dict(lines=0, individuals_skipped=0, ceased=0, kept=0, with_number=0, bad_lines=0)
batch = []
def flush():
    if batch:
        out.write(f'INSERT INTO company_owners_next ({",".join(COLS)}) VALUES\n' + ',\n'.join(batch) + ';\n')
        batch.clear()

for part in PARTS:
    with zipfile.ZipFile(part) as z:
        for name in z.namelist():
            with z.open(name) as f:
                for raw in f:
                    counts['lines'] += 1
                    try: rec = json.loads(raw)
                    except ValueError:
                        counts['bad_lines'] += 1; continue
                    d = rec.get('data', rec) if isinstance(rec, dict) else {}
                    kind = d.get('kind') or ''
                    if not ('corporate-entity' in kind or 'legal-person' in kind):
                        if kind.startswith('individual'): counts['individuals_skipped'] += 1
                        continue
                    if d.get('ceased_on') or d.get('ceased'):
                        counts['ceased'] += 1; continue
                    company = (rec.get('company_number') or '').strip().upper()
                    if not company:
                        m = re.match(r'/company/([A-Z0-9]{8})/', (d.get('links') or {}).get('self', ''), re.I)
                        company = m.group(1).upper() if m else ''
                    if not re.fullmatch(r'[A-Z0-9]{8}', company): continue
                    ident = d.get('identification') or {}
                    num = owner_number(ident)
                    row = dict(company_number=company, owner_name=' '.join((d.get('name') or '').split()) or None,
                               owner_number=num, owner_country=ident.get('country_registered') or ident.get('place_registered'),
                               owner_kind='legal person' if 'legal-person' in kind else 'company',
                               control=control(d.get('natures_of_control')), notified_on=d.get('notified_on'))
                    counts['kept'] += 1
                    counts['with_number'] += 1 if num else 0
                    batch.append('(' + ','.join(lit(row[c]) for c in COLS) + ')')
                    if len(batch) >= 200: flush()
flush()
for idx in re.findall(r'CREATE INDEX IF NOT EXISTS (\w+) ON company_owners\(([^)]*)\);', schema):
    out.write(f'CREATE INDEX {idx[0]}_{TAG} ON company_owners_next({idx[1]});\n')
out.close()

checks = {
    'at least 100,000 corporate owners': counts['kept'] >= 100_000,
    'unreadable lines under 0.1%': counts['bad_lines'] <= 0.001 * max(counts['lines'], 1),
    'at least half the owners link to a UK company number': counts['with_number'] >= 0.5 * max(counts['kept'], 1),
}
report = dict(as_of=datetime.date.today().isoformat(), parts=len(PARTS), **counts, checks=checks, ok=all(checks.values()))
with open(os.path.join(OUT, 'publish.sql'), 'w') as f:
    f.write('DROP TABLE IF EXISTS company_owners_prev;\nALTER TABLE company_owners RENAME TO company_owners_prev;\n'
            'ALTER TABLE company_owners_next RENAME TO company_owners;\n'
            f"INSERT INTO dataset_versions (dataset, as_of, row_count, checksum, validated, published_at, notes) VALUES "
            f"('groups', {lit(report['as_of'])}, {counts['kept']}, '', 1, datetime('now'), {lit(str(counts['with_number']) + ' with a UK company number')});\n")
json.dump(report, open(os.path.join(OUT, 'report.json'), 'w'), indent=2)
print(json.dumps(report, indent=2))
