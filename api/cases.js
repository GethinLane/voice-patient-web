// api/cases.js
export default function handler(req, res) {
  res.json({ ok: true, cases: [1, 2, 3, 4, 5, 81] });
}
