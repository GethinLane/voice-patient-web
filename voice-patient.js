// voice-patient.js (CUSTOM UI - no iframe)
// - MemberSpace identity passthrough
// - 12-min countdown + auto-stop
// - finite grading poll
// - Daily custom call object (audio-only)
// - Track-based audio meters for Listening/Thinking/Talking
// - Emits vp:ui events for your standalone patient card overlay

(() => {
  const VERSION = "v12.5-2026-02-10";
  const API_BASE = "https://voice-patient-web.vercel.app";
  const DAILY_JS_SRC = "https://unpkg.com/@daily-co/daily-js";

  // Enable debug panel + console logs only when ?vpdebug=1
  const DEBUG_UI = new URLSearchParams(window.location.search).has("vpdebug");
  const DEBUG_LOG = DEBUG_UI;

  // ---------------- Session + grading poll ----------------
  let currentSessionId = null;
  let gradingPollTimer = null;
  let gradingPollTries = 0;
  let startRunId = 0;        // increments on each start/stop to cancel in-flight starts
let stoppingNow = false;   // true while stopConsultation is running

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

  // Remote audio playback
  let remoteAudioEl = null;
  let currentRemoteTrack = null;

  // WebAudio metering
  let audioCtx = null;
  let localMeter = null;   // { analyser, data, source }
  let remoteMeter = null;  // { analyser, data, source }
  let levelTimer = null;

  // Levels
  let localLevel = 0;
  let remoteLevel = 0;
  let smoothLocal = 0;
  let smoothRemote = 0;

  // Adaptive noise baseline
  let noiseLocal = 0.0025;
  let noiseRemote = 0.0025;

  const LEVEL_SAMPLE_MS = 80;
  const SMOOTHING = 0.18; // 0..1 (higher = more responsive)
  const BASE_ALPHA = 0.04;

  // Hold state briefly to avoid flicker/missed frames
  const HOLD_MS = 450;
  let holdUntilMs = 0;

  // UI state
let uiState = "idle"; // idle | connecting | waiting | thinking | listening | talking | error
  let lastGlow = 0.15;
  let vpIsStarting = false;

  // ---------------- Remote presence (agent join gating) ----------------
let remotePresent = false;  // any non-local participant
let agentPresent  = false;  // treat as "agent is here" (can refine by name/id)
let waitingSinceMs = 0;

function computeRemotePresence() {
  if (!callObject) return { remotePresent: false, agentPresent: false };

  const parts = callObject.participants?.() || {};
  const remotes = Object.values(parts).filter((p) => p && !p.local);

  const anyRemote = remotes.length > 0;

  // Optional: if you can identify the agent more strictly, adjust this
  const anyAgent = remotes.some((p) => {
    const name = String(p.user_name || "").toLowerCase();
    const uid  = String(p.user_id || "").toLowerCase();
    return name.includes("pipecat") || name.includes("agent") || uid.includes("pipecat");
  });

  return { remotePresent: anyRemote, agentPresent: anyAgent || anyRemote };
}

function refreshPresenceAndUi() {
  const p = computeRemotePresence();
  remotePresent = p.remotePresent;
  agentPresent = p.agentPresent;

  // If we're connected locally but agent isn't here yet, show waiting
  if (callObject && !agentPresent) {
    if (!waitingSinceMs) waitingSinceMs = Date.now();
    if (uiState !== "waiting") setUiState("waiting");
    emitUi("waiting", 0.16);
  } else if (callObject && agentPresent && uiState === "waiting") {
    waitingSinceMs = 0;
    setUiState("thinking");
    emitUi("thinking", 0.18);
  }
}

// ---------------- Helpers ----------------
function $(id) {
  const els = Array.from(document.querySelectorAll(`#${CSS.escape(id)}`));
  // Prefer a visible element (offsetParent !== null is a solid “is displayed” check)
  return els.find((el) => el && el.offsetParent !== null) || els[0] || null;
}

  // Voice agent picker (stored by Squarespace dropdown or set manually)
function getForcedAgent() {
  try {
    // Preferred: set by your Squarespace dropdown script
    const fromLs = String(localStorage.getItem("vp_forced_agent") || "").trim();
    if (fromLs) return fromLs;

    // Optional fallback: if you put a <select id="vpAgentSelect"> on the page
    const sel = document.getElementById("vpAgentSelect");
    const fromSelect = sel ? String(sel.value || "").trim() : "";
    if (fromSelect) return fromSelect;
  } catch {}
  return "";
}


function getSelectedMode() {
  const el = document.querySelector('input[name="vpMode"]:checked');
  return el ? String(el.value || "").trim().toLowerCase() : "standard";
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x || 0)));
}

