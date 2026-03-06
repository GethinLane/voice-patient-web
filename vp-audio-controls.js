/**
 * vp-audio-controls.js
 *
 * Mic + speaker buttons for voice-patient.js + Daily Pipecat.
 *
 * Reads:   window.__vpCallObject  (set by voice-patient.js)
 * Listens: vp:ui custom events    (fired by voice-patient.js)
 *
 * BEFORE a call: probes mic via getUserMedia to give real state.
 * DURING a call: syncs with Daily SDK only (no extra streams).
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
  let inCall = false;

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

  // Lightweight: just check what devices exist (no permission needed)
  async function checkSpeakers() {
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var hadSpk = spkAvailable;

      spkAvailable = devices.some(function (d) { return d.kind === "audiooutput"; });

      if (!hadSpk && spkAvailable) spkMuted = false;
      if (!spkAvailable) spkMuted = false;
    } catch (e) {
      console.warn("[vp-audio] enumerateDevices failed:", e);
    }
  }

  // Heavy: actually request mic access to verify it works
  // Only used when NOT in a call
  async function probeMic() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(function (t) { t.stop(); });

      if (!micAvailable) micMuted = false;
      micAvailable = true;
    } catch (e) {
      micAvailable = false;
      micMuted = false;
    }
  }

  // Sync mic state from Daily SDK — no new streams, just reads existing state
  function syncWithDaily() {
    var co = window.__vpCallObject;
    if (!co) return;
    try {
      var parts = co.participants ? co.participants() : {};
      var local = parts && parts.local;
      if (local) {
        micMuted = !local.audio;
        micAvailable = true; // if we're in a call, mic was available

        var track = (local.tracks && local.tracks.audio)
          ? (local.tracks.audio.persistentTrack || local.tracks.audio.track)
          : null;
        if (!track || track.readyState === "ended") micAvailable = false;
      }
    } catch (e) {}
  }

  // Smart check: picks the right strategy based on call state
  async function smartCheck() {
    if (inCall) {
      // During a call: lightweight only
      syncWithDaily();
    } else {
      // Before/after a call: probe mic properly
      await probeMic();
    }
    await checkSpeakers();
    renderAll();
  }

  // Expose for console testing
  window.__vpCheckDevices = smartCheck;

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () { smartCheck(); });
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

  // Listen to vp:ui to track call state
  window.addEventListener("vp:ui", function (e) {
    var d = e.detail || {};
    var wasInCall = inCall;

    if (d.state === "idle" || d.state === "error") {
      inCall = false;
      // Call just ended — re-probe mic properly
      if (wasInCall) smartCheck();
    } else if (d.state === "listening" || d.state === "talking" || d.state === "thinking" || d.state === "waiting" || d.state === "connecting") {
      inCall = true;
      syncWithDaily();
      checkSpeakers().then(renderAll);
    }
  });

  // Boot — probe mic on load
  smartCheck();

  // Poll every 5s — getUserMedia only runs when not in a call
  setInterval(function () { smartCheck(); }, 5000);
})();
