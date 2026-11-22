-- Accounts (Accounts Plan, 22 Nov 2026). Optional: every free check works without one.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                 -- random, never shown
  email TEXT NOT NULL UNIQUE,          -- lower case
  name TEXT,
  google_sub TEXT,                     -- set when they sign in with Google
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  emails_ok INTEGER NOT NULL DEFAULT 0 -- ticked "email me a monthly re-check" (step 4)
);

-- Sign-in links: only a hash of the token is kept; each works once, for 20 minutes.
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  next TEXT                            -- where to go after signing in (a path on this site)
);
CREATE INDEX login_links_email ON login_links (email, created_at);

-- Checks kept with an account: a Website Check (report id) or a Google Ads Check, with its area scores for the dashboard.
CREATE TABLE checks (
  id TEXT NOT NULL,                    -- the report id
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,                  -- 'website' | 'ads'
  domain TEXT NOT NULL,                -- the site, or the Ads account's name
  model TEXT,
  checked_at TEXT NOT NULL,
  scores TEXT,                         -- JSON: [{ id, score }]
  fixes INTEGER,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX checks_account ON checks (account_id, checked_at);

-- Emails sent per London month: stops at the cap so email never costs anything.
CREATE TABLE email_months (
  month TEXT PRIMARY KEY,              -- YYYY-MM
  n INTEGER NOT NULL DEFAULT 0
);
