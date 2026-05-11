/**
 * trigger-audit.js
 * Netlify Function — decrypts the token from auth-callback and calls the Cloud Run worker.
 *
 * Called by audit.html via fetch POST with { token, customer_id }
 * Returns the full audit JSON from the worker.
 *
 * Env vars required:
 *   WORKER_URL          e.g. https://ads-audit-worker-xxxx-nw.a.run.app
 *   WORKER_SECRET       shared secret — used for decryption + Cloud Run X-Worker-Secret header
 */

const crypto = require("crypto");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { token, customer_id } = body;

  if (!token || !customer_id) {
    return json({ error: "token and customer_id required" }, 400);
  }

  // Decrypt the token to get { refreshToken, customerId }
  let payload;
  try {
    payload = JSON.parse(decrypt(token));
  } catch (e) {
    console.error("Decryption failed:", e.message);
    return json({ error: "Invalid or tampered token" }, 401);
  }

  // Validate customer_id matches what was encoded at auth time
  if (payload.customerId && payload.customerId !== customer_id) {
    return json({ error: "customer_id mismatch" }, 403);
  }

  // Call the Cloud Run worker
  let auditResult;
  try {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) throw new Error("WORKER_URL not configured");

    const res = await fetch(`${workerUrl}/audit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Secret": process.env.WORKER_SECRET || "",
      },
      body: JSON.stringify({
        customer_id,
        refresh_token: payload.refreshToken,
        user_email: payload.userEmail || "",
        user_name: payload.userName || "",
      }),
    });

    if (res.status === 429) {
      const errBody = await res.json().catch(() => ({}));
      return json({ error: "already_audited", detail: errBody.detail || "Already audited" }, 429);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ detail: res.statusText }));
      console.error("Worker error:", res.status, JSON.stringify(errBody));
      return json({ error: "Audit failed", detail: errBody.detail || "Worker error", traceback: errBody.traceback || null }, 502);
    }

    auditResult = await res.json();
  } catch (e) {
    console.error("Worker call failed:", e.message);
    return json({ error: "Could not reach audit worker", detail: e.message }, 503);
  }

  return json(auditResult, 200);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * AES-256-GCM decrypt. Inverse of auth-callback encrypt().
 * Packed format: iv(12) + authTag(16) + ciphertext, base64url encoded.
 */
function decrypt(encoded) {
  const secret = process.env.WORKER_SECRET;
  if (!secret) throw new Error("WORKER_SECRET not set");
  const key = crypto.createHash("sha256").update(secret).digest();
  const packed = Buffer.from(encoded, "base64url");
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
}
