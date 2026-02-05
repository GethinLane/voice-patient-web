// api/submit-transcript.js
import { cors, usersCfg, tableUrl, airtableFetchJson, escFormula } from "./_airtable.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { apiKey, baseId, usersTable, attemptsTable } = usersCfg();

    const { sessionId, caseId, transcript, userId } = req.body || {};
    const sid = String(sessionId || "").trim();
    const cid = Number(caseId);
    const uid = String(userId || "").trim() || `anon-${sid.slice(0, 8)}`;

    if (!sid) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!cid) return res.status(400).json({ ok: false, error: "Missing/invalid caseId" });
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing transcript[]" });
    }

    // 1) Find or create user record (Users table primary is UserID)
    const userFilter = `{UserID}="${escFormula(uid)}"`;
    const userFindUrl =
      `${tableUrl(baseId, usersTable)}?filterByFormula=${encodeURIComponent(userFilter)}&pageSize=1`;

    const userFind = await airtableFetchJson(userFindUrl, apiKey, { method: "GET" });
    let userRecordId = userFind?.records?.[0]?.id;

    if (!userRecordId) {
      const created = await airtableFetchJson(tableUrl(baseId, usersTable), apiKey, {
        method: "POST",
        body: JSON.stringify({ records: [{ fields: { UserID: uid } }] }),
      });
      userRecordId = created?.records?.[0]?.id;
    }

    if (!userRecordId) throw new Error("Could not resolve userRecordId");

    // 2) Determine AttemptNumber for this user+case
    // We can’t filter directly on linked record id easily with formulas, so we SEARCH the UserID in the linked field.
    const attemptFilter = `AND({CaseID}=${cid}, SEARCH("${escFormula(uid)}", ARRAYJOIN({User})))`;
    const attemptUrl =
      `${tableUrl(baseId, attemptsTable)}` +
      `?filterByFormula=${encodeURIComponent(attemptFilter)}` +
      `&sort[0][field]=AttemptNumber&sort[0][direction]=desc&pageSize=1`;

    const attemptFind = await airtableFetchJson(attemptUrl, apiKey, { method: "GET" });
    const lastN = Number(attemptFind?.records?.[0]?.fields?.AttemptNumber || 0);
    const attemptNumber = lastN + 1;

    // 3) Store attempt
    const transcriptText = JSON.stringify(transcript);

    // Demo grading (plumbing test)
    const gradingText =
`✅ Stored attempt (DEMO – plumbing test)
UserID: ${uid}
CaseID: ${cid}
AttemptNumber: ${attemptNumber}
SessionID: ${sid}
Turns: ${transcript.length}

DG: Borderline Pass
CM: Borderline Fail
RTO: Pass
Application: Borderline Pass

Next step: replace demo with real grading using Case indicators + OpenAI.`;

    // Your Attempts table primary field should be something like AttemptKey (text)
    const attemptKey = `${uid}-C${cid}-A${attemptNumber}`;

    const createdAttempt = await airtableFetchJson(tableUrl(baseId, attemptsTable), apiKey, {
      method: "POST",
      body: JSON.stringify({
        records: [
          {
            fields: {
              AttemptKey: attemptKey,
              User: [userRecordId],     // Linked record field
              AttemptNumber: attemptNumber,
              CaseID: cid,
              SessionID: sid,
              Transcript: transcriptText,
              GradingText: gradingText,
            },
          },
        ],
      }),
    });

    const recordId = createdAttempt?.records?.[0]?.id;

    return res.json({ ok: true, sessionId: sid, userId: uid, attemptNumber, recordId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
