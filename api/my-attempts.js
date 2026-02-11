// api/my-attempts.js
import { airtableListAll } from "./_airtable";

function withCors(req, res) {
  // Update these if you want to allow both domains
  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
  ]);

  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // fallback (optional): lock to your main domain
    res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  withCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { userId, email, limit = 100 } = req.body || {};
    if (!userId && !email) {
      return res.status(400).json({ error: "Missing identity (userId or email required)" });
    }

    const baseId = process.env.AIRTABLE_USERS_BASE_ID;
    const apiKey = process.env.AIRTABLE_USERS_API_KEY;

    const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
    const ATTEMPTS_TABLE = process.env.AIRTABLE_ATTEMPTS_TABLE || "Attempts";
    const USERS_ID_FIELD = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";

    if (!baseId || !apiKey) {
      return res.status(500).json({
        error: "Users Airtable not configured",
        detail: "Missing AIRTABLE_USERS_BASE_ID or AIRTABLE_USERS_API_KEY",
      });
    }

    // ---- 1) Find user record (DO NOT create) ----
    const parts = [];
    if (userId) parts.push(`{${USERS_ID_FIELD}}="${String(userId)}"`);
    if (email) parts.push(`{Email}="${String(email)}"`);

    const filterByFormula = parts.length === 1 ? parts[0] : `OR(${parts.join(",")})`;

    const users = await airtableListAll({
      apiKey,
      baseId,
      table: USERS_TABLE,
      params: {
        filterByFormula,
        maxRecords: "1",
      },
    });

    if (!users.length) {
      return res.status(403).json({ error: "No matching user record found" });
    }

    const userRecId = users[0].id;

    // ---- 2) List attempts linked to that user ----
    // IMPORTANT: This assumes the linked-record field in Attempts is named "User"
    // If yours is named differently, change {User} below.
    const attempts = await airtableListAll({
      apiKey,
      baseId,
      table: ATTEMPTS_TABLE,
      params: {
        filterByFormula: `FIND("${userRecId}", ARRAYJOIN({User}))>0`,
      },
    });

    const cleaned = attempts
      .map((r) => ({
        attemptRecordId: r.id,
        createdTime: r.createdTime,
        attemptNumber: r.fields?.AttemptNumber ?? null,
        caseId: r.fields?.CaseID ?? null,
        sessionId: r.fields?.SessionID ?? null,
        gradingStatus: r.fields?.GradingStatus ?? null,
        // we intentionally don't return gradingText here; we fetch it via get-grading when clicked
      }))
      .filter((x) => x.sessionId)
      .sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));

    return res.status(200).json({ ok: true, count: cleaned.length, attempts: cleaned });
  } catch (err) {
    // Make debugging easy (you can remove stack later)
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
      stack: err?.stack || null,
    });
  }
}
