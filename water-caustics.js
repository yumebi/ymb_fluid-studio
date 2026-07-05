/*
 * WaterCaustics - WebGL2 fullscreen "looking down into a shallow pool"
 * caustics effect. Dependency-free, embeddable via a single script tag.
 *
 * All math below is original: the height field is a hand-tuned sum of
 * directional sine waves plus a small hash/value-noise function, the
 * caustic brightness is estimated from the screen-space Jacobian of a
 * refracted-ray sample (a local "how much did neighboring rays converge"
 * measure built from dFdx/dFdy), and the ripple/depth/god-ray terms are
 * simple original composites on top. No shader code or algorithm was
 * copied from any third party; there is no attribution requirement.
 *
 * Usage (auto-init):
 *   <div data-water-caustics data-mode="cursor" data-background="light"
 *        data-color-a="#bfe6e4" data-color-b="#4f9ea8"></div>
 *   <script src="water-caustics.js"></script>
 *
 * Usage (manual):
 *   var fx = new WaterCaustics(canvasOrSelector, { mode: 'ambient' });
 *   fx.setMode('cursor'); fx.setColors('#bfe6e4', '#4f9ea8');
 *   fx.setBackground('dark'); fx.destroy();
 *
 * Modes:
 *   'cursor'  - pointer spawns expanding damped ring ripples that distort
 *               the surface height field. Each ripple is a discrete "water
 *               drop": once spawned it is anchored at the position it was
 *               created at and only its radius/fade evolve afterward - it
 *               never follows the pointer, so cursor mode reads as ripples
 *               appearing on the water rather than a creature trailing the
 *               mouse. Movement spawns a new ripple roughly every 150ms of
 *               dwell time OR every ~0.35 world units of travel (whichever
 *               comes first), so a slow hover still drips steadily while a
 *               fast sweep does not spam an unbroken dense trail.
 *               pointerdown always spawns one larger/stronger ring
 *               immediately. Up to ~10 concurrent ripples; each expires ~3s
 *               after it starts.
 *   'ambient' - waves + noise only, no pointer interaction.
 *
 * background 'dark' | 'light' (default 'light'):
 *   'dark'  - deep pool at night: darker tints, brighter caustic webs.
 *   'light' - bright day spa: airy pale aqua, caustics read as soft
 *             white webs on the surface.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, pointermove never spawns
 *     ripples at all; only pointerdown does (down-only "tap the water").
 *     Ripples that already exist still expire normally.
 *   pointerEmit ('move' default | 'click') - when 'click', pointermove
 *     alone produces nothing (no ripple, no distortion) until the pointer
 *     is held down; dragging while down still spawns via the normal move
 *     cadence. Applies on top of pointerTrail (both must allow it).
 *
 * Runtime tuning:
 *   Named setters - setWaveHeight(0..1), setWaveSpeed(0.1..3),
 *   setCausticStrength(0..3), setCausticScale(0.3..4), setChromatic(0..1),
 *   setRayStrength(0..1), setRippleStrength(0..2), setColors(hexA, hexB),
 *   setMode('cursor'|'ambient'), setBackground('dark'|'light'),
 *   setPointerTrail(bool), setPointerEmit('move'|'click').
 *   Or bulk: setParams({ mode, background, colorA, colorB, waveHeight,
 *   waveSpeed, causticStrength, causticScale, chromatic, rayStrength,
 *   rippleStrength, pointerTrail, pointerEmit }) - unknown/absent keys are
 *   ignored, values are clamped.
 *
 * Auto-init data attributes (on the [data-water-caustics] element):
 *   data-mode, data-background, data-color-a, data-color-b,
 *   data-wave-height, data-wave-speed, data-caustic-strength,
 *   data-caustic-scale, data-chromatic, data-ray-strength,
 *   data-ripple-strength, data-pointer-trail, data-pointer-emit
 */
