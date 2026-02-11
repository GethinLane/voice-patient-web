// api/_airtable.js
export async function airtableListAll({ apiKey, baseId, table, params = {} }) {
  const records = [];
  let offset = undefined;

  while (true) {
    const qs = new URLSearchParams({ pageSize: "100", ...params });
    if (offset) qs.set("offset", offset);

    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${qs.toString()}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Airtable list error ${resp.status}: ${text.slice(0, 400)}`);
    }

    const data = text ? JSON.parse(text) : {};
    records.push(...(data.records || []));
    offset = data.offset;
    if (!offset) break;
  }

  return records;
}

export async function airtableCreate({ apiKey, baseId, table, fields }) {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records: [{ fields }] }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Airtable create error ${resp.status}: ${text.slice(0, 400)}`);
  const data = text ? JSON.parse(text) : null;
  return data?.records?.[0];
}

export async function airtableUpdate({ apiKey, baseId, table, recordId, fields }) {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Airtable update error ${resp.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
/** NEW: fetch the first record matching an Airtable filterByFormula */
export async function airtableGetFirstByFormula({ apiKey, baseId, table, formula, params = {} }) {
  const records = await airtableListAll({
    apiKey,
    baseId,
    table,
    params: {
      maxRecords: "1",
      filterByFormula: formula,
      ...params,
    },
  });
  return records?.[0] || null;
}

/** NEW: get CaseProfiles row for a given CaseID */
export async function getCaseProfileByCaseId({ apiKey, baseId, caseId, table = "CaseProfiles" }) {
  const formula = `{CaseID}=${Number(caseId)}`;
  return await airtableGetFirstByFormula({ apiKey, baseId, table, formula });
}
