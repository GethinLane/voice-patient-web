/**
 * vp-audio-controls.js
 *
 * Mic + speaker buttons for voice-patient.js + Daily Pipecat.
 *
 * Reads:   window.__vpCallObject  (set by voice-patient.js)
 * Listens: vp:ui custom events    (fired by voice-patient.js)
 *
 * On load, probes mic access via getUserMedia so the user can
 * see whether their mic is working BEFORE starting a call.
 *
 * Icons (FA Pro):
 *   Mic:     fa-microphone / fa-microphone-slash / fa-microphone-circle-xmark
 *   Speaker: fa-volume-high / fa-volume-slash / fa-volume-xmark
 */
(() => {
  let micAvailable = false;
  let spkAvailable = false;
  let micMuted = false;
  let spkMuted = false;
  let micProbed = false;

  function applyBtn(id, iconId, state, type) {
    var btn  = document.getElementById(id);
    var icon = document.getElementById(iconId);
    if (!btn || !icon) return;

    btn.classList.remove("vp-audioBtn--active", "vp-audioBtn--muted", "vp-audioBtn--disconnected");
    btn.classList.add("vp-audioBtn--" + state);

    if (type === "mic") {
      icon.className = state === "active"        ? "fa-solid fa-microphone"
                      : state === "muted"         ? "fa-solid fa-microphone-slash"
                      :                             "fa-solid fa-microphone-circle-xmark";
    } else {
      icon.className = state === "active"         ? "fa-solid fa-volume-high"
                      : state === "muted"          ? "fa-solid fa-volume-slash"
                      :                              "fa-solid fa-volume-xmark";
    }
  }

  function renderAll() {
    var ms = !micAvailable ? "disconnected" : micMuted ? "muted" : "active";
    var ss = !spkAvailable ? "disconnected" : spkMuted ? "muted" : "active";
    applyBtn("vpMicBtn", "vpMicIcon", ms, "mic");
    applyBtn("vpSpkBtn", "vpSpkIcon", ss, "spk");
  }

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

  /**
   * Probe mic access on page load.
   * Requests a brief getUserMedia stream to:
   *   1. Trigger the browser permission prompt if not yet granted
   *   2. Verify the mic actually works (not just listed)
   * Immediately stops all tracks — no ongoing recording.
   */
  async function probeMic() {
    if (micProbed) return;
    micProbed = true;

    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Got access — mic is real and working
      stream.getTracks().forEach(function (t) { t.stop(); });
      micAvailable = true;
      renderAll();
    } catch (e) {
      // NotAllowedError = user denied permission
      // NotFoundError = no mic hardware
      // Any other error = treat as unavailable
      console.warn("[vp-audio] mic probe failed:", e.name, e.message);
      micAvailable = false;
      renderAll();
    }

    // Now that we have permission, enumerateDevices gives full info
    await checkDevices();
  }

  // Expose for testing
  window.__vpCheckDevices = checkDevices;

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () { checkDevices(); });
  }

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

  window.addEventListener("vp:ui", function (e) {
    var d = e.detail || {};
    if (d.state === "idle") { checkDevices(); return; }
    if (d.state === "listening" || d.state === "talking" || d.state === "thinking" || d.state === "waiting") {
      syncWithDaily();
    }
  });

  // Boot — probe mic on load, check speakers via enumerateDevices
  probeMic();

  // Poll every 3s
  setInterval(function () { checkDevices(); }, 3000);
})();
