// grading-page.js
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";

  const qs = new URLSearchParams(window.location.search);
  const sessionId = (qs.get("sessionId") || "").trim();

  const out = document.getElementById("gradingOutput");
  const statusEl = document.getElementById("gradingStatus");
  const modeBadge = document.getElementById("modeBadge");
  const caseBadge = document.getElementById("caseBadge");

  // Expose state for the PDF button script (browser-side)
  window.__gradingReady = false;
  window.__gradingText = "";

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t || "";
  }

  function isMeaningfulText(s) {
    return String(s || "").trim().length >= 20;
  }

  function setOutPlain(t) {
    if (!out) return;
    out.textContent = t || "";
  }

function setMeta({ mode, caseId } = {}) {
  const m = String(mode || "").toLowerCase() === "premium" ? "premium" : "standard";

  if (modeBadge) {
    modeBadge.textContent = m === "premium" ? "Premium attempt" : "Standard attempt";
    modeBadge.classList.toggle("is-premium", m === "premium");
  }

  if (caseBadge) {
    const n = Number(caseId);
    caseBadge.textContent = Number.isFinite(n) && n > 0 ? `Case ${n}` : "Case";
  }
}

// Wrap the premium section (first H2 that starts with "Premium") into a styled card
function decoratePremiumCard() {
  if (!out) return;

  const h2s = Array.from(out.querySelectorAll("h2"));
  const h = h2s.find((el) => /^premium\b/i.test(String(el.textContent || "").trim()));
  if (!h) return;

  const titleText = String(h.textContent || "").trim();

  const card = document.createElement("div");
  card.className = "premium-card";

  const title = document.createElement("div");
  title.className = "premium-card-title";
  title.innerHTML = `<i class="fa-solid fa-star"></i><span>${titleText}</span>`;
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "premium-card-body";

  // Move everything AFTER the premium H2 into the card body
  let node = h.nextSibling;
  while (node) {
    const next = node.nextSibling;
    body.appendChild(node);
    node = next;
  }

  card.appendChild(body);

  // Replace the H2 with the card
  h.replaceWith(card);
}
  
  function setOutMarkdown(md) {
    if (!out) return;

    const raw = String(md || "");

    if (!window.marked || !window.DOMPurify) {
      setOutPlain(raw);
      return;
    }

    const html = window.marked.parse(raw, { gfm: true, breaks: true });
    const clean = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    out.innerHTML = clean;
    decoratePremiumCard();
  }

  function publishGrading(text) {
    // This is the key: makes the PDF button instant (no extra fetch)
    window.__gradingText = String(text || "");
    window.__gradingReady = isMeaningfulText(window.__gradingText);
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const text = await resp.text();

    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!resp.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;
      err.url = url;
      throw err;
    }
    return data;
  }

  async function poll({ intervalMs = 1500, maxTries = 120 } = {}) {
    if (!out) return;

    if (!sessionId) {
      setStatus("Missing sessionId");
      setOutPlain("This page needs a URL like: /grading?sessionId=YOUR_SESSION_ID");
      return;
    }

    setStatus("Loading grading…");
    setOutPlain("Grading in progress…");

    for (let i = 1; i <= maxTries; i++) {
      try {
        // IMPORTANT: do NOT use force=1 here; in your backend that can trigger a regrade.
        const url = `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(sessionId)}`;
        const data = await fetchJson(url, { method: "GET", cache: "no-store", mode: "cors" });

        if (!data?.found) {
          setStatus("Waiting for attempt…");
          setOutPlain("No attempt found yet… (waiting for transcript submission)");
        } else {
          const gradingText = String(data.gradingText || "");
          const ready = !!data.ready;
          setMeta({ mode: data.modeUsed, caseId: data.caseId });

          if (ready && isMeaningfulText(gradingText)) {
            setStatus("Grading ready");
            setOutMarkdown(gradingText);
            publishGrading(gradingText);
            return;
          }

          // Not ready yet
          setStatus(`Grading in progress… (${i}/${maxTries})`);
          setOutPlain("Grading in progress…");
          publishGrading(""); // keeps __gradingReady false
        }
      } catch (e) {
        setStatus("Error fetching grading");
        setOutPlain(`Error: ${e?.message || String(e)}`);
        // keep trying; if it keeps failing, it will time out
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    setStatus("Timed out");
    setOutPlain("Still grading… Please refresh this page in a moment.");
  }

  window.addEventListener("DOMContentLoaded", () => {
    poll({ intervalMs: 1500, maxTries: 120 });
  });
})();
