// api/_grading.js
import { airtableListAll } from "./_airtable.js";

// -------- Helpers to read indicators from Case {N} table --------

function combineFieldAcrossRows(records, fieldName) {
  const parts = [];
  for (const r of records) {
    const v = r?.fields?.[fieldName];
    if (v == null) continue;
    const t = (typeof v === "string" ? v : String(v)).trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

function parseIndicators(text) {
  if (!text) return [];
  return text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .map((l) => l.replace(/^[\-\*\u2022]+\s*/, ""))        // bullets
    .map((l) => l.replace(/^\(?\d+[\).\]]\s*/, ""))        // "1." "2)" etc
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

  // Field names exactly as you described:
  const dgPos = parseIndicators(combineFieldAcrossRows(records, "DG positive"));
  const dgNeg = parseIndicators(combineFieldAcrossRows(records, "DG negative"));
  const cmPos = parseIndicators(combineFieldAcrossRows(records, "CM positive"));
  const cmNeg = parseIndicators(combineFieldAcrossRows(records, "CM negative"));
  const rtoPos = parseIndicators(combineFieldAcrossRows(records, "RTO positive"));
  const rtoNeg = parseIndicators(combineFieldAcrossRows(records, "RTO negative"));

  // Application: treat as indicator list too (works whether it's bullets or paragraphs)
  const app = parseIndicators(combineFieldAcrossRows(records, "Application"));

  return {
    table,
    dg: { positive: dgPos, negative: dgNeg },
    cm: { positive: cmPos, negative: cmNeg },
    rto: { positive: rtoPos, negative: rtoNeg },
    application: app,
  };
}

// -------- Scoring (first 3 indicators heavier) --------

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
  return i < 3 ? 2 : 1; // your “first three heavier” rule
}

function computeDomainBand(posResults, negResults) {
  const posMax = posResults.reduce((acc, it, i) => acc + weightForIndex(i), 0) || 1;
  const posGot = posResults.reduce((acc, it, i) => acc + (it.met ? weightForIndex(i) : 0), 0);

  let band = bandFromRatio(posGot / posMax);

  // penalties for negatives
  let downgrade = 0;
  for (let i = 0; i < negResults.length; i++) {
    if (!negResults[i].occurred) continue;
    downgrade += (i < 3 ? 2 : 1);
  }

  const baseIdx = BANDS.indexOf(band);
  const finalIdx = clampBandIndex(baseIdx - downgrade);
  return BANDS[finalIdx];
}

function formatDomainText(title, band, posResults, negResults) {
  const met = posResults.filter((x) => x.met).map((x) => `✅ ${x.indicator}${x.evidence ? ` — ${x.evidence}` : ""}`);
  const miss = posResults.filter((x) => !x.met).map((x) => `❌ ${x.indicator}`);
  const neg = negResults.filter((x) => x.occurred).map((x) => `⚠️ ${x.indicator}${x.evidence ? ` — ${x.evidence}` : ""}`);

  const lines = [];
  lines.push(`### ${title}: **${band}**`);
  if (met.length) lines.push(met.slice(0, 8).join("\n"));
  if (miss.length) lines.push("\nMissing:\n" + miss.slice(0, 8).join("\n"));
  if (neg.length) lines.push("\nNegatives triggered:\n" + neg.slice(0, 8).join("\n"));
  return lines.join("\n");
}

function transcriptToText(transcript) {
  // transcript entries: {role:"user"|"assistant", text:"..."}
  const lines = [];
  const trimmed = Array.isArray(transcript) ? transcript : [];
  const last = trimmed.slice(-120); // cap for token cost
  for (const t of last) {
    const who = t.role === "user" ? "CLINICIAN" : "PATIENT";
    lines.push(`${who}: ${String(t.text || "").trim()}`);
  }
  return lines.join("\n");
}

// -------- OpenAI evaluation (returns booleans + evidence) --------

