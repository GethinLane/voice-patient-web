// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/**
 * - OpenAI returns compact arrays of numbers (0/1/2) aligned to criteria order.
 * - Narrative is still rich and tied to criteria (we derive hit/work-on lists from scores).
 * - Retry if JSON is truncated or narrative is generic.
 * - NEW: "Criteria to work on" includes PARTIAL (score=1) as well as MISSED (score=0),
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
  if (!respJson) return "";

  // 1. Direct output_text shortcut
  if (typeof respJson.output_text === "string") {
    return respJson.output_text;
  }

  // 2. Standard output array
  if (Array.isArray(respJson.output)) {
    let last = "";


    for (const item of respJson.output) {
      if (!item) continue;

      // Some models nest content differently
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (!c) continue;

if (typeof c.text === "string") {
  last = c.text;
}

if (c.type === "output_text" && typeof c.text === "string") {
  last = c.text;
}

        }
      }
    }

    return last;

  }

  return "";
}


function safeJsonParseAny(text) {
  if (!text) return null;
  const t = String(text).trim();

  // 1) Try direct parse first
  try {
    return JSON.parse(t);
  } catch {}

  // 2) Extract the first complete JSON object by brace-matching
  const start = t.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < t.length; i++) {
    const ch = t[i];

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    } else {
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // if candidate failed, keep searching (rare) — maybe junk inside strings etc.
        }
      }
    }
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
  mode = "standard",
}) {
  if (!openaiKey) throw new Error("Missing openaiKey");
  if (!model) throw new Error("Missing model");
  if (!marking) throw new Error("Missing marking");
  const isPremium = String(mode || "").toLowerCase() === "premium";

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

// ---- Build PATIENT-only text for cue/impact/empathy validation ----
function buildPatientCorpus(transcriptArr) {
  const trimmed = Array.isArray(transcriptArr) ? transcriptArr : [];
  const last = trimmed.slice(-200);
  const patientLines = [];
  for (const t of last) {
    const who = normalizeRole(t?.role);
    if (who !== "PATIENT") continue;
    const text = String(t?.text || "").trim();
    if (!text) continue;
    patientLines.push(text);
  }
  const patientText = patientLines.join("\n");
  return { patientLines, patientText };
}

function exactQuoteInPatient(quote, patientText) {
  const q = String(quote || "").trim();
  if (!q) return false;
  return patientText.includes(q);
}

function cleanQuotesToPatientOnly(quotes, patientText, max = 6) {
  const arr = Array.isArray(quotes) ? quotes : [];
  const out = [];
  for (const q of arr) {
    const s = String(q || "").trim();
    if (!s) continue;
    if (exactQuoteInPatient(s, patientText)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const { clinicianText } = buildClinicianCorpus(Array.isArray(transcript) ? transcript : []);
const { patientText } = buildPatientCorpus(Array.isArray(transcript) ? transcript : []);
  
  const criteria = {
    dg_positive: marking.dg.positive,
    dg_negative: marking.dg.negative,
    cm_positive: marking.cm.positive,
    cm_negative: marking.cm.negative,
    rto_positive: marking.rto.positive,
    rto_negative: marking.rto.negative,
    application: marking.application,
  };

const premiumOutputSchemaHint = {
  consultation_skills: {
    cue_handling: {
      paragraph: "string",
      cues: [
        {
          patient_cue_quote: "string",
          clinician_response_quote: "string",
          assessment: "string",
          what_to_do_next_time: "string",
        },
      ],
    },
    explanation_of_condition: {
      paragraph: "string",
      clinician_quotes: ["string"],
      what_was_good: ["string"],
      what_to_improve: ["string"],
    },
    ice_management: {
      paragraph: "string",
      what_was_explored: ["string"],
      what_was_missed: ["string"],
      patient_quotes: ["string"],
      clinician_quotes: ["string"],
    },
    psychosocial_impact: {
      paragraph: "string",
      what_was_elicited: ["string"],
      what_was_missed: ["string"],
      patient_quotes: ["string"],
      clinician_quotes: ["string"],
    },
    empathy: {
      paragraph: "string",
      good_empathy_quotes: ["string"],
      missed_opportunities: [
        {
          patient_quote: "string",
          clinician_quote: "string",
          better_response: "string",
        },
      ],
    },
  },
};
  
const outputSchemaHint = {
  dg_pos_scores: ["0|1|2"],
  dg_neg_severity: ["0|1|2"],

  cm_pos_scores: ["0|1|2"],
  cm_neg_severity: ["0|1|2"],

  rto_pos_scores: ["0|1|2"],
  rto_neg_severity: ["0|1|2"],

  app_scores: ["0|1|2"],
  
  narrative: {
    dg: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    cm: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    rto: { paragraph: "string", example_phrases: ["string"], evidence_quotes: ["string"] },
    overall: { paragraph: "string", priorities_next_time: ["string"] },
  },

  ...(isPremium ? premiumOutputSchemaHint : {}),
};


async function callOpenAI({ retryMode = false } = {}) {
  // Reasoning models don't support temperature. (e.g. o1/o3/o4/gpt-5 families)
  const isReasoningModel =
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5");

  const premiumAddon =
    "\n\nPREMIUM CONSULTATION SKILLS FEEDBACK (no scoring):\n" +
    "- Add a consultation_skills object with: cue_handling, explanation_of_condition, ice_management, psychosocial_impact, empathy.\n" +
    "- This premium section is NOT scored. Provide feedback only.\n" +
    "- Cue handling: identify subtle cues in PATIENT lines (quote them exactly) and assess whether/how the CLINICIAN responded, and what to do next time.\n" +
    "- Explanation: assess clarity and jargon-free explanation of the condition/diagnosis, including what the doctor thinks is going on and why (ONLY if evidenced), plus management and prognosis ONLY if evidenced.\n" +
    "- ICE: comment on whether Ideas, Concerns, Expectations were explored and addressed; if not, what was missed.\n" +
    "- Psychosocial impact: comment on whether psychosocial/functional impact was elicited; if not, what was missed.\n" +
    "- Empathy: provide examples of good empathy (CLINICIAN quotes) and missed opportunities (PATIENT quote + better response).\n" +
    "- If not evidenced, say 'not evidenced'. Do NOT invent.\n";

    const maxOutStandard = Number(process.env.GRADING_MAX_OUTPUT_TOKENS_STANDARD || 5000);
  const maxOutPremium  = Number(process.env.GRADING_MAX_OUTPUT_TOKENS_PREMIUM  || 8000);

  const effortStandard = String(process.env.GRADING_REASONING_EFFORT_STANDARD || "low");
  const effortPremium  = String(process.env.GRADING_REASONING_EFFORT_PREMIUM  || "medium");

  const payload = {
    model,
        reasoning: { effort: isPremium ? effortPremium : effortStandard },
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
  "- If there is little/no management discussion in the transcript, you MUST say 'management not evidenced in transcript' and score accordingly.\n" +
  "QUOTE RULES (critical):\n" +
"- For DG/CM/RTO narrative: example_phrases and evidence_quotes MUST be exact quotes from CLINICIAN lines.\n" +
"- For PREMIUM consultation_skills ONLY:\n" +
"  - patient_cue_quote, patient_quotes, patient_quote MUST be exact quotes from PATIENT lines.\n" +
"  - clinician_response_quote, clinician_quotes, clinician_quote, good_empathy_quotes MUST be exact quotes from CLINICIAN lines.\n" +
"- Never fabricate quotes. If you cannot find a quote, leave it empty and say 'not evidenced' in the paragraph.\n\n" +
  


          
          "Return ONLY valid JSON. No markdown.\n\n" +
          "SCORING OUTPUT (critical):\n" +
"- For each POSITIVE criteria list, return an array of scores 0..2 in the SAME ORDER and SAME LENGTH as provided:\n" +
"  0 = not demonstrated or absent, 1 = partially demonstrated or incomplete, 2 = fully demonstrated as described with clear and specific behaviour.\n" +
"- For each NEGATIVE criteria list, return severity 0..2 in the SAME ORDER and SAME LENGTH:\n" +
"  0 = not present, 1 = mild issue, 2 = major issue.\n" +
"- Keep per-criterion output VERY short (numbers only). Do NOT repeat or rewrite the indicator text.\n\n" +
"IMPORTANT SCORING RULE:\n" +
"- Score 2 only if the criterion is clearly and substantially demonstrated in the transcript.\n" +
"- If only part of the behaviour is present, score 1.\n" +
"- Do not infer missing components.\n\n" +

          

          "SCORING GUIDANCE (important):\n" +
"- Score based on what is clearly demonstrated in the transcript.\n" +
"- Exact wording is NOT required for score=2; strong implication or clear behaviour is sufficient.\n" +
"- Do NOT invent actions that are not reasonably supported by the transcript.\n\n" +

"NARRATIVE OUTPUT (critical):\n" +
          "- For EACH domain (DG/CM/RTO) write ONE substantial paragraph (about 100–150 words) that includes BOTH:\n" +
          "  (a) what was done well tied to criteria that scored 2 (clear), AND\n" +
          "  (b) what to improve tied to criteria that scored 0 or 1 (missed/partial).\n" +
          "- Include 2–4 short example phrases the candidate used (from CLINICIAN lines) per domain.\n" +
          "- Include evidence_quotes: 2–5 EXACT quotes from the transcript (CLINICIAN lines) that support your claims.\n" +
          "- If you cannot find evidence for a claim, you must NOT make the claim; say 'not evidenced'.\n" +
          "- Even if the domain is PASS, you MUST still give at least 2 concrete improvement points (growth points).\n" +
          "- Do NOT say 'no improvements needed' or 'no significant omissions'.\n" +
(retryMode
            ? "\nRETRY MODE: Your last output was too generic or invalid JSON. Be more specific, and keep JSON compact."
            : "") +
          (isPremium ? premiumAddon : ""),
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
        max_output_tokens: isPremium ? maxOutPremium : maxOutStandard,
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

  console.error("RAW OPENAI RESPONSE:", raw);


  const data = raw ? JSON.parse(raw) : null;
  const outText = collectAllAssistantText(data);
  let parsed = safeJsonParseAny(outText);

if (!parsed) {
  console.error("Failed JSON parse. Raw output:", outText);

  // Retry once automatically
  if (!retryMode) {
    return await callOpenAI({ retryMode: true });
  }

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
// ---- Scores (no hard literal enforcement) ----
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

function enforceConsultationSkillsQuotes(cs) {
  const out = cs || {};

  const cleanClin = (arr, max) => cleanQuotesToClinicianOnly(arr, clinicianText, max);
  const cleanPat  = (arr, max) => cleanQuotesToPatientOnly(arr, patientText, max);

  // cue handling: validate patient cue quotes and clinician response quotes
  if (out.cue_handling) {
    const cues = Array.isArray(out.cue_handling.cues) ? out.cue_handling.cues : [];
    out.cue_handling.cues = cues
      .slice(0, 8)
      .map((c) => {
        const pq = String(c?.patient_cue_quote || "").trim();
        const cq = String(c?.clinician_response_quote || "").trim();
        return {
          patient_cue_quote: exactQuoteInPatient(pq, patientText) ? pq : "",
          clinician_response_quote: exactQuoteInClinician(cq, clinicianText) ? cq : "",
          assessment: String(c?.assessment || "").trim(),
          what_to_do_next_time: String(c?.what_to_do_next_time || "").trim(),
        };
      })
      .filter((x) => x.patient_cue_quote);
  }

  if (out.explanation_of_condition) {
    out.explanation_of_condition.clinician_quotes = cleanClin(
      out.explanation_of_condition.clinician_quotes,
      8
    );
  }

  if (out.ice_management) {
    out.ice_management.patient_quotes = cleanPat(out.ice_management.patient_quotes, 8);
    out.ice_management.clinician_quotes = cleanClin(out.ice_management.clinician_quotes, 8);
  }

  if (out.psychosocial_impact) {
    out.psychosocial_impact.patient_quotes = cleanPat(out.psychosocial_impact.patient_quotes, 8);
    out.psychosocial_impact.clinician_quotes = cleanClin(out.psychosocial_impact.clinician_quotes, 8);
  }

  if (out.empathy) {
    out.empathy.good_empathy_quotes = cleanClin(out.empathy.good_empathy_quotes, 10);
    const mm = Array.isArray(out.empathy.missed_opportunities) ? out.empathy.missed_opportunities : [];
    out.empathy.missed_opportunities = mm
      .slice(0, 8)
      .map((m) => {
        const pq = String(m?.patient_quote || "").trim();
        const cq = String(m?.clinician_quote || "").trim();
        return {
          patient_quote: exactQuoteInPatient(pq, patientText) ? pq : "",
          clinician_quote: exactQuoteInClinician(cq, clinicianText) ? cq : "",
          better_response: String(m?.better_response || "").trim(),
        };
      })
      .filter((x) => x.patient_quote);
  }

  return out;
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

function renderConsultationSkills(cs) {
  if (!cs) return "";

  const lines = [];
  lines.push("## Premium consultation skills add-on");
  lines.push("");

  if (cs.cue_handling) {
    lines.push("### 1) Cue handling");
    if (cs.cue_handling.paragraph) lines.push(cs.cue_handling.paragraph, "");
    const cues = Array.isArray(cs.cue_handling.cues) ? cs.cue_handling.cues : [];
    if (cues.length) {
      lines.push("**Subtle cues (patient) and how they were handled:**");
      for (const c of cues.slice(0, 6)) {
        lines.push(`- Patient cue: "${c.patient_cue_quote}"`);
        if (c.clinician_response_quote) lines.push(`  - Clinician response: "${c.clinician_response_quote}"`);
        if (c.assessment) lines.push(`  - Feedback: ${c.assessment}`);
        if (c.what_to_do_next_time) lines.push(`  - Next time: ${c.what_to_do_next_time}`);
      }
      lines.push("");
    }
  }

  if (cs.explanation_of_condition) {
    lines.push("### 2) Explanation of the condition / diagnosis");
    if (cs.explanation_of_condition.paragraph) lines.push(cs.explanation_of_condition.paragraph, "");
    const q = Array.isArray(cs.explanation_of_condition.clinician_quotes)
      ? cs.explanation_of_condition.clinician_quotes
      : [];
    if (q.length) lines.push(`**Clinician quotes:** ${q.map((x) => `"${x}"`).join(" • ")}`, "");
  }

  if (cs.ice_management) {
    lines.push("### 3) Ideas, Concerns and Expectations (ICE)");
    if (cs.ice_management.paragraph) lines.push(cs.ice_management.paragraph, "");
    const missed = Array.isArray(cs.ice_management.what_was_missed) ? cs.ice_management.what_was_missed : [];
    if (missed.length) {
      lines.push("**What was missed / could be improved:**");
      for (const m of missed.slice(0, 8)) lines.push(`- ${m}`);
      lines.push("");
    }
  }

  if (cs.psychosocial_impact) {
    lines.push("### 4) Psychosocial impact");
    if (cs.psychosocial_impact.paragraph) lines.push(cs.psychosocial_impact.paragraph, "");
    const missed = Array.isArray(cs.psychosocial_impact.what_was_missed)
      ? cs.psychosocial_impact.what_was_missed
      : [];
    if (missed.length) {
      lines.push("**What was missed / could be explored:**");
      for (const m of missed.slice(0, 8)) lines.push(`- ${m}`);
      lines.push("");
    }
  }

  if (cs.empathy) {
    lines.push("### 5) Empathy");
    if (cs.empathy.paragraph) lines.push(cs.empathy.paragraph, "");
    const good = Array.isArray(cs.empathy.good_empathy_quotes) ? cs.empathy.good_empathy_quotes : [];
    if (good.length) lines.push(`**Good empathy examples:** ${good.map((x) => `"${x}"`).join(" • ")}`, "");

    const mm = Array.isArray(cs.empathy.missed_opportunities) ? cs.empathy.missed_opportunities : [];
    if (mm.length) {
      lines.push("**Missed empathy opportunities (with better responses):**");
      for (const m of mm.slice(0, 6)) {
        lines.push(`- Patient: "${m.patient_quote}"`);
        if (m.clinician_quote) lines.push(`  - What you said: "${m.clinician_quote}"`);
        if (m.better_response) lines.push(`  - Better response: ${m.better_response}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

  let cs = null;
if (isPremium) {
  cs = enforceConsultationSkillsQuotes(parsed.consultation_skills || {});
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
        ...(isPremium ? ["", renderConsultationSkills(cs)] : []),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand, overall },
  };
}
