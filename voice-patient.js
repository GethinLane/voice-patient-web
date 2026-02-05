// voice-patient.js (DEBUG - Squarespace compatible)
(() => {
  const VERSION = "debug-2026-02-05-1";
  const API_BASE = "https://voice-patient-web.vercel.app";

  function $(id) { return document.getElementById(id); }

  // Fallback debug panel (in case textarea isn't present / visible)
  function ensureDebugPanel() {
    let panel = document.getElementById("vp-debug");
    if (panel) return panel;

    panel = document.createElement("pre");
    panel.id = "vp-debug";
    panel.style.whiteSpace = "pre-wrap";
    panel.style.padding = "10px";
    panel.style.border = "1px solid #ddd";
    panel.style.borderRadius = "10px";
    panel.style.marginTop = "12px";
    panel.style.fontSize = "12px";
    panel.style.maxHeight = "280px";
    panel.style.overflow = "auto";
    panel.style.background = "#fafafa";

    const anchor = $("status") || document.body;
    anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    return panel;
  }

  function log(message, obj) {
    const line =
      `[VP ${VERSION}] ${new Date().toISOString()}  ${message}` +
      (obj ? `\n${JSON.stringify(obj, null, 2)}` : "");

    console.log(line);

    const ta = $("log");
    if (ta) {
      ta.value += line + "\n";
      ta.scrollTop = ta.scrollHeight;
    } else {
      const panel = ensureDebugPanel();
      panel.textContent += line + "\n";
      panel.scrollTop = panel.scrollHeight;
    }
  }

  function setStatus(text) {
    const el = $("status");
    if (el) el.textContent = text;
    log(`[STATUS] ${text}`);
  }

  function setUiConnected(connected) {
    const startBtn = $("startBtn");
    const stopBtn  = $("stopBtn");
    if (startBtn) startBtn.disabled = connected;
    if (stopBtn)  stopBtn.disabled  = !connected;
    log(`[UI] connected=${connected}`);
  }

  async function fetchJsonDebug(url, options) {
    log(`[FETCH] ${options?.method || "GET"} ${url}`, options);

    let resp;
    try {
      resp = await fetch(url, options);
    } catch (e) {
      log(`[FETCH ERROR] network error calling ${url}: ${e?.message || String(e)}`);
      throw e;
    }

    const ct = resp.headers.get("content-type");
    const status = resp.status;
    const text = await resp.text();

    log(`[FETCH RESP] ${status} ${url}`, {
      contentType: ct,
      bodyPreview: text.slice(0, 300),
    });

    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch {
      throw new Error(`Non-JSON from ${url} status=${status} ct=${ct} body=${text.slice(0, 120)}`);
    }

    if (!resp.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${status}`);
    }

    return data;
  }

  // --- Cases dropdown ---
  async function populateCaseDropdown() {
    const sel = $("caseSelect");
    if (!sel) {
      log("UI ERROR: caseSelect not found");
      return;
    }

    sel.innerHTML = `<option>Loading cases…</option>`;
    setStatus("Loading cases…");

    try {
      const data = await fetchJsonDebug(`${API_BASE}/api/cases`, {
        method: "GET",
        cache: "no-store",
        mode: "cors",
      });

      log("[CASES] response", data);

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

      // log selection changes
      sel.addEventListener("change", () => {
        log("[UI] caseSelect changed", { value: sel.value });
      });

      if (data.cases.length) sel.value = String(data.cases[data.cases.length - 1]);
      log("[CASES] loaded", { count: data.cases.length, selected: sel.value });

      setStatus("Cases loaded. Choose a case then Start.");
    } catch (e) {
      log("[CASES] error", { error: e?.message || String(e) });
      setStatus("Failed to load cases (see log).");
      const sel2 = $("caseSelect");
      if (sel2) sel2.innerHTML = `<option>Error loading cases</option>`;
    }
  }

  // --- Daily embed ---
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

    const url = `${dailyRoom}?t=${encodeURIComponent(dailyToken)}`;
    log("[DAILY] mounting iframe", { url });

    callIframe = document.createElement("iframe");
    callIframe.allow = "microphone; camera; autoplay; display-capture";
    callIframe.src = url;
    callIframe.style.width = "100%";
    callIframe.style.height = "520px";
    callIframe.style.border = "0";
    callIframe.style.borderRadius = "12px";

    callIframe.onload = () => log("[DAILY] iframe loaded");
    container.appendChild(callIframe);
  }

  function unmountDailyIframe() {
    log("[DAILY] unmount iframe");
    if (callIframe) {
      try { callIframe.remove(); } catch {}
      callIframe = null;
    }
  }

  // --- Start/Stop ---
  async function startConsultation() {
    log("[CLICK] startConsultation called");

    try {
      setUiConnected(true);
      setStatus("Starting session…");

      const sel = $("caseSelect");
      const raw = sel ? sel.value : null;
      const caseId = Number(raw) || 1;

      log("[START] selected case", { rawValue: raw, parsedCaseId: caseId });

      const data = await fetchJsonDebug(`${API_BASE}/api/start-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
        mode: "cors",
      });

      log("[START] /api/start-session response", data);

      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken in response");

      mountDailyIframe(data.dailyRoom, data.dailyToken);
      setStatus(`Connected (Case ${caseId}). Start talking!`);
    } catch (e) {
      log("[START] error", { error: e?.message || String(e) });
      setStatus("Error starting (see log).");
      setUiConnected(false);
      unmountDailyIframe();
    }
  }

  function stopConsultation() {
    log("[CLICK] stopConsultation called");
    unmountDailyIframe();
    setUiConnected(false);
    setStatus("Stopped.");
  }

  // --- Boot ---
  window.addEventListener("DOMContentLoaded", () => {
    log("[BOOT] DOMContentLoaded", {
      location: window.location.href,
      scriptVersion: VERSION,
      apiBase: API_BASE,
      hasCaseSelect: !!$("caseSelect"),
      hasStartBtn: !!$("startBtn"),
      hasStopBtn: !!$("stopBtn"),
    });

    const startBtn = $("startBtn");
    const stopBtn  = $("stopBtn");

    if (!startBtn || !stopBtn) {
      log("UI ERROR: startBtn/stopBtn not found (check IDs)");
      return;
    }

    startBtn.addEventListener("click", startConsultation);
    stopBtn.addEventListener("click", stopConsultation);

    setUiConnected(false);
    setStatus("Not connected");

    populateCaseDropdown();
  });
})();
