// voice-patient.js (Vercel version)
(() => {
  function $(id) { return document.getElementById(id); }
  function log(message) {
    console.log(message);
    const logEl = $("log");
    if (!logEl) return;
    logEl.value += message + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(text) { const el = $("status"); if (el) el.textContent = text; }
  function setUiConnected(connected) {
    $("startBtn").disabled = connected;
    $("stopBtn").disabled = !connected;
  }

  let callIframe = null;

  async function populateCaseDropdown() {
    const sel = $("caseSelect");
    sel.innerHTML = `<option>Loading cases…</option>`;
    try {
      const resp = await fetch(`/api/cases`, { cache: "no-store" });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "Failed to load cases");

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
    }
  }

  async function startConsultation() {
    try {
      setUiConnected(true);
      setStatus("Starting session…");

      const caseId = Number($("caseSelect")?.value) || 1;

      const resp = await fetch(`/api/start-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      });

      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "Failed to start session");

      log(`[START] sessionId=${data.sessionId}`);
      log(`[START] room=${data.dailyRoom}`);

      // Embed Daily room (token in query)
      const container = $("call");
      if (!container) throw new Error("Missing <div id='call'></div> in HTML");

      if (callIframe) callIframe.remove();
      callIframe = document.createElement("iframe");

      callIframe.src = `${data.dailyRoom}?t=${encodeURIComponent(data.dailyToken)}`;
      callIframe.allow = "microphone; camera; autoplay; display-capture";
      callIframe.style.width = "100%";
      callIframe.style.height = "520px";
      callIframe.style.border = "0";
      callIframe.style.borderRadius = "12px";

      container.appendChild(callIframe);

      setStatus(`Connected (Case ${caseId}). Start talking!`);
    } catch (err) {
      log("[ERROR] " + (err?.message || String(err)));
      setStatus("Error: " + (err?.message || String(err)));
      setUiConnected(false);
    }
  }

  function stopConsultation() {
    log("Stopping consultation.");
    if (callIframe) {
      callIframe.remove();
      callIframe = null;
    }
    setUiConnected(false);
    setStatus("Stopped.");
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("startBtn").addEventListener("click", startConsultation);
    $("stopBtn").addEventListener("click", stopConsultation);
    populateCaseDropdown();
    setUiConnected(false);
    setStatus("Not connected");
  });
})();
