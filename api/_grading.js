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

export async function gradeTranscriptWithIndicators({
  openaiKey,
  model,
  transcript,
  marking,
}) {
  if (!openaiKey) throw new Error("Missing openaiKey");
  if (!model) throw new Error("Missing model");
  if (!marking) throw new Error("Missing marking");
  if (!Array.isArray(transcript) || transcript.length === 0) {
    throw new Error("Transcript missing/empty");
  }

  const transcriptText = transcriptToText(transcript);
  if (!transcriptText.trim()) throw new Error("Transcript text empty after formatting");

  // Strong anti-generic instruction:
  // - MUST include exact short quotes per section (validated server-side)
  // - MUST provide narrative strengths/improvements grounded in transcript
  const schemaHint = {
    dg_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
    dg_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
    cm_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
    cm_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
    rto_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
    rto_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
    application: [{ indicator: "string", met: "boolean", evidence: "string" }],
    narrative: {
      dg: {
        strengths: "string",
        improvements: "string",
        quotes: ["string"], // EXACT words copied from transcript
      },
      cm: {
        strengths: "string",
        improvements: "string",
        quotes: ["string"],
      },
      rto: {
        strengths: "string",
        improvements: "string",
        quotes: ["string"],
      },
      overall: {
        what_went_well: "string",
        next_time: "string",
        quotes: ["string"],
      },
    },
  };

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an OSCE examiner grading a candidate clinician from a transcript.\n" +
          "Return ONLY valid JSON. No markdown. No bullet lists in the narrative.\n" +
          "You MUST be transcript-grounded and specific:\n" +
          "- Every narrative paragraph must refer to what was/wasn't said in THIS transcript.\n" +
          "- Include EXACT short quotes copied from the transcript (required arrays) to prove grounding.\n" +
          "- Do NOT give generic advice. Do NOT invent missing content.\n" +
          "Indicator rules:\n" +
          "- For each indicator, set met/occurred ONLY if clearly evidenced.\n" +
          "- If uncertain, set false and keep evidence as empty string.\n" +
          "Narrative rules:\n" +
          "- Provide 2 short paragraphs per domain: strengths then improvements.\n" +
          "- Overall should compare performance to Application (what aligned / what didn’t).\n" +
          "- Narrative fields MUST be non-empty.\n",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            transcript: transcriptText,
            // Note: "CLINICIAN" lines are the candidate; "PATIENT" lines are the simulated patient.
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
            quote_rules: {
              exact_copy_required: true,
              max_quotes_each_section: 3,
              max_quote_length_chars: 140,
            },
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

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI error ${resp.status}: ${raw.slice(0, 400)}`);
  }

  const data = raw ? JSON.parse(raw) : null;
  const outText = collectAllAssistantText(data);
  const parsed = safeJsonParseAny(outText);

  if (!parsed) {
    throw new Error(`OpenAI returned non-JSON output_text preview: ${String(outText).slice(0, 260)}`);
  }

  // Enforce required shapes before we do anything else (NO fallback)
  requireIndicatorArrays(parsed, marking);

  // Enforce narrative presence + evidence quotes that MUST appear in transcript
  const narrative = parsed.narrative || {};

  const dgStrengths = requireNonEmptyString(narrative?.dg?.strengths, "narrative.dg.strengths");
  const dgImprove = requireNonEmptyString(narrative?.dg?.improvements, "narrative.dg.improvements");
  const dgQuotes = requireQuotesInTranscript(narrative?.dg?.quotes, transcriptText, "narrative.dg.quotes");

  const cmStrengths = requireNonEmptyString(narrative?.cm?.strengths, "narrative.cm.strengths");
  const cmImprove = requireNonEmptyString(narrative?.cm?.improvements, "narrative.cm.improvements");
  const cmQuotes = requireQuotesInTranscript(narrative?.cm?.quotes, transcriptText, "narrative.cm.quotes");

  const rtoStrengths = requireNonEmptyString(narrative?.rto?.strengths, "narrative.rto.strengths");
  const rtoImprove = requireNonEmptyString(narrative?.rto?.improvements, "narrative.rto.improvements");
  const rtoQuotes = requireQuotesInTranscript(narrative?.rto?.quotes, transcriptText, "narrative.rto.quotes");

  const overallGood = requireNonEmptyString(narrative?.overall?.what_went_well, "narrative.overall.what_went_well");
  const overallNext = requireNonEmptyString(narrative?.overall?.next_time, "narrative.overall.next_time");
  const overallQuotes = requireQuotesInTranscript(
    narrative?.overall?.quotes,
    transcriptText,
    "narrative.overall.quotes"
  );

  // Normalize arrays to match original indicator ordering (keeps weighting stable)
  function zipPos(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return (indicators || []).map((indicator) => {
      const x = map.get(indicator) || {};
      return {
        indicator,
        met: !!x.met,
        evidence: (x.evidence || "").toString().trim(),
      };
    });
  }

  function zipNeg(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return (indicators || []).map((indicator) => {
      const x = map.get(indicator) || {};
      return {
        indicator,
        occurred: !!x.occurred,
        evidence: (x.evidence || "").toString().trim(),
      };
    });
  }

  const dgPos = zipPos(marking.dg.positive, parsed.dg_positive);
  const dgNeg = zipNeg(marking.dg.negative, parsed.dg_negative);
  const cmPos = zipPos(marking.cm.positive, parsed.cm_positive);
  const cmNeg = zipNeg(marking.cm.negative, parsed.cm_negative);
  const rtoPos = zipPos(marking.rto.positive, parsed.rto_positive);
  const rtoNeg = zipNeg(marking.rto.negative, parsed.rto_negative);

  // Application met list (not displayed as pass/fail; used in overall band return if you want it later)
  const appPos = zipPos(marking.application, parsed.application);

  const dgBand = computeDomainBand(dgPos, dgNeg);
  const cmBand = computeDomainBand(cmPos, cmNeg);
  const rtoBand = computeDomainBand(rtoPos, rtoNeg);

  // Optional internal application band (NOT shown in gradingText)
  const appMax = appPos.reduce((a, _it, i) => a + weightForIndex(i), 0) || 1;
  const appGot = appPos.reduce((a, it, i) => a + (it.met ? weightForIndex(i) : 0), 0);
  const appBand = bandFromRatio(appGot / appMax);

  // Build the output exactly as you requested: 4 sections, narrative only, no ✅/❌ lists
  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    ``,
    dgStrengths,
    ``,
    `What to improve:`,
    dgImprove,
    ``,
    `Evidence quotes:`,
    ...dgQuotes.map((q) => `- "${q}"`),
    ``,
    `## Clinical Management: **${cmBand}**`,
    ``,
    cmStrengths,
    ``,
    `What to improve:`,
    cmImprove,
    ``,
    `Evidence quotes:`,
    ...cmQuotes.map((q) => `- "${q}"`),
    ``,
    `## Relating to Others: **${rtoBand}**`,
    ``,
    rtoStrengths,
    ``,
    `What to improve:`,
    rtoImprove,
    ``,
    `Evidence quotes:`,
    ...rtoQuotes.map((q) => `- "${q}"`),
    ``,
    `## Overall`,
    ``,
    overallGood,
    ``,
    `Next time:`,
    overallNext,
    ``,
    `Evidence quotes:`,
    ...overallQuotes.map((q) => `- "${q}"`),
  ].join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand },
    // If you ever want debugging/inspection later:
    // indicatorResults: { dgPos, dgNeg, cmPos, cmNeg, rtoPos, rtoNeg, appPos },
  };
}
