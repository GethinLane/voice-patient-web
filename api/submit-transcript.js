// api/submit-transcript.js
import { airtableListAll, airtableCreate } from "./_airtable.js";

function cors(res) {
  const origin = process.env.ALLOWED_ORIGIN || "https://www.scarevision.co.uk";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { sessionId, caseId, userId, transcript } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!caseId) return res.status(400).json({ ok: false, error: "Missing caseId" });
    if (!Array.isArray(transcript)) return res.status(400).json({ ok: false, error: "Missing transcript[]" });

    const usersKey = process.env.AIRTABLE_USERS_API_KEY;
    const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
    const usersTable = process.env.AIRTABLE_USERS_TABLE || "Users";
    const attemptsTable = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    const idField = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";

    if (!usersKey) throw new Error("Missing AIRTABLE_USERS_API_KEY");
    if (!usersBase) throw new Error("Missing AIRTABLE_USERS_BASE_ID");

    const effectiveUserId = (userId && String(userId).trim()) || `anon-${sessionId.slice(0, 8)}`;

    // Find or create user
    const userRecs = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: usersTable,
      params: { filterByFormula: `{${idField}}="${effectiveUserId.replace(/"/g, '\\"')}"` },
    });

    let userRecordId = userRecs?.[0]?.id;
    if (!userRecordId) {
      const created = await airtableCreate({
        apiKey: usersKey,
        baseId: usersBase,
        table: usersTable,
        fields: { [idField]: effectiveUserId },
      });
      userRecordId = created?.id;
    }
    if (!userRecordId) throw new Error("Failed to create/find user record");

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

    const attempt = await airtableCreate({
      apiKey: usersKey,
      baseId: usersBase,
      table: attemptsTable,
      fields: {
        User: [userRecordId],
        AttemptNumber: attemptNumber,
        CaseID: Number(caseId),
        SessionID: String(sessionId),
        Transcript: JSON.stringify(transcript),
        GradingText: "", // will be filled by get-grading
      },
    });

    return res.json({
      ok: true,
      stored: true,
      sessionId,
      caseId: Number(caseId),
      userId: effectiveUserId,
      attemptRecordId: attempt?.id,
      attemptNumber,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
