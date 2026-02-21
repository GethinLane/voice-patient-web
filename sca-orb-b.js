/* sca-orb.js
   Punchy electric orb renderer for #sca-orb-canvas (WHITE background tuned)
   - Larger, brighter particles
   - Crisp cores + additive glow
   - Frequent visible streaks (tangent arcs)
   - Controlled bloom pass (screen + blur) for "electric" feel
   - Subtle ring scaffold + halo (no dark vignette / no step 6)
   - Listens to window "vp:ui" events for mode + glow
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  const ORB = {
    mode: "idle",
    glow: 0.18,

    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,

    baseScale: 1,
    tick: 0,
    animationId: null,
    particles: []
  };

  // --- Distribution around the ring ---
  const ORB_INNER_NORM  = 0.86;
  const ORB_CENTER_NORM = 1.04;
  const ORB_OUTER_NORM  = 1.22;
  const ORB_CENTER_BIAS = 2.4; // cluster strength

  // --- Look & feel knobs (white background) ---
  const CONFIG = {
    count: 240,

    // particle size (larger than before)
    sizeMin: 1.9,
    sizeMax: 3.9,

    // brightness
    alphaMin: 0.30,
    alphaMax: 0.70,

    // streak frequency (lower = more)
    streakCadence: 7,

    // bloom
    bloomOn: true,
    bloomBlurPx: 7,
    bloomAlpha: 0.62,
    bloomRadiusMul: 2.9,

    // ring scaffold visibility (helps on white)
    ringLineAlpha: 0.22,
    ringOuterAlpha: 0.10
  };

  function respawn(p) {
    const angle = Math.random() * Math.PI * 2;

    // Biased-to-center sampling
    const u = Math.random();
    const v = Math.random();
    const mix = Math.pow((u + v) * 0.5, ORB_CENTER_BIAS);

    let radiusNorm;
    if (Math.random() < 0.55) {
      radiusNorm = ORB_CENTER_NORM + mix * (ORB_OUTER_NORM - ORB_CENTER_NORM);
    } else {
      radiusNorm = ORB_CENTER_NORM - mix * (ORB_CENTER_NORM - ORB_INNER_NORM);
    }

    p.angle = angle;
    p.baseRadiusNorm = radiusNorm;
    p.radiusNorm = radiusNorm;

    p.radialDir = Math.random() < 0.5 ? -1 : 1;

    // Movement personality (organic)
    const r = Math.random();
    p.radialAmp = 0.70 + (r * r) * 2.10;           // ~0.70–2.80 (skewed smaller)
    p.wobbleAmp = 0.006 + Math.random() * 0.020;   // 0.006–0.026
    p.wobbleFreq = 0.055 + Math.random() * 0.11;
    p.wobblePhase = Math.random() * Math.PI * 2;

    p.speed = 0.0010 + Math.random() * 0.0024;

    // Larger + brighter defaults
    p.size  = CONFIG.sizeMin + Math.random() * (CONFIG.sizeMax - CONFIG.sizeMin);
    p.alpha = CONFIG.alphaMin + Math.random() * (CONFIG.alphaMax - CONFIG.alphaMin);

    // Lifecycle
    p.t = 0;
    p.tSpeed = 0.0042 + Math.random() * 0.0028;

    // Delay by mode (idle calmer)
    const delayMax =
      ORB.mode === "idle" ? 520 :
      ORB.mode === "listening" ? 300 :
      ORB.mode === "thinking" ? 220 :
      170; // talking

    p.delay = Math.floor(Math.random() * delayMax);

    // Stable seed for streak cadence
    p.seed = Math.floor(Math.random() * 1_000_000);
  }

  function seedParticles() {
    const parts = [];
    for (let i = 0; i < CONFIG.count; i += 1) {
      const p = {};
      respawn(p);
      p.t = Math.random(); // stagger start
      parts.push(p);
    }
    ORB.particles = parts;
  }

  function kickParticles() {
    const parts = ORB.particles || [];
    for (let i = 0; i < parts.length; i += 1) {
      if (Math.random() < 0.38) {
        parts[i].delay = Math.floor(Math.random() * 18);
        parts[i].t = Math.random() * 0.22;
      }
    }
  }

  function choosePulse() {
    const mode = ORB.mode;

    ORB.baseScale = 1; // keep overall size constant

    if (mode === "talking") {
      ORB.pulseTarget = 0.965 + Math.random() * 0.085; // 0.965–1.05
      ORB.pulseFrames = 8 + Math.floor(Math.random() * 10);
      return;
    }
    if (mode === "thinking") {
      ORB.pulseTarget = 0.975 + Math.random() * 0.060; // 0.975–1.035
      ORB.pulseFrames = 14 + Math.floor(Math.random() * 18);
      return;
    }
    if (mode === "listening") {
      ORB.pulseTarget = 0.985 + Math.random() * 0.040; // 0.985–1.025
      ORB.pulseFrames = 24 + Math.floor(Math.random() * 28);
      return;
    }

    ORB.pulseTarget = 1;
    ORB.pulseFrames = 60;
  }

  function updateDynamics() {
    if (ORB.pulseFrames <= 0) choosePulse();
    ORB.pulseFrames -= 1;

    const talking = ORB.mode === "talking";
    const idle = ORB.mode === "idle";

    if (idle) {
      ORB.pulseValue = 1;
      return;
    }

    const pulseLerp = talking ? 0.12 : 0.06;
    ORB.pulseValue += (ORB.pulseTarget - ORB.pulseValue) * pulseLerp;
  }

  function draw() {
    const canvas = $("sca-orb-canvas");
    if (!canvas) { ORB.animationId = null; return; }

    const ctx = canvas.getContext("2d");
    if (!ctx) { ORB.animationId = null; return; }

    ORB.tick += 1;

    // DPR scaling
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || 500;
    const height = canvas.clientHeight || 500;

    const nextW = Math.round(width * dpr);
    const nextH = Math.round(height * dpr);
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!ORB.particles.length) seedParticles();
    updateDynamics();

    // Anchor to ring element (true center/radius)
    const ringEl = document.getElementById("sca-ring");
    const ringRect = ringEl?.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    let cx = width / 2;
    let cy = height / 2;
    let ringRadius = Math.min(width, height) * 0.5;

    if (ringRect && canvasRect) {
      cx = (ringRect.left + ringRect.width / 2) - canvasRect.left;
      cy = (ringRect.top + ringRect.height / 2) - canvasRect.top;
      ringRadius = ringRect.width / 2;
    }

    // Avatar radius
    const avatarEl = document.querySelector("#sca-ring .sca-avatar");
    const avatarRect = avatarEl?.getBoundingClientRect();
    let avatarRadius = ringRadius * 0.5;
    if (avatarRect) avatarRadius = avatarRect.width / 2;

    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";
    const idle = ORB.mode === "idle";

    // Motion/energy by mode
    const movementBoost = idle ? 0.05 : talking ? 0.70 : (thinking || listening) ? 0.52 : 0.45;

    // Alpha lift tuned for white background
    const alphaBoost = talking ? 0.10 : (thinking || listening) ? 0.05 : 0.02;

    // lifecycle speed
    const twinkleFactor =
      idle ? 0.12 :
      listening ? 0.40 :
      thinking ? 0.56 :
      talking ? 0.82 :
      0.40;

    // Slight user-driven glow (from vp:ui)
    const glowLift = 0.06 + ORB.glow * 0.20;

    // ------------------------------------------------------------
    // 1) Ring scaffold + halo (helps readability on white)
    // ------------------------------------------------------------
    const edge = avatarRadius;

    // ring line (subtle navy)
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(18,55,120,${CONFIG.ringLineAlpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, edge * 1.02, 0, Math.PI * 2);
    ctx.stroke();

    // faint outer light
    ctx.lineWidth = 4.0;
    ctx.strokeStyle = `rgba(50,120,255,${CONFIG.ringOuterAlpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, edge * 1.06, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // subtle halo (blue lift, no milky wash)
    const inner = edge * 0.92;
    const peak = edge * 1.05;
    const outer = edge * 1.55;

    const halo = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    const tPeak = (peak - inner) / (outer - inner);

    halo.addColorStop(0.00, "rgba(255,255,255,0)");
    halo.addColorStop(Math.max(0, Math.min(1, tPeak)), `rgba(60,140,255,${0.14 + ORB.glow * 0.12})`);
    halo.addColorStop(1.00, "rgba(255,255,255,0)");

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Collect dots for bloom
    const frameDots = [];

    // ------------------------------------------------------------
    // 2) Crisp particle cores (additive)
    // ------------------------------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of ORB.particles) {
      p.angle += p.speed * movementBoost;

      if (p.delay > 0) { p.delay -= 1; continue; }

      p.t += p.tSpeed * twinkleFactor;
      if (p.t >= 1) { respawn(p); continue; }

      const lifeAlpha = Math.sin(Math.PI * p.t);

      // in/out wobble
      const pulseDelta = ORB.pulseValue - 1;
      const pulseAmp = talking ? 2.4 : thinking ? 1.7 : listening ? 1.35 : 1.05;

      const wobbleAmpMul  = idle ? 0.75 : 1.0;
      const wobbleFreqMul = idle ? 0.30 : 1.0;

      const wobble =
        Math.sin(ORB.tick * (p.wobbleFreq * wobbleFreqMul) + p.wobblePhase + p.angle * 3.7) *
        (p.wobbleAmp * wobbleAmpMul);

      const effectiveNorm =
        p.baseRadiusNorm +
        (p.radialDir * pulseDelta * pulseAmp * p.radialAmp) +
        wobble;

      p.radiusNorm = Math.max(ORB_INNER_NORM, Math.min(ORB_OUTER_NORM, effectiveNorm));

      const radius = ringRadius * p.radiusNorm * ORB.baseScale;
      const x = cx + Math.cos(p.angle) * radius;
      const y = cy + Math.sin(p.angle) * radius;

      // brighter on white
      let alpha = (p.alpha * lifeAlpha) + alphaBoost + glowLift;
      alpha = Math.max(0.0, Math.min(1.0, alpha));
      if (alpha <= 0.001) continue;

      // size swell + less harsh falloff (keeps particles large)
      const pulseSize = 1 + Math.min(0.60, Math.abs(pulseDelta) * (talking ? 15 : 10));
      const lifeSize  = 0.80 + 0.20 * lifeAlpha;

      const distFromCenter = Math.abs(p.radiusNorm - ORB_CENTER_NORM);
      const spreadHalf = Math.max(0.0001, (ORB_OUTER_NORM - ORB_INNER_NORM) * 0.5);
      const t = Math.min(1, distFromCenter / spreadHalf);
      const sizeFalloff = 1 - (0.55 * t);

      const dotRadius = p.size * 1.55 * pulseSize * lifeSize * sizeFalloff;

      // crisp core + tight glow
      const core = Math.max(1.35, dotRadius * 0.78);
      const glow = dotRadius * 2.6;

      const g = ctx.createRadialGradient(x, y, 0, x, y, glow);
      g.addColorStop(0.00, `rgba(255,255,255,${alpha})`);
      g.addColorStop(0.14, `rgba(140,210,255,${alpha * 0.97})`);
      g.addColorStop(0.38, `rgba(20,110,255,${alpha * 0.68})`);
      g.addColorStop(1.00, "rgba(0,0,0,0)");

      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, core, 0, Math.PI * 2);
      ctx.fill();

      // streaks (tangent arcs) — frequent & visible
      if (!idle && ((ORB.tick + p.seed) % CONFIG.streakCadence === 0)) {
        const tangent = p.angle + Math.PI / 2;
        const len = 11 + (p.seed % 15); // 11–25 px

        const x2 = x + Math.cos(tangent) * len;
        const y2 = y + Math.sin(tangent) * len;

        const sg = ctx.createLinearGradient(x, y, x2, y2);
        sg.addColorStop(0.0, `rgba(255,255,255,${alpha * 0.95})`);
        sg.addColorStop(0.35, `rgba(160,225,255,${alpha * 0.75})`);
        sg.addColorStop(1.0, "rgba(0,0,0,0)");

        ctx.save();
        ctx.strokeStyle = sg;
        ctx.lineWidth = 1.9;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }

      frameDots.push({ x, y, alpha, r: dotRadius });
    }

    ctx.restore();

    // ------------------------------------------------------------
    // 3) Bloom pass (screen + blur) — makes it feel electric
    // ------------------------------------------------------------
    if (CONFIG.bloomOn && frameDots.length) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.filter = `blur(${CONFIG.bloomBlurPx}px)`;
      ctx.globalAlpha = CONFIG.bloomAlpha;

      for (const d of frameDots) {
        const r = Math.max(7, d.r * CONFIG.bloomRadiusMul);
        const bg = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
        bg.addColorStop(0.00, `rgba(80,150,255,${d.alpha * 0.55})`);
        bg.addColorStop(0.50, `rgba(30,120,255,${d.alpha * 0.22})`);
        bg.addColorStop(1.00, "rgba(0,0,0,0)");

        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.filter = "none";
      ctx.restore();
    }

    ORB.animationId = requestAnimationFrame(draw);
  }

  function start() {
    if (ORB.animationId) return;
    choosePulse();
    ORB.animationId = requestAnimationFrame(draw);
  }

  // Listen for voice-patient.js updates
  window.addEventListener("vp:ui", (e) => {
    const d = e.detail || {};

    if (d.state) {
      const next = d.state;
      const changed = next !== ORB.mode;
      ORB.mode = next;
      choosePulse();
      if (changed) kickParticles();
    }

    if (!d.state && typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) {
      ORB.mode = "idle";
      choosePulse();
    }

    if (typeof d.glow === "number") ORB.glow = clamp01(d.glow);
  });

  function startWhenReady() {
    if (!document.getElementById("sca-orb-canvas")) {
      requestAnimationFrame(startWhenReady);
      return;
    }
    start();
  }

  window.addEventListener("DOMContentLoaded", startWhenReady);
})();
