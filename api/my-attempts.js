// api/my-attempts.js
import { airtableListAll } from "./_airtable";

function withCors(req, res) {
  const allowed = new Set(["https://www.scarevision.co.uk", "https://www.scarevision.ai"]);
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin && allowed.has(origin) ? origin : "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const normEmail = (s) => String(s || "").trim().toLowerCase();
const esc = (s) => String(s || "").replaceAll('"', '\\"');

export default async function handler(req, res) {
  withCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { userId, email, limit = 100 } = req.body || {};
    if (!userId && !email) return res.status(400).json({ error: "Missing identity" });

    const baseId = process.env.AIRTABLE_USERS_BASE_ID;
    const apiKey = process.env.AIRTABLE_USERS_API_KEY;

    const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
    const ATTEMPTS_TABLE = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    const USERS_ID_FIELD = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";

    // IMPORTANT: this must match the exact field name in Attempts
    const ATTEMPTS_USER_LINK_FIELD = process.env.ATTEMPTS_USER_LINK_FIELD || "User";

    if (!baseId || !apiKey) {
      return res.status(500).json({ error: "Missing AIRTABLE_USERS_BASE_ID / AIRTABLE_USERS_API_KEY" });
    }

    // ---- STEP 1: find user record ----
    const userFilterParts = [];
    if (userId) userFilterParts.push(`{${USERS_ID_FIELD}}="${esc(String(userId).trim())}"`);
    if (email) userFilterParts.push(`LOWER({Email})="${esc(normEmail(email))}"`);
    const userFilter = userFilterParts.length === 1 ? userFilterParts[0] : `OR(${userFilterParts.join(",")})`;

    const users = await airtableListAll({
      apiKey,
      baseId,
      table: USERS_TABLE,
      params: { filterByFormula: userFilter, maxRecords: "5" },
    });

    if (!users.length) {
      return res.status(403).json({
        error: "No matching Users record",
        diagnostics: { userFilter, USERS_TABLE, baseId },
      });
    }

    // prefer exact email match if provided
    let userRec = users[0];
    if (email) {
      const target = normEmail(email);
      const exact = users.find(u => normEmail(u.fields?.Email) === target);
      if (exact) userRec = exact;
    }

    const userRecId = userRec.id;

    // ---- STEP 2: list attempts linked to that user record id ----
    const attemptsFilter = `FIND("${userRecId}", ARRAYJOIN({${ATTEMPTS_USER_LINK_FIELD}}))>0`;

    const attempts = await airtableListAll({
      apiKey,
      baseId,
      table: ATTEMPTS_TABLE,
      params: { filterByFormula: attemptsFilter },
    });

    // Also fetch a tiny sample of attempts (no filter) to inspect raw {User} values via API
    const sample = await airtableListAll({
      apiKey,
      baseId,
      table: ATTEMPTS_TABLE,
      params: { maxRecords: "5", fields: [ATTEMPTS_USER_LINK_FIELD, "SessionID", "CaseID"] },
    });

    const cleaned = attempts
      .map((r) => ({
        attemptRecordId: r.id,
        createdTime: r.fields?.CreatedAt || r.createdTime,
        attemptNumber: r.fields?.AttemptNumber ?? null,
        caseId: r.fields?.CaseID ?? null,
        sessionId: r.fields?.SessionID ?? null,
        gradingStatus: r.fields?.GradingStatus ?? null,
      }))
      .filter(x => x.sessionId)
      .sort((a, b) => (String(a.createdTime) < String(b.createdTime) ? 1 : -1))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));

    return res.status(200).json({
      ok: true,
      count: cleaned.length,
      attempts: cleaned,
      diagnostics: {
        baseId,
        USERS_TABLE,
        ATTEMPTS_TABLE,
        ATTEMPTS_USER_LINK_FIELD,
        userFilter,
        matchedUser: {
          recordId: userRecId,
          UserID: userRec.fields?.[USERS_ID_FIELD] ?? null,
          Email: userRec.fields?.Email ?? null,
        },
        attemptsFilter,
        attemptsSampleUserFieldRaw: sample.map(s => ({
          id: s.id,
          userField: s.fields?.[ATTEMPTS_USER_LINK_FIELD] ?? null,
          sessionId: s.fields?.SessionID ?? null,
          caseId: s.fields?.CaseID ?? null,
        })),
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
      stack: err?.stack || null,
    });
  }
}
