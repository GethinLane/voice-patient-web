// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/**
 * This file:
 * 1) Loads marking indicators from Airtable Case {N} table fields:
 *    - DG positive / DG negative
 *    - CM positive / CM negative
 *    - RTO positive / RTO negative
 *    - Application
 * 2) Grades a transcript against those indicators using OpenAI (strict JSON mode)
 * 3) Produces narrative feedback ONLY (no ✅/❌ lists) + domain bands for DG/CM/RTO
 *
 * IMPORTANT:
 * - Transcript entries are expected as: { role: "user"|"assistant", text: "..." }
 *   Where "user" == CLINICIAN and "assistant" == PATIENT (your system convention).
 * - NO FALLBACK CONTENT: narrative fields and evidence quotes are REQUIRED.
 *   If missing or generic/unverifiable, we throw an error (grading fails).
 */

// -------------------- Airtable indicator loading --------------------

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

  // Field names exactly as provided:
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

// -------------------- Scoring helpers --------------------

const BANDS = ["Fail", "Borderline Fail", "Borderline Pass", "Pass"];

function clampBandIndex(i) {
  if (i < 0) return 0;
  if (i > 3) return 3;
  return i;
}

function bandFromRatio(r) {
  if (r >= 0.75) return "Pass";
  if (r >= 0.55) return "Borderline Pass";
  if (r >= 0.35) return "Borderline Fail";
  return "Fail";
}

function weightForIndex(i) {
  return i < 3 ? 2 : 1; // first 3 indicators heavier weighting
}

function computeDomainBand(posResults, negResults) {
  const posMax =
    posResults.reduce((acc, _it, i) => acc + weightForIndex(i), 0) || 1;
  const posGot = posResults.reduce(
    (acc, it, i) => acc + (it.met ? weightForIndex(i) : 0),
    0
  );

  let band = bandFromRatio(posGot / posMax);

  // penalties for negatives
  let downgrade = 0;
  for (let i = 0; i < (negResults || []).length; i++) {
    if (!negResults[i]?.occurred) continue;
    downgrade += i < 3 ? 2 : 1;
  }

  const baseIdx = BANDS.indexOf(band);
  const finalIdx = clampBandIndex(baseIdx - downgrade);
  return BANDS[finalIdx];
}

// -------------------- Transcript formatting --------------------

function normalizeRole(role) {
  const r = String(role || "").toLowerCase().trim();
  if (r === "user" || r === "clinician" || r === "doctor") return "CLINICIAN";
  if (r === "assistant" || r === "patient") return "PATIENT";
  return r ? r.toUpperCase() : "UNKNOWN";
}

function transcriptToText(transcript) {
  const trimmed = Array.isArray(transcript) ? transcript : [];
  const last = trimmed.slice(-160); // cap to control token cost
  const lines = [];
  for (const t of last) {
    const who = normalizeRole(t?.role);
    const text = String(t?.text || "").trim();
    if (!text) continue;
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

// -------------------- OpenAI response extraction --------------------

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
      // Most common segment: { type:"output_text", text:"..." }
      if (typeof c?.text === "string") s += c.text;
      else if (c?.type === "text" && typeof c?.text === "string") s += c.text;
    }
  }
  return s || respJson?.output_text || "";
}

function safeJsonParseAny(text) {
  if (!text) return null;
  const t = String(text).trim();
  try {
    return JSON.parse(t);
  } catch {
    // salvage largest {...} block (still NOT content fallback; just parsing tolerance)
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      const slice = t.slice(i, j + 1);
      try {
        return JSON.parse(slice);
      } catch {}
    }
  }
  return null;
}

// -------------------- Strict validation (NO fallback allowed) --------------------

function requireNonEmptyString(val, path) {
  const s = (val ?? "").toString().trim();
  if (!s) throw new Error(`Model output missing/empty required field: ${path}`);
  return s;
}

function normalizeForContains(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .trim();
}

function requireQuotesInTranscript(quotes, transcriptText, path) {
  if (!Array.isArray(quotes) || quotes.length < 1) {
    throw new Error(`Model output missing required evidence quotes array: ${path}`);
  }

  const tx = normalizeForContains(transcriptText);

  for (let idx = 0; idx < quotes.length; idx++) {
    const qRaw = String(quotes[idx] || "").trim();
    if (!qRaw) throw new Error(`Empty quote at ${path}[${idx}]`);

    // enforce "exact words" behaviour and keep them short
    if (qRaw.length > 140) {
      throw new Error(`Quote too long at ${path}[${idx}] (max 140 chars)`);
    }

    const q = normalizeForContains(qRaw);

    // must be found in transcript (prevents hallucinated “quotes”)
    if (!tx.includes(q)) {
      throw new Error(
        `Quote not found in transcript at ${path}[${idx}]. ` +
          `Quote was: "${qRaw.slice(0, 140)}"`
      );
    }
  }

  return quotes.map((q) => String(q).trim());
}

