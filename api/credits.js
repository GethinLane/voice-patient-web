// /api/credits.js

const isAllowedOrigin = (origin) => {
  if (!origin) return false;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:") return false;

    // allow root + www + any subdomain of scarevision.ai
    return (
      hostname === "scarevision.ai" ||
      hostname === "www.scarevision.ai" ||
      hostname.endsWith(".scarevision.ai")
    );
  } catch {
    return false;
  }
};

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapeFormulaString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export default async function handler(req, res) {
  // ✅ CORS headers must be set on *every* response path
  applyCors(req, res);

  // ✅ Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET,OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }

    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "Missing ?email=" });

    const baseId = requireEnv("AIRTABLE_USERS_BASE_ID");
    const apiKey = requireEnv("AIRTABLE_USERS_API_KEY");
    const table = requireEnv("USERS_AI_USERS_TABLE");

    const filterByFormula = `{Email}='${escapeFormulaString(email)}'`;

    const url =
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}` +
      `?maxRecords=1&filterByFormula=${encodeURIComponent(filterByFormula)}` +
      `&fields%5B%5D=CreditsRemaining`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!r.ok) {
      const details = await r.text();
      return res.status(502).json({
        error: "Airtable request failed",
        status: r.status,
        details,
      });
    }

    const data = await r.json();
    const record = data?.records?.[0];
    const creditsRemaining = record?.fields?.CreditsRemaining ?? null;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ creditsRemaining });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
