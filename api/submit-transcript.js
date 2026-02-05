// api/submit-transcript.js (NO Users Airtable - test mode)
function store() {
  // survives warm invocations; resets on cold start (fine for testing)
  if (!globalThis.__gradingStore) globalThis.__gradingStore = new Map();
  return globalThis.__gradingStore;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { sessionId, caseId, transcript } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });
    if (!caseId) return res.status(400).json({ ok: false, error: "Missing caseId" });
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing transcript[]" });
    }

    // mark as pending
    store().set(sessionId, { status: "pending", ts: Date.now() });

    // --- Airtable (Case base) ---
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    if (!AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
    if (!AIRTABLE_BASE_ID) throw new Error("Missing AIRTABLE_BASE_ID");

    const tableName = `Case ${caseId}`;
    const caseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

    const caseResp = await fetch(caseUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const caseRaw = await caseResp.text();
    let caseData = null;
    try { caseData = JSON.parse(caseRaw); } catch {}
    if (!caseResp.ok) throw new Error(`Airtable error: ${caseRaw.slice(0, 300)}`);

    const records = caseData?.records || [];
    if (!records.length) throw new Error(`No records found in ${tableName}`);

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

    // --- OpenAI grading ---
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

    const transcriptText = transcript.map(t => `${String(t.role).toUpperCase()}: ${t.text}`).join("\n");

    const prompt = `
You are an OSCE examiner. Grade the candidate based ONLY on the transcript vs the marking indicators below.

Domains and scoring:
- Domains: Data gathering & diagnosis (DG), Clinical management (CM), Relating to others (RTO), Application.
- Each domain score: Pass / Borderline Pass / Borderline Fail / Fail.
- FIRST THREE indicators in each positive/negative list are higher weighting.
- For each indicator: Achieved Yes/No with a short evidence quote.
- Be strict: if not clearly evidenced, mark Not achieved.

Return output as ONE TEXT REPORT ONLY (no JSON), formatted:

DG: <score>
✅ <indicator> — "<evidence>"
❌ <indicator> — "<why not evidenced>"

CM: <score>
...

RTO: <score>
...

Application: <score>
<brief justification>

Overall summary: <3–5 lines>

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
        input: prompt,
        text: { verbosity: "low" },
        reasoning: { effort: "low" },
      }),
    });

    const oaiRaw = await oaiResp.text();
    let oai = null;
    try { oai = JSON.parse(oaiRaw); } catch {}

    if (!oaiResp.ok) {
      store().set(sessionId, { status: "error", error: oaiRaw.slice(0, 800), ts: Date.now() });
      return res.status(oaiResp.status).json({ ok: false, error: oaiRaw.slice(0, 800) });
    }

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
    store().set(sessionId, { status: "ready", gradingText, caseId: Number(caseId), ts: Date.now() });

    return res.json({ ok: true, sessionId });
  } catch (e) {
    if (req?.body?.sessionId) {
      store().set(req.body.sessionId, { status: "error", error: e?.message || String(e), ts: Date.now() });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
