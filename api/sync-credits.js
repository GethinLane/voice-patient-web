// /api/sync-credits.js
export default async function handler(req, res) {

  console.log("[sync-credits] Request received");
  console.log("[sync-credits] Method:", req.method);
  console.log("[sync-credits] Headers:", JSON.stringify(req.headers));

  const secret = req.headers["x-sync-secret"];
  const envSecret = process.env.CREDITS_SYNC_SECRET;

  console.log("[sync-credits] Secret received:", secret ? "YES" : "NO");
  console.log("[sync-credits] Env secret set:", envSecret ? "YES" : "NO");
  console.log("[sync-credits] Secret match:", secret === envSecret);

  if (secret !== envSecret) {
    console.log("[sync-credits] 401 - secret mismatch");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;
    console.log("[sync-credits] Body received:", JSON.stringify(body));

    const userId = body?.userId;
    const credits = body?.credits;

    console.log("[sync-credits] userId:", userId);
    console.log("[sync-credits] credits:", credits);

    if (!userId || credits === undefined || credits === null || credits === "") {
      console.log("[sync-credits] 400 - missing fields");
      return res.status(400).json({ error: "Missing userId or credits" });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    console.log("[sync-credits] KV_REST_API_URL set:", kvUrl ? "YES" : "NO");
    console.log("[sync-credits] KV_REST_API_TOKEN set:", kvToken ? "YES" : "NO");

    if (!kvUrl || !kvToken) {
      console.log("[sync-credits] 500 - KV not configured");
      return res.status(500).json({ error: "KV not configured" });
    }

    const creditValue = Number(credits);
    const kvKey = `credits:${encodeURIComponent(userId)}`;
    const kvEndpoint = `${kvUrl}/set/${kvKey}/${creditValue}`;

    console.log("[sync-credits] Writing to KV key:", kvKey);
    console.log("[sync-credits] Credit value:", creditValue);
    console.log("[sync-credits] KV endpoint:", kvEndpoint);

    const resp = await fetch(kvEndpoint, {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${kvToken}`,
        "Content-Type": "application/json"
      },
    });

    const kvResponse = await resp.text();
    console.log("[sync-credits] KV response status:", resp.status);
    console.log("[sync-credits] KV response body:", kvResponse);

    if (!resp.ok) {
      console.log("[sync-credits] KV write failed");
      throw new Error(`KV write failed: ${resp.status} ${kvResponse}`);
    }

    console.log("[sync-credits] Success!");
    return res.status(200).json({ ok: true, userId, credits: creditValue });

  } catch (err) {
    console.log("[sync-credits] Error:", err.message);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
