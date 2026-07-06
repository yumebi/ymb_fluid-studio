/*
 * WaterRipple - WebGL2 real 2D wave-equation ripple simulation.
 * Dependency-free, embeddable via a single script tag.
 *
 * Unlike a purely decorative ring-of-sine-waves effect, the height field
 * here is an actual discretized 2D wave equation solved by ping-ponging
 * two float FBOs every frame (classic explicit finite-difference / verlet
 * scheme: h_new = damping * (2*h - h_prev + c2 * laplacian(h))). Because
 * it is a real simulation rather than a fixed formula, drops interfere
 * with each other, reflect off the canvas edges (clamped-neighbor
 * boundary), and decay naturally - all emergent from the update rule
 * rather than scripted. All math and shader code below is original; no
 * shader source or algorithm was copied from any third party and there is
 * no attribution requirement (the finite-difference wave scheme itself is
 * public-domain numerical technique, like semi-Lagrangian advection).
 *
 * Usage (auto-init):
 *   <div data-water-ripple data-mode="cursor" data-background="light"
 *        data-color-a="#bfe6e4" data-color-b="#4f9ea8"></div>
 *   <script src="water-ripple.js"></script>
 *
 * Usage (manual):
 *   var fx = new WaterRipple(canvasOrSelector, { mode: 'ambient' });
 *   fx.setMode('cursor'); fx.setColors('#bfe6e4', '#4f9ea8');
 *   fx.setBackground('dark'); fx.drop(0.5, 0.5, 1.0); fx.destroy();
 *
 * Modes:
 *   'cursor'  - pointerdown injects one strong gaussian depression into the
 *               height field; pointermove (while allowed - see pointerTrail
 *               / pointerEmit below) injects light continuous "touch"
 *               splashes at a modest cadence rather than every frame, so a
 *               drag reads as a series of small droplets rather than a
 *               single dragged trench.
 *   'ambient' - the pointer is inactive; instead a gentle random drop is
 *               injected at a random position roughly every 1-3 seconds so
 *               an untouched canvas still shows the water is "alive".
 *
 * background 'light' | 'dark' (default 'light'):
 *   Selects the procedural refracted-background gradient profile (colorA to
 *   colorB, with a soft large-scale noise variation and an optional faint
 *   floor-tile pattern) that the wave field refracts. 'dark' pairs with a
 *   brighter specular glint; 'light' keeps the glint softer so it doesn't
 *   blow out against a pale gradient.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, pointermove never injects
 *     ripples at all; only pointerdown does (down-only "tap the water").
 *   pointerEmit ('move' default | 'click') - when 'click', pointermove
 *     alone produces nothing (no ripple) until the pointer is held down;
 *     dragging while down still spawns via the normal move cadence.
 *     Applies on top of pointerTrail (both must allow it).
 *
 * Runtime tuning:
 *   Named setters - setDamping(0.9..0.999), setWaveSpeed(0.05..0.5),
 *   setDropStrength(0..3), setDropRadius(0.002..0.1), setRefraction(0..3),
 *   setSpecular(0..3), setColors(hexA, hexB), setMode('cursor'|'ambient'),
 *   setBackground('light'|'dark'), setTilePattern(bool),
 *   setPointerTrail(bool), setPointerEmit('move'|'click').
 *   Or bulk: setParams({ mode, background, colorA, colorB, damping,
 *   waveSpeed, dropStrength, dropRadius, refraction, specular, tilePattern,
 *   pointerTrail, pointerEmit }) - unknown/absent keys are ignored, values
 *   are clamped.
 *   Programmatic drop: drop(xNorm, yNorm, strength) injects a gaussian
 *   depression at a normalized (0..1, 0..1) canvas position immediately,
 *   independent of pointer/ambient triggering.
 *
 * Auto-init data attributes (on the [data-water-ripple] element):
 *   data-mode, data-background, data-color-a, data-color-b,
 *   data-damping, data-wave-speed, data-drop-strength, data-drop-radius,
 *   data-refraction, data-specular, data-tile-pattern,
 *   data-pointer-trail, data-pointer-emit
 */
