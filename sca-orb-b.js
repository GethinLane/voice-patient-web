/* sca-orb.js
   Punchy electric orb for WHITE backgrounds (NO halo / NO background glow)
   - Central irregular electric-blue ring (crackly + additive)
   - Dark #253551 edge-cover donut to clean/hide avatar/canvas edge artifacts
   - Larger, brighter particles with crisp cores
   - Frequent visible streaks
   - Controlled bloom pass (screen + blur)
   - Listens to window "vp:ui" events (state + glow)

   Assumes:
   - Canvas id:  sca-orb-canvas
   - Ring element id: sca-ring
   - Avatar element: #sca-ring .sca-avatar
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x ?? 0)));

  const ORB = {
    mode: "idle",
    glow: 0.18,

    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,

    tick: 0,
    animationId: null,
    particles: []
  };

  // --- Particle distribution around the ring ---
  const ORB_INNER_NORM  = 0.86;
  const ORB_CENTER_NORM = 1.04;
  const ORB_OUTER_NORM  = 1.22;
  const ORB_CENTER_BIAS = 2.4;

  // --- Style knobs ---
  const CFG = {
    count: 260,

    // particles (larger + brighter)
    sizeMin: 2.0,
    sizeMax: 4.2,
    alphaMin: 0.32,
    alphaMax: 0.78,

    // streaks
    streakCadence: 6,     // lower = more streaks
    streakWidth: 2.0,

    // bloom
    bloomOn: true,
    bloomBlurPx: 7,
    bloomAlpha: 0.62,
    bloomRadiusMul: 2.9,

    // electric ring
    ringSteps: 120,
    ringBaseMul: 1.045,
    ringIrregularPx: 6.0,
    ringStrokeMin: 1.1,
    ringStrokeMax: 2.4,
    ringAlpha: 0.55,

    // edge cover donut
    edgeCoverAlpha: 0.23
  };

  // --- helpers for irregular ring ---
  function ringNoise(theta, tick, seed) {
    return (
      Math.sin(theta * 3.0 + tick * 0.015 + seed * 1.7) * 0.55 +
      Math.sin(theta * 7.0 - tick * 0.020 + seed * 2.9) * 0.30 +
      Math.sin(theta * 13.0 + tick * 0.010 + seed * 0.7) * 0.15
    );
  }

  function respawn(p) {
    const angle = Math.random() * Math.PI * 2;

    // Biased-to-center sampling for radiusNorm
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

    // movement personality
    const r = Math.random();
    p.radialAmp = 0.75 + (r * r) * 2.1;
    p.wobbleAmp = 0.006 + Math.random() * 0.020;
    p.wobbleFreq = 0.055 + Math.random() * 0.115;
    p.wobblePhase = Math.random() * Math.PI * 2;

    p.speed = 0.0010 + Math.random() * 0.0025;

    // Larger, brighter particles
    p.size  = CFG.sizeMin + Math.random() * (CFG.sizeMax - CFG.sizeMin);
    p.alpha = CFG.alphaMin + Math.random() * (CFG.alphaMax - CFG.alphaMin);

    // lifecycle
    p.t = 0;
    p.tSpeed = 0.0042 + Math.random() * 0.0030;

    // delay by mode
    const delayMax =
      ORB.mode === "idle" ? 520 :
      ORB.mode === "listening" ? 300 :
      ORB.mode === "thinking" ? 220 :
      170;

    p.delay = Math.floor(Math.random() * delayMax);

    // stable seed for streak cadence + ring correlation
    p.seed = Math.floor(Math.random() * 1_000_000);
  }

  function seedParticles() {
    const parts = [];
    for (let i = 0; i < CFG.count; i += 1) {
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
      if (Math.random() < 0.40) {
        parts[i].delay = Math.floor(Math.random() * 16);
        parts[i].t = Math.random() * 0.22;
      }
    }
  }

  function choosePulse() {
    const mode = ORB.mode;

    if (mode === "talking") {
      ORB.pulseTarget = 0.965 + Math.random() * 0.090;
      ORB.pulseFrames = 8 + Math.floor(Math.random() * 10);
      return;
    }
    if (mode === "thinking") {
      ORB.pulseTarget = 0.975 + Math.random() * 0.065;
      ORB.pulseFrames = 14 + Math.floor(Math.random() * 18);
      return;
    }
    if (mode === "listening") {
      ORB.pulseTarget = 0.985 + Math.random() * 0.040;
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

  function drawEdgeCover(ctx, cx, cy, width, height, avatarRadius) {
    // Dark donut to hide edge artifacts and canvas bleed on white UI
    const edge = avatarRadius;

    const coverInner = edge * 0.985;
    const coverMid   = edge * 1.06;
    const coverOuter = edge * 1.30;

    const cover = ctx.createRadialGradient(cx, cy, coverInner, cx, cy, coverOuter);
    cover.addColorStop(0.00, "rgba(37,53,81,0)");
    cover.addColorStop((coverMid - coverInner) / (coverOuter - coverInner), `rgba(37,53,81,${CFG.edgeCoverAlpha})`);
    cover.addColorStop(1.00, "rgba(37,53,81,0)");

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = cover;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function drawElectricRing(ctx, cx, cy, avatarRadius) {
    // Irregular, crackly electric-blue ring (additive)
    const baseR = avatarRadius * CFG.ringBaseMul;
    const steps = CFG.ringSteps;

    const idle = ORB.mode === "idle";
    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";

    const energy =
      idle ? 0.22 :
      listening ? 0.55 :
      thinking ? 0.70 :
      talking ? 1.00 : 0.55;

    const irregular = CFG.ringIrregularPx * energy;
    const alpha = CFG.ringAlpha * (0.70 + ORB.glow * 0.75);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let layer = 0; layer < 3; layer += 1) {
      const layerSeed = 1000 + layer * 77;
      const lw = (CFG.ringStrokeMin + Math.random() * (CFG.ringStrokeMax - CFG.ringStrokeMin)) * (layer === 0 ? 1.0 : 0.85);
      const layerR = baseR + (layer - 1) * 1.4;

      ctx.lineWidth = lw;

      if (layer === 0) ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.38})`;
      if (layer === 1) ctx.strokeStyle = `rgba(90,170,255,${alpha * 0.78})`;
      if (layer === 2) ctx.strokeStyle = `rgba(10,110,255,${alpha * 0.70})`;

      ctx.beginPath();

      let started = false;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const theta = t * Math.PI * 2;

        const n = ringNoise(theta, ORB.tick, layerSeed);
        const r = layerR + n * irregular;

        const x = cx + Math.cos(theta) * r;
        const y = cy + Math.sin(theta) * r;

        // broken segments
        const breakChance = 0.08 + layer * 0.02;
        const breaker = Math.sin(theta * 9 + ORB.tick * 0.06 + layerSeed) * 0.5 + 0.5;
        const shouldBreak = breaker < breakChance;

        if (shouldBreak) {
          if (started) {
            ctx.stroke();
            ctx.beginPath();
            started = false;
          }
          continue;
        }

        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }

      if (started) ctx.stroke();
    }

    // extra zaps
    if (!idle) {
      const zaps = 6 + Math.floor(energy * 8);
      for (let k = 0; k < zaps; k += 1) {
        const theta = (k / zaps) * Math.PI * 2 + (ORB.tick * 0.01);
        const n = ringNoise(theta, ORB.tick, 4242 + k);
        const r = baseR + n * irregular;

        const x = cx + Math.cos(theta) * r;
        const y = cy + Math.sin(theta) * r;

        const tangent = theta + Math.PI / 2;
        const len = 8 + Math.random() * 14;

        const x2 = x + Math.cos(tangent) * len;
        const y2 = y + Math.sin(tangent) * len;

        const sg = ctx.createLinearGradient(x, y, x2, y2);
        sg.addColorStop(0.0, `rgba(255,255,255,${alpha * 0.68})`);
        sg.addColorStop(0.35, `rgba(150,220,255,${alpha * 0.52})`);
        sg.addColorStop(1.0, "rgba(0,0,0,0)");

        ctx.save();
        ctx.strokeStyle = sg;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function drawParticles(ctx, cx, cy, ringRadius, movementBoost, twinkleFactor, alphaBoost, glowLift) {
    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";
    const idle = ORB.mode === "idle";

    const frameDots = [];

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of ORB.particles) {
      p.angle += p.speed * movementBoost;

      if (p.delay > 0) { p.delay -= 1; continue; }

      p.t += p.tSpeed * twinkleFactor;
      if (p.t >= 1) { respawn(p); continue; }

      const lifeAlpha = Math.sin(Math.PI * p.t);

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

      const radius = ringRadius * p.radiusNorm;
      const x = cx + Math.cos(p.angle) * radius;
      const y = cy + Math.sin(p.angle) * radius;

      let alpha = (p.alpha * lifeAlpha) + alphaBoost + glowLift;
      alpha = Math.max(0.0, Math.min(1.0, alpha));
      if (alpha <= 0.001) continue;

      const pulseSize = 1 + Math.min(0.60, Math.abs(pulseDelta) * (talking ? 15 : 10));
      const lifeSize  = 0.80 + 0.20 * lifeAlpha;

      const distFromCenter = Math.abs(p.radiusNorm - ORB_CENTER_NORM);
      const spreadHalf = Math.max(0.0001, (ORB_OUTER_NORM - ORB_INNER_NORM) * 0.5);
      const t = Math.min(1, distFromCenter / spreadHalf);
      const sizeFalloff = 1 - (0.55 * t);

      const dotRadius = p.size * 1.55 * pulseSize * lifeSize * sizeFalloff;

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

      // frequent streaks
      if (!idle && ((ORB.tick + p.seed) % CFG.streakCadence === 0)) {
        const tangent = p.angle + Math.PI / 2;
        const len = 12 + (p.seed % 16);

        const x2 = x + Math.cos(tangent) * len;
        const y2 = y + Math.sin(tangent) * len;

        const sg = ctx.createLinearGradient(x, y, x2, y2);
        sg.addColorStop(0.0, `rgba(255,255,255,${alpha * 0.95})`);
        sg.addColorStop(0.35, `rgba(160,225,255,${alpha * 0.75})`);
        sg.addColorStop(1.0, "rgba(0,0,0,0)");

        ctx.save();
        ctx.strokeStyle = sg;
        ctx.lineWidth = CFG.streakWidth;
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
    return frameDots;
  }

  function drawBloom(ctx, frameDots) {
    if (!CFG.bloomOn || !frameDots.length) return;

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.filter = `blur(${CFG.bloomBlurPx}px)`;
    ctx.globalAlpha = CFG.bloomAlpha;

    for (const d of frameDots) {
      const r = Math.max(7, d.r * CFG.bloomRadiusMul);
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

    // Anchor to ring
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

    const movementBoost = idle ? 0.05 : talking ? 0.72 : (thinking || listening) ? 0.54 : 0.45;
    const alphaBoost = talking ? 0.10 : (thinking || listening) ? 0.05 : 0.02;

    const twinkleFactor =
      idle ? 0.12 :
      listening ? 0.42 :
      thinking ? 0.58 :
      talking ? 0.86 :
      0.42;

    const glowLift = 0.06 + ORB.glow * 0.20;

    // NO background halo here:
    // 1) Edge cover donut
    drawEdgeCover(ctx, cx, cy, width, height, avatarRadius);

    // 2) Electric irregular ring
    drawElectricRing(ctx, cx, cy, avatarRadius);

    // 3) Particles + streaks
    const frameDots = drawParticles(ctx, cx, cy, ringRadius, movementBoost, twinkleFactor, alphaBoost, glowLift);

    // 4) Bloom
    drawBloom(ctx, frameDots);

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
