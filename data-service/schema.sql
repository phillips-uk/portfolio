-- Phillips. data service (D1). Company-level public data only: never people.
-- Data tables are loaded as *_next by the ingest job, validated, then swapped in by publish.sql.
-- The previous copy is kept as *_prev so a bad load can be rolled back with rollback.sql.

CREATE TABLE IF NOT EXISTS companies (
  number TEXT PRIMARY KEY,          -- Companies House number, 8 characters
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,          -- upper case, letters and digits only, for search
  status TEXT,                      -- from Companies House; NULL when not in the live register
  sic_code TEXT, sic_text TEXT,     -- first SIC code
  division TEXT, section TEXT,      -- SIC 2007 division (2 digits) and section (letter)
  postcode_area TEXT,               -- letters of the registered office postcode, e.g. CB
  incorporated TEXT,
  reports INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS companies_name ON companies(name_norm);

-- Every company on the live register (Companies House Free Company Data Product, about 5.6 million), refreshed
-- monthly with the payments load. Gives search across all companies and SIC codes for the accounts job.
CREATE TABLE IF NOT EXISTS register (
  number TEXT PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, status TEXT,
  sic_code TEXT, division TEXT, section TEXT, postcode_area TEXT, incorporated TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS register_name ON register(name_norm);

-- Current owners of each company that are themselves companies or other legal persons, from the Companies House
-- PSC snapshot (weekly). Individuals are never stored. owner_number is set when the owner is a UK company.
CREATE TABLE IF NOT EXISTS company_owners (
  company_number TEXT NOT NULL, owner_name TEXT, owner_number TEXT, owner_country TEXT, owner_kind TEXT,
  control TEXT, notified_on TEXT
);
CREATE INDEX IF NOT EXISTS company_owners_company ON company_owners(company_number);
CREATE INDEX IF NOT EXISTS company_owners_owner ON company_owners(owner_number);

-- Corporate insolvency notices from The Gazette (daily), only for companies on the register. No personal data.
CREATE TABLE IF NOT EXISTS insolvency_notices (
  notice_id INTEGER PRIMARY KEY, company_number TEXT NOT NULL, notice_code TEXT, notice_type TEXT, published TEXT
);
CREATE INDEX IF NOT EXISTS insolvency_notices_company ON insolvency_notices(company_number, published);
CREATE INDEX IF NOT EXISTS insolvency_notices_published ON insolvency_notices(published);

-- Companies House streams, caught up every 10 minutes by the scheduled handler (src/stream.js).
-- Charges as they are created or satisfied; holders kept only when they are organisations.
CREATE TABLE IF NOT EXISTS charges (
  charge_id TEXT PRIMARY KEY, company_number TEXT NOT NULL, status TEXT, created_on TEXT, delivered_on TEXT,
  satisfied_on TEXT, kind TEXT, holders TEXT, holders_not_listed INTEGER, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS charges_company ON charges(company_number);
CREATE INDEX IF NOT EXISTS charges_updated ON charges(updated_at);
-- Insolvency cases: status, case types, numbers and dates. Practitioners are never stored.
CREATE TABLE IF NOT EXISTS insolvency_cases (
  company_number TEXT PRIMARY KEY, status TEXT, cases TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS insolvency_cases_updated ON insolvency_cases(updated_at);
CREATE TABLE IF NOT EXISTS stream_runs (
  run_at TEXT, stream TEXT, status INTEGER, events INTEGER, timepoint INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS stream_state (
  stream TEXT PRIMARY KEY, timepoint INTEGER, published_at TEXT, updated_at TEXT, events INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_reports (
  report_id INTEGER PRIMARY KEY,
  company_number TEXT NOT NULL,
  regime TEXT,
  period_start TEXT, period_end TEXT, filed TEXT, year INTEGER,
  payments_made INTEGER,            -- 0 when the company made no qualifying payments in the period
  days INTEGER,                     -- average time to pay
  pct30 INTEGER, pct60 INTEGER, pct_over60 INTEGER,
  pct_late INTEGER,                 -- share of invoices not paid within agreed terms
  pct_dispute INTEGER,
  terms_shortest INTEGER, terms_longest INTEGER, terms_max INTEGER,
  payment_code TEXT, e_invoicing INTEGER, scf INTEGER
);
CREATE INDEX IF NOT EXISTS reports_company ON payment_reports(company_number, period_end);

CREATE TABLE IF NOT EXISTS benchmarks (
  dataset TEXT NOT NULL,            -- 'payments'
  group_key TEXT NOT NULL,          -- 'all', 's-C' (section), 'd-29' (division)
  metric TEXT NOT NULL,             -- 'days', 'pct_late', 'pct30'
  year INTEGER NOT NULL,            -- year the reporting period ended
  median REAL, p25 REAL, p75 REAL, n INTEGER NOT NULL,
  PRIMARY KEY (dataset, group_key, metric, year)
);

CREATE TABLE IF NOT EXISTS sectors (
  code TEXT PRIMARY KEY,            -- 's-C' or 'd-29'
  name TEXT NOT NULL
);

-- Entered by hand once a month (the Bank of England blocks automated downloads). See scripts/set-rate.mjs.
CREATE TABLE IF NOT EXISTS rates (
  series TEXT NOT NULL,             -- 'boe-sme-new-loans'
  month TEXT NOT NULL,              -- '2026-09'
  value REAL NOT NULL,              -- per cent a year
  release TEXT, source_url TEXT NOT NULL, entered_by TEXT NOT NULL, entered_at TEXT NOT NULL,
  PRIMARY KEY (series, month)
);

-- Headline figures from every machine-readable filed account (bulk iXBRL files, all company sizes). Appended daily;
-- never swapped, so a monthly payments publish leaves them alone. The live lookup uses these before fetching a document.
CREATE TABLE IF NOT EXISTS accounts_facts (
  company_number TEXT NOT NULL, period_end TEXT NOT NULL,
  employees INTEGER, turnover REAL, cost_of_sales REAL, trade_debtors REAL, debtors REAL, stock REAL,
  trade_creditors REAL, cash REAL, creditors_within_year REAL, fixed_assets REAL, net_assets REAL,
  sic_code TEXT, division TEXT, section TEXT, source_file TEXT NOT NULL,
  -- The comparative column of the same filing (about a year earlier), for year-on-year health signals.
  prior_period_end TEXT, prior_turnover REAL, prior_cash REAL, prior_net_assets REAL, prior_trade_debtors REAL, prior_employees REAL,
  PRIMARY KEY (company_number, period_end)
);
CREATE INDEX IF NOT EXISTS accounts_facts_section ON accounts_facts(section, period_end);
CREATE INDEX IF NOT EXISTS accounts_facts_source ON accounts_facts(source_file);
-- The live lookup reads stored figures first (accounts_facts PRIMARY KEY covers company_number lookups).

-- Debtor, stock and creditor days by group, from accounts_facts. Rebuilt in full by ingest/accounts_benchmarks.py.
CREATE TABLE IF NOT EXISTS accounts_benchmarks (
  group_key TEXT NOT NULL, metric TEXT NOT NULL, year INTEGER NOT NULL,
  median REAL, p25 REAL, p75 REAL, n INTEGER NOT NULL,
  PRIMARY KEY (group_key, metric, year)
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset TEXT NOT NULL, as_of TEXT NOT NULL, row_count INTEGER NOT NULL, checksum TEXT NOT NULL,
  validated INTEGER NOT NULL, published_at TEXT, notes TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active, overdue, suspended
  plan TEXT, monthly_fee REAL, scopes TEXT NOT NULL DEFAULT '["payments"]',
  daily_quota INTEGER NOT NULL DEFAULT 5000,
  billing_ref TEXT, notes TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,        -- SHA-256 hex of the key; the key itself is never stored
  client_id TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  client_id TEXT NOT NULL, endpoint TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, endpoint, day)
);

CREATE TABLE IF NOT EXISTS audit_log (
  at TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, before TEXT, after TEXT
);
