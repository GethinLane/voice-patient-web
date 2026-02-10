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
  const VERSION = "debug-2026-02-10-active-speaker-ui-1";
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

  // ---------------- Daily custom audio (no iframe) ----------------
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

  function ensureRemoteAudioElement() {
    if (remoteAudioEl) return remoteAudioEl;

    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.muted = false;
    remoteAudioEl.volume = 1.0;
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);

    remoteStream = new MediaStream();
    remoteAudioEl.srcObject = remoteStream;

    return remoteAudioEl;
  }

  function startDecayTimer() {
    stopDecayTimer();
    decayTimer = setInterval(() => {
      // If we haven’t seen any speaker activity recently, go back to thinking.
      if (!callObject) return;
      if (uiState !== "talking" && uiState !== "listening") return;
      if (Date.now() - lastSpeakerAt > 900) setUiState("thinking");
    }, 200);
  }

  function stopDecayTimer() {
    if (decayTimer) clearInterval(decayTimer);
    decayTimer = null;
  }

  function handleActiveSpeakerChange({ activeSpeaker } = {}) {
    // activeSpeaker?.peerId is the session_id of the current speaker (can be undefined/null)
    const peerId = activeSpeaker?.peerId || null;

    // refresh localSid when possible
    try {
      const p = callObject?.participants?.();
      if (p?.local?.session_id) localSid = p.local.session_id;
    } catch {}

    lastSpeakerAt = Date.now();

    if (!peerId) {
      setUiState("thinking");
      return;
    }

    if (localSid && peerId === localSid) {
      // user is speaking -> patient is listening
      setUiState("listening");
    } else {
      // remote is speaking -> patient is talking
      setUiState("talking");
    }
  }

  async function mountDailyCustomAudio(dailyRoom, dailyToken) {
    await loadDailyJsOnce();
    await unmountDailyCustomAudio();

    ensureRemoteAudioElement();

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

    // Attach remote audio tracks to our persistent stream
    callObject.on("track-started", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        log("[DAILY] remote audio track started", { session_id: participant.session_id });

        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(track);

        // Try to start playback (Start click counts as a gesture, so this usually works)
        remoteAudioEl?.play?.().catch(() => {});
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

        try { remoteStream?.removeTrack?.(track); } catch {}
      } catch {}
    });

    // ✅ Recommended for audio-only UIs
    callObject.on("active-speaker-change", handleActiveSpeakerChange);

    // Join
    await callObject.join({ url: dailyRoom, token: dailyToken });

    // Cache local session id after join
    try {
      const p = callObject.participants();
      localSid = p?.local?.session_id || null;
    } catch {
      localSid = null;
    }

    startDecayTimer();

    // Default state once connected
    setUiState("thinking");
  }

  async function unmountDailyCustomAudio() {
    stopDecayTimer();

    if (callObject) {
      try { callObject.off("active-speaker-change", handleActiveSpeakerChange); } catch {}
      try { await callObject.leave(); } catch {}
      try { callObject.destroy?.(); } catch {}
    }
    callObject = null;
    localSid = null;

    // reset audio
    if (remoteStream) {
      try {
        remoteStream.getTracks().forEach((t) => {
          try { remoteStream.removeTrack(t); } catch {}
          try { t.stop?.(); } catch {}
        });
      } catch {}
    }

    if (remoteAudioEl) {
      try { remoteAudioEl.pause?.(); } catch {}
      try { remoteAudioEl.srcObject = null; } catch {}
      try { remoteAudioEl.remove(); } catch {}
    }
    remoteAudioEl = null;
    remoteStream = null;

    setUiState("idle");
    uiEmit({ state: "idle", status: "Waiting…", sessionId: currentSessionId });
  }

  // On-demand diagnostics (no spam)
  window.vpDebug = () => {
    try {
      const p = callObject?.participants?.() || null;
      return {
        version: VERSION,
        state: uiState,
        sessionId: currentSessionId,
        localSid,
        hasCall: !!callObject,
        participants: p,
      };
    } catch {
      return { version: VERSION, state: uiState, sessionId: currentSessionId, localSid, hasCall: !!callObject };
    }
  };

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
