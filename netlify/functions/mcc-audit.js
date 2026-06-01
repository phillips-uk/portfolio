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
  const clientIp = (
    (event.headers || {})["x-forwarded-for"] ||
    (event.headers || {})["client-ip"] ||
    "unknown"
  ).split(",")[0].trim();

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

  // Internal notification email (same pattern as trigger-audit.js)
  if (!isBlockedIp(clientIp)) {
    await sendNotificationEmail(
      `Google Ads MCC audit — Account ${customer_id}`,
      `<div style="font-family:Helvetica Neue,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1A1A1A">
        <div style="background:#985830;padding:20px 24px;border-radius:6px 6px 0 0">
          <span style="color:#fff;font-size:18px;font-weight:700">Phillips. MCC Audit Alert</span>
        </div>
        <div style="background:#FDF6EE;border:1px solid #E8D8C4;border-top:none;padding:24px;border-radius:0 0 6px 6px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B;width:120px">Account ID</td><td style="padding:4px 0;font-size:13px;font-weight:700">${customer_id}</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">Flow</td><td style="padding:4px 0;font-size:13px;color:#985830;font-weight:700">Manager Link (no OAuth)</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">User</td><td style="padding:4px 0;font-size:13px">${user_name || "(unknown)"} (${user_email || "no email"})</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">Score</td><td style="padding:4px 0;font-size:13px;font-weight:700">${auditResult.score != null ? auditResult.score : "N/A"}</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">Issues</td><td style="padding:4px 0;font-size:13px">${Array.isArray(auditResult.issues) ? auditResult.issues.length : "N/A"}</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">IP</td><td style="padding:4px 0;font-size:13px;font-family:monospace">${clientIp}</td></tr>
            <tr><td style="padding:4px 0;font-size:13px;color:#6B6B6B">Time</td><td style="padding:4px 0;font-size:13px">${new Date().toISOString()}</td></tr>
          </table>
          <div style="margin-top:16px;padding-top:12px;border-top:1px solid #E8D8C4;font-size:12px;color:#6B6B6B;">
            Manager link was removed automatically after the audit.
          </div>
        </div>
      </div>`
    );
  }

  return json(auditResult, 200);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBlockedIp(ip) {
  const blocked = (process.env.EMAIL_SKIP_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
  return blocked.some(b => ip && ip.startsWith(b));
}

async function sendNotificationEmail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:    "audits@phillips-uk.com",
        to:      "lewis@phillips-uk.com",
        subject,
        html,
      }),
    });
  } catch (e) {
    console.error("MCC notification email failed:", e.message);
  }
}

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
