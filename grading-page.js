// grading-page.js
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";

  const qs = new URLSearchParams(window.location.search);
  const sessionId = (qs.get("sessionId") || "").trim();

  const out = document.getElementById("gradingOutput");
  const statusEl = document.getElementById("gradingStatus");

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t || "";
  }

  function isMeaningfulText(s) {
    return String(s || "").trim().length >= 20;
  }

  // Plain text output (safe fallback for loading/errors)
  function setOutPlain(t) {
    if (!out) return;
    out.textContent = t || "";
  }

  // Markdown -> HTML output (safe if DOMPurify is present; falls back to plain text)
  function setOutMarkdown(md) {
    if (!out) return;

    const raw = String(md || "");

    // If libs aren't loaded, render as plain text
    if (!window.marked || !window.DOMPurify) {
      setOutPlain(raw);
      return;
    }

    // Parse markdown to HTML
    const html = window.marked.parse(raw, {
      gfm: true,
      breaks: true, // single newlines become <br>
    });

    // Sanitize HTML to prevent XSS
    const clean = window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });

    out.innerHTML = clean;
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const text = await resp.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}

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

  async function poll({ intervalMs = 3000, maxTries = 80 } = {}) {
    if (!out) return;

    if (!sessionId) {
      setStatus("Missing sessionId");
      setOutPlain("This page needs a URL like: /grading?sessionId=YOUR_SESSION_ID");
      return;
    }

    setStatus("Loading grading…");
    setOutPlain("Grading in progress…");

    let readyEmptyCount = 0;

    for (let i = 1; i <= maxTries; i++) {
      try {
        const url = `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(sessionId)}`;
        const data = await fetchJson(url, { method: "GET", cache: "no-store", mode: "cors" });

        if (!data?.found) {
          setStatus("Waiting for attempt…");
          setOutPlain("No attempt found yet… (waiting for transcript submission)");
        } else {
          const gradingText = String(data.gradingText || "");
          const ready = !!data.ready;

          // Guard: ready=true but empty gradingText sometimes happens briefly
          if (ready && !isMeaningfulText(gradingText)) {
            readyEmptyCount += 1;
            setStatus("Finishing grading…");
            setOutPlain("Grading finishing…");

            // After 2 consecutive "ready but empty" results, force refresh once
            if (readyEmptyCount >= 2) {
              const urlForce =
                `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(sessionId)}&force=1`;
              const forced = await fetchJson(urlForce, { method: "GET", cache: "no-store", mode: "cors" });

              const forcedText = String(forced?.gradingText || "");
              if (forced?.ready && isMeaningfulText(forcedText)) {
                setStatus("Grading ready");
                setOutMarkdown(forcedText);
                return;
              }
            }
          } else if (ready && isMeaningfulText(gradingText)) {
            setStatus("Grading ready");
            setOutMarkdown(gradingText);
            return;
          } else {
            setStatus(`Grading in progress… (${i}/${maxTries})`);
            setOutPlain("Grading in progress…");
          }
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

  // Boot
  window.addEventListener("DOMContentLoaded", () => {
    poll({ intervalMs: 3000, maxTries: 80 });
  });
})();
