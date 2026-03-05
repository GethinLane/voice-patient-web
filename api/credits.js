// /api/credits.js
// Reads from Vercel KV (fast) with Airtable fallback (slow but safe)

const isAllowedOrigin = (origin) => {
  if (!origin) return false;
  const allowed = new Set([
    "https://www.scarevision.co.uk",
    "https://scarevision.co.uk",
    "https://www.scarevision.ai",
    "https://scarevision.ai",
  ]);
  return allowed.has(origin);
};

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapeFormulaString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeMode(value) {
  return String(value || "").trim().toLowerCase() === "premium" ? "premium" : "standard";
}

function parseCreditCost(rawValue, fallback) {
  if (rawValue == null) return fallback;
  const n = Number(String(rawValue).trim());
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

// Read from Vercel KV via REST API
async function getCreditsFromKV(userId) {
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (!kvUrl || !kvToken) return null;

    const key = `credits.${userId}`; // dot instead of colon avoids encoding issues
    const resp = await fetch(`${kvUrl}/get/${key}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.result == null) return null;
    return Number(data.result);
  } catch {
    return null;
  }
}

// Fallback: read from Airtable directly
async function getCreditsFromAirtable(userId, email) {
  const baseId = requireEnv("AIRTABLE_USERS_BASE_ID");
  const apiKey = requireEnv("AIRTABLE_USERS_API_KEY");
  const table = requireEnv("USERS_AI_USERS_TABLE");
  const idField = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";
  const creditsField = process.env.AIRTABLE_USERS_CREDITS_FIELD || "CreditsRemaining";

  let filterByFormula = userId
    ? `{${idField}}='${escapeFormulaString(userId)}'`
    : `LOWER({Email})='${escapeFormulaString(email)}'`;

  const url =
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}` +
    `?maxRecords=1&filterByFormula=${encodeURIComponent(filterByFormula)}` +
    `&fields%5B%5D=${encodeURIComponent(creditsField)}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!r.ok) throw new Error(`Airtable error: ${r.status}`);
  const data = await r.json();
  const record = data?.records?.[0];
  return Number(record?.fields?.[creditsField] ?? 0);
}

export default async function handler(req, res) {
  applyCors(req, res);
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

    const email = String(req.query.email || "").trim().toLowerCase();
    const userId = String(req.query.userId || "").trim();
    if (!email && !userId) return res.status(400).json({ error: "Missing ?email= or ?userId=" });

    const mode = normalizeMode(req.query.mode);
    const standardCost = parseCreditCost(process.env.STANDARD_BOT_COST, 2);
    const premiumCost = parseCreditCost(process.env.PREMIUM_BOT_COST, 1);
    const required = mode === "premium" ? premiumCost : standardCost;

    // Try KV first (fast ~10ms)
    let available = null;
    if (userId) {
      available = await getCreditsFromKV(userId);
    }

    // If KV miss, fall back to Airtable and write result back to KV
    if (available === null) {
      console.log("[credits] KV miss — falling back to Airtable");
      available = await getCreditsFromAirtable(userId, email);

      // Write to KV so next request is fast
      if (userId) {
        try {
          const kvUrl = process.env.KV_REST_API_URL;
          const kvToken = process.env.KV_REST_API_TOKEN;
          if (kvUrl && kvToken) {
await fetch(`${kvUrl}/set/credits.${userId}/${available}`, {
  method: "GET",
  headers: { Authorization: `Bearer ${kvToken}` },
});
          }
        } catch {}
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      creditsRemaining: available,
      mode,
      required,
      canStart: available >= required,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
