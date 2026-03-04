// /api/sync-credits.js
// Called by Airtable Automation whenever credits change
// Writes the new value to Vercel KV so /api/credits is instant

export default async function handler(req, res) {
  // Simple secret check to prevent abuse
  const secret = req.headers["x-sync-secret"];
  if (secret !== process.env.SCA_SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userId, credits } = req.body;

    if (!userId || credits == null) {
      return res.status(400).json({ error: "Missing userId or credits" });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ error: "KV not configured" });
    }

    // Write to KV
    const resp = await fetch(
      `${kvUrl}/set/credits:${encodeURIComponent(userId)}/${Number(credits)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${kvToken}` },
      }
    );

    if (!resp.ok) throw new Error("KV write failed");

    return res.status(200).json({ ok: true, userId, credits });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
