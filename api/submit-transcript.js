// api/submit-transcript.js
export default async function handler(req, res) {
  // CORS (Squarespace)
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { sessionId, caseId, userId, transcript } = req.body || {};
    if (!caseId || !Array.isArray(transcript)) {
      return res.status(400).json({ ok: false, error: "Missing caseId or transcript[]" });
    }

    // --- Load case grading indicators from Airtable (Case base) ---
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
    if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

    const tableName = `Case ${caseId}`;
    const caseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

    const caseResp = await fetch(caseUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const caseText = await caseResp.text();
    let caseData;
    try { caseData = JSON.parse(caseText); } catch { caseData = null; }
    if (!caseResp.ok) {
      return res.status(caseResp.status).json({ ok: false, error: caseText.slice(0, 400) });
    }

    const records = caseData?.records || [];
    if (!records.length) throw new Error(`No records found in ${tableName}`);

    // Helper: combine field values across rows
    const combine = (field) => {
      const parts = [];
      for (const r of records) {
        const v = r?.fields?.[field];
        if (v == null) continue;
        const s = String(v).trim();
        if (s) parts.push(s);
      }
      return parts.join("\n");
    };

    const rubric = {
      dg_pos: combine("DG positive"),
      dg_neg: combine("DG negative"),
      cm_pos: combine("CM positive"),
      cm_neg: combine("CM negative"),
      rto_pos: combine("RTO positive"),
      rto_neg: combine("RTO negative"),
      application: combine("Application"),
    };

    // --- Grade with OpenAI Responses API ---
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

    const transcriptText = transcript
      .map((t) => `${t.role.toUpperCase()}: ${t.text}`)
      .join("\n");

    const gradingPrompt = `
You are an OSCE examiner. Grade the candidate based ONLY on the transcript vs the marking indicators below.

Marking scheme rules:
- Domains: DG, CM, RTO, Application.
- Each domain gets one of: Pass, Borderline Pass, Borderline Fail, Fail.
- The FIRST THREE indicators in each positive/negative list are higher weighting.
- Decide if each indicator is achieved (yes/no) and quote short supporting evidence from the transcript.
- Be strict: if not clearly evidenced, mark as not achieved.
- Output TWO things:
  1) A JSON object with per-domain results and indicator checklist
  2) A readable text report (same content), formatted for display on a website.

Indicators:
DG positive:
${rubric.dg_pos || "[none]"}
DG negative:
${rubric.dg_neg || "[none]"}

CM positive:
${rubric.cm_pos || "[none]"}
CM negative:
${rubric.cm_neg || "[none]"}

RTO positive:
${rubric.rto_pos || "[none]"}
RTO negative:
${rubric.rto_neg || "[none]"}

Application:
${rubric.application || "[none]"}

Transcript:
${transcriptText}
`.trim();

    const oaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: gradingPrompt,
        text: { verbosity: "low" },
        reasoning: { effort: "none" },
      }),
    });

    const oaiRaw = await oaiResp.text();
    let oai;
    try { oai = JSON.parse(oaiRaw); } catch { oai = null; }
    if (!oaiResp.ok) {
      return res.status(oaiResp.status).json({ ok: false, error: oaiRaw.slice(0, 800) });
    }

    // Responses API returns content in output_text convenience on many SDKs,
    // but via raw HTTP we’ll extract the first text we can find.
    const extractText = (resp) => {
      if (!resp) return "";
      if (typeof resp.output_text === "string") return resp.output_text;
      const out = resp.output || [];
      for (const item of out) {
        const content = item?.content || [];
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
          if (typeof c?.text === "string") return c.text;
        }
      }
      return "";
    };

    const gradingText = extractText(oai) || "[No grading text returned]";
    const gradingJson = JSON.stringify({ rubric, transcript, openai: oai }, null, 2);

    // --- Store in Users AI Airtable (Attempts table) ---
    const USERS_AIRTABLE_API_KEY = process.env.USERS_AIRTABLE_API_KEY;
    const USERS_AIRTABLE_BASE_ID = process.env.USERS_AIRTABLE_BASE_ID;
    const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || "Attempts";

    if (!USERS_AIRTABLE_API_KEY) throw new Error("Missing USERS_AIRTABLE_API_KEY");
    if (!USERS_AIRTABLE_BASE_ID) throw new Error("Missing USERS_AIRTABLE_BASE_ID");

    const usersUrl = `https://api.airtable.com/v0/${USERS_AIRTABLE_BASE_ID}/${encodeURIComponent(USERS_TABLE_NAME)}`;

    const createResp = await fetch(usersUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${USERS_AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              sessionId: sessionId || "",
              caseId: Number(caseId),
              userId: userId || "",
              gradingText,
              gradingJson,
            },
          },
        ],
      }),
    });

    const createRaw = await createResp.text();
    if (!createResp.ok) {
      return res.status(createResp.status).json({ ok: false, error: createRaw.slice(0, 800) });
    }

    return res.json({ ok: true, sessionId: sessionId || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
