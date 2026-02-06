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

function escapeFormulaString(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

  // Hoisted so catch can always write back
  let attemptRecordId = null;
  let caseId = null;
  let stage = "start";

  try {
    stage = "find_attempt";

    // 1) Find attempt by SessionID
    const attempts = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      params: {
        filterByFormula: `{SessionID}="${escapeFormulaString(sessionId)}"`,
        pageSize: "1",
      },
    });

    const attempt = attempts?.[0];
    if (!attempt) return res.json({ ok: true, found: false });

    attemptRecordId = attempt.id;
    const f = attempt.fields || {};
    caseId = Number(f.CaseID || 0);
    const currentText = String(f.GradingText || "");
    const currentStatus = String(f.GradingStatus || "").toLowerCase().trim();

    // 2) If already graded (either by status or by text), return it
    if (!force) {
      if (currentStatus === "done" && currentText && !currentText.startsWith("⏳")) {
        return res.json({
          ok: true,
          found: true,
          ready: true,
          sessionId,
          attemptRecordId,
          caseId,
          gradingText: currentText,
        });
      }

      if (currentText && !currentText.startsWith("⏳") && currentStatus !== "processing") {
        return res.json({
          ok: true,
          found: true,
          ready: true,
          sessionId,
          attemptRecordId,
          caseId,
          gradingText: currentText,
        });
      }
    }

    // 3) If locked, return processing unless stale/force
    if (!force && currentText.startsWith("⏳")) {
      const t = parseLockTime(currentText);
      const ageMs = t ? Date.now() - t : null;

      // stale lock after 3 minutes -> retry
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

    // 4) Lock (always replaced by grade or error)
    stage = "lock";
    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: {
        GradingText: lockText(),
        GradingStatus: "processing",
      },
    });

    // 5) Load transcript
    stage = "load_transcript";
    let transcript = [];
    try {
      transcript = JSON.parse(String(f.Transcript || "[]"));
    } catch {
      transcript = [];
    }

    if (!Array.isArray(transcript) || transcript.length === 0) {
      const msg = "❌ Grading failed: Transcript missing/empty in Attempts record.";
      await airtableUpdate({
        apiKey: usersKey,
        baseId: usersBase,
        table: attemptsTable,
        recordId: attemptRecordId,
        fields: { GradingText: msg, GradingStatus: "error" },
      });

      return res.json({
        ok: false,
        found: true,
        ready: true,
        sessionId,
        attemptRecordId,
        caseId,
        error: msg,
        gradingText: msg,
      });
    }

    // 6) Load marking indicators from CASES base
    stage = "load_marking";
    const casesKey = process.env.AIRTABLE_CASES_API_KEY || process.env.AIRTABLE_API_KEY;
    const casesBase = process.env.AIRTABLE_CASES_BASE_ID || process.env.AIRTABLE_BASE_ID;
    if (!casesKey) throw new Error("Missing AIRTABLE_CASES_API_KEY (or AIRTABLE_API_KEY)");
    if (!casesBase) throw new Error("Missing AIRTABLE_CASES_BASE_ID (or AIRTABLE_BASE_ID)");
    if (!caseId) throw new Error("Attempt record missing CaseID");

    const marking = await loadCaseMarking({
      caseId,
      casesApiKey: casesKey,
      casesBaseId: casesBase,
    });

    // 7) Grade via OpenAI
    stage = "openai";
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
    stage = "save_grade";
    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: {
        GradingText: result.gradingText || "⚠️ Grading completed but gradingText was empty.",
        GradingStatus: "done",
      },
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
    const msg = e?.message || String(e);
    const errText =
      `❌ Grading failed at stage "${stage}": ${msg}\n\n` +
      `Tip: retry with ?force=1`;

    if (attemptRecordId) {
      try {
        await airtableUpdate({
          apiKey: usersKey,
          baseId: usersBase,
          table: attemptsTable,
          recordId: attemptRecordId,
          fields: { GradingText: errText, GradingStatus: "error" },
        });
      } catch {}
    }

    return res.status(200).json({
      ok: false,
      found: !!attemptRecordId,
      ready: true,
      sessionId,
      attemptRecordId,
      caseId,
      stage,
      error: msg,
      gradingText: errText,
    });
  }
}
