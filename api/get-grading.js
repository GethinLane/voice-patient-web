// api/get-grading.js
import { getStore } from "./_gradingStore.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.scarevision.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });

  const sessionId = String(req.query?.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  const store = getStore();
  const item = store.get(sessionId);

  if (!item) return res.json({ ok: true, found: false });
  return res.json({ ok: true, found: true, ...item });
}
