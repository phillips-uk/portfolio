/**
 * auth-callback.js
 * Netlify Function — handles the Google OAuth callback.
 *
 * Flow:
 *  1. Google redirects here with ?code=... after user grants access
 *  2. Exchange code for tokens (access_token + refresh_token)
 *  3. Call Cloud Run worker /accounts to discover accessible Google Ads accounts
 *  4. Encrypt { refreshToken, userEmail, userName, accountIds } with AES-256-GCM
 *  5. Redirect to /google-ads-audit.html?token=<encrypted>&accounts=<base64url-json>
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   OAUTH_REDIRECT_URI   e.g. https://phillips-uk.com/.netlify/functions/auth-callback
 *   WORKER_SECRET        shared secret used for encryption + Cloud Run auth
 *   WORKER_URL           Cloud Run worker base URL
 */

const crypto = require("crypto");

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const error = params.error;

  if (error) {
    return redirect(`/google-ads-audit.html?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect("/google-ads-audit.html?error=missing_code");
  }

  // 1. Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (e) {
    console.error("Token exchange failed:", e.message);
    return redirect("/google-ads-audit.html?error=token_exchange_failed");
  }

  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    return redirect("/google-ads-audit.html?error=no_refresh_token");
  }

  // 2. Fetch user email / name
  let userEmail = "", userName = "";
  try {
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      userEmail = userInfo.email || "";
      userName  = userInfo.name  || "";
    }
  } catch (e) {
    console.warn("UserInfo fetch failed (non-fatal):", e.message);
  }

  // 3. Discover accessible Google Ads accounts via Cloud Run worker
  let accounts = [];
  let accountsError = null;
  try {
    const workerUrl    = process.env.WORKER_URL;
    const workerSecret = process.env.WORKER_SECRET || "";
    if (workerUrl) {
      const accountsRes = await fetch(`${workerUrl}/accounts`, {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "X-Worker-Secret": workerSecret,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (accountsRes.ok) {
        accounts = await accountsRes.json();
        console.log(`[auth-callback] /accounts returned ${accounts.length} account(s) for ${userEmail}`);
      } else {
        const body = await accountsRes.text().catch(() => "(unreadable)");
        accountsError = `HTTP ${accountsRes.status}: ${body}`;
        console.error(`[auth-callback] /accounts non-OK for ${userEmail}: ${accountsError}`);
      }
    } else {
      accountsError = "WORKER_URL not set";
      console.error("[auth-callback] WORKER_URL env var is missing");
    }
  } catch (e) {
    accountsError = e.message;
    console.error("[auth-callback] /accounts fetch threw:", e.message);
  }

  // 4. Encrypt payload
  let encryptedToken;
  try {
    encryptedToken = encrypt(JSON.stringify({
      refreshToken,
      userEmail,
      userName,
      accountIds: accounts.map(a => a.id),
    }));
  } catch (e) {
    console.error("Encryption failed:", e.message);
    return redirect("/google-ads-audit.html?error=encryption_failed");
  }

  // 5. Redirect with accounts list (or no_accounts flag if empty)
  const tokenParam = `token=${encodeURIComponent(encryptedToken)}`;
  if (accounts.length === 0) {
    return redirect(`/google-ads-audit.html?${tokenParam}&no_accounts=1`);
  }

  const accountsParam = Buffer.from(JSON.stringify(accounts)).toString("base64url");
  return redirect(`/google-ads-audit.html?${tokenParam}&accounts=${accountsParam}`);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  process.env.OAUTH_REDIRECT_URI,
    grant_type:    "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * AES-256-GCM encrypt. Returns iv(12)+authTag(16)+ciphertext packed as base64url.
 * Key is derived from WORKER_SECRET via SHA-256.
 */
function encrypt(plaintext) {
  const secret = process.env.WORKER_SECRET;
  if (!secret) throw new Error("WORKER_SECRET not set");
  const key    = crypto.createHash("sha256").update(secret).digest();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url");
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location },
    body: "",
  };
}
