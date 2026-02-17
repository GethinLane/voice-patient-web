/* orb-b.js
 * Uses existing:
 *   #sca-patient-card .sca-ring
 *   canvas.sca-orbCanvas (created if missing)
 *
 * No CSS changes required.
 *
 * API:
 *   window.setAIState("idle" | "listening" | "talking")
 */

(() => {
  "use strict";

  // Wait until patient card exists
  function waitForRing(timeout = 15000) {
    return new Promise((resolve) => {
      const start = Date.now();
      function check() {
        const ring = document.querySelector("#sca-patient-card .sca-ring");
        if (ring) return resolve(ring);
        if (Date.now() - start > timeout) return resolve(null);
        requestAnimationFrame(check);
      }
      check();
    });
  }

function ensureCanvas(ring) {
  let canvas = ring.querySelector("canvas.sca-orbCanvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "sca-orbCanvas";
    ring.appendChild(canvas);
  }

  // Force stacking order entirely from JS
  ring.style.position = "relative";
  ring.style.zIndex = "3";

  const avatar = ring.querySelector(".sca-avatar");
  if (avatar) {
    avatar.style.position = "relative";
    avatar.style.zIndex = "2";
  }

  canvas.style.position = "absolute";
  canvas.style.left = "50%";
  canvas.style.top = "50%";
  canvas.style.transform = "translate(-50%, -50%)";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "1";

  return canvas;
}


  function createOrb(canvas) {
    const ctx = canvas.getContext("2d");

    let W = 300, H = 300, CX = 150, CY = 150;
    let ORB_RADIUS = 150;
    let INNER_MAX = ORB_RADIUS * 0.8;
    let MAX_RADIUS = 200;

    const PARTICLE_COUNT = 400;
    let particles = [];
    let anim = null;

    let mode = "idle";

    let pulse = 1;
    let pulseTarget = 1;
    let pulseTime = 0;

    let scale = 0.55;
    let scaleTarget = 0.55;

    let color = { r: 140, g: 196, b: 242 };
    let colorTarget = { r: 140, g: 196, b: 242 };

    function resize() {
const ringRect = canvas.parentElement.getBoundingClientRect();
const avatar = canvas.parentElement.querySelector(".sca-avatar");
const avatarRect = avatar ? avatar.getBoundingClientRect() : ringRect;

// Make orb significantly bigger than avatar
const size = Math.max(avatarRect.width, avatarRect.height) * 1.6;

      const dpr = window.devicePixelRatio || 1;

      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      W = size;
      H = size;
      CX = W / 2;
      CY = H / 2;

      ORB_RADIUS = W / 2;
      INNER_MAX = ORB_RADIUS * 0.8;
      MAX_RADIUS = ORB_RADIUS * (200 / 150);

      createParticles();
    }

    function createParticles() {
      particles = [];
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const stray = Math.random() < 0.08;

        const r = stray
          ? ORB_RADIUS + Math.random() * (MAX_RADIUS - ORB_RADIUS)
          : Math.sqrt(Math.random()) * INNER_MAX;

        particles.push({
          angle,
          radius: r,
          stray,
          baseSpeed: stray
            ? 0.0015 + Math.random() * 0.0025
            : 0.0008 + Math.random() * 0.0015,
          drift: (Math.random() - 0.5) * (stray ? 0.06 : 0.03),
          size: 1 + Math.random() * 1.3,
          alpha: 0.3 + Math.random() * 0.6
        });
      }
    }

    function nextPulse() {
      if (mode === "talking") {
        pulseTarget = 0.75 + Math.random() * 0.35;
        pulseTime = 6 + Math.random() * 10;
      } else {
        pulseTarget = 1;
        pulseTime = 60;
      }
    }

    function update() {
      if (pulseTime <= 0) nextPulse();
      pulseTime--;

      const lerp = mode === "talking" ? 0.12 : 0.04;
      pulse += (pulseTarget - pulse) * lerp;
      scale += (scaleTarget - scale) * 0.08;

      const cLerp = mode === "talking" ? 0.08 : 0.02;
      color.r += (colorTarget.r - color.r) * cLerp;
      color.g += (colorTarget.g - color.g) * cLerp;
      color.b += (colorTarget.b - color.b) * cLerp;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      update();

      for (const p of particles) {
        p.angle += p.baseSpeed;
        p.radius += p.drift * 0.6;

        if (!p.stray && (p.radius > INNER_MAX || p.radius < 0))
          p.radius = Math.sqrt(Math.random()) * INNER_MAX;

        if (p.stray && (p.radius < ORB_RADIUS || p.radius > MAX_RADIUS))
          p.radius = ORB_RADIUS + Math.random() * (MAX_RADIUS - ORB_RADIUS);

        const rEff = p.radius * pulse * scale;
        const x = CX + Math.cos(p.angle) * rEff;
        const y = CY + Math.sin(p.angle) * rEff;

        const grad = ctx.createRadialGradient(x, y, 0, x, y, p.size * 3);
        grad.addColorStop(0, `rgba(${color.r},${color.g},${color.b},0.95)`);
        grad.addColorStop(0.6, `rgba(${color.r+40},${color.g+40},${color.b+40},0.6)`);
        grad.addColorStop(1, `rgba(${color.r+140},${color.g+140},${color.b+140},0)`);

        ctx.fillStyle = grad;
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(x, y, p.size * 2.3, 0, Math.PI * 2);
        ctx.fill();
      }

      anim = requestAnimationFrame(draw);
    }

    function start() {
      resize();
      if (!anim) {
        nextPulse();
        draw();
      }
    }

    function setState(m) {
      mode = m;
      if (mode === "talking") {
        scaleTarget = 1.0;
        colorTarget = { r: 21, g: 101, b: 192 };
      } else if (mode === "listening") {
        scaleTarget = 0.7;
        colorTarget = { r: 111, g: 174, b: 230 };
      } else {
        scaleTarget = 0.52;
        colorTarget = { r: 140, g: 196, b: 242 };
      }
    }

    return { start, setState };
  }

  async function boot() {
    const ring = await waitForRing();
    if (!ring) return;

    const canvas = ensureCanvas(ring);
    const orb = createOrb(canvas);

    window.setAIState = (s) => orb.setState(s);

    orb.start();
    orb.setState("idle");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
