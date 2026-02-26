/* sca-particles.js
   Particle overlay for #sca-particles-canvas
   - No halo/mist, particles only
   - Matches plasma palette (blue / cyan / purple)
   - Listens to window "vp:ui" events (idle/listening/thinking/talking)
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  const ORB = {
    mode: "idle",
    glow: 0.25,

    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,

    baseScale: 1,

    tick: 0,
    animationId: null,
    particles: []
  };

  // Spread controls (unchanged)
  const ORB_INNER_NORM  = 0.85;
  const ORB_CENTER_NORM = 1.05;
  const ORB_OUTER_NORM  = 1.20;
  const ORB_CENTER_BIAS = 2.6;

  // Plasma-matching palette (RGBA components without alpha)
  const PALETTE = {
    blue:  [13, 102, 255],   // deep vibrant blue
    cyan:  [189, 219, 250],  // soft icy cyan (visible, not neon)
    purp:  [187, 92, 255],   // purple accent
  };

  function respawn(p) {
    const angle = Math.random() * Math.PI * 2;

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

    const r = Math.random();
    p.radialAmp = 0.55 + (r * r) * 1.75;
    p.wobbleAmp = 0.004 + Math.random() * 0.018;
    p.wobbleFreq = 0.05 + Math.random() * 0.10;
    p.wobblePhase = Math.random() * Math.PI * 2;

    p.speed = 0.0008 + Math.random() * 0.002;
    p.size = 1.2 + Math.random() * 1.8;
    p.alpha = 0.2 + Math.random() * 0.55;

    p.t = 0;
    p.tSpeed = 0.004 + Math.random() * 0.0025;

    const delayMax =
      ORB.mode === "idle" ? 650 :
      ORB.mode === "listening" ? 320 :
      ORB.mode === "thinking" ? 240 :
      190;

    p.delay = Math.floor(Math.random() * delayMax);

    // Assign a base hue bias per particle (mostly blue, some cyan, a few purple)
    const pick = Math.random();
    p.hue = pick < 0.70 ? "blue" : pick < 0.92 ? "cyan" : "purp";
  }

  function seedParticles() {
    const count = 220;
    const parts = [];
    for (let i = 0; i < count; i += 1) {
      const p = {};
      respawn(p);
      p.t = Math.random();
      parts.push(p);
    }
    ORB.particles = parts;
  }

  function kickParticles() {
    const parts = ORB.particles || [];
    for (let i = 0; i < parts.length; i += 1) {
      if (Math.random() < 0.35) {
        parts[i].delay = Math.floor(Math.random() * 22);
        parts[i].t = Math.random() * 0.25;
      }
    }
  }

  function choosePulse() {
    const mode = ORB.mode;
    ORB.baseScale = 1;

    if (mode === "talking") {
      ORB.pulseTarget = 0.97 + Math.random() * 0.07;
      ORB.pulseFrames = 8 + Math.floor(Math.random() * 10);
      return;
    }
    if (mode === "thinking") {
      ORB.pulseTarget = 0.98 + Math.random() * 0.05;
      ORB.pulseFrames = 14 + Math.floor(Math.random() * 16);
      return;
    }
    if (mode === "listening") {
      ORB.pulseTarget = 0.99 + Math.random() * 0.03;
      ORB.pulseFrames = 24 + Math.floor(Math.random() * 26);
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

    const pulseLerp = talking ? 0.10 : 0.05;
    ORB.pulseValue += (ORB.pulseTarget - ORB.pulseValue) * pulseLerp;
  }

  function getGeometry(canvas) {
    const width = canvas.clientWidth || 500;
    const height = canvas.clientHeight || 500;

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

    return { cx, cy, ringRadius, width, height };
  }

  function draw() {
    const canvas = $("sca-particles-canvas");
    if (!canvas) {
      ORB.animationId = null;
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      ORB.animationId = null;
      return;
    }

    ORB.tick += 1;

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

    const { cx, cy, ringRadius } = getGeometry(canvas);

    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";
    const idle = ORB.mode === "idle";

    const movementBoost = idle ? 0 : talking ? 0.60 : (thinking || listening) ? 0.45 : 0.45;
    const alphaBoost = talking ? 0.09 : (thinking || listening) ? 0.03 : -0.03;

    const twinkleFactor =
      idle ? 0.10 :
      listening ? 0.33 :
      thinking ? 0.50 :
      talking ? 0.75 :
      0.33;

    // Slightly brighter particles when glow increases
    const glowBoost = 0.75 + 0.55 * clamp01(ORB.glow);

    for (const p of ORB.particles) {
      p.angle += p.speed * movementBoost;

      if (p.delay > 0) {
        p.delay -= 1;
        continue;
      }

      p.t += p.tSpeed * twinkleFactor;
      if (p.t >= 1) {
        respawn(p);
        continue;
      }

      const lifeAlpha = Math.sin(Math.PI * p.t);

      const pulseDelta = ORB.pulseValue - 1;
      const pulseAmp = talking ? 2.2 : thinking ? 1.5 : listening ? 1.2 : 0.9;

      const isIdle = ORB.mode === "idle";
      const wobbleAmpMul  = isIdle ? 0.7 : 1.0;
      const wobbleFreqMul = isIdle ? 0.25 : 1.0;

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

      let alpha = (p.alpha * lifeAlpha) + alphaBoost;
      alpha = Math.max(0.0, Math.min(0.92, alpha));
      if (alpha <= 0.001) continue;

      const pulseSize = 1 + Math.min(0.55, Math.abs(pulseDelta) * (talking ? 14 : 8));
      const lifeSize = 0.78 + 0.22 * lifeAlpha;

      const distFromCenter = Math.abs(p.radiusNorm - ORB_CENTER_NORM);
      const spreadHalf = Math.max(0.0001, (ORB_OUTER_NORM - ORB_INNER_NORM) * 0.5);
      const t = Math.min(1, distFromCenter / spreadHalf);
      const sizeFalloff = 1 - (0.75 * t);

      const dotRadius = p.size * pulseSize * lifeSize * sizeFalloff;

      // Choose color per particle, then nudge toward cyan/purple a bit in talking
      const base = PALETTE[p.hue];
      const cyan = PALETTE.cyan;
      const purp = PALETTE.purp;

      const talkMix = talking ? 0.22 : thinking ? 0.14 : listening ? 0.10 : 0.06;
      const alt = (p.hue === "blue") ? cyan : (p.hue === "cyan") ? purp : cyan;

      const rCol = base[0] + (alt[0] - base[0]) * talkMix;
      const gCol = base[1] + (alt[1] - base[1]) * talkMix;
      const bCol = base[2] + (alt[2] - base[2]) * talkMix;

      const a0 = alpha * glowBoost;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, dotRadius * 3.6);
      grad.addColorStop(0,   `rgba(${rCol.toFixed(0)}, ${gCol.toFixed(0)}, ${bCol.toFixed(0)}, ${a0})`);
      grad.addColorStop(0.6, `rgba(${rCol.toFixed(0)}, ${gCol.toFixed(0)}, ${bCol.toFixed(0)}, ${a0 * 0.50})`);
      grad.addColorStop(1,   "rgba(0, 0, 0, 0)");

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, dotRadius * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ORB.animationId = requestAnimationFrame(draw);
  }

  function start() {
    if (ORB.animationId) return;
    choosePulse();
    ORB.animationId = requestAnimationFrame(draw);
  }

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
    if (!document.getElementById("sca-particles-canvas")) {
      requestAnimationFrame(startWhenReady);
      return;
    }
    start();
  }

  window.addEventListener("DOMContentLoaded", startWhenReady);
})();
