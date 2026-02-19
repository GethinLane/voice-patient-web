// api/start-session.js (DEBUG)

import { getCaseProfileByCaseId, airtableListAll } from "./_airtable.js";

function safeStr(x) {
  return x == null ? "" : String(x);
}

function parseJSONMaybe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = valueFromAirtableField(value);
    if (normalized) return normalized;
  }
  return "";
}

function valueFromAirtableField(value) {
  if (value == null) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = valueFromAirtableField(item);
      if (nested) return nested;
    }
    return "";
  }

  if (typeof value === "object") {
    return firstNonEmpty(value.name, value.value, value.id);
  }

  return safeStr(value).trim();
}

function canonicalizeProvider(value) {
  const raw = safeStr(value).trim().toLowerCase();
  if (!raw) return "";

  const compact = raw.replace(/[\s_-]+/g, "");
  const aliases = new Map([
    ["cartesia", "cartesia"],
    ["elevenlabs", "elevenlabs"],
    ["eleven", "elevenlabs"],
    ["11labs", "elevenlabs"],
    ["google", "google"],
    ["googletts", "google"],
    ["googlecloud", "google"],
    ["googlecloudtts", "google"],
    ["googletexttospeech", "google"],
    ["googlecloudtexttospeech", "google"],
    ["gcp", "google"],

    // Inworld
    ["inworld", "inworld"],
    ["inworldtts", "inworld"],
    ["inworldai", "inworld"],
    ["inworldtexttospeech", "inworld"],
  ]);

  if (aliases.has(compact)) return aliases.get(compact);

  if (compact.includes("google")) return "google";
  if (compact.includes("inworld")) return "inworld";

  return raw;
}


function buildTtsPreflightWarnings({ provider, voice, model, config }) {
  const warnings = [];

  if (provider === "google") {
    if (!voice) {
      warnings.push("Google TTS selected but no voice is set in Airtable (StandardVoice/PremiumVoice).");
    }

    const hasAnyConfig =
      !!(config && typeof config === "object" && Object.keys(config).length > 0);

    if (!hasAnyConfig) {
      warnings.push(
        "Google TTS selected with empty config. If Pipecat logs show 'No valid credentials provided', configure Google credentials in the bot runtime environment (not this Vercel start-session API)."
      );
    }
  }

  if (provider === "inworld") {
    if (!voice) {
      warnings.push("Inworld selected but no voiceId is set in Airtable (StandardVoice/PremiumVoice).");
    }
    if (!model) {
      warnings.push("Inworld selected but no modelId is set in Airtable (StandardModel/PremiumModel). The bot will default if missing, but set it for control.");
    }
  }

  return warnings;
}

function debugValueMeta(value) {
  return {
    type: Array.isArray(value) ? "array" : typeof value,
    value,
    normalized: valueFromAirtableField(value),
  };
}

