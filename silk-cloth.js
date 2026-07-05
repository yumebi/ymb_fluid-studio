/*
 * SilkCloth - WebGL2 fullscreen "flowing silk/satin cloth" effect.
 * Dependency-free, embeddable via a single script tag.
 *
 * Renders a single fullscreen fragment shader (no mesh, no simulation
 * buffers). A fold "height field" is built from an original domain-warped
 * value noise (own hash + interpolation, 2-3 octaves) stretched strongly
 * along a configurable fold direction, drifting slowly over time so the
 * folds look like they are billowing/breathing. A finite-difference
 * gradient of that height field yields a surface normal, which is lit
 * with:
 *   - soft wrap diffuse
 *   - an original anisotropic (Ward/Kajiya-Kay style) specular term,
 *     built from a tangent that follows the fold direction bent by the
 *     local gradient, producing long bright bands that sweep across the
 *     folds (the satin "sheen" signature)
 *   - a secondary warm sheen tint layered on top of the base/shadow color
 *     mix (colorA/colorB blended by fold depth)
 *
 * All shader code, noise, and lighting math are original - no borrowed
 * shader source, no attribution required.
 *
 * Usage (auto-init):
 *   <div data-silk-cloth data-mode="cursor" data-color-a="#c9a86c" data-color-b="#6d4f2f"></div>
 *   <script src="silk-cloth.js"></script>
 *
 * Usage (manual):
 *   var fx = new SilkCloth(canvasOrSelector, { mode: 'ambient', foldScale: 2.2 });
 *   fx.setMode('cursor'); fx.setColors('#c9a86c', '#6d4f2f'); fx.setBackground('light');
 *   fx.destroy();
 *
 * The `background` option ('dark' default | 'light') switches the shading
 * profile; use 'light' when the canvas sits on a white/bright page (specular
 * is toned down and the base tones are lifted so the cloth reads on paper).
 * Also settable via data-background attribute in auto-init.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, no trailing wake array is
 *     written; only the eased current-position dent presses into the
 *     cloth while the pointer is present/qualifying, releasing smoothly
 *     (via the normal per-sample age decay) once it is not - no elongated
 *     wake geometry behind the motion.
 *   pointerEmit ('move' default | 'click') - when 'click', hovering
 *     without the button held presses no dent into the cloth at all; only
 *     pointerdown and drag-while-down do. Applies on top of pointerTrail.
 *
 * Runtime tuning:
 *   Named setters - setFoldScale(0.2..8), setFoldDepth(0..2),
 *   setFoldDirection(degrees, any value - wrapped to 0..360),
 *   setFlowSpeed(0..4), setSheenStrength(0..3), setShininess(1..400),
 *   setAnisotropy(0..1), setPressStrength(0..3), setSheenColor(hex),
 *   setColors(colorA, colorB), setBackground('dark'|'light'), setMode('cursor'|'ambient'),
 *   setPointerTrail(bool), setPointerEmit('move'|'click').
 *   Or bulk: setParams({ mode, background, colorA, colorB, sheenColor,
 *   foldScale, foldDepth, foldDirection, flowSpeed, sheenStrength,
 *   shininess, anisotropy, pressStrength, pointerTrail, pointerEmit })
 *   - unknown/absent keys are ignored, values are clamped.
 *
 * Auto-init data attributes (on the [data-silk-cloth] element):
 *   data-mode, data-background, data-color-a, data-color-b, data-sheen-color,
 *   data-fold-scale, data-fold-depth, data-fold-direction, data-flow-speed,
 *   data-sheen-strength, data-shininess, data-anisotropy, data-press-strength,
 *   data-pointer-trail, data-pointer-emit
 */
