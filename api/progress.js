// /api/progress.js
export default async function handler(req, res) {
  // --- CORS ---
  const origin = req.headers.origin || "";
  const allowed = [
    "https://scarevision.ai",
    "https://www.scarevision.ai",
    // add your squarespace domains if this will be called there too
  ];
  if (allowed.includes(origin) || origin.endsWith(".squarespace.com")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://scarevision.ai");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const userId = String(req.query.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // --- env config (matches your Master Summary naming) ---
  const API_KEY = process.env.AIRTABLE_USERS_API_KEY;
  const BASE_ID = process.env.AIRTABLE_USERS_BASE_ID;
  const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
  const USER_ID_FIELD = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";
  const COMPLETED_FIELD = "CompletedCases";

  if (!API_KEY || !BASE_ID) {
    return res.status(500).json({ error: "Missing Users base env vars" });
  }

  const filterByFormula = `{${USER_ID_FIELD}}='${userId.replace(/'/g, "\\'")}'`;
  const url =
    `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(USERS_TABLE)}` +
    `?maxRecords=1&filterByFormula=${encodeURIComponent(filterByFormula)}`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!r.ok) {
    const t = await r.text();
    return res.status(r.status).json({ error: "Airtable Users lookup failed", detail: t });
  }

  const data = await r.json();
  const user = data?.records?.[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  const raw = user.fields?.[COMPLETED_FIELD];

  // We support either:
  // - JSON string '["12","44"]'
  // - or a real Airtable array (if you ever switch field type)
  let completed = [];
  try {
    if (Array.isArray(raw)) completed = raw;
    else if (typeof raw === "string" && raw.trim()) completed = JSON.parse(raw);
  } catch {
    completed = [];
  }

  completed = (completed || []).map(String);

  return res.status(200).json({
    userId,
    completed,
  });
}
