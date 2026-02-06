// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/**
 * Key changes vs your earlier versions:
 * - We DO NOT match indicators by text (fragile). We score by INDEX.
 * - OpenAI returns compact arrays of numbers (0/1/2) aligned to criteria order.
 * - Narrative is still rich and tied to criteria (we derive hit/miss lists from scores).
 * - Retry if JSON is truncated or narrative is generic.
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
  const records = await airtableListAll({ apiKey: casesApiKey, baseId: casesBaseId, table });

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

// -------------------- Transcript formatting --------------------

function normalizeRole(role) {
  const r = String(role || "").toLowerCase().trim();
  if (r === "user" || r === "clinician" || r === "doctor") return "CLINICIAN";
  if (r === "assistant" || r === "patient") return "PATIENT";
  return r ? r.toUpperCase() : "UNKNOWN";
}

function transcriptToText(transcript) {
  const trimmed = Array.isArray(transcript) ? transcript : [];
  const last = trimmed.slice(-200); // keep it reasonable
  const lines = [];
  for (const t of last) {
    const who = normalizeRole(t?.role);
    const text = String(t?.text || "").trim();
    if (!text) continue;
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

// -------------------- OpenAI response extraction/parsing --------------------

function collectAllAssistantText(respJson) {
  const out = respJson?.output;
  if (!Array.isArray(out)) return respJson?.output_text || "";
  let s = "";
  for (const item of out) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (typeof c?.text === "string") s += c.text;
      else if (c?.type === "text" && typeof c?.text === "string") s += c.text;
    }
  }
  return s || respJson?.output_text || "";
}

function safeJsonParseAny(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)); } catch {}
  }
  return null;
}

