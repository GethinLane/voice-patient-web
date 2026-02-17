/* sca-orb.js
   Standalone orb renderer for #sca-orb-canvas
   - No dependencies on other bot-page code
   - Listens to window "vp:ui" events (same as before)
   - Particle lifecycle: fade in/out + respawn
   - Idle: no rotation, very slow fade
   - Talking: more in/out wobble + subtle size swell (NO diameter pumping)
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  const ORB = {
    mode: "idle",
    glow: 0.15,

    // per-particle in/out modulation
    pulseValue: 1,
    pulseTarget: 1,
    pulseFrames: 0,

    // keep overall size constant
    baseScale: 1,

    tick: 0,
    animationId: null,
    particles: []
  };
   
  // --- Spread controls ---
  const ORB_INNER_NORM  = 0.92;   // allow slightly inside
  const ORB_CENTER_NORM = 1.05;   // where most particles cluster
  const ORB_OUTER_NORM  = 1.20;   // allow slightly outside
  const ORB_CENTER_BIAS = 2.6;    // higher = more clustered around center

  function respawn(p) {
    const angle = Math.random() * Math.PI * 2;

    // biased-to-center sampling (more particles near ORB_CENTER_NORM)
    const u = Math.random();
    const v = Math.random();
    const mix = Math.pow((u + v) * 0.5, ORB_CENTER_BIAS);

    let radiusNorm;
    if (Math.random() < 0.55) {
      // slightly more likely to sit on/just outside the center band
      radiusNorm = ORB_CENTER_NORM + mix * (ORB_OUTER_NORM - ORB_CENTER_NORM);
    } else {
      radiusNorm = ORB_CENTER_NORM - mix * (ORB_CENTER_NORM - ORB_INNER_NORM);
    }

    p.angle = angle;
    p.baseRadiusNorm = radiusNorm;
    p.radiusNorm = radiusNorm;

    p.radialDir = Math.random() < 0.5 ? -1 : 1;
    // NEW: per-particle movement personality (makes talking organic)
    // Most particles move modestly, a few move a lot.
    const r = Math.random();
    p.radialAmp = 0.55 + (r * r) * 1.75;     // ~0.55–2.30 (skewed toward smaller)
    p.wobbleAmp = 0.004 + Math.random() * 0.018; // 0.004–0.022
    p.wobbleFreq = 0.05 + Math.random() * 0.10;  // per-particle speed
    p.wobblePhase = Math.random() * Math.PI * 2;

    p.speed = 0.0008 + Math.random() * 0.002;
    p.size = 1.2 + Math.random() * 1.8;
    p.alpha = 0.2 + Math.random() * 0.55;

    // lifecycle (longer)
    p.t = 0;
    p.tSpeed = 0.004 + Math.random() * 0.0025;

    // delay (idle very calm)
    const delayMax =
      ORB.mode === "idle" ? 650 :
      ORB.mode === "listening" ? 320 :
      ORB.mode === "thinking" ? 240 :
      190; // talking

    p.delay = Math.floor(Math.random() * delayMax);
  }

  function seedParticles() {
    const count = 220;
    const parts = [];
    for (let i = 0; i < count; i += 1) {
      const p = {};
      respawn(p);
      p.t = Math.random(); // stagger start
      parts.push(p);
    }
    ORB.particles = parts;
  }

  function kickParticles() {
    // make some appear soon on state change
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

    // overall size does not change
    ORB.baseScale = 1;

    if (mode === "talking") {
      ORB.pulseTarget = 0.97 + Math.random() * 0.07;   // 0.97–1.04
      ORB.pulseFrames = 8 + Math.floor(Math.random() * 10);
      return;
    }
    if (mode === "thinking") {
      ORB.pulseTarget = 0.98 + Math.random() * 0.05;   // 0.98–1.03
      ORB.pulseFrames = 14 + Math.floor(Math.random() * 16);
      return;
    }
    if (mode === "listening") {
      ORB.pulseTarget = 0.99 + Math.random() * 0.03;   // 0.99–1.02
      ORB.pulseFrames = 24 + Math.floor(Math.random() * 26);
      return;
    }
    // idle
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

// --- Anchor orb to the ACTUAL ring circle (not the canvas size) ---
const ringEl = document.getElementById("sca-ring");
const ringRect = ringEl?.getBoundingClientRect();
const canvasRect = canvas.getBoundingClientRect();

// Fallback if something is missing
let cx = width / 2;
let cy = height / 2;
let ringRadius = Math.min(width, height) * 0.5;

if (ringRect && canvasRect) {
  // centre of the ring, expressed in canvas local coords
  cx = (ringRect.left + ringRect.width / 2) - canvasRect.left;
  cy = (ringRect.top + ringRect.height / 2) - canvasRect.top;

  // true circle radius is the ring size, not the canvas size (canvas includes bleed)
  ringRadius = ringRect.width / 2;
}

     // --- NEW: measure the ACTUAL avatar circle radius ---
const avatarEl = document.querySelector("#sca-ring .sca-avatar");
const avatarRect = avatarEl?.getBoundingClientRect();

let avatarRadius = ringRadius * 0.5; // fallback guess
if (avatarRect) {
  avatarRadius = avatarRect.width / 2;
}



    const talking = ORB.mode === "talking";
    const thinking = ORB.mode === "thinking";
    const listening = ORB.mode === "listening";
    const idle = ORB.mode === "idle";

    // rotation speed: idle = 0
    const movementBoost = idle ? 0 : talking ? 0.60 : (thinking || listening) ? 0.45 : 0.45;

    const alphaBoost = talking ? 0.09 : (thinking || listening) ? 0.03 : -0.03;
    const tint = 112 + Math.round(40 * ORB.glow);

    // lifecycle speed: idle very slow
    const twinkleFactor =
      idle ? 0.10 :
      listening ? 0.33 :
      thinking ? 0.50 :
      talking ? 0.75 :
      0.33;

// ---- MIST DONUT tuned so BLUE peak sits on AVATAR edge ----
// Draw BEFORE particles so blobs stay crisp on top.
const edge = avatarRadius;

// These are tuned so the strongest blue lands right on the avatar edge.
const inner = edge * 0.74;         // how far into the face the fade starts
const bluePeak = edge * 1.0;      // move outward if you want it bigger (try 1.06)
const whitePeak = edge * 1.15;     // white wash just outside the blue
const outer = edge * 1.55;         // overall size of halo; increase to make it larger

const mist = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);

const tBlue  = (bluePeak  - inner) / (outer - inner);
const tWhite = (whitePeak - inner) / (outer - inner);

mist.addColorStop(0.00, "rgba(255,255,255,0)");
// #d6dde9 = rgb(214,221,233)
mist.addColorStop(Math.max(0, Math.min(1, tBlue)),  "rgba(214,221,233,1)");
mist.addColorStop(Math.max(0, Math.min(1, tWhite)), "rgba(255,255,255,0.88)");

mist.addColorStop(1.00, "rgba(255,255,255,0)");

ctx.save();
ctx.globalCompositeOperation = "source-over";
ctx.fillStyle = mist;
ctx.fillRect(0, 0, width, height);
ctx.restore();


     
    for (const p of ORB.particles) {
      p.angle += p.speed * movementBoost;

      // lifecycle
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

      // in/out wobble
      const pulseDelta = ORB.pulseValue - 1;
      const pulseAmp = talking ? 2.2 : thinking ? 1.5 : listening ? 1.2 : 0.9;

// NEW: organic variation — some particles respond more/less to pulse
// Idle still moves, but much slower + smaller than other modes.
const isIdle = ORB.mode === "idle";
const wobbleAmpMul  = isIdle ? 0.18 : 1.0;  // 18% amplitude in idle
const wobbleFreqMul = isIdle ? 0.25 : 1.0;  // 4x slower in idle

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

      // alpha
let alpha = (p.alpha * lifeAlpha) + alphaBoost;

// allow true fade-out to invisible at end of life
alpha = Math.max(0.0, Math.min(0.92, alpha));
if (alpha <= 0.001) continue;


      // size swell (talking + lifecycle)
      const pulseSize = 1 + Math.min(0.55, Math.abs(pulseDelta) * (talking ? 14 : 8));
      const lifeSize = 0.78 + 0.22 * lifeAlpha;

      // NEW: size falloff — smaller when farther from the center band
      const distFromCenter = Math.abs(p.radiusNorm - ORB_CENTER_NORM);
      const spreadHalf = Math.max(0.0001, (ORB_OUTER_NORM - ORB_INNER_NORM) * 0.5);
      const t = Math.min(1, distFromCenter / spreadHalf);  // 0=center, 1=extremes
      const sizeFalloff = 1 - (0.45 * t);                  // 45% smaller at extremes

      const dotRadius = p.size * pulseSize * lifeSize * sizeFalloff;


      const grad = ctx.createRadialGradient(x, y, 0, x, y, dotRadius * 3.6);
      grad.addColorStop(0, `rgba(20, 101, 192, ${alpha})`);
      grad.addColorStop(0.6, `rgba(85, ${tint}, 230, ${alpha * 0.55})`);
      grad.addColorStop(1, "rgba(160, 210, 255, 0)");

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

  // Listen for voice-patient.js updates
  window.addEventListener("vp:ui", (e) => {
    const d = e.detail || {};

    // keep your existing states
    if (d.state) {
      const next = d.state;
      const changed = next !== ORB.mode;
      ORB.mode = next;
      choosePulse();
      if (changed) kickParticles();
    }

    // if disconnected, go idle
    if (!d.state && typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) {
      ORB.mode = "idle";
      choosePulse();
    }

    if (typeof d.glow === "number") ORB.glow = clamp01(d.glow);
  });

  window.addEventListener("DOMContentLoaded", start);
})();
