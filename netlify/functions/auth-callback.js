/**
 * auth-callback.js
 * Netlify Function — handles the Google OAuth callback.
 *
 * Flow:
 *  1. Google redirects here with ?code=... after user grants access
 *  2. Exchange code for tokens (access_token + refresh_token)
 *  3. Encrypt { refreshToken, customerId } with AES-256-GCM using WORKER_SECRET
 *  4. Redirect to /audit.html?token=<encrypted>&customer_id=<cid>
 *     (no server-side storage required)
 *
 * Env vars required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   OAUTH_REDIRECT_URI   e.g. https://phillips-uk.com/.netlify/functions/auth-callback
 *   WORKER_SECRET        shared secret used for encryption + Cloud Run auth
 */

const crypto = require("crypto");

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const state = params.state || ""; // customer_id passed through state param
  const error = params.error;

  if (error) {
    return redirect(`/audit.html?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect("/audit.html?error=missing_code");
  }

  // Exchange code for tokens
  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (e) {
    console.error("Token exchange failed:", e.message);
    return redirect("/audit.html?error=token_exchange_failed");
  }

  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    return redirect("/audit.html?error=no_refresh_token");
  }

  const customerId = state || "";

  // Fetch the user's email and name from Google UserInfo
  let userEmail = "";
  let userName = "";
  try {
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      userEmail = userInfo.email || "";
      userName = userInfo.name || "";
    }
  } catch (e) {
    console.warn("UserInfo fetch failed (non-fatal):", e.message);
  }

  // Encrypt { refreshToken, customerId, userEmail, userName } into a URL param
  // No server-side storage needed — the token is self-contained
  let encryptedToken;
  try {
    encryptedToken = encrypt(JSON.stringify({ refreshToken, customerId, userEmail, userName }));
  } catch (e) {
    console.error("Encryption failed:", e.message);
    return redirect("/audit.html?error=encryption_failed");
  }

  return redirect(
    `/audit.html?token=${encodeURIComponent(encryptedToken)}&customer_id=${encodeURIComponent(customerId)}`
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * AES-256-GCM encrypt. Returns "iv:authTag:ciphertext" as hex, base64url encoded.
 * Key derived from WORKER_SECRET via SHA-256 (32 bytes).
 */
function encrypt(plaintext) {
  const secret = process.env.WORKER_SECRET;
  if (!secret) throw new Error("WORKER_SECRET not set");
  const key = crypto.createHash("sha256").update(secret).digest(); // 32 bytes
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack as iv(12) + authTag(16) + ciphertext, base64url
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64url");
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location },
    body: "",
  };
}
