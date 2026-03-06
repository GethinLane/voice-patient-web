/**
 * vp-audio-controls.js
 *
 * Mic + speaker buttons for voice-patient.js + Daily Pipecat.
 *
 * Reads:   window.__vpCallObject  (set by voice-patient.js)
 * Listens: vp:ui custom events    (fired by voice-patient.js)
 *
 * Probes mic via getUserMedia ONCE on page load to get real state.
 * After that, only re-probes on devicechange (plug/unplug).
 * During a call, syncs with Daily SDK — no extra streams.
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

  // Lightweight: check what devices exist via enumerateDevices (no permission needed)
  async function checkDevicesLight() {
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var hadSpk = spkAvailable;

      spkAvailable = devices.some(function (d) { return d.kind === "audiooutput"; });

      if (!hadSpk && spkAvailable) spkMuted = false;
      if (!spkAvailable) spkMuted = false;
    } catch (e) {
      console.warn("[vp-audio] enumerateDevices failed:", e);
    }
    renderAll();
  }

  // Heavy: request mic access to verify it actually works
  // Immediately releases the stream — mic is NOT held open
  async function probeMic() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Kill the stream immediately so the mic indicator goes away
      stream.getTracks().forEach(function (t) { t.stop(); });

      if (!micAvailable) micMuted = false;
      micAvailable = true;
    } catch (e) {
      micAvailable = false;
      micMuted = false;
    }
  }

  // Sync mic state from Daily SDK — no new streams
  function syncWithDaily() {
    var co = window.__vpCallObject;
    if (!co) return;
    try {
      var parts = co.participants ? co.participants() : {};
      var local = parts && parts.local;
      if (local) {
        micMuted = !local.audio;
        micAvailable = true;

        var track = (local.tracks && local.tracks.audio)
          ? (local.tracks.audio.persistentTrack || local.tracks.audio.track)
          : null;
        if (!track || track.readyState === "ended") micAvailable = false;
      }
    } catch (e) {}
    renderAll();
  }

  // Expose for console testing
  window.__vpCheckDevices = async function () {
    await probeMic();
    await checkDevicesLight();
  };

  // Device hot-plug/unplug — re-probe mic fully (only fires on real hardware change)
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", async function () {
      if (!inCall) {
        await probeMic();
      }
      await checkDevicesLight();
    });
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
      if (wasInCall) {
        // Call just ended — re-probe mic once
        probeMic().then(checkDevicesLight);
      }
    } else if (d.state === "listening" || d.state === "talking" || d.state === "thinking" || d.state === "waiting" || d.state === "connecting") {
      inCall = true;
      syncWithDaily();
      checkDevicesLight();
    }
  });

  // Boot — probe mic once on load, then just check speakers
  (async function () {
    await probeMic();
    await checkDevicesLight();
  })();

  // Lightweight poll every 5s — only checks speakers, does NOT touch the mic
  setInterval(function () {
    if (inCall) {
      syncWithDaily();
    }
    checkDevicesLight();
  }, 5000);
})();
