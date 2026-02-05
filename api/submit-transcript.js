// api/submit-transcript.js (TEST STORE WRITE)
import { getStore } from "./_gradingStore.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const store = getStore();

  try {
    const { sessionId, caseId, transcript } = req.body || {};
    const sid = String(sessionId || "").trim();
    const cid = Number(caseId);

    if (!sid) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!cid) return res.status(400).json({ ok: false, error: "Missing/invalid caseId" });
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing transcript[]" });
    }

    // ✅ prove storage works
    store.set(sid, { status: "pending", caseId: cid, ts: Date.now() });

    const gradingText = `✅ STORE TEST OK
sessionId: ${sid}
caseId: ${cid}
turns: ${transcript.length}

Next step: replace this dummy grading with Airtable + OpenAI grading.`;

    store.set(sid, { status: "ready", caseId: cid, gradingText, ts: Date.now() });

    return res.json({ ok: true, sessionId: sid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
