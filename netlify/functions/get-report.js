/**
 * get-report.js
 * Netlify Function — retrieves a previously saved audit by its UUID.
 *
 * Called by audit.html when ?report=<uuid> is in the URL.
 * No OAuth required — the UUID itself is the unforgeable capability.
 *
 * GET /.netlify/functions/get-report?id=<uuid>
 *
 * Env vars required:
 *   WORKER_URL      e.g. https://ads-audit-worker-xxxx-nw.a.run.app
 *   WORKER_SECRET   shared secret for Cloud Run auth
 */

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const id = (event.queryStringParameters || {}).id || "";

  // UUID v4: 8-4-4-4-12 hex chars
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return json({ error: "Invalid report ID" }, 400);
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    return json({ error: "Worker not configured" }, 503);
  }

  try {
    const res = await fetch(`${workerUrl}/audit/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: {
        "X-Worker-Secret": process.env.WORKER_SECRET || "",
      },
    });

    if (res.status === 404) {
      return json({ error: "Report not found" }, 404);
    }

    if (!res.ok) {
      return json({ error: "Could not retrieve report" }, 502);
    }

    const data = await res.json();
    return json(data, 200);

  } catch (e) {
    console.error("get-report error:", e.message);
    return json({ error: "Could not reach audit worker", detail: e.message }, 503);
  }
};

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Cache for 1 hour — audit results don't change
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify(data),
  };
}
