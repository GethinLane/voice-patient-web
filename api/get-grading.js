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

function escapeFormulaString(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// -------------------- NEW: credit deduction helper --------------------

async function airtableGetRecord({ apiKey, baseId, table, recordId, fields = [] }) {
  const qs = new URLSearchParams();
  for (const f of fields) qs.append("fields[]", f);

  const url =
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}` +
    (fields.length ? `?${qs.toString()}` : "");

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Airtable get error ${resp.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function deductOneCreditIfNeeded({
  usersKey,
  usersBase,
  usersTable,
  creditsField,
  userRecordId,
  shouldDeduct,
}) {
  if (!shouldDeduct) {
    return { didDeduct: false, before: null, after: null, reason: "already_done_or_forced" };
  }

  if (!userRecordId) {
    // No linked user -> we cannot safely deduct
    return { didDeduct: false, before: null, after: null, reason: "missing_user_link" };
  }

  // Read current credits
  const userRec = await airtableGetRecord({
    apiKey: usersKey,
    baseId: usersBase,
    table: usersTable,
    recordId: userRecordId,
    fields: [creditsField],
  });

  const beforeRaw = userRec?.fields?.[creditsField];
  const before = Number(beforeRaw);
  if (!Number.isFinite(before)) {
    // Credits field missing/blank/non-numeric -> don't break grading, just skip deduction
    return { didDeduct: false, before: beforeRaw ?? null, after: null, reason: "credits_not_numeric" };
  }

  const after = Math.max(0, before - 1);

  // Write back
  await airtableUpdate({
    apiKey: usersKey,
    baseId: usersBase,
    table: usersTable,
    recordId: userRecordId,
    fields: { [creditsField]: after },
  });

  return { didDeduct: true, before, after, reason: "deducted" };
}

// -------------------- handler --------------------

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

  // NEW: user table + credits field (no new Airtable fields, just config)
  const usersTable = process.env.AIRTABLE_USERS_TABLE || "Users";
  const creditsField = process.env.AIRTABLE_USERS_CREDITS_FIELD || "CreditsRemaining";

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

    // NEW: user link record id from Attempts.User (linked record field)
    const userRecordId =
      Array.isArray(f.User) && f.User.length ? String(f.User[0]) : null;

    // 2) If already graded (either by status or by text), return it
    if (!force) {
      if (currentStatus === "done" && currentText && !currentText.startsWith("⏳")) {
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

      if (currentText && !currentText.startsWith("⏳") && currentStatus !== "processing") {
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

    // Guard for double-deduction:
    // If the attempt is already marked done, and caller is forcing a regrade,
    // we MUST NOT deduct again.
    const wasAlreadyDone =
      currentStatus === "done" && currentText && !currentText.startsWith("⏳");

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
    const gradingTextToSave =
      result.gradingText || "⚠️ Grading completed but gradingText was empty.";

    await airtableUpdate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      recordId: attemptRecordId,
      fields: {
        GradingText: gradingTextToSave,
        GradingStatus: "done",
      },
    });

    // 9) NEW: deduct ONE credit AFTER we have a grade saved
    // Deduct only if this attempt wasn't already done (prevents double-charging)
    stage = "deduct_credit";
    const creditResult = await deductOneCreditIfNeeded({
      usersKey,
      usersBase,
      usersTable,
      creditsField,
      userRecordId,
      shouldDeduct: !wasAlreadyDone,
    });

    return res.json({
      ok: true,
      found: true,
      ready: true,
      status: "done",
      sessionId,
      attemptRecordId,
      caseId,
      gradingText: gradingTextToSave,
      bands: result.bands,
      credits: {
        didDeduct: creditResult.didDeduct,
        before: creditResult.before,
        after: creditResult.after,
        reason: creditResult.reason,
      },
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
