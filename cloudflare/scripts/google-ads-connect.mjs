#!/usr/bin/env node
// One-off: connect the free tools' Google Ads Check to the "Phillips Tools" Cloud project (phillips-tools-uk).
// Lewis runs this himself on his Mac. It never prints a secret.
//
//   node cloudflare/scripts/google-ads-connect.mjs ~/Downloads/client_secret_<...>.json
//
// 1. Reads the OAuth client file downloaded from Google Auth Platform > Clients (a "Web application" client whose
//    authorised redirect URIs include http://localhost:8765/oauth2callback).
// 2. Opens Google's sign-in in the browser. Sign in with the login that manages the Phillips. manager account
//    (495-618-4074) and allow access to Google Ads. Google may first say the app isn't verified yet: press Advanced,
//    then continue to Phillips.
// 3. Checks the new credentials can read the manager account through the API, without the old developer token.
// 4. Only if that works: stores GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN as secrets on
//    the phillips-uk Worker (piped into wrangler), and deletes the old GOOGLE_ADS_DEVELOPER_TOKEN, which belongs to the
//    automation's project. If the check fails, nothing on the Worker changes.
// Afterwards, delete the downloaded client file.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const MANAGER = '4956184074';
const API = 'https://googleads.googleapis.com/v24';
const ACCOUNT = '9cd423eee8986ecc6f22f6fa3a17878b';
const WORKER = 'phillips-uk';

const fail = msg => { console.error('\nStopped: ' + msg + '\nNothing on the Worker was changed.'); process.exit(1); };

// ---------- 1. the client file ----------
const file = process.argv[2];
if (!file) fail('give the path of the client file, e.g. node cloudflare/scripts/google-ads-connect.mjs ~/Downloads/client_secret_123.json');
let client;
try { client = JSON.parse(readFileSync(file, 'utf8')).web; } catch { fail('could not read that file as a Google OAuth client file.'); }
if (!client || !client.client_id || !client.client_secret) fail('that file is not a "Web application" client. Create the client as Web application.');
if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(client.client_id)) fail('the client ID in that file does not look right.');
if (!(client.redirect_uris || []).includes(REDIRECT)) fail(`the client has no authorised redirect URI ${REDIRECT}. Add it in the console, save, download the file again.`);
console.log('Client file read (project ' + (client.project_id || 'unknown') + ').');

// ---------- 2. sign in ----------
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');
const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/adwords',
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
});

const code = await new Promise((resolve) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
    const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:Helvetica,Arial,sans-serif;padding:48px;color:#1A1A1A"><h1 style="font-size:24px">${title}</h1><p>${text}</p></body>`;
    if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('That didn’t work', 'Google did not send a sign-in code (' + (u.searchParams.get('error') || 'no code') + '). Go back to the terminal.'));
      server.close();
      fail('Google did not return a sign-in code (' + (u.searchParams.get('error') || 'no code') + ').');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Signed in', 'You can close this tab and go back to the terminal.'));
    server.close();
    resolve(u.searchParams.get('code'));
  });
  server.listen(PORT, 'localhost', () => {
    console.log('\nOpening Google sign-in in your browser. If it does not open, copy this address into the browser:\n' + auth + '\n');
    spawn('open', [auth], { stdio: 'ignore' });
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
});
const tokens = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !tokens.refresh_token) fail('Google did not give a refresh token (' + (tokens.error || tokenRes.status) + '). Run the script again; it asks Google for a fresh one each time.');
if (!String(tokens.scope || '').includes('auth/adwords')) fail('the Google Ads permission was not ticked on the consent screen. Run it again and allow access to Google Ads.');
console.log('Signed in, refresh token received (not shown).');

// ---------- 3. check it can read the manager account, with no developer token ----------
const errCode = text => { try { const e = JSON.parse(text); const x = (Array.isArray(e) ? e[0] : e).error; const d = (x.details || []).flatMap(v => v.errors || [])[0]; return (d && Object.values(d.errorCode || {})[0]) || x.status || x.message; } catch { return text.slice(0, 120); } };
const headers = { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json', 'login-customer-id': MANAGER };
const check = await fetch(`${API}/customers/${MANAGER}/googleAds:searchStream`, {
  method: 'POST', headers,
  body: JSON.stringify({ query: 'SELECT customer.id, customer.manager FROM customer' }),
});
const checkText = await check.text();
if (!check.ok) fail('the new client could not read the manager account 495-618-4074 (' + errCode(checkText) + '). Check you signed in with the login that manages it.');
const links = await fetch(`${API}/customers/${MANAGER}/googleAds:searchStream`, {
  method: 'POST', headers,
  body: JSON.stringify({ query: "SELECT customer_client_link.status FROM customer_client_link WHERE customer_client_link.status = 'ACTIVE'" }),
});
const linksText = await links.text();
if (!links.ok) fail('the new client could read the manager account but not its account links (' + errCode(linksText) + ').');
const linked = (JSON.parse(linksText || '[]') || []).flatMap(b => b.results || []).length;
console.log(`Checked: the new client reads the manager account and sees ${linked} linked accounts, without a developer token.`);

// ---------- 4. store the secrets on the Worker ----------
function putSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', WORKER], {
    input: value, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8',
  });
  if (r.status !== 0) fail(`could not store ${name} (wrangler said: ${String(r.stderr || '').split('\n').filter(l => /ERROR|error/.test(l))[0] || 'unknown error'}). Earlier secrets in this run may already be stored: run the script again.`);
  console.log(`Stored ${name}.`);
}
putSecret('GOOGLE_ADS_CLIENT_ID', client.client_id);
putSecret('GOOGLE_ADS_CLIENT_SECRET', client.client_secret);
putSecret('GOOGLE_ADS_REFRESH_TOKEN', tokens.refresh_token);

const del = spawnSync('npx', ['wrangler', 'secret', 'delete', 'GOOGLE_ADS_DEVELOPER_TOKEN', '--name', WORKER], {
  input: 'y\n', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8',
});
console.log(del.status === 0 ? 'Deleted the old GOOGLE_ADS_DEVELOPER_TOKEN (the automation project’s).' : 'The old GOOGLE_ADS_DEVELOPER_TOKEN was not deleted (it may already be gone).');

console.log('\nDone. The Google Ads Check now uses the Phillips Tools project. Delete the downloaded client file:\n  rm ' + JSON.stringify(file));
