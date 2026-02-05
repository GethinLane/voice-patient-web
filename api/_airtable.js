// api/_airtable.js

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function casesCfg() {
  // your existing key/base used to READ case marking scheme later
  return {
    apiKey: mustEnv("AIRTABLE_API_KEY"),
    baseId: mustEnv("AIRTABLE_BASE_ID"),
  };
}

export function usersCfg() {
  // new key/base used to WRITE attempts now
  return {
    apiKey: mustEnv("USERS_AIRTABLE_API_KEY"),
    baseId: mustEnv("USERS_AI_BASE_ID"),
    usersTable: process.env.USERS_AI_USERS_TABLE || "Users",
    attemptsTable: process.env.USERS_AI_ATTEMPTS_TABLE || "Attempts",
  };
}

export function tableUrl(baseId, tableName) {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
}

export function escFormula(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function airtableFetchJson(url, apiKey, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!resp.ok) {
    throw new Error(
      (data && (data.error?.message || data.message)) ||
      `Airtable HTTP ${resp.status}: ${text.slice(0, 300)}`
    );
  }
  return data;
}
