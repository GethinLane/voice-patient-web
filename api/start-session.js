// api/start-session.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  try {
    const caseId = Number(req.body?.caseId);
    if (!caseId) {
      res.status(400).json({ ok: false, error: "Missing/invalid caseId" });
      return;
    }

    const agentName = process.env.PIPECAT_AGENT_NAME;
    const apiKey = process.env.PIPECAT_PUBLIC_API_KEY;

    if (!agentName) throw new Error("Missing env PIPECAT_AGENT_NAME");
    if (!apiKey) throw new Error("Missing env PIPECAT_PUBLIC_API_KEY");

    const url = `https://api.pipecat.daily.co/v1/public/${encodeURIComponent(agentName)}/start`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        createDailyRoom: true,
        transport: "webrtc",
        // This is what your bot should read via runner_args.body
        body: { caseId },
      }),
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

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
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
