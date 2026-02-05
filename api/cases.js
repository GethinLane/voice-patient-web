// api/cases.js (DEBUG)
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  return res.json({
    ok: true,
    cases: [1, 2, 3, 4, 5, 81],
    debug: {
      ts: new Date().toISOString(),
      note: "If you can see this, CORS + routing is working.",
    },
  });
}
