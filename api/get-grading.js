// api/get-grading.js
import { cors, usersCfg, tableUrl, airtableFetchJson, escFormula } from "./_airtable.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  try {
    const { apiKey, baseId, attemptsTable } = usersCfg();

    const sessionId = String(req.query?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

    const filter = `{SessionID}="${escFormula(sessionId)}"`;
    const url = `${tableUrl(baseId, attemptsTable)}?filterByFormula=${encodeURIComponent(filter)}&pageSize=1`;

    const data = await airtableFetchJson(url, apiKey, { method: "GET" });
    const rec = data?.records?.[0];
    if (!rec) return res.json({ ok: true, found: false });

    const f = rec.fields || {};
    return res.json({
      ok: true,
      found: true,
      caseId: f.CaseID,
      attemptNumber: f.AttemptNumber,
      gradingText: f.GradingText || "",
      recordId: rec.id,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
