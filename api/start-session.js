// api/start-session.js (DEBUG)

import { getCaseProfileByCaseId } from "./_airtable.js";

function safeStr(x) {
  return x == null ? "" : String(x);
}

function parseJSONMaybe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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
    const providerRaw =
      (safeMode === "premium" ? profileFields?.PremiumProvider : profileFields?.StandardProvider) || "cartesia";
    const voiceRaw =
      (safeMode === "premium" ? profileFields?.PremiumVoice : profileFields?.StandardVoice) || null;

    // Optional fields (won’t break if you didn’t create them)
    const modelRaw =
      (safeMode === "premium" ? profileFields?.PremiumModel : profileFields?.StandardModel) || null;

    const configRaw =
      (safeMode === "premium" ? profileFields?.PremiumConfigJSON : profileFields?.StandardConfigJSON) || "";

    const configObj = parseJSONMaybe(configRaw) || {};

    const startTone = (profileFields?.StartTone || "neutral").toString().trim().toLowerCase();

    const tts = {
      provider: safeStr(providerRaw).trim().toLowerCase(),
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

      sessionId: data.sessionId,
      dailyRoom: data.dailyRoom,
      dailyToken: data.dailyToken,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