// ✅ Add this
function getCaseIdFromUrl() {
  try {
    const url = new URL(window.location.href);

    const caseParam = url.searchParams.get("case");
    if (caseParam && /^\d+$/.test(caseParam)) return Number(caseParam);

    // support bare ?341
    if (!caseParam && url.search) {
      const bare = url.search.replace(/^\?/, "");
      if (bare && /^\d+$/.test(bare)) return Number(bare);
    }
  } catch {}
  return null;
}

  function getCaseLabel() {
  const n = getCaseIdFromUrl();
  return n ? `Case ${n}` : "No case selected";
}

function uiEmit(detail) {
  try { window.dispatchEvent(new CustomEvent("vp:ui", { detail })); } catch {}
}

function log(message, obj) {
  if (!DEBUG_LOG) return;
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


  // ---------- Debug panel (optional) ----------
  function ensureUiRoot() {
    if (!DEBUG_UI) return null;

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
    root.appendChild(timer);

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
    if (!DEBUG_UI) return;

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

  function setCountdownText(text) {
    if (!DEBUG_UI) return;
    ensureUiRoot();
    const el = document.getElementById("vp-timer");
    if (el) el.textContent = text || "";
  }

  function setStatus(text) {
    const el = $("status");
    if (el) el.textContent = text;
    updateMeta({ note: text });
    uiEmit({ status: text, sessionId: currentSessionId, state: uiState, glow: lastGlow });
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


  // ---------------- Countdown helpers ----------------
  function formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function stopCountdown(reason = "") {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEndsAt = null;
    if (DEBUG_UI) {
      if (reason) setCountdownText(`Timer stopped (${reason})`);
      else setCountdownText("");
    }
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
        stopConsultation(true).catch(() => {});
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

  // ---------------- Daily + Track meters ----------------
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

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function ensureRemoteAudioElement() {
    if (remoteAudioEl) return remoteAudioEl;
    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.playsInline = true;
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);
    return remoteAudioEl;
  }

  function destroyMeter(m) {
    if (!m) return;
    try { m.source.disconnect(); } catch {}
    try { m.analyser.disconnect(); } catch {}
  }

  function makeMeterForTrack(track) {
    if (!track) return null;
    const ctx = ensureAudioContext();
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    return { source, analyser, data };
  }

  function rmsFromMeter(m) {
    if (!m) return 0;
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (let i = 0; i < m.data.length; i++) {
      const v = (m.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / m.data.length);
    return rms; // ~0..1 (usually small)
  }

  function setUiState(next) {
    if (uiState === next) return;
    uiState = next;
    updateMeta();
    log("[UI] state", { uiState });
  }

  function emitUi(state, glow) {
    lastGlow = clamp01(glow);
    uiEmit({
      state,
      glow: lastGlow,
      localLevel: clamp01(smoothLocal * 8),  // scaled for debugging display only
      remoteLevel: clamp01(smoothRemote * 8),
      sessionId: currentSessionId,
    });
  }

  function computeThresholds() {
    // Adaptive thresholds above baseline noise
    const localTh = Math.max(0.006, noiseLocal + 0.006);
    const remoteTh = Math.max(0.005, noiseRemote + 0.005);
    return { localTh, remoteTh };
  }

  function startLevelLoop() {
    stopLevelLoop();
    levelTimer = setInterval(() => {
      const lr = rmsFromMeter(localMeter);
      const rr = rmsFromMeter(remoteMeter);

      localLevel = lr;
      remoteLevel = rr;

      // Update baselines only when near baseline (avoid learning speech as "noise")
      if (lr < noiseLocal + 0.010) noiseLocal = noiseLocal * (1 - BASE_ALPHA) + lr * BASE_ALPHA;
      if (rr < noiseRemote + 0.010) noiseRemote = noiseRemote * (1 - BASE_ALPHA) + rr * BASE_ALPHA;

      smoothLocal += (lr - smoothLocal) * SMOOTHING;
      smoothRemote += (rr - smoothRemote) * SMOOTHING;

      const { localTh, remoteTh } = computeThresholds();

      const now = Date.now();
      let state = uiState;
      let glow = 0.18;
            // If agent hasn't joined yet, keep UI in waiting and don't run talk/listen/thinking logic
      if (!agentPresent) {
        if (uiState !== "waiting") setUiState("waiting");
        emitUi("waiting", 0.16);
        return;
      }

      // Prioritize bot talking over listening to avoid echo picking up
      if (smoothRemote > remoteTh) {
        state = "talking";
        glow = 0.16 + Math.min(0.8, smoothRemote * 10);
        holdUntilMs = now + HOLD_MS;
      } else if (smoothLocal > localTh) {
        state = "listening";
        glow = 0.14 + Math.min(0.7, smoothLocal * 10);
        holdUntilMs = now + HOLD_MS;
      } else if (now < holdUntilMs) {
        // keep last state briefly
        state = uiState;
        glow = lastGlow;
      } else {
        state = "thinking";
        glow = 0.18;
      }

      if (state !== uiState) setUiState(state);
      emitUi(state, glow);
    }, LEVEL_SAMPLE_MS);
  }

  function stopLevelLoop() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
  }

  function tryAttachLocalMeter() {
    if (!callObject) return false;
    const parts = callObject.participants?.() || {};
    const t =
      parts?.local?.tracks?.audio?.persistentTrack ||
      parts?.local?.tracks?.audio?.track ||
      null;

    if (!t) return false;

    destroyMeter(localMeter);
    localMeter = makeMeterForTrack(t);
    return !!localMeter;
  }

  async function mountDailyCustomAudio(dailyRoom, dailyToken) {
    await loadDailyJsOnce();
    await unmountDailyCustomAudio();

    // Create call object
    callObject = window.Daily.createCallObject({
      startVideoOff: true,
      startAudioOff: false,
    });

    // Presence gating: track when the remote agent joins/leaves
callObject.on("participant-joined", () => refreshPresenceAndUi());
callObject.on("participant-left",  () => refreshPresenceAndUi());
callObject.on("participant-updated", () => refreshPresenceAndUi());

    // ✅ DEBUG: expose callObject so we can inspect tracks from browser console
window.__vpCallObject = callObject;
console.log("[VP] callObject exposed as window.__vpCallObject");


    callObject.on("error", (e) => {
      log("[DAILY] error", e);
      setUiState("error");
      setStatus("Daily error (add ?vpdebug=1 to see details).");
      emitUi("error", 0.20);
    });

    // Track handling: remote audio playback + meter
    callObject.on("track-started", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        currentRemoteTrack = track;

        const audio = ensureRemoteAudioElement();
        audio.srcObject = new MediaStream([track]);
        audio.play?.().catch(() => {}); // should be allowed (triggered by user Start click)

        destroyMeter(remoteMeter);
        remoteMeter = makeMeterForTrack(track);

        // If loop was running but remote meter was missing, it will now react
      } catch (e) {
        log("[DAILY] track-started handler error", { error: e?.message || String(e) });
      }
    });

    callObject.on("track-stopped", (ev) => {
      try {
        const { track, participant } = ev || {};
        if (!track || track.kind !== "audio") return;
        if (!participant || participant.local) return;

        // Only clear if it is the SAME track we attached (prevents accidental mid-sentence clears)
        if (currentRemoteTrack && track === currentRemoteTrack) {
          currentRemoteTrack = null;
          if (remoteAudioEl) remoteAudioEl.srcObject = null;
          destroyMeter(remoteMeter);
          remoteMeter = null;
        }
      } catch {}
    });

    // Join
    await callObject.join({ url: dailyRoom, token: dailyToken });
    // Update presence immediately after join (agent may or may not be in yet)
    refreshPresenceAndUi();
    vpIsStarting = false;

    // Make sure audio context is running (must be after user gesture)
    ensureAudioContext();

    // Ensure local audio is on
    try { callObject.setLocalAudio?.(true); } catch {}

    // Attach local meter (or wait until audio track appears)
    if (!tryAttachLocalMeter()) {
      const onPU = () => {
        if (tryAttachLocalMeter()) {
          callObject.off?.("participant-updated", onPU);
        }
      };
      callObject.on("participant-updated", onPU);
    }

    // Reset levels and start UI loop
    localLevel = remoteLevel = 0;
    smoothLocal = smoothRemote = 0;
    noiseLocal = noiseRemote = 0.0025;
    holdUntilMs = 0;

    setUiState("thinking");
    emitUi("thinking", 0.18);
    startLevelLoop();
  }

  async function unmountDailyCustomAudio({ suppressIdleEmit = false } = {}) {
    stopLevelLoop();

    destroyMeter(localMeter);
    destroyMeter(remoteMeter);
    localMeter = null;
    remoteMeter = null;

    currentRemoteTrack = null;

    if (remoteAudioEl) {
      try { remoteAudioEl.srcObject = null; remoteAudioEl.remove(); } catch {}
      remoteAudioEl = null;
    }

    if (callObject) {
      try { await callObject.leave(); } catch {}
      try { callObject.destroy?.(); } catch {}
      callObject = null;
    }

    remotePresent = false;
agentPresent = false;
waitingSinceMs = 0;
    
    if (!suppressIdleEmit) {
    uiState = "idle";
    emitUi("idle", 0.15);
}
  }

  // On-demand debug — no spam
  window.vpDebugLevels = () => {
    const th = computeThresholds();
    return {
      state: uiState,
      localLevel,
      remoteLevel,
      smoothLocal,
      smoothRemote,
      noiseLocal,
      noiseRemote,
      localTh: th.localTh,
      remoteTh: th.remoteTh,
      hasCall: !!callObject,
      hasLocalMeter: !!localMeter,
      hasRemoteMeter: !!remoteMeter,
    };
  };

  // ---------- Cases ----------
  async function populateCaseDropdown() {
    const sel = $("caseSelect");
    if (!sel) return;

    sel.innerHTML = `<option>Loading cases…</option>`;

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
    } catch (e) {
      sel.innerHTML = `<option>Error loading cases</option>`;
      log("[CASES] error", { error: e?.message || String(e) });
    }
  }

  // ---------- Grading ----------
  function stopGradingPoll(reason = "") {
    if (gradingPollTimer) clearInterval(gradingPollTimer);
    gradingPollTimer = null;
    gradingPollTries = 0;
    updateMeta();
    log("[GRADING] polling stopped", { reason });
  }

  function isMeaningfulText(s) {
    const t = String(s || "");
    return t.trim().length >= 20;
  }

  async function pollGradingOnce(manual = false, { force = false } = {}) {
    if (DEBUG_UI) ensureUiRoot();

    const out = document.getElementById("gradingOutput");
    if (out && !DEBUG_UI) {
      // If you want grading visible without debug panel, add <pre id="gradingOutput"></pre> to your page.
    }

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

        if (willForceNext) {
          await pollGradingOnce(false, { force: true });
        }
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
      stopGradingPoll("error");
      log("[GRADING] fetch error", { error: e?.message || String(e) });
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
        if (out) out.textContent =
          "Still grading… (timed out waiting). Click “Fetch grading now” (with ?vpdebug=1) or refresh.";
        stopGradingPoll("timeout");
      }
    }, GRADING_POLL_INTERVAL_MS);

    pollGradingOnce(false);
  }


  // ---------- Start/Stop ----------
  async function startConsultation() {
    if (DEBUG_UI) ensureUiRoot();

      const myRun = ++startRunId;   // claim this start attempt
  stoppingNow = false;          // allow starting even if a previous stop happened
  const stillCurrent = () => myRun === startRunId && !stoppingNow;

    stopGradingPoll("new session");
    stopCountdown("new session");

    const out = document.getElementById("gradingOutput");
    if (out) out.textContent = "Grading will appear here after you stop the consultation.";

    currentSessionId = null;
    updateMeta();

    try {
      setUiConnected(true);
      
      vpIsStarting = true;
      setUiState("connecting");
      emitUi("connecting", 0.15);
      setStatus(`Starting session (${getCaseLabel()})…`);

const urlCase = getCaseIdFromUrl();
const caseId = urlCase || 1;


      const { userId, email } = await ensureIdentity({ timeoutMs: 2500, intervalMs: 150 });
      if (!stillCurrent()) return;
      if (!userId && !email) {
  vpIsStarting = false;
  setStatus("Couldn't detect MemberSpace login. Refresh the page, then try again.");
  setUiConnected(false);
  return;
}

      const mode = getSelectedMode();

      // IMPORTANT: this click path is what unlocks autoplay + AudioContext
      ensureAudioContext();

      const credits = await fetchJson(
  `${API_BASE}/api/credits?userId=${encodeURIComponent(userId)}&email=${encodeURIComponent(email)}&mode=${encodeURIComponent(mode)}`,
  { method: "GET", cache: "no-store", mode: "cors" }
);
      if (!stillCurrent()) return;

if (!credits?.canStart) {
  vpIsStarting = false;
  setStatus(`Not enough credits for ${mode}. You have ${credits.creditsRemaining}, need ${credits.required}.`);
  setUiConnected(false);
  return;
}


// Build payload (includes mode + optional agent)
const payload = { caseId, userId, email, mode };

const agent = getForcedAgent();
if (agent) payload.agent = agent;

const data = await fetchJson(`${API_BASE}/api/start-session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  mode: "cors",
});
      if (!stillCurrent()) return;


      // Avatar is loaded on page load by bot-page.bundle.js — no avatar updates needed here.


      if (!data?.ok) throw new Error(data?.error || "Start failed");
      if (!data.dailyRoom || !data.dailyToken) throw new Error("Missing dailyRoom/dailyToken");

      currentSessionId = data.sessionId || null;
      updateMeta();

      setStatus(`Connecting audio (${getCaseLabel()})…`);
      setUiState("connecting");
emitUi("connecting", 0.15);
      if (!stillCurrent()) return;
await mountDailyCustomAudio(data.dailyRoom, data.dailyToken);
if (!stillCurrent()) return;

      startCountdown(MAX_SESSION_SECONDS);
      setStatus(`Connected (${getCaseLabel()}). Talk, then press Stop.`);
} catch (e) {
      vpIsStarting = false;
  // ✅ Credits gate from /api/start-session
  if (e?.status === 402) {
    const available = e?.data?.credits?.available;
    const required  = e?.data?.credits?.required;
    const mode      = e?.data?.credits?.mode || getSelectedMode();

    const msg =
      `Unable to start: insufficient credits. Please top up before beginning.` +
      (Number.isFinite(available) && Number.isFinite(required)
        ? ` (You have ${available}, need ${required} for ${mode}.)`
        : "");

    setStatus(msg);          // <- this automatically updates your #sca-status via vp:ui
    setUiConnected(false);
    return;
  }

  setStatus("Error starting. Add ?vpdebug=1 for details.");
  setUiConnected(false);
  await unmountDailyCustomAudio({ suppressIdleEmit: true });
  stopCountdown("start failed");
  log("[START] error", { error: e?.message || String(e), status: e?.status, data: e?.data });
}

  }

async function stopConsultation(auto = false) {
  if (DEBUG_UI) ensureUiRoot();

  // Ignore repeated stop clicks while a stop is already running
  if (stoppingNow) return;
  stoppingNow = true;

  // Cancel any in-flight startConsultation() immediately
  startRunId++;

  try {
    stopCountdown(auto ? "auto stop" : "manual stop");

    // On stop we want UI to return to idle, so do NOT suppress idle emit
    await unmountDailyCustomAudio();

    setUiConnected(false);
    setStatus(auto ? "Time limit reached. Grading in progress…" : "Stopped. Grading in progress…");

    if (currentSessionId) startFiniteGradingPoll();
    else {
      const out = document.getElementById("gradingOutput");
      if (out) out.textContent = "No sessionId available; cannot fetch grading.";
    }
  } finally {
    // Always release the stop lock even if Daily throws
    stoppingNow = false;
  }
}

  // ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  if (DEBUG_UI) ensureUiRoot();

  // Wait for required elements to exist (bundle might mount after DOMContentLoaded)
  function findUiEls() {
    const startBtn = document.getElementById("startBtn");
    const stopBtn  = document.getElementById("stopBtn");
    const status   = document.getElementById("status");
    return { startBtn, stopBtn, status };
  }

  function bindOnce() {
    const { startBtn, stopBtn, status } = findUiEls();

    // If multiple exist (duplicate IDs), pick the visible one
    const pickVisible = (id) => {
      const els = Array.from(document.querySelectorAll(`#${CSS.escape(id)}`));
      return els.find((el) => el.offsetParent !== null) || els[0] || null;
    };

    const sBtn = pickVisible("startBtn");
    const xBtn = pickVisible("stopBtn");
    const stEl = pickVisible("status");

    const ok = !!(sBtn && xBtn && stEl);
    if (!ok) return false;

    // Prevent double-binding if code runs twice
    if (window.__vpBound) return true;
    window.__vpBound = true;

    // Swap to the visible ones
    // (so the rest of the script's helpers still work)
    // NOTE: your helpers use $(id) each time, so this is just sanity.
    log("[BOOT] binding UI elements", {
      startBtn: !!sBtn, stopBtn: !!xBtn, status: !!stEl
    });

    sBtn.addEventListener("click", startConsultation);
    xBtn.addEventListener("click", () => { stopConsultation(false).catch(() => {}); });

    window.addEventListener("beforeunload", () => {
      try { unmountDailyCustomAudio(); } catch {}
    });

    // Initial UI state
    setUiConnected(false);
    setStatus("Not connected");
    uiEmit({ state: "idle", glow: 0.15, status: "Waiting…", sessionId: null });

    populateCaseDropdown();
    setCountdownText("");
    return true;
  }

  // Try immediately
  if (bindOnce()) return;

  // Otherwise observe until UI appears
  const obs = new MutationObserver(() => {
    if (bindOnce()) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Also try a small timed retry (Squarespace can be weird)
  setTimeout(() => { bindOnce(); }, 250);
  setTimeout(() => { bindOnce(); }, 1000);
});
})();