function escapeFormulaString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function parseCreditCost(rawValue, fallback) {
  const n = Number(String(rawValue ?? "").trim());
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

// ---------------- PIPECAT AGENT POOL + FAILOVER HELPERS ----------------

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function getAgentPool() {
  const raw =
    process.env.PIPECAT_AGENT_NAMES ||
    process.env.PIPECAT_AGENT_NAME ||
    "";
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function isCapacityError(resp, data, rawText) {
  // Pipecat: at-capacity is HTTP 429
  if (resp?.status === 429) return true;

  const code =
    data?.code ||
    data?.error_code ||
    data?.errorCode ||
    data?.error;

  if (code === "PCC-AGENT-AT-CAPACITY") return true;

  const msg = String(data?.message || data?.error || rawText || "");
  return /maximum agent instances reached|at[- ]capacity|pool capacity|rate limit exceeded/i.test(msg);
}

// Optional: allow forcing an agent for testing only
function pickAgentOrder({ seed, forcedAgent }) {
  const pool = getAgentPool();
  if (!pool.length) return [];

  // If tester forces an agent, try it first, then rest as fallback
  if (forcedAgent && pool.includes(forcedAgent)) {
    return [forcedAgent, ...pool.filter(a => a !== forcedAgent)];
  }

  // Otherwise deterministic load-spread
  const startIdx = fnv1a32(seed) % pool.length;
  return pool.slice(startIdx).concat(pool.slice(0, startIdx));
}

// ----------------------------------------------------------------------


export default async function handler(req, res) {
  const origin = req.headers.origin;

  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
    "https://scarevision.co.uk",
    "https://scarevision.ai",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const receivedCaseId = req.body?.caseId;
    const caseId = Number(receivedCaseId);

    // Identity
    const userId = req.body?.userId != null ? safeStr(req.body.userId).trim() : "";
    const email  = req.body?.email  != null ? safeStr(req.body.email).trim().toLowerCase() : "";

    if (!caseId) {
      return res.status(400).json({ ok: false, error: "Missing/invalid caseId", receivedCaseId });
    }

    // Require identity (as you already do)
    if (!userId && !email) {
      return res.status(400).json({ ok: false, error: "Missing userId/email (not logged in)" });
    }

    // Standard vs premium mode
    const mode = (req.body?.mode != null ? safeStr(req.body.mode) : "standard").trim().toLowerCase();
    const safeMode = mode === "premium" ? "premium" : "standard";
    const forcedAgent = req.body?.agent != null ? safeStr(req.body.agent).trim() : "";


    // ---------------- CREDIT GATE (BLOCK START IF INSUFFICIENT) ----------------
    const usersKey = process.env.AIRTABLE_USERS_API_KEY;
    const usersBase = process.env.AIRTABLE_USERS_BASE_ID;
    const usersTable = process.env.USERS_AI_USERS_TABLE; // keep your existing env naming

    if (!usersKey) throw new Error("Missing AIRTABLE_USERS_API_KEY");
    if (!usersBase) throw new Error("Missing AIRTABLE_USERS_BASE_ID");
    if (!usersTable) throw new Error("Missing USERS_AI_USERS_TABLE");

    const idField = "UserID";
    const creditsField = "CreditsRemaining";

    // Prefer userId match when present; otherwise use email
    const filterByFormula = userId
      ? `{${idField}}='${escapeFormulaString(userId)}'`
      : `LOWER({Email})='${escapeFormulaString(email)}'`;

    const userRecs = await airtableListAll({
      apiKey: usersKey,
      baseId: usersBase,
      table: usersTable,
      params: { filterByFormula, maxRecords: 2 },
    });

    if (!userRecs?.length) {
      return res.status(404).json({ ok: false, error: "User not found (cannot start session)" });
    }

    if (userRecs.length > 1) {
      return res.status(409).json({ ok: false, error: "Multiple Users matched; fix duplicates in Airtable." });
    }

    const userFields = userRecs[0].fields || {};
    const available = Number(userFields?.[creditsField]);

    if (!Number.isFinite(available)) {
      return res.status(500).json({ ok: false, error: `User field '${creditsField}' is not numeric.` });
    }

    const standardCost = parseCreditCost(process.env.STANDARD_BOT_COST, 2);
    const premiumCost = parseCreditCost(process.env.PREMIUM_BOT_COST, 1);
    const required = safeMode === "premium" ? premiumCost : standardCost;

    if (available < required) {
      return res.status(402).json({
        ok: false,
        error: `Insufficient credits for ${safeMode} bot`,
        credits: { available, required, mode: safeMode },
      });
    }
    // --------------------------------------------------------------------------


    // Airtable Cases base (same env vars you already use)
    const casesApiKey = process.env.AIRTABLE_API_KEY;
    const casesBaseId = process.env.AIRTABLE_BASE_ID;
    if (!casesApiKey) throw new Error("Missing AIRTABLE_API_KEY");
    if (!casesBaseId) throw new Error("Missing AIRTABLE_BASE_ID");

    // Load CaseProfiles row (optional; fall back safely)
    let profileFields = null;
    let profileRecordId = null;

    try {
      const rec = await getCaseProfileByCaseId({
        apiKey: casesApiKey,
        baseId: casesBaseId,
        caseId,
      });
      profileRecordId = rec?.id || null;
      profileFields = rec?.fields || null;
    } catch (err) {
      profileFields = null;
    }

    // --- Pick provider/voice from profile, using ONLY fields you said you created ---
    // Expected Airtable fields:
    // StandardProvider, StandardVoice, PremiumProvider, PremiumVoice, StartTone
    const modeProviderField = safeMode === "premium" ? "PremiumProvider" : "StandardProvider";
    const modeVoiceField = safeMode === "premium" ? "PremiumVoice" : "StandardVoice";

    const providerSource = profileFields?.[modeProviderField];
    const voiceSource = profileFields?.[modeVoiceField];

    const normalizedProvider = valueFromAirtableField(providerSource);
    const normalizedVoice = valueFromAirtableField(voiceSource);

    const providerRaw = firstNonEmpty(providerSource, "cartesia");
    const providerCanonical = canonicalizeProvider(providerRaw);
    const voiceRaw = firstNonEmpty(voiceSource) || null;

    const providerFallbackReason = normalizedProvider
      ? null
      : `No usable value in ${modeProviderField}; defaulted to cartesia`;

    const providerCanonicalizationNote =
      providerCanonical !== safeStr(providerRaw).trim().toLowerCase()
        ? `Canonicalized provider "${safeStr(providerRaw).trim()}" -> "${providerCanonical}"`
        : null;

    // Optional fields (won’t break if you didn’t create them)
    const modelRaw =
      (safeMode === "premium" ? profileFields?.PremiumModel : profileFields?.StandardModel) || null;

    const configRaw =
      (safeMode === "premium" ? profileFields?.PremiumConfigJSON : profileFields?.StandardConfigJSON) || "";

    const configObj = parseJSONMaybe(configRaw) || {};

        // ------------------- NEW: Voice speed (speakingRate) -------------------
    // Airtable field: StandardVoiceSpeed (Number). Optional PremiumVoiceSpeed later.
    const speedRaw =
      safeMode === "premium"
        ? profileFields?.PremiumVoiceSpeed   // only works if you add this field
        : profileFields?.StandardVoiceSpeed; // your new field

    let speakingRate =
      (typeof speedRaw === "number" && Number.isFinite(speedRaw))
        ? speedRaw
        : Number(String(speedRaw ?? "").trim());

    if (!Number.isFinite(speakingRate)) speakingRate = 1.0;

    // clamp to safe range
    speakingRate = Math.max(0.5, Math.min(2.0, speakingRate));

    // Put into config under canonical key the bot expects
    configObj.speakingRate = speakingRate;
    // ----------------------------------------------------------------------


    const startTone = (profileFields?.StartTone || "neutral").toString().trim().toLowerCase();

    const tts = {
      provider: providerCanonical,
      voice: voiceRaw != null ? safeStr(voiceRaw).trim() : null,
      model: modelRaw != null ? safeStr(modelRaw).trim() : null,
      config: configObj,
    };

    const ttsPreflightWarnings = buildTtsPreflightWarnings(tts);

// Pipecat config
const apiKey = process.env.PIPECAT_PUBLIC_API_KEY;
if (!apiKey) throw new Error("Missing PIPECAT_PUBLIC_API_KEY");

const agentSeed = `${userId || email || "anon"}:${caseId}`;
const agentOrder = pickAgentOrder({ seed: agentSeed, forcedAgent });

if (!agentOrder.length) {
  throw new Error("Missing PIPECAT_AGENT_NAME(S): set PIPECAT_AGENT_NAMES or PIPECAT_AGENT_NAME");
}

const sent = {
  transport: "webrtc",
  createDailyRoom: true,
  body: {
    caseId,
    userId,
    email,
    mode: safeMode,
    startTone,
    tts,
  },
};

// Try each agent in order; fail over only on capacity errors (typically 429)
let lastCapacity = null;
const attempts = [];

for (const agentName of agentOrder) {
  const url = `https://api.pipecat.daily.co/v1/public/${encodeURIComponent(agentName)}/start`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sent),
  });

  const raw = await resp.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}

  attempts.push({
    agentName,
    status: resp.status,
    preview: raw.slice(0, 180),
  });

  if (resp.ok) {
    return res.json({
      ok: true,
      receivedCaseId,
      parsedCaseId: caseId,
      sent,

      agentNameUsed: agentName,
      attempts,

      // DEBUG: show what we found in Airtable
      profileFound: !!profileFields,
      profileRecordId,
      profileKeys: profileFields ? Object.keys(profileFields) : [],
      debugTtsSelection: {
        mode: safeMode,
        modeProviderField,
        modeVoiceField,
        providerSource: debugValueMeta(providerSource),
        voiceSource: debugValueMeta(voiceSource),
        normalizedProvider,
        normalizedVoice,
        selectedProviderRaw: safeStr(providerRaw).trim().toLowerCase(),
        selectedProvider: providerCanonical,
        selectedVoice: voiceRaw != null ? safeStr(voiceRaw).trim() : null,
        providerFallbackReason,
        providerCanonicalizationNote,
        ttsPreflightWarnings,
      },

      sessionId: data.sessionId,
      dailyRoom: data.dailyRoom,
      dailyToken: data.dailyToken,
    });
  }

  // Capacity/at-limit? try next agent
  if (isCapacityError(resp, data, raw)) {
    lastCapacity = { agentName, status: resp.status, raw: raw.slice(0, 400), data };
    continue;
  }

  // Any other error: stop immediately (don’t spam other deployments)
  return res.status(resp.status).json({
    ok: false,
    error: (data && (data.error || data.message)) || raw.slice(0, 400),
    receivedCaseId,
    parsedCaseId: caseId,
    sent,

    agentNameTried: agentName,
    attempts,

    // DEBUG: show what we found in Airtable
    profileFound: !!profileFields,
    profileRecordId,
    profileKeys: profileFields ? Object.keys(profileFields) : [],
    debugTtsSelection: {
      mode: safeMode,
      modeProviderField,
      modeVoiceField,
      providerSource: debugValueMeta(providerSource),
      voiceSource: debugValueMeta(voiceSource),
      normalizedProvider,
      normalizedVoice,
      selectedProviderRaw: safeStr(providerRaw).trim().toLowerCase(),
      selectedProvider: providerCanonical,
      selectedVoice: voiceRaw != null ? safeStr(voiceRaw).trim() : null,
      providerFallbackReason,
      providerCanonicalizationNote,
      ttsPreflightWarnings,
    },

    pipecatStatus: resp.status,
    pipecatRawPreview: raw.slice(0, 400),
  });
}

// All agents looked “full”
return res.status(429).json({
  ok: false,
  error: "All Pipecat agent deployments are at capacity. Please retry shortly.",
  code: lastCapacity?.data?.code || "PCC-AGENT-AT-CAPACITY",
  attempts,
  receivedCaseId,
  parsedCaseId: caseId,
  sent,
});

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