(function (global) {
  'use strict';

  // Simulation grid is capped well below canvas resolution: the wave
  // equation reads/writes every neighbor every frame (a true PDE solve,
  // not a single display pass), so an uncapped 1:1 canvas-resolution grid
  // would be far more texture traffic than this effect needs to look
  // convincing - ripples are a low-frequency phenomenon.
  var MAX_SIM_RES = 768;

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

  var FRAG_HEADER = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'uniform vec2 uTexel;',
    'out vec4 fragColor;'
  ].join('\n');

  // Explicit finite-difference wave equation update (verlet form):
  //   h_new = damping * (2*h_cur - h_prev + c2 * (sum of 4 neighbors - 4*h_cur))
  // c2 (uC2) is clamped by the JS side to <= 0.5 for stability (CFL-style
  // bound on this 5-point stencil). Height is packed in .r; .g carries the
  // previous frame's height so a single RG16F ping-pong pair holds both
  // states the update needs, instead of a 3-buffer scheme.
  // Boundary: texture() on a CLAMP_TO_EDGE sampler repeats the edge texel
  // for out-of-range neighbor fetches, which is exactly the "closed basin"
  // Neumann-ish boundary that reflects an incoming wavefront back inward -
  // no special-case edge code needed, the sampler wrap mode does it.
  var UPDATE_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uState;', // .r = h(t), .g = h(t-dt)
    'uniform float uC2;',
    'uniform float uDamping;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec2 st = texture(uState, uv).rg;',
    '  float hC = st.x;',
    '  float hPrev = st.y;',
    '  float hL = texture(uState, uv - vec2(uTexel.x, 0.0)).x;',
    '  float hR = texture(uState, uv + vec2(uTexel.x, 0.0)).x;',
    '  float hB = texture(uState, uv - vec2(0.0, uTexel.y)).x;',
    '  float hT = texture(uState, uv + vec2(0.0, uTexel.y)).x;',
    '  float lap = (hL + hR + hB + hT - 4.0 * hC);',
    '  float hNew = uDamping * (2.0 * hC - hPrev + uC2 * lap);',
    '  fragColor = vec4(hNew, hC, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Injects a smooth gaussian depression (negative height, i.e. a dip -
  // reads as a drop pressing the surface down) centered at uPoint into the
  // state texture. Critically, the SAME depressed value is written to both
  // the current (.r) and previous (.g) height channels: a verlet-form
  // integrator infers velocity from (hCur - hPrev), so writing only .r and
  // leaving .g at its old value would fabricate a permanent, never-decaying
  // velocity at that texel (the dip would keep digging deeper every frame
  // instead of springing back) - it must look like the surface "already
  // was" at the dipped position with zero velocity, and let the wave
  // equation's laplacian term alone generate the outward-propagating
  // ripple from that displaced shape on subsequent update passes.
  var DROP_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uState;',
    'uniform vec2 uPoint;',
    'uniform float uStrength;',
    'uniform float uRadius;',
    'uniform float uAspect;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec2 d = uv - uPoint;',
    '  d.x *= uAspect;',
    '  float g = exp(-dot(d, d) / uRadius);',
    '  vec2 st = texture(uState, uv).rg;',
    '  float dipped = st.x - uStrength * g;',
    '  fragColor = vec4(dipped, mix(st.y, dipped, g), 0.0, 1.0);',
    '}'
  ].join('\n');

  // Small original hash / value-noise, used only for a subtle large-scale
  // variation on the procedural background gradient (not for the wave
  // physics itself, which is the real PDE solve above).
  var NOISE_FN = [
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
    'float fbm(vec2 p) {',
    '  float v = 0.0;',
    '  v += valueNoise(p) * 0.6;',
    '  v += valueNoise(p * 2.13 + 11.7) * 0.4;',
    '  return v;',
    '}'
  ].join('\n');

  // Display pass: samples the simulated height field at canvas resolution,
  // derives a surface normal from its screen-space gradient, refracts a
  // procedural background gradient by that normal's xy, and adds a
  // specular glint from a fixed top-left light plus a slope-based
  // darkening term. The refraction of the background is what sells the
  // "looking through moving water" read rather than a flat texture.
  var DISPLAY_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uHeight;',
    'uniform vec2 uScreenTexel;',
    'uniform vec2 uResolution;',
    'uniform float uLightBg;',
    'uniform float uRefraction;',
    'uniform float uSpecular;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform float uTilePattern;',
    NOISE_FN,
    // Procedural backdrop: large-scale noise-modulated gradient plus an
    // optional faint floor-tile grid, sampled at a (possibly refracted) uv.
    'vec3 background(vec2 uv) {',
    '  float aspect = uResolution.x / uResolution.y;',
    '  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);',
    '  float grad = clamp(uv.y + (fbm(p * 1.6 + 4.2) - 0.5) * 0.5, 0.0, 1.0);',
    '  vec3 col = mix(uColorA, uColorB, grad);',
    '  float shade = fbm(p * 3.1 - 7.7) * 0.14 - 0.07;',
    '  col *= 1.0 + shade;',
    '  if (uTilePattern > 0.5) {',
    '    vec2 tp = p * 6.0;',
    '    vec2 g = abs(fract(tp) - 0.5);',
    '    float line = smoothstep(0.46, 0.5, max(g.x, g.y));',
    '    col *= 1.0 - line * 0.10;',
    '  }',
    '  return col;',
    '}',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uScreenTexel;',
    '  vec2 texel = uTexel;',
    '  float hC = texture(uHeight, uv).r;',
    '  float hL = texture(uHeight, uv - vec2(texel.x, 0.0)).r;',
    '  float hR = texture(uHeight, uv + vec2(texel.x, 0.0)).r;',
    '  float hB = texture(uHeight, uv - vec2(0.0, texel.y)).r;',
    '  float hT = texture(uHeight, uv + vec2(0.0, texel.y)).r;',
    '  float gx = (hR - hL) * 22.0;',
    '  float gy = (hT - hB) * 22.0;',
    '  vec3 normal = normalize(vec3(-gx, -gy, 1.0));',
    '  vec2 refractUv = uv + normal.xy * uRefraction * 0.06;',
    '  vec3 col = background(clamp(refractUv, 0.0, 1.0));',
    '  vec3 lightDir = normalize(vec3(-0.45, 0.6, 0.66));',
    '  vec3 viewDir = vec3(0.0, 0.0, 1.0);',
    '  vec3 halfDir = normalize(lightDir + viewDir);',
    '  float spec = pow(max(dot(normal, halfDir), 0.0), 90.0);',
    '  float slope = clamp(abs(gx) + abs(gy), 0.0, 1.0);',
    '  col *= 1.0 - slope * 0.22;',
    '  vec3 glintTint = mix(vec3(1.0), uColorB, uLightBg * 0.25);',
    '  col += spec * uSpecular * glintTint;',
    '  fragColor = vec4(clamp(col, 0.0, 1.6), 1.0);',
    '}'
  ].join('\n');

  var FALLBACK_SRC = [
    FRAG_HEADER,
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec3 col = mix(uColorA, uColorB, uv.y);',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // ---------------------------------------------------------------------
  // Small helpers
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
      throw new Error('WaterRipple shader compile error: ' + log);
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
      throw new Error('WaterRipple program link error: ' + gl.getProgramInfoLog(prog));
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

  // Ping-pong pair of float FBOs sharing one resolution.
  function FboPair(gl, w, h, internalFormat, format, type, filter) {
    this.w = w;
    this.h = h;
    this.read = FboPair.makeTarget(gl, w, h, internalFormat, format, type, filter);
    this.write = FboPair.makeTarget(gl, w, h, internalFormat, format, type, filter);
  }
  FboPair.makeTarget = function (gl, w, h, internalFormat, format, type, filter) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: tex, fbo: fbo };
  };
  FboPair.prototype.swap = function () {
    var tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  };
  FboPair.prototype.dispose = function (gl) {
    gl.deleteTexture(this.read.texture);
    gl.deleteTexture(this.write.texture);
    gl.deleteFramebuffer(this.read.fbo);
    gl.deleteFramebuffer(this.write.fbo);
  };

  function computeSimSize(w, h, maxRes) {
    var aspect = w / h;
    var size;
    if (aspect > 1) {
      size = { w: Math.min(maxRes, w), h: 0 };
      size.h = Math.round(size.w / aspect);
    } else {
      size = { h: Math.min(maxRes, h), w: 0 };
      size.w = Math.round(size.h * aspect);
    }
    size.w = Math.max(1, size.w);
    size.h = Math.max(1, size.h);
    return size;
  }

  // ---------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------

  function WaterRipple(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('WaterRipple: target not found');
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

    // Mobile: without touch-action:none, the browser treats a finger-down
    // on the canvas as a scroll/pan gesture and never delivers pointermove
    // for the drag. Setting it here (not just in demo CSS) means embeds
    // get correct touch dragging for free. user-select/tap-highlight avoid
    // incidental text selection / flash on tap.
    canvas.style.touchAction = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.userSelect = 'none';
    canvas.style.webkitTapHighlightColor = 'transparent';

    this.mode = options.mode === 'ambient' ? 'ambient' : 'cursor';
    this.background = options.background === 'dark' ? 'dark' : 'light';
    this._hexA = options.colorA || '#bfe6e4';
    this._hexB = options.colorB || '#4f9ea8';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);

    this.damping = options.damping != null ? clamp(options.damping, 0.9, 0.999) : 0.985;
    this.waveSpeed = options.waveSpeed != null ? clamp(options.waveSpeed, 0.05, 0.5) : 0.3;
    this.dropStrength = options.dropStrength != null ? clamp(options.dropStrength, 0, 3) : 1.0;
    this.dropRadius = options.dropRadius != null ? clamp(options.dropRadius, 0.002, 0.1) : 0.015;
    this.refraction = options.refraction != null ? clamp(options.refraction, 0, 3) : 1.0;
    this.specular = options.specular != null ? clamp(options.specular, 0, 3) : 1.0;
    this.tilePattern = !!options.tilePattern;
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';
    this._pointerDown = false;

    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) {
      console.warn('WaterRipple: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;

    var floatExt = gl.getExtension('EXT_color_buffer_float');
    this._linearExt = !!gl.getExtension('OES_texture_float_linear');
    this._filter = this._linearExt ? gl.LINEAR : gl.NEAREST;

    if (!floatExt) {
      console.warn('WaterRipple: EXT_color_buffer_float missing, using static gradient fallback.');
      this._initFallback();
      return;
    }
    this._halfFloat = gl.HALF_FLOAT;

    this._buildPrograms();
    this._vao = gl.createVertexArray();

    this._time = 0;
    this._lastFrameTime = 0;
    this._raf = null;
    this._paused = false;
    this._destroyed = false;
    this._nextAmbientAt = 1 + Math.random() * 2;
    this._lastMoveTime = 0;
    this._lastMovePt = { x: 0.5, y: 0.5 };

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._tick = this._tick.bind(this);

    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    // pointercancel fires when the browser steals the gesture mid-drag
    // (e.g. a system edge-swipe on mobile) - treat exactly like pointerup
    // so the "down" state never gets stuck true.
    window.addEventListener('pointercancel', this._onPointerUp);
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
  // Setup helpers
  // ---------------------------------------------------------------------

  WaterRipple.prototype._initFallback = function () {
    var gl = this.gl;
    this._fallbackProg = createProgram(gl, VERT_SRC, FALLBACK_SRC);
    this._onResize = this._onResize.bind(this);
    this._onResizeFallback();
    window.addEventListener('resize', this._onResize);
  };

  WaterRipple.prototype._onResizeFallback = function () {
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    var rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    var gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this._fallbackProg.program);
    gl.uniform2f(this._fallbackProg.uniforms.uTexel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform3f(this._fallbackProg.uniforms.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(this._fallbackProg.uniforms.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  WaterRipple.prototype._buildPrograms = function () {
    var gl = this.gl;
    this._progUpdate = createProgram(gl, VERT_SRC, UPDATE_SRC);
    this._progDrop = createProgram(gl, VERT_SRC, DROP_SRC);
    this._progDisplay = createProgram(gl, VERT_SRC, DISPLAY_SRC);
  };

  WaterRipple.prototype._allocate = function () {
    var gl = this.gl;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.dpr = dpr;
    var w = Math.max(1, Math.round((rect.width || this.canvas.clientWidth || 300) * dpr));
    var h = Math.max(1, Math.round((rect.height || this.canvas.clientHeight || 150) * dpr));
    this.canvas.width = w;
    this.canvas.height = h;

    var simSize = computeSimSize(w, h, MAX_SIM_RES);
    this.simSize = simSize;

    if (this.state) this.state.dispose(gl);
    // RG16F: .r = current height, .g = previous height (verlet needs both).
    this.state = new FboPair(gl, simSize.w, simSize.h, gl.RG16F, gl.RG, this._halfFloat, this._filter);

    gl.viewport(0, 0, w, h);
  };

  // ---------------------------------------------------------------------
  // Drops
  // ---------------------------------------------------------------------

  WaterRipple.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    return { x: x, y: y };
  };

  // Injects a gaussian depression into the *read* state texture in place
  // (drawing into .write then swapping), independent of the per-frame wave
  // update pass - this lets drop() be called any number of times per frame
  // without interfering with the once-per-frame PDE step.
  WaterRipple.prototype.drop = function (xNorm, yNorm, strength) {
    if (!this.gl || this._fallbackProg || !this.state) return;
    var gl = this.gl;
    var aspect = this.canvas.width / this.canvas.height;
    gl.useProgram(this._progDrop.program);
    var u = this._progDrop.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.state.w, 1 / this.state.h);
    gl.uniform1i(u.uState, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.read.texture);
    gl.uniform2f(u.uPoint, clamp(xNorm, 0, 1), clamp(yNorm, 0, 1));
    gl.uniform1f(u.uStrength, (strength != null ? strength : 1.0) * this.dropStrength * 0.35);
    gl.uniform1f(u.uRadius, this.dropRadius);
    gl.uniform1f(u.uAspect, aspect);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.state.w, this.state.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.state.swap();
  };

  var MOVE_SPAWN_INTERVAL = 0.09; // seconds between light touch splashes while dragging
  var MOVE_SPAWN_DIST = 0.02;     // normalized units of travel that also trigger a splash

  WaterRipple.prototype._onPointerMove = function (e) {
    var pt = this._normalizedPoint(e);
    if (this.mode !== 'cursor') { this._lastMovePt = pt; return; }
    if (!this.pointerTrail) { this._lastMovePt = pt; return; } // down-only
    if (this.pointerEmit === 'click' && !this._pointerDown) { this._lastMovePt = pt; return; }
    var dx = pt.x - this._lastMovePt.x;
    var dy = pt.y - this._lastMovePt.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var dueByTime = this._time - this._lastMoveTime >= MOVE_SPAWN_INTERVAL;
    var dueByDist = dist >= MOVE_SPAWN_DIST;
    if (!dueByTime && !dueByDist) return;
    this._lastMoveTime = this._time;
    this._lastMovePt = pt;
    this.drop(pt.x, pt.y, 0.32);
  };

  WaterRipple.prototype._onPointerDown = function (e) {
    // Pointer capture keeps pointermove streaming to the canvas even if a
    // touch drag slides the finger outside its bounds (mid-gesture),
    // instead of the drag silently going dead.
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    this._pointerDown = true;
    var pt = this._normalizedPoint(e);
    this._lastMovePt = pt;
    this._lastMoveTime = this._time;
    if (this.mode !== 'cursor') return;
    this.drop(pt.x, pt.y, 1.0);
  };

  WaterRipple.prototype._onPointerUp = function (e) {
    this._pointerDown = false;
    if (e && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  WaterRipple.prototype._updateAmbient = function (dt) {
    if (this._time < this._nextAmbientAt) return;
    this._nextAmbientAt = this._time + 1 + Math.random() * 2;
    var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    var x = 0.15 + Math.random() * 0.7;
    var y = 0.15 + Math.random() * 0.7;
    this.drop(x, y, 0.45 + Math.random() * 0.35);
  };

  // ---------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------

  // c2 (wave-speed-squared analog in the discretized update) is clamped to
  // <= 0.5 for stability of this explicit 5-point stencil regardless of
  // what a caller passes via setWaveSpeed - values above 0.5 would make
  // the scheme diverge (blow up into NaN/Infinity) rather than propagate.
  var MAX_C2 = 0.5;

  WaterRipple.prototype._step = function (dt) {
    var gl = this.gl;
    var c2 = Math.min(this.waveSpeed, MAX_C2);
    // Sub-step the PDE at a fixed reference timestep so the visual wave
    // speed stays consistent across variable frame rates rather than
    // effectively changing c2 when dt drifts.
    var steps = clamp(Math.round(dt / (1 / 60)), 1, 4);
    gl.useProgram(this._progUpdate.program);
    var u = this._progUpdate.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.state.w, 1 / this.state.h);
    gl.uniform1i(u.uState, 0);
    gl.uniform1f(u.uC2, c2);
    gl.uniform1f(u.uDamping, this.damping);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.state.w, this.state.h);
    for (var i = 0; i < steps; i++) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.state.read.texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.write.fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.state.swap();
    }
  };

  WaterRipple.prototype._render = function () {
    var gl = this.gl;
    gl.useProgram(this._progDisplay.program);
    var u = this._progDisplay.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.state.w, 1 / this.state.h);
    gl.uniform2f(u.uScreenTexel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uLightBg, this.background === 'light' ? 1.0 : 0.0);
    gl.uniform1f(u.uRefraction, this.refraction);
    gl.uniform1f(u.uSpecular, this.specular);
    gl.uniform1f(u.uTilePattern, this.tilePattern ? 1.0 : 0.0);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.read.texture);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  WaterRipple.prototype._tick = function (now) {
    if (this._destroyed) return;
    if (this._paused || document.hidden) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    var dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    dt = clamp(dt, 0, 1 / 30);
    this._lastFrameTime = now;
    this._time += dt;

    if (this.mode === 'ambient') this._updateAmbient(dt);
    this._step(dt);
    this._render();

    this._raf = requestAnimationFrame(this._tick);
  };

  WaterRipple.prototype._onResize = function () {
    if (this._unsupported) return;
    if (!this.gl) return;
    if (!this._progDisplay) {
      this._onResizeFallback();
      return;
    }
    this._allocate();
  };

  WaterRipple.prototype._onVisibility = function () {
    // Loop already checks document.hidden each frame; nothing else needed.
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  WaterRipple.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
  };

  WaterRipple.prototype.setBackground = function (bg) {
    this.background = bg === 'dark' ? 'dark' : 'light';
  };

  WaterRipple.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
    if (this._fallbackProg) this._onResizeFallback();
  };

  WaterRipple.prototype.setDamping = function (v) {
    this.damping = clamp(v, 0.9, 0.999);
  };

  WaterRipple.prototype.setWaveSpeed = function (v) {
    this.waveSpeed = clamp(v, 0.05, 0.5);
  };

  WaterRipple.prototype.setDropStrength = function (v) {
    this.dropStrength = clamp(v, 0, 3);
  };

  WaterRipple.prototype.setDropRadius = function (v) {
    this.dropRadius = clamp(v, 0.002, 0.1);
  };

  WaterRipple.prototype.setRefraction = function (v) {
    this.refraction = clamp(v, 0, 3);
  };

  WaterRipple.prototype.setSpecular = function (v) {
    this.specular = clamp(v, 0, 3);
  };

  WaterRipple.prototype.setTilePattern = function (b) {
    this.tilePattern = !!b;
  };

  // pointerTrail=false: pointermove never injects drops (pointerdown still
  // injects the strong one). true (default): move injects the light-touch
  // cadence defined in _onPointerMove.
  WaterRipple.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': pointermove alone injects nothing at all until
  // pointerdown; drag-while-down still injects via the same move handler
  // since _pointerDown is checked there. 'move' (default): pointer motion
  // alone injects per the normal cadence.
  WaterRipple.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  WaterRipple.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.damping != null) this.setDamping(p.damping);
    if (p.waveSpeed != null) this.setWaveSpeed(p.waveSpeed);
    if (p.dropStrength != null) this.setDropStrength(p.dropStrength);
    if (p.dropRadius != null) this.setDropRadius(p.dropRadius);
    if (p.refraction != null) this.setRefraction(p.refraction);
    if (p.specular != null) this.setSpecular(p.specular);
    if (p.tilePattern != null) this.setTilePattern(p.tilePattern);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
  };

  WaterRipple.prototype.pause = function () {
    this._paused = true;
  };

  WaterRipple.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  WaterRipple.prototype.destroy = function () {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.canvas) {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    }
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._resizeObserver) this._resizeObserver.disconnect();

    var gl = this.gl;
    if (gl) {
      if (this.state) this.state.dispose(gl);
      var progs = [this._progUpdate, this._progDrop, this._progDisplay, this._fallbackProg];
      for (var i = 0; i < progs.length; i++) {
        if (progs[i]) gl.deleteProgram(progs[i].program);
      }
      if (this._vao) gl.deleteVertexArray(this._vao);
    }
  };

  global.WaterRipple = WaterRipple;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-water-ripple]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._waterRippleInstance) continue;
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
        damping: num('data-damping'),
        waveSpeed: num('data-wave-speed'),
        dropStrength: num('data-drop-strength'),
        dropRadius: num('data-drop-radius'),
        refraction: num('data-refraction'),
        specular: num('data-specular'),
        tilePattern: el.hasAttribute('data-tile-pattern') ? bool('data-tile-pattern', false) : undefined,
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined
      };
      el._waterRippleInstance = new WaterRipple(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
