/*
 * GoldShimmer - WebGL2 "gold leaf suspended in serum" particle sparkle effect.
 * Dependency-free, embeddable via a single script tag.
 *
 * Thousands of tiny metallic flakes drift through a slow volumetric swirl
 * and twinkle individually with sharp, intermittent glints (not a uniform
 * glow). Everything animates on the GPU: each particle is a static seed
 * record (base position, phase, size factor, depth) uploaded once into a
 * VBO, and the vertex shader alone derives its per-frame position from
 * uTime plus those seeds - no per-frame CPU buffer writes. Drift uses a
 * cheap analytic "curl-ish" field built from a sum of offset sine waves
 * (an original, non-Perlin approximation of curl noise: two scalar fields
 * offset by a quarter period approximate the two components of a curl so
 * the flow looks rotational/volumetric rather than a plain sideways drift).
 * Points are rendered with gl.POINTS; the fragment shader draws a
 * soft-edged circular core plus a subtle 4-point star cross flare, and a
 * per-particle phase drives a sharp pow(sin, highExponent) twinkle so only
 * a small fraction of flakes flash brightly on any given frame.
 *
 * All shader code, the noise/curl approximation, and the sparkle shading
 * are original - no borrowed shader source, no attribution required.
 *
 * Usage (auto-init):
 *   <div data-gold-shimmer data-mode="cursor" data-background="dark"></div>
 *   <script src="gold-shimmer.js"></script>
 *
 * Usage (manual):
 *   var fx = new GoldShimmer(canvasOrSelector, { mode: 'ambient', particleCount: 4000 });
 *   fx.setMode('cursor'); fx.setColors('#d4af37', '#fff3c4'); fx.setBackground('light');
 *   fx.destroy();
 *
 * The `background` option ('dark' default | 'light') switches the blend
 * profile: on dark backgrounds the flakes are additively blended (bright
 * glints on black); on light backgrounds a darker-gold variant is normal-
 * blended so the sparkle reads on a bright page instead of washing out.
 * Also settable via data-background attribute in auto-init.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, the swirl/push velocity
 *     impulse from pointer motion drops to zero immediately once the
 *     pointer stops moving, instead of easing out over the next few
 *     frames - no lingering stirred region.
 *   pointerEmit ('move' default | 'click') - when 'click', the swirl/push
 *     field around the pointer only engages while the button is held;
 *     plain hovering (cursor mode) has zero influence on the particles.
 *     Applies on top of pointerTrail.
 *
 * Runtime tuning:
 *   Named setters - setParticleCount(100..10000, recreates the seed
 *   buffer), setSpeed(0.05..5), setSize(0.2..4), setTwinkleRate(0..3),
 *   setSwirlStrength(0..3), setColors(colorA, colorB),
 *   setBackground('dark'|'light'), setMode('cursor'|'ambient'),
 *   setPointerTrail(bool), setPointerEmit('move'|'click').
 *   Or bulk: setParams({ mode, background, colorA, colorB, particleCount,
 *   speed, size, twinkleRate, swirlStrength, pointerTrail, pointerEmit })
 *   - unknown/absent keys are ignored, values are clamped.
 *
 * Auto-init data attributes (on the [data-gold-shimmer] element):
 *   data-mode, data-background, data-color-a, data-color-b,
 *   data-particle-count, data-speed, data-size, data-twinkle-rate,
 *   data-swirl-strength, data-pointer-trail, data-pointer-emit
 */