function collectAllAssistantText(respJson) {
  // Prefer structured output content segments from Responses API
  const out = respJson?.output;
  if (!Array.isArray(out)) return respJson?.output_text || "";

  let s = "";
  for (const item of out) {
    if (item?.type !== "message") continue;
    if (item?.role !== "assistant") continue;

    const content = item?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      // Most common: { type:"output_text", text:"..." }
      if (typeof c?.text === "string") s += c.text;
      // Some variants: { type:"text", text:"..." }
      else if (c?.type === "text" && typeof c?.text === "string") s += c.text;
    }
  }

  // Fallback
  return s || respJson?.output_text || "";
}

function safeJsonParseAny(text) {
  if (!text) return null;

  // Trim whitespace
  const t = String(text).trim();

  // If it's already valid JSON, great
  try { return JSON.parse(t); } catch {}

  // Try to salvage the largest {...} block
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    const slice = t.slice(i, j + 1);
    try { return JSON.parse(slice); } catch {}
  }

  return null;
}


export async function gradeTranscriptWithIndicators({ openaiKey, model, transcript, marking }) {
  const transcriptText = transcriptToText(transcript);

  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are an OSCE examiner. Output MUST be valid JSON (no markdown). " +
          "Decide each indicator as met/occurred ONLY if clearly evidenced in the transcript. " +
          "If uncertain, mark it false and leave evidence empty.",
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
              dg_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
              dg_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
              cm_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
              cm_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
              rto_positive: [{ indicator: "string", met: "boolean", evidence: "string" }],
              rto_negative: [{ indicator: "string", occurred: "boolean", evidence: "string" }],
              application: [{ indicator: "string", met: "boolean", evidence: "string" }],
              notes: "string",
            },
          },
          null,
          2
        ),
      },
    ],
    // JSON mode to guarantee JSON parseability
    text: { format: { type: "json_object" } },
    temperature: 0,
    max_output_tokens: 1600,
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
  const outText = extractResponseText(data);
  const parsed = safeJsonParse(outText);

  if (!parsed) {
    throw new Error(`OpenAI returned non-JSON output_text preview: ${String(outText).slice(0, 200)}`);
  }

  // Normalize arrays to match original indicator ordering
  function zipPos(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return indicators.map((indicator) => {
      const x = map.get(indicator) || {};
      return { indicator, met: !!x.met, evidence: (x.evidence || "").toString().trim() };
    });
  }
  function zipNeg(indicators, arr) {
    const map = new Map((Array.isArray(arr) ? arr : []).map((x) => [x.indicator, x]));
    return indicators.map((indicator) => {
      const x = map.get(indicator) || {};
      return { indicator, occurred: !!x.occurred, evidence: (x.evidence || "").toString().trim() };
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

  // Application: treat as “positive indicators only”
  const appMax = appPos.reduce((a, _, i) => a + weightForIndex(i), 0) || 1;
  const appGot = appPos.reduce((a, it, i) => a + (it.met ? weightForIndex(i) : 0), 0);
  const appBand = bandFromRatio(appGot / appMax);

  // Overall: simple average of band indexes (you can change later)
  const overallIdx =
    Math.round(
      (BANDS.indexOf(dgBand) + BANDS.indexOf(cmBand) + BANDS.indexOf(rtoBand) + BANDS.indexOf(appBand)) / 4
    );
  const overall = BANDS[clampBandIndex(overallIdx)];

  const gradingText = [
    `## Grading`,
    formatDomainText("Data Gathering & Diagnosis", dgBand, dgPos, dgNeg),
    "",
    formatDomainText("Clinical Management", cmBand, cmPos, cmNeg),
    "",
    formatDomainText("Relating to Others", rtoBand, rtoPos, rtoNeg),
    "",
    `### Application: **${appBand}**`,
    appPos.map((x) => (x.met ? `✅ ${x.indicator}${x.evidence ? ` — ${x.evidence}` : ""}` : `❌ ${x.indicator}`)).slice(0, 12).join("\n"),
    "",
    `## Overall: **${overall}**`,
    parsed.notes ? `\nNotes: ${String(parsed.notes).trim()}` : "",
  ].join("\n");

  return {
    gradingText,
    bands: { dgBand, cmBand, rtoBand, appBand, overall },
  };
}
