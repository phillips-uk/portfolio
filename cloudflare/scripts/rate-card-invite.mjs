#!/usr/bin/env node
// Makes a private rate card invite link.
//   node cloudflare/scripts/rate-card-invite.mjs <who> [days]
//   e.g. node cloudflare/scripts/rate-card-invite.mjs champagne-house 30
// <who> is a short label (a-z, 0-9, dashes) that shows in the Worker logs when the link is opened.
// The signing key lives in the macOS Keychain (service "phillips-rate-card-key") and as the RATE_CARD_KEY Worker secret.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const [label, daysArg] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]{1,40}$/.test(label)) {
  console.error('Usage: node cloudflare/scripts/rate-card-invite.mjs <who> [days]   (who: a-z, 0-9 and dashes)');
  process.exit(1);
}
const days = Number(daysArg || 30);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error('days must be a whole number from 1 to 365');
  process.exit(1);
}

let key;
try {
  key = execFileSync('security', ['find-generic-password', '-s', 'phillips-rate-card-key', '-w'], { encoding: 'utf8' }).trim();
} catch {
  console.error('Signing key not found in the Keychain (service "phillips-rate-card-key").');
  process.exit(1);
}

const expiryDay = Math.floor(Date.now() / 86400000) + days;
const sig = createHmac('sha256', key).update(`${label}.${expiryDay}`).digest('base64url').slice(0, 22);
const expires = new Date(expiryDay * 86400000).toISOString().slice(0, 10);

console.log(`https://www.phillips-uk.com/rate-card?invite=${label}.${expiryDay}.${sig}`);
console.log(`Opens until ${expires}. To revoke it, add "${label}" to RATE_CARD_REVOKED in wrangler.jsonc and deploy.`);
