// voice-patient.js (DEBUG - finite grading poll + injected UI) + MemberSpace identity passthrough
(() => {
  const VERSION = "debug-2026-02-05-finite-poll-1+ms-identity";
  const API_BASE = "https://voice-patient-web.vercel.app";
  const ALLOWED_ORIGINS = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
    // optional (non-www variants):
    "https://scarevision.co.uk",
    "https://scarevision.ai",
  ]);

  let currentSessionId = null;
  let gradingPollTimer = null;
  let gradingPollTries = 0;

  const GRADING_POLL_INTERVAL_MS = 6000; // every 6s
  const GRADING_POLL_MAX_TRIES = 20;     // 20 * 6s = 120s (2 minutes)

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

    const btnStopPoll = document.createElement("button");
    btnStopPoll.textContent = "Stop polling";
    btnStopPoll.onclick = () => stopGradingPoll("manual stop");
    btnRow.appendChild(btnStopPoll);

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
    debug.style.maxHeight = "220px";
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

    const { userId, email } = getIdentity();

    meta.textContent =
      `origin=${window.location.origin} | api=${API_BASE} | sessionId=${currentSessionId || "(none)"}` +
      ` | tries=${gradingPollTries}/${GRADING_POLL_MAX_TRIES}` +
      ` | userId=${userId || "(none)"} | email=${email || "(none)"}` +
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
    const el = $("status");
    if (el) el.textContent = text;
    updateMeta({ note: text });
  }

  function setUiConnected(connected) {
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    if (startBtn) startBtn.disabled = connected;
    if (stopBtn) stopBtn.disabled = !connected;
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const text = await resp.text();

    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch {
      throw new Error(`Non-JSON from ${url} status=${resp.status} body=${text.slice(0, 120)}`);
    }
    if (!resp.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${resp.status}`);
    }
    return data;
  }

  // ---------- MemberSpace identity (robust) ----------
  let msMember = null;

  function setMsMember(mi, source = "unknown") {
    if (!mi) return;
    const id = mi?.id != null ? String(mi.id).trim() : "";
    const email = mi?.email ? String(mi.email).trim().toLowerCase() : "";
    if (!id && !email) return;

    msMember = { ...mi, id, email };
    // Optional: share with other scripts (e.g. your Stripe email-lock script)
    window.__msMemberInfo = msMember;

    log("[MEMBERSPACE] identity set", { source, id, email });
    updateMeta();
  }

  function tryHydrateFromMemberSpaceGetter() {
    try {
      const MS = window.MemberSpace;
      if (!MS || typeof MS.getMemberInfo !== "function") return false;

      const data = MS.getMemberInfo(); // { isLoggedIn: true, memberInfo: {...} } or { isLoggedIn:false }
      if (data?.isLoggedIn && data?.memberInfo) {
        setMsMember(data.memberInfo, "MemberSpace.getMemberInfo");
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Event: MemberSpace.member.info
  document.addEventListener("MemberSpace.member.info", (e) => {
    // Docs: event.detail contains MemberInfo (often wrapped as { memberInfo })
    const detail = e.detail || null;
    const mi = detail?.memberInfo || detail;
    setMsMember(mi, "MemberSpace.member.info");
  });

  // Event: MemberSpace.ready (good time to call getter)
  document.addEventListener("MemberSpace.ready", () => {
    tryHydrateFromMemberSpaceGetter();
  });

  // If another script already captured it (like your Stripe lock code), use it
  if (window.__msMemberInfo) setMsMember(window.__msMemberInfo, "window.__msMemberInfo");

  // Try once immediately (may still be too early; that's fine)
  tryHydrateFromMemberSpaceGetter();

  function getIdentity() {
    const mi = msMember || window.__msMemberInfo || null;
    const userId = mi?.id != null ? String(mi.id).trim() : "";
    const email = mi?.email ? String(mi.email).trim().toLowerCase() : "";
    return { userId, email };
  }

  async function ensureIdentity({ timeoutMs = 2500, intervalMs = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { userId, email } = getIdentity();
      if (userId || email) return { userId, email };

      // try the getter in case we missed the event
      tryHydrateFromMemberSpaceGetter();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return getIdentity();
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
    if (callIframe) {
      try { callIframe.src = "about:blank"; } catch {}
      try { callIframe.remove(); } catch {}
      callIframe = null;
    }
    log("[DAILY] iframe unmounted");
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
      const data = await fetchJson(`${API_BASE}/api/cases`, {
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

  // ---------- Grading (finite poll) ----------
  function stopGradingPoll(reason = "") {
    if (gradingPollTimer) clearInterval(gradingPollTimer);
    gradingPollTimer = null;
    gradingPollTries = 0;
    if (reason) log("[GRADING] polling stopped", { reason });
    updateMeta();
  }

  async function pollGradingOnce(manual = false) {
    ensureUiRoot();
    const out = document.getElementById("gradingOutput");

    if (!currentSessionId) {
      out.textContent = "No sessionId yet — start a consultation first.";
      if (manual) log("[GRADING] no currentSessionId");
      return;
    }

    const shouldLog = manual;

    try {
      const data = await fetchJson(
        `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(currentSessionId)}`,
        { method: "GET", cache: "no-store", mode: "cors" }
      );

      if (!data.found) {
        out.textContent = "No attempt found yet… (waiting for transcript submit)";
        if (shouldLog) log("[GRADING] found=false", data);
        return;
      }

      if (data.ready && data.gradingText) {
  out.textContent = data.gradingText;
  setStatus("Grading ready.");
  log("[GRADING] READY", {
    sessionId: currentSessionId,
    attemptRecordId: data.attemptRecordId,
    caseId: data.caseId,
  });
  stopGradingPoll("ready");
  return;
}


      out.textContent = "Grading in progress…";
      if (shouldLog) log("[GRADING] processing", data);
      setStatus("Stopped. Grading in progress…");
    } catch (e) {
      out.textContent = "Error fetching grading: " + (e?.message || String(e));
      log("[GRADING] fetch error", { error: e?.message || String(e) });
      stopGradingPoll("error");
    }
  }

  function startFiniteGradingPoll() {
    stopGradingPoll("restart");
    gradingPollTries = 0;

    const out = document.getElementById("gradingOutput");
    out.textContent = "Grading in progress…";

    log("[GRADING] start finite polling", {
      sessionId: currentSessionId,
      intervalMs: GRADING_POLL_INTERVAL_MS,
      maxTries: GRADING_POLL_MAX_TRIES,
    });

    gradingPollTimer = setInterval(async () => {
      gradingPollTries++;
      updateMeta();

      await pollGradingOnce(false);

      if (gradingPollTries >= GRADING_POLL_MAX_TRIES) {
        const out2 = document.getElementById("gradingOutput");
        out2.textContent =
          "Still grading… (timed out waiting). Click “Fetch grading now” to try again.";
        stopGradingPoll("timeout");
      }
    }, GRADING_POLL_INTERVAL_MS);

    pollGradingOnce(false);
  }

  // ---------- Start/Stop ----------
  async function startConsultation() {
    ensureUiRoot();
    stopGradingPoll("new session");
    document.getElementById("gradingOutput").textContent =
      "Grading will appear here after you stop the consultation.";

    currentSessionId = null;
    updateMeta();

    try {
      setUiConnected(true);
      setStatus("Starting session…");

      const sel = $("caseSelect");
      const caseId = Number(sel?.value) || 1;

      log("[START] case selected", { caseId });

      // ✅ NEW: include MemberSpace identity in the start request
      const { userId, email } = await ensureIdentity({ timeoutMs: 2500, intervalMs: 150 });

      if (!userId && !email) {
        log("[START] blocked: missing MemberSpace identity (after retry)");
        setStatus("Couldn't detect MemberSpace login. Refresh the page, then try again.");
        setUiConnected(false);
        return;
      }


      const data = await fetchJson(`${API_BASE}/api/start-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, userId, email }), // ✅ CHANGED
        mode: "cors",
      });

      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken");

      currentSessionId = data.sessionId || null;
      log("[START] started", { currentSessionId, userId, email });
      updateMeta();

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
    setStatus("Stopped. Grading in progress…");

    if (currentSessionId) startFiniteGradingPoll();
    else document.getElementById("gradingOutput").textContent =
      "No sessionId available; cannot fetch grading.";
  }

  // ---------- Boot ----------
  window.addEventListener("DOMContentLoaded", () => {
    ensureUiRoot();

    log("[BOOT] DOMContentLoaded", {
      href: window.location.href,
      origin: window.location.origin,
      apiBase: API_BASE,
      originAllowed: ALLOWED_ORIGINS.has(window.location.origin),
      hasCaseSelect: !!$("caseSelect"),
      hasStartBtn: !!$("startBtn"),
      hasStopBtn: !!$("stopBtn"),
      hasStatus: !!$("status"),
    });

    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    if (startBtn) startBtn.addEventListener("click", startConsultation);
    if (stopBtn) stopBtn.addEventListener("click", stopConsultation);

    setUiConnected(false);
    setStatus("Not connected");
    populateCaseDropdown();
  });
})();
