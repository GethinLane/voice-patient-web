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

  function setOut(t) {
    if (out) out.textContent = t || "";
  }

  function isMeaningfulText(s) {
    return String(s || "").trim().length >= 20;
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

  async function poll({ intervalMs = 3000, maxTries = 80 } = {}) {
    if (!out) return;

    if (!sessionId) {
      setStatus("Missing sessionId");
      setOut("This page needs a URL like: /grading?sessionId=YOUR_SESSION_ID");
      return;
    }

    setStatus("Loading grading…");
    setOut("Grading in progress…");

    let readyEmptyCount = 0;

    for (let i = 1; i <= maxTries; i++) {
      try {
        const url = `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(sessionId)}`;
        const data = await fetchJson(url, { method: "GET", cache: "no-store", mode: "cors" });

        if (!data?.found) {
          setStatus("Waiting for attempt…");
          setOut("No attempt found yet… (waiting for transcript submission)");
        } else {
          const gradingText = String(data.gradingText || "");
          const ready = !!data.ready;

          // Mirrors your guard: ready=true but empty gradingText sometimes happens briefly
          if (ready && !isMeaningfulText(gradingText)) {
            readyEmptyCount += 1;
            setStatus("Finishing grading…");
            setOut("Grading finishing…");

            if (readyEmptyCount >= 2) {
              const urlForce =
                `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(sessionId)}&force=1`;
              const forced = await fetchJson(urlForce, { method: "GET", cache: "no-store", mode: "cors" });

              const forcedText = String(forced.gradingText || "");
              if (forced?.ready && isMeaningfulText(forcedText)) {
                setStatus("Grading ready");
                setOut(forcedText);
                return;
              }
            }
          } else if (ready && gradingText) {
            setStatus("Grading ready");
            setOut(gradingText);
            return;
          } else {
            setStatus(`Grading in progress… (${i}/${maxTries})`);
            setOut("Grading in progress…");
          }
        }
      } catch (e) {
        setStatus("Error fetching grading");
        setOut(`Error: ${e?.message || String(e)}`);
        // keep trying a few times; if it keeps failing, it will time out
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    setStatus("Timed out");
    setOut("Still grading… Please refresh this page in a moment.");
  }

  // Boot
  window.addEventListener("DOMContentLoaded", () => {
    poll({ intervalMs: 3000, maxTries: 80 });
  });
})();
