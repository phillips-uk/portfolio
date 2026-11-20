-- Roll back the last published load: the *_prev tables become live again and the bad load is dropped.
-- Run only when *_prev exists (it does after the second publish).
DROP TABLE IF EXISTS companies_bad; ALTER TABLE companies RENAME TO companies_bad; ALTER TABLE companies_prev RENAME TO companies; DROP TABLE companies_bad;
DROP TABLE IF EXISTS payment_reports_bad; ALTER TABLE payment_reports RENAME TO payment_reports_bad; ALTER TABLE payment_reports_prev RENAME TO payment_reports; DROP TABLE payment_reports_bad;
DROP TABLE IF EXISTS benchmarks_bad; ALTER TABLE benchmarks RENAME TO benchmarks_bad; ALTER TABLE benchmarks_prev RENAME TO benchmarks; DROP TABLE benchmarks_bad;
DROP TABLE IF EXISTS register_bad; ALTER TABLE register RENAME TO register_bad; ALTER TABLE register_prev RENAME TO register; DROP TABLE register_bad;
DROP TABLE IF EXISTS sectors_bad; ALTER TABLE sectors RENAME TO sectors_bad; ALTER TABLE sectors_prev RENAME TO sectors; DROP TABLE sectors_bad;
UPDATE dataset_versions SET published_at = NULL, notes = COALESCE(notes, '') || ' (rolled back)'
  WHERE rowid = (SELECT rowid FROM dataset_versions WHERE dataset = 'payments' AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1);
