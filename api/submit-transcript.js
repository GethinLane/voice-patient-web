// api/submit-transcript.js
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

    // ✅ write immediately so polling sees it
    store.set(sid, { status: "pending", caseId: cid, ts: Date.now() });

    // ---- For now (TEST MODE): don't call OpenAI yet, just store a dummy grading ----
    // This proves the end-to-end UI pipeline works without any external dependencies.
    const dummy = `DG: Borderline Pass
✅ (demo) Gathered some info — "Hello, how are you?"
❌ (demo) Missed key negatives — "Not asked"

CM: Borderline Fail
❌ (demo) No management plan discussed

RTO: Pass
✅ (demo) Polite communication — "Hello..."

Application: Borderline Pass
Some patient-centred phrasing but limited clinical application.

Overall summary:
This is a demo grading to confirm the plumbing works.`;

    store.set(sid, { status: "ready", caseId: cid, gradingText: dummy, ts: Date.now() });

    return res.json({ ok: true, sessionId: sid });
  } catch (e) {
    // try store error if we have sessionId
    try {
      const sid = String(req.body?.sessionId || "").trim();
      if (sid) store.set(sid, { status: "error", error: e?.message || String(e), ts: Date.now() });
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
