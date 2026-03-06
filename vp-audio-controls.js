/**
 * vp-audio-controls.js
 *
 * Mic + speaker buttons for voice-patient.js + Daily Pipecat.
 *
 * Reads:   window.__vpCallObject  (set by voice-patient.js)
 * Listens: vp:ui custom events    (fired by voice-patient.js)
 *
 * States:
 *   active       → green, normal icon
 *   muted        → red, slash icon
 *   disconnected → dark, normal icon + fa-circle-xmark badge (shown via CSS)
 */
(() => {
  let micAvailable = false;
  let spkAvailable = false;
  let micMuted = false;
  let spkMuted = false;

  function applyBtn(id, iconId, state, type) {
    const btn  = document.getElementById(id);
    const icon = document.getElementById(iconId);
    if (!btn || !icon) return;

    btn.classList.remove("vp-audioBtn--active", "vp-audioBtn--muted", "vp-audioBtn--disconnected");
    btn.classList.add("vp-audioBtn--" + state);

    if (type === "mic") {
      icon.className = state === "muted"
        ? "fa-solid fa-microphone-slash"
        : "fa-solid fa-microphone";
    } else {
      icon.className = state === "muted"
        ? "fa-solid fa-volume-xmark"
        : "fa-solid fa-volume-high";
    }
  }

  function renderAll() {
    var ms = !micAvailable ? "disconnected" : micMuted ? "muted" : "active";
    var ss = !spkAvailable ? "disconnected" : spkMuted ? "muted" : "active";
    applyBtn("vpMicBtn", "vpMicIcon", ms, "mic");
    applyBtn("vpSpkBtn", "vpSpkIcon", ss, "spk");
  }

  // ── Device detection ──
  async function checkDevices() {
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var hadMic = micAvailable;
      var hadSpk = spkAvailable;

      micAvailable = devices.some(function (d) { return d.kind === "audioinput"; });
      spkAvailable = devices.some(function (d) { return d.kind === "audiooutput"; });

      if (!hadMic && micAvailable) micMuted = false;
      if (!hadSpk && spkAvailable) spkMuted = false;
      if (!micAvailable) micMuted = false;
      if (!spkAvailable) spkMuted = false;

      renderAll();
    } catch (e) {
      console.warn("[vp-audio] enumerateDevices failed:", e);
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () { checkDevices(); });
  }

  // ── Click handlers ──
  window.__vpToggleMic = function () {
    if (!micAvailable) return;

    var co = window.__vpCallObject;
    if (co && typeof co.localAudio === "function") {
      var isOn = co.localAudio();
      co.setLocalAudio(!isOn);
      micMuted = isOn;
    } else {
      micMuted = !micMuted;
    }
    renderAll();
  };

  window.__vpToggleSpk = function () {
    if (!spkAvailable) return;

    var audioEls = document.querySelectorAll("audio");
    var toggled = false;
    audioEls.forEach(function (el) {
      if (el.srcObject || el.src) {
        el.muted = !el.muted;
        spkMuted = el.muted;
        toggled = true;
      }
    });
    if (!toggled) spkMuted = !spkMuted;

    renderAll();
  };

  // ── Sync mic state from Daily SDK ──
  function syncWithDaily() {
    var co = window.__vpCallObject;
    if (!co) return;
    try {
      var parts = co.participants ? co.participants() : {};
      var local = parts && parts.local;
      if (local) {
        micMuted = !local.audio;
        var track = (local.tracks && local.tracks.audio)
          ? (local.tracks.audio.persistentTrack || local.tracks.audio.track)
          : null;
        if (!track || track.readyState === "ended") micAvailable = false;
      }
    } catch (e) {}
    renderAll();
  }

  // ── Stay in sync via vp:ui events ──
  window.addEventListener("vp:ui", function (e) {
    var d = e.detail || {};
    if (d.state === "idle") { checkDevices(); return; }
    if (d.state === "listening" || d.state === "talking" || d.state === "thinking" || d.state === "waiting") {
      syncWithDaily();
    }
  });

  // ── Boot ──
  checkDevices();
  setInterval(function () { if (!window.__vpCallObject) checkDevices(); }, 3000);
})();