function wordCount(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function looksTooGeneric(s) {
  const t = String(s || "").toLowerCase();
  const banned = [
    "no significant improvements",
    "no improvements needed",
    "performed well",
    "excellent communication",
  ];
  return banned.some((p) => t.includes(p));
}

// -------------------- Bands (guide, not strict) --------------------

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

function w(i) {
  return i < 3 ? 2 : 1; // first 3 heavier
}

function computeDomainBandFromScores(posScores012, negSev012) {
  const pos = Array.isArray(posScores012) ? posScores012 : [];
  const neg = Array.isArray(negSev012) ? negSev012 : [];

  // Core-weighted: first 6 are "core", remainder light-touch
  const coreN = Math.min(6, pos.length);
  const core = pos.slice(0, coreN);
  const optional = pos.slice(coreN);

  const coreMax = core.reduce((a, _v, i) => a + w(i) * 2, 0) || 1;
  const coreGot = core.reduce((a, v, i) => a + w(i) * (Number(v) || 0), 0);

  const optMax = optional.length * 2 || 1;
  const optGot = optional.reduce((a, v) => a + (Number(v) || 0), 0);

  let ratio = 0.85 * (coreGot / coreMax) + 0.15 * (optGot / optMax);

  // gentle negative penalty
  const negMax = neg.length * 2 || 1;
  const negGot = neg.reduce((a, v) => a + (Number(v) || 0), 0);
  const negPenalty = negGot / negMax;

  ratio = Math.max(0, Math.min(1, ratio - 0.15 * negPenalty));
  return bandFromRatio(ratio);
}

// -------------------- Main grading --------------------

export async function gradeTranscriptWithIndicators({ openaiKey, model, transcript, marking }) {
  if (!openaiKey) throw new Error("Missing openaiKey");
  if (!model) throw new Error("Missing model");
  if (!marking) throw new Error("Missing marking");

  const transcriptText = transcriptToText(transcript);
  if (!transcriptText.trim()) throw new Error("Transcript text empty after formatting");

  // We pass criteria as arrays of strings, and FORCE the model to return arrays of equal length (by index).
  const criteria = {
    dg_positive: marking.dg.positive,
    dg_negative: marking.dg.negative,
    cm_positive: marking.cm.positive,
    cm_negative: marking.cm.negative,
    rto_positive: marking.rto.positive,
    rto_negative: marking.rto.negative,
    application: marking.application,
  };

  const outputSchemaHint = {
    // IMPORTANT: arrays MUST be same length as input arrays; values are 0..2
    dg_pos_scores: ["0|1|2"],
    dg_neg_severity: ["0|1|2"],
    cm_pos_scores: ["0|1|2"],
    cm_neg_severity: ["0|1|2"],
    rto_pos_scores: ["0|1|2"],
    rto_neg_severity: ["0|1|2"],
    app_scores: ["0|1|2"],
    narrative: {
      dg: { paragraph: "string", example_phrases: ["string"] },
      cm: { paragraph: "string", example_phrases: ["string"] },
      rto: { paragraph: "string", example_phrases: ["string"] },
      overall: { paragraph: "string", priorities_next_time: ["string"] },
    },
  };

  async function callOpenAI({ retryMode = false } = {}) {
    const payload = {
      model,
      input: [
        {
          role: "system",
          content:
            "You are an OSCE examiner. Use the marking criteria as a GUIDE, not a strict word-for-word checklist.\n" +
            "Be fair: give PARTIAL credit when the intent is present but incomplete.\n" +
            "Do NOT require exact wording.\n\n" +
            "Return ONLY valid JSON. No markdown.\n\n" +
            "SCORING OUTPUT (critical):\n" +
            "- For each POSITIVE criteria list, return an array of scores 0..2 in the SAME ORDER and SAME LENGTH as provided:\n" +
            "  0 = not addressed, 1 = partially addressed, 2 = clearly addressed.\n" +
            "- For each NEGATIVE criteria list, return severity 0..2 in the SAME ORDER and SAME LENGTH:\n" +
            "  0 = not present, 1 = mild issue, 2 = major issue.\n" +
            "- Keep per-criterion output VERY short (numbers only). Do NOT repeat or rewrite the indicator text.\n\n" +
            "NARRATIVE OUTPUT (critical):\n" +
            "- For EACH domain (DG/CM/RTO) write ONE substantial paragraph (about 120–200 words) that includes BOTH:\n" +
            "  (a) what was done well tied to the criteria they hit, AND\n" +
            "  (b) what to improve tied to criteria they partially missed.\n" +
            "- Include 2–4 short example phrases the candidate used (from CLINICIAN lines) per domain.\n" +
            "- Do NOT say 'no improvements needed' unless it is a clear PASS and there are no meaningful gaps.\n" +
            (retryMode
              ? "\nRETRY MODE: Your last output was too generic or invalid JSON. Be more specific, and keep JSON compact."
              : ""),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              transcript: transcriptText,
              note: "CLINICIAN lines are the candidate; PATIENT lines are the simulator.",
              criteria,
              output_schema_hint: outputSchemaHint,
            },
            null,
            2
          ),
        },
      ],
      text: { format: { type: "json_object" } },
      temperature: 0.2,
      max_output_tokens: 6000, // raise headroom to avoid truncation
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
    if (!parsed) {
      throw new Error(`OpenAI returned non-JSON. Preview: ${String(outText).slice(0, 260)}`);
    }
    return parsed;
  }

  let parsed;
  try {
    parsed = await callOpenAI({ retryMode: false });
  } catch (e) {
    // One retry if JSON got truncated / invalid
    parsed = await callOpenAI({ retryMode: true });
  }

  // Ensure arrays match expected lengths (pad/truncate)
  function normalize012Array(arr, n) {
    const a = Array.isArray(arr) ? arr.map((v) => Number(v)) : [];
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = a[i];
      out.push(v === 0 || v === 1 || v === 2 ? v : 0);
    }
    return out;
  }

  const dgPosScores = normalize012Array(parsed.dg_pos_scores, marking.dg.positive.length);
  const dgNegSev = normalize012Array(parsed.dg_neg_severity, marking.dg.negative.length);
  const cmPosScores = normalize012Array(parsed.cm_pos_scores, marking.cm.positive.length);
  const cmNegSev = normalize012Array(parsed.cm_neg_severity, marking.cm.negative.length);
  const rtoPosScores = normalize012Array(parsed.rto_pos_scores, marking.rto.positive.length);
  const rtoNegSev = normalize012Array(parsed.rto_neg_severity, marking.rto.negative.length);
  const appScores = normalize012Array(parsed.app_scores, marking.application.length);

  const dgBand = computeDomainBandFromScores(dgPosScores, dgNegSev);
  const cmBand = computeDomainBandFromScores(cmPosScores, cmNegSev);
  const rtoBand = computeDomainBandFromScores(rtoPosScores, rtoNegSev);
  const appBand = bandFromRatio((appScores.reduce((a, v) => a + v, 0)) / ((appScores.length * 2) || 1));

  const overallIdx =
    Math.round(
      (BANDS.indexOf(dgBand) + BANDS.indexOf(cmBand) + BANDS.indexOf(rtoBand) + BANDS.indexOf(appBand)) / 4
    );
  const overall = BANDS[clampBandIndex(overallIdx)];

  // Derive "criteria hit/missed" from scores (guide)
  function hitMissFromScores(indicators, scores) {
    const hits = [];
    const misses = [];
    for (let i = 0; i < indicators.length; i++) {
      const s = scores[i] || 0;
      if (s >= 1) hits.push(indicators[i]);      // partial counts as "touched"
      else misses.push(indicators[i]);
    }
    return { hits, misses };
  }

  const dgHM = hitMissFromScores(marking.dg.positive, dgPosScores);
  const cmHM = hitMissFromScores(marking.cm.positive, cmPosScores);
  const rtoHM = hitMissFromScores(marking.rto.positive, rtoPosScores);

  // Narrative
  const n = parsed.narrative || {};
  const ndg = n.dg || {};
  const ncm = n.cm || {};
  const nrto = n.rto || {};
  const nov = n.overall || {};

  // If narrative is still too generic, force a second refinement call (rare, but helps)
  const dgPara = String(ndg.paragraph || "").trim();
  const cmPara = String(ncm.paragraph || "").trim();
  const rtoPara = String(nrto.paragraph || "").trim();

  if (
    wordCount(dgPara) < 80 || wordCount(cmPara) < 80 || wordCount(rtoPara) < 80 ||
    looksTooGeneric(dgPara) || looksTooGeneric(cmPara) || looksTooGeneric(rtoPara)
  ) {
    // One more refinement attempt
    parsed = await callOpenAI({ retryMode: true });
  }

  const nn = parsed.narrative || {};
  const dgP = String((nn.dg || {}).paragraph || "").trim();
  const cmP = String((nn.cm || {}).paragraph || "").trim();
  const rtoP = String((nn.rto || {}).paragraph || "").trim();
  const ovP = String((nn.overall || {}).paragraph || "").trim();

  function top(arr, n = 6) {
    return (Array.isArray(arr) ? arr : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, n);
  }

  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    "",
    dgP,
    top((nn.dg || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((nn.dg || {}).example_phrases, 4).map((p) => `"${p}"`).join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...dgHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...dgHM.misses.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Clinical Management: **${cmBand}**`,
    "",
    cmP,
    top((nn.cm || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((nn.cm || {}).example_phrases, 4).map((p) => `"${p}"`).join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...cmHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...cmHM.misses.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Relating to Others: **${rtoBand}**`,
    "",
    rtoP,
    top((nn.rto || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((nn.rto || {}).example_phrases, 4).map((p) => `"${p}"`).join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...rtoHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...rtoHM.misses.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Overall: **${overall}**`,
    "",
    ovP,
    "",
    `**Next priorities:**`,
    ...top((nn.overall || {}).priorities_next_time, 5).map((x) => `- ${x}`),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand, overall },
  };
}
