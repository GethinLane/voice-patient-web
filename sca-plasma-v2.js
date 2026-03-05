/* sca-plasma.js
   Mode-aware plasma: Standard (soft pale blue) vs Premium (deep blue-purple)
   - Reads vpMode radio buttons to pick palette
   - Standard: pale sky-blue + silver, no purple/green
   - Premium: rich navy-blue + deep purple, no cyan/green
   - Base energy stays stable; talking adds outer pulses
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  const STATE = {
    mode: "idle",
    glow: 0.65,
    t: 0,
    raf: null,

    energy: 0.50,
    energyTarget: 0.50,

    talkPulse: 0.0,
    talkPulseTarget: 0.0,

    userGlow: 0.1,

    // 0.0 = standard, 1.0 = premium (smoothly interpolated)
    planMode: 0.0,
    planModeTarget: 0.0,
  };

  /* ------------------------------------------------------------------ */
  /*  Detect standard vs premium from the vpMode radio buttons          */
  /* ------------------------------------------------------------------ */
  function readPlanMode() {
    const el = document.querySelector('input[name="vpMode"]:checked');
    const val = el ? String(el.value || "").trim().toLowerCase() : "standard";
    return val === "premium" ? 1.0 : 0.0;
  }

  function watchPlanRadios() {
    // Initial read
    STATE.planModeTarget = readPlanMode();
    STATE.planMode = STATE.planModeTarget; // snap on load

    // Listen for changes
    document.addEventListener("change", (e) => {
      if (e.target && e.target.name === "vpMode") {
        STATE.planModeTarget = readPlanMode();
      }
    });
  }

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;
    varying vec2 v_uv;

    uniform vec2  u_res;
    uniform float u_time;
    uniform float u_energy;
    uniform float u_talk;
    uniform float u_glow;
    uniform vec2  u_center;
    uniform float u_radius;
    uniform float u_outer;
    uniform float u_planMode;   // 0.0 = standard, 1.0 = premium

    float hash21(vec2 p){
      p = fract(p*vec2(123.34, 345.45));
      p += dot(p, p+34.345);
      return fract(p.x*p.y);
    }
    float noise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash21(i);
      float b = hash21(i+vec2(1.0,0.0));
      float c = hash21(i+vec2(0.0,1.0));
      float d = hash21(i+vec2(1.0,1.0));
      vec2 u = f*f*(3.0-2.0*f);
      return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
    }
    float fbm(vec2 p){
      float v = 0.0;
      float a = 0.55;
      for(int i=0;i<5;i++){
        v += a * noise(p);
        p *= 2.02;
        a *= 0.5;
      }
      return v;
    }

    void main(){
      vec2 frag = v_uv * u_res;
      vec2 p = frag - u_center;

      float r = length(p);
      float inner = u_radius * 0.9;
      float outer = u_outer;
      if (r < inner || r > outer) discard;

      float band = (r - inner) / max(1.0, (outer - inner));
      float a = atan(p.y, p.x);

      float e = smoothstep(0.0, 1.0, clamp(u_energy, 0.0, 1.0));
      float spd  = 0.85;
      float turb = mix(0.85, 1.35, e);

      vec2 q = vec2(
        cos(a*2.0 + u_time*0.7*spd),
        sin(a*2.0 - u_time*0.6*spd)
      );

      vec2 uv = p / max(1.0, outer);
      uv *= 2.2;
      uv += 0.20*q;

      float n1 = fbm(uv * (1.35 + turb) + u_time*0.25*spd);
      float n2 = fbm(uv * (2.25 + turb*0.8) - u_time*0.20*spd + vec2(10.0,3.0));
      float n  = mix(n1, n2, 0.55);

      float wave = sin((band*8.0 - u_time*1.8*spd) + n*4.0);
      float core = smoothstep(0.95, 0.05, band);

      float intensity = 0.55*core + 0.50*(1.0-band);
      intensity += 0.55*n;
      intensity += 0.20*wave;

      // --- Talking outer pulses (unchanged) ---
      float outerMask = smoothstep(0.55, 1.0, band);
      float jitter = 0.55*sin(u_time*10.0 + n*6.0) + 0.35*sin(u_time*16.0 + a*1.5) + 0.25*sin(u_time*23.0);
      float burst = smoothstep(0.15, 0.95, abs(jitter));
      float pulse = (0.35 + 0.65*burst) * u_talk;
      intensity += 0.35 * pulse * outerMask;

      intensity *= mix(0.55, 1.10, u_glow);
      intensity *= mix(0.95, 1.18, e);

      float edgeSoft = smoothstep(0.0, 0.18, band) * smoothstep(1.0, 0.80, band);
      intensity *= edgeSoft;

      /* ==========================================================
         MODE-AWARE PALETTE
         ========================================================== */

      float pm = clamp(u_planMode, 0.0, 1.0);

      // ---- STANDARD (pm = 0): pale sky-blue + silver, NO purple/green ----
      vec3 s_blue = vec3(0.53, 0.68, 0.91);   // soft sky blue
      vec3 s_cyan = vec3(0.84, 0.87, 0.91);   // ~#d6dde9 silver-blue
      vec3 s_hot  = vec3(0.68, 0.78, 0.90);   // silvery highlight (replaces green)
      vec3 s_strk = vec3(0.60, 0.72, 0.92);   // soft periwinkle (replaces purple)

      // ---- PREMIUM (pm = 1): rich deep navy-blue + purple accents ----
      vec3 p_blue = vec3(0.07, 0.20, 0.58);   // deep rich navy
      vec3 p_cyan = vec3(0.14, 0.18, 0.52);   // dark steel-blue (NOT violet)
      vec3 p_hot  = vec3(0.38, 0.12, 0.72);   // purple only on hot highlights
      vec3 p_strk = vec3(0.58, 0.12, 0.92);   // bright purple streak

      // Interpolate between palettes
      vec3 blue  = mix(s_blue, p_blue, pm);
      vec3 cyan  = mix(s_cyan, p_cyan, pm);
      vec3 hot   = mix(s_hot,  p_hot,  pm);
      vec3 strk  = mix(s_strk, p_strk, pm);

      // --- colour mixing (same logic as original) ---
      float h = clamp(n*0.90 + 0.12*wave, 0.0, 1.0);

      vec3 col = mix(blue, cyan, smoothstep(0.20, 0.75, h));

      float hotMix = smoothstep(0.55, 0.95, n) * smoothstep(0.20, 1.00, e);
      col = mix(col, hot, hotMix * 0.55);

      float streak = smoothstep(0.70, 0.98, abs(wave)) * (0.35 + 0.65*n);
      col = mix(col, strk, streak * 0.18);

      // Streak highlight: blue-tinted for standard, purple-tinted for premium
      vec3 streakGlow = mix(
        vec3(0.45, 0.60, 0.90),   // standard: soft blue glow
        vec3(0.35, 0.15, 0.85),   // premium: purple glow
        pm
      );
      col += streak * streakGlow * mix(0.10, 0.35, e);

      float alpha = intensity;
      alpha *= smoothstep(1.0, 0.0, band);
      alpha *= smoothstep(0.0, 0.18, band);
      alpha = clamp(alpha, 0.0, 0.95);

      gl_FragColor = vec4(col * alpha, alpha);
    }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }
  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn(gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  function getOrbGeometry(canvas) {
    const ringEl = document.getElementById("sca-ring");
    const ringRect = ringEl?.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    let cx = canvas.clientWidth / 2;
    let cy = canvas.clientHeight / 2;
    let ringRadius = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.5;

    if (ringRect && canvasRect) {
      cx = (ringRect.left + ringRect.width / 2) - canvasRect.left;
      cy = (ringRect.top + ringRect.height / 2) - canvasRect.top;
      ringRadius = ringRect.width / 2;
    }

    const avatarEl = document.querySelector("#sca-ring .sca-avatar");
    const avatarRect = avatarEl?.getBoundingClientRect();
    let avatarRadius = ringRadius * 0.5;
    if (avatarRect) avatarRadius = avatarRect.width / 2;

    return { cx, cy, ringRadius, avatarRadius };
  }

  function baseEnergyForMode(mode) {
    if (mode === "talking") return 0.60;
    if (mode === "thinking") return 0.50;
    if (mode === "listening") return 0.45;
    return 0.35;
  }

  function start() {
    const canvas = $("sca-orb-canvas");
    if (!canvas) return;

    const gl =
      canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true }) ||
      canvas.getContext("experimental-webgl", { alpha: true, antialias: true, premultipliedAlpha: true });

    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = link(gl, vs, fs);
    if (!prog) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes      = gl.getUniformLocation(prog, "u_res");
    const uTime     = gl.getUniformLocation(prog, "u_time");
    const uEnergy   = gl.getUniformLocation(prog, "u_energy");
    const uTalk     = gl.getUniformLocation(prog, "u_talk");
    const uGlow     = gl.getUniformLocation(prog, "u_glow");
    const uCenter   = gl.getUniformLocation(prog, "u_center");
    const uRadius   = gl.getUniformLocation(prog, "u_radius");
    const uOuter    = gl.getUniformLocation(prog, "u_outer");
    const uPlanMode = gl.getUniformLocation(prog, "u_planMode");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let lastTS = null;

    function frame(ts) {
      const canvas = $("sca-orb-canvas");
      if (!canvas) { STATE.raf = null; return; }

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || 500;
      const cssH = canvas.clientHeight || 500;
      const w = Math.max(2, Math.round(cssW * dpr));
      const h = Math.max(2, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
      gl.viewport(0, 0, w, h);

      if (lastTS == null) lastTS = ts;
      let dt = (ts - lastTS) / 1000;
      lastTS = ts;
      dt = Math.min(0.033, Math.max(0, dt));
      STATE.t += dt;

      // Smooth base energy
      STATE.energy += (STATE.energyTarget - STATE.energy) * 0.06;

      // Smooth talking pulse
      const pulseLerp = (STATE.mode === "talking") ? 0.18 : 0.12;
      STATE.talkPulse += (STATE.talkPulseTarget - STATE.talkPulse) * pulseLerp;

      // Smooth plan mode transition (~0.5s blend)
      STATE.planMode += (STATE.planModeTarget - STATE.planMode) * 0.08;

      const glow = clamp01(STATE.userGlow);
      const { cx, cy, ringRadius, avatarRadius } = getOrbGeometry(canvas);

      const cxp = Math.round(cx * dpr);
      const cyp = Math.round(cy * dpr);
      const outer = Math.round((ringRadius * 1.6) * dpr);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, STATE.t);
      gl.uniform1f(uEnergy, clamp01(STATE.energy));
      gl.uniform1f(uTalk, clamp01(STATE.talkPulse));
      gl.uniform1f(uGlow, glow);
      gl.uniform2f(uCenter, cxp, cyp);
      gl.uniform1f(uRadius, avatarRadius * dpr);
      gl.uniform1f(uOuter, outer);
      gl.uniform1f(uPlanMode, clamp01(STATE.planMode));

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      STATE.raf = requestAnimationFrame(frame);
    }

    window.addEventListener("vp:ui", (e) => {
      const d = e.detail || {};
      if (d.state) {
        STATE.mode = d.state;
      } else if (typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) {
        STATE.mode = "idle";
      }

      STATE.energyTarget = baseEnergyForMode(STATE.mode);
      STATE.talkPulseTarget = (STATE.mode === "talking") ? 1.0 : 0.0;

      if (typeof d.glow === "number") STATE.userGlow = clamp01(d.glow);
    });

    // Initial state
    STATE.energyTarget = baseEnergyForMode(STATE.mode);
    STATE.talkPulseTarget = 0.0;

    // Start watching plan radio buttons
    watchPlanRadios();

    if (!STATE.raf) STATE.raf = requestAnimationFrame(frame);
  }

  function startWhenReady() {
    if (!document.getElementById("sca-orb-canvas")) {
      requestAnimationFrame(startWhenReady);
      return;
    }
    start();
  }

  window.addEventListener("DOMContentLoaded", startWhenReady);
})();
