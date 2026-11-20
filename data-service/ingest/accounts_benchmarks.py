"""Rebuild accounts_benchmarks from accounts_facts.

  python3 -I accounts_benchmarks.py <facts.json> <out.sql>

<facts.json> is the output of:
  wrangler d1 execute phillips-data --remote --json --command "SELECT period_end, turnover, cost_of_sales,
    trade_debtors, stock, trade_creditors, division, section FROM accounts_facts"
Groups: all, SIC section, SIC division; year of the accounts date. A group needs 30 companies to be published.
Values beyond 365 days are left out as filing errors or unusual businesses.
"""
import datetime, json, statistics, sys

MIN_N = int(sys.argv[sys.argv.index('--min-n') + 1]) if '--min-n' in sys.argv else 30  # lower only for tests
data = json.load(open(sys.argv[1]))
rows = data[0]['results'] if isinstance(data, list) else data
groups = {}
for r in rows:
    year = int(r['period_end'][:4])
    keys = ['all'] + ([f"s-{r['section']}"] if r.get('section') else []) + ([f"d-{r['division']}"] if r.get('division') else [])
    def add(metric, num, den):
        if num is None or not den or den <= 0: return
        d = 365 * num / den
        if 0 <= d <= 365:
            for k in keys: groups.setdefault((k, metric, year), []).append(d)
    add('debtor_days', r.get('trade_debtors'), r.get('turnover'))
    add('stock_days', r.get('stock'), r.get('cost_of_sales'))
    add('creditor_days', r.get('trade_creditors'), r.get('cost_of_sales'))

out_rows = []
for (k, metric, year), v in sorted(groups.items()):
    if len(v) < MIN_N: continue
    q = statistics.quantiles(v, n=4, method='inclusive')
    out_rows.append((k, metric, year, round(q[1], 1), round(q[0], 1), round(q[2], 1), len(v)))

lit = lambda s: "'" + str(s).replace("'", "''") + "'"
today = datetime.date.today().isoformat()
with open(sys.argv[2], 'w') as out:
    out.write('DELETE FROM accounts_benchmarks;\n')
    for i in range(0, len(out_rows), 200):
        vals = ',\n'.join(f'({lit(k)},{lit(m)},{y},{md},{p25},{p75},{n})' for k, m, y, md, p25, p75, n in out_rows[i:i + 200])
        out.write(f'INSERT INTO accounts_benchmarks (group_key, metric, year, median, p25, p75, n) VALUES\n{vals};\n')
    out.write(f"INSERT INTO dataset_versions (dataset, as_of, row_count, checksum, validated, published_at, notes) VALUES "
              f"('accounts', {lit(today)}, {len(rows)}, '', 1, datetime('now'), {lit(f'{len(out_rows)} benchmarks')});\n")
print(json.dumps({'facts': len(rows), 'benchmarks': len(out_rows)}))
