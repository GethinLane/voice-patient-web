// /api/_completedCases.js
export async function markCaseCompleted({ userId, caseId }) {
  const API_KEY = process.env.AIRTABLE_USERS_API_KEY;
  const BASE_ID = process.env.AIRTABLE_USERS_BASE_ID;
  const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
  const USER_ID_FIELD = process.env.AIRTABLE_USERS_ID_FIELD || "UserID";
  const COMPLETED_FIELD = "CompletedCases";

  if (!API_KEY || !BASE_ID) throw new Error("Missing Users base env vars");

  const findUser = async () => {
    const filterByFormula = `{${USER_ID_FIELD}}='${String(userId).replace(/'/g, "\\'")}'`;
    const url =
      `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(USERS_TABLE)}` +
      `?maxRecords=1&filterByFormula=${encodeURIComponent(filterByFormula)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!r.ok) throw new Error(`Airtable Users lookup failed (${r.status})`);
    const data = await r.json();
    return data?.records?.[0] || null;
  };

  const writeUser = async (recordId, completedSet) => {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(USERS_TABLE)}/${recordId}`;
    const payload = {
      fields: {
        [COMPLETED_FIELD]: JSON.stringify(Array.from(completedSet)),
      },
    };

    const r = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Airtable Users update failed (${r.status}): ${t}`);
    }
    return r.json();
  };

  const parseSet = (raw) => {
    try {
      if (Array.isArray(raw)) return new Set(raw.map(String));
      if (typeof raw === "string" && raw.trim()) return new Set(JSON.parse(raw).map(String));
    } catch {}
    return new Set();
  };

  // attempt 1
  const user = await findUser();
  if (!user) throw new Error("User not found");

  const set1 = parseSet(user.fields?.[COMPLETED_FIELD]);
  set1.add(String(caseId));

  try {
    await writeUser(user.id, set1);
    return { ok: true, completed: Array.from(set1) };
  } catch {
    // retry once with fresh read (race-safe enough for Airtable)
    const fresh = await findUser();
    if (!fresh) throw new Error("User not found (retry)");
    const set2 = parseSet(fresh.fields?.[COMPLETED_FIELD]);
    set2.add(String(caseId));
    await writeUser(fresh.id, set2);
    return { ok: true, completed: Array.from(set2), retried: true };
  }
}
