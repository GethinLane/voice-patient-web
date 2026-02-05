// api/get-grading.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  try {
    const sessionId = String(req.query?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

    const USERS_AIRTABLE_API_KEY = process.env.USERS_AIRTABLE_API_KEY;
    const USERS_AIRTABLE_BASE_ID = process.env.USERS_AIRTABLE_BASE_ID;
    const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || "Attempts";
    if (!USERS_AIRTABLE_API_KEY) throw new Error("Missing USERS_AIRTABLE_API_KEY");
    if (!USERS_AIRTABLE_BASE_ID) throw new Error("Missing USERS_AIRTABLE_BASE_ID");

    const url =
      `https://api.airtable.com/v0/${USERS_AIRTABLE_BASE_ID}/${encodeURIComponent(USERS_TABLE_NAME)}` +
      `?filterByFormula=${encodeURIComponent(`{sessionId}="${sessionId}"`)}` +
      `&maxRecords=1&sort%5B0%5D%5Bfield%5D=Created%20time&sort%5B0%5D%5Bdirection%5D=desc`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${USERS_AIRTABLE_API_KEY}` } });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!r.ok) return res.status(r.status).json({ ok: false, error: raw.slice(0, 400) });

    const rec = (data?.records || [])[0];
    if (!rec) return res.json({ ok: true, found: false });

    return res.json({
      ok: true,
      found: true,
      gradingText: rec.fields?.gradingText || "",
      caseId: rec.fields?.caseId ?? null,
      userId: rec.fields?.userId || "",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