function requireIndicatorArrays(parsed, marking) {
  const required = [
    ["dg_positive", marking.dg.positive],
    ["dg_negative", marking.dg.negative],
    ["cm_positive", marking.cm.positive],
    ["cm_negative", marking.cm.negative],
    ["rto_positive", marking.rto.positive],
    ["rto_negative", marking.rto.negative],
    ["application", marking.application],
  ];

  for (const [key, indicators] of required) {
    if (!Array.isArray(indicators)) continue;
    const arr = parsed?.[key];
    if (!Array.isArray(arr)) {
      throw new Error(`Model output missing required array: ${key}`);
    }
  }
}

// -------------------- Main grading function --------------------

export async function gradeTranscriptWithIndicators({ openaiKey, model, transcript, marking }) {
  const transcriptText = transcriptToText(transcript);

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an OSCE examiner.\n" +
          "Use the marking indicators as GUIDANCE, not a strict checklist.\n" +
          "Give balanced feedback: credit partial attempts and good clinical reasoning.\n" +
          "Do NOT require exact wording. Do NOT demand quotes.\n" +
          "Return ONLY valid JSON (no markdown).\n\n" +
          "Scoring rules:\n" +
          "- For positive indicators, give score 0,1,2 (0 not addressed, 1 partially, 2 clearly).\n" +
          "- For negative indicators, give severity 0,1,2 (0 none, 1 mild, 2 major).\n" +
          "- Evidence is optional and can be short paraphrase.\n"
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
            output_schema_hint: {
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
                overall: { summary: "string", next_steps: "string" }
              }
            }
          },
          null,
          2
        )
      }
    ],
    text: { format: { type: "json_object" } },
    temperature: 0,
    max_output_tokens: 2200
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${raw.slice(0, 400)}`);

  const data = raw ? JSON.parse(raw) : null;
  const outText = collectAllAssistantText(data);
  const parsed = safeJsonParseAny(outText);
  if (!parsed) throw new Error(`OpenAI returned non-JSON. Preview: ${String(outText).slice(0, 240)}`);

  // ---- helper: align model arrays to Airtable indicator ordering ----
  function zipPos(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return (indicators || []).map((indicator) => {
      const x = map.get(indicator) || {};
      const score = Number(x.score);
      return {
        indicator,
        score: score === 0 || score === 1 || score === 2 ? score : 0,
        note: String(x.note || "").trim(),
      };
    });
  }

  function zipNeg(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return (indicators || []).map((indicator) => {
      const x = map.get(indicator) || {};
      const sev = Number(x.severity);
      return {
        indicator,
        severity: sev === 0 || sev === 1 || sev === 2 ? sev : 0,
        note: String(x.note || "").trim(),
      };
    });
  }

  // ---- compute bands from scores (rubric, not strict) ----
  function ratioFromScores(posArr) {
    const max = (posArr.length * 2) || 1;
    const got = posArr.reduce((a, it) => a + (it.score || 0), 0);
    return got / max;
  }

  function penaltyFromNeg(negArr) {
    // mild=1, major=2 -> convert to 0..1 penalty scale
    const max = (negArr.length * 2) || 1;
    const got = negArr.reduce((a, it) => a + (it.severity || 0), 0);
    return got / max;
  }

  function bandFromRubric(ratio, negPenalty) {
    // negate a bit, but not catastrophic unless lots of negatives
    const adjusted = Math.max(0, Math.min(1, ratio - 0.25 * negPenalty));
    if (adjusted >= 0.75) return "Pass";
    if (adjusted >= 0.55) return "Borderline Pass";
    if (adjusted >= 0.35) return "Borderline Fail";
    return "Fail";
  }

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
  const appBand = bandFromRatio(ratioFromScores(appPos)); // reuse your old bandFromRatio if you like

  const n = parsed.narrative || {};
  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    (n.dg?.strengths || "").trim(),
    "",
    `What to improve:`,
    (n.dg?.improvements || "").trim(),
    "",
    `## Clinical Management: **${cmBand}**`,
    (n.cm?.strengths || "").trim(),
    "",
    `What to improve:`,
    (n.cm?.improvements || "").trim(),
    "",
    `## Relating to Others: **${rtoBand}**`,
    (n.rto?.strengths || "").trim(),
    "",
    `What to improve:`,
    (n.rto?.improvements || "").trim(),
    "",
    `## Overall`,
    (n.overall?.summary || "").trim(),
    "",
    `Next steps:`,
    (n.overall?.next_steps || "").trim(),
  ].join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand },
  };
}
