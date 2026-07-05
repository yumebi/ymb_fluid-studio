/*
 * ThinFilm - WebGL2 "thin-film iridescence" (pearl / soap-film rainbow) effect.
 * Dependency-free, embeddable via a single script tag.
 *
 * Original implementation: a hash-based value-noise thickness field (2-3
 * octaves), advected by a slow original domain-warp flow, is fed through a
 * cosine-palette approximation of thin-film optical interference (rgb =
 * 0.5 + 0.5*cos(2*PI*(thickness*scale + phase))) to fake a physically
 * inspired iridescent sheen without any real spectral simulation. All
 * shader code, the noise hash, the warp field and the display shading were
 * written from scratch for this file - no external shader source or
 * attribution.
 *
 * Usage (auto-init):
 *   <div data-thin-film data-mode="cursor" data-background="light"></div>
 *   <script src="thin-film.js"></script>
 *
 * Usage (manual):
 *   var fx = new ThinFilm(canvasOrSelector, { mode: 'ambient', background: 'dark' });
 *   fx.setMode('cursor'); fx.setColors('#f6f2ee', '#dcc8e8'); fx.setBackground('light');
 *   fx.setHueShift(0.3); fx.destroy();
 *
 * The `background` option ('dark' | 'light', default 'light') switches the
 * shading profile: on dark backgrounds the film glows luminous on black; on
 * light backgrounds a soft pastel sheen is used and additive terms are
 * clamped to avoid blowing out against a bright page.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, moving the pointer no longer
 *     accumulates thickness stamps into the ripple buffer; instead a single
 *     transient bump follows the live pointer and fades out within ~0.5s,
 *     so there is never a lingering trail of past stamps.
 *   pointerEmit ('move' default | 'click') - when 'click', hovering
 *     without the button held disturbs nothing at all; only pointerdown
 *     and drag-while-down do. Applies on top of pointerTrail.
 *
 * Runtime tuning:
 *   Named setters - setHueShift(0..1, rotates palette phase), setIntensity
 *   (0..1, rainbow strength vs base pearl color - 0 reads as a plain
 *   mother-of-pearl gradient), setScale(0.2..12, interference band
 *   frequency), setFlowSpeed(0..4), setRippleStrength(0..3, pointer-bump
 *   gain), setMode('cursor'|'ambient'), setColors(hexA, hexB),
 *   setBackground('dark'|'light'), setOpaque(bool), setPointerTrail(bool),
 *   setPointerEmit('move'|'click').
 *   Or bulk: setParams({ mode, background, colorA, colorB, hueShift,
 *   intensity, scale, flowSpeed, rippleStrength, opaque, pointerTrail,
 *   pointerEmit }) - unknown/absent keys are ignored, values are clamped.
 *
 * Auto-init data attributes (on the [data-thin-film] element):
 *   data-mode, data-background, data-color-a, data-color-b,
 *   data-hue-shift, data-intensity, data-scale, data-flow-speed,
 *   data-ripple-strength, data-opaque, data-pointer-trail, data-pointer-emit
 */
