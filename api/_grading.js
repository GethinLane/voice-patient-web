// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/**
 * Key changes vs your earlier versions:
 * - We DO NOT match indicators by text (fragile). We score by INDEX.
 * - OpenAI returns compact arrays of numbers (0/1/2) aligned to criteria order.
 * - Narrative is still rich and tied to criteria (we derive hit/work-on lists from scores).
 * - Retry if JSON is truncated or narrative is generic.
 * - NEW: "Criteria to work on" includes PARTIAL (score=1) as well as MISSED (score=0),
 *        and we guarantee at least 2 work-on items per domain.
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
  try {
    return JSON.parse(t);
  } catch {}
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(t.slice(i, j + 1));
    } catch {}
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
    "no significant omissions",
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

export async function gradeTranscriptWithIndicators({
  openaiKey,
  model,
  transcript,
  marking,
}) {
  if (!openaiKey) throw new Error("Missing openaiKey");
  if (!model) throw new Error("Missing model");
  if (!marking) throw new Error("Missing marking");

const transcriptText = transcriptToText(transcript);
if (!transcriptText.trim()) throw new Error("Transcript text empty after formatting");

// ---- Build CLINICIAN-only text for strict quote validation ----
function buildClinicianCorpus(transcriptArr) {
  const trimmed = Array.isArray(transcriptArr) ? transcriptArr : [];
  const last = trimmed.slice(-200);
  const clinicianLines = [];
  for (const t of last) {
    const who = normalizeRole(t?.role);
    if (who !== "CLINICIAN") continue;
    const text = String(t?.text || "").trim();
    if (!text) continue;
    clinicianLines.push(text);
  }
  const clinicianText = clinicianLines.join("\n");
  return { clinicianLines, clinicianText };
}

function exactQuoteInClinician(quote, clinicianText) {
  const q = String(quote || "").trim();
  if (!q) return false;
  return clinicianText.includes(q);
}

function cleanQuotesToClinicianOnly(quotes, clinicianText, max = 4) {
  const arr = Array.isArray(quotes) ? quotes : [];
  const out = [];
  for (const q of arr) {
    const s = String(q || "").trim();
    if (!s) continue;
    if (exactQuoteInClinician(s, clinicianText)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const { clinicianText } = buildClinicianCorpus(Array.isArray(transcript) ? transcript : []);

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
  dg_pos_scores: ["0|1|2"],
  dg_pos_evidence: ["string|null"],          // NEW
  dg_neg_severity: ["0|1|2"],
  dg_neg_evidence: ["string|null"],          // NEW

  cm_pos_scores: ["0|1|2"],
  cm_pos_evidence: ["string|null"],          // NEW
  cm_neg_severity: ["0|1|2"],
  cm_neg_evidence: ["string|null"],          // NEW

  rto_pos_scores: ["0|1|2"],
  rto_pos_evidence: ["string|null"],         // NEW
  rto_neg_severity: ["0|1|2"],
  rto_neg_evidence: ["string|null"],         // NEW

  app_scores: ["0|1|2"],
  app_evidence: ["string|null"],             // NEW
  
  narrative: {
    dg: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    cm: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    rto: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    overall: { paragraph: "string", priorities_next_time: ["string"] },
  },
};


async function callOpenAI({ retryMode = false } = {}) {
  // Reasoning models don't support temperature. (e.g. o1/o3/o4/gpt-5 families)
  const isReasoningModel =
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5");

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an OSCE examiner. Use the marking criteria as a GUIDE, not a strict word-for-word checklist.\n" +
          "Be fair: give PARTIAL credit when the intent is present but incomplete.\n" +
          "Do NOT require exact wording.\n\n" +
            "GROUNDING RULES (critical):\n" +
  "- You MUST base scoring and narrative ONLY on the transcript provided.\n" +
  "- Do NOT assume anything happened unless it is explicitly in CLINICIAN lines.\n" +
  "- If something is not in the transcript, say 'not evidenced'. Do NOT invent.\n" +
  "- Do NOT mention QRisk, guidelines, complaints procedure, safety-netting, follow-up, tests, or alternative meds unless explicitly stated.\n" +
  "- Example phrases MUST be exact quotes from CLINICIAN lines.\n\n" +
          "- You MUST NOT write invented clinician statements like 'I advised...' unless those exact words appear in CLINICIAN lines.\n" +
"- If there is little/no management discussion in the transcript, you MUST say 'management not evidenced in transcript' and score accordingly.\n" +
"- Example phrases and evidence_quotes MUST come ONLY from CLINICIAN lines (candidate). Never quote PATIENT.\n" +


          
          "Return ONLY valid JSON. No markdown.\n\n" +
          "SCORING OUTPUT (critical):\n" +
          "- For each POSITIVE criteria list, return an array of scores 0..2 in the SAME ORDER and SAME LENGTH as provided:\n" +
          "  0 = not addressed, 1 = partially addressed, 2 = clearly addressed.\n" +
          "- For each NEGATIVE criteria list, return severity 0..2 in the SAME ORDER and SAME LENGTH:\n" +
          "  0 = not present, 1 = mild issue, 2 = major issue.\n" +
          "- Keep per-criterion output VERY short (numbers only). Do NOT repeat or rewrite the indicator text.\n\n" +
          "SCORING EVIDENCE (critical):\n" +
"- For EACH criteria array you score, you MUST also return a matching evidence array of the SAME LENGTH.\n" +
"- Each evidence item must be an EXACT quote from a CLINICIAN line that supports the score.\n" +
"- If no supporting quote exists, evidence must be null and the score MUST be 0.\n" +
"- You may only assign score=2 if evidence is a strong, exact supporting quote.\n\n" +
"NARRATIVE OUTPUT (critical):\n" +
          "- For EACH domain (DG/CM/RTO) write ONE substantial paragraph (about 120–200 words) that includes BOTH:\n" +
          "  (a) what was done well tied to criteria that scored 2 (clear), AND\n" +
          "  (b) what to improve tied to criteria that scored 0 or 1 (missed/partial).\n" +
          "- Include 2–4 short example phrases the candidate used (from CLINICIAN lines) per domain.\n" +
          "- Include evidence_quotes: 2–5 EXACT quotes from the transcript (CLINICIAN lines) that support your claims.\n" +
          "- If you cannot find evidence for a claim, you must NOT make the claim; say 'not evidenced'.\n" +
          "- Even if the domain is PASS, you MUST still give at least 2 concrete improvement points (growth points).\n" +
          "- Do NOT say 'no improvements needed' or 'no significant omissions'.\n" +
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
    // Only include temperature when supported
    ...(isReasoningModel ? {} : { temperature: 0.2 }),
    max_output_tokens: 6000,
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
    throw new Error(
      `OpenAI returned non-JSON. Preview: ${String(outText).slice(0, 260)}`
    );
  }

  return parsed;
}


  let parsed;
  try {
    parsed = await callOpenAI({ retryMode: false });
  } catch (e) {
    parsed = await callOpenAI({ retryMode: true });
  }

  function normalize012Array(arr, n) {
    const a = Array.isArray(arr) ? arr.map((v) => Number(v)) : [];
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = a[i];
      out.push(v === 0 || v === 1 || v === 2 ? v : 0);
    }
    return out;
  }

  function normalizeEvidenceArray(arr, n) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = a[i];
    const s = (v === null || v === undefined) ? null : String(v).trim();
    out.push(s && s.length ? s : null);
  }
  return out;
}

