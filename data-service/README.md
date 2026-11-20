# Phillips. data service

A read-only API over company-level public data at `data.phillips-uk.com/v1`. Client sites call it server to server
with their own key, held as a Worker secret in their own Cloudflare account. Company data only, never people.
Brief and decisions: vault `01_Phillips/04_Products/Phillips Data Service/`.

## Endpoints (all need `Authorization: Bearer <key>`, except health)

| Endpoint | Returns |
|---|---|
| `GET /v1/health` | `{ ok: true }` |
| `GET /v1/companies/search?q=jaguar` | up to 8 companies that have filed payment reports (2+ characters; a company number also works) |
| `GET /v1/companies/{number}/payments` | company basics, latest report, up to 20 past reports, and the benchmark for its SIC division (or section, or all) in the same year |
| `GET /v1/benchmarks?group=s-C&metric=days&year=2025` | medians and quartiles; `group` is `all`, `s-A`..`s-U` or `d-01`..`d-99`; `metric` is `days`, `pct_late` or `pct30` |

Every response carries `as_of`, `source` and `licence`. Errors: 401 bad key, 403 suspended or not in plan,
429 rate limit (120 a minute per key) or daily quota (per client, default 5,000), 404 unknown company.

## Data

- **Payment practices** (Department for Business and Trade, Open Government Licence v3.0): every report since 2017.
- **Companies House Free Company Data**: name, status, first SIC code, postcode area and incorporation date, for
  reporting companies only.
- **Benchmarks**: by year of period end, for all companies, SIC sections and divisions (30 reports or more).

## Monthly refresh

`.github/workflows/data-service-monthly.yml` downloads both files, runs `ingest/build.py`, refuses to publish if
any check fails, then loads `*_next` tables and swaps them in (`publish.sql`). The previous copy stays as `*_prev`.

**Rollback:** check `SELECT COUNT(*) FROM companies_prev` is not 0, then
`npx wrangler d1 execute phillips-data --remote --file rollback.sql`.

Run locally: `python3 -I ingest/build.py <payments.csv> <basic.zip> <out-dir>`, then `wrangler d1 execute
phillips-data --local --file <out-dir>/load.sql` and `publish.sql`, then `npx wrangler dev`.

## Keys

`node scripts/new-key.mjs <client-id> "<Client name>" [--remote]` creates the client if new and a key. The key is
written once to `.keys/` (git-ignored, owner-only) and never printed; only its SHA-256 hash is stored. Suspend a
client: `UPDATE clients SET status = 'suspended' WHERE id = '...'`. Revoke a key: set `revoked_at`.
