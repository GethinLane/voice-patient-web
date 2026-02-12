// api/start-session.js (DEBUG)

import { getCaseProfileByCaseId } from "./_airtable.js";

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
    ["gcp", "google"],
  ]);

  return aliases.get(compact) || raw;
}

function debugValueMeta(value) {
  return {
    type: Array.isArray(value) ? "array" : typeof value,
    value,
    normalized: valueFromAirtableField(value),
  };
}

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

    const startTone = (profileFields?.StartTone || "neutral").toString().trim().toLowerCase();

    const tts = {
      provider: providerCanonical,
      voice: voiceRaw != null ? safeStr(voiceRaw).trim() : null,
      model: modelRaw != null ? safeStr(modelRaw).trim() : null,
      config: configObj,
    };

    // Pipecat config
    const agentName = process.env.PIPECAT_AGENT_NAME;
    const apiKey = process.env.PIPECAT_PUBLIC_API_KEY;
    if (!agentName) throw new Error("Missing PIPECAT_AGENT_NAME");
    if (!apiKey) throw new Error("Missing PIPECAT_PUBLIC_API_KEY");

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

    if (!resp.ok) {
      return res.status(resp.status).json({
        ok: false,
        error: (data && (data.error || data.message)) || raw.slice(0, 400),
        receivedCaseId,
        parsedCaseId: caseId,
        sent,

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
        },

        pipecatStatus: resp.status,
        pipecatRawPreview: raw.slice(0, 400),
      });
    }

    return res.json({
      ok: true,
      receivedCaseId,
      parsedCaseId: caseId,
      sent,

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
      },

      sessionId: data.sessionId,
      dailyRoom: data.dailyRoom,
      dailyToken: data.dailyToken,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
