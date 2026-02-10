// voice-patient.js (CUSTOM UI, no iframe)
// - MemberSpace identity passthrough
// - 12-min countdown + auto-stop
// - Finite grading poll + grading guard
// - Daily custom audio via callObject (no iframe)
// - UI state driven by Daily active-speaker-change (recommended for audio-only UIs)
// - Emits window event: vp:ui  { state: idle|thinking|listening|talking|error, status?, sessionId? }
//
// Notes:
// - "listening" = USER is speaking (patient is listening)
// - "talking"   = PATIENT (bot) is speaking

(() => {
  const VERSION = "debug-v12.4b";
  const API_BASE = "https://voice-patient-web.vercel.app";
  const DAILY_JS_SRC = "https://unpkg.com/@daily-co/daily-js";

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

  // Remote audio element + persistent stream
  let remoteAudioEl = null;
  let remoteStream = null;

  // UI state
  let uiState = "idle"; // idle | thinking | listening | talking | error

  // active speaker tracking
  let localSid = null;
  let lastSpeakerAt = 0;
  let decayTimer = null;

  // ---------------- Helpers ----------------
  function $(id) { return document.getElementById(id); }

  function uiEmit(detail) {
    try {
      window.dispatchEvent(new CustomEvent("vp:ui", { detail }));
    } catch {}
  }

  // Keep logs minimal (no spam)
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

  function setUiState(next) {
    if (uiState === next) return;
    uiState = next;
    updateMeta();

    uiEmit({
      state: uiState,
      sessionId: currentSessionId,
    });
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
      throw new Error(`Non-JSON from ${url} status=${resp.status} body=${text.slice(0, 180)}`);
    }
    if (!resp.ok) {
      throw new Error((data && (data.error || data.message)) || `HTTP ${resp.status}`);
    }
    return data;
  }

  // ---------------- Debug panel + (optional) fallback controls ----------------
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
      `api=${API_BASE} | sessionId=${currentSessionId || "(none)"} | tries=${gradingPollTries}/${GRADING_POLL_MAX_TRIES}` +
      ` | userId=${userId || "(none)"} | email=${email || "(none)"}` +
      ` | state=${uiState}` +
      (extra.note ? ` | ${extra.note}` : "");
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
        stopConsultation(true).catch((e) => {
          log("[TIMER] auto stop error", { error: e?.message || String(e) });
        });
      }
    };

    tick();
    countdownTimer = setInterval(tick, 250);
  }

  // ---------------- MemberSpace identity (robust) ----------------
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

  // ---- UI state + emission ----
  function setUiState(next) {
    if (uiState === next) return;
    uiState = next;
    updateMeta();
    // minimal log: only on state change
    log("[UI] state", { uiState });
    uiEmit({ state: uiState, glow: lastGlow, sessionId: currentSessionId });
  }

  // ---- Audio level polling (reliable) ----
  let levelTimer = null;
  let lastLocalSpeechAt = 0;
  let lastRemoteSpeechAt = 0;

  // Tuning knobs:
  const LEVEL_POLL_MS = 120;

  // “Hold” time so we don’t drop to thinking between words/pauses
  const HOLD_TALK_MS = 700;
  const HOLD_LISTEN_MS = 500;

  // Noise floor + thresholds (start here, then tune with vpDebugLevels())
  const NOISE_FLOOR = 0.003;
  const TALKING_TH = 0.012;   // remote (bot)
  const LISTENING_TH = 0.014; // local (mic)
  const SMOOTHING = 0.25;

  function clamp01(x) {
  const n = Number(x || 0);
  return Math.max(0, Math.min(1, n));
}


  function stopLevelLoop() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
  }

  function startLevelLoop() {
    stopLevelLoop();
    levelTimer = setInterval(() => {
      if (!callObject) return;

      // get latest levels from Daily observers
      let l = 0;
      let r = 0;

      try {
        const rawL = callObject.getLocalAudioLevel?.();
        if (typeof rawL === "number") l = Math.max(0, rawL - NOISE_FLOOR);
      } catch {}

      try {
        const map = callObject.getRemoteParticipantsAudioLevel?.() || {};
        const parts = callObject.participants?.() || {};
        const localSid = parts?.local?.session_id || null;

        let max = 0;
        for (const sid in map) {
          if (localSid && sid === localSid) continue; // exclude local if present
          const v = Number(map[sid] || 0);
          if (v > max) max = v;
        }
        r = Math.max(0, max - NOISE_FLOOR);
      } catch {}

      // store raw
      localLevel = l;
      remoteLevel = r;

      // smooth
      smoothLocal += (localLevel - smoothLocal) * SMOOTHING;
      smoothRemote += (remoteLevel - smoothRemote) * SMOOTHING;

      const now = Date.now();

      // update “speech detected” timestamps
      if (smoothLocal > LISTENING_TH) lastLocalSpeechAt = now;
      if (smoothRemote > TALKING_TH) lastRemoteSpeechAt = now;

      // decide state (remote wins)
      let nextState = "thinking";
      if (now - lastRemoteSpeechAt < HOLD_TALK_MS) nextState = "talking";
      else if (now - lastLocalSpeechAt < HOLD_LISTEN_MS) nextState = "listening";

      // glow depends on state
      let glow = 0.18;
      if (nextState === "talking") glow = Math.min(1, 0.12 + smoothRemote * 2.6);
      if (nextState === "listening") glow = Math.min(1, 0.12 + smoothLocal * 2.6);

      lastGlow = clamp01(glow);

      // emit every tick for smooth animation
      uiEmit({
        state: nextState,
        glow: lastGlow,
        sessionId: currentSessionId,
      });

      if (nextState !== uiState) setUiState(nextState);
    }, LEVEL_POLL_MS);
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

    // Remote audio (bot) -> <audio>
    callObject.on("track-started", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        const audio = ensureRemoteAudioElement();
        audio.srcObject = new MediaStream([track]);
        audio.play?.().catch(() => {});
      } catch (e) {
        log("[DAILY] track-started handler error", { error: e?.message || String(e) });
      }
    });

    // Join first
    await callObject.join({ url: dailyRoom, token: dailyToken });

    // Start observers so getLocalAudioLevel/getRemoteParticipantsAudioLevel work
    // (Daily docs: observers populate the getter values) :contentReference[oaicite:2]{index=2}
    callObject.startLocalAudioLevelObserver(100);
    callObject.startRemoteParticipantsAudioLevelObserver(100);

    // reset + start loop
    localLevel = remoteLevel = 0;
    smoothLocal = smoothRemote = 0;
    lastLocalSpeechAt = lastRemoteSpeechAt = 0;
    lastGlow = 0.18;

    setUiState("thinking");
    startLevelLoop();
  }

  async function unmountDailyCustomAudio() {
    stopLevelLoop();

    if (!callObject) {
      uiState = "idle";
      lastGlow = 0.15;
      uiEmit({ state: "idle", glow: lastGlow, sessionId: currentSessionId });
      return;
    }

    try { callObject.stopLocalAudioLevelObserver?.(); } catch {}
    try { callObject.stopRemoteParticipantsAudioLevelObserver?.(); } catch {}

    try { await callObject.leave(); } catch {}
    try { callObject.destroy?.(); } catch {}

    callObject = null;

    localLevel = remoteLevel = 0;
    smoothLocal = smoothRemote = 0;

    uiState = "idle";
    lastGlow = 0.15;
    uiEmit({ state: "idle", glow: lastGlow, sessionId: currentSessionId });

    if (remoteAudioEl) {
      try { remoteAudioEl.srcObject = null; remoteAudioEl.remove(); } catch {}
      remoteAudioEl = null;
    }
  }

  // On-demand debug (no spam)
  window.vpDebugLevels = () => ({
    state: uiState,
    localLevel,
    remoteLevel,
    smoothLocal,
    smoothRemote,
    TALKING_TH,
    LISTENING_TH,
    NOISE_FLOOR,
    hasCall: !!callObject,
  });


  // ---------------- Cases ----------------
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

  // ---------------- Grading (finite poll) ----------------
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
      if (out) out.textContent = "No sessionId yet — start a consultation first.";
      return;
    }

    const url =
      `${API_BASE}/api/get-grading?sessionId=${encodeURIComponent(currentSessionId)}` +
      (force ? `&force=1` : "");

    try {
      const data = await fetchJson(url, { method: "GET", cache: "no-store", mode: "cors" });

      if (!data.found) {
        if (out) out.textContent = "No attempt found yet… (waiting for transcript submit)";
        return;
      }

      const gradingText = String(data.gradingText || "");
      const ready = !!data.ready;

      if (ready && !isMeaningfulText(gradingText)) {
        readyEmptyCount += 1;
        const willForceNext = readyEmptyCount >= 2;

        if (out) out.textContent = "Grading finishing…";
        setStatus("Stopped. Grading finishing…");

        if (willForceNext) await pollGradingOnce(false, { force: true });
        return;
      }

      if (ready && gradingText) {
        if (out) out.textContent = gradingText;
        setStatus("Grading ready.");
        stopGradingPoll("ready");
        return;
      }

      if (out) out.textContent = "Grading in progress…";
      setStatus("Stopped. Grading in progress…");
    } catch (e) {
      if (out) out.textContent = "Error fetching grading: " + (e?.message || String(e));
      log("[GRADING] fetch error", { error: e?.message || String(e) });
      stopGradingPoll("error");
    }
  }

  function startFiniteGradingPoll() {
    stopGradingPoll("restart");
    gradingPollTries = 0;
    readyEmptyCount = 0;

    const out = document.getElementById("gradingOutput");
    if (out) out.textContent = "Grading in progress…";

    gradingPollTimer = setInterval(async () => {
      gradingPollTries++;
      updateMeta();

      await pollGradingOnce(false);

      if (gradingPollTries >= GRADING_POLL_MAX_TRIES) {
        const out2 = document.getElementById("gradingOutput");
        if (out2) out2.textContent =
          "Still grading… (timed out waiting). Click “Fetch grading now” to try again.";
        stopGradingPoll("timeout");
      }
    }, GRADING_POLL_INTERVAL_MS);

    pollGradingOnce(false);
  }

  // ---------------- Start/Stop ----------------
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

      const { userId, email } = await ensureIdentity({ timeoutMs: 2500, intervalMs: 150 });

      if (!userId && !email) {
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

  // ---------------- Boot ----------------
  window.addEventListener("DOMContentLoaded", () => {
    ensureUiRoot();

    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");

    if (startBtn) startBtn.addEventListener("click", startConsultation);
    if (stopBtn) stopBtn.addEventListener("click", () => { stopConsultation(false).catch(() => {}); });

    window.addEventListener("beforeunload", () => {
      try { unmountDailyCustomAudio(); } catch {}
    });

    setUiConnected(false);
    setStatus("Not connected");
    setUiState("idle");
    uiEmit({ state: "idle", status: "Waiting…", sessionId: null });

    populateCaseDropdown();
    setCountdownText("");
  });
})();
