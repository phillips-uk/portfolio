// Create a client (if new) and a fresh API key for it.
//   node scripts/new-key.mjs <client-id> "<Client name>" [--remote]
// The key is written once to data-service/.keys/<client-id>-<date>.txt (git-ignored, owner-only) for copying into
// the client's Worker secret; only its SHA-256 hash goes into the database. The key is never printed.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const [id, name, flag] = process.argv.slice(2);
if (!/^[a-z0-9-]{2,40}$/.test(id || '') || !name) {
  console.error('Usage: node scripts/new-key.mjs <client-id> "<Client name>" [--remote]');
  process.exit(1);
}
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const key = 'pd_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const now = new Date().toISOString();
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const sql = `INSERT OR IGNORE INTO clients (id, name, created_at) VALUES (${q(id)}, ${q(name)}, ${q(now)});
INSERT INTO api_keys (key_hash, client_id, label, created_at) VALUES (${q(hash)}, ${q(id)}, ${q('created ' + now.slice(0, 10))}, ${q(now)});
INSERT INTO audit_log (at, who, what, after) VALUES (${q(now)}, 'new-key script', 'key created', ${q(id)});`;
const tmp = join(tmpdir(), `pd-key-${process.pid}.sql`);
writeFileSync(tmp, sql, { mode: 0o600 });
try {
  execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'phillips-data', flag === '--remote' ? '--remote' : '--local', '--file', tmp],
    { cwd: here, stdio: ['ignore', 'ignore', 'inherit'] });
} finally { rmSync(tmp, { force: true }); }
mkdirSync(join(here, '.keys'), { recursive: true, mode: 0o700 });
const out = join(here, '.keys', `${id}-${now.slice(0, 10)}${flag === '--remote' ? '' : '-local'}.txt`);
writeFileSync(out, key + '\n', { mode: 0o600 });
console.log(`Key created for ${id} (${flag === '--remote' ? 'live' : 'local'}). Saved to ${out}; copy it into the client's Worker secret, then delete the file.`);
