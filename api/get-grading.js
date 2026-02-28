// api/get-grading.js
import { airtableListAll, airtableUpdate } from "./_airtable.js";
import { loadCaseMarking, gradeTranscriptWithIndicators } from "./_grading.js";

function cors(req, res) {
  const origin = req.headers.origin;

  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
    // optional (if you ever use www on the .co.uk)
    "https://www.scarevision.co.uk",
    // optional (if you ever use www on the .ai)
    "https://www.scarevision.ai",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
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

function isMeaningfulGradeText(text) {
  const t = String(text || "").trim();
  // Treat empty/whitespace as “not graded yet”
  if (!t) return false;
  // Treat the lock text as “not graded yet”
  if (t.startsWith("⏳")) return false;
  // Optional: require some minimum length so tiny accidental strings don't block grading
  return t.length >= 20;
}

function escapeFormulaString(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseCreditCost(rawValue, fallback) {
  if (rawValue == null) return fallback;

  const normalized = String(rawValue).trim();
  if (!normalized) return fallback;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function parseCompletedCases(raw) {
  try {
    if (Array.isArray(raw)) return new Set(raw.map(String));
    const s = String(raw || "").trim();
    if (!s) return new Set();
    const arr = JSON.parse(s);
    return new Set((arr || []).map(String));
  } catch {
    return new Set();
  }
}

async function addCompletedCaseForUser({
  usersKey,
  usersBase,
  usersTable,
  userRecordId,
  caseId,
}) {
  const userRecs = await airtableListAll({
    apiKey: usersKey,
    baseId: usersBase,
    table: usersTable,
    params: {
      filterByFormula: `RECORD_ID()="${escapeFormulaString(userRecordId)}"`,
      maxRecords: 1,
    },
  });

  if (!userRecs?.length) {
    throw new Error(`Linked user record not found in '${usersTable}' for id=${userRecordId}`);
  }

  const userFields = userRecs[0].fields || {};
  const set = (() => {
    try {
      const raw = userFields.CompletedCases;
      if (Array.isArray(raw)) return new Set(raw.map(String));
      const s = String(raw || "").trim();
      if (!s) return new Set();
      return new Set((JSON.parse(s) || []).map(String));
    } catch {
      return new Set();
    }
  })();

  const beforeSize = set.size;
  set.add(String(caseId));
  if (set.size === beforeSize) {
    return { ok: true, changed: false, completedCount: set.size };
  }

  await airtableUpdate({
    apiKey: usersKey,
    baseId: usersBase,
    table: usersTable,
    recordId: userRecordId,
    fields: { CompletedCases: JSON.stringify(Array.from(set)) },
  });

  return { ok: true, changed: true, completedCount: set.size };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  const sessionId = String(req.query?.sessionId || "").trim();
  const force = String(req.query?.force || "") === "1";
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const usersKey = process.env.AIRTABLE_USERS_API_KEY;
  const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
  const attemptsTable = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";

  const usersTable = process.env.AIRTABLE_USERS_TABLE || "Users";
  const creditsField = process.env.AIRTABLE_USERS_CREDITS_FIELD || "CreditsRemaining";
  const standardCreditCost = parseCreditCost(process.env.STANDARD_BOT_COST, 2);
  const premiumCreditCost = parseCreditCost(process.env.PREMIUM_BOT_COST, 1);

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

// 2) If already graded, return it (ONLY when text is meaningful)
if (!force) {
  const hasGrade = isMeaningfulGradeText(currentText);

  if (currentStatus === "done" && hasGrade) {
    return res.json({
      ok: true,
      found: true,
      ready: true,
      status: "done",
      sessionId,
      attemptRecordId,
      caseId,
      gradingText: currentText,
    });
  }

  // If status is done but text isn't meaningful, fall through and regenerate
  // If status is queued but text is blank/whitespace, fall through and grade
  if (hasGrade && currentStatus !== "processing") {
    return res.json({
      ok: true,
      found: true,
      ready: true,
      status: currentStatus || "done",
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
          status: "processing",
          sessionId,
          attemptRecordId,
          caseId,
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
        status: "error",
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
if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

// No fallback: MUST be set in Vercel
const standardModel = process.env.GRADING_OPENAI_MODEL_STANDARD;
const premiumModel  = process.env.GRADING_OPENAI_MODEL_PREMIUM;

if (!standardModel) throw new Error("Missing GRADING_OPENAI_MODEL_STANDARD");
if (!premiumModel)  throw new Error("Missing GRADING_OPENAI_MODEL_PREMIUM");

const modeForGrading =
  String(f.Mode || "standard").trim().toLowerCase() === "premium"
    ? "premium"
    : "standard";

const model = modeForGrading === "premium" ? premiumModel : standardModel;


    const result = await gradeTranscriptWithIndicators({
      openaiKey,
      model,
      transcript,
      marking,
      mode: modeForGrading,
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

    // ✅ NEW: Auto-mark completion (NON-FATAL)
// Only mark completion when grading is meaningful (not lock text, not tiny).
stage = "autocomplete";
let completionInfo = null;

try {
  const savedText = result.gradingText || "";
  const hasMeaningful = isMeaningfulGradeText(savedText);

  if (!hasMeaningful) {
    completionInfo = { ok: true, skipped: true, reason: "gradingText not meaningful" };
  } else {
    const linkedUsers = Array.isArray(f.User) ? f.User : [];
    const userRecordId = linkedUsers?.[0] ? String(linkedUsers[0]) : "";

    if (!userRecordId || !userRecordId.startsWith("rec")) {
      throw new Error(
        `Attempt missing linked User record id in {User}. Expected 'rec...'. Got: ${userRecordId || "(none)"}`
      );
    }

    completionInfo = await addCompletedCaseForUser({
      usersKey,
      usersBase,
      usersTable,
      userRecordId,
      caseId,
    });
  }
} catch (completionErr) {
  // Non-fatal: grading should still return
  completionInfo = { ok: false, error: completionErr?.message || String(completionErr) };
}

    // ✅ NEW: Deduct credits by mode (NON-FATAL; never breaks grading)
    // This runs AFTER grade is saved so users never get “empty grading” due to billing issues.
    stage = "deductcredit";
    let creditInfo = null;

    try {
      const linkedUsers = Array.isArray(f.User) ? f.User : [];
      const userRecordId = linkedUsers?.[0] ? String(linkedUsers[0]) : "";

      if (!userRecordId || !userRecordId.startsWith("rec")) {
        throw new Error(
          `Attempt missing linked User record id in {User}. Expected 'rec...'. Got: ${userRecordId || "(none)"}`
        );
      }

      // Fetch user record using RECORD_ID() (avoids needing a new airtableGet helper)
      const userRecs = await airtableListAll({
        apiKey: usersKey,
        baseId: usersBase,
        table: usersTable,
        params: {
          filterByFormula: `RECORD_ID()="${escapeFormulaString(userRecordId)}"`,
          maxRecords: 1,
        },
      });

      if (!userRecs?.length) {
        throw new Error(`Linked user record not found in '${usersTable}' for id=${userRecordId}`);
      }

      const userFields = userRecs[0].fields || {};
      const currentCreditsRaw = userFields?.[creditsField];
      const currentCredits = Number(currentCreditsRaw);

      if (!Number.isFinite(currentCredits)) {
        throw new Error(
          `User field '${creditsField}' is not numeric. Got: ${JSON.stringify(currentCreditsRaw)}`
        );
      }

      const mode = String(f.Mode || "standard").trim().toLowerCase() === "premium" ? "premium" : "standard";
      const deduction = mode === "premium" ? premiumCreditCost : standardCreditCost;
      const nextCredits = Math.max(0, currentCredits - deduction);

      await airtableUpdate({
        apiKey: usersKey,
        baseId: usersBase,
        table: usersTable,
        recordId: userRecordId,
        fields: {
          [creditsField]: nextCredits,
        },
      });

      creditInfo = {
        ok: true,
        deducted: deduction,
        mode,
        userRecordId,
        field: creditsField,
        before: currentCredits,
        after: nextCredits,
      };
    } catch (creditErr) {
      // NON-FATAL: we still return the grade
      creditInfo = {
        ok: false,
        error: creditErr?.message || String(creditErr),
      };
    }

    return res.json({
      ok: true,
      found: true,
      ready: true,
      status: "done",
      sessionId,
      attemptRecordId,
      caseId,
      gradingText: result.gradingText,
      bands: result.bands,
      credits: creditInfo, // ✅ NEW (optional for frontend display/logging)
      completion: completionInfo,
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
      status: "error",
      sessionId,
      attemptRecordId,
      caseId,
      stage,
      error: msg,
      gradingText: errText,
    });
  }
}
