"""Corporate insolvency notices from The Gazette, newest first, back to a given date.

  GAZETTE_UA="App/1.0 (+contact URL)" python3 -I gazette.py <since YYYY-MM-DD> <out.sql>

Source: https://www.thegazette.co.uk/insolvency/notice/data.json (Crown copyright, Open Government Licence v3.0;
the licence does not cover personal data). Fair use policy (https://www.thegazette.co.uk/fair-use-policy): run between
9pm and 7am UK time, at most 5 requests every 10 seconds, honour 429 Retry-After, identify the app and a contact in the
User-Agent. This script waits 2.5 seconds between requests.

Company data only: corporate notice codes (24xx) are kept; personal insolvency (25xx) is skipped. Only the notice id,
code, type, date, link, company name and number are read. The SQL keeps a notice only when it matches a company on
the register (by number, else by exact name), so sole traders and partnerships never stay in the table.
"""
import json, os, re, sys, time, urllib.error, urllib.request

SINCE, OUT = sys.argv[1], sys.argv[2]
UA = os.environ.get('GAZETTE_UA', '').strip()
if not UA: sys.exit('Set GAZETTE_UA: application name/version and a contact URL, per the Gazette fair use policy')
BASE = 'https://www.thegazette.co.uk/insolvency/notice/data.json?results-page-size=100&results-page='
NUMBER = re.compile(r'Company\s+(?:Registration\s+)?(?:Number|No\.?)\s*:?\s*\(?\s*([A-Z]{0,2}\s?\d{5,8})', re.I)


def norm(name): return re.sub(r'[^A-Z0-9]', '', (name or '').upper())


def lit(v): return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def fetch(page):
    for attempt in range(5):
        req = urllib.request.Request(BASE + str(page), headers={'User-Agent': UA, 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get('Retry-After') or 60)); continue
            if e.code >= 500: time.sleep(30); continue
            raise
        except (urllib.error.URLError, TimeoutError): time.sleep(30)
    raise SystemExit(f'gave up on page {page}')


rows, page, oldest, seen = [], 1, None, 0
while True:
    data = fetch(page)
    entries = data.get('entry') or []
    if isinstance(entries, dict): entries = [entries]
    if not entries: break
    for e in entries:
        seen += 1
        published = (e.get('published') or '')[:10]
        oldest = published
        code = str(e.get('f:notice-code') or '')
        if not code.startswith('24') or published < SINCE: continue
        nid = (e.get('id') or '').rsplit('/', 1)[-1]
        if not nid.isdigit(): continue
        cat = e.get('category')
        cat = cat.get('@term') if isinstance(cat, dict) else None
        m = NUMBER.search(e.get('content') or '')
        num = re.sub(r'\s', '', m.group(1)).upper() if m else None
        if num:
            prefix = re.match(r'[A-Z]*', num).group(0)
            num = prefix + num[len(prefix):].zfill(8 - len(prefix)) if len(num) <= 8 else None
        rows.append((int(nid), num, (e.get('title') or '').strip(), code, cat, published))
    if oldest and oldest < SINCE: break
    page += 1
    time.sleep(2.5)

with open(OUT, 'w') as out:
    out.write('DROP TABLE IF EXISTS gazette_staging;\nCREATE TABLE gazette_staging (notice_id INTEGER PRIMARY KEY, company_number TEXT, '
              'company_name TEXT, name_norm TEXT, notice_code TEXT, notice_type TEXT, published TEXT);\n')
    for i in range(0, len(rows), 200):
        vals = ',\n'.join(f'({nid},{lit(num)},{lit(name)},{lit(norm(name))},{lit(code)},{lit(cat)},{lit(pub)})'
                          for nid, num, name, code, cat, pub in rows[i:i + 200])
        out.write('INSERT OR IGNORE INTO gazette_staging (notice_id, company_number, company_name, name_norm, notice_code, '
                  f'notice_type, published) VALUES\n{vals};\n')
    # Keep only notices about companies on the register: by number, else by exact normalised name.
    out.write("UPDATE gazette_staging SET company_number = NULL WHERE company_number IS NOT NULL AND company_number NOT IN "
              "(SELECT number FROM register WHERE number = gazette_staging.company_number);\n"
              "UPDATE gazette_staging SET company_number = (SELECT number FROM register r WHERE r.name_norm = gazette_staging.name_norm) "
              "WHERE company_number IS NULL;\n"
              "INSERT OR REPLACE INTO insolvency_notices (notice_id, company_number, notice_code, notice_type, published) "
              "SELECT notice_id, company_number, notice_code, notice_type, published FROM gazette_staging WHERE company_number IS NOT NULL;\n"
              "DROP TABLE gazette_staging;\n")
print(json.dumps({'since': SINCE, 'pages': page, 'entries_read': seen, 'corporate_notices': len(rows),
                  'with_number_in_text': sum(1 for r in rows if r[1])}))
