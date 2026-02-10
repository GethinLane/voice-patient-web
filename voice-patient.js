// voice-patient.js (DEBUG - finite grading poll + injected UI)
// + MemberSpace identity passthrough + 12-min countdown + auto-stop
// + Daily custom UI (no iframe) + real Listening/Thinking/Talking (audio levels)
// + emits vp:ui events for a standalone patient card overlay
//
// PATCH 2026-02-10:
// - Lowered audio thresholds (Daily levels are often tiny)
// - Start audio observers AFTER join (more reliable)
// - Ensure remote <audio> calls play()
// - Add active-speaker fallback
// - Add 1/sec LEVELS log so you can tune quickly

(() => {
  const VERSION = "debug-2026-02-10-dailyjs-customui-1+states-2(thresholds+fallback)+finite-poll-1+ms-identity+grading-guard-1+12min-timer";
  const API_BASE = "https://voice-patient-web.vercel.app";
  const DAILY_JS_SRC = "https://unpkg.com/@daily-co/daily-js";

  const ALLOWED_ORIGINS = new Set([
    "https://www.scarevision.co.uk",
    "https://www.scarevision.ai",
    "https://scarevision.co.uk",
    "https://scarevision.ai",
  ]);

  // ---------------- Session + grading poll ----------------
  let currentSessionId = null;
  let gradingPollTimer = null;
  let gradingPollTries = 0;

  const GRADING_POLL_INTERVAL_MS = 6000; // every 6s
  const GRADING_POLL_MAX_TRIES = 20;     // 120s max

  // ---------------- Countdown (12 min) ----------------
  const MAX_SESSION_SECONDS = 12 * 60;
  let countdownTimer = null;
  let countdownEndsAt = null;

  // Grading guard
  let readyEmptyCount = 0;

  // ---------------- Daily custom call state ----------------
  let callObject = null;
  let remoteAudioEl = null;

  let localLevel = 0;
  let remoteLevel = 0;

  // smoothed levels (for stable UI)
  let smoothLocal = 0;
  let smoothRemote = 0;

  // ⚠️ Daily audio levels are often small (0.002–0.02 typical)
  const SMOOTHING = 0.25;

  let uiState = "idle"; // idle | thinking | listening | talking | error
  let lastGlow = 0.15;

  // ✅ lower thresholds (tune from logs)
  const TALKING_TH = 0.012;    // bot audio
  const LISTENING_TH = 0.015;  // mic audio

  // active speaker fallback
  let lastActiveSpeaker = null; // "local" | <remote session_id> | null

  // level log throttling
  let lastLevelLogAt = 0;

  // ---------------- Helpers ----------------
  function $(id) { return document.getElementById(id); }

  function uiEmit(detail) {
    try {
      window.dispatchEvent(new CustomEvent("vp:ui", { detail }));
    } catch {}
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, Number(x || 0)));
  }

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

    const timer = document.createElement("div");
    timer.id = "vp-timer";
    timer.style.marginTop = "6px";
    timer.style.fontWeight = "700";
    timer.style.color = "#1565C0";
    timer.textContent = "";
    root.appendChild(timer);

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
      ` | state=${uiState}` +
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

    uiEmit({ status: text, sessionId: currentSessionId });
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

  // ---------------- Countdown helpers ----------------
  function formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function setCountdownText(text) {
    ensureUiRoot();
    const el = document.getElementById("vp-timer");
    if (el) el.textContent = text || "";
  }

  function stopCountdown(reason = "") {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEndsAt = null;
    if (reason) setCountdownText(`Timer stopped (${reason})`);
    else setCountdownText("");
  }

  function startCountdown(seconds = MAX_SESSION_SECONDS) {
    stopCountdown("restart");
    countdownEndsAt = Date.now() + seconds * 1000;

    const tick = () => {
      const remainingMs = countdownEndsAt - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);

      setCountdownText(`Time left: ${formatMMSS(remainingSec)}`);

      if (remainingSec <= 0) {
        stopCountdown("time limit reached");
        log("[TIMER] reached zero -> auto stop", { currentSessionId });

        stopConsultation(true).catch((e) => {
          log("[TIMER] auto stop error", { error: e?.message || String(e) });
        });
      }
    };

    tick();
    countdownTimer = setInterval(tick, 250);
  }

  // ---------- MemberSpace identity (robust) ----------
  let msMember = null;

  function setMsMember(mi, source = "unknown") {
    if (!mi) return;
    const id = mi?.id != null ? String(mi.id).trim() : "";
    const email = mi?.email ? String(mi.email).trim().toLowerCase() : "";
    if (!id && !email) return;

    msMember = { ...mi, id, email };
    window.__msMemberInfo = msMember;

    log("[MEMBERSPACE] identity set", { source, id, email });
    updateMeta();
  }

  function tryHydrateFromMemberSpaceGetter() {
    try {
      const MS = window.MemberSpace;
      if (!MS || typeof MS.getMemberInfo !== "function") return false;

      const data = MS.getMemberInfo();
      if (data?.isLoggedIn && data?.memberInfo) {
        setMsMember(data.memberInfo, "MemberSpace.getMemberInfo");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  document.addEventListener("MemberSpace.member.info", (e) => {
    const detail = e.detail || null;
    const mi = detail?.memberInfo || detail;
    setMsMember(mi, "MemberSpace.member.info");
  });

  document.addEventListener("MemberSpace.ready", () => {
    tryHydrateFromMemberSpaceGetter();
  });

  if (window.__msMemberInfo) setMsMember(window.__msMemberInfo, "window.__msMemberInfo");
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
      tryHydrateFromMemberSpaceGetter();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return getIdentity();
  }

  // ---------- Daily custom (no iframe) ----------
  function ensureRemoteAudioElement() {
    if (remoteAudioEl) return remoteAudioEl;
    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);
    return remoteAudioEl;
  }

  function setUiState(next) {
    if (uiState === next) return;
    uiState = next;
    updateMeta();
    log("[UI] state", { uiState, localLevel, remoteLevel, activeSpeaker: lastActiveSpeaker });

    uiEmit({
      state: uiState,
      glow: lastGlow,
      sessionId: currentSessionId,
    });
  }

  // ✅ patched: lower thresholds + active-speaker fallback + 1/sec level logs
  function computeAndEmitUiFromLevels() {
    if (!callObject) return;

    smoothLocal += (localLevel - smoothLocal) * SMOOTHING;
    smoothRemote += (remoteLevel - smoothRemote) * SMOOTHING;

    let state = "thinking";
    let glow = 0.18;

    if (smoothRemote > TALKING_TH) {
      state = "talking";
      glow = Math.min(1, 0.12 + smoothRemote * 2.2);
    } else if (smoothLocal > LISTENING_TH) {
      state = "listening";
      glow = Math.min(1, 0.10 + smoothLocal * 2.2);
    } else {
      // fallback if levels are tiny but we have an active speaker
      if (lastActiveSpeaker === "local") state = "listening";
      else if (lastActiveSpeaker) state = "talking";
    }

    lastGlow = clamp01(glow);

    // emit every tick so the ring can animate continuously
    uiEmit({
      state,
      glow: lastGlow,
      localLevel: clamp01(smoothLocal),
      remoteLevel: clamp01(smoothRemote),
      sessionId: currentSessionId,
    });

    if (state !== uiState) setUiState(state);

    // once-per-second debug log so thresholds can be tuned
    const now = Date.now();
    if (now - lastLevelLogAt > 1000) {
      lastLevelLogAt = now;
      log("[LEVELS] local/remote", {
        local: Number(smoothLocal.toFixed(4)),
        remote: Number(smoothRemote.toFixed(4)),
        TALKING_TH,
        LISTENING_TH,
        activeSpeaker: lastActiveSpeaker,
      });
    }
  }

  async function loadDailyJsOnce() {
    if (window.Daily && typeof window.Daily.createCallObject === "function") return;

    await new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((s) => (s.src || "").includes("@daily-co/daily-js"));
      if (existing) return resolve();

      const s = document.createElement("script");
      s.crossOrigin = "anonymous";
      s.src = DAILY_JS_SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load daily-js"));
      document.head.appendChild(s);
    });
  }

  async function mountDailyCustomAudio(dailyRoom, dailyToken) {
    await loadDailyJsOnce();

    await unmountDailyCustomAudio();

    callObject = window.Daily.createCallObject({
      startVideoOff: true,
      startAudioOff: false,
    });

    callObject.on("error", (e) => {
      log("[DAILY] error", e);
      setUiState("error");
      setStatus("Daily error (see debug panel).");
    });

    callObject.on("joining-meeting", () => log("[DAILY] joining"));
    callObject.on("joined-meeting", () => log("[DAILY] joined"));
    callObject.on("left-meeting", () => log("[DAILY] left"));

    // ✅ Active speaker fallback
    callObject.on("active-speaker-change", (ev) => {
      try {
        const sid = ev?.activeSpeaker?.session_id || ev?.activeSpeaker || null;
        if (!sid) { lastActiveSpeaker = null; return; }

        // best-effort local session id comparison
        const p = callObject.participants?.() || {};
        const localSid = p?.local?.session_id || null;

        lastActiveSpeaker = (localSid && sid === localSid) ? "local" : sid;
      } catch {
        // if shape differs, don't break
      }
    });

    // Remote audio (bot) -> <audio>
    callObject.on("track-started", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        log("[DAILY] remote audio track started", { session_id: participant.session_id });

        const audio = ensureRemoteAudioElement();
        audio.srcObject = new MediaStream([track]);

        // ✅ important on some browsers
        audio.play?.().catch(() => {});
      } catch (e) {
        log("[DAILY] track-started handler error", { error: e?.message || String(e) });
      }
    });

    callObject.on("track-stopped", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        log("[DAILY] remote audio track stopped", { session_id: participant.session_id });

        if (remoteAudioEl) {
          remoteAudioEl.srcObject = null;
        }
      } catch {}
    });

    // Audio level events (will start firing once observers are started)
    callObject.on("local-audio-level", (ev) => {
      localLevel = Number(ev?.level || 0);
      computeAndEmitUiFromLevels();
    });

    callObject.on("remote-participants-audio-level", (ev) => {
      const parts = ev?.participants || {};
      let max = 0;
      for (const sid in parts) {
        const lvl = Number(parts[sid]?.level || 0);
        if (lvl > max) max = lvl;
      }
      remoteLevel = max;
      computeAndEmitUiFromLevels();
    });

    // Join FIRST, then start observers (more reliable)
    await callObject.join({ url: dailyRoom, token: dailyToken });

    // ✅ Start observers AFTER join
    callObject.startLocalAudioLevelObserver(100);
    callObject.startRemoteParticipantsAudioLevelObserver(100);

    // Initial UI
    localLevel = 0;
    remoteLevel = 0;
    smoothLocal = 0;
    smoothRemote = 0;
    lastGlow = 0.18;
    lastActiveSpeaker = null;
    setUiState("thinking");
  }

  async function unmountDailyCustomAudio() {
    if (!callObject) {
      uiState = "idle";
      lastGlow = 0.15;
      lastActiveSpeaker = null;
      uiEmit({ state: "idle", glow: lastGlow, sessionId: currentSessionId });
      return;
    }

    try { callObject.stopLocalAudioLevelObserver?.(); } catch {}
    try { callObject.stopRemoteParticipantsAudioLevelObserver?.(); } catch {}

    try { await callObject.leave(); } catch {}
    try { callObject.destroy?.(); } catch {}

    callObject = null;

    localLevel = 0;
    remoteLevel = 0;
    smoothLocal = 0;
    smoothRemote = 0;
    lastActiveSpeaker = null;

    uiState = "idle";
    lastGlow = 0.15;
    uiEmit({ state: "idle", glow: lastGlow, sessionId: currentSessionId });

    if (remoteAudioEl) {
      try { remoteAudioEl.srcObject = null; remoteAudioEl.remove(); } catch {}
      remoteAudioEl = null;
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

  function isMeaningfulText(s) {
    const t = String(s || "");
    return t.trim().length >= 20;
  }

  async function pollGradingOnce(manual = false, { force = false } = {}) {
    ensureUiRoot();
    const out = document.getElementById("gradingOutput");

    if (!currentSessionId) {
      out.textContent = "No sessionId yet — start a consultation first.";
      if (manual) log("[GRADING] no currentSessionId");
      return;
    }

    const url =
      `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(currentSessionId)}` +
      (force ? `&force=1` : "");

    if (manual || force) log("[GRADING] request", { url });

    try {
      const data = await fetchJson(url, { method: "GET", cache: "no-store", mode: "cors" });

      if (!data.found) {
        out.textContent = "No attempt found yet… (waiting for transcript submit)";
        if (manual) log("[GRADING] found=false", data);
        return;
      }

      const status = String(data.status || "");
      const gradingText = String(data.gradingText || "");
      const ready = !!data.ready;

      if (ready && !isMeaningfulText(gradingText)) {
        readyEmptyCount += 1;
        const willForceNext = readyEmptyCount >= 2;

        log("[GRADING] ready=true but gradingText empty", {
          sessionId: currentSessionId,
          attemptRecordId: data.attemptRecordId,
          caseId: data.caseId,
          status,
          readyEmptyCount,
          willForceNext,
          data,
        });

        out.textContent = "Grading finishing…";
        setStatus("Stopped. Grading finishing…");

        if (willForceNext) {
          await pollGradingOnce(false, { force: true });
        }
        return;
      }

      if (ready && gradingText) {
        out.textContent = gradingText;
        setStatus("Grading ready.");
        log("[GRADING] READY", {
          sessionId: currentSessionId,
          attemptRecordId: data.attemptRecordId,
          caseId: data.caseId,
          status,
          len: gradingText.length,
        });
        stopGradingPoll("ready");
        return;
      }

      out.textContent = "Grading in progress…";
      if (manual) log("[GRADING] processing", data);
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
    readyEmptyCount = 0;

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
    stopCountdown("new session");

    const out = document.getElementById("gradingOutput");
    if (out) out.textContent = "Grading will appear here after you stop the consultation.";

    currentSessionId = null;
    updateMeta();

    try {
      setUiConnected(true);
      setStatus("Starting session…");

      const sel = $("caseSelect");
      const caseId = Number(sel?.value) || 1;

      log("[START] case selected", { caseId });

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
        body: JSON.stringify({ caseId, userId, email }),
        mode: "cors",
      });

      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken");

      currentSessionId = data.sessionId || null;
      log("[START] started", { currentSessionId, userId, email });
      updateMeta();

      setStatus(`Connecting audio (Case ${caseId})…`);
      await mountDailyCustomAudio(data.dailyRoom, data.dailyToken);

      startCountdown(MAX_SESSION_SECONDS);
      setStatus(`Connected (Case ${caseId}). Talk, then press Stop.`);
    } catch (e) {
      log("[START] error", { error: e?.message || String(e) });
      setStatus("Error starting (see debug panel).");
      setUiConnected(false);
      await unmountDailyCustomAudio();
      stopCountdown("start failed");
    }
  }

  async function stopConsultation(auto = false) {
    ensureUiRoot();
    log("[STOP] clicked", { currentSessionId, auto });

    stopCountdown(auto ? "auto stop" : "manual stop");

    await unmountDailyCustomAudio();

    setUiConnected(false);
    setStatus(auto ? "Time limit reached. Grading in progress…" : "Stopped. Grading in progress…");

    if (currentSessionId) startFiniteGradingPoll();
    else {
      const out = document.getElementById("gradingOutput");
      if (out) out.textContent = "No sessionId available; cannot fetch grading.";
    }
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
    if (stopBtn) stopBtn.addEventListener("click", () => { stopConsultation(false).catch(() => {}); });

    window.addEventListener("beforeunload", () => {
      try { unmountDailyCustomAudio(); } catch {}
    });

    setUiConnected(false);
    setStatus("Not connected");
    uiEmit({ state: "idle", glow: 0.15, status: "Waiting…", sessionId: null });

    populateCaseDropdown();
    setCountdownText("");
  });
})();
