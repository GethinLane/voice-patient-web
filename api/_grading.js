// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/* =========================================================
   Airtable: load indicators from Case {N} table
   ========================================================= */

function combineFieldAcrossRows(records, fieldName) {
  const parts = [];
  for (const r of records || []) {
    const v = r?.fields?.[fieldName];
    if (v == null) continue;
    const t = (typeof v === "string" ? v : String(v)).trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

function parseIndicators(text) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .map((l) => l.replace(/^[\-\*\u2022]+\s*/, "")) // bullets
    .map((l) => l.replace(/^\(?\d+[\).\]]\s*/, "")) // "1." "2)" etc
    .map((l) => l.trim())
    .filter((l) => l.length >= 3);
}

export async function loadCaseMarking({ caseId, casesApiKey, casesBaseId }) {
  const table = `Case ${caseId}`;

  const records = await airtableListAll({
    apiKey: casesApiKey,
    baseId: casesBaseId,
    table,
  });

  const dgPos = parseIndicators(combineFieldAcrossRows(records, "DG positive"));
  const dgNeg = parseIndicators(combineFieldAcrossRows(records, "DG negative"));
  const cmPos = parseIndicators(combineFieldAcrossRows(records, "CM positive"));
  const cmNeg = parseIndicators(combineFieldAcrossRows(records, "CM negative"));
  const rtoPos = parseIndicators(combineFieldAcrossRows(records, "RTO positive"));
  const rtoNeg = parseIndicators(combineFieldAcrossRows(records, "RTO negative"));
  const app = parseIndicators(combineFieldAcrossRows(records, "Application"));

  return {
    table,
    dg: { positive: dgPos, negative: dgNeg },
    cm: { positive: cmPos, negative: cmNeg },
    rto: { positive: rtoPos, negative: rtoNeg },
    application: app,
  };
}

/* =========================================================
   Transcript formatting
   ========================================================= */

function normalizeRole(role) {
  const r = String(role || "").toLowerCase().trim();
  if (r === "user" || r === "clinician" || r === "doctor") return "CLINICIAN";
  if (r === "assistant" || r === "patient") return "PATIENT";
  return r ? r.toUpperCase() : "UNKNOWN";
}

