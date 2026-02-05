// api/start-session.js (DEBUG)
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const receivedCaseId = req.body?.caseId;
    const caseId = Number(receivedCaseId);

    if (!caseId) {
      return res.status(400).json({ ok: false, error: "Missing/invalid caseId", receivedCaseId });
    }

    const agentName = process.env.PIPECAT_AGENT_NAME;
    const apiKey = process.env.PIPECAT_PUBLIC_API_KEY;
    if (!agentName) throw new Error("Missing PIPECAT_AGENT_NAME");
    if (!apiKey) throw new Error("Missing PIPECAT_PUBLIC_API_KEY");

    const sent = {
      transport: "webrtc",
      createDailyRoom: true,
      body: { caseId }, // <-- critical: this is what bot.py should read
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