(function (global) {
  'use strict';

  var DEFAULT_PARTICLE_COUNT = 3000;
  var MIN_PARTICLES = 100;
  var MAX_PARTICLES = 10000;

  // ---------------------------------------------------------------------
  // Shader sources
  // ---------------------------------------------------------------------

  // Per-particle static attributes (uploaded once, never rewritten):
  //   aSeed  - vec2, a per-particle pseudo-random base position in [-1, 1]
  //            used both as the "resting" drift-field coordinate and as a
  //            hash seed for phase/color/orbit variation.
  //   aPhase - float, twinkle phase offset in [0, 2*PI).
  //   aSize  - float, per-particle size multiplier in [0.4, 1.6].
  //   aDepth - float, pseudo-depth in [0, 1); 0 = far/small/dim,
  //            1 = near/large/bright. Also offsets the drift field so
  //            depth layers swirl at slightly different rates (parallax).
  var VERT_SRC = [
    '#version 300 es',
    'layout(location=0) in vec2 aSeed;',
    'layout(location=1) in float aPhase;',
    'layout(location=2) in float aSize;',
    'layout(location=3) in float aDepth;',
    'uniform float uTime;',
    'uniform vec2 uResolution;',
    'uniform float uSpeed;',
    'uniform float uSize;',
    'uniform float uSwirlStrength;',
    'uniform float uTwinkleRate;',
    'uniform vec2 uPointer;',
    'uniform vec2 uPointerVel;',
    'uniform float uPointerMix;', // 0 = ambient only, 1 = full cursor influence
    'out float vTwinkle;',
    'out float vDepth;',
    'out vec2 vColorMix;', // x: base colorA/colorB blend, y: extra glint boost
    '',
    // Two independent scalar fields, sampled a quarter-period apart and
    // rotated 90 degrees against each other, behave like the two
    // components of a curl of some hidden potential: each field is
    // divergence-heavy on its own, but combining them this way keeps the
    // resulting vector field close to volume-preserving (particles swirl
    // and loop instead of piling up or thinning out at "sinks"), without
    // ever computing an actual gradient. Cheap sum-of-sines, own design.
    'float driftField(vec2 p, float t) {',
    '  float s = sin(p.x * 1.7 + t * 0.9) * cos(p.y * 1.3 - t * 0.6);',
    '  s += 0.5 * sin(p.x * 3.1 - t * 1.4 + p.y * 0.7);',
    '  s += 0.25 * cos(p.y * 4.3 + t * 0.5 - p.x * 1.1);',
    '  return s;',
    '}',
    'vec2 curlish(vec2 p, float t) {',
    '  float a = driftField(p, t);',
    '  float b = driftField(p + vec2(1.7, -0.9), t + 1.5707963);',
    '  return vec2(b, -a);',
    '}',
    '',
    'float hash1(float n) { return fract(sin(n * 43758.5453) * 12345.6789); }',
    '',
    'void main() {',
    '  float t = uTime * uSpeed;',
    '  float depthRate = 0.35 + aDepth * 0.65;',
    '  vec2 basePos = aSeed;',
    // slow large-scale swirl orbit around the seed's own neighborhood
    '  vec2 swirl = curlish(basePos * 0.8 + aDepth * 3.1, t * depthRate) * uSwirlStrength;',
    '  vec2 pos = basePos + swirl * 0.5;',
    // gentle independent bob so the field does not look perfectly periodic
    '  pos.x += sin(t * 0.17 * depthRate + aPhase) * 0.08;',
    '  pos.y += cos(t * 0.13 * depthRate + aPhase * 1.37) * 0.08;',
    '',
    // pointer interaction: local swirl/push around the pointer with a
    // smooth radial falloff, scaled by uPointerMix (0 in ambient mode).
    '  vec2 toP = pos - uPointer;',
    '  float d2 = dot(toP, toP) + 0.02;',
    '  float falloff = uPointerMix / (1.0 + d2 * 9.0);',
    '  vec2 tangent = vec2(-toP.y, toP.x);',
    '  pos += tangent * falloff * 0.9;',
    '  pos += uPointerVel * falloff * 1.6;',
    '  pos += normalize(toP + 0.0001) * falloff * 0.05;',
    '',
    // wrap drifted position back into a stable [-1, 1] tile so particles
    // never permanently escape the view, without ever snapping/popping:
    // the curl field itself is smooth and roughly periodic in `basePos`
    // scale, so fract-based wrapping stays visually seamless.
    '  vec2 wrapped = mod(pos + 1.0, 2.0) - 1.0;',
    '',
    // aspect-correct so particles fill a rectangular canvas evenly
    '  float aspect = uResolution.x / max(uResolution.y, 1.0);',
    '  vec2 clip = wrapped;',
    '  if (aspect > 1.0) { clip.y *= aspect; } else { clip.x /= aspect; }',
    '  gl_Position = vec4(clip, 0.0, 1.0);',
    '',
    // depth attenuation: near particles bigger and brighter.
    // Baseline flake diameter is ~9px at a 900px-tall reference canvas
    // (uSize=1, aSize=1, depthScale=1); the previous formula omitted this
    // base-size factor entirely and only ever produced sub-pixel point
    // sizes (0.1-1.7px at typical viewport heights), which is why nothing
    // was visible - gl.POINTS rounds/coverage-drops below ~1px regardless
    // of the fragment shader's alpha math.
    '  float depthScale = 0.35 + aDepth * 1.15;',
    '  float basePx = 9.0;',
    '  float px = uSize * aSize * depthScale * basePx * (uResolution.y / 900.0);',
    '  gl_PointSize = clamp(px, 1.0, 64.0);',
    '',
    // sharp intermittent twinkle: pow(sin, high exponent) is ~0 almost
    // everywhere and spikes to 1 only near the phase peak, so at any
    // instant only a small fraction of particles are "lit".
    '  float tw = sin(t * (1.3 + hash1(aPhase) * 1.7) * (0.4 + uTwinkleRate) + aPhase * 6.2831853);',
    '  tw = max(tw, 0.0);',
    '  vTwinkle = pow(tw, 10.0 + hash1(aPhase * 3.1) * 18.0);',
    '  vDepth = aDepth;',
    '  vColorMix = vec2(hash1(aPhase * 7.77 + aSeed.x), hash1(aSeed.y * 5.31 + aPhase));',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    '#version 300 es',
    'precision highp float;',
    'in float vTwinkle;',
    'in float vDepth;',
    'in vec2 vColorMix;',
    'out vec4 fragColor;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform float uLightBg;',
    '',
    'void main() {',
    '  vec2 uv = gl_PointCoord * 2.0 - 1.0;',
    '  float r = length(uv);',
    '  if (r > 1.0) discard;',
    '',
    // soft circular core
    '  float core = smoothstep(1.0, 0.0, r);',
    '  core = core * core;',
    '',
    // subtle 4-point star cross flare: strongest along the axes, fading
    // fast off-axis, and only shows up when the particle is twinkling.
    '  float axis = pow(max(1.0 - abs(uv.x) * 3.2, 0.0), 3.0) + pow(max(1.0 - abs(uv.y) * 3.2, 0.0), 3.0);',
    '  float flare = axis * smoothstep(1.0, 0.0, r) * 0.6;',
    '',
    '  vec3 base = mix(uColorA, uColorB, clamp(vColorMix.x * 0.6, 0.0, 1.0));',
    '  vec3 glint = mix(base, uColorB, 0.85);',
    '  vec3 col = mix(base * 0.85, glint, vTwinkle);',
    '  col += flare * vTwinkle * uColorB;',
    '',
    '  float baseAlpha = core * (0.18 + 0.35 * vDepth);',
    '  float glintAlpha = core * vTwinkle * (0.55 + 0.45 * vDepth);',
    '  float alpha = clamp(baseAlpha + glintAlpha + flare * vTwinkle * 0.5, 0.0, 1.0);',
    '',
    '  if (uLightBg > 0.5) {',
    // darker-gold variant for light backgrounds: normal-blended, so
    // reduce brightness and lean on alpha rather than additive glow.
    '    col *= 0.55;',
    '    alpha *= 0.85;',
    '    fragColor = vec4(clamp(col, 0.0, 1.0), alpha);',
    '  } else {',
    // additive on dark backgrounds: premultiply by alpha so faint
    // particles do not oversaturate when summed.
    '    fragColor = vec4(col * alpha, alpha);',
    '  }',
    '}'
  ].join('\n');

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function hexToRgb01(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Deterministic-ish PRNG (mulberry32) so seed buffers are reproducible
  // across recreations within a session without relying on Math.random
  // exclusively - not required for correctness, just gives stable-looking
  // regeneration when particleCount changes back and forth.
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('GoldShimmer shader compile error: ' + log);
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
      throw new Error('GoldShimmer program link error: ' + gl.getProgramInfoLog(prog));
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

  function GoldShimmer(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('GoldShimmer: target not found');
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
    this._hexA = options.colorA || '#d4af37';
    this._hexB = options.colorB || '#fff3c4';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);
    this.background = options.background === 'light' ? 'light' : 'dark';
    this.particleCount = clamp(Math.round(options.particleCount || DEFAULT_PARTICLE_COUNT), MIN_PARTICLES, MAX_PARTICLES);
    this.speed = options.speed != null ? clamp(options.speed, 0.05, 5) : 1;
    this.size = options.size != null ? clamp(options.size, 0.2, 4) : 1;
    this.twinkleRate = options.twinkleRate != null ? clamp(options.twinkleRate, 0, 3) : 1;
    this.swirlStrength = options.swirlStrength != null ? clamp(options.swirlStrength, 0, 3) : 1;
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';
    this._pointerDown = false;

    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) {
      console.warn('GoldShimmer: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;

    this._prog = createProgram(gl, VERT_SRC, FRAG_SRC);
    this._vao = gl.createVertexArray();
    this._vbo = null;
    this._buildParticles();

    this._pointer = { x: 0, y: 0, dx: 0, dy: 0, moved: false };
    this._lastPointer = { x: 0, y: 0 };

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

  // Builds (or rebuilds) the static per-particle seed VBO. Layout per
  // particle, 5 floats: seedX, seedY, phase, size, depth.
  GoldShimmer.prototype._buildParticles = function () {
    var gl = this.gl;
    var n = this.particleCount;
    var rng = makeRng(0x9e3779b9 ^ n);
    var stride = 5;
    var data = new Float32Array(n * stride);
    for (var i = 0; i < n; i++) {
      var o = i * stride;
      data[o] = rng() * 2 - 1;          // aSeed.x
      data[o + 1] = rng() * 2 - 1;      // aSeed.y
      data[o + 2] = rng() * Math.PI * 2; // aPhase
      data[o + 3] = 0.4 + rng() * 1.2;   // aSize
      data[o + 4] = rng();               // aDepth
    }

    if (this._vbo) gl.deleteBuffer(this._vbo);
    this._vbo = gl.createBuffer();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    var bytesPerFloat = 4;
    var strideBytes = stride * bytesPerFloat;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, strideBytes, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, strideBytes, 2 * bytesPerFloat);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, strideBytes, 3 * bytesPerFloat);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, strideBytes, 4 * bytesPerFloat);
    gl.bindVertexArray(null);
  };

  GoldShimmer.prototype._allocate = function () {
    var gl = this.gl;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.dpr = dpr;
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
  };

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  GoldShimmer.prototype._render = function () {
    var gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    if (this.background === 'light') {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE);
    }

    gl.useProgram(this._prog.program);
    var u = this._prog.uniforms;
    gl.uniform1f(u.uTime, this._time);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uSpeed, this.speed);
    gl.uniform1f(u.uSize, this.size);
    gl.uniform1f(u.uSwirlStrength, this.swirlStrength);
    gl.uniform1f(u.uTwinkleRate, this.twinkleRate);
    gl.uniform2f(u.uPointer, this._pointer.x, this._pointer.y);
    gl.uniform2f(u.uPointerVel, this._pointer.dx, this._pointer.dy);
    // pointerEmit='click': the swirl/push field only engages while the
    // button is held (or in ambient mode it is off regardless, as before).
    var pointerEngaged = this.mode === 'cursor' && (this.pointerEmit !== 'click' || this._pointerDown);
    gl.uniform1f(u.uPointerMix, pointerEngaged ? 1.0 : 0.0);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    gl.uniform1f(u.uLightBg, this.background === 'light' ? 1.0 : 0.0);

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);

    // pointerTrail=false: drop the velocity impulse to zero immediately so
    // the swirl "push" from motion never carries over/lingers once the
    // pointer stops - no residual stirred region. pointerTrail=true (the
    // previous, default behavior): decay by 0.85/frame so the push eases
    // out smoothly instead of snapping off.
    if (this.pointerTrail) {
      this._pointer.dx *= 0.85;
      this._pointer.dy *= 0.85;
    } else {
      this._pointer.dx = 0;
      this._pointer.dy = 0;
    }
  };

  GoldShimmer.prototype._tick = function (now) {
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

  // ---------------------------------------------------------------------
  // Pointer / resize / visibility handlers
  // ---------------------------------------------------------------------

  GoldShimmer.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var aspect = rect.width / Math.max(rect.height, 1);
    var x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var y = (1 - (e.clientY - rect.top) / rect.height) * 2 - 1;
    if (aspect > 1) { y *= aspect; } else { x /= aspect; }
    return { x: x, y: y };
  };

  GoldShimmer.prototype._onPointerMove = function (e) {
    var pt = this._normalizedPoint(e);
    var last = this._lastPointer;
    // pointerEmit='click': still track raw position (so a subsequent
    // pointerdown starts from the right place, and so _onPointerDown's
    // own uPointer is sensible) but never register a velocity impulse
    // from a plain hover-move - uPointerMix is already 0 while up, so
    // this is mostly defensive, but it also avoids seeding a "pop" of
    // apparent velocity the instant the button goes down.
    if (this.pointerEmit === 'click' && !this._pointerDown) {
      this._pointer.x = pt.x;
      this._pointer.y = pt.y;
      last.x = pt.x;
      last.y = pt.y;
      return;
    }
    this._pointer.dx = pt.x - last.x;
    this._pointer.dy = pt.y - last.y;
    this._pointer.x = pt.x;
    this._pointer.y = pt.y;
    this._pointer.moved = true;
    last.x = pt.x;
    last.y = pt.y;
  };

  GoldShimmer.prototype._onPointerDown = function (e) {
    // Pointer capture keeps pointermove streaming to the canvas even if a
    // touch drag slides the finger outside its bounds (mid-gesture),
    // instead of the drag silently going dead.
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    this._pointerDown = true;
    this._onPointerMove(e);
  };

  GoldShimmer.prototype._onPointerUp = function (e) {
    this._pointerDown = false;
    if (e && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  GoldShimmer.prototype._onResize = function () {
    if (this._unsupported) return;
    if (!this.gl) return;
    this._allocate();
  };

  GoldShimmer.prototype._onVisibility = function () {
    // Loop already checks document.hidden each frame; nothing else needed.
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  GoldShimmer.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
  };

  GoldShimmer.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
  };

  GoldShimmer.prototype.setBackground = function (bg) {
    this.background = bg === 'light' ? 'light' : 'dark';
  };

  GoldShimmer.prototype.setParticleCount = function (n) {
    var clamped = clamp(Math.round(n), MIN_PARTICLES, MAX_PARTICLES);
    if (clamped === this.particleCount) return;
    this.particleCount = clamped;
    if (this.gl) this._buildParticles();
  };

  GoldShimmer.prototype.setSpeed = function (v) {
    this.speed = clamp(v, 0.05, 5);
  };

  GoldShimmer.prototype.setSize = function (v) {
    this.size = clamp(v, 0.2, 4);
  };

  GoldShimmer.prototype.setTwinkleRate = function (v) {
    this.twinkleRate = clamp(v, 0, 3);
  };

  GoldShimmer.prototype.setSwirlStrength = function (v) {
    this.swirlStrength = clamp(v, 0, 3);
  };

  // pointerTrail=false: the swirl/push velocity impulse from pointer motion
  // drops to zero immediately once the pointer stops, instead of easing
  // out over a few frames - no lingering stirred region.
  GoldShimmer.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': the swirl/push field only engages while the
  // pointer button is held; plain hovering has zero influence.
  GoldShimmer.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  GoldShimmer.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.particleCount != null) this.setParticleCount(p.particleCount);
    if (p.speed != null) this.setSpeed(p.speed);
    if (p.size != null) this.setSize(p.size);
    if (p.twinkleRate != null) this.setTwinkleRate(p.twinkleRate);
    if (p.swirlStrength != null) this.setSwirlStrength(p.swirlStrength);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
  };

  GoldShimmer.prototype.pause = function () {
    this._paused = true;
  };

  GoldShimmer.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  GoldShimmer.prototype.destroy = function () {
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
      if (this._vbo) gl.deleteBuffer(this._vbo);
      if (this._vao) gl.deleteVertexArray(this._vao);
      if (this._prog) gl.deleteProgram(this._prog.program);
    }
  };

  global.GoldShimmer = GoldShimmer;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-gold-shimmer]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._goldShimmerInstance) continue;
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
        particleCount: num('data-particle-count'),
        speed: num('data-speed'),
        size: num('data-size'),
        twinkleRate: num('data-twinkle-rate'),
        swirlStrength: num('data-swirl-strength'),
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined
      };
      el._goldShimmerInstance = new GoldShimmer(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