function transcriptToText(transcript) {
  const trimmed = Array.isArray(transcript) ? transcript : [];
  const last = trimmed.slice(-160); // cap token cost
  const lines = [];
  for (const t of last) {
    const who = normalizeRole(t?.role);
    const text = String(t?.text || "").trim();
    if (!text) continue;
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

/* =========================================================
   OpenAI response extraction + parsing
   ========================================================= */

function collectAllAssistantText(respJson) {
  const out = respJson?.output;
  if (!Array.isArray(out)) return respJson?.output_text || "";

  let s = "";
  for (const item of out) {
    if (item?.type !== "message") continue;
    if (item?.role !== "assistant") continue;

    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      if (typeof c?.text === "string") s += c.text; // output_text or text
      else if (c?.type === "text" && typeof c?.text === "string") s += c.text;
    }
  }
  return s || respJson?.output_text || "";
}

function safeJsonParseAny(text) {
  if (!text) return null;

  const t = String(text).trim();

  // direct
  try {
    return JSON.parse(t);
  } catch {}

  // salvage largest {...}
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    const slice = t.slice(i, j + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

/* =========================================================
   Rubric scoring + banding
   - Positives: score 0/1/2 (not / partial / clear)
   - Negatives: severity 0/1/2 (none / mild / major)
   ========================================================= */

const BANDS = ["Fail", "Borderline Fail", "Borderline Pass", "Pass"];

function bandFromRatio(r) {
  if (r >= 0.75) return "Pass";
  if (r >= 0.55) return "Borderline Pass";
  if (r >= 0.35) return "Borderline Fail";
  return "Fail";
}

function ratioFromScores(posArr) {
  const max = (posArr.length * 2) || 1;
  const got = posArr.reduce((a, it) => a + (it.score || 0), 0);
  return got / max;
}

function penaltyFromNeg(negArr) {
  const max = (negArr.length * 2) || 1;
  const got = negArr.reduce((a, it) => a + (it.severity || 0), 0);
  return got / max;
}

function bandFromRubric(ratio, negPenalty) {
  // gentle penalty, not catastrophic
  const adjusted = Math.max(0, Math.min(1, ratio - 0.25 * negPenalty));
  return bandFromRatio(adjusted);
}

function clamp012(n) {
  const x = Number(n);
  return x === 0 || x === 1 || x === 2 ? x : 0;
}

// safer zipping: allow slight text mismatches by index fallback
function zipPos(indicators, arr) {
  const src = Array.isArray(arr) ? arr : [];
  const map = new Map(src.map((x) => [String(x.indicator || "").trim(), x]));

  return (indicators || []).map((indicator, idx) => {
    const key = String(indicator || "").trim();
    const found = map.get(key) || src[idx] || {};
    return {
      indicator: key,
      score: clamp012(found.score),
      note: String(found.note || found.evidence || "").trim(),
    };
  });
}

function zipNeg(indicators, arr) {
  const src = Array.isArray(arr) ? arr : [];
  const map = new Map(src.map((x) => [String(x.indicator || "").trim(), x]));

  return (indicators || []).map((indicator, idx) => {
    const key = String(indicator || "").trim();
    const found = map.get(key) || src[idx] || {};
    return {
      indicator: key,
      severity: clamp012(found.severity),
      note: String(found.note || found.evidence || "").trim(),
    };
  });
}

/* =========================================================
   Main grading function
   ========================================================= */

export async function gradeTranscriptWithIndicators({ openaiKey, model, transcript, marking }) {
  if (!openaiKey) throw new Error("Missing openaiKey");
  if (!model) throw new Error("Missing model");
  if (!marking) throw new Error("Missing marking");
  if (!Array.isArray(transcript) || transcript.length === 0) throw new Error("Transcript missing/empty");

  const transcriptText = transcriptToText(transcript);
  if (!transcriptText.trim()) throw new Error("Transcript text empty after formatting");

  const schemaHint = {
    dg_positive: [{ indicator: "string", score: "0|1|2", note: "string" }],
    dg_negative: [{ indicator: "string", severity: "0|1|2", note: "string" }],
    cm_positive: [{ indicator: "string", score: "0|1|2", note: "string" }],
    cm_negative: [{ indicator: "string", severity: "0|1|2", note: "string" }],
    rto_positive: [{ indicator: "string", score: "0|1|2", note: "string" }],
    rto_negative: [{ indicator: "string", severity: "0|1|2", note: "string" }],
    application: [{ indicator: "string", score: "0|1|2", note: "string" }],
    narrative: {
      dg: { strengths: "string", improvements: "string" },
      cm: { strengths: "string", improvements: "string" },
      rto: { strengths: "string", improvements: "string" },
      overall: { summary: "string", next_steps: "string" },
    },
  };

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an OSCE examiner.\n" +
          "Use the marking indicators as GUIDANCE (a rubric), not a strict checklist.\n" +
          "Be balanced: credit partial attempts and good reasoning.\n" +
          "Do not require exact wording and do not demand direct quotes.\n" +
          "Return ONLY valid JSON (no markdown).\n\n" +
          "Scoring:\n" +
          "- For positives: score 0/1/2 (0 not addressed, 1 partially/implicitly, 2 clearly).\n" +
          "- For negatives: severity 0/1/2 (0 none, 1 mild concern, 2 major concern).\n" +
          "Notes can be a short paraphrase of what the clinician did/didn't do.\n" +
          "Narrative should be concise and specific to this transcript.\n",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            transcript: transcriptText,
            indicators: {
              dg_positive: marking.dg.positive,
              dg_negative: marking.dg.negative,
              cm_positive: marking.cm.positive,
              cm_negative: marking.cm.negative,
              rto_positive: marking.rto.positive,
              rto_negative: marking.rto.negative,
              application: marking.application,
            },
            output_schema_hint: schemaHint,
          },
          null,
          2
        ),
      },
    ],
    text: { format: { type: "json_object" } },
    temperature: 0,
    max_output_tokens: 2200,
  };

  async function callOpenAI(body) {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await resp.text();
    if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${raw.slice(0, 400)}`);
    return raw ? JSON.parse(raw) : null;
  }

  let parsed = null;

  // First attempt
  const data1 = await callOpenAI(payload);
  const outText1 = collectAllAssistantText(data1);
  parsed = safeJsonParseAny(outText1);

  // Retry once with stricter "return JSON only" phrasing if parse failed
  if (!parsed) {
    const retry = {
      ...payload,
      input: [
        {
          role: "system",
          content:
            "Return ONLY valid JSON. No markdown. No commentary outside JSON.\n" +
            "Follow the output schema. Keep narrative fields short.\n",
        },
        payload.input[1],
      ],
      max_output_tokens: 2600,
    };

    const data2 = await callOpenAI(retry);
    const outText2 = collectAllAssistantText(data2);
    parsed = safeJsonParseAny(outText2);
  }

  if (!parsed) {
    throw new Error("OpenAI returned non-JSON output (failed to parse).");
  }

  // Zip results back to Airtable indicator ordering
  const dgPos = zipPos(marking.dg.positive, parsed.dg_positive);
  const dgNeg = zipNeg(marking.dg.negative, parsed.dg_negative);
  const cmPos = zipPos(marking.cm.positive, parsed.cm_positive);
  const cmNeg = zipNeg(marking.cm.negative, parsed.cm_negative);
  const rtoPos = zipPos(marking.rto.positive, parsed.rto_positive);
  const rtoNeg = zipNeg(marking.rto.negative, parsed.rto_negative);
  const appPos = zipPos(marking.application, parsed.application);

  const dgBand = bandFromRubric(ratioFromScores(dgPos), penaltyFromNeg(dgNeg));
  const cmBand = bandFromRubric(ratioFromScores(cmPos), penaltyFromNeg(cmNeg));
  const rtoBand = bandFromRubric(ratioFromScores(rtoPos), penaltyFromNeg(rtoNeg));
  const appBand = bandFromRatio(ratioFromScores(appPos));

  const n = parsed.narrative || {};
  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    (n.dg?.strengths || "Strengths: (not provided)").trim(),
    "",
    `What to improve:`,
    (n.dg?.improvements || "Improvements: (not provided)").trim(),
    "",
    `## Clinical Management: **${cmBand}**`,
    (n.cm?.strengths || "Strengths: (not provided)").trim(),
    "",
    `What to improve:`,
    (n.cm?.improvements || "Improvements: (not provided)").trim(),
    "",
    `## Relating to Others: **${rtoBand}**`,
    (n.rto?.strengths || "Strengths: (not provided)").trim(),
    "",
    `What to improve:`,
    (n.rto?.improvements || "Improvements: (not provided)").trim(),
    "",
    `## Overall`,
    (n.overall?.summary || "Summary: (not provided)").trim(),
    "",
    `Next steps:`,
    (n.overall?.next_steps || "Next steps: (not provided)").trim(),
    "",
    `\n(Internal bands: DG=${dgBand}, CM=${cmBand}, RTO=${rtoBand}, App=${appBand})`,
  ].join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand },
  };
}