// HARD RULE: if evidence is missing OR not an exact quote in clinicianText, force score to 0
function enforceEvidence(scores, evidence, clinicianText) {
  const out = [];
  for (let i = 0; i < (scores || []).length; i++) {
    const s = Number(scores?.[i] ?? 0);
    const ev = evidence?.[i] ?? null;

    if (!ev) { out.push(0); continue; }
    if (!String(clinicianText || "").includes(String(ev))) { out.push(0); continue; }

    out.push(s === 0 || s === 1 || s === 2 ? s : 0);
  }
  return out;
}


// ---- Evidence arrays (must match criteria lengths) ----
const dgPosEv = normalizeEvidenceArray(parsed.dg_pos_evidence, marking.dg.positive.length);
const dgNegEv = normalizeEvidenceArray(parsed.dg_neg_evidence, marking.dg.negative.length);

const cmPosEv = normalizeEvidenceArray(parsed.cm_pos_evidence, marking.cm.positive.length);
const cmNegEv = normalizeEvidenceArray(parsed.cm_neg_evidence, marking.cm.negative.length);

const rtoPosEv = normalizeEvidenceArray(parsed.rto_pos_evidence, marking.rto.positive.length);
const rtoNegEv = normalizeEvidenceArray(parsed.rto_neg_evidence, marking.rto.negative.length);

