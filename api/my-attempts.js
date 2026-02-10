// api/my-attempts.js
// Returns attempts for an existing user (matched by userId and/or email).
// NOTE: This trusts the identity coming from the browser unless you add server-side MemberSpace verification.

import { airtableListAll } from "./_airtable";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.ai");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { userId, email, limit = 50 } = req.body || {};
    if (!userId && !email) {
      return res.status(400).json({ error: "Missing identity (userId or email required)" });
    }

    const USERS_BASE_ID = process.env.AIRTABLE_USERS_BASE_ID;
    const USERS_API_KEY = process.env.AIRTABLE_USERS_API_KEY;
    const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
    const ATTEMPTS_TABLE = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    const USERS_ID_FIELD = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";

    if (!USERS_BASE_ID || !USERS_API_KEY) {
      return res.status(500).json({ error: "Users Airtable not configured (AIRTABLE_USERS_BASE_ID / AIRTABLE_USERS_API_KEY)" });
    }

    // 1) Find the existing Users record (DO NOT create)
    const userFilterParts = [];
    if (userId) userFilterParts.push(`{${USERS_ID_FIELD}}="${String(userId)}"`);
    if (email) userFilterParts.push(`{Email}="${String(email)}"`);
    const userFilter = userFilterParts.length === 1 ? userFilterParts[0] : `OR(${userFilterParts.join(",")})`;

    const users = await airtableListAll({
      apiKey: USERS_API_KEY,
      baseId: USERS_BASE_ID,
      tableName: USERS_TABLE,
      filterByFormula: userFilter,
      maxRecords: 1,
    });

    if (!users.length) {
      return res.status(403).json({ error: "No matching user record found (user must already exist)" });
    }

    const userRecId = users[0].id;

    // 2) List attempts linked to that user record ID
    // Linked record field is "User" in your model (Attempts.User -> Users record)
    const attempts = await airtableListAll({
      apiKey: USERS_API_KEY,
      baseId: USERS_BASE_ID,
      tableName: ATTEMPTS_TABLE,
      // Link fields in Airtable are arrays of record IDs. We match the first linked record.
      filterByFormula: `FIND("${userRecId}", ARRAYJOIN({User}))>0`,
      // Sort newest first (if Airtable supports sort in your helper, otherwise we sort locally)
      // If your airtableListAll doesn't support sort params, it still returns createdTime so we can sort below.
    });

    const cleaned = attempts
      .map((r) => ({
        attemptRecordId: r.id,
        createdTime: r.createdTime,
        attemptNumber: r.fields?.AttemptNumber ?? null,
        caseId: r.fields?.CaseID ?? null,
        sessionId: r.fields?.SessionID ?? null,
        gradingStatus: r.fields?.GradingStatus ?? null,
        gradingText: r.fields?.GradingText ?? "",
        durationSeconds: r.fields?.DurationSeconds ?? null, // only if you store it
      }))
      .filter((x) => x.sessionId)
      .sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));

    return res.status(200).json({
      ok: true,
      count: cleaned.length,
      attempts: cleaned,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
