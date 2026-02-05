// voice-patient.js (ULTRA DEBUG - always injects UI)
(() => {
  const VERSION = "ultra-debug-2026-02-05-1";
  const API_BASE = "https://voice-patient-web.vercel.app";
  const ORIGIN = "https://www.scarevision.co.uk";

  let currentSessionId = null;
  let gradingPollTimer = null;

  function $(id) { return document.getElementById(id); }

  // ---------- Always-visible debug + grading UI ----------
  function ensureUiRoot() {
    let root = document.getElementById("vp-root");
    if (root) return root;

    root = document.createElement("div");
    root.id = "vp-root";
    root.style.border = "2px solid #333";
    root.style.borderRadius = "12px";
    root.style.padding = "12px";
    root.style.margin = "12px 0";
    root.style.background = "#fff";
    root.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";
    root.style.fontSize = "14px";

    // insert at top of body (guaranteed visible)
    document.body.insertBefore(root, document.body.firstChild);

    const title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = `Voice Patient Debug Panel (${VERSION})`;
    root.appendChild(title);

    const meta = document.createElement("div");
    meta.id = "vp-meta";
    meta.style.marginTop = "6px";
    meta.style.opacity = "0.9";
    root.appendChild(meta);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.marginTop = "10px";

    const btnFetch = document.createElement("button");
    btnFetch.textContent = "Fetch grading now";
    btnFetch.onclick = () => pollGradingOnce(true);
    btnRow.appendChild(btnFetch);

    const btnClear = document.createElement("button");
    btnClear.textContent = "Clear debug";
    btnClear.onclick = () => {
      const pre = document.getElementById("vp-debug");
      if (pre) pre.textContent = "";
    };
    btnRow.appendChild(btnClear);

    root.appendChild(btnRow);

    const debug = document.createElement("pre");
    debug.id = "vp-debug";
    debug.style.whiteSpace = "pre-wrap";
    debug.style.marginTop = "10px";
    debug.style.padding = "10px";
    debug.style.border = "1px solid #ddd";
    debug.style.borderRadius = "10px";
    debug.style.maxHeight = "240px";
    debug.style.overflow = "auto";
    debug.style.background = "#fafafa";
    root.appendChild(debug);

    const grading = document.createElement("pre");
    grading.id = "gradingOutput";
    grading.style.whiteSpace = "pre-wrap";
    grading.style.marginTop = "10px";
    grading.style.padding = "10px";
    grading.style.border = "1px solid #0a0";
    grading.style.borderRadius = "10px";
    grading.style.background = "#f6fff6";
    grading.textContent = "Grading will appear here after you stop the consultation.";
    root.appendChild(grading);

    updateMeta();
    return root;
  }

  function updateMeta(extra = {}) {
    const meta = document.getElementById("vp-meta");
    if (!meta) return;
    meta.textContent =
      `origin=${window.location.origin} | api=${API_BASE} | sessionId=${currentSessionId || "(none)"}` +
      (extra.note ? ` | ${extra.note}` : "");
  }

  function log(message, obj) {
    ensureUiRoot();
    const line =
      `[VP ${VERSION}] ${new Date().toISOString()}  ${message}` +
      (obj ? `\n${JSON.stringify(obj, null, 2)}` : "");
    console.log(line);
    const pre = document.getElementById("vp-debug");
    if (pre) {
      pre.textContent += line + "\n";
      pre.scrollTop = pre.scrollHeight;
    }
  }

  function setStatus(text) {
    // still update your existing status element if present
    const el = $("status");
    if (el) el.textContent = text;
    log(`[STATUS] ${text}`);
    updateMeta({ note: text });
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

    const resp = await fetch(url, options);
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

  // ---------- Daily iframe ----------
  let callIframe = null;

  function mountDailyIframe(dailyRoom, dailyToken) {
    let container = $("call");
    if (!container) {
      container = document.createElement("div");
      container.id = "call";
      container.style.marginTop = "12px";
      document.body.appendChild(container);
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
    try { callIframe.src = "about:blank"; } catch {}
    try { callIframe.remove(); } catch {}
    callIframe = null;
  }
}


  // ---------- Cases ----------
  async function populateCaseDropdown() {
    const sel = $("caseSelect");
    if (!sel) {
      log("UI ERROR: caseSelect not found");
      setStatus("caseSelect not found in page HTML");
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

      if (!data?.ok || !Array.isArray(data.cases)) throw new Error("Invalid /api/cases response");

      sel.innerHTML = "";
      for (const n of data.cases) {
        const opt = document.createElement("option");
        opt.value = String(n);
        opt.textContent = `Case ${n}`;
        sel.appendChild(opt);
      }

      if (data.cases.length) sel.value = String(data.cases[data.cases.length - 1]);
      log("[CASES] loaded", { count: data.cases.length, selected: sel.value });
      setStatus("Cases loaded. Choose a case then Start.");
    } catch (e) {
      log("[CASES] error", { error: e?.message || String(e) });
      setStatus("Failed to load cases (see debug panel).");
      sel.innerHTML = `<option>Error loading cases</option>`;
    }
  }

  // ---------- Grading poll ----------
  async function pollGradingOnce(manual = false) {
    ensureUiRoot();
    const out = document.getElementById("gradingOutput");

    if (!currentSessionId) {
      out.textContent = "No sessionId yet — start a consultation first.";
      log("[GRADING] no currentSessionId");
      return;
    }

    try {
      const data = await fetchJsonDebug(
        `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(currentSessionId)}`,
        { method: "GET", cache: "no-store", mode: "cors" }
      );

      log("[GRADING] get-grading response", data);

      if (data?.status === "ready") {
        out.textContent = data.gradingText || "(gradingText empty)";
        setStatus("Grading ready.");
        stopGradingPoll();
      } else if (data?.status === "pending") {
        out.textContent = "Waiting for grading… (still processing)";
        if (manual) setStatus("Grading pending…");
      } else if (data?.status === "error") {
        out.textContent = "Grading error:\n" + (data.error || "Unknown error");
        if (manual) setStatus("Grading error.");
        stopGradingPoll();
      } else {
        out.textContent = "No grading found yet (store empty / cold start).";
        if (manual) setStatus("No grading found yet.");
      }
    } catch (e) {
      out.textContent = "Error fetching grading (see debug panel).";
      log("[GRADING] fetch error", { error: e?.message || String(e) });
      if (manual) setStatus("Error fetching grading.");
    }
  }

  function startGradingPoll() {
    stopGradingPoll();
    log("[GRADING] start polling", { sessionId: currentSessionId });
    const out = document.getElementById("gradingOutput");
    out.textContent = "Waiting for grading… (polling every 2s)";
    gradingPollTimer = setInterval(() => pollGradingOnce(false), 2000);
    pollGradingOnce(false);
  }

  function stopGradingPoll() {
    if (gradingPollTimer) {
      clearInterval(gradingPollTimer);
      gradingPollTimer = null;
      log("[GRADING] stop polling");
    }
  }

  // ---------- Start/Stop ----------
  async function startConsultation() {
    ensureUiRoot();
    stopGradingPoll();
    document.getElementById("gradingOutput").textContent =
      "Grading will appear here after you stop the consultation.";
    currentSessionId = null;
    updateMeta();

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

      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken");

      currentSessionId = data.sessionId || null;
      updateMeta();
      log("[START] started", { currentSessionId });

      mountDailyIframe(data.dailyRoom, data.dailyToken);
      setStatus(`Connected (Case ${caseId}). Talk, then press Stop.`);
    } catch (e) {
      log("[START] error", { error: e?.message || String(e) });
      setStatus("Error starting (see debug panel).");
      setUiConnected(false);
      unmountDailyIframe();
    }
  }

  function stopConsultation() {
    ensureUiRoot();
    log("[STOP] clicked", { currentSessionId });
    unmountDailyIframe();
    setUiConnected(false);
    setStatus("Stopped. Waiting for grading…");

    if (currentSessionId) startGradingPoll();
    else document.getElementById("gradingOutput").textContent = "No sessionId available; cannot fetch grading.";
  }

  // ---------- Boot ----------
  window.addEventListener("DOMContentLoaded", () => {
    ensureUiRoot();
    log("[BOOT] DOMContentLoaded", {
      href: window.location.href,
      origin: window.location.origin,
      apiBase: API_BASE,
      expectedOrigin: ORIGIN,
      hasCaseSelect: !!$("caseSelect"),
      hasStartBtn: !!$("startBtn"),
      hasStopBtn: !!$("stopBtn"),
      hasStatus: !!$("status"),
    });

    const startBtn = $("startBtn");
    const stopBtn  = $("stopBtn");
    if (startBtn) startBtn.addEventListener("click", startConsultation);
    if (stopBtn) stopBtn.addEventListener("click", stopConsultation);

    setUiConnected(false);
    setStatus("Not connected");
    populateCaseDropdown();
  });
})();
