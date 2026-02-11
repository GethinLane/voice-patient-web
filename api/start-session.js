// api/start-session.js (DEBUG)

import { getCaseProfileByCaseId } from "./_airtable.js";

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

    // ✅ NEW: accept identity from frontend
    const userId = req.body?.userId != null ? String(req.body.userId).trim() : "";
    const email  = req.body?.email  != null ? String(req.body.email).trim().toLowerCase() : "";

    if (!caseId) {
      return res.status(400).json({ ok: false, error: "Missing/invalid caseId", receivedCaseId });
    }

    // 🔒 Optional but recommended: require identity
    // (If you want to allow free anonymous demo mode, remove this)
    if (!userId && !email) {
      return res.status(400).json({ ok: false, error: "Missing userId/email (not logged in)" });
    }
        // ✅ NEW: standard vs premium mode (from frontend button/link)
    const mode = (req.body?.mode != null ? String(req.body.mode) : "standard").trim().toLowerCase();
    const safeMode = mode === "premium" ? "premium" : "standard";

    // ✅ NEW: load case profile from Airtable (CaseProfiles table in the same base)
    const casesApiKey = process.env.AIRTABLE_API_KEY;
    const casesBaseId = process.env.AIRTABLE_BASE_ID;
    if (!casesApiKey) throw new Error("Missing AIRTABLE_API_KEY");
    if (!casesBaseId) throw new Error("Missing AIRTABLE_BASE_ID");

    let profile = null;
    try {
      const rec = await getCaseProfileByCaseId({ apiKey: casesApiKey, baseId: casesBaseId, caseId });
      profile = rec?.fields || null;
    } catch (err) {
      // Don't hard-fail if profile missing — keep Cartesia default behaviour
      profile = null;
    }

    // ✅ NEW: pick provider/voice/model/config from profile based on mode
    const provider = (safeMode === "premium" ? profile?.PremiumProvider : profile?.StandardProvider) || "cartesia";
    const voice    = (safeMode === "premium" ? profile?.PremiumVoice    : profile?.StandardVoice)    || null;
    const model    = (safeMode === "premium" ? profile?.PremiumModel    : profile?.StandardModel)    || null;

    const configRaw = (safeMode === "premium" ? profile?.PremiumConfigJSON : profile?.StandardConfigJSON) || "";
    const configObj = parseJSONMaybe(configRaw) || {};

    const startTone = (profile?.StartTone || "neutral").trim().toLowerCase();

    const tts = {
      provider: String(provider).trim().toLowerCase(),
      voice: voice != null ? String(voice).trim() : null,
      model: model != null ? String(model).trim() : null,
      config: configObj,
    };

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
        pipecatStatus: resp.status,
        pipecatRawPreview: raw.slice(0, 400),
      });
    }

    return res.json({
      ok: true,
      receivedCaseId,
      parsedCaseId: caseId,
      sent,
      sessionId: data.sessionId,
      dailyRoom: data.dailyRoom,
      dailyToken: data.dailyToken,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
