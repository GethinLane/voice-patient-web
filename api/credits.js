// /api/credits.js
// Backwards-compatible upgrade:
// - Keeps { creditsRemaining } exactly as before
// - Adds { mode, required, canStart } for gating Start button
// - Supports lookup by userId OR email
// - Expands CORS to .co.uk + .ai (www + non-www)

const isAllowedOrigin = (origin) => {
  if (!origin) return false;

  // Keep this explicit allowlist consistent with your other endpoints
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
  const normalized = String(rawValue).trim();
  if (!normalized) return fallback;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
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

    // Accept either userId or email
    const email = String(req.query.email || "").trim().toLowerCase();
    const userId = String(req.query.userId || "").trim();
    if (!email && !userId) return res.status(400).json({ error: "Missing ?email= or ?userId=" });

    // Mode is optional; defaults to standard (keeps old usage working)
    const mode = normalizeMode(req.query.mode);

    // Airtable config (align to your other endpoints)
    const baseId = requireEnv("AIRTABLE_USERS_BASE_ID");
    const apiKey = requireEnv("AIRTABLE_USERS_API_KEY");
    const table = requireEnv("USERS_AI_USERS_TABLE");
    const idField = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";
    const creditsField = process.env.AIRTABLE_USERS_CREDITS_FIELD || "CreditsRemaining";

    // Build filter
    // Prefer userId match when present; fall back to email.
    // (If you prefer OR when both provided, you can change this.)
    let filterByFormula = "";
    if (userId) {
      filterByFormula = `{${idField}}='${escapeFormulaString(userId)}'`;
    } else {
      filterByFormula = `LOWER({Email})='${escapeFormulaString(email)}'`;
    }

    // Only fetch the credits field (plus whatever Airtable needs)
    const url =
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}` +
      `?maxRecords=1&filterByFormula=${encodeURIComponent(filterByFormula)}` +
      `&fields%5B%5D=${encodeURIComponent(creditsField)}`;

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
    const rawCredits = record?.fields?.[creditsField];

    // Backwards-compatible output: always return creditsRemaining
    const creditsRemaining = Number(rawCredits ?? 0);
    const available = Number.isFinite(creditsRemaining) ? creditsRemaining : 0;

    // Compute required cost for this mode
    const standardCost = parseCreditCost(process.env.STANDARD_BOT_COST, 2);
    const premiumCost = parseCreditCost(process.env.PREMIUM_BOT_COST, 1);
    const required = mode === "premium" ? premiumCost : standardCost;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      creditsRemaining: available, // ✅ keep existing key
      mode,                        // ✅ new (optional)
      required,                    // ✅ new (optional)
      canStart: available >= required, // ✅ new (optional)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
