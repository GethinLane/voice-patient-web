// api/get-grading.js
import { airtableListAll, airtableUpdate } from "./_airtable.js";
import { loadCaseMarking, gradeTranscriptWithIndicators } from "./_grading.js";

function cors(res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://www.scarevision.co.uk";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  try {
    const sessionId = String(req.query?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

    const usersKey = process.env.AIRTABLE_USERS_API_KEY;
    const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
    const attemptsTable = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    if (!usersKey) throw new Error("Missing AIRTABLE_USERS_API_KEY");
    if (!usersBase) throw new Error("Missing AIRTABLE_USERS_BASE_ID");

    // Find attempt by SessionID
    const attempts = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      params: { filterByFormula: `{SessionID}="${sessionId.replace(/"/g, '\\"')}"` },
    });

    const attempt = attempts?.[0];
    if (!attempt) return res.json({ ok: true, found: false });

    const fields = attempt.fields || {};
    const attemptRecordId = attempt.id;
    const caseId = Number(fields.CaseID || 0);

    const gradingText = (fields.GradingText || "").toString();
    if (gradingText && !gradingText.startsWith("⏳")) {
      return res.json({
        ok: true,
        found: true,
        ready: true,
        sessionId,
        attemptRecordId,
        caseId,
        gradingText,
      });
    }

    // If already in progress, just report status
    if (gradingText.startsWith("⏳")) {
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

    // Start grading (set lock)
    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: { GradingText: "⏳ Grading in progress..." },
    });

    // Load transcript
    let transcript = [];
    try {
      transcript = JSON.parse((fields.Transcript || "[]").toString());
    } catch {
      transcript = [];
    }

    // Load marking indicators from CASES base
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

    // Grade via OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const result = await gradeTranscriptWithIndicators({
      openaiKey,
      model,
      transcript,
      marking,
    });

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
      bands: result.bands, // helpful debug
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
