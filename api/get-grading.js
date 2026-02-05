// api/get-grading.js (NO Users Airtable - test mode)
function store() {
  if (!globalThis.__gradingStore) globalThis.__gradingStore = new Map();
  return globalThis.__gradingStore;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  const sessionId = String(req.query?.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const item = store().get(sessionId);
  if (!item) return res.json({ ok: true, found: false });

  if (item.status === "pending") return res.json({ ok: true, found: true, status: "pending" });
  if (item.status === "error") {
    return res.json({ ok: true, found: true, status: "error", error: item.error || "Unknown error" });
  }

  return res.json({
    ok: true,
    found: true,
    status: "ready",
    gradingText: item.gradingText || "",
    caseId: item.caseId ?? null,
  });
}
