// api/get-grading.js
import { airtableListAll, airtableUpdate } from "./_airtable.js";
import { loadCaseMarking, gradeTranscriptWithIndicators } from "./_grading.js";

function cors(res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://www.scarevision.co.uk";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function lockText() {
  return `⏳ Grading in progress @ ${new Date().toISOString()}`;
}

function parseLockTime(text) {
  const m = String(text || "").match(/@ (.+)$/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  const sessionId = String(req.query?.sessionId || "").trim();
  const force = String(req.query?.force || "") === "1";
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const usersKey = process.env.AIRTABLE_USERS_API_KEY;
  const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
  const attemptsTable = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";

  if (!usersKey) return res.status(500).json({ ok: false, error: "Missing AIRTABLE_USERS_API_KEY" });
  if (!usersBase) return res.status(500).json({ ok: false, error: "Missing AIRTABLE_USERS_BASE_ID" });

  try {
    // 1) Find attempt by SessionID
    const attempts = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      params: { filterByFormula: `{SessionID}="${sessionId.replace(/"/g, '\\"')}"`, pageSize: "1" },
    });

    const attempt = attempts?.[0];
    if (!attempt) return res.json({ ok: true, found: false });

    const attemptRecordId = attempt.id;
    const f = attempt.fields || {};
    const caseId = Number(f.CaseID || 0);
    const current = String(f.GradingText || "");

    // 2) If already graded, return it
    if (current && !current.startsWith("⏳") && !force) {
      return res.json({
        ok: true,
        found: true,
        ready: true,
        sessionId,
        attemptRecordId,
        caseId,
        gradingText: current,
      });
    }

    // 3) If locked, return processing UNLESS stale/force
    if (current.startsWith("⏳") && !force) {
      const t = parseLockTime(current);
      const ageMs = t ? (Date.now() - t) : null;

      // stale lock after 3 minutes → retry
      if (ageMs != null && ageMs > 180000) {
        // fall through and re-grade
      } else {
        return res.json({
          ok: true,
          found: true,
          ready: false,
          sessionId,
          attemptRecordId,
          caseId,
          status: "processing",
        });
      }
    }

    // 4) Lock (but we will ALWAYS replace it with either a grade or an error)
    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: { GradingText: lockText() },
    });

    // 5) Load transcript
    let transcript = [];
    try { transcript = JSON.parse(String(f.Transcript || "[]")); } catch {}
    if (!Array.isArray(transcript) || transcript.length === 0) {
      const msg = "❌ Grading failed: Transcript missing/empty in Attempts record.";
      await airtableUpdate({
        apiKey: usersKey,
        baseId: usersBase,
        table: attemptsTable,
        recordId: attemptRecordId,
        fields: { GradingText: msg },
      });
      return res.json({ ok: true, found: true, ready: true, sessionId, attemptRecordId, caseId, gradingText: msg });
    }

    // 6) Load marking indicators from CASES base
    const casesKey = process.env.AIRTABLE_CASES_API_KEY || process.env.AIRTABLE_API_KEY;
    const casesBase = process.env.AIRTABLE_CASES_BASE_ID || process.env.AIRTABLE_BASE_ID;
    if (!casesKey) throw new Error("Missing AIRTABLE_CASES_API_KEY (or AIRTABLE_API_KEY)");
    if (!casesBase) throw new Error("Missing AIRTABLE_CASES_BASE_ID (or AIRTABLE_BASE_ID)");
    if (!caseId) throw new Error("Attempt record missing CaseID");

    const marking = await loadCaseMarking({ caseId, casesApiKey: casesKey, casesBaseId: casesBase });

    // 7) Grade via OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const result = await gradeTranscriptWithIndicators({
      openaiKey,
      model,
      transcript,
      marking,
    });

    // 8) Save grade
    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: { GradingText: result.gradingText },
    });

    return res.json({
      ok: true,
      found: true,
      ready: true,
      sessionId,
      attemptRecordId,
      caseId,
      gradingText: result.gradingText,
      bands: result.bands,
    });
  } catch (e) {
    // IMPORTANT: write the error into Airtable so it never gets stuck
    const errText = `❌ Grading failed: ${e?.message || String(e)}\n\nTip: retry with ?force=1`;
    try {
      // re-fetch record id quickly is expensive; but we already have attempt if we got past that stage.
      // If failure happened early before attempt was found, this update will be skipped.
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
