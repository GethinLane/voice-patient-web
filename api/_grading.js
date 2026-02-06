// api/_grading.js
import { airtableListAll } from "./_airtable.js";

/**
 * Goal:
 * - OpenAI writes the full narrative feedback.
 * - It MUST reference Airtable criteria (hit + missed) as a guide, not strict wording.
 * - It MUST include concrete examples and candidate phrases.
 * - Avoid generic "no improvements needed" when bands aren't strong.
 *
 * Exports:
 * - loadCaseMarking(...)
 * - gradeTranscriptWithIndicators(...)
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
  const last = trimmed.slice(-200);
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

// -------------------- Bands (not strict) --------------------

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
  return i < 3 ? 2 : 1; // keep your original “first 3 heavier” feel
}

function scoreToPoints(rating) {
  if (rating === "met") return 2;
  if (rating === "partial") return 1;
  return 0; // missed/unknown
}

function computeDomainBand(posResults, negResults) {
  // positives: met/partial/missed
  const posMax = posResults.reduce((acc, _it, i) => acc + weightForIndex(i) * 2, 0) || 1;
  const posGot = posResults.reduce((acc, it, i) => acc + weightForIndex(i) * scoreToPoints(it.rating), 0);
  let ratio = posGot / posMax;

  // negatives: severity 0..2, mild penalty
  const negMax = (negResults?.reduce((acc, _it, i) => acc + weightForIndex(i) * 2, 0)) || 1;
  const negGot = (negResults?.reduce((acc, it, i) => acc + weightForIndex(i) * (Number(it.severity) || 0), 0)) || 0;
  const negPenalty = negGot / negMax;

  // penalty is gentle: don’t nuke borderline performances
  ratio = Math.max(0, Math.min(1, ratio - 0.18 * negPenalty));

  return bandFromRatio(ratio);
}

// -------------------- Narrative quality checks + retry --------------------

const BANNED_PHRASES = [
  "no significant improvements",
  "no improvements needed",
  "performed well",
  "excellent communication", // too generic unless backed by examples
];

function looksTooGeneric(text) {
  const t = String(text || "").toLowerCase();
  return BANNED_PHRASES.some((p) => t.includes(p));
}

function wordCount(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForContains(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteSeemsFromTranscript(quote, transcriptText) {
  const q = normalizeForContains(quote);
  const tx = normalizeForContains(transcriptText);
  if (!q || q.length < 8) return false;
  return tx.includes(q);
}

// -------------------- Main grading --------------------

export async function gradeTranscriptWithIndicators({ openaiKey, model, transcript, marking }) {
  const transcriptText = transcriptToText(transcript);

  const mk = {
    dg_positive: marking.dg.positive,
    dg_negative: marking.dg.negative,
    cm_positive: marking.cm.positive,
    cm_negative: marking.cm.negative,
    rto_positive: marking.rto.positive,
    rto_negative: marking.rto.negative,
    application: marking.application,
  };

  const schemaHint = {
    dg_positive: [{ indicator: "string", rating: "met|partial|missed", note: "string", phrases: ["string"] }],
    dg_negative: [{ indicator: "string", severity: "0|1|2", note: "string", phrases: ["string"] }],
    cm_positive: [{ indicator: "string", rating: "met|partial|missed", note: "string", phrases: ["string"] }],
    cm_negative: [{ indicator: "string", severity: "0|1|2", note: "string", phrases: ["string"] }],
    rto_positive: [{ indicator: "string", rating: "met|partial|missed", note: "string", phrases: ["string"] }],
    rto_negative: [{ indicator: "string", severity: "0|1|2", note: "string", phrases: ["string"] }],
    application: [{ indicator: "string", rating: "met|partial|missed", note: "string", phrases: ["string"] }],
    narrative: {
      dg: {
        paragraph: "string",                 // ONE substantial paragraph: positives + improvements
        hits: ["string"],                    // indicators mostly achieved (copy indicator text)
        misses: ["string"],                  // indicators to work on (copy indicator text)
        example_phrases: ["string"],         // exact/near-exact candidate phrases (prefer exact)
      },
      cm: { paragraph: "string", hits: ["string"], misses: ["string"], example_phrases: ["string"] },
      rto: {
        paragraph: "string",
        hits: ["string"],
        misses: ["string"],
        example_phrases: ["string"],         // MUST include at least 2 phrases about empathy/structure/checking understanding
      },
      overall: {
        paragraph: "string",                 // overall summary + next focus points
        priorities_next_time: ["string"],    // 3-5 concrete things to practice
      },
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
            "Your job is to compare the transcript to the criteria and judge whether each criterion is MET, PARTIAL, or MISSED.\n" +
            "Be fair: give PARTIAL credit when the intent is present but incomplete.\n\n" +
            "Output MUST be valid JSON only (no markdown).\n\n" +
            "CRITICAL OUTPUT QUALITY RULES:\n" +
            "- For EACH domain (DG/CM/RTO), write ONE substantial paragraph (roughly 120–200 words) that includes BOTH:\n" +
            "  (a) what they did well, explicitly tied to criteria they hit, AND\n" +
            "  (b) what they should improve, explicitly tied to criteria they partially missed.\n" +
            "- Do NOT say 'no improvements needed' unless the domain is a clear PASS and there are no meaningful misses.\n" +
            "- In Relating to Others, you MUST give specific examples of consultation/communication behaviours (empathy, ICE, structure, safety-netting, checking understanding) and cite at least 2 candidate phrases.\n" +
            "- Provide 'hits' and 'misses' arrays per domain containing the indicator text (not IDs).\n" +
            "- Provide 'example_phrases' per domain: short phrases the candidate said (prefer exact words from transcript; if not exact, keep very close).\n\n" +
            (retryMode
              ? "RETRY MODE: Your previous output was too generic. Remove vague praise. Add specific criteria hit/missed and concrete examples/phrases.\n"
              : ""),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              transcript: transcriptText,
              note: "CLINICIAN lines are the candidate; PATIENT lines are the simulator.",
              criteria: mk,
              output_schema_hint: schemaHint,
            },
            null,
            2
          ),
        },
      ],
      text: { format: { type: "json_object" } },
      temperature: 0.2,            // allow better wording while staying grounded
      max_output_tokens: 2600,
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
    if (!parsed) throw new Error(`OpenAI returned non-JSON. Preview: ${String(outText).slice(0, 260)}`);
    return parsed;
  }

  let parsed = await callOpenAI({ retryMode: false });

  // If narrative is too generic/short, retry once.
  const dgP = parsed?.narrative?.dg?.paragraph || "";
  const cmP = parsed?.narrative?.cm?.paragraph || "";
  const rtoP = parsed?.narrative?.rto?.paragraph || "";
  const anyGeneric =
    looksTooGeneric(dgP) || looksTooGeneric(cmP) || looksTooGeneric(rtoP) ||
    wordCount(dgP) < 80 || wordCount(cmP) < 80 || wordCount(rtoP) < 80;

  if (anyGeneric) {
    parsed = await callOpenAI({ retryMode: true });
  }

  // Normalize per-indicator arrays back to Airtable order (matching by indicator text)
  function zipPos(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return (indicators || []).map((indicator) => {
      const x = map.get(indicator) || {};
      const rating = (String(x.rating || "").toLowerCase().trim());
      return {
        indicator,
        rating: (rating === "met" || rating === "partial" || rating === "missed") ? rating : "missed",
        note: String(x.note || "").trim(),
        phrases: Array.isArray(x.phrases) ? x.phrases.map((p) => String(p || "").trim()).filter(Boolean) : [],
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
        severity: (sev === 0 || sev === 1 || sev === 2) ? sev : 0,
        note: String(x.note || "").trim(),
        phrases: Array.isArray(x.phrases) ? x.phrases.map((p) => String(p || "").trim()).filter(Boolean) : [],
      };
    });
  }

  const dgPos = zipPos(marking.dg.positive, parsed.dg_positive);
  const dgNeg = zipNeg(marking.dg.negative, parsed.dg_negative);
  const cmPos = zipPos(marking.cm.positive, parsed.cm_positive);
  const cmNeg = zipNeg(marking.cm.negative, parsed.cm_negative);
  const rtoPos = zipPos(marking.rto.positive, parsed.rto_positive);
  const rtoNeg = zipNeg(marking.rto.negative, parsed.rto_negative);
  const appPos = zipPos(marking.application, parsed.application);

  const dgBand = computeDomainBand(dgPos, dgNeg);
  const cmBand = computeDomainBand(cmPos, cmNeg);
  const rtoBand = computeDomainBand(rtoPos, rtoNeg);

  // Application band (positive-only)
  const appMax = appPos.reduce((acc, _it, i) => acc + weightForIndex(i) * 2, 0) || 1;
  const appGot = appPos.reduce((acc, it, i) => acc + weightForIndex(i) * scoreToPoints(it.rating), 0);
  const appBand = bandFromRatio(appGot / appMax);

  // Overall = average of indices
  const overallIdx =
    Math.round(
      (BANDS.indexOf(dgBand) + BANDS.indexOf(cmBand) + BANDS.indexOf(rtoBand) + BANDS.indexOf(appBand)) / 4
    );
  const overall = BANDS[clampBandIndex(overallIdx)];

  // Pull narrative
  const n = parsed?.narrative || {};
  const ndg = n.dg || {};
  const ncm = n.cm || {};
  const nrto = n.rto || {};
  const nov = n.overall || {};

  function listTop(arr, max = 6) {
    return (Array.isArray(arr) ? arr : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, max);
  }

  function listPhrases(ph, transcriptText, max = 3) {
    const raw = listTop(ph, 8);
    // Prefer phrases that actually appear (soft check; do not fail)
    const good = [];
    for (const q of raw) {
      if (quoteSeemsFromTranscript(q, transcriptText)) good.push(q);
      if (good.length >= max) break;
    }
    // If none found, just return first few (still useful, but may be near-exact)
    return good.length ? good : raw.slice(0, max);
  }

  const dgPhrases = listPhrases(ndg.example_phrases, transcriptText, 2);
  const cmPhrases = listPhrases(ncm.example_phrases, transcriptText, 2);
  const rtoPhrases = listPhrases(nrto.example_phrases, transcriptText, 3);

  const gradingText = [
    `## Data Gathering & Diagnosis: **${dgBand}**`,
    "",
    String(ndg.paragraph || "").trim(),
    dgPhrases.length ? `\n**Example phrases:** ${dgPhrases.map((p) => `"${p}"`).join(" • ")}` : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...listTop(ndg.hits, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...listTop(ndg.misses, 6).map((x) => `- ${x}`),
    "",
    `## Clinical Management: **${cmBand}**`,
    "",
    String(ncm.paragraph || "").trim(),
    cmPhrases.length ? `\n**Example phrases:** ${cmPhrases.map((p) => `"${p}"`).join(" • ")}` : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...listTop(ncm.hits, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...listTop(ncm.misses, 6).map((x) => `- ${x}`),
    "",
    `## Relating to Others: **${rtoBand}**`,
    "",
    String(nrto.paragraph || "").trim(),
    rtoPhrases.length ? `\n**Example phrases:** ${rtoPhrases.map((p) => `"${p}"`).join(" • ")}` : "",
    "",
    `**Criteria mostly achieved (guide):**`,
    ...listTop(nrto.hits, 6).map((x) => `- ${x}`),
    "",
    `**Criteria to work on (guide):**`,
    ...listTop(nrto.misses, 6).map((x) => `- ${x}`),
    "",
    `## Overall: **${overall}**`,
    "",
    String(nov.paragraph || "").trim(),
    "",
    `**Next priorities:**`,
    ...listTop(nov.priorities_next_time, 5).map((x) => `- ${x}`),
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand, overall },
  };
}
