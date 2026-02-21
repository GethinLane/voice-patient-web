/* sca-orb.js
   Electric orb renderer for #sca-orb-canvas
   - Additive particles (lighter)
   - Hot core + tight falloff (crisp)
   - Subtle halo (no milky wash)
   - Occasional tangent streaks
   - Optional bloom pass (screen + blur)
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  const ORB = {
    mode: "idle",
    glow: 0.15,

    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,
    baseScale: 1,

    tick: 0,
    animationId: null,
    particles: []
  };

  // --- Spread controls ---
  const ORB_INNER_NORM  = 0.85;
  const ORB_CENTER_NORM = 1.05;
  const ORB_OUTER_NORM  = 1.20;
  const ORB_CENTER_BIAS = 2.6;

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

    // personality
    const r = Math.random();
    p.radialAmp = 0.55 + (r * r) * 1.75;           // ~0.55–2.30
    p.wobbleAmp = 0.004 + Math.random() * 0.018;   // 0.004–0.022
    p.wobbleFreq = 0.05 + Math.random() * 0.10;
    p.wobblePhase = Math.random() * Math.PI * 2;

    p.speed = 0.0008 + Math.random() * 0.002;
    p.size = 0.85 + Math.random() * 1.35;          // slightly smaller by default
    p.alpha = 0.25 + Math.random() * 0.55;

    // lifecycle
    p.t = 0;
    p.tSpeed = 0.004 + Math.random() * 0.0025;

    const delayMax =
      ORB.mode === "idle" ? 650 :
      ORB.mode === "listening" ? 320 :
      ORB.mode === "thinking" ? 240 :
      190;

    p.delay = Math.floor(Math.random() * delayMax);

    // stable per particle (used for streak timing)
    p.seed = Math.floor(Math.random() * 1000000);
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

  function draw() {
    const canvas = $("sca-orb-canvas");
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

    // Anchor orb to the ring element
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

    // Measure avatar circle radius (for halo sizing)
    const avatarEl = document.querySelector("#sca-ring .sca-avatar");
    const avatarRect = avatarEl?.getBoundingClientRect();
    let avatarRadius = ringRadius * 0.5;
    if (avatarRect) avatarRadius = avatarRect.width / 2;

    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";
    const idle = ORB.mode === "idle";

    const movementBoost = idle ? 0 : talking ? 0.60 : (thinking || listening) ? 0.45 : 0.45;
    const alphaBoost = talking ? 0.10 : (thinking || listening) ? 0.04 : -0.02;

    const twinkleFactor =
      idle ? 0.10 :
      listening ? 0.33 :
      thinking ? 0.50 :
      talking ? 0.75 :
      0.33;

    // ------------------------------------------------------------
    // Subtle halo (no milky wash)
    // ------------------------------------------------------------
    const edge = avatarRadius;
    const inner = edge * 0.86;      // start nearer the edge
    const bluePeak = edge * 1.03;   // tiny bit outside
    const outer = edge * 1.55;

    const mist = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    const tBlue = (bluePeak - inner) / (outer - inner);

    mist.addColorStop(0.00, "rgba(255,255,255,0)");
    mist.addColorStop(Math.max(0, Math.min(1, tBlue)), "rgba(70,140,255,0.18)");
    mist.addColorStop(1.00, "rgba(255,255,255,0)");

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // We’ll capture rendered particles for bloom pass
    const frameDots = [];

    // ------------------------------------------------------------
    // Crisp + electric particles (additive)
    // ------------------------------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

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

      const lifeAlpha = Math.sin(Math.PI * p.t); // 0→1→0

      const pulseDelta = ORB.pulseValue - 1;
      const pulseAmp = talking ? 2.2 : thinking ? 1.5 : listening ? 1.2 : 0.9;

      const wobbleAmpMul  = idle ? 0.7 : 1.0;
      const wobbleFreqMul = idle ? 0.25 : 1.0;

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
      alpha = Math.max(0.0, Math.min(0.95, alpha));
      if (alpha <= 0.001) continue;

      // Size behavior: keep smaller + sharper overall
      const pulseSize = 1 + Math.min(0.45, Math.abs(pulseDelta) * (talking ? 12 : 7));
      const lifeSize = 0.82 + 0.18 * lifeAlpha;

      const distFromCenter = Math.abs(p.radiusNorm - ORB_CENTER_NORM);
      const spreadHalf = Math.max(0.0001, (ORB_OUTER_NORM - ORB_INNER_NORM) * 0.5);
      const t = Math.min(1, distFromCenter / spreadHalf);
      const sizeFalloff = 1 - (0.65 * t);

      const dotRadius = p.size * pulseSize * lifeSize * sizeFalloff;

      // Hot core + tight glow falloff (crisp)
      const core = Math.max(0.55, dotRadius * 0.60);
      const glow = dotRadius * 2.1;

      const grad = ctx.createRadialGradient(x, y, 0, x, y, glow);
      grad.addColorStop(0.00, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(0.18, `rgba(110,180,255,${alpha * 0.95})`);
      grad.addColorStop(0.45, `rgba(30,120,255,${alpha * 0.55})`);
      grad.addColorStop(1.00, "rgba(0,0,0,0)");

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, core, 0, Math.PI * 2);
      ctx.fill();

      // Tangent streak arcs (stable flicker)
      // ~every ~15 frames per particle (varies with seed)
      if (!idle && ((ORB.tick + (p.seed % 29)) % 17 === 0)) {
        const tangent = p.angle + Math.PI / 2;
        const len = 7 + (p.seed % 9); // 7–15 px

        ctx.save();
        ctx.strokeStyle = `rgba(200,230,255,${alpha * 0.75})`;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(tangent) * len, y + Math.sin(tangent) * len);
        ctx.stroke();
        ctx.restore();
      }

      // Save for bloom pass
      frameDots.push({ x, y, alpha, r: dotRadius });
    }

    ctx.restore();

    // ------------------------------------------------------------
    // Optional bloom pass (screen + blur) — glow without mush
    // ------------------------------------------------------------
    // Tune these if you want more/less “electric haze”
    const BLOOM_ON = true;
    if (BLOOM_ON && frameDots.length) {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.filter = "blur(6px)";
      ctx.globalAlpha = 0.55;

      for (const d of frameDots) {
        const r = Math.max(2.0, d.r * 2.8);
        const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
        g.addColorStop(0.00, `rgba(90,160,255,${d.alpha * 0.60})`);
        g.addColorStop(1.00, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
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