(function (global) {
  'use strict';

  var MAX_RIPPLES = 10;
  var RIPPLE_LIFETIME = 3.0;

  // ---------------------------------------------------------------------
  // Shader sources
  // ---------------------------------------------------------------------

  var VERT_SRC = [
    '#version 300 es',
    'void main() {',
    '  vec2 p[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));',
    '  gl_Position = vec4(p[gl_VertexID], 0.0, 1.0);',
    '}'
  ].join('\n');

  // Fullscreen caustics shader. Everything happens in one pass:
  //  1. build a surface height field from directional sine waves + value
  //     noise + active pointer ripples,
  //  2. differentiate it analytically for the surface normal,
  //  3. refract a straight-down light ray through that normal and see
  //     where it lands on the (imaginary) pool floor,
  //  4. use screen-space derivatives of that landing point to estimate
  //     ray density (caustic brightness) - converging rays make the
  //     Jacobian determinant shrink, so brightness ~ 1 / |det J|,
  //  5. composite depth tint, chromatic fringing and soft god-rays.
  var FRAG_SRC = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 fragColor;',
    'uniform vec2 uResolution;',
    'uniform float uTime;',
    'uniform float uWaveHeight;',
    'uniform float uWaveSpeed;',
    'uniform float uCausticStrength;',
    'uniform float uCausticScale;',
    'uniform float uChromatic;',
    'uniform float uRayStrength;',
    'uniform float uLightBg;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform int uRippleCount;',
    'uniform vec4 uRipples[' + MAX_RIPPLES + '];', // x, y, startTime (seconds), per-ripple strength
    'uniform float uRippleStrength;',

    // ---- small original hash / value-noise ----------------------------
    'float hash12(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.10312);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float valueNoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  float a = hash12(i);',
    '  float b = hash12(i + vec2(1.0, 0.0));',
    '  float c = hash12(i + vec2(0.0, 1.0));',
    '  float d = hash12(i + vec2(1.0, 1.0));',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    // two-octave fbm, kept cheap on purpose (this is a spa effect, not a storm)
    'float fbm(vec2 p) {',
    '  float v = 0.0;',
    '  v += valueNoise(p) * 0.6;',
    '  v += valueNoise(p * 2.13 + 11.7) * 0.4;',
    '  return v;',
    '}',

    // ---- directional wave bank -----------------------------------------
    // 6 seeded directional sine waves, varied direction/wavelength/speed
    // so the pattern never repeats obviously across the pool surface.
    'const int NUM_WAVES = 6;',
    'const vec2 WAVE_DIR[6] = vec2[6](',
    '  vec2(0.83, 0.55), vec2(-0.62, 0.79), vec2(0.31, -0.95),',
    '  vec2(-0.94, -0.34), vec2(0.15, 0.99), vec2(-0.71, 0.41)',
    ');',
    'const float WAVE_FREQ[6] = float[6](1.7, 2.6, 3.4, 4.8, 6.3, 8.1);',
    'const float WAVE_SPD[6]  = float[6](0.7, 0.55, 0.9, 0.5, 1.1, 0.65);',
    'const float WAVE_AMP[6]  = float[6](1.0, 0.75, 0.55, 0.4, 0.28, 0.18);',
    'const float WAVE_PHASE[6] = float[6](0.0, 1.9, 4.1, 2.4, 5.6, 0.8);',

    // Height field h(p, t). Kept as a plain function (not inlined per
    // wave) so the ripple contribution can share the same evaluation
    // used for both the height and its finite-difference derivatives.
    'float rippleHeight(vec2 p, float t) {',
    '  float sum = 0.0;',
    '  for (int i = 0; i < ' + MAX_RIPPLES + '; i++) {',
    '    if (i >= uRippleCount) break;',
    '    vec4 rp = uRipples[i];',
    '    float age = t - rp.z;',
    '    if (age < 0.0 || age > ' + RIPPLE_LIFETIME.toFixed(1) + ') continue;',
    '    float dist = length(p - rp.xy);',
    '    float front = age * 0.35;',
    '    float band = dist - front;',
    // Ring spatial frequency is kept low enough (wavelength ~0.8 world units)
    // that the caustic normal's finite-difference epsilon (~0.2-0.3 world
    // units, see causticBrightness) can actually resolve the slope - a
    // higher frequency here would alias against that fixed sampling step
    // and the ripple would barely register in the refracted-normal Jacobian
    // even though the height field technically contains it.
    '    float envelope = exp(-band * band * 9.0) * exp(-age * 0.75);',
    '    float ring = sin(band * 8.0 - age * 2.0);',
    '    sum += ring * envelope * rp.w;',
    '  }',
    '  return sum * uRippleStrength;',
    '}',

    'float surfaceHeight(vec2 p, float t) {',
    '  float h = 0.0;',
    '  for (int i = 0; i < NUM_WAVES; i++) {',
    '    float phase = dot(WAVE_DIR[i], p) * WAVE_FREQ[i] + t * uWaveSpeed * WAVE_SPD[i] + WAVE_PHASE[i];',
    '    h += sin(phase) * WAVE_AMP[i];',
    '  }',
    '  h *= 0.14;', // normalize the wave-bank sum into a gentle range
    '  h += (fbm(p * 0.6 + t * 0.03 * uWaveSpeed) - 0.5) * 0.5;',
    '  h *= uWaveHeight;',
    '  h += rippleHeight(p, t);',
    '  return h;',
    '}',

    // Analytic-ish normal via central differences of the height field -
    // cheap and stable, avoids the need for a second render pass.
    'vec3 surfaceNormal(vec2 p, float t, float eps) {',
    '  float hl = surfaceHeight(p - vec2(eps, 0.0), t);',
    '  float hr = surfaceHeight(p + vec2(eps, 0.0), t);',
    '  float hd = surfaceHeight(p - vec2(0.0, eps), t);',
    '  float hu = surfaceHeight(p + vec2(0.0, eps), t);',
    '  vec3 n = normalize(vec3((hl - hr) / (2.0 * eps), (hd - hu) / (2.0 * eps), 1.0));',
    '  return n;',
    '}',

    // Refract a straight-down ray through the local normal and project
    // where it would land on a floor plane a fixed distance below -
    // this is the "ray landing position" whose screen-space derivative
    // (Jacobian) tells us how much light bunched up or spread out.
    'vec2 refractedLanding(vec2 p, float t, float eps, float floorDist, float ior) {',
    '  vec3 n = surfaceNormal(p, t, eps);',
    '  vec3 incident = vec3(0.0, 0.0, -1.0);',
    '  vec3 r = refract(incident, n, 1.0 / ior);',
    '  if (dot(r, r) < 1e-6) r = incident;',
    '  vec2 offset = r.xy / max(abs(r.z), 0.001) * floorDist;',
    '  return p + offset;',
    '}',

    // Ray-density estimate: compare how much the refracted landing point
    // spreads across neighboring pixels (ddx/ddy of `landing`) against
    // how much the *undistorted* ray position spreads across the same
    // pixels (ddx/ddy of `p`). That ratio is scale-invariant - it reads
    // as 1.0 for a flat surface (no focusing) and grows where rays
    // converge, independent of zoom level or screen resolution.
    'float causticBrightness(vec2 p, float t, float scale) {',
    '  float eps = 0.35 / uCausticScale / max(scale, 0.001);',
    '  vec2 landing = refractedLanding(p, t, eps, 1.0, 1.34);',
    '  vec2 ddxL = dFdx(landing);',
    '  vec2 ddyL = dFdy(landing);',
    '  vec2 ddxP = dFdx(p);',
    '  vec2 ddyP = dFdy(p);',
    '  float detJ = abs(ddxL.x * ddyL.y - ddxL.y * ddyL.x);',
    '  float detFlat = abs(ddxP.x * ddyP.y - ddxP.y * ddyP.x);',
    '  detFlat = max(detFlat, 1e-8);',
    '  float ratio = detFlat / max(detJ, 1e-8);',
    '  float bright = pow(clamp(ratio, 0.0, 400.0) / 400.0, 0.6) * 3.2;',
    '  return clamp(bright, 0.0, 3.2);',
    '}',

    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution;',
    '  float aspect = uResolution.x / uResolution.y;',
    '  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * uCausticScale * 2.5;',
    '  float t = uTime;',

    // large-scale depth field: slow, low-frequency noise decides where
    // the pool reads as "shallow" (colorA) vs "deep" (colorB).
    '  float depth = fbm(p * 0.18 + vec2(3.1, -1.7) + t * 0.01);',
    '  vec3 base = mix(uColorA, uColorB, smoothstep(0.25, 0.85, depth));',

    // caustics: primary sample plus two chromatically-offset/scaled
    // samples for a soft, elegant RGB fringe (not a glitch-style split).
    '  float cR = causticBrightness(p, t, 1.0 + uChromatic * 0.05);',
    '  float cG = causticBrightness(p, t, 1.0);',
    '  float cB = causticBrightness(p, t, 1.0 - uChromatic * 0.05);',
    '  vec3 caustic = vec3(cR, cG, cB) * uCausticStrength;',

    // soft diagonal god-ray streaks: very low frequency, low contrast,
    // modulated gently over time so they drift rather than flicker.
    '  float rayCoord = (p.x * 0.35 + p.y * 0.9) - t * 0.05 * uWaveSpeed;',
    '  float rays = pow(0.5 + 0.5 * sin(rayCoord * 2.0), 6.0);',
    '  rays *= 0.5 + 0.5 * fbm(p * 0.25 - t * 0.02);',
    '  vec3 rayColor = mix(vec3(1.0), uColorA, 0.3) * rays * uRayStrength;',

    '  vec3 color = base + caustic * mix(uColorA, vec3(1.0), uLightBg * 0.6 + 0.2) + rayColor;',

    // dark-background profile: deepen the base tint and let caustics
    // read brighter/whiter against it (moonlit-pool feel).
    '  color = mix(color * mix(vec3(0.45, 0.5, 0.55), vec3(1.0), uLightBg), color, uLightBg);',

    '  color = clamp(color, 0.0, 1.6);',
    '  fragColor = vec4(color, 1.0);',
    '}'
  ].join('\n');

  // ---------------------------------------------------------------------
  // Small helpers (kept local, no globals leaked)
  // ---------------------------------------------------------------------

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexToRgb01(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('WaterCaustics shader compile error: ' + log);
    }
    return sh;
  }

  function createProgram(gl, vertSrc, fragSrc) {
    var prog = gl.createProgram();
    var vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('WaterCaustics program link error: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    var wrap = { program: prog, uniforms: {} };
    var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(prog, i);
      var name = info.name.replace(/\[0\]$/, '');
      wrap.uniforms[name] = gl.getUniformLocation(prog, name);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------

  function WaterCaustics(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('WaterCaustics: target not found');
    var canvas = el;
    if (el.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      el.appendChild(canvas);
    }
    this.canvas = canvas;
    this.host = el;

    this.mode = options.mode === 'ambient' ? 'ambient' : 'cursor';
    this.background = options.background === 'dark' ? 'dark' : 'light';
    this._hexA = options.colorA || '#bfe6e4';
    this._hexB = options.colorB || '#4f9ea8';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);

    this.waveHeight = options.waveHeight != null ? clamp(options.waveHeight, 0, 1) : 0.45;
    this.waveSpeed = options.waveSpeed != null ? clamp(options.waveSpeed, 0.1, 3) : 0.6;
    this.causticStrength = options.causticStrength != null ? clamp(options.causticStrength, 0, 3) : 1.1;
    this.causticScale = options.causticScale != null ? clamp(options.causticScale, 0.3, 4) : 1.3;
    this.chromatic = options.chromatic != null ? clamp(options.chromatic, 0, 1) : 0.35;
    this.rayStrength = options.rayStrength != null ? clamp(options.rayStrength, 0, 1) : 0.12;
    this.rippleStrength = options.rippleStrength != null ? clamp(options.rippleStrength, 0, 2) : 1.35;
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';
    this._pointerDown = false;

    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) {
      console.warn('WaterCaustics: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;
    gl.getExtension('OES_standard_derivatives'); // no-op on WebGL2 (core), kept defensive

    this._prog = createProgram(gl, VERT_SRC, FRAG_SRC);
    this._vao = gl.createVertexArray();

    this._ripples = [];
    this._time = 0;
    this._lastFrameTime = 0;
    this._raf = null;
    this._paused = false;
    this._destroyed = false;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._tick = this._tick.bind(this);

    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(canvas);
    }

    this._allocate();
    this._raf = requestAnimationFrame(this._tick);
  }

  // ---------------------------------------------------------------------
  // Sizing
  // ---------------------------------------------------------------------

  WaterCaustics.prototype._allocate = function () {
    var gl = this.gl;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.dpr = dpr;
    var w = Math.max(1, Math.round((rect.width || this.canvas.clientWidth || 300) * dpr));
    var h = Math.max(1, Math.round((rect.height || this.canvas.clientHeight || 150) * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
  };

  // ---------------------------------------------------------------------
  // Ripples (cursor mode)
  // ---------------------------------------------------------------------

  WaterCaustics.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var aspect = rect.width / rect.height;
    var x = ((e.clientX - rect.left) / rect.width - 0.5) * aspect * this.causticScale * 2.5;
    var y = (1.0 - (e.clientY - rect.top) / rect.height - 0.5) * this.causticScale * 2.5;
    return { x: x, y: y };
  };

  WaterCaustics.prototype._addRipple = function (pt, strength) {
    if (this.mode !== 'cursor') return;
    if (this._ripples.length >= MAX_RIPPLES) this._ripples.shift();
    // Each ripple is a self-contained record (position, birth time,
    // strength) - once spawned it never moves and never re-anchors to the
    // pointer. That is what makes it read as a water drop rather than a
    // creature trailing the cursor: the ring's centre is frozen at the
    // instant it was created, and only its radius/fade evolve afterward
    // (see rippleHeight() in the fragment shader, which keys purely off
    // `age = t - start`).
    this._ripples.push({ x: pt.x, y: pt.y, start: this._time, strength: strength });
  };

  // Move-driven ripple spawning: a discrete "drop" every ~150ms of dwell
  // time OR every MOVE_SPAWN_DIST world units of cursor travel, whichever
  // comes first, so a slow-moving pointer still gets a steady drip while a
  // fast sweep does not spam a dense overlapping trail. This intentionally
  // does NOT track/redraw a ripple at the pointer's current position each
  // frame - once spawned, a ring is anchored (see _addRipple).
  var MOVE_SPAWN_INTERVAL = 0.15; // seconds
  var MOVE_SPAWN_DIST = 0.35;     // world units (post causticScale transform)

  WaterCaustics.prototype._onPointerMove = function (e) {
    if (this.mode !== 'cursor') return;
    if (!this.pointerTrail) return; // pointerTrail=false: move never spawns rings (down-only)
    if (this.pointerEmit === 'click' && !this._pointerDown) return; // click-to-emit: move alone does nothing
    var pt = this._normalizedPoint(e);
    this._lastMoveTime = this._lastMoveTime || 0;
    this._lastMovePt = this._lastMovePt || pt;
    var dx = pt.x - this._lastMovePt.x;
    var dy = pt.y - this._lastMovePt.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var dueByTime = this._time - this._lastMoveTime >= MOVE_SPAWN_INTERVAL;
    var dueByDist = dist >= MOVE_SPAWN_DIST;
    if (!dueByTime && !dueByDist) return;
    this._lastMoveTime = this._time;
    this._lastMovePt = pt;
    this._addRipple(pt, 0.8);
  };

  WaterCaustics.prototype._onPointerDown = function (e) {
    if (this.mode !== 'cursor') return;
    this._pointerDown = true;
    var pt = this._normalizedPoint(e);
    this._lastMovePt = pt;
    this._lastMoveTime = this._time;
    this._addRipple(pt, 1.4);
  };

  WaterCaustics.prototype._onPointerUp = function () {
    this._pointerDown = false;
  };

  // ---------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------

  WaterCaustics.prototype._pruneRipples = function () {
    var alive = [];
    for (var i = 0; i < this._ripples.length; i++) {
      var r = this._ripples[i];
      if (this._time - r.start <= RIPPLE_LIFETIME) alive.push(r);
    }
    this._ripples = alive;
  };

  WaterCaustics.prototype._render = function () {
    var gl = this.gl;
    this._pruneRipples();

    gl.useProgram(this._prog.program);
    var u = this._prog.uniforms;
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this._time);
    gl.uniform1f(u.uWaveHeight, this.waveHeight);
    gl.uniform1f(u.uWaveSpeed, this.waveSpeed);
    gl.uniform1f(u.uCausticStrength, this.causticStrength);
    gl.uniform1f(u.uCausticScale, this.causticScale);
    gl.uniform1f(u.uChromatic, this.chromatic);
    gl.uniform1f(u.uRayStrength, this.rayStrength);
    gl.uniform1f(u.uRippleStrength, this.rippleStrength);
    gl.uniform1f(u.uLightBg, this.background === 'light' ? 1.0 : 0.0);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);

    var n = this._ripples.length;
    gl.uniform1i(u.uRippleCount, n);
    // NOTE: createProgram() strips the trailing "[0]" off array-uniform
    // names when it builds this.uniforms (so "uRipples[0]" is stored under
    // the key "uRipples"), matching how every other single-value uniform is
    // looked up. Looking this up as u['uRipples[0]'] - as a previous version
    // of this code did - always misses, silently skips gl.uniform4fv, and
    // the ripple array never reaches the GPU at all regardless of pointer
    // input. Use the bare key.
    if (n > 0 && u.uRipples !== undefined) {
      var flat = new Float32Array(MAX_RIPPLES * 4);
      for (var i = 0; i < n; i++) {
        var r = this._ripples[i];
        flat[i * 4] = r.x;
        flat[i * 4 + 1] = r.y;
        flat[i * 4 + 2] = r.start;
        flat[i * 4 + 3] = r.strength;
      }
      gl.uniform4fv(u.uRipples, flat);
    }

    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  WaterCaustics.prototype._tick = function (now) {
    if (this._destroyed) return;
    if (this._paused || document.hidden) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    var dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    dt = clamp(dt, 0, 1 / 30);
    this._lastFrameTime = now;
    this._time += dt;

    this._render();

    this._raf = requestAnimationFrame(this._tick);
  };

  WaterCaustics.prototype._onResize = function () {
    if (this._unsupported || !this.gl) return;
    this._allocate();
  };

  WaterCaustics.prototype._onVisibility = function () {
    // Loop already checks document.hidden each frame; nothing else needed.
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  WaterCaustics.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
    if (this.mode === 'ambient') this._ripples = [];
  };

  WaterCaustics.prototype.setBackground = function (bg) {
    this.background = bg === 'dark' ? 'dark' : 'light';
  };

  WaterCaustics.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
  };

  WaterCaustics.prototype.setWaveHeight = function (v) {
    this.waveHeight = clamp(v, 0, 1);
  };

  WaterCaustics.prototype.setWaveSpeed = function (v) {
    this.waveSpeed = clamp(v, 0.1, 3);
  };

  WaterCaustics.prototype.setCausticStrength = function (v) {
    this.causticStrength = clamp(v, 0, 3);
  };

  WaterCaustics.prototype.setCausticScale = function (v) {
    this.causticScale = clamp(v, 0.3, 4);
  };

  WaterCaustics.prototype.setChromatic = function (v) {
    this.chromatic = clamp(v, 0, 1);
  };

  WaterCaustics.prototype.setRayStrength = function (v) {
    this.rayStrength = clamp(v, 0, 1);
  };

  WaterCaustics.prototype.setRippleStrength = function (v) {
    this.rippleStrength = clamp(v, 0, 2);
  };

  // pointerTrail=false: pointermove never spawns rings (pointerdown still
  // spawns the stronger ring). true (default): move spawns the normal drip
  // cadence defined in _onPointerMove.
  WaterCaustics.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': pointermove alone spawns nothing at all (even the
  // move-driven drip is suppressed) until pointerdown; drag-while-down
  // still spawns via the same move handler since _pointerDown is checked
  // there. 'move' (default): pointer motion alone spawns rings per the
  // normal cadence.
  WaterCaustics.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  WaterCaustics.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.waveHeight != null) this.setWaveHeight(p.waveHeight);
    if (p.waveSpeed != null) this.setWaveSpeed(p.waveSpeed);
    if (p.causticStrength != null) this.setCausticStrength(p.causticStrength);
    if (p.causticScale != null) this.setCausticScale(p.causticScale);
    if (p.chromatic != null) this.setChromatic(p.chromatic);
    if (p.rayStrength != null) this.setRayStrength(p.rayStrength);
    if (p.rippleStrength != null) this.setRippleStrength(p.rippleStrength);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
  };

  WaterCaustics.prototype.pause = function () {
    this._paused = true;
  };

  WaterCaustics.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  WaterCaustics.prototype.destroy = function () {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.canvas) {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    }
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._resizeObserver) this._resizeObserver.disconnect();

    var gl = this.gl;
    if (gl) {
      if (this._prog) gl.deleteProgram(this._prog.program);
      if (this._vao) gl.deleteVertexArray(this._vao);
    }
  };

  global.WaterCaustics = WaterCaustics;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-water-caustics]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._waterCausticsInstance) continue;
      var num = function (name) {
        return el.hasAttribute(name) ? parseFloat(el.getAttribute(name)) : undefined;
      };
      var bool = function (name, def) {
        if (!el.hasAttribute(name)) return def;
        var v = el.getAttribute(name);
        return v === 'true' || v === '1' || v === '';
      };
      var opts = {
        mode: el.getAttribute('data-mode') || undefined,
        background: el.getAttribute('data-background') || undefined,
        colorA: el.getAttribute('data-color-a') || undefined,
        colorB: el.getAttribute('data-color-b') || undefined,
        waveHeight: num('data-wave-height'),
        waveSpeed: num('data-wave-speed'),
        causticStrength: num('data-caustic-strength'),
        causticScale: num('data-caustic-scale'),
        chromatic: num('data-chromatic'),
        rayStrength: num('data-ray-strength'),
        rippleStrength: num('data-ripple-strength'),
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined
      };
      el._waterCausticsInstance = new WaterCaustics(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