(function (global) {
  'use strict';

  var RIPPLE_RES = 256; // half-res-ish square accumulation buffer, resolution independent

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
    'out vec4 fragColor;'
  ].join('\n');

  // Original hash-based value noise: a 2D hash -> smoothstep-interpolated
  // lattice noise, plus a small fbm (2-3 octaves) helper. No borrowed
  // constants beyond the well-known "big odd number" hash trick used to
  // scramble a dot-product, which is not creative expression by itself.
  var NOISE_FN = [
    'float tfHash(vec2 p) {',
    '  p = fract(p * vec2(127.1, 311.7));',
    '  p += dot(p, p + 34.23);',
    '  return fract(p.x * p.y * 95.43);',
    '}',
    'float tfValueNoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  float a = tfHash(i);',
    '  float b = tfHash(i + vec2(1.0, 0.0));',
    '  float c = tfHash(i + vec2(0.0, 1.0));',
    '  float d = tfHash(i + vec2(1.0, 1.0));',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    'float tfFbm(vec2 p) {',
    '  float sum = 0.0;',
    '  float amp = 0.55;',
    '  float freq = 1.0;',
    '  for (int i = 0; i < 3; i++) {',
    '    sum += amp * tfValueNoise(p * freq);',
    '    freq *= 2.07;',
    '    amp *= 0.55;',
    '  }',
    '  return sum;',
    '}',
    // Slow domain warp: displaces the sampling point by a second, coarser
    // noise field before the fbm lookup, so the thickness pattern folds
    // and drifts rather than just translating.
    'vec2 tfWarp(vec2 p, float t) {',
    '  float wx = tfFbm(p * 0.8 + vec2(0.0, t));',
    '  float wy = tfFbm(p * 0.8 + vec2(5.2, -t));',
    '  return p + (vec2(wx, wy) - 0.5) * 1.6;',
    '}'
  ].join('\n');

  // Ping-pong ripple accumulation pass: decays the previous buffer and
  // stamps a gaussian bump at the current pointer position when active.
  var RIPPLE_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uPrev;',
    'uniform vec2 uTexel;',
    'uniform vec2 uPoint;',
    'uniform float uActive;',
    'uniform float uAspect;',
    'uniform float uStrength;',
    'uniform float uRadius;',
    'uniform float uDecay;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  float prev = texture(uPrev, uv).r * uDecay;',
    '  vec2 d = uv - uPoint;',
    '  d.x *= uAspect;',
    '  float g = exp(-dot(d, d) / uRadius) * uActive * uStrength;',
    '  fragColor = vec4(clamp(prev + g, 0.0, 4.0), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CLEAR_SRC = [
    FRAG_HEADER,
    'void main() { fragColor = vec4(0.0, 0.0, 0.0, 1.0); }'
  ].join('\n');

  // Main display pass: builds the thickness field, derives a pseudo-normal
  // from its gradient for fresnel-ish edge brightening, converts thickness
  // to an iridescent color via a cosine palette, and blends it over a soft
  // pearl base gradient.
  //
  // uBackground selects the compositing profile (0 = dark, 1 = light):
  //  - dark: the film is treated as glowing on black, so the iridescent
  //    term and fresnel rim are added on top of a dim base.
  //  - light: the base pearl gradient dominates and the iridescent /
  //    fresnel terms are blended in and tone-mapped down so they read as a
  //    soft sheen rather than blowing out to white.
  // uIntensity (0..1) cross-fades between the flat pearl base color and
  // the full iridescent palette - at 0 the result is a plain mother-of-
  // pearl gradient, at 1 the rainbow bands read at full saturation.
  var DISPLAY_SRC = [
    FRAG_HEADER,
    NOISE_FN,
    'uniform vec2 uResolution;',
    'uniform float uTime;',
    'uniform float uScale;',
    'uniform float uFlowSpeed;',
    'uniform float uHueShift;',
    'uniform float uIntensity;',
    'uniform float uBackground;',
    'uniform float uOpaque;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform sampler2D uRipple;',
    // Transient live-bump path used when pointerTrail=false: instead of
    // sampling the accumulation buffer (which would keep every past stamp
    // fading in slowly over the normal ~1s decay), compute a single
    // instantaneous gaussian bump directly from the pointer position and
    // an age that fades it out within ~0.5s. uUseLiveRipple selects which
    // source feeds the shared `ripple` term below.
    'uniform float uUseLiveRipple;',
    'uniform vec2 uLivePoint;',
    'uniform float uLiveAge;',
    'uniform float uLiveActive;',
    'uniform float uLiveStrength;',
    'uniform float uLiveAspect;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution;',
    '  float aspect = uResolution.x / uResolution.y;',
    '  vec2 p = vec2(uv.x * aspect, uv.y) * 2.4;',
    '  float t = uTime * uFlowSpeed * 0.12;',
    '  vec2 warped = tfWarp(p, t);',
    '  float thickness = tfFbm(warped * 1.3 + vec2(t * 0.6, -t * 0.4));',
    '  float ripple;',
    '  if (uUseLiveRipple > 0.5) {',
    '    vec2 d = uv - uLivePoint;',
    '    d.x *= uLiveAspect;',
    // fades to 0 within ~0.5s (uLiveAge is seconds since last update) and
    // also respects uLiveActive so it snaps off cleanly once the pointer
    // stops qualifying (e.g. pointerEmit=click and button released).
    '    float fade = uLiveActive * clamp(1.0 - uLiveAge / 0.5, 0.0, 1.0);',
    '    ripple = exp(-dot(d, d) / 0.0022) * uLiveStrength * fade;',
    '  } else {',
    '    ripple = texture(uRipple, uv).r;',
    '  }',
    '  thickness += ripple;',
    // pseudo-normal from the thickness gradient (screen-space derivatives),
    // used for a fresnel-style rim - same trick as shading a heightfield
    // without a real normal buffer.
    '  float gx = dFdx(thickness);',
    '  float gy = dFdy(thickness);',
    '  vec3 normal = normalize(vec3(-gx * 40.0, -gy * 40.0, 1.0));',
    '  float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.0);',
    // cosine-palette iridescence approximation of thin-film optical path
    // difference: three phase-shifted cosines produce the rainbow bands.
    // uHueShift rotates the palette phase once (not per-channel) so it maps
    // linearly over its full 0..1 range without wrapping early.
    '  float phase = thickness * uScale + uHueShift;',
    '  vec3 iridescence = 0.5 + 0.5 * cos(6.28318530718 * (vec3(phase) + vec3(0.0, 0.33, 0.67)));',
    '  vec3 pearlBase = mix(uColorA, uColorB, clamp(uv.y * 0.6 + thickness * 0.4, 0.0, 1.0));',
    '  vec3 col;',
    '  float alpha;',
    '  if (uBackground > 0.5) {',
    '    vec3 sheen = mix(pearlBase, iridescence, uIntensity * 0.85);',
    '    sheen = mix(pearlBase, sheen, 0.9);',
    '    col = sheen;',
    '    col += fresnel * 0.18 * (0.4 + uIntensity);',
    '    col += iridescence * fresnel * uIntensity * 0.35;',
    '    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), max(0.0, 0.15 - uIntensity * 0.15));',
    '    col = clamp(col, 0.0, 1.0);',
    '    alpha = clamp(0.55 + thickness * 0.3 + fresnel * 0.25, 0.0, 1.0) * (0.4 + uIntensity * 0.6);',
    '  } else {',
    '    vec3 darkBase = pearlBase * 0.14;',
    '    vec3 glow = iridescence * (0.35 + uIntensity * 0.65);',
    '    col = darkBase + glow * (0.5 + thickness * 0.5);',
    '    col += fresnel * iridescence * uIntensity * 0.6;',
    '    col += fresnel * 0.25;',
    '    col = clamp(col, 0.0, 1.0);',
    '    alpha = clamp(dot(col, vec3(0.299, 0.587, 0.114)) * 1.4 + fresnel * 0.3, 0.0, 1.0);',
    '  }',
    '  alpha = mix(alpha, 1.0, uOpaque);',
    '  fragColor = vec4(col, alpha);',
    '}'
  ].join('\n');

  var FALLBACK_SRC = [
    FRAG_HEADER,
    'uniform vec2 uResolution;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform float uTime;',
    NOISE_FN,
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution;',
    '  float n = tfFbm(uv * 3.0 + uTime * 0.02);',
    '  vec3 col = mix(uColorA, uColorB, clamp(uv.y * 0.6 + n * 0.4, 0.0, 1.0));',
    '  fragColor = vec4(col, 1.0);',
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

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('ThinFilm shader compile error: ' + log);
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
      throw new Error('ThinFilm program link error: ' + gl.getProgramInfoLog(prog));
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

  function makeTarget(gl, w, h, internalFormat, format, type, filter) {
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
  }

  function RipplePair(gl, w, h, internalFormat, format, type, filter) {
    this.w = w;
    this.h = h;
    this.read = makeTarget(gl, w, h, internalFormat, format, type, filter);
    this.write = makeTarget(gl, w, h, internalFormat, format, type, filter);
  }
  RipplePair.prototype.swap = function () {
    var tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  };
  RipplePair.prototype.dispose = function (gl) {
    gl.deleteTexture(this.read.texture);
    gl.deleteTexture(this.write.texture);
    gl.deleteFramebuffer(this.read.fbo);
    gl.deleteFramebuffer(this.write.fbo);
  };

  // ---------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------

  function ThinFilm(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('ThinFilm: target not found');
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
    this._hexA = options.colorA || '#f6f2ee';
    this._hexB = options.colorB || '#dcc8e8';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);
    this.background = options.background === 'dark' ? 'dark' : 'light';
    this.hueShift = options.hueShift != null ? clamp(options.hueShift, 0, 1) : 0;
    this.intensity = options.intensity != null ? clamp(options.intensity, 0, 1) : 0.6;
    this.scale = options.scale != null ? clamp(options.scale, 0.2, 12) : 3.2;
    this.flowSpeed = options.flowSpeed != null ? clamp(options.flowSpeed, 0, 4) : 1;
    this.rippleStrength = options.rippleStrength != null ? clamp(options.rippleStrength, 0, 3) : 1;
    this.opaque = options.opaque !== false;
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';

    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) {
      console.warn('ThinFilm: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;

    this._linearExt = !!gl.getExtension('OES_texture_float_linear');
    this._floatExt = !!gl.getExtension('EXT_color_buffer_float');
    this._filter = this._linearExt ? gl.LINEAR : gl.NEAREST;

    if (!this._floatExt) {
      console.warn('ThinFilm: EXT_color_buffer_float missing, pointer ripples fall back to a non-accumulating uniform ripple.');
    }

    this._buildPrograms();

    // active: 0/1 whether the live pointer currently qualifies to disturb
    // the surface (respects pointerEmit). down: raw button state, tracked
    // independently so pointerEmit='click' can allow drag-while-down.
    // liveAge: seconds since the last qualifying update, used by the
    // pointerTrail=false transient-bump path to fade out within ~0.5s
    // instead of relying on the (skipped) FBO accumulation decay.
    this._pointer = { x: 0.5, y: 0.5, active: 0, down: false, liveAge: 999 };
    this._time = 0;
    this._lastFrameTime = 0;
    this._raf = null;
    this._paused = false;
    this._destroyed = false;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
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
    canvas.addEventListener('pointerleave', this._onPointerLeave);
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

  ThinFilm.prototype._buildPrograms = function () {
    var gl = this.gl;
    this._progDisplay = createProgram(gl, VERT_SRC, DISPLAY_SRC);
    if (this._floatExt) {
      this._progRipple = createProgram(gl, VERT_SRC, RIPPLE_SRC);
      this._progClear = createProgram(gl, VERT_SRC, CLEAR_SRC);
    }
    this._vao = gl.createVertexArray();

    // 1x1 neutral (zero) ripple texture used when the float-buffer path is
    // unavailable, so the display shader always has something bound to
    // uRipple - keeps the shader itself branch-free between the two paths.
    this._blackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._blackTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  };

  ThinFilm.prototype._allocate = function () {
    var gl = this.gl;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.dpr = dpr;
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.width = w;
    this.canvas.height = h;

    if (this._floatExt) {
      var aspect = w / h;
      var rw, rh;
      if (aspect > 1) {
        rw = RIPPLE_RES;
        rh = Math.max(1, Math.round(RIPPLE_RES / aspect));
      } else {
        rh = RIPPLE_RES;
        rw = Math.max(1, Math.round(RIPPLE_RES * aspect));
      }
      if (this.ripple) this.ripple.dispose(gl);
      this.ripple = new RipplePair(gl, rw, rh, gl.R16F, gl.RED, gl.HALF_FLOAT, this._filter);
      this._clearRipple();
    }

    gl.viewport(0, 0, w, h);
  };

  ThinFilm.prototype._clearRipple = function () {
    if (!this.ripple) return;
    var gl = this.gl;
    gl.useProgram(this._progClear.program);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.ripple.w, this.ripple.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ripple.read.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ripple.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  ThinFilm.prototype._stepRipple = function (dt) {
    if (!this.ripple) return;
    var gl = this.gl;
    var p = this._pointer;
    gl.useProgram(this._progRipple.program);
    var u = this._progRipple.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.ripple.w, 1 / this.ripple.h);
    gl.uniform2f(u.uPoint, p.x, p.y);
    gl.uniform1f(u.uActive, this.mode === 'cursor' ? p.active : 0.0);
    gl.uniform1f(u.uAspect, this.ripple.w / this.ripple.h);
    gl.uniform1f(u.uStrength, this.rippleStrength * 0.9);
    gl.uniform1f(u.uRadius, 0.0022);
    // decay ~0.99/frame at 60fps; scale with dt so slower/faster frame
    // rates still settle at roughly the same physical rate.
    var decay = Math.pow(0.99, Math.max(dt, 1 / 240) * 60);
    gl.uniform1f(u.uDecay, decay);
    gl.uniform1i(u.uPrev, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ripple.read.texture);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.ripple.w, this.ripple.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ripple.write.fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.ripple.swap();
  };

  ThinFilm.prototype._render = function () {
    var gl = this.gl;
    gl.useProgram(this._progDisplay.program);
    var u = this._progDisplay.uniforms;
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this._time);
    gl.uniform1f(u.uScale, this.scale);
    gl.uniform1f(u.uFlowSpeed, this.flowSpeed);
    gl.uniform1f(u.uHueShift, this.hueShift);
    gl.uniform1f(u.uIntensity, this.intensity);
    gl.uniform1f(u.uBackground, this.background === 'dark' ? 0.0 : 1.0);
    gl.uniform1f(u.uOpaque, this.opaque ? 1.0 : 0.0);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);

    // pointerTrail=false (or no float-buffer support at all): feed the
    // transient live-bump path instead of the accumulation texture, so
    // moving the pointer never leaves a lingering thickness stamp - only
    // a single bump at the current/last position that fades within ~0.5s.
    var useLive = !this.pointerTrail || !this.ripple;
    gl.uniform1f(u.uUseLiveRipple, useLive ? 1.0 : 0.0);
    var p = this._pointer;
    gl.uniform2f(u.uLivePoint, p.x, p.y);
    gl.uniform1f(u.uLiveAge, p.liveAge);
    gl.uniform1f(u.uLiveActive, this.mode === 'cursor' ? p.active : 0.0);
    gl.uniform1f(u.uLiveStrength, this.rippleStrength * 0.9);
    gl.uniform1f(u.uLiveAspect, this.canvas.width / Math.max(this.canvas.height, 1));

    gl.uniform1i(u.uRipple, 0);
    gl.activeTexture(gl.TEXTURE0);
    if (this.ripple) {
      gl.bindTexture(gl.TEXTURE_2D, this.ripple.read.texture);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._blackTex);
      // No accumulation buffer available: fake a single instantaneous
      // ripple directly from the pointer uniform so cursor mode still
      // gives some feedback (no persistence/decay, just a live bump).
    }
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.opaque) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  ThinFilm.prototype._renderFallback = function () {
    var gl = this.gl;
    gl.useProgram(this._progDisplay.program);
    var u = this._progDisplay.uniforms;
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this._time);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  ThinFilm.prototype._tick = function (now) {
    if (this._destroyed) return;
    if (this._paused || document.hidden) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    var dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    dt = clamp(dt, 0, 1 / 30);
    this._lastFrameTime = now;
    this._time += dt;
    this._pointer.liveAge += dt;

    if (this.pointerTrail) this._stepRipple(dt);
    this._render();

    this._raf = requestAnimationFrame(this._tick);
  };

  // ---------------------------------------------------------------------
  // Pointer / resize / visibility handlers
  // ---------------------------------------------------------------------

  ThinFilm.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    return { x: x, y: y };
  };

  ThinFilm.prototype._onPointerMove = function (e) {
    var pt = this._normalizedPoint(e);
    this._pointer.x = pt.x;
    this._pointer.y = pt.y;
    // pointerEmit='click': hovering without the button held must not
    // disturb the film at all.
    if (this.pointerEmit === 'click' && !this._pointer.down) {
      return;
    }
    this._pointer.active = 1.0;
    this._pointer.liveAge = 0;
  };

  ThinFilm.prototype._onPointerDown = function (e) {
    // Pointer capture keeps pointermove streaming to the canvas even if a
    // touch drag slides the finger outside its bounds (mid-gesture),
    // instead of the drag silently going dead.
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    this._pointer.down = true;
    this._onPointerMove(e);
  };

  ThinFilm.prototype._onPointerUp = function (e) {
    this._pointer.down = false;
    if (this.pointerEmit === 'click') this._pointer.active = 0.0;
    if (e && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  ThinFilm.prototype._onPointerLeave = function () {
    this._pointer.active = 0.0;
  };

  ThinFilm.prototype._onResize = function () {
    if (this._unsupported) return;
    if (!this.gl) return;
    this._allocate();
  };

  ThinFilm.prototype._onVisibility = function () {
    // Loop already checks document.hidden each frame; nothing else needed.
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  ThinFilm.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
  };

  ThinFilm.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
  };

  ThinFilm.prototype.setBackground = function (bg) {
    this.background = bg === 'dark' ? 'dark' : 'light';
  };

  ThinFilm.prototype.setHueShift = function (v) {
    this.hueShift = clamp(v, 0, 1);
  };

  ThinFilm.prototype.setIntensity = function (v) {
    this.intensity = clamp(v, 0, 1);
  };

  ThinFilm.prototype.setScale = function (v) {
    this.scale = clamp(v, 0.2, 12);
  };

  ThinFilm.prototype.setFlowSpeed = function (v) {
    this.flowSpeed = clamp(v, 0, 4);
  };

  ThinFilm.prototype.setRippleStrength = function (v) {
    this.rippleStrength = clamp(v, 0, 3);
  };

  ThinFilm.prototype.setOpaque = function (b) {
    this.opaque = !!b;
  };

  // pointerTrail=false: moving the pointer no longer accumulates thickness
  // stamps into the ripple FBO - instead a single transient bump follows
  // the live pointer and fades within ~0.5s (see _render's uUseLiveRipple
  // path), so there is never a persistent trail of past stamps.
  ThinFilm.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': hovering without the button held disturbs
  // nothing; only pointerdown and drag-while-down do.
  ThinFilm.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Partial update: any of { hueShift, intensity, scale, flowSpeed,
  // rippleStrength }.
  ThinFilm.prototype.setDisplayParams = function (p) {
    p = p || {};
    if (p.hueShift != null) this.setHueShift(p.hueShift);
    if (p.intensity != null) this.setIntensity(p.intensity);
    if (p.scale != null) this.setScale(p.scale);
    if (p.flowSpeed != null) this.setFlowSpeed(p.flowSpeed);
    if (p.rippleStrength != null) this.setRippleStrength(p.rippleStrength);
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  ThinFilm.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.opaque != null) this.setOpaque(p.opaque);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
    this.setDisplayParams(p);
  };

  ThinFilm.prototype.pause = function () {
    this._paused = true;
  };

  ThinFilm.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  ThinFilm.prototype.destroy = function () {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.canvas) {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
      this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    }
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._resizeObserver) this._resizeObserver.disconnect();

    var gl = this.gl;
    if (gl) {
      if (this.ripple) this.ripple.dispose(gl);
      if (this._blackTex) gl.deleteTexture(this._blackTex);
      var progs = [this._progDisplay, this._progRipple, this._progClear];
      for (var i = 0; i < progs.length; i++) {
        if (progs[i]) gl.deleteProgram(progs[i].program);
      }
      if (this._vao) gl.deleteVertexArray(this._vao);
    }
  };

  global.ThinFilm = ThinFilm;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-thin-film]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._thinFilmInstance) continue;
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
        colorA: el.getAttribute('data-color-a') || undefined,
        colorB: el.getAttribute('data-color-b') || undefined,
        background: el.getAttribute('data-background') || undefined,
        hueShift: num('data-hue-shift'),
        intensity: num('data-intensity'),
        scale: num('data-scale'),
        flowSpeed: num('data-flow-speed'),
        rippleStrength: num('data-ripple-strength'),
        opaque: el.hasAttribute('data-opaque') ? bool('data-opaque', true) : undefined,
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined
      };
      el._thinFilmInstance = new ThinFilm(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
