// api/instructions.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Airtable from "airtable";
import OpenAI from "openai";
import { put, head } from "@vercel/blob";

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  OPENAI_API_KEY,
  BLOB_READ_WRITE_TOKEN,
  RUN_SECRET,
  MAX_CASE_ID,
  INSTRUCTIONS_TEXT_MODEL,
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !OPENAI_API_KEY || !BLOB_READ_WRITE_TOKEN || !RUN_SECRET) {
  throw new Error(
    "Missing env vars: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, OPENAI_API_KEY, BLOB_READ_WRITE_TOKEN, RUN_SECRET"
  );
}

const maxCaseDefault = 355;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const airtable = new Airtable({ apiKey: AIRTABLE_TOKEN }).base(AIRTABLE_BASE_ID);

// Default to GPT-5.2 unless overridden
const TEXT_MODEL_USED = INSTRUCTIONS_TEXT_MODEL || "gpt-5.2";

// Lower temperature for consistency + fewer “weird” cues
const TEMPERATURE = 0.2;

/* -----------------------------
   Auth + retry helpers
----------------------------- */

function getHeader(req: VercelRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  if (typeof v === "string") return v;
  return undefined;
}

function requireSecret(req: VercelRequest) {
  const provided = getHeader(req, "x-run-secret");
  if (!provided || provided !== RUN_SECRET) {
    const err: any = new Error("AUTH_FAILED_RUN_SECRET");
    err.status = 401;
    throw err;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status?: number) {
  return status === 429 || (status != null && status >= 500);
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status || e?.statusCode;
      if (!isRetryableStatus(status) || i === tries - 1) break;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

function extractErr(e: any) {
  return {
    status: e?.status || e?.statusCode || 500,
    message: e?.message || String(e),
  };
}

function pad4(n: number) {
  return String(n).padStart(4, "0");
}

/* -----------------------------
   Airtable: full case text (for “don’t leak facts” safety)
----------------------------- */

const CASE_FIELDS = [
  "Name",
  "Age",
  "PMHx Record",
  "DHx",
  "Medical Notes",
  "Medical Notes Content",
  "Notes Photo",
  "Results",
  "Results Content",
  "Instructions",
  "Opening Sentence",
  "Divulge Freely",
  "Divulge Asked",
  "PMHx RP",
  "Social History",
  "Family History",
  "ICE",
  "Reaction",
] as const;

function normalizeFieldValue(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function buildRecordText(fields: Record<string, any>): string {
  const parts: string[] = [];

  for (const k of CASE_FIELDS) {
    const v = (fields as any)[k];
    if (v == null || v === "") continue;
    parts.push(`${k}: ${normalizeFieldValue(v)}`);
  }

  // include any extra fields too
  for (const [k, v] of Object.entries(fields)) {
    if ((CASE_FIELDS as readonly string[]).includes(k)) continue;
    if (v == null || v === "") continue;
    parts.push(`${k}: ${normalizeFieldValue(v)}`);
  }

  return parts.join("\n");
}

/**
 * Pull all records from "Case N" and concatenate into a single full-case text.
 * This gives the model the complete map so it can avoid leaking key clinical facts in cues.
 */
async function getCaseText(caseId: number): Promise<{ tableName: string; caseText: string; recordCount: number }> {
  const tableName = `Case ${caseId}`;
  const table = airtable(tableName);

  try {
    const records = await table.select({ maxRecords: 100 }).firstPage();
    if (!records.length) return { tableName, caseText: "", recordCount: 0 };

    const combined = records
      .map((r) => buildRecordText(r.fields as any))
      .filter(Boolean)
      .join("\n\n---\n\n");

    return { tableName, caseText: combined, recordCount: records.length };
  } catch (err: any) {
    const e: any = new Error(`AIRTABLE_READ_FAILED table="${tableName}" msg="${err?.message || String(err)}"`);
    e.status = err?.statusCode || err?.status || 500;
    e.details = err;
    throw e;
  }
}

/* -----------------------------
   Airtable: multi-record aggregation for specific fields
----------------------------- */

const FIELDS = [
  "Name",
  "Age",
  "Opening Sentence",
  "Divulge Freely",
  "Divulge Asked",
  "PMHx RP",
  "Social History",
  "Family History",
  "ICE",
  "Reaction",
  "Instructions",
] as const;

type FieldName = (typeof FIELDS)[number];
type InstructionInput = Record<FieldName, string>;

function clean(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  try {
    return JSON.stringify(v).trim();
  } catch {
    return String(v).trim();
  }
}

/**
 * De-dupe exact duplicates while preserving order.
 */
function uniqPreserve(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of values.map((x) => String(x || "").trim()).filter(Boolean)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Index snippets explicitly to reduce confusion from multi-record tables.
 */
function joinManyIndexed(values: string[]): string {
  const arr = uniqPreserve(values);
  if (!arr.length) return "";
  return arr.map((v, i) => `[${i + 1}] ${v}`).join("\n\n---\n\n");
}

async function getInstructionFields(caseId: number): Promise<InstructionInput> {
  const tableName = `Case ${caseId}`;
  const table = airtable(tableName);

  const records = await table.select({ maxRecords: 100 }).firstPage();

  const buckets: Record<string, string[]> = {};
  for (const k of FIELDS) buckets[k] = [];

  for (const r of records) {
    const f: any = (r.fields || {}) as any;
    const instr = f["Instructions"] ?? f["Instruction"]; // tolerate naming variance

    buckets["Name"].push(clean(f["Name"]));
    buckets["Age"].push(clean(f["Age"]));
    buckets["Opening Sentence"].push(clean(f["Opening Sentence"]));
    buckets["Divulge Freely"].push(clean(f["Divulge Freely"]));
    buckets["Divulge Asked"].push(clean(f["Divulge Asked"]));
    buckets["PMHx RP"].push(clean(f["PMHx RP"]));
    buckets["Social History"].push(clean(f["Social History"]));
    buckets["Family History"].push(clean(f["Family History"]));
    buckets["ICE"].push(clean(f["ICE"]));
    buckets["Reaction"].push(clean(f["Reaction"]));
    buckets["Instructions"].push(clean(instr));
  }

  return {
    Name: joinManyIndexed(buckets["Name"]),
    Age: joinManyIndexed(buckets["Age"]),
    "Opening Sentence": joinManyIndexed(buckets["Opening Sentence"]),
    "Divulge Freely": joinManyIndexed(buckets["Divulge Freely"]),
    "Divulge Asked": joinManyIndexed(buckets["Divulge Asked"]),
    "PMHx RP": joinManyIndexed(buckets["PMHx RP"]),
    "Social History": joinManyIndexed(buckets["Social History"]),
    "Family History": joinManyIndexed(buckets["Family History"]),
    ICE: joinManyIndexed(buckets["ICE"]),
    Reaction: joinManyIndexed(buckets["Reaction"]),
    Instructions: joinManyIndexed(buckets["Instructions"]),
  };
}

/* -----------------------------
   Blob bundling (groups of N)
----------------------------- */

async function blobExists(pathname: string): Promise<boolean> {
  try {
    await head(pathname);
    return true;
  } catch {
    return false;
  }
}

async function uploadBundleJson(
  startCaseId: number,
  endCaseId: number,
  bundleObj: any,
  overwrite: boolean
): Promise<string> {
  const pathname = `case-instructions/batch-${pad4(startCaseId)}-${pad4(endCaseId)}.json`;

  if (!overwrite) {
    const exists = await blobExists(pathname);
    if (exists) return (await head(pathname)).url;
  }

  const bytes = Buffer.from(JSON.stringify(bundleObj, null, 2), "utf-8");
  const res = await put(pathname, bytes, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return res.url;
}

/* -----------------------------
   Prompt text (kept undiluted)
----------------------------- */

const FINAL_POLISHED_INSTRUCTION_BLOCK = `
Final Polished Instruction (Optimised for Your Use Case)  

Please read the case details below and produce two outputs: 

Instructions: Write in UK English, in second person, present tense, starting exactly with “You are…”. Make it clear this is a video or telephone consultation, and include the name and specific age of the person speaking; if the speaker is calling about or attending with someone else, also include the name and specific age of the other person. If the case specifies multiple speaking roles (e.g., patient plus partner/parent/paramedic), explicitly state that there are multiple voices in the consultation, name each speaker, and specify who leads the history and when the other person speaks (e.g., answers only when prompted, interrupts to disagree, corrects details, etc.). 
Assume the bot will have access to the full case details, so do not restate any facts already provided anywhere in the case (including symptoms, timeline, examination findings, medications, past history, social history, and ideas/concerns/expectations); instead, write only what is needed to guide roleplay: each speaker’s tone, emotional state, communication style, level of health anxiety, how cooperative or challenging they are, what triggers escalation, what reassures them, and how they interact with each other. 

Exception: Some cases include an “instruction field” that will be replaced/overwritten in the final bot, meaning the bot will not be able to see that field afterwards. If important roleplay information appears in that instruction field, you must carry it over into the new 2-sentence character brief. 

Opening line (1 sentence): 
Write the patient’s first spoken sentence in first person, phrased in a natural, conversational way that fits how this individual would actually speak (matching their age, confidence, education, and personality). Avoid overly formal or clinical wording unless the case clearly suggests the patient speaks that way. It’s important that the opening sentence doesn’t reveal any plans or worries. 

3. Patient Cues 

This section is critical. 

Include no more than 2 cues. 

Each cue must be a neutral observation, not a disclosure. 

Cues must not reveal key clinical facts, red flags, diagnoses, exact timelines, risks, or underlying causes. 

Do not include interpretation, conclusions, or emotional reasoning (avoid “because…”, “so I think…”, “it must be…”). 

A cue should never give the answer — it should only prompt the clinician to ask the next question. 

Cues are only used if the clinician has not already explored that area. 

Keep both cues within one short paragraph, with each cue written as a single sentence. 

A good cue: 

Hints at a missing domain. 

Sounds natural and spontaneous. 

Could safely be said even if the clinician does not follow up. 

Opens a door without stepping through it. 

A bad cue: 

States a red-flag symptom directly. 

Provides a diagnosis or label. 

Gives an exact timeframe. 

Reveals a safeguarding, risk, or safety-critical detail outright. 

Answers a question the clinician has not yet asked. 

Think: 
A cue should create curiosity, not provide clarity. 

Important: Treat every case as independent and do not carry over information from previous cases. 
`.trim();

/* -----------------------------
   Generation (split: main + cues) + validation/repair
----------------------------- */

type MainOutput = {
  instructions: string; // MUST start You are...
  opening_line: string; // 1 sentence, first person
};

type CuesOutput = {
  patient_cues: string[]; // 0-2 items, each 1 sentence
};

function mustStartWithYouAre(s: string) {
  return /^you are\b/i.test(String(s || "").trim());
}

function sentenceCount(s: string): number {
  const t = String(s || "").trim();
  if (!t) return 0;
  // crude but effective: count ., !, ?
  const m = t.match(/[.!?]+/g);
  return m ? m.length : 1;
}

function hasDisallowedCuesContent(s: string): string | null {
  const t = String(s || "").toLowerCase();

  // avoid explicit reasoning
  if (/\bbecause\b/.test(t)) return "contains 'because'";
  if (/\bso i think\b/.test(t)) return "contains 'so I think'";
  if (/\bit must\b/.test(t)) return "contains 'it must'";
  if (/\bi think\b/.test(t)) return "contains 'I think'";

  // avoid exact timeframes / numbers (common leak)
  // allow ages like "my 3-year-old" would be a leak risk too; keep strict:
  if (/\b\d+\b/.test(t)) return "contains a number (timeline/age risk)";

  // avoid “red flag” words (not exhaustive, but helps a lot)
  if (/\bdiagnos/.test(t)) return "mentions diagnosis";
  if (/\bred flag\b/.test(t)) return "mentions red flag";
  if (/\bsepsis\b|\bstroke\b|\bheart attack\b|\bmi\b|\bpe\b/.test(t)) return "mentions high-risk diagnosis";
  if (/\bbleed(ing)?\b|\bsuicid|\boverdose\b/.test(t)) return "mentions high-risk disclosure";

  return null;
}

function validateCues(cues: string[]): { ok: boolean; reason?: string } {
  const arr = cues.map((x) => String(x || "").trim()).filter(Boolean);

  if (arr.length > 2) return { ok: false, reason: "more than 2 cues" };
  for (const c of arr) {
    if (sentenceCount(c) !== 1) return { ok: false, reason: "a cue is not exactly 1 sentence" };
    const bad = hasDisallowedCuesContent(c);
    if (bad) return { ok: false, reason: `cue invalid: ${bad}` };
    // avoid overly long cues
    if (c.length > 220) return { ok: false, reason: "cue too long" };
  }
  return { ok: true };
}

function joinCuesToParagraph(cues: string[]): string {
  const arr = cues.map((x) => String(x || "").trim()).filter(Boolean);
  if (!arr.length) return "";
  // One short paragraph, max 2 sentences total
  return arr.join(" ");
}

function extractJsonObject(raw: string) {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return raw.slice(firstBrace, lastBrace + 1);
}

async function llmJson(prompt: string): Promise<any> {
  const resp = await withRetry(() =>
    openai.responses.create({
      model: TEXT_MODEL_USED,
      input: prompt,
      temperature: TEMPERATURE,
    } as any)
  );

  const raw = (resp as any).output_text?.trim?.() || "";
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) throw new Error(`LLM_JSON_PARSE_FAILED: ${raw.slice(0, 240)}`);
  return JSON.parse(jsonStr);
}

async function generateMain(caseText: string, input: InstructionInput, caseId: number): Promise<MainOutput> {
  const prompt = `
${FINAL_POLISHED_INSTRUCTION_BLOCK}

IMPORTANT OUTPUT FORMAT:
Return ONLY valid JSON with EXACTLY these keys:
{
  "instructions": "...",
  "opening_line": "..."
}

CRITICAL CLARIFICATION (DO NOT IGNORE):
In THIS system, the existing Airtable "Instructions" field WILL be overwritten by your new "instructions" output, and the final bot will NOT have access to the old Airtable Instructions text. Therefore, you MUST carry over ANY roleplay-relevant details from the existing Airtable Instructions field into your new "instructions" output (integrated naturally). Do NOT rely on the old Instructions field being visible later.

Additional constraints (do not ignore):
- "instructions" MUST start exactly with "You are".
- Do NOT include patient cues in "instructions" (those will be generated separately).
- Treat every case as independent.

Deterministic key (do not output): CASE_ID=${caseId}

FULL CASE TEXT (bot can see this; do not restate facts in instructions):
${caseText}

SELECTED FIELDS (may contain multiple snippets separated by --- and indexed):
Name:
${input["Name"]}

Age:
${input["Age"]}

Opening Sentence:
${input["Opening Sentence"]}

Divulge Freely:
${input["Divulge Freely"]}

Divulge Asked:
${input["Divulge Asked"]}

PMHx RP:
${input["PMHx RP"]}

Social History:
${input["Social History"]}

Family History:
${input["Family History"]}

ICE:
${input["ICE"]}

Reaction:
${input["Reaction"]}

Instructions field (THIS WILL BE OVERWRITTEN; MUST CARRY OVER ROLEPLAY-RELEVANT CONTENT INTO NEW OUTPUT):
${input["Instructions"]}
`.trim();

  const parsed = await llmJson(prompt);

  const instructions = String(parsed.instructions ?? "").trim();
  const opening_line = String(parsed.opening_line ?? "").trim();

  if (!mustStartWithYouAre(instructions)) throw new Error(`INSTRUCTION_BAD_START: must start with "You are..."`);
  if (sentenceCount(opening_line) !== 1) {
    // not fatal, but usually helpful to enforce
    throw new Error(`OPENING_LINE_BAD_SENTENCE_COUNT: must be exactly 1 sentence`);
  }

  return { instructions, opening_line };
}

async function generateCues(caseText: string, input: InstructionInput, caseId: number): Promise<CuesOutput> {
  // Cues generated in isolation, with strict array output
  const prompt = `
${FINAL_POLISHED_INSTRUCTION_BLOCK}

You are producing ONLY the Patient Cues output for this case.

IMPORTANT OUTPUT FORMAT:
Return ONLY valid JSON with EXACTLY these keys:
{
  "patient_cues": ["...", "..."]
}

Rules (repeat, do not ignore):
- Include no more than 2 cues total.
- Each cue must be a neutral observation, not a disclosure.
- Cues must not reveal key clinical facts, red flags, diagnoses, exact timelines, risks, or underlying causes.
- Do not include interpretation, conclusions, or emotional reasoning (avoid “because…”, “so I think…”, “it must be…”).
- Each cue must be exactly ONE sentence.
- Avoid numbers and exact time references (do not include any digits).
- Cues should create curiosity, not provide clarity.
- Treat every case as independent.

Deterministic key (do not output): CASE_ID=${caseId}

FULL CASE TEXT (you can see it to avoid accidentally leaking key details in cues):
${caseText}

Helpful context about tone/personality (do not restate facts):
Name:
${input["Name"]}

Age:
${input["Age"]}

Reaction:
${input["Reaction"]}

ICE:
${input["ICE"]}
`.trim();

  const parsed = await llmJson(prompt);

  const cues = Array.isArray(parsed.patient_cues) ? parsed.patient_cues : [];
  const cleaned = cues.map((x: any) => String(x || "").trim()).filter(Boolean);

  return { patient_cues: cleaned.slice(0, 2) };
}

async function repairCues(caseText: string, badCues: string[], caseId: number): Promise<CuesOutput> {
  const prompt = `
You are correcting Patient Cues that failed strict rules.

Return ONLY valid JSON with EXACTLY these keys:
{
  "patient_cues": ["...", "..."]
}

Rules (must pass):
- Max 2 cues.
- Each cue exactly ONE sentence.
- Each cue is a neutral observation (not a disclosure) of something important or key to the case.
- Must NOT reveal key clinical facts, red flags, diagnoses, exact timelines, risks, or underlying causes.
- Must NOT contain any digits/numbers.
- Must NOT include interpretations, conclusion or emotional reasoning (avoid "because","so i think","it must be..").
- A Cue should never give the answer - it should only prompt the clinican to ask the next question.
- Cues are only used if the clinician has not already explored that area.
- each cue must be written as a conditional prompt in the form of: "If (something important) has not been asked about, you mention....".
- One cue can be omitted if safer (return [] or [single cue]).

Deterministic key (do not output): CASE_ID=${caseId}

FULL CASE TEXT (for safety; do not leak facts in cues):
${caseText}

BAD CUES TO FIX:
${badCues.map((c, i) => `- [${i + 1}] ${c}`).join("\n")}
`.trim();

  const parsed = await llmJson(prompt);
  const cues = Array.isArray(parsed.patient_cues) ? parsed.patient_cues : [];
  const cleaned = cues.map((x: any) => String(x || "").trim()).filter(Boolean);
  return { patient_cues: cleaned.slice(0, 2) };
}

async function generateCuesVerified(caseText: string, input: InstructionInput, caseId: number): Promise<string[]> {
  // Try: generate -> validate -> if fail, repair -> validate -> else retry generate (up to 3 total attempts)
  let last: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await generateCues(caseText, input, caseId);
    last = out.patient_cues;

    const v = validateCues(last);
    if (v.ok) return last;

    // one repair attempt
    const repaired = await repairCues(caseText, last, caseId);
    last = repaired.patient_cues;

    const v2 = validateCues(last);
    if (v2.ok) return last;

    await sleep(120);
  }

  // If still failing, return best-effort (could be empty)
  return last.slice(0, 2);
}

/* -----------------------------
   Handler
----------------------------- */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    requireSecret(req);

    const startFrom = Number(req.query.startFrom ?? 1);
    const maxCase = Number(MAX_CASE_ID ?? maxCaseDefault);
    const endAt = Number(req.query.endAt ?? maxCase);

    // bundleSize = cases per uploaded file (default 10)
    const bundleSize = Math.max(1, Math.min(50, Number(req.query.bundleSize ?? 10)));

    // limit = max cases processed per invocation (default = bundleSize)
    const limit = Math.max(1, Number(req.query.limit ?? bundleSize));

    const dryRun = String(req.query.dryRun ?? "0") === "1";
    const overwrite = String(req.query.overwrite ?? "0") === "1";
    const debug = String(req.query.debug ?? "0") === "1";

    const processed: any[] = [];
    const bundles: any[] = [];

    let currentBundleStart: number | null = null;
    let currentItems: any[] = [];

    const flushBundle = async () => {
      if (currentBundleStart == null) return;
      if (!currentItems.length) return;

      const startId = currentBundleStart;
      const endId = currentItems[currentItems.length - 1]?.caseId ?? startId;

      const bundleObj = {
        createdAt: new Date().toISOString(),
        model: TEXT_MODEL_USED,
        temperature: TEMPERATURE,
        range: { start: startId, end: endId },
        count: currentItems.length,
        items: currentItems,
      };

      if (dryRun) {
        bundles.push({ range: `${pad4(startId)}-${pad4(endId)}`, status: "dryrun-skip-upload" });
      } else {
        const url = await uploadBundleJson(startId, endId, bundleObj, overwrite);
        bundles.push({ range: `${pad4(startId)}-${pad4(endId)}`, status: "uploaded", url });
      }

      currentBundleStart = null;
      currentItems = [];
    };

    for (let caseId = startFrom; caseId <= endAt; caseId++) {
      if (processed.length >= limit) break;

      try {
        const { tableName, caseText, recordCount } = await getCaseText(caseId);

        if (!caseText.trim()) {
          const item = { caseId, tableName, recordCount, status: "no-text" };
          processed.push(item);
          if (currentBundleStart == null) currentBundleStart = caseId;
          currentItems.push(item);
          if (currentItems.length >= bundleSize) await flushBundle();
          continue;
        }

        if (dryRun) {
          const item = { caseId, tableName, recordCount, status: "dryrun-ok" };
          processed.push(item);
          if (currentBundleStart == null) currentBundleStart = caseId;
          currentItems.push(item);
          if (currentItems.length >= bundleSize) await flushBundle();
          continue;
        }

        const input = await getInstructionFields(caseId);

        const main = await generateMain(caseText, input, caseId);
        const cuesArr = await generateCuesVerified(caseText, input, caseId);

        const output = {
          instructions: main.instructions,
          opening_line: main.opening_line,
          patient_cues: joinCuesToParagraph(cuesArr),
          patient_cues_array: cuesArr, // keep for debugging/traceability (optional)
        };

        const item = {
          caseId,
          tableName,
          recordCount,
          // Keep both full case text and inputs for traceability.
          // If you want smaller blob files, you can remove these two lines.
          input,
          // caseText,
          output,
        };

        processed.push({ caseId, status: "done", tableName, recordCount });

        if (debug) {
          return res.status(200).json({ ok: true, debug: true, item, model: TEXT_MODEL_USED });
        }

        if (currentBundleStart == null) currentBundleStart = caseId;
        currentItems.push(item);
        if (currentItems.length >= bundleSize) await flushBundle();

        await sleep(150);
      } catch (e: any) {
        const item = { caseId, status: "error", error: extractErr(e) };
        processed.push(item);

        if (currentBundleStart == null) currentBundleStart = caseId;
        currentItems.push(item);
        if (currentItems.length >= bundleSize) await flushBundle();
      }
    }

    await flushBundle();

    return res.status(200).json({
      ok: true,
      startFrom,
      endAt,
      limit,
      bundleSize,
      dryRun,
      overwrite,
      model: TEXT_MODEL_USED,
      temperature: TEMPERATURE,
      processedCount: processed.length,
      processed,
      bundles,
    });
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || "Unknown error", status });
  }
}
