export default async function handler(req, res) {
  // 🔐 CORS — MUST MATCH YOUR SQUARESPACE DOMAIN
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  try {
    const caseId = Number(req.body?.caseId);
    if (!caseId) {
      res.status(400).json({ ok: false, error: "Missing or invalid caseId" });
      return;
    }

    const agentName = process.env.PIPECAT_AGENT_NAME;
    const apiKey = process.env.PIPECAT_PUBLIC_API_KEY;

    if (!agentName) throw new Error("Missing PIPECAT_AGENT_NAME");
    if (!apiKey) throw new Error("Missing PIPECAT_PUBLIC_API_KEY");

    const url = `https://api.pipecat.daily.co/v1/public/${encodeURIComponent(agentName)}/start`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transport: "webrtc",
        createDailyRoom: true,
        body: { caseId }, // 👈 this feeds runner_args.body in bot.py
      }),
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch {}

    if (!resp.ok) {
      res.status(resp.status).json({
        ok: false,
        error: (data && (data.error || data.message)) || text.slice(0, 400),
      });
      return;
    }

    res.json({
      ok: true,
      sessionId: data.sessionId,
      dailyRoom: data.dailyRoom,
      dailyToken: data.dailyToken,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
