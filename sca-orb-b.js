/* orb-b.js
 * Particle orb (same look as your provided snippet) + auto mount BEHIND the existing case image.
 *
 * Requires existing:
 *   <canvas id="ai-orb-canvas"></canvas>
 * Optional:
 *   <div id="ai-state-label"></div>
 *
 * API:
 *   window.setAIState("idle" | "listening" | "talking")
 *   window.stopOrbAnimation() // optional
 */

(() => {
  "use strict";

  // ---------- CSS injection for behind-image layering ----------
  function injectStyles() {
    if (document.getElementById("orb-b-styles")) return;
    const style = document.createElement("style");
    style.id = "orb-b-styles";
    style.textContent = `
      .orbB-wrap {
        position: relative;
        display: inline-block;
        overflow: visible; /* allow orb to protrude */
      }
      .orbB-canvas {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 1;        /* behind */
        pointer-events: none;
      }
      .orbB-portrait {
        position: relative;
        z-index: 2;        /* above orb */
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- Find the existing portrait element (Airtable-driven) ----------
  function isLikelyAirtableUrl(url) {
    const u = String(url || "");
    return (
      u.includes("airtableusercontent") ||
      u.includes("dl.airtable.com") ||
      u.includes("airtable.com")
    );
  }

  function findCaseImageElement() {
    // 1) Common explicit ids/classes (if your UI uses them)
    const direct =
      document.getElementById("caseImage") ||
      document.getElementById("patientImage") ||
      document.querySelector("[data-case-image]") ||
      document.querySelector("[data-orb-portrait]") ||
      document.querySelector(".case-image img") ||
      document.querySelector(".patient img") ||
      document.querySelector(".vp-case img") ||
      document.querySelector(".vp-patient img") ||
      document.querySelector(".patient-card img") ||
      document.querySelector(".sca-patient img");

    if (direct) return direct;

    // 2) Any <img> whose src looks like Airtable attachment URL
    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      if (isLikelyAirtableUrl(img.currentSrc || img.src)) return img;
    }

    // 3) Any element using Airtable background-image
    const els = Array.from(document.querySelectorAll("*"));
    for (const el of els) {
      const bg = getComputedStyle(el).backgroundImage || "";
      if (bg && bg !== "none" && (bg.includes("airtableusercontent") || bg.includes("dl.airtable.com"))) {
        // background-image elements are tricky to layer behind (background is behind children),
        // so prefer img. But if this is all we have, we can still use it as the "portrait layer".
        return el;
      }
    }

    return null;
  }

  // ---------- Mount canvas behind that portrait element ----------
  function ensureWrapperAndMount(canvas, portraitEl) {
    injectStyles();

    // If portrait is a background-image element (not an IMG), we still overlay canvas behind it by wrapping both.
    const isImg = portraitEl.tagName === "IMG";

    // Wrap portrait element (or its container if background image)
    let target = portraitEl;
    // If it’s a background-image element, keep it as target as-is.
    // If it’s an IMG, target is the IMG itself.

    let wrap = target.closest(".orbB-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "orbB-wrap";
      target.parentNode.insertBefore(wrap, target);
      wrap.appendChild(target);
    }

    // Mark portrait for layering
    if (isImg) target.classList.add("orbB-portrait");

    // Move canvas into the wrapper, behind the portrait
    if (canvas.parentNode !== wrap) {
      wrap.insertBefore(canvas, wrap.firstChild);
    }
    canvas.classList.add("orbB-canvas");

    return { wrap, portrait: target };
  }

  // ---------- Orb implementation (same as your snippet, but size is responsive) ----------
  function Orb(canvas, labelEl) {
    const ctx = canvas.getContext("2d");

    // Will be set by setCanvasLogicalSize()
    let orbW = 300, orbH = 300, orbCx = 150, orbCy = 150;

    // Radii derived from size (keeps proportions same as your original: 300px canvas => ORB_RADIUS 150)
    let ORB_RADIUS = 150;
    let INNER_MAX = ORB_RADIUS * 0.8;
    let MAX_RADIUS = 200;

    const PARTICLE_COUNT = 400;
    let particles = [];
    let animId = null;

    let aiMode = "listening"; // idle | listening | talking

    // Pulse state
    let pulseValue = 1;
    let pulseTarget = 1;
    let pulseTimeLeft = 0;

    // Base scale (idle/listening smaller, talking larger)
    let baseScaleCurrent = 0.7;
    let baseScaleTarget = 0.7;

    // Colors (same palette as your snippet)
    let colorCurrent = { r: 111, g: 174, b: 230 };
    let colorTarget  = { r: 111, g: 174, b: 230 };

    function setCanvasLogicalSize(cssPx) {
      // Render sharp on HiDPI while keeping drawing coordinates in CSS px
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.style.width = `${cssPx}px`;
      canvas.style.height = `${cssPx}px`;
      canvas.width = Math.round(cssPx * dpr);
      canvas.height = Math.round(cssPx * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      orbW = cssPx;
      orbH = cssPx;
      orbCx = orbW / 2;
      orbCy = orbH / 2;

      ORB_RADIUS = orbW / 2;
      INNER_MAX = ORB_RADIUS * 0.8;
      MAX_RADIUS = ORB_RADIUS * (200 / 150); // preserve original ratio (200 when ORB_RADIUS=150)

      // Recreate particles for consistent distribution at new size
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

    function draw() {
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

      animId = requestAnimationFrame(draw);
    }

    function start() {
      if (!particles.length) createParticles();
      if (!animId) {
        chooseNextPulseSegment();
        draw();
      }
    }

    function stop() {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
    }

    function setState(mode) {
      const m = String(mode || "").toLowerCase();
      aiMode = (m === "talking" || m === "listening" || m === "idle") ? m : "listening";

      if (labelEl) {
        labelEl.textContent =
          aiMode === "talking" ? "Patient speaking…" :
          aiMode === "idle"    ? "Idle…" :
                                 "Listening…";
      }

      if (aiMode === "talking") {
        baseScaleTarget = 1.0;
        colorTarget = { r: 21, g: 101, b: 192 };
      } else if (aiMode === "idle") {
        baseScaleTarget = 0.55; // smaller so only edges show
        colorTarget = { r: 140, g: 196, b: 242 }; // slightly lighter than listening
        pulseTarget = 1.0; pulseValue = 1.0;
      } else {
        baseScaleTarget = 0.7;
        colorTarget = { r: 111, g: 174, b: 230 };
        pulseTarget = 1.0; pulseValue = 1.0;
      }

      chooseNextPulseSegment();
    }

    return { start, stop, setState, setCanvasLogicalSize };
  }

  // ---------- Bootstrapping + auto-mount ----------
  function boot() {
    const canvas = document.getElementById("ai-orb-canvas");
    if (!canvas) return;

    // Label is optional
    const label = document.getElementById("ai-state-label");

    const orb = Orb(canvas, label);

    function tryMount() {
      const portrait = findCaseImageElement();
      if (!portrait) return false;

      const { wrap, portrait: p } = ensureWrapperAndMount(canvas, portrait);

      // Size canvas relative to portrait so it protrudes
      const sizeFromPortrait = () => {
        const rect = p.getBoundingClientRect();
        const base = Math.max(rect.width || 0, rect.height || 0);
        // Orb canvas should be larger than portrait so edges stick out.
        // Talking expands (baseScaleTarget=1.0) so more becomes visible.
        const cssSize = Math.max(260, Math.round(base * 1.55));
        orb.setCanvasLogicalSize(cssSize);
      };

      // Initial size
      sizeFromPortrait();

      // Keep in sync if image loads late or resizes
      if (p.tagName === "IMG" && !p.complete) {
        p.addEventListener("load", sizeFromPortrait, { once: true });
      }
      const ro = new ResizeObserver(sizeFromPortrait);
      ro.observe(p);

      // Start in idle (calm edges)
      orb.start();
      orb.setState("idle");

      // Expose globals (same as orb-A pattern, but now includes idle)
      window.setAIState = (state) => orb.setState(state);
      window.stopOrbAnimation = () => orb.stop();

      // Also expose a small debug handle
      window.__orbB = { orb, wrap, portrait: p };

      return true;
    }

    // If portrait exists now, mount immediately
    if (tryMount()) return;

    // Otherwise wait until the Airtable image is injected into the DOM
    const obs = new MutationObserver(() => {
      if (tryMount()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Fallback: still run orb even if no portrait found (won't be behind image)
    orb.setCanvasLogicalSize(300);
    orb.start();
    orb.setState("idle");
    window.setAIState = (state) => orb.setState(state);
    window.stopOrbAnimation = () => orb.stop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
