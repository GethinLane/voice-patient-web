// voice-patient.js (Squarespace-compatible)
// Loaded from Squarespace via:
// <script defer src="https://voice-patient-web.vercel.app/voice-patient.js?v=..."></script>
(() => {
  const API_BASE = "https://voice-patient-web.vercel.app";
  console.log("[VOICE-PATIENT] loaded. API_BASE =", API_BASE);

  function $(id) { return document.getElementById(id); }

  function log(message) {
    console.log(message);
    const logEl = $("log");
    if (!logEl) return;
    logEl.value += message + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text) {
    const statusEl = $("status");
    if (statusEl) statusEl.textContent = text;
  }

  function setUiConnected(connected) {
    const startBtn = $("startBtn");
    const stopBtn  = $("stopBtn");
    if (startBtn) startBtn.disabled = connected;
    if (stopBtn)  stopBtn.disabled  = !connected;
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const text = await resp.text();

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Non-JSON response from ${url} (status ${resp.status}). First 120 chars: ${text.slice(0, 120)}`
      );
    }

    if (!resp.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${resp.status}`);
    }

    return data;
  }

  async function populateCaseDropdown() {
    const sel = $("caseSelect");
    if (!sel) {
      log("UI ERROR: caseSelect not found in HTML.");
      return;
    }

    sel.innerHTML = `<option>Loading cases…</option>`;

    try {
      const data = await fetchJson(`${API_BASE}/api/cases`, {
        method: "GET",
        cache: "no-store",
      });

      if (!data?.ok || !Array.isArray(data.cases)) {
        throw new Error("Invalid /api/cases response shape");
      }

      sel.innerHTML = "";
      for (const n of data.cases) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = `Case ${n}`;
        sel.appendChild(opt);
      }

      if (data.cases.length) sel.value = String(data.cases[data.cases.length - 1]);
      log(`[CASES] loaded ${data.cases.length} cases`);
    } catch (err) {
      sel.innerHTML = `<option>Error loading cases</option>`;
      log("[CASES] error: " + (err?.message || String(err)));
      setStatus("Failed to load cases (check console/log).");
    }
  }

  // Daily embed
  let callIframe = null;

  function mountDailyIframe(dailyRoom, dailyToken) {
    let container = $("call");
    if (!container) {
      const statusEl = $("status");
      container = document.createElement("div");
      container.id = "call";
      container.style.marginTop = "12px";
      if (statusEl?.parentNode) statusEl.parentNode.insertBefore(container, statusEl.nextSibling);
      else document.body.appendChild(container);
    }

    if (callIframe) {
      try { callIframe.remove(); } catch {}
      callIframe = null;
    }

    callIframe = document.createElement("iframe");
    callIframe.allow = "microphone; camera; autoplay; display-capture";
    callIframe.src = `${dailyRoom}?t=${encodeURIComponent(dailyToken)}`;

    callIframe.style.width = "100%";
    callIframe.style.height = "520px";
    callIframe.style.border = "0";
    callIframe.style.borderRadius = "12px";

    container.appendChild(callIframe);
  }

  function unmountDailyIframe() {
    if (callIframe) {
      try { callIframe.remove(); } catch {}
      callIframe = null;
    }
  }

  async function startConsultation() {
    try {
      setUiConnected(true);
      setStatus("Starting session…");

      const sel = $("caseSelect");
      const caseId = Number(sel?.value) || 1;

      log(`[START] requesting session for caseId=${caseId}`);

      const data = await fetchJson(`${API_BASE}/api/start-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      });

      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken in response");

      log(`[START] sessionId=${data.sessionId || "(none)"}`);
      log(`[START] dailyRoom=${data.dailyRoom}`);

      mountDailyIframe(data.dailyRoom, data.dailyToken);
      setStatus(`Connected (Case ${caseId}). Start talking!`);
    } catch (err) {
      log("[ERROR] " + (err?.message || String(err)));
      setStatus("Error: " + (err?.message || String(err)));
      setUiConnected(false);
      unmountDailyIframe();
    }
  }

  function stopConsultation() {
    log("Stopping consultation.");
    unmountDailyIframe();
    setUiConnected(false);
    setStatus("Stopped.");
  }

  window.addEventListener("DOMContentLoaded", () => {
    const startBtn = $("startBtn");
    const stopBtn  = $("stopBtn");

    if (!startBtn || !stopBtn) {
      log("UI ERROR: startBtn/stopBtn not found. Check element IDs in Squarespace HTML.");
      return;
    }

    startBtn.addEventListener("click", startConsultation);
    stopBtn.addEventListener("click", stopConsultation);

    setUiConnected(false);
    setStatus("Not connected");

    populateCaseDropdown();
  });
})();