const appEv = normalizeEvidenceArray(parsed.app_evidence, marking.application.length);

// ---- Scores with HARD enforcement: no evidence => cannot score >0 ----
const dgPosScores = enforceEvidence(
  normalize012Array(parsed.dg_pos_scores, marking.dg.positive.length),
  dgPosEv,
  clinicianText
);

const dgNegSev = enforceEvidence(
  normalize012Array(parsed.dg_neg_severity, marking.dg.negative.length),
  dgNegEv,
  clinicianText
);

const cmPosScores = enforceEvidence(
  normalize012Array(parsed.cm_pos_scores, marking.cm.positive.length),
  cmPosEv,
  clinicianText
);

const cmNegSev = enforceEvidence(
  normalize012Array(parsed.cm_neg_severity, marking.cm.negative.length),
  cmNegEv,
  clinicianText
);

const rtoPosScores = enforceEvidence(
  normalize012Array(parsed.rto_pos_scores, marking.rto.positive.length),
  rtoPosEv,
  clinicianText
);

const rtoNegSev = enforceEvidence(
  normalize012Array(parsed.rto_neg_severity, marking.rto.negative.length),
  rtoNegEv,
  clinicianText
);

const appScores = enforceEvidence(
  normalize012Array(parsed.app_scores, marking.application.length),
  appEv,
  clinicianText
);


  const dgBand = computeDomainBandFromScores(dgPosScores, dgNegSev);
  const cmBand = computeDomainBandFromScores(cmPosScores, cmNegSev);
  const rtoBand = computeDomainBandFromScores(rtoPosScores, rtoNegSev);
  const appBand = bandFromRatio(
    appScores.reduce((a, v) => a + v, 0) / ((appScores.length * 2) || 1)
  );

  const overallIdx = Math.round(
    (BANDS.indexOf(dgBand) +
      BANDS.indexOf(cmBand) +
      BANDS.indexOf(rtoBand) +
      BANDS.indexOf(appBand)) /
      4
  );
  const overall = BANDS[clampBandIndex(overallIdx)];

  // NEW: "work on" includes partial (1) + missed (0) and guarantee >=2 items
  function hitWorkOnFromScores(indicators, scores) {
    const hits = []; // score=2
    const workOn = []; // score=0 or 1

    for (let i = 0; i < (indicators || []).length; i++) {
      const s = Number(scores?.[i] ?? 0);
      if (s === 2) hits.push({ text: indicators[i], score: 2 });
      else workOn.push({ text: indicators[i], score: s === 1 ? 1 : 0 });
    }

    // Guarantee at least 2 "work on" items if there are any indicators
    if (workOn.length === 0 && (indicators || []).length > 0) {
      const pick = indicators.slice(-Math.min(2, indicators.length));
      for (const t of pick) workOn.push({ text: t, score: 1 });
    } else if (workOn.length === 1 && (indicators || []).length > 1) {
      // add another weak area: pick the last hit as a stretch area
      const used = new Set(workOn.map((x) => x.text));
      for (let i = indicators.length - 1; i >= 0; i--) {
        const t = indicators[i];
        if (!used.has(t)) {
          workOn.push({ text: t, score: 1 });
          break;
        }
      }
    }

    return {
      hits: hits.map((x) => x.text),
      workOn: workOn.map((x) => x.text),
    };
  }

  const dgHM = hitWorkOnFromScores(marking.dg.positive, dgPosScores);
  const cmHM = hitWorkOnFromScores(marking.cm.positive, cmPosScores);
  const rtoHM = hitWorkOnFromScores(marking.rto.positive, rtoPosScores);

  // Narrative
  let n = parsed.narrative || {};

  // ---- Enforce clinician-only quotes; if model invents, force retry ----
