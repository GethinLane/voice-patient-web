/* sca-plasma.js
   Standalone “plasma core” orb for #sca-orb-canvas (NO deps, NO build step)
   - WebGL fragment shader (electric / professional)
   - Anchors to #sca-ring + masks around .sca-avatar
   - Listens to window "vp:ui" events with d.state = idle|listening|thinking|talking
*/

(() => {
  const $ = (id) => document.getElementById(id);
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x || 0)));

  // NEW: transition easing helpers (fixes the “hyperactive for half a second” jump)
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const mix = (a, b, t) => a + (b - a) * t;

  const STATE = {
    mode: "idle",
    glow: 0.65,
    t: 0,
    raf: null,

    // smoothed energy per mode (drives intensity, motion)
    energy: 0.15,
    energyTarget: 0.15,

    // you decided to keep alpha constant
    alpha: 1,
    alphaTarget: 1,

    // optional external glow control from vp:ui
    userGlow: 0.65,

    // NEW: eased transition state
    transStart: performance.now(),
    transDur: 260,     // ms (smooth; talking gets shorter below)
    fromEnergy: 0.15,
    toEnergy: 0.15
  };

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
    uniform float u_energy;    // 0..1
    uniform float u_glow;      // 0..1
    uniform float u_alphaMul;  // 0..1 overall transparency control (kept at 1)
    uniform vec2  u_center;    // in pixels
    uniform float u_radius;    // in pixels (avatar radius)
    uniform float u_outer;     // in pixels (outer render limit)

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
      float inner = u_radius * 0.93;   // KEEP your sizing
      float outer = u_outer;

      if (r < inner || r > outer) discard;

      float band = (r - inner) / max(1.0, (outer - inner)); // 0..1
      float a = atan(p.y, p.x);

      float spd  = mix(0.15, 1.35, u_energy);
      float turb = mix(0.65, 1.75, u_energy);

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
      intensity *= mix(0.55, 1.10, u_glow);
      intensity *= mix(0.80, 1.35, u_energy);

      float edgeSoft = smoothstep(0.0, 0.18, band) * smoothstep(1.0, 0.80, band);
      intensity *= edgeSoft;

      // Palette (ONLY CHANGE: soften cyan to ~#d6dde9, slightly brighter)
      vec3 blue  = vec3(0.10, 0.55, 1.00);
      vec3 cyan  = vec3(0.86, 0.89, 0.93);  // softer cyan/ice-blue (not neon)
      vec3 green = vec3(0.10, 1.00, 0.55);
      vec3 purp  = vec3(0.78, 0.25, 1.00);

      float h = clamp(n*0.90 + 0.12*wave, 0.0, 1.0);

      vec3 col = mix(blue, cyan, smoothstep(0.20, 0.75, h));

      float hot = smoothstep(0.55, 0.95, n) * smoothstep(0.20, 1.00, u_energy);
      col = mix(col, green, hot * 0.55);

      float streak = smoothstep(0.70, 0.98, abs(wave)) * (0.35 + 0.65*n);
      col = mix(col, purp, streak * 0.18);

      col += streak * vec3(0.15, 0.55, 1.00) * mix(0.10, 0.35, u_energy);

      float alpha = intensity;
      alpha *= smoothstep(1.0, 0.0, band);
      alpha *= smoothstep(0.0, 0.18, band);

      // kept at 1 (no alpha mode)
      alpha *= u_alphaMul;

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

  // KEEP your existing energy settings exactly
  function setEnergyForMode(mode) {
    if (mode === "talking") return 1;
    if (mode === "thinking") return 0.55;
    if (mode === "listening") return 0.3;
    return 0.08;
  }

  // keep alpha constant (as requested)
  function setAlphaForMode(mode) {
    return 1;
  }

  function start() {
    const canvas = $("sca-orb-canvas");
    if (!canvas) return;

    const gl =
      canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true }) ||
      canvas.getContext("experimental-webgl", { alpha: true, antialias: true, premultipliedAlpha: true });

    if (!gl) {
      console.warn("WebGL not available; plasma visualizer disabled.");
      return;
    }

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
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1
      ]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes      = gl.getUniformLocation(prog, "u_res");
    const uTime     = gl.getUniformLocation(prog, "u_time");
    const uEnergy   = gl.getUniformLocation(prog, "u_energy");
    const uGlow     = gl.getUniformLocation(prog, "u_glow");
    const uAlphaMul = gl.getUniformLocation(prog, "u_alphaMul");
    const uCenter   = gl.getUniformLocation(prog, "u_center");
    const uRadius   = gl.getUniformLocation(prog, "u_radius");
    const uOuter    = gl.getUniformLocation(prog, "u_outer");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    function frame() {
      const canvas = $("sca-orb-canvas");
      if (!canvas) {
        STATE.raf = null;
        return;
      }

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || 500;
      const cssH = canvas.clientHeight || 500;
      const w = Math.max(2, Math.round(cssW * dpr));
      const h = Math.max(2, Math.round(cssH * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);

      STATE.t += 1 / 60;

      // NEW: eased transition for ENERGY (prevents brief “hyperactive” burst)
      const now = performance.now();
      const tt = clamp01((now - STATE.transStart) / STATE.transDur);
      const te = easeInOut(tt);
      const energyGoal = mix(STATE.fromEnergy, STATE.toEnergy, te);

      // gentle low-pass for stability
      STATE.energy += (energyGoal - STATE.energy) * 0.06;

      const glow = clamp01(STATE.userGlow);

      const { cx, cy, ringRadius, avatarRadius } = getOrbGeometry(canvas);
      const cxp = cx * dpr;
      const cyp = cy * dpr;

      // KEEP your current sizing behaviour exactly
      const outer = (ringRadius * 1.3) * dpr;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, STATE.t);
      gl.uniform1f(uEnergy, clamp01(STATE.energy));
      gl.uniform1f(uGlow, glow);
      gl.uniform1f(uAlphaMul, 1.0); // keep alpha constant
      gl.uniform2f(uCenter, cxp, cyp);
      gl.uniform1f(uRadius, avatarRadius * dpr);
      gl.uniform1f(uOuter, outer);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      STATE.raf = requestAnimationFrame(frame);
    }

    window.addEventListener("vp:ui", (e) => {
      const d = e.detail || {};

      // compute next mode using your existing rules
      let nextMode = null;
      if (d.state) nextMode = d.state;
      else if (typeof d.status === "string" && /not connected|disconnected/i.test(d.status)) nextMode = "idle";

      // only start a transition when mode actually changes
      if (nextMode && nextMode !== STATE.mode) {
        STATE.mode = nextMode;

        // start an eased transition from current energy to the new target
        STATE.transStart = performance.now();
        STATE.transDur = (STATE.mode === "talking") ? 180 : 260; // slightly snappier into talking

        STATE.fromEnergy = STATE.energy;
        STATE.toEnergy = setEnergyForMode(STATE.mode);
      } else if (nextMode) {
        // keep target in sync even if same state repeats
        STATE.toEnergy = setEnergyForMode(STATE.mode);
      }

      if (typeof d.glow === "number") STATE.userGlow = clamp01(d.glow);
    });

    // initial targets
    STATE.fromEnergy = STATE.energy;
    STATE.toEnergy = setEnergyForMode(STATE.mode);

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
