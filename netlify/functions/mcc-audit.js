/**
 * mcc-audit.js
 * Netlify Function — triggers the MCC manager-link audit flow.
 *
 * Accepts POST { customer_id, manager_link_id, user_email, user_name }
 * Calls Cloud Run /mcc/audit which:
 *   1. Accepts the pending manager invite
 *   2. Runs the full audit using MCC credentials
 *   3. Removes the manager link immediately after
 *
 * Returns the same audit JSON as trigger-audit.js (OAuth flow).
 *
 * Env vars required:
 *   WORKER_URL          Cloud Run worker base URL
 *   WORKER_SECRET       shared secret for X-Worker-Secret header
 *   RESEND_API_KEY      (optional) for internal notification email
 */

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

  const { customer_id, manager_link_id, user_email, user_name } = body;

  if (!customer_id || !manager_link_id) {
    return json({ error: "customer_id and manager_link_id required" }, 400);
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    return json({ error: "Worker not configured" }, 500);
  }

  let auditResult;
  try {
    const res = await fetch(`${workerUrl}/mcc/audit`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Worker-Secret": process.env.WORKER_SECRET || "",
      },
      body: JSON.stringify({ customer_id, manager_link_id, user_email, user_name }),
    });

    if (res.status === 429) {
      const errBody = await res.json().catch(() => ({}));
      return json({ error: "already_audited", detail: errBody.detail || "Already audited" }, 429);
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ detail: res.statusText }));
      console.error("MCC audit worker error:", res.status, JSON.stringify(errBody));
      return json({ error: "Audit failed", detail: errBody.detail || "Worker error" }, 502);
    }

    auditResult = await res.json();
  } catch (e) {
    console.error("mcc-audit worker call failed:", e.message);
    return json({ error: "Could not reach audit server", detail: e.message }, 503);
  }

  return json(auditResult, 200);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
}
