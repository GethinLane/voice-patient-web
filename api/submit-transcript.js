// api/submit-transcript.js
import { airtableListAll, airtableCreate, airtableUpdate } from "./_airtable.js";

function cors(req, res) {
  const origin = req.headers.origin;

  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
    "https://scarevision.co.uk",
    "https://scarevision.ai",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function escapeFormulaString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeMode(value) {
  return String(value != null ? value : "")
    .trim()
    .toLowerCase() === "premium"
    ? "premium"
    : "standard";
}

function parseCreditCost(rawValue, fallback) {
  const n = Number(String(rawValue ?? "").trim());
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function countMeaningfulTurns(transcript) {
  if (!Array.isArray(transcript)) return 0;
  return transcript.filter(t => String(t?.text || "").trim().length > 0).length;
}

function resolveModeFromPayload(body) {
  return normalizeMode(
    body?.mode ?? body?.botMode ?? body?.metadata?.mode ?? body?.meta?.mode ?? body?.context?.mode
  );
}

// ✅ NEW: "kick" grading server-side so it doesn't depend on the browser polling.
// No env vars required.
function kickGrading(sessionId) {
  try {
    const base = "https://voice-patient-web.vercel.app"; // <-- keep your prod base here
    const url = `${base}/api/get-grading?sessionId=${encodeURIComponent(String(sessionId))}`;

    // Fire-and-forget; do not await.
    fetch(url, { method: "GET" }).catch(() => {});
  } catch {
    // never break submit-transcript
  }
}


export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { sessionId, caseId, userId, email, transcript } = req.body || {};

    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!caseId) return res.status(400).json({ ok: false, error: "Missing caseId" });
    if (!Array.isArray(transcript)) return res.status(400).json({ ok: false, error: "Missing transcript[]" });

    const botMode = resolveModeFromPayload(req.body || {});

    // 🔒 IMPORTANT: do NOT allow anonymous sessions to create "fake" users
    const userIdStr = userId != null ? String(userId).trim() : "";
    const emailStr = email != null ? String(email).trim().toLowerCase() : "";

    if (!userIdStr && !emailStr) {
      return res.status(400).json({
        ok: false,
        error: "Missing userId or email (must identify an existing user)",
      });
    }

    const usersKey = process.env.AIRTABLE_USERS_API_KEY;
    const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
    const usersTable = process.env.AIRTABLE_USERS_TABLE || "Users";
    const attemptsTable = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    const idField = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";

    if (!usersKey) throw new Error("Missing AIRTABLE_USERS_API_KEY");
    if (!usersBase) throw new Error("Missing AIRTABLE_USERS_BASE_ID");

    // ✅ Find existing user (DO NOT CREATE)
    const parts = [];
    if (userIdStr) parts.push(`{${idField}}='${escapeFormulaString(userIdStr)}'`);
    if (emailStr) parts.push(`LOWER({Email})='${escapeFormulaString(emailStr)}'`);

    const filterByFormula = parts.length === 1 ? parts[0] : `OR(${parts.join(",")})`;

    const userRecs = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: usersTable,
      params: { filterByFormula, maxRecords: 2 },
    });

    if (!userRecs || userRecs.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "User not found in Users table (MemberSpace/Zapier user sync may not have run yet)",
      });
    }

    if (userRecs.length > 1) {
      return res.status(409).json({
        ok: false,
        error: "Multiple Users matched (email/UserID not unique). Fix duplicates in Airtable.",
      });
    }

    const userRecordId = userRecs[0].id;

    // AttemptNumber = count existing attempts for this user+case
    const attempts = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      params: {
        filterByFormula: `AND({CaseID}=${Number(caseId)}, FIND("${userRecordId}", ARRAYJOIN({User})))`,
      },
    });

    const attemptNumber = (attempts?.length || 0) + 1;

const turns = countMeaningfulTurns(transcript);
    const tooShort = turns < 10;

    const attempt = await airtableCreate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      fields: {
        User: [userRecordId],
        AttemptNumber: attemptNumber,
        CaseID: Number(caseId),
        SessionID: String(sessionId),
        Mode: botMode,
        Transcript: JSON.stringify(transcript),
        GradingStatus: tooShort ? "too_short" : "queued",
        GradingText: tooShort ? "Session too short to grade. No credits have been deducted." : "",
      },
    });

    // Too short: no credits, no grading
    if (tooShort) {
      return res.json({
        ok: true,
        stored: true,
        tooShort: true,
        turns,
        sessionId,
        caseId: Number(caseId),
        mode: botMode,
        userId: userIdStr || null,
        email: emailStr || null,
        userRecordId,
        attemptRecordId: attempt?.id,
        attemptNumber,
      });
    }

    // Deduct credits IMMEDIATELY for valid sessions
    const creditsField = process.env.AIRTABLE_USERS_CREDITS_FIELD || "CreditsRemaining";
    const standardCreditCost = parseCreditCost(process.env.STANDARD_BOT_COST, 2);
    const premiumCreditCost = parseCreditCost(process.env.PREMIUM_BOT_COST, 1);

    let creditInfo = null;
    try {
      const userFields = userRecs[0].fields || {};
      const currentCredits = Number(userFields?.[creditsField]);

      if (!Number.isFinite(currentCredits)) {
        throw new Error(`User field '${creditsField}' is not numeric.`);
      }

      const deduction = botMode === "premium" ? premiumCreditCost : standardCreditCost;
      const nextCredits = Math.max(0, currentCredits - deduction);

      await airtableUpdate({
        apiKey: usersKey,
        baseId: usersBase,
        table: usersTable,
        recordId: userRecordId,
        fields: { [creditsField]: nextCredits },
      });

      creditInfo = { ok: true, deducted: deduction, mode: botMode, before: currentCredits, after: nextCredits };
    } catch (creditErr) {
      creditInfo = { ok: false, error: creditErr?.message || String(creditErr) };
    }

    // Kick grading (fire-and-forget)
    kickGrading(sessionId);

    return res.json({
      ok: true,
      stored: true,
      tooShort: false,
      turns,
      sessionId,
      caseId: Number(caseId),
      mode: botMode,
      userId: userIdStr || null,
      email: emailStr || null,
      userRecordId,
      attemptRecordId: attempt?.id,
      attemptNumber,
      credits: creditInfo,
      gradingKick: true,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