(function (global) {
  'use strict';

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

  var TRAIL_COUNT = 8;

  // Original hash + value-noise + domain warp + fold height field, followed
  // by an original anisotropic (Ward/Kajiya-Kay style) lighting pass.
  var FRAG_SRC = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 fragColor;',
    'uniform vec2 uResolution;',
    'uniform float uTime;',
    'uniform float uFoldScale;',
    'uniform float uFoldDepth;',
    'uniform float uFoldDirection;', // radians
    'uniform float uFlowSpeed;',
    'uniform float uSheenStrength;',
    'uniform float uShininess;',
    'uniform float uAnisotropy;',
    'uniform float uPressStrength;',
    'uniform float uLightBg;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform vec3 uSheenColor;',
    'uniform vec2 uTrailPos[' + TRAIL_COUNT + '];',
    'uniform vec2 uTrailVel[' + TRAIL_COUNT + '];',
    'uniform float uTrailAge[' + TRAIL_COUNT + '];',
    'uniform float uTrailActive;',

    // ---- original hash / value noise -----------------------------------
    'float hash21(vec2 p) {',
    '  p = fract(p * vec2(123.17, 311.73));',
    '  p += dot(p, p + 43.71);',
    '  return fract(p.x * p.y);',
    '}',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  float a = hash21(i);',
    '  float b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0));',
    '  float d = hash21(i + vec2(1.0, 1.0));',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    // fractal sum, 3 octaves
    'float fbm(vec2 p) {',
    '  float sum = 0.0;',
    '  float amp = 0.5;',
    '  float freq = 1.0;',
    '  for (int i = 0; i < 3; i++) {',
    '    sum += (vnoise(p * freq) - 0.5) * amp;',
    '    freq *= 2.07;',
    '    amp *= 0.52;',
    '  }',
    '  return sum;',
    '}',

    // ---- fold height field ----------------------------------------------
    // Rotate into fold space, stretch heavily along the fold-running axis
    // (so the noise reads as long parallel ridges rather than blobs), then
    // domain-warp with a second, slower fbm sample before the final fold
    // sample. uTime drifts both layers so the folds slowly travel/breathe.
    'mat2 rot2(float a) {',
    '  float s = sin(a), c = cos(a);',
    '  return mat2(c, -s, s, c);',
    '}',
    'float foldHeight(vec2 uv, float t) {',
    '  mat2 R = rot2(uFoldDirection);',
    '  vec2 q = R * (uv - 0.5);',
    '  q.y *= 3.6;', // stretch across the fold run -> long parallel folds
    '  q *= uFoldScale;',
    '  vec2 drift = vec2(t * 0.06, t * 0.021);',
    '  vec2 warp = vec2(',
    '    fbm(q * 0.55 + drift * 1.3 + 11.0),',
    '    fbm(q * 0.55 - drift * 1.1 + 47.0)',
    '  );',
    '  vec2 warped = q + warp * 0.9 + drift;',
    '  float h = fbm(warped);',
    '  h += fbm(warped * 2.1 + 5.0) * 0.35;',
    '  return h * uFoldDepth;',
    '}',

    // ---- pointer press / wake --------------------------------------------
    // Each trailing pointer sample presses a smooth radial depression into
    // the height field; velocity extends the depression into an elongated
    // wake behind the motion. Older samples (higher index / uTrailAge) fall
    // off both in radius weight and opacity for an eased decay trail.
    'float pointerField(vec2 uv, float aspect) {',
    '  if (uTrailActive < 0.5) return 0.0;',
    '  float total = 0.0;',
    '  for (int i = 0; i < ' + TRAIL_COUNT + '; i++) {',
    '    vec2 d = uv - uTrailPos[i];',
    '    d.x *= aspect;',
    '    float speed = length(uTrailVel[i]);',
    '    vec2 dir = speed > 0.0001 ? uTrailVel[i] / speed : vec2(0.0, 1.0);',
    '    float along = dot(d, dir);',
    '    float across = length(d - dir * along);',
    '    float stretch = 0.06 + min(speed * 4.0, 0.28);',
    '    float g = exp(-(across * across) / (0.0048) - (max(along, 0.0) * max(along, 0.0)) / (stretch * stretch));',
    '    float decay = exp(-uTrailAge[i] * 1.5);',
    '    total += g * decay;',
    '  }',
    '  return total;',
    '}',

    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution;',
    '  float aspect = uResolution.x / uResolution.y;',
    '  float t = uTime * uFlowSpeed;',
    '  float eps = 1.0 / max(uResolution.y, 1.0) * 1.5;',

    '  float press = pointerField(uv, aspect) * uPressStrength;',
    '  float hC = foldHeight(uv, t) - press;',
    '  float hX = foldHeight(uv + vec2(eps, 0.0), t) - pointerField(uv + vec2(eps, 0.0), aspect) * uPressStrength;',
    '  float hY = foldHeight(uv + vec2(0.0, eps), t) - pointerField(uv + vec2(0.0, eps), aspect) * uPressStrength;',

    '  float gx = (hX - hC) / eps;',
    '  float gy = (hY - hC) / eps;',
    '  vec3 normal = normalize(vec3(-gx, -gy, 2.2));',

    // fold-running tangent, bent slightly by the local gradient so the
    // anisotropic streaks visibly follow the fold surface rather than
    // staying perfectly straight.
    '  vec2 foldDir = rot2(uFoldDirection) * vec2(0.0, 1.0);',
    '  vec3 tangent = normalize(vec3(foldDir, 0.0) + vec3(gy, -gx, 0.0) * 0.6);',
    '  tangent = normalize(tangent - normal * dot(tangent, normal));',

    '  vec3 lightDir = normalize(vec3(-0.35, 0.5, 0.78));',
    '  vec3 viewDir = vec3(0.0, 0.0, 1.0);',
    '  vec3 halfDir = normalize(lightDir + viewDir);',

    // soft wrap diffuse
    '  float ndl = dot(normal, lightDir);',
    '  float wrap = 0.4;',
    '  float diffuse = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);',
    '  diffuse = pow(diffuse, 1.15);',

    // original anisotropic specular: stretched highlight from the angle
    // between the tangent and the half-vector (Ward/Kajiya-Kay style).
    // The exponent is kept in a moderate range (12..48) so the band stays a
    // narrow bright streak rather than a broad wash that blows out the
    // whole frame - at shininess=1 sinTH^12 already decays fast off-axis.
    '  float tdh = dot(tangent, halfDir);',
    '  float sinTH = sqrt(clamp(1.0 - tdh * tdh, 0.0, 1.0));',
    '  float shin = mix(12.0, 48.0, uAnisotropy) * clamp(uShininess / 90.0, 0.3, 3.0);',
    '  float aniso = pow(sinTH, shin);',
    '  float ndh = max(dot(normal, halfDir), 0.0);',
    '  aniso *= pow(ndh, 1.5);',
    '  float spec = aniso * uSheenStrength * 0.85;',

    '  float depth = clamp(hC * 0.5 + 0.5, 0.0, 1.0);',
    '  vec3 base = mix(uColorB, uColorA, depth);',
    '  base *= mix(0.5, 1.0, diffuse);',

    '  vec3 col;',
    '  float alpha = 1.0;',
    '  if (uLightBg > 0.5) {',
    '    base = mix(base, vec3(1.0), 0.35);',
    '    col = base + uSheenColor * spec * 0.45;',
    '    col = mix(col, vec3(1.0), clamp(press * 0.4, 0.0, 0.35));',
    '  } else {',
    '    col = base * 0.75 + uSheenColor * spec;',
    '    col += uSheenColor * pow(diffuse, 4.0) * 0.05;',
    '    col = mix(col, col * 0.7, clamp(press * 0.5, 0.0, 0.4));',
    '  }',
    '  fragColor = vec4(clamp(col, 0.0, 1.0), alpha);',
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
      throw new Error('SilkCloth shader compile error: ' + log);
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
      throw new Error('SilkCloth program link error: ' + gl.getProgramInfoLog(prog));
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

  function SilkCloth(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('SilkCloth: target not found');
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
    this._hexA = options.colorA || '#c9a86c';
    this._hexB = options.colorB || '#6d4f2f';
    this._hexSheen = options.sheenColor || '#fff8f0';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);
    this.sheenColor = hexToRgb01(this._hexSheen);
    this.background = options.background === 'light' ? 'light' : 'dark';

    this.foldScale = options.foldScale != null ? clamp(options.foldScale, 0.2, 8) : 2.2;
    this.foldDepth = options.foldDepth != null ? clamp(options.foldDepth, 0, 2) : 0.9;
    this.foldDirection = options.foldDirection != null ? ((options.foldDirection % 360) + 360) % 360 : 25;
    this.flowSpeed = options.flowSpeed != null ? clamp(options.flowSpeed, 0, 4) : 0.5;
    this.sheenStrength = options.sheenStrength != null ? clamp(options.sheenStrength, 0, 3) : 1.1;
    this.shininess = options.shininess != null ? clamp(options.shininess, 1, 400) : 90;
    this.anisotropy = options.anisotropy != null ? clamp(options.anisotropy, 0, 1) : 0.85;
    this.pressStrength = options.pressStrength != null ? clamp(options.pressStrength, 0, 3) : 0.35;
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';
    this._pointerDown = false;

    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) {
      console.warn('SilkCloth: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;

    this._prog = createProgram(gl, VERT_SRC, FRAG_SRC);
    this._vao = gl.createVertexArray();

    // pointer trail: fixed-size ring buffer of recent normalized positions,
    // velocities and ages (seconds since sample was recorded).
    this._trail = [];
    for (var i = 0; i < TRAIL_COUNT; i++) {
      this._trail.push({ x: 0.5, y: 0.5, vx: 0, vy: 0, age: 999 });
    }
    this._trailActive = false;
    // Raw pointer target (updated instantly on every event) vs. the eased
    // position actually fed into the trail/shader each frame - this is the
    // low-pass filter that keeps quick mouse jerks from snapping the cloth.
    this._targetPointer = { x: 0.5, y: 0.5, active: false };
    this._smoothPointer = { x: 0.5, y: 0.5, vx: 0, vy: 0, has: false };

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

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(canvas);
    }

    this._allocate();
    this._raf = requestAnimationFrame(this._tick);
  }

  // ---------------------------------------------------------------------
  // Setup / resize
  // ---------------------------------------------------------------------

  SilkCloth.prototype._allocate = function () {
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

  SilkCloth.prototype._render = function () {
    var gl = this.gl;
    var u = this._prog.uniforms;
    gl.useProgram(this._prog.program);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, this._time);
    gl.uniform1f(u.uFoldScale, this.foldScale);
    gl.uniform1f(u.uFoldDepth, this.foldDepth);
    gl.uniform1f(u.uFoldDirection, this.foldDirection * Math.PI / 180);
    gl.uniform1f(u.uFlowSpeed, this.flowSpeed);
    gl.uniform1f(u.uSheenStrength, this.sheenStrength);
    gl.uniform1f(u.uShininess, this.shininess);
    gl.uniform1f(u.uAnisotropy, this.anisotropy);
    gl.uniform1f(u.uPressStrength, this.mode === 'cursor' ? this.pressStrength : 0.0);
    gl.uniform1f(u.uLightBg, this.background === 'light' ? 1.0 : 0.0);
    gl.uniform3f(u.uColorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.uColorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    gl.uniform3f(u.uSheenColor, this.sheenColor[0], this.sheenColor[1], this.sheenColor[2]);

    if (u.uTrailPos) {
      var posArr = new Float32Array(TRAIL_COUNT * 2);
      var velArr = new Float32Array(TRAIL_COUNT * 2);
      var ageArr = new Float32Array(TRAIL_COUNT);
      for (var i = 0; i < TRAIL_COUNT; i++) {
        var s = this._trail[i];
        posArr[i * 2] = s.x;
        posArr[i * 2 + 1] = s.y;
        velArr[i * 2] = s.vx;
        velArr[i * 2 + 1] = s.vy;
        ageArr[i] = s.age;
      }
      gl.uniform2fv(u.uTrailPos, posArr);
      gl.uniform2fv(u.uTrailVel, velArr);
      gl.uniform1fv(u.uTrailAge, ageArr);
    }
    gl.uniform1f(u.uTrailActive, this.mode === 'cursor' && this._trailActive ? 1.0 : 0.0);

    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  SilkCloth.prototype._tick = function (now) {
    if (this._destroyed) return;
    if (this._paused || document.hidden) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    var dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    dt = clamp(dt, 0, 1 / 30);
    this._lastFrameTime = now;
    this._time += dt;

    for (var i = 0; i < this._trail.length; i++) {
      this._trail[i].age += dt;
    }
    if (this._trail[0].age > 4) this._trailActive = false;

    this._updatePointer(dt);

    this._render();
    this._raf = requestAnimationFrame(this._tick);
  };

  // Low-pass filter for the pointer: eases the smoothed position toward the
  // raw target by a fixed per-frame factor (independent of event rate),
  // derives velocity from that eased motion, clamps its magnitude, and only
  // then pushes a sample into the trail ring buffer. This is what keeps a
  // fast, jerky mouse flick from slamming a huge instantaneous deformation
  // into the cloth - the shader never sees the raw, unfiltered pointer.
  SilkCloth.prototype._updatePointer = function (dt) {
    if (!this._targetPointer.active) return;
    var sp = this._smoothPointer;
    var tx = this._targetPointer.x;
    var ty = this._targetPointer.y;
    var pushFn = this.pointerTrail ? this._pushTrail : this._pushSingle;
    if (!sp.has) {
      sp.x = tx;
      sp.y = ty;
      sp.vx = 0;
      sp.vy = 0;
      sp.has = true;
      pushFn.call(this, sp.x, sp.y, 0, 0);
      return;
    }
    // lerp factor is expressed per-60fps-frame, then adjusted for actual dt
    // so the feel stays consistent across refresh rates.
    var lerp = 1 - Math.pow(1 - 0.13, dt * 60);
    var px = sp.x, py = sp.y;
    sp.x += (tx - px) * lerp;
    sp.y += (ty - py) * lerp;
    var vx = (sp.x - px) / Math.max(dt, 1 / 240);
    var vy = (sp.y - py) / Math.max(dt, 1 / 240);
    // clamp by magnitude (not per-axis) so diagonal flicks don't sneak past
    // the cap, and keep the cap modest - this bounds how far the wake can
    // stretch even on a fast swipe.
    var speed = Math.sqrt(vx * vx + vy * vy);
    var maxSpeed = 1.4;
    if (speed > maxSpeed) {
      var scale = maxSpeed / speed;
      vx *= scale;
      vy *= scale;
    }
    sp.vx = vx;
    sp.vy = vy;
    pushFn.call(this, sp.x, sp.y, vx, vy);
  };

  // ---------------------------------------------------------------------
  // Pointer / resize handlers
  // ---------------------------------------------------------------------

  SilkCloth.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    return { x: x, y: y };
  };

  SilkCloth.prototype._pushTrail = function (x, y, vx, vy) {
    // shift older samples back, freshest sample at index 0, ages reset to 0
    for (var i = this._trail.length - 1; i > 0; i--) {
      this._trail[i].x = this._trail[i - 1].x;
      this._trail[i].y = this._trail[i - 1].y;
      this._trail[i].vx = this._trail[i - 1].vx;
      this._trail[i].vy = this._trail[i - 1].vy;
      this._trail[i].age = this._trail[i - 1].age;
    }
    this._trail[0].x = x;
    this._trail[0].y = y;
    this._trail[0].vx = vx;
    this._trail[0].vy = vy;
    this._trail[0].age = 0;
    this._trailActive = true;
  };

  // pointerTrail=false variant: only slot 0 (the current eased position)
  // is ever written: no history shift, so slots 1..TRAIL_COUNT-1 stay at
  // their stale age (>=999s), which the shader's exp(-age*1.5) decay
  // collapses to ~0 contribution. The net effect in pointerField() is a
  // single dent that follows the eased pointer and releases smoothly when
  // it goes inactive - no wake/trail geometry at all.
  SilkCloth.prototype._pushSingle = function (x, y, vx, vy) {
    this._trail[0].x = x;
    this._trail[0].y = y;
    this._trail[0].vx = vx;
    this._trail[0].vy = vy;
    this._trail[0].age = 0;
    this._trailActive = true;
  };

  SilkCloth.prototype._onPointerMove = function (e) {
    // Only record the raw target here - the actual easing/velocity/trail
    // push happens once per rendered frame in _tick(), so the response is
    // governed by a consistent per-frame lerp rather than raw event
    // frequency (which on a real mouse can be very bursty).
    // pointerEmit='click': hovering without the button held must not
    // press any dent into the cloth at all.
    if (this.pointerEmit === 'click' && !this._pointerDown) {
      this._targetPointer.active = false;
      return;
    }
    var pt = this._normalizedPoint(e);
    this._targetPointer.x = pt.x;
    this._targetPointer.y = pt.y;
    this._targetPointer.active = true;
  };

  SilkCloth.prototype._onPointerDown = function (e) {
    // Pointer capture keeps pointermove streaming to the canvas even if a
    // touch drag slides the finger outside its bounds (mid-gesture),
    // instead of the drag silently going dead.
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    this._pointerDown = true;
    this._onPointerMove(e);
  };

  SilkCloth.prototype._onPointerUp = function (e) {
    this._pointerDown = false;
    if (this.pointerEmit === 'click') {
      this._targetPointer.active = false;
      this._smoothPointer.has = false;
    }
    if (e && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  SilkCloth.prototype._onPointerLeave = function () {
    // Stop chasing the pointer once it leaves; existing trail samples still
    // age out naturally (smooth decay) instead of snapping the depression
    // away.
    this._targetPointer.active = false;
  };

  SilkCloth.prototype._onResize = function () {
    if (this._unsupported || !this.gl) return;
    this._allocate();
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  SilkCloth.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
  };

  SilkCloth.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
  };

  SilkCloth.prototype.setSheenColor = function (hex) {
    this._hexSheen = hex;
    this.sheenColor = hexToRgb01(hex);
  };

  SilkCloth.prototype.setBackground = function (bg) {
    this.background = bg === 'light' ? 'light' : 'dark';
  };

  SilkCloth.prototype.setFoldScale = function (v) {
    this.foldScale = clamp(v, 0.2, 8);
  };

  SilkCloth.prototype.setFoldDepth = function (v) {
    this.foldDepth = clamp(v, 0, 2);
  };

  SilkCloth.prototype.setFoldDirection = function (deg) {
    this.foldDirection = ((deg % 360) + 360) % 360;
  };

  SilkCloth.prototype.setFlowSpeed = function (v) {
    this.flowSpeed = clamp(v, 0, 4);
  };

  SilkCloth.prototype.setSheenStrength = function (v) {
    this.sheenStrength = clamp(v, 0, 3);
  };

  SilkCloth.prototype.setShininess = function (v) {
    this.shininess = clamp(v, 1, 400);
  };

  SilkCloth.prototype.setAnisotropy = function (v) {
    this.anisotropy = clamp(v, 0, 1);
  };

  SilkCloth.prototype.setPressStrength = function (v) {
    this.pressStrength = clamp(v, 0, 3);
  };

  // pointerTrail=false: no trailing wake array is written - only the eased
  // current-position dent presses into the cloth while the pointer is
  // present, releasing smoothly (via the normal age-based decay) once it
  // is not.
  SilkCloth.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': hovering without the button held presses no dent
  // at all; only pointerdown and drag-while-down do.
  SilkCloth.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  SilkCloth.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.sheenColor != null) this.setSheenColor(p.sheenColor);
    if (p.foldScale != null) this.setFoldScale(p.foldScale);
    if (p.foldDepth != null) this.setFoldDepth(p.foldDepth);
    if (p.foldDirection != null) this.setFoldDirection(p.foldDirection);
    if (p.flowSpeed != null) this.setFlowSpeed(p.flowSpeed);
    if (p.sheenStrength != null) this.setSheenStrength(p.sheenStrength);
    if (p.shininess != null) this.setShininess(p.shininess);
    if (p.anisotropy != null) this.setAnisotropy(p.anisotropy);
    if (p.pressStrength != null) this.setPressStrength(p.pressStrength);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
  };

  SilkCloth.prototype.pause = function () {
    this._paused = true;
  };

  SilkCloth.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  SilkCloth.prototype.destroy = function () {
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
    if (this._resizeObserver) this._resizeObserver.disconnect();

    var gl = this.gl;
    if (gl) {
      if (this._prog) gl.deleteProgram(this._prog.program);
      if (this._vao) gl.deleteVertexArray(this._vao);
    }
  };

  global.SilkCloth = SilkCloth;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-silk-cloth]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._silkClothInstance) continue;
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
        sheenColor: el.getAttribute('data-sheen-color') || undefined,
        foldScale: num('data-fold-scale'),
        foldDepth: num('data-fold-depth'),
        foldDirection: num('data-fold-direction'),
        flowSpeed: num('data-flow-speed'),
        sheenStrength: num('data-sheen-strength'),
        shininess: num('data-shininess'),
        anisotropy: num('data-anisotropy'),
        pressStrength: num('data-press-strength'),
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined
      };
      el._silkClothInstance = new SilkCloth(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
