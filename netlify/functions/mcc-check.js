/**
 * mcc-check.js
 * Netlify Function — polls the Cloud Run worker for a pending MCC invite.
 *
 * Called repeatedly by the frontend while the user completes the manager invite
 * step in Google Ads. Returns { found: bool, manager_link_id } from the worker.
 *
 * Env vars required:
 *   WORKER_URL      Cloud Run worker base URL
 *   WORKER_SECRET   shared secret for X-Worker-Secret header
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

  const { customer_id } = body;
  if (!customer_id) {
    return json({ error: "customer_id required" }, 400);
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    return json({ error: "Worker not configured" }, 500);
  }

  try {
    const res = await fetch(`${workerUrl}/mcc/check`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Worker-Secret": process.env.WORKER_SECRET || "",
      },
      body: JSON.stringify({ customer_id }),
    });

    const data = await res.json().catch(() => ({}));
    return json(data, res.status);
  } catch (e) {
    console.error("mcc-check worker call failed:", e.message);
    return json({ error: "Could not reach audit server", found: false }, 503);
  }
};

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
