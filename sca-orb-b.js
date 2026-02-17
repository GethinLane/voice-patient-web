/* orb-b.js (v2)
 * Uses your existing patient card DOM:
 *   #sca-patient-card .sca-ring
 *   canvas.sca-orbCanvas  (reuse if exists, create if missing)
 *
 * API:
 *   window.setAIState("idle" | "listening" | "talking")
 *   window.stopOrbAnimation() // optional
 */

(() => {
  "use strict";

  // ------------------ Helpers: wait for DOM ------------------
  function waitForPatientCard(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();

      const tick = () => {
        const ring = document.querySelector("#sca-patient-card .sca-ring");
        if (ring) return resolve(ring);
        if (Date.now() - start > timeoutMs) return resolve(null);
        requestAnimationFrame(tick);
      };

      tick();
    });
  }

  function ensureCanvasInRing(ring) {
    let canvas =
      ring.querySelector("canvas.sca-orbCanvas") ||
      ring.querySelector("canvas");

    if (!canvas) {
      canvas = document.createElement("canvas");
      ring.appendChild(canvas);
    }

    canvas.classList.add("sca-orbCanvas");
    return canvas;
  }

  function getCssPixelSize(el) {
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    // Use square for orb
    return Math.max(w, h);
  }

  // ------------------ Orb core (your exact look) ------------------
  function createOrb(canvas, labelEl) {
    const ctx = canvas.getContext("2d");

    // Will be set on resize
    let orbW = 300, orbH = 300, orbCx = 150, orbCy = 150;

    // Radii derived from size (keeps same proportions as your snippet)
    let ORB_RADIUS = 150;
    let INNER_MAX = ORB_RADIUS * 0.8;
    let MAX_RADIUS = 200;

    const PARTICLE_COUNT = 400;

    let particles = [];
    let animId = null;

    let aiMode = "idle"; // idle | listening | talking

    // Pulse state
    let pulseValue = 1;
    let pulseTarget = 1;
    let pulseTimeLeft = 0;

    // Base scale (idle smallest, listening medium, talking biggest)
    let baseScaleCurrent = 0.55;
    let baseScaleTarget = 0.55;

    // Colours: same palette as your snippet
    let colorCurrent = { r: 140, g: 196, b: 242 }; // idle slightly lighter
    let colorTarget  = { r: 140, g: 196, b: 242 };

    function resizeToCssBox() {
      const cssPx = getCssPixelSize(canvas);
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      canvas.width = Math.round(cssPx * dpr);
      canvas.height = Math.round(cssPx * dpr);

      // Draw in CSS pixel coords
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      orbW = cssPx;
      orbH = cssPx;
      orbCx = orbW / 2;
      orbCy = orbH / 2;

      ORB_RADIUS = orbW / 2;
      INNER_MAX = ORB_RADIUS * 0.8;
      MAX_RADIUS = ORB_RADIUS * (200 / 150); // preserve 150->200 ratio

      createParticles();
    }

    function createParticles() {
      particles = [];
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const isStray = Math.random() < 0.08;

        let radius;
        if (isStray) {
          const rNorm = Math.random();
          radius = ORB_RADIUS + rNorm * (MAX_RADIUS - ORB_RADIUS);
        } else {
          const rNorm = Math.sqrt(Math.random());
          radius = rNorm * INNER_MAX;
        }

        const baseSpeed = isStray
          ? 0.0015 + Math.random() * 0.0025
          : 0.0008 + Math.random() * 0.0015;
        const baseDrift = (Math.random() - 0.5) * (isStray ? 0.06 : 0.03);

        particles.push({
          angle,
          radius,
          baseSpeed,
          baseDrift,
          baseSize: 1 + Math.random() * 1.3,
          baseAlpha: 0.3 + Math.random() * 0.6,
          stray: isStray
        });
      }
    }

    function chooseNextPulseSegment() {
      if (aiMode === "talking") {
        const isPause = Math.random() < 0.25;

        if (isPause) {
          pulseTarget = 0.82 + Math.random() * 0.08;
          pulseTimeLeft = 4 + Math.floor(Math.random() * 6);
        } else {
          pulseTarget = 0.75 + Math.random() * 0.35;
          pulseTimeLeft = 6 + Math.floor(Math.random() * 10);
        }
      } else {
        pulseTarget = 1.0;
        pulseTimeLeft = 60;
      }
    }

    function updatePulseAndScale() {
      if (pulseTimeLeft <= 0) chooseNextPulseSegment();
      pulseTimeLeft -= 1;

      const talking = aiMode === "talking";
      const lerpFactor = talking ? 0.12 : 0.04;
      pulseValue += (pulseTarget - pulseValue) * lerpFactor;

      const scaleLerp = 0.08;
      baseScaleCurrent += (baseScaleTarget - baseScaleCurrent) * scaleLerp;

      const colorLerp = talking ? 0.08 : 0.02;
      colorCurrent.r += (colorTarget.r - colorCurrent.r) * colorLerp;
      colorCurrent.g += (colorTarget.g - colorCurrent.g) * colorLerp;
      colorCurrent.b += (colorTarget.b - colorCurrent.b) * colorLerp;
    }

    function respawnInner(p) {
      p.angle = Math.random() * Math.PI * 2;
      const rNorm = Math.sqrt(Math.random());
      p.radius = rNorm * INNER_MAX;
    }

    function respawnStray(p) {
      p.angle = Math.random() * Math.PI * 2;
      const rNorm = Math.random();
      p.radius = ORB_RADIUS + rNorm * (MAX_RADIUS - ORB_RADIUS);
    }

    function drawOrb() {
      ctx.clearRect(0, 0, orbW, orbH);

      updatePulseAndScale();

      const speedFactor = aiMode === "talking" ? 1.2 : 1.0;
      const alphaBoost  = aiMode === "talking" ? 0.2 : -0.05;

      const coreR = Math.min(Math.max(colorCurrent.r, 0), 255);
      const coreG = Math.min(Math.max(colorCurrent.g, 0), 255);
      const coreB = Math.min(Math.max(colorCurrent.b, 0), 255);

      const midR  = Math.min(coreR + 40, 255);
      const midG  = Math.min(coreG + 40, 255);
      const midB  = Math.min(coreB + 40, 255);

      const outerR = Math.min(coreR + 140, 255);
      const outerG = Math.min(coreG + 140, 255);
      const outerB = Math.min(coreB + 140, 255);

      const darkColor = `rgba(${coreR}, ${coreG}, ${coreB}, 0.95)`;
      const midColor  = `rgba(${midR}, ${midG}, ${midB}, 0.6)`;
      const fadeColor = `rgba(${outerR}, ${outerG}, ${outerB}, 0.0)`;

      for (const p of particles) {
        p.angle += p.baseSpeed * speedFactor;
        p.radius += p.baseDrift * speedFactor * 0.6;

        if (!p.stray) {
          if (p.radius > INNER_MAX || p.radius < 0) respawnInner(p);
        } else {
          if (p.radius < ORB_RADIUS || p.radius > MAX_RADIUS) respawnStray(p);
        }

        const effectiveRadius = p.radius * pulseValue * baseScaleCurrent;
        const x = orbCx + Math.cos(p.angle) * effectiveRadius;
        const y = orbCy + Math.sin(p.angle) * effectiveRadius;

        const norm = Math.min(1, Math.abs(effectiveRadius) / ORB_RADIUS);

        let sizeScale = 1 - 0.7 * (norm * norm);
        sizeScale = Math.max(0.35, sizeScale);
        const size = p.baseSize * sizeScale;

        let alpha = p.baseAlpha + alphaBoost;
        alpha *= 1 - 0.3 * norm;
        alpha = Math.max(0.12, Math.min(1, alpha));

        ctx.save();
        ctx.globalAlpha = alpha;

        const r = size * 3;
        const dotGrad = ctx.createRadialGradient(x, y, 0, x, y, r);
        dotGrad.addColorStop(0.0, darkColor);
        dotGrad.addColorStop(0.6, midColor);
        dotGrad.addColorStop(1.0, fadeColor);

        ctx.fillStyle = dotGrad;
        ctx.beginPath();
        ctx.arc(x, y, size * 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      animId = requestAnimationFrame(drawOrb);
    }

    function start() {
      resizeToCssBox();
      if (!animId) {
        chooseNextPulseSegment();
        drawOrb();
      }
    }

    function stop() {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
    }

    function setAIState(mode) {
      const m = String(mode || "").trim().toLowerCase();
      aiMode = (m === "talking" || m === "listening" || m === "idle") ? m : "listening";

      if (labelEl) {
        labelEl.textContent =
          aiMode === "talking" ? "Patient speaking…" :
          aiMode === "idle"    ? "Idle…" :
                                 "Listening…";
      }

      if (aiMode === "talking") {
        // Talking expands -> more visible around portrait
        baseScaleTarget = 1.0;
        colorTarget = { r: 21, g: 101, b: 192 };
      } else if (aiMode === "idle") {
        // Smallest -> just edges peeking out
        baseScaleTarget = 0.52;
        colorTarget = { r: 140, g: 196, b: 242 };
        pulseTarget = 1.0; pulseValue = 1.0;
      } else {
        // Listening
        baseScaleTarget = 0.70;
        colorTarget = { r: 111, g: 174, b: 230 };
        pulseTarget = 1.0; pulseValue = 1.0;
      }

      chooseNextPulseSegment();
    }

    // Keep canvas in sync with layout changes
    const ro = new ResizeObserver(() => resizeToCssBox());
    ro.observe(canvas);

    return { start, stop, setAIState };
  }

  // ------------------ Boot ------------------
  async function boot() {
    const ring = await waitForPatientCard();
    if (!ring) return;

    const canvas = ensureCanvasInRing(ring);

    // label optional — if you don’t have it, just ignore
    const labelEl = document.getElementById("ai-state-label") || null;

    const orb = createOrb(canvas, labelEl);

    // Expose globals (same callsite as orb-A used)
    window.setAIState = (state) => orb.setAIState(state);
    window.stopOrbAnimation = () => orb.stop();

    orb.start();
    orb.setAIState("idle");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
