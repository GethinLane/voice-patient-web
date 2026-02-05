export default function handler(req, res) {
  // 🔐 CORS — CHANGE THIS to your real Squarespace domain
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "GET only" });
    return;
  }

  // Simple static list for now
  res.json({
    ok: true,
    cases: [1, 2, 3, 4, 5, 81],
  });
}