function enforceNarrativeQuotes(narr) {
  const nn = narr || {};
  for (const key of ["dg", "cm", "rto"]) {
    if (!nn[key]) nn[key] = {};
    nn[key].example_phrases = cleanQuotesToClinicianOnly(nn[key].example_phrases, clinicianText, 4);
    nn[key].evidence_quotes = cleanQuotesToClinicianOnly(nn[key].evidence_quotes, clinicianText, 5);
  }
  return nn;
}

n = enforceNarrativeQuotes(n);

// If the model couldn't provide any valid clinician quotes in any domain, retry once.
const bad =
  (Array.isArray(n.dg?.example_phrases) && n.dg.example_phrases.length === 0) ||
  (Array.isArray(n.cm?.example_phrases) && n.cm.example_phrases.length === 0) ||
  (Array.isArray(n.rto?.example_phrases) && n.rto.example_phrases.length === 0);

if (bad) {
  parsed = await callOpenAI({ retryMode: true });
  n = enforceNarrativeQuotes(parsed.narrative || {});
}
  
  const dgPara = String((n.dg || {}).paragraph || "").trim();
  const cmPara = String((n.cm || {}).paragraph || "").trim();
  const rtoPara = String((n.rto || {}).paragraph || "").trim();

  if (
    wordCount(dgPara) < 80 ||
    wordCount(cmPara) < 80 ||
    wordCount(rtoPara) < 80 ||
    looksTooGeneric(dgPara) ||
    looksTooGeneric(cmPara) ||
    looksTooGeneric(rtoPara)
  ) {
    parsed = await callOpenAI({ retryMode: true });
    n = parsed.narrative || {};
  }

  const dgP = String((n.dg || {}).paragraph || "").trim();
  const cmP = String((n.cm || {}).paragraph || "").trim();
  const rtoP = String((n.rto || {}).paragraph || "").trim();
  const ovP = String((n.overall || {}).paragraph || "").trim();

  function top(arr, n = 6) {
    return (Array.isArray(arr) ? arr : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, n);
  }

  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    "",
    dgP,
    top((n.dg || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((n.dg || {}).example_phrases, 4)
          .map((p) => `"${p}"`)
          .join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...dgHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...dgHM.workOn.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Clinical Management: **${cmBand}**`,
    "",
    cmP,
    top((n.cm || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((n.cm || {}).example_phrases, 4)
          .map((p) => `"${p}"`)
          .join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...cmHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...cmHM.workOn.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Relating to Others: **${rtoBand}**`,
    "",
    rtoP,
    top((n.rto || {}).example_phrases, 4).length
      ? `\n**Example phrases:** ${top((n.rto || {}).example_phrases, 4)
          .map((p) => `"${p}"`)
          .join(" • ")}`
      : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...rtoHM.hits.slice(0, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...rtoHM.workOn.slice(0, 6).map((x) => `- ${x}`),
    "",
    `## Overall: **${overall}**`,
    "",
    ovP,
    "",
    `**Next priorities:**`,
    ...top((n.overall || {}).priorities_next_time, 5).map((x) => `- ${x}`),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand, overall },
  };
}
