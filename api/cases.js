// api/cases.js (DEBUG)
export default function handler(req, res) {
  // Allow both domains (and vary so caches don't mix responses)
  const origin = req.headers.origin;
  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  // Cases 1..355
  const cases = Array.from({ length: 355 }, (_, i) => i + 1);

  return res.json({
    ok: true,
    cases,
    debug: {
      ts: new Date().toISOString(),
      note: "If you can see this, CORS + routing is working.",
      originReceived: origin || null,
    },
  });
}
