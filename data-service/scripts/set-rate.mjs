// Enter the Bank of England SME rate for a month, after checking it by eye on the Bank's release.
//   node scripts/set-rate.mjs 2026-09 6.55 "<release name>" "<source URL>" [--remote]
// The Bank blocks automated downloads, so this is the only way the figure gets in. Every entry is audit-logged.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const [month, value, release, url, flag] = process.argv.slice(2);
if (!/^\d{4}-\d{2}$/.test(month || '') || !(Number(value) > 0 && Number(value) < 30) || !/^https:\/\/www\.bankofengland\.co\.uk\//.test(url || '')) {
  console.error('Usage: node scripts/set-rate.mjs <YYYY-MM> <percent> "<release>" "<https://www.bankofengland.co.uk/...>" [--remote]');
  process.exit(1);
}
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const now = new Date().toISOString();
const sql = `INSERT INTO rates (series, month, value, release, source_url, entered_by, entered_at)
VALUES ('boe-sme-new-loans', ${q(month)}, ${Number(value)}, ${q(release || '')}, ${q(url)}, 'Lewis', ${q(now)})
ON CONFLICT (series, month) DO UPDATE SET value = excluded.value, release = excluded.release, source_url = excluded.source_url, entered_at = excluded.entered_at;
INSERT INTO audit_log (at, who, what, after) VALUES (${q(now)}, 'Lewis', 'SME rate entered', ${q(`${month} ${value}`)});`;
const tmp = join(tmpdir(), `pd-rate-${process.pid}.sql`);
writeFileSync(tmp, sql);
try {
  execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'phillips-data', flag === '--remote' ? '--remote' : '--local', '--file', tmp],
    { cwd: dirname(dirname(fileURLToPath(import.meta.url))), stdio: ['ignore', 'ignore', 'inherit'] });
} finally { rmSync(tmp, { force: true }); }
console.log(`SME rate for ${month} set to ${value}% (${flag === '--remote' ? 'live' : 'local'}).`);
