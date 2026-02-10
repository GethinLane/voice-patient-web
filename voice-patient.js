// voice-patient.js (DEBUG - finite grading poll + injected UI) + MemberSpace identity passthrough + 12-min countdown + auto-stop
(() => {
  const VERSION = "debug-2026-02-05-finite-poll-1+ms-identity+grading-guard-1+12min-timer";
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

  // ---------------- Countdown (12 min) ----------------
  const MAX_SESSION_SECONDS = 12 * 60;
  let countdownTimer = null;
  let countdownEndsAt = null;

  // Grading guard (prevents "ready but empty gradingText" looking like success)
  let readyEmptyCount = 0;

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

    // Timer row (created once)
    const timer = document.createElement("div");
    timer.id = "vp-timer";
    timer.style.marginTop = "6px";
    timer.style.fontWeight = "700";
    timer.style.color = "#1565C0";
    timer.textContent = ""; // will be set when session starts
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
        stopConsultation(true); // auto stop
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

  // ---------- Daily (Custom UI - no iframe) ----------
let callObject = null;
let remoteAudioEl = null;

let localLevel = 0;
let remoteLevel = 0;
let uiState = "idle"; // idle | listening | thinking | talking | error

function ensureRemoteAudioElement() {
  if (remoteAudioEl) return remoteAudioEl;
  remoteAudioEl = document.createElement("audio");
  remoteAudioEl.autoplay = true;
  remoteAudioEl.playsInline = true;
  remoteAudioEl.style.display = "none"; // audio-only, no visible UI
  document.body.appendChild(remoteAudioEl);
  return remoteAudioEl;
}

function setUiState(next) {
  if (uiState === next) return;
  uiState = next;
  // TODO: update your Option-1 overlay here (ring + label)
  log("[UI] state", { uiState, localLevel, remoteLevel });
}

function updateStateFromLevels() {
  // tune these thresholds based on real-world testing
  const TALKING_TH = 0.05;   // bot audio level
  const LISTENING_TH = 0.06; // mic audio level

  if (!callObject) return;

  if (remoteLevel > TALKING_TH) setUiState("talking");
  else if (localLevel > LISTENING_TH) setUiState("listening");
  else setUiState("thinking");
}

async function loadDailyJsOnce() {
  if (window.Daily && typeof window.Daily.createCallObject === "function") return;

  await new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(s => s.src.includes("@daily-co/daily-js"));
    if (existing) return resolve();

    const s = document.createElement("script");
    s.crossOrigin = "anonymous";
    s.src = "https://unpkg.com/@daily-co/daily-js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load daily-js"));
    document.head.appendChild(s);
  });
}

async function mountDailyCustomAudio(dailyRoom, dailyToken) {
  await loadDailyJsOnce();

  // Ensure no previous instance exists
  await unmountDailyCustomAudio();

  // Create the call object (custom UI, no iframe)
  callObject = window.Daily.createCallObject({
    // Try to keep it audio-only from the start:
    startVideoOff: true,
    startAudioOff: false,
    // Optional: for audio-only apps, you can control subscriptions manually later.
    // subscribeToTracksAutomatically: false,
  });

  // Basic lifecycle logs
  callObject.on("joining-meeting", () => log("[DAILY] joining"));
  callObject.on("joined-meeting", () => log("[DAILY] joined"));
  callObject.on("left-meeting", () => log("[DAILY] left"));

  // Attach remote audio track (bot) to <audio>
  callObject.on("track-started", (ev) => {
    try {
      const { track, participant } = ev || {};
      if (!track || track.kind !== "audio") return;
      if (!participant || participant.local) return;

      log("[DAILY] remote audio track started", { session_id: participant.session_id });

      const audio = ensureRemoteAudioElement();
      audio.srcObject = new MediaStream([track]); // standard Web API
    } catch (e) {
      log("[DAILY] track-started handler error", { error: e?.message || String(e) });
    }
  });

  // Audio level observers
  callObject.on("local-audio-level", (ev) => {
    // ev.level is typically 0..1
    localLevel = Number(ev?.level || 0);
    updateStateFromLevels();
    // TODO: drive ring intensity from localLevel when listening
  });

  callObject.on("remote-participants-audio-level", (ev) => {
    // ev.participants is a map of session_id -> { level }
    const parts = ev?.participants || {};
    let max = 0;
    for (const sid in parts) {
      const lvl = Number(parts[sid]?.level || 0);
      if (lvl > max) max = lvl;
    }
    remoteLevel = max;
    updateStateFromLevels();
    // TODO: drive ring intensity from remoteLevel when talking
  });

  // Start observers at 100ms (smooth animation)
  callObject.startLocalAudioLevelObserver(100);
  callObject.startRemoteParticipantsAudioLevelObserver(100);

  // Join using your Pipecat-provided room + token
  await callObject.join({ url: dailyRoom, token: dailyToken });

  // Once joined, initial state
  setUiState("thinking");
}

async function unmountDailyCustomAudio() {
  if (!callObject) return;

  try { callObject.stopLocalAudioLevelObserver?.(); } catch {}
  try { callObject.stopRemoteParticipantsAudioLevelObserver?.(); } catch {}

  try { await callObject.leave(); } catch {}
  try { callObject.destroy?.(); } catch {}

  callObject = null;
  localLevel = 0;
  remoteLevel = 0;
  setUiState("idle");

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
    return t.trim().length >= 20; // avoid "\n" or tiny placeholders
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

      // ✅ If ready but gradingText is empty/whitespace, treat as not ready yet
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

        // after 2 empties, force a re-grade on next poll
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

      // processing
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

    // first hit immediately
    pollGradingOnce(false);
  }

  // ---------- Start/Stop ----------
  async function startConsultation() {
    ensureUiRoot();
    stopGradingPoll("new session");
    stopCountdown("new session");
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

      // include MemberSpace identity in the start request
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

      await mountDailyCustomAudio(data.dailyRoom, data.dailyToken);

      startCountdown(MAX_SESSION_SECONDS);
      setStatus(`Connected (Case ${caseId}). Talk, then press Stop.`);
    } catch (e) {
      log("[START] error", { error: e?.message || String(e) });
      setStatus("Error starting (see debug panel).");
      setUiConnected(false);
      unmountDailyCustomAudio();

      stopCountdown("start failed");
    }
  }

  function stopConsultation(auto = false) {
    ensureUiRoot();
    log("[STOP] clicked", { currentSessionId, auto });

    stopCountdown(auto ? "auto stop" : "manual stop");
    unmountDailyIframe();
    setUiConnected(false);
    setStatus(auto ? "Time limit reached. Grading in progress…" : "Stopped. Grading in progress…");

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
    if (stopBtn) stopBtn.addEventListener("click", () => stopConsultation(false));

    setUiConnected(false);
    setStatus("Not connected");
    populateCaseDropdown();
    setCountdownText(""); // ensure clean
  });
})();
