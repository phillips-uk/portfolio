# Phillips. data service

A read-only API over company-level public data at `data.phillips-uk.com/v1`. Client sites call it server to server
with their own key, held as a Worker secret in their own Cloudflare account. Company data only, never people.
Brief and decisions: vault `01_Phillips/04_Products/Phillips Data Service/`.

## Endpoints (all need `Authorization: Bearer <key>`, except health)

| Endpoint | Returns |
|---|---|
| `GET /v1/health` | `{ ok: true }` |
| `GET /v1/companies/search?q=jaguar` | up to 8 companies that have filed payment reports (2+ characters; a company number also works) |
| `GET /v1/companies/search?q=acme&all=1` | any company on the register (about 5.6 million): name prefix or company number, 8 results in name order; needs `live` or `payments` |
| `GET /v1/companies/{number}/payments` | company basics, latest report, up to 20 past reports, and the benchmark for its SIC division (or section, or all) in the same year |
| `GET /v1/benchmarks?group=s-C&metric=days&year=2025` | medians and quartiles; `group` is `all`, `s-A`..`s-U` or `d-01`..`d-99`; `metric` is `days`, `pct_late` or `pct30` |
| `GET /v1/companies/{number}/live` | Companies House profile, outstanding charges (lenders named only when they are organisations) and the latest accounts' figures and debtor, stock and creditor days when the accounts are machine-readable; cached 24 hours |
| `GET /v1/benchmarks?dataset=accounts&group=s-C&metric=debtor_days` | debtor, stock or creditor days from filed accounts of companies with 10+ staff; groups need 30 companies |
| `GET /v1/companies/{number}/group` | owners that are companies (never individuals), the chain of majority owners up to the top parent, and up to 100 subsidiaries; needs `group` |
| `GET /v1/changes?type=charges&since=2026-11-20&section=F` | newest 100 charges (or `type=insolvency` cases) seen on the Companies House streams since a date; needs `live` |
| `GET /v1/sectors` | SIC 2007 sections and divisions (with each division's section), for industry dropdowns; any active key |
| `GET /v1/rates/sme` | latest Bank of England effective rate on new loans to SMEs (entered by hand) |
| `GET /v1/rates/fx` | ECB reference rates as units per £1; cached 6 hours |

**Plans (scopes in `clients.scopes`):** `payments` (search, payments, payment benchmarks), `live`, `rates`, `accounts`, `group`.
Live lookups share a cap of 20 a minute across all clients, to stay inside Companies House's 600 calls per 5 minutes.

**Which calculator uses what:** debtor days and customer checker: `payments`, `rates/sme`. Asset-based lending,
acquisition and cash cycle: `live` to pre-fill a company's figures, `accounts` benchmarks. Growth gap: `accounts`
benchmarks, `rates/sme`. Import order: `rates/fx`. Recruitment payroll: `payments` benchmarks for division 78 and
the client's industry.

Every response carries `as_of`, `source` and `licence`. Errors: 401 bad key, 403 suspended or not in plan,
429 rate limit (120 a minute per key) or daily quota (per client, default 5,000), 404 unknown company.

## Data

- **Payment practices** (Department for Business and Trade, Open Government Licence v3.0): every report since 2017.
- **Companies House Free Company Data**: name, status, first SIC code, postcode area and incorporation date for every
  company on the register (`register`, about 5.6 million rows, monthly) and for reporting companies (`companies`).
- **Benchmarks**: by year of period end, for all companies, SIC sections and divisions (30 reports or more).

## Monthly refresh

`.github/workflows/data-service-monthly.yml` downloads both files, runs `ingest/build.py`, refuses to publish if
any check fails, then loads `*_next` tables (`load.sql`, then `register-001.sql` onwards, each about 100MB) and swaps them in (`publish.sql`). The previous copy stays as `*_prev`.

**Schema changes on the live database:** run only the new `CREATE` statements. Re-running all of `schema.sql`
adds duplicate indexes to tables that were swapped in (their indexes carry a load tag in the name).

**Rollback:** check `SELECT COUNT(*) FROM companies_prev` is not 0, then
`npx wrangler d1 execute phillips-data --remote --file rollback.sql`.

Run locally: `python3 -I ingest/build.py <payments.csv> <basic.zip> <out-dir>`, then `wrangler d1 execute
phillips-data --local --file <out-dir>/load.sql` and `publish.sql`, then `npx wrangler dev`.

## Accounts figures

`.github/workflows/data-service-accounts-daily.yml` reads each day's Companies House accounts bulk file, keeps
every machine-readable filing of any size (`ingest/accounts.py`), upserts them into `accounts_facts` with SIC codes from
`register` (no API calls), and rebuilds `accounts_benchmarks` from companies with 10 or more staff (last four years). A manual run can backfill a list of past files.
`ingest/ixbrl.py` and `src/ixbrl.js` read accounts the same way; change both together.

## Group structures

`.github/workflows/data-service-groups.yml` downloads the Companies House PSC snapshot weekly (33 files of about 80MB),
runs `ingest/groups.py` (corporate owners only; individual records are skipped), refuses to publish if a check fails,
loads `owners-NNN.sql` and swaps `company_owners` in.

## Companies House streams

The Worker's scheduled handler runs every 10 minutes (`src/stream.js`): it resumes the charges, insolvency-cases and
companies streams from their saved timepoints (`stream_state`), reads until each goes quiet for 30 seconds or 4 minutes
pass, and closes (two connections at most). Charges and insolvency cases go into their own tables; company profile
changes update `register`. Secret `CH_STREAM_KEY` is a streaming key from the Developer Hub (not the REST key).
Officer and PSC streams are not read (people).

## Insolvency notices

`.github/workflows/data-service-gazette.yml` reads The Gazette's insolvency notice feed nightly (22:30 UTC, inside its
9pm to 7am window, 2.5 seconds between requests, User-Agent from the repository variable `GAZETTE_UA`). Corporate
notices only, kept only when they match a company on the register. The live lookup returns the latest 10.

## Bank of England SME rate

The Bank blocks automated downloads. Once a month, check the figure on the Bank's release and run
`node scripts/set-rate.mjs 2026-09 <percent> "<release>" "<https://www.bankofengland.co.uk/...>" --remote`.

## Keys

`node scripts/new-key.mjs <client-id> "<Client name>" [--remote]` creates the client if new and a key. The key is
written once to `.keys/` (git-ignored, owner-only) and never printed; only its SHA-256 hash is stored. Suspend a
client: `UPDATE clients SET status = 'suspended' WHERE id = '...'`. Revoke a key: set `revoked_at`.
