/*
 * FluidSim - WebGL2 grid-based viscous fluid ("原液/serum") effect.
 * Dependency-free, embeddable via a single script tag.
 *
 * Implements the classic semi-Lagrangian advection + Jacobi pressure
 * projection method (public-domain numerical technique) with an
 * original code layout, an original viscosity-diffusion pass, and an
 * original "serum gloss" shading pass for display.
 *
 * Usage (auto-init):
 *   <div data-fluid-sim data-mode="cursor" data-color-a="#4a0f16" data-color-b="#f0b8ae"></div>
 *   <script src="fluid-sim.js"></script>
 *
 * Usage (manual):
 *   var fx = new FluidSim(canvasOrSelector, { mode: 'ambient', viscosity: 0.5, background: 'light' });
 *   fx.setMode('cursor'); fx.setColors('#000','#fff'); fx.setBackground('light');
 *   fx.splat(0.5, 0.5, 0, -0.4); fx.destroy();
 *
 * The `background` option ('dark' default | 'light') switches the display
 * shading profile; use 'light' when the canvas sits on a white/bright page.
 * Also settable via data-background attribute in auto-init.
 *
 * Pointer-interaction options (embeddable-behavior controls):
 *   pointerTrail (default true) - when false, pointer movement injects
 *     velocity only (it stirs whatever dye is already in the field) and
 *     never splats new color along the path, so moving the pointer leaves
 *     no persistent trail of dye.
 *   pointerEmit ('move' default | 'click') - when 'click', hovering
 *     without the button held produces nothing at all (no velocity splat,
 *     no dye); only pointerdown and drag-while-down inject into the sim.
 *     Applies on top of pointerTrail.
 *
 * Runtime tuning:
 *   Named setters - setViscosity(0..1), setDyeDissipation(0..1),
 *   setVelocityDissipation(0..1), setPressureIterations(10..80),
 *   setViscosityIterations(0..50), setSplatRadius(0.01..1), setSpeed(0.05..5),
 *   setCurlStrength(0..50) (vorticity confinement, 0 = off),
 *   setColorMode('palette' | 'rainbow'), setPointerTrail(bool),
 *   setPointerEmit('move'|'click'),
 *   setDisplayParams({ specular: 0..2, shininess: 8..200, fresnel: 0..1,
 *   transparency: 0..1 }).
 *   Or bulk: setParams({ mode, background, colorA, colorB, colorMode,
 *   viscosity, dyeDissipation, velocityDissipation, pressureIterations,
 *   viscosityIterations, splatRadius, speed, curlStrength, pointerTrail,
 *   pointerEmit, specular, shininess, fresnel, transparency })
 *   - unknown/absent keys are ignored, values are clamped.
 *
 * Auto-init data attributes (on the [data-fluid-sim] element):
 *   data-mode, data-background, data-color-mode, data-color-a, data-color-b,
 *   data-viscosity, data-speed, data-splat-radius,
 *   data-curl (or data-curl-strength),
 *   data-dye-dissipation, data-velocity-dissipation,
 *   data-pressure-iterations, data-viscosity-iterations,
 *   data-pointer-trail, data-pointer-emit,
 *   data-specular, data-shininess, data-fresnel, data-transparency
 */
(function (global) {
  'use strict';

  var MAX_SIM_RES = 512;
  var MAX_DYE_RES = 1024;

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

  // Manual bilinear fetch used everywhere a float texture might lack
  // OES_texture_float_linear support on the sampling hardware.
  var BILINEAR_FN = [
    'vec4 bilerp(sampler2D tex, vec2 uv, vec2 texel) {',
    '  vec2 st = uv / texel - 0.5;',
    '  vec2 i0 = floor(st);',
    '  vec2 f = st - i0;',
    '  vec2 uv00 = (i0 + 0.5) * texel;',
    '  vec4 a = texture(tex, uv00);',
    '  vec4 b = texture(tex, uv00 + vec2(texel.x, 0.0));',
    '  vec4 c = texture(tex, uv00 + vec2(0.0, texel.y));',
    '  vec4 d = texture(tex, uv00 + texel);',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}'
  ].join('\n');

  var FRAG_HEADER = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler2D;',
    'uniform vec2 uTexel;',
    'out vec4 fragColor;'
  ].join('\n');

  // Semi-Lagrangian advection: trace the position backward along the
  // velocity field and sample the source quantity there. Works for both
  // velocity self-advection and dye advection.
  var ADVECT_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform float uDt;',
    'uniform float uDissipation;',
    'uniform bool uManualFilter;',
    BILINEAR_FN,
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec2 vel = uManualFilter ? bilerp(uVelocity, uv, uTexel).xy : texture(uVelocity, uv).xy;',
    '  vec2 back = uv - uDt * vel * uTexel;',
    '  vec4 result = uManualFilter ? bilerp(uSource, back, uTexel) : texture(uSource, back);',
    '  fragColor = result * uDissipation;',
    '}'
  ].join('\n');

  // One Jacobi relaxation step: shared by the viscosity diffusion solve
  // and the pressure Poisson solve (they only differ by the alpha/beta
  // coefficients and which field is the "x" being relaxed).
  var JACOBI_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uX;',
    'uniform sampler2D uB;',
    'uniform float uAlpha;',
    'uniform float uBeta;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec4 xL = texture(uX, uv - vec2(uTexel.x, 0.0));',
    '  vec4 xR = texture(uX, uv + vec2(uTexel.x, 0.0));',
    '  vec4 xB = texture(uX, uv - vec2(0.0, uTexel.y));',
    '  vec4 xT = texture(uX, uv + vec2(0.0, uTexel.y));',
    '  vec4 bC = texture(uB, uv);',
    '  fragColor = (xL + xR + xB + xT + uAlpha * bC) * uBeta;',
    '}'
  ].join('\n');

  var DIVERGENCE_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uVelocity;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  float l = texture(uVelocity, uv - vec2(uTexel.x, 0.0)).x;',
    '  float r = texture(uVelocity, uv + vec2(uTexel.x, 0.0)).x;',
    '  float b = texture(uVelocity, uv - vec2(0.0, uTexel.y)).y;',
    '  float t = texture(uVelocity, uv + vec2(0.0, uTexel.y)).y;',
    '  float div = 0.5 * ((r - l) + (t - b));',
    '  fragColor = vec4(div, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Subtracts the pressure gradient from the velocity field so the
  // result satisfies div(v) = 0 (Helmholtz-Hodge projection) - this is
  // what keeps the flow from either exploding or collapsing to nothing.
  var GRADIENT_SUBTRACT_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  float l = texture(uPressure, uv - vec2(uTexel.x, 0.0)).x;',
    '  float r = texture(uPressure, uv + vec2(uTexel.x, 0.0)).x;',
    '  float b = texture(uPressure, uv - vec2(0.0, uTexel.y)).x;',
    '  float t = texture(uPressure, uv + vec2(0.0, uTexel.y)).x;',
    '  vec2 vel = texture(uVelocity, uv).xy;',
    '  vel -= 0.5 * vec2(r - l, t - b);',
    '  fragColor = vec4(vel, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Scalar vorticity of the velocity field: w = dvy/dx - dvx/dy.
  var CURL_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uVelocity;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  float l = texture(uVelocity, uv - vec2(uTexel.x, 0.0)).y;',
    '  float r = texture(uVelocity, uv + vec2(uTexel.x, 0.0)).y;',
    '  float b = texture(uVelocity, uv - vec2(0.0, uTexel.y)).x;',
    '  float t = texture(uVelocity, uv + vec2(0.0, uTexel.y)).x;',
    '  fragColor = vec4(0.5 * ((r - l) - (t - b)), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Vorticity confinement: the coarse grid + semi-Lagrangian advection
  // numerically damp small vortices, which flattens the flow. This pass
  // pushes velocity back toward vortex centers (force = eps * N x w, with
  // N the normalized gradient of |w|), restoring the fine swirl. The
  // result is clamped so a large strength cannot blow the field up.
  var VORTICITY_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float uStrength;',
    'uniform float uDt;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  float cL = texture(uCurl, uv - vec2(uTexel.x, 0.0)).x;',
    '  float cR = texture(uCurl, uv + vec2(uTexel.x, 0.0)).x;',
    '  float cB = texture(uCurl, uv - vec2(0.0, uTexel.y)).x;',
    '  float cT = texture(uCurl, uv + vec2(0.0, uTexel.y)).x;',
    '  float cC = texture(uCurl, uv).x;',
    '  vec2 grad = 0.5 * vec2(abs(cR) - abs(cL), abs(cT) - abs(cB));',
    '  grad /= length(grad) + 0.0001;',
    '  vec2 force = uStrength * cC * vec2(grad.y, -grad.x);',
    '  vec2 vel = texture(uVelocity, uv).xy + force * uDt;',
    '  fragColor = vec4(clamp(vel, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);',
    '}'
  ].join('\n');

  var SPLAT_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uTarget;',
    'uniform vec2 uPoint;',
    'uniform vec3 uValue;',
    'uniform float uRadius;',
    'uniform float uAspect;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec2 d = uv - uPoint;',
    '  d.x *= uAspect;',
    '  float g = exp(-dot(d, d) / uRadius);',
    '  vec3 base = texture(uTarget, uv).xyz;',
    '  fragColor = vec4(base + uValue * g, 1.0);',
    '}'
  ].join('\n');

  var CLEAR_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uTarget;',
    'uniform float uMul;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  fragColor = texture(uTarget, uv) * uMul;',
    '}'
  ].join('\n');

  // Final "serum gloss" display shader: reconstructs a pseudo-normal
  // from the dye luminance gradient and lights it like a thick, glossy
  // liquid surface rather than flat smoke.
  //
  // Two compositing profiles selected by uLightBg:
  //  - dark  (0.0): additive white specular + fresnel rim, wide alpha ramp.
  //    Bright additive terms read well against a dark page.
  //  - light (1.0): additive white would vanish into a white page, and a
  //    wide alpha ramp leaves grey haze at trail edges. Instead the dye
  //    chromaticity (color / luminance) is re-shaded: thicker liquid gets
  //    darker and more saturated, the fresnel rim darkens (refractive edge
  //    of a drop on paper), the specular pulls toward a tinted highlight
  //    rather than pure white, and the alpha ramp starts later / ends
  //    steeper so thin trails cut off cleanly instead of smearing grey.
  // NOTE: this pass renders at CANVAS resolution while sampling the dye
  // texture, so the interpolation uv must come from uScreenTexel (1/canvas)
  // - reusing the dye texel size for uv would map dye-texture 0..1 onto only
  // a canvas-pixel-count-of-the-dye-FBO region and smear the rest via
  // CLAMP_TO_EDGE. uTexel (1/dye) is still used for gradient offsets.
  // Gradients are taken 2 texels out to smooth per-texel dye noise that
  // otherwise reads as a wrinkled skin instead of smooth thick liquid.
  // uSpecular / uShininess / uFresnel expose the gloss shaping at runtime
  // (defaults 0.9 / 60 / 0.35). The light branch consumes fresnel as a rim
  // darkening and specular as a highlight mix, so both are rescaled there
  // (x0.63 / x0.94) to keep the defaults visually matched to the original
  // hard-coded light-mode constants (0.22 / 0.85).
  // uTransparency (0 default) fades the liquid body toward invisible while
  // keeping specular highlights and the slope rim at full strength - that
  // is what makes a clear gel readable: you see the light on it, not the
  // pigment in it. Every uTransparency term is a no-op at 0.
  var DISPLAY_SRC = [
    FRAG_HEADER,
    'uniform sampler2D uDye;',
    'uniform vec2 uScreenTexel;',
    'uniform float uLightBg;',
    'uniform float uSpecular;',
    'uniform float uShininess;',
    'uniform float uFresnel;',
    'uniform float uTransparency;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uScreenTexel;',
    '  vec2 off = uTexel * 2.0;',
    '  vec3 c = texture(uDye, uv).rgb;',
    '  float lC = dot(c, vec3(0.299, 0.587, 0.114));',
    '  float lL = dot(texture(uDye, uv - vec2(off.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));',
    '  float lR = dot(texture(uDye, uv + vec2(off.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));',
    '  float lB = dot(texture(uDye, uv - vec2(0.0, off.y)).rgb, vec3(0.299, 0.587, 0.114));',
    '  float lT = dot(texture(uDye, uv + vec2(0.0, off.y)).rgb, vec3(0.299, 0.587, 0.114));',
    '  float gx = (lR - lL) * 10.0;',
    '  float gy = (lT - lB) * 10.0;',
    '  vec3 normal = normalize(vec3(-gx, -gy, 1.0));',
    '  vec3 lightDir = normalize(vec3(-0.4, 0.55, 0.72));',
    '  vec3 viewDir = vec3(0.0, 0.0, 1.0);',
    '  vec3 halfDir = normalize(lightDir + viewDir);',
    '  float spec = pow(max(dot(normal, halfDir), 0.0), uShininess);',
    // Slope-based rim instead of pow(1-N.V, 3): the diffused dye field only
    // produces gradients of ~0.1-0.2, where a true fresnel term underflows
    // to nothing. Same visual role (edge emphasis where the surface tilts
    // away), but responsive at the slopes that actually occur.
    '  float fresnel = clamp((abs(gx) + abs(gy)) * 3.0, 0.0, 1.0);',
    '  fresnel *= fresnel;',
    '  float thickness = clamp(abs(gx) + abs(gy), 0.0, 1.0);',
    '  vec3 col;',
    '  float alpha;',
    '  if (uLightBg > 0.5) {',
    '    vec3 tint = c / max(lC, 0.0015);',
    '    float body = smoothstep(0.04, 0.5, lC);',
    '    col = tint * mix(0.72, 0.34, body);',
    '    col = mix(col, vec3(0.97), uTransparency * 0.85);',
    '    col *= 1.0 - thickness * 0.2 * (1.0 - uTransparency);',
    '    col += thickness * 0.12 * uTransparency;',
    '    col *= clamp(1.0 - fresnel * uFresnel * (0.63 + uTransparency * 0.55), 0.0, 1.0);',
    '    float specMix = min(spec * uSpecular * 0.94, 1.0);',
    '    vec3 highlight = mix(tint * 0.85, vec3(1.0), 0.55 + uTransparency * 0.4);',
    '    col = mix(col, highlight, specMix);',
    '    alpha = smoothstep(0.055, 0.45, lC);',
    '    alpha = alpha * alpha * (3.0 - 2.0 * alpha);',
    '    float liquid = alpha;',
    '    alpha *= 1.0 - uTransparency * 0.85;',
    '    float hi = max(specMix, fresnel * uFresnel);',
    '    alpha = max(alpha, liquid * min(hi * (0.6 + 0.6 * uTransparency), 1.0) * uTransparency);',
    '  } else {',
    '    col = c * (1.0 - thickness * 0.35) * (1.0 - uTransparency * 0.9);',
    '    col += spec * uSpecular;',
    '    col += fresnel * uFresnel * (0.5 + 0.5 * c) * (1.0 + uTransparency);',
    '    alpha = smoothstep(0.02, 0.35, lC);',
    '    float liquid = alpha;',
    '    alpha *= 1.0 - uTransparency * 0.85;',
    '    float hi = max(min(spec * uSpecular, 1.0), fresnel * uFresnel);',
    '    alpha = max(alpha, liquid * min(hi, 1.0) * uTransparency);',
    '  }',
    '  fragColor = vec4(clamp(col, 0.0, 1.0), alpha);',
    '}'
  ].join('\n');

  var FALLBACK_SRC = [
    FRAG_HEADER,
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy * uTexel;',
    '  vec3 col = mix(uColorA, uColorB, uv.y);',
    '  fragColor = vec4(col, 0.5);',
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

  function hueToRgb01(h) {
    h -= Math.floor(h);
    var r = Math.abs(h * 6 - 3) - 1;
    var g = 2 - Math.abs(h * 6 - 2);
    var b = 2 - Math.abs(h * 6 - 4);
    return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
  }

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('FluidSim shader compile error: ' + log);
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
      throw new Error('FluidSim program link error: ' + gl.getProgramInfoLog(prog));
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

  function FluidSim(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('FluidSim: target not found');
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

    this.mode = options.mode || 'cursor';
    this._hexA = options.colorA || '#4a0f16';
    this._hexB = options.colorB || '#f0b8ae';
    this.colorA = hexToRgb01(this._hexA);
    this.colorB = hexToRgb01(this._hexB);
    this.viscosity = options.viscosity != null ? clamp(options.viscosity, 0, 1) : 0.5;
    this.dyeDissipation = options.dyeDissipation != null ? options.dyeDissipation : 0.995;
    this.velocityDissipation = options.velocityDissipation != null ? options.velocityDissipation : 0.98;
    this.pressureIterations = options.pressureIterations || 40;
    this.viscosityIterations = options.viscosityIterations || 20;
    this.splatRadius = options.splatRadius != null ? options.splatRadius : 0.25;
    this.speed = options.speed != null ? options.speed : 1;
    this.background = options.background === 'light' ? 'light' : 'dark';
    this.curlStrength = options.curlStrength != null ? clamp(options.curlStrength, 0, 50) : 0;
    this.colorMode = options.colorMode === 'rainbow' ? 'rainbow' : 'palette';
    this.pointerTrail = options.pointerTrail !== false;
    this.pointerEmit = options.pointerEmit === 'click' ? 'click' : 'move';
    var dp = options.displayParams || {};
    this.displayParams = {
      specular: dp.specular != null ? dp.specular : 0.9,
      shininess: dp.shininess != null ? dp.shininess : 60,
      fresnel: dp.fresnel != null ? dp.fresnel : 0.35,
      transparency: dp.transparency != null ? clamp(dp.transparency, 0, 1) : 0
    };

    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) {
      console.warn('FluidSim: WebGL2 not supported, effect disabled.');
      this._unsupported = true;
      return;
    }
    this.gl = gl;

    var floatExt = gl.getExtension('EXT_color_buffer_float');
    this._linearExt = !!gl.getExtension('OES_texture_float_linear');
    this._manualFilter = !this._linearExt;

    if (!floatExt) {
      console.warn('FluidSim: EXT_color_buffer_float missing, using static gradient fallback.');
      this._initFallback();
      return;
    }

    this._halfFloat = gl.HALF_FLOAT;
    this._filter = this._linearExt ? gl.LINEAR : gl.NEAREST;

    this._buildPrograms();

    this._pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, moved: false, down: false };
    this._lastPointer = { x: 0.5, y: 0.5 };
    this._emitters = this._makeEmitters();

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

  FluidSim.prototype._initFallback = function () {
    var gl = this.gl;
    this._fallbackProg = createProgram(gl, VERT_SRC, FALLBACK_SRC);
    this._onResize = this._onResize.bind(this);
    this._onResizeFallback();
    window.addEventListener('resize', this._onResize);
  };

  FluidSim.prototype._onResizeFallback = function () {
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

  FluidSim.prototype._buildPrograms = function () {
    var gl = this.gl;
    this._progAdvect = createProgram(gl, VERT_SRC, ADVECT_SRC);
    this._progJacobi = createProgram(gl, VERT_SRC, JACOBI_SRC);
    this._progDivergence = createProgram(gl, VERT_SRC, DIVERGENCE_SRC);
    this._progGradient = createProgram(gl, VERT_SRC, GRADIENT_SUBTRACT_SRC);
    this._progSplat = createProgram(gl, VERT_SRC, SPLAT_SRC);
    this._progClear = createProgram(gl, VERT_SRC, CLEAR_SRC);
    this._progCurl = createProgram(gl, VERT_SRC, CURL_SRC);
    this._progVorticity = createProgram(gl, VERT_SRC, VORTICITY_SRC);
    this._progDisplay = createProgram(gl, VERT_SRC, DISPLAY_SRC);
    this._vao = gl.createVertexArray();
  };

  FluidSim.prototype._makeEmitters = function () {
    var list = [];
    var n = 3;
    for (var i = 0; i < n; i++) {
      list.push({
        phase: (i / n) * Math.PI * 2,
        speed: 0.06 + i * 0.015,
        radius: 0.22 + i * 0.08,
        cx: 0.5 + (Math.random() - 0.5) * 0.2,
        cy: 0.5 + (Math.random() - 0.5) * 0.2
      });
    }
    return list;
  };

  FluidSim.prototype._allocate = function () {
    var gl = this.gl;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.dpr = dpr;
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.width = w;
    this.canvas.height = h;

    var simSize = computeSimSize(w, h, MAX_SIM_RES);
    var dyeSize = computeSimSize(w, h, MAX_DYE_RES);
    this.simSize = simSize;
    this.dyeSize = dyeSize;

    if (this.velocity) this.velocity.dispose(gl);
    if (this.dye) this.dye.dispose(gl);
    if (this.divergence) {
      gl.deleteTexture(this.divergence.texture);
      gl.deleteFramebuffer(this.divergence.fbo);
    }
    if (this.viscositySource) {
      gl.deleteTexture(this.viscositySource.texture);
      gl.deleteFramebuffer(this.viscositySource.fbo);
    }
    if (this.curlTarget) {
      gl.deleteTexture(this.curlTarget.texture);
      gl.deleteFramebuffer(this.curlTarget.fbo);
    }
    if (this.pressure) this.pressure.dispose(gl);

    this.velocity = new FboPair(gl, simSize.w, simSize.h, gl.RG16F, gl.RG, this._halfFloat, this._filter);
    this.pressure = new FboPair(gl, simSize.w, simSize.h, gl.R16F, gl.RED, this._halfFloat, this._filter);
    this.divergence = FboPair.makeTarget(gl, simSize.w, simSize.h, gl.R16F, gl.RED, this._halfFloat, gl.NEAREST);
    this.viscositySource = FboPair.makeTarget(gl, simSize.w, simSize.h, gl.RG16F, gl.RG, this._halfFloat, gl.NEAREST);
    this.curlTarget = FboPair.makeTarget(gl, simSize.w, simSize.h, gl.R16F, gl.RED, this._halfFloat, gl.NEAREST);
    this.dye = new FboPair(gl, dyeSize.w, dyeSize.h, gl.RGBA16F, gl.RGBA, this._halfFloat, this._filter);

    gl.viewport(0, 0, w, h);
  };

  // ---------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------

  FluidSim.prototype._drawTo = function (target, w, h, texelW, texelH) {
    var gl = this.gl;
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // skipDye: when true, only the velocity field is disturbed (used by
  // pointerTrail=false so a moving pointer stirs the existing dye without
  // laying down any new color along its path).
  FluidSim.prototype._splat = function (xNorm, yNorm, dxNorm, dyNorm, color, skipDye) {
    var gl = this.gl;
    var aspect = this.canvas.width / this.canvas.height;
    var radius = this.splatRadius * 0.001 * Math.max(this.canvas.width, this.canvas.height) / Math.max(this.simSize.w, this.simSize.h) + this.splatRadius * 0.02;

    // velocity splat
    gl.useProgram(this._progSplat.program);
    var u = this._progSplat.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(u.uTarget, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.uniform2f(u.uPoint, xNorm, yNorm);
    gl.uniform3f(u.uValue, dxNorm, dyNorm, 0.0);
    gl.uniform1f(u.uRadius, this.splatRadius * 0.02 + 0.0008);
    gl.uniform1f(u.uAspect, aspect);
    this._drawTo(this.velocity.write.fbo, this.velocity.w, this.velocity.h);
    this.velocity.swap();

    if (skipDye) return;

    // dye splat
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    gl.uniform2f(u.uTexel, 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform3f(u.uValue, color[0], color[1], color[2]);
    gl.uniform1f(u.uRadius, this.splatRadius * 0.02 + 0.0008);
    this._drawTo(this.dye.write.fbo, this.dye.w, this.dye.h);
    this.dye.swap();
  };

  FluidSim.prototype._randomizedColor = function (speedFactor) {
    if (this.colorMode === 'rainbow') {
      // hue drifts with sim time so consecutive splats walk the spectrum
      var rgb = hueToRgb01(this._time * 0.15 + Math.random() * 0.06);
      return [rgb[0] * 0.35, rgb[1] * 0.35, rgb[2] * 0.35];
    }
    var t = clamp(0.25 + Math.random() * 0.5 + speedFactor * 0.25, 0, 1);
    var wobble = (Math.random() - 0.5) * 0.12;
    var r = clamp(this.colorA[0] + (this.colorB[0] - this.colorA[0]) * t + wobble, 0, 1);
    var g = clamp(this.colorA[1] + (this.colorB[1] - this.colorA[1]) * t + wobble, 0, 1);
    var b = clamp(this.colorA[2] + (this.colorB[2] - this.colorA[2]) * t + wobble, 0, 1);
    return [r * 0.35, g * 0.35, b * 0.35];
  };

  FluidSim.prototype._injectPointer = function (dt) {
    var p = this._pointer;
    if (!p.moved) return;
    p.moved = false;
    // pointerEmit='click': a plain hover-move never reaches here at all
    // (see _onPointerMove, which only sets p.moved while p.down is true),
    // so no extra gating is needed in this function for that option.
    var speed = Math.sqrt(p.dx * p.dx + p.dy * p.dy) / Math.max(dt, 0.0001);
    var force = clamp(speed * 0.9, 0, 12);
    var color = this._randomizedColor(clamp(speed * 0.5, 0, 1));
    var mulX = p.down ? 1.6 : 1.0;
    // pointerTrail=false: inject velocity only so the pointer stirs the
    // existing dye field without laying down a persistent trail of new
    // color along its path.
    this._splat(p.x, p.y, p.dx * force, p.dy * force, [color[0] * mulX, color[1] * mulX, color[2] * mulX], !this.pointerTrail);
  };

  FluidSim.prototype._updateAmbient = function (dt) {
    this._ambientAccum = (this._ambientAccum || 0) + dt;
    if (this._ambientAccum < 0.05) return;
    this._ambientAccum = 0;
    for (var i = 0; i < this._emitters.length; i++) {
      var e = this._emitters[i];
      var ang = this._time * e.speed * this.speed + e.phase;
      var x = e.cx + Math.cos(ang) * e.radius;
      var y = e.cy + Math.sin(ang * 0.8) * e.radius * 0.6;
      var dx = -Math.sin(ang) * e.speed * e.radius;
      var dy = -Math.cos(ang * 0.8) * e.speed * e.radius * 0.6 * 0.8;
      var color = this._randomizedColor(0.2);
      this._splat(clamp(x, 0, 1), clamp(y, 0, 1), dx * 6, dy * 6, [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5]);
    }
  };

  FluidSim.prototype._step = function (dt) {
    var gl = this.gl;
    gl.disable(gl.BLEND);

    // 1. Advect velocity through itself.
    gl.useProgram(this._progAdvect.program);
    var ua = this._progAdvect.uniforms;
    gl.uniform2f(ua.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(ua.uVelocity, 0);
    gl.uniform1i(ua.uSource, 1);
    gl.uniform1f(ua.uDt, dt);
    gl.uniform1f(ua.uDissipation, this.velocityDissipation);
    gl.uniform1i(ua.uManualFilter, this._manualFilter ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    this._drawTo(this.velocity.write.fbo, this.velocity.w, this.velocity.h);
    this.velocity.swap();

    // 2. Viscosity diffusion (Jacobi solve of (I - vA) x = v0).
    // The right-hand side "b" must stay fixed across all iterations, so it
    // is snapshotted into a dedicated texture first - reusing the velocity
    // ping-pong pair for both b and the iterating x would eventually alias
    // the read-from and rendered-to textures (a feedback loop) once an odd
    // number of swaps flips which physical texture is "current".
    var visc = this.viscosity * 40.0;
    var iterations = Math.max(0, Math.round(this.viscosityIterations));
    if (visc > 0.0001 && iterations > 0) {
      var alpha = 1.0 / (visc * dt || 0.0001);
      var beta = 1.0 / (4.0 + alpha);

      gl.useProgram(this._progClear.program);
      var ucv = this._progClear.uniforms;
      gl.uniform2f(ucv.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
      gl.uniform1i(ucv.uTarget, 0);
      gl.uniform1f(ucv.uMul, 1.0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
      this._drawTo(this.viscositySource.fbo, this.velocity.w, this.velocity.h);

      gl.useProgram(this._progJacobi.program);
      var uj = this._progJacobi.uniforms;
      gl.uniform2f(uj.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
      gl.uniform1f(uj.uAlpha, alpha);
      gl.uniform1f(uj.uBeta, beta);
      gl.uniform1i(uj.uB, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.viscositySource.texture);
      for (var i = 0; i < iterations; i++) {
        gl.uniform1i(uj.uX, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
        this._drawTo(this.velocity.write.fbo, this.velocity.w, this.velocity.h);
        this.velocity.swap();
      }
    }

    // 3. Splats (pointer / ambient emitters).
    if (this.mode === 'ambient') {
      this._updateAmbient(dt);
    } else {
      this._injectPointer(dt);
    }

    // 3.5. Vorticity confinement (optional): re-inject the small-scale
    // swirl the coarse grid damps out. Skipped entirely at strength 0.
    if (this.curlStrength > 0.01) {
      gl.useProgram(this._progCurl.program);
      var ucl = this._progCurl.uniforms;
      gl.uniform2f(ucl.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
      gl.uniform1i(ucl.uVelocity, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
      this._drawTo(this.curlTarget.fbo, this.velocity.w, this.velocity.h);

      gl.useProgram(this._progVorticity.program);
      var uvt = this._progVorticity.uniforms;
      gl.uniform2f(uvt.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
      gl.uniform1i(uvt.uVelocity, 0);
      gl.uniform1i(uvt.uCurl, 1);
      gl.uniform1f(uvt.uStrength, this.curlStrength);
      gl.uniform1f(uvt.uDt, dt);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curlTarget.texture);
      this._drawTo(this.velocity.write.fbo, this.velocity.w, this.velocity.h);
      this.velocity.swap();
    }

    // 4. Divergence of the (possibly non-solenoidal) velocity field.
    gl.useProgram(this._progDivergence.program);
    var ud = this._progDivergence.uniforms;
    gl.uniform2f(ud.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(ud.uVelocity, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    this._drawTo(this.divergence.fbo, this.velocity.w, this.velocity.h);

    // Clear pressure slightly each frame (helps convergence, avoids drift).
    gl.useProgram(this._progClear.program);
    var uc = this._progClear.uniforms;
    gl.uniform2f(uc.uTexel, 1 / this.pressure.w, 1 / this.pressure.h);
    gl.uniform1i(uc.uTarget, 0);
    gl.uniform1f(uc.uMul, 0.8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
    this._drawTo(this.pressure.write.fbo, this.pressure.w, this.pressure.h);
    this.pressure.swap();

    // 5. Pressure Jacobi solve of the Poisson equation laplacian(p) = div(v).
    gl.useProgram(this._progJacobi.program);
    var uj2 = this._progJacobi.uniforms;
    gl.uniform2f(uj2.uTexel, 1 / this.pressure.w, 1 / this.pressure.h);
    gl.uniform1f(uj2.uAlpha, -1.0);
    gl.uniform1f(uj2.uBeta, 0.25);
    gl.uniform1i(uj2.uB, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.divergence.texture);
    var pIterations = Math.max(1, Math.round(this.pressureIterations));
    for (var j = 0; j < pIterations; j++) {
      gl.uniform1i(uj2.uX, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
      this._drawTo(this.pressure.write.fbo, this.pressure.w, this.pressure.h);
      this.pressure.swap();
    }

    // 6. Subtract pressure gradient -> divergence-free velocity.
    gl.useProgram(this._progGradient.program);
    var ug = this._progGradient.uniforms;
    gl.uniform2f(ug.uTexel, 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(ug.uPressure, 0);
    gl.uniform1i(ug.uVelocity, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    this._drawTo(this.velocity.write.fbo, this.velocity.w, this.velocity.h);
    this.velocity.swap();

    // 7. Advect dye through the divergence-free velocity field.
    gl.useProgram(this._progAdvect.program);
    var ua2 = this._progAdvect.uniforms;
    gl.uniform2f(ua2.uTexel, 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform1i(ua2.uVelocity, 0);
    gl.uniform1i(ua2.uSource, 1);
    gl.uniform1f(ua2.uDt, dt);
    gl.uniform1f(ua2.uDissipation, this.dyeDissipation);
    gl.uniform1i(ua2.uManualFilter, this._manualFilter ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    this._drawTo(this.dye.write.fbo, this.dye.w, this.dye.h);
    this.dye.swap();
  };

  FluidSim.prototype._render = function () {
    var gl = this.gl;
    gl.useProgram(this._progDisplay.program);
    var u = this._progDisplay.uniforms;
    gl.uniform2f(u.uTexel, 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform2f(u.uScreenTexel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1i(u.uDye, 0);
    gl.uniform1f(u.uLightBg, this.background === 'light' ? 1.0 : 0.0);
    gl.uniform1f(u.uSpecular, this.displayParams.specular);
    gl.uniform1f(u.uShininess, this.displayParams.shininess);
    gl.uniform1f(u.uFresnel, this.displayParams.fresnel);
    gl.uniform1f(u.uTransparency, this.displayParams.transparency);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dye.read.texture);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this._vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  FluidSim.prototype._tick = function (now) {
    if (this._destroyed) return;
    if (this._paused || document.hidden) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    var dt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    dt = clamp(dt, 0, 1 / 30) * this.speed;
    this._lastFrameTime = now;
    this._time += dt;

    this._step(dt);
    this._render();

    this._raf = requestAnimationFrame(this._tick);
  };

  // ---------------------------------------------------------------------
  // Pointer / resize / visibility handlers
  // ---------------------------------------------------------------------

  FluidSim.prototype._normalizedPoint = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = 1.0 - (e.clientY - rect.top) / rect.height;
    return { x: x, y: y };
  };

  FluidSim.prototype._onPointerMove = function (e) {
    var pt = this._normalizedPoint(e);
    var last = this._lastPointer;
    // pointerEmit='click': hovering without the button held must produce
    // nothing at all (no velocity, no dye) - only update the tracked
    // position/delta so a subsequent pointerdown-drag starts from a
    // sensible baseline, but never flag moved=true while up.
    if (this.pointerEmit === 'click' && !this._pointer.down) {
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

  FluidSim.prototype._onPointerDown = function (e) {
    // Pointer capture keeps pointermove streaming to the canvas even if a
    // touch drag slides the finger outside its bounds (mid-gesture),
    // instead of the drag silently going dead.
    if (this.canvas.setPointerCapture) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    var pt = this._normalizedPoint(e);
    this._pointer.x = pt.x;
    this._pointer.y = pt.y;
    this._pointer.dx = (Math.random() - 0.5) * 0.02;
    this._pointer.dy = (Math.random() - 0.5) * 0.02;
    this._pointer.down = true;
    this._pointer.moved = true;
    this._lastPointer.x = pt.x;
    this._lastPointer.y = pt.y;
  };

  FluidSim.prototype._onPointerUp = function (e) {
    this._pointer.down = false;
    if (e && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  FluidSim.prototype._onResize = function () {
    if (this._unsupported) return;
    if (!this.gl) return;
    if (!this._progDisplay) {
      this._onResizeFallback();
      return;
    }
    this._allocate();
  };

  FluidSim.prototype._onVisibility = function () {
    // Loop already checks document.hidden each frame; nothing else needed.
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  FluidSim.prototype.setMode = function (mode) {
    this.mode = mode === 'ambient' ? 'ambient' : 'cursor';
  };

  FluidSim.prototype.setColors = function (colorA, colorB) {
    this._hexA = colorA;
    this._hexB = colorB;
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
    if (this._fallbackProg) {
      this._onResizeFallback();
    }
  };

  FluidSim.prototype.setViscosity = function (v) {
    this.viscosity = clamp(v, 0, 1);
  };

  FluidSim.prototype.setBackground = function (bg) {
    this.background = bg === 'light' ? 'light' : 'dark';
  };

  FluidSim.prototype.setDyeDissipation = function (v) {
    this.dyeDissipation = clamp(v, 0, 1);
  };

  FluidSim.prototype.setVelocityDissipation = function (v) {
    this.velocityDissipation = clamp(v, 0, 1);
  };

  FluidSim.prototype.setPressureIterations = function (n) {
    this.pressureIterations = clamp(Math.round(n), 10, 80);
  };

  FluidSim.prototype.setViscosityIterations = function (n) {
    this.viscosityIterations = clamp(Math.round(n), 0, 50);
  };

  FluidSim.prototype.setSplatRadius = function (v) {
    this.splatRadius = clamp(v, 0.01, 1);
  };

  FluidSim.prototype.setSpeed = function (v) {
    this.speed = clamp(v, 0.05, 5);
  };

  FluidSim.prototype.setCurlStrength = function (v) {
    this.curlStrength = clamp(v, 0, 50);
  };

  FluidSim.prototype.setColorMode = function (m) {
    this.colorMode = m === 'rainbow' ? 'rainbow' : 'palette';
  };

  // pointerTrail=false: pointer motion injects velocity only (stirs the
  // existing dye) and never lays down new dye along its path.
  FluidSim.prototype.setPointerTrail = function (b) {
    this.pointerTrail = !!b;
  };

  // pointerEmit 'click': hovering without the button held produces nothing
  // at all; only pointerdown + drag-while-down injects into the sim.
  FluidSim.prototype.setPointerEmit = function (v) {
    this.pointerEmit = v === 'click' ? 'click' : 'move';
  };

  // Partial update: any of { specular: 0..2, shininess: 8..200,
  // fresnel: 0..1, transparency: 0..1 }.
  FluidSim.prototype.setDisplayParams = function (p) {
    p = p || {};
    if (p.specular != null) this.displayParams.specular = clamp(p.specular, 0, 2);
    if (p.shininess != null) this.displayParams.shininess = clamp(p.shininess, 1, 400);
    if (p.fresnel != null) this.displayParams.fresnel = clamp(p.fresnel, 0, 1);
    if (p.transparency != null) this.displayParams.transparency = clamp(p.transparency, 0, 1);
  };

  // Bulk update: routes every recognised key through its named setter, so
  // UI code can drive everything with a single object.
  FluidSim.prototype.setParams = function (p) {
    p = p || {};
    if (p.mode != null) this.setMode(p.mode);
    if (p.background != null) this.setBackground(p.background);
    if (p.colorA != null || p.colorB != null) {
      this.setColors(p.colorA != null ? p.colorA : this._hexA, p.colorB != null ? p.colorB : this._hexB);
    }
    if (p.viscosity != null) this.setViscosity(p.viscosity);
    if (p.dyeDissipation != null) this.setDyeDissipation(p.dyeDissipation);
    if (p.velocityDissipation != null) this.setVelocityDissipation(p.velocityDissipation);
    if (p.pressureIterations != null) this.setPressureIterations(p.pressureIterations);
    if (p.viscosityIterations != null) this.setViscosityIterations(p.viscosityIterations);
    if (p.splatRadius != null) this.setSplatRadius(p.splatRadius);
    if (p.speed != null) this.setSpeed(p.speed);
    if (p.curlStrength != null) this.setCurlStrength(p.curlStrength);
    if (p.colorMode != null) this.setColorMode(p.colorMode);
    if (p.pointerTrail != null) this.setPointerTrail(p.pointerTrail);
    if (p.pointerEmit != null) this.setPointerEmit(p.pointerEmit);
    this.setDisplayParams(p);
  };

  FluidSim.prototype.splat = function (xNorm, yNorm, dxNorm, dyNorm) {
    if (!this.gl || this._fallbackProg) return;
    var color = this._randomizedColor(0.5);
    this._splat(clamp(xNorm, 0, 1), clamp(yNorm, 0, 1), dxNorm, dyNorm, color);
  };

  FluidSim.prototype.pause = function () {
    this._paused = true;
  };

  FluidSim.prototype.resume = function () {
    if (this._destroyed) return;
    this._paused = false;
    this._lastFrameTime = 0;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  };

  FluidSim.prototype.destroy = function () {
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
      if (this.velocity) this.velocity.dispose(gl);
      if (this.dye) this.dye.dispose(gl);
      if (this.pressure) this.pressure.dispose(gl);
      if (this.divergence) {
        gl.deleteTexture(this.divergence.texture);
        gl.deleteFramebuffer(this.divergence.fbo);
      }
      if (this.viscositySource) {
        gl.deleteTexture(this.viscositySource.texture);
        gl.deleteFramebuffer(this.viscositySource.fbo);
      }
      if (this.curlTarget) {
        gl.deleteTexture(this.curlTarget.texture);
        gl.deleteFramebuffer(this.curlTarget.fbo);
      }
      var progs = [this._progAdvect, this._progJacobi, this._progDivergence,
        this._progGradient, this._progSplat, this._progClear, this._progCurl,
        this._progVorticity, this._progDisplay, this._fallbackProg];
      for (var i = 0; i < progs.length; i++) {
        if (progs[i]) gl.deleteProgram(progs[i].program);
      }
      if (this._vao) gl.deleteVertexArray(this._vao);
    }
  };

  global.FluidSim = FluidSim;

  // ---------------------------------------------------------------------
  // Auto-init
  // ---------------------------------------------------------------------

  function autoInit() {
    var nodes = document.querySelectorAll('[data-fluid-sim]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._fluidSimInstance) continue;
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
        viscosity: num('data-viscosity'),
        speed: num('data-speed'),
        splatRadius: num('data-splat-radius'),
        background: el.getAttribute('data-background') || undefined,
        curlStrength: num('data-curl-strength') != null ? num('data-curl-strength') : num('data-curl'),
        colorMode: el.getAttribute('data-color-mode') || undefined,
        dyeDissipation: num('data-dye-dissipation'),
        velocityDissipation: num('data-velocity-dissipation'),
        pressureIterations: num('data-pressure-iterations'),
        viscosityIterations: num('data-viscosity-iterations'),
        pointerTrail: el.hasAttribute('data-pointer-trail') ? bool('data-pointer-trail', true) : undefined,
        pointerEmit: el.getAttribute('data-pointer-emit') || undefined,
        displayParams: {
          specular: num('data-specular'),
          shininess: num('data-shininess'),
          fresnel: num('data-fresnel'),
          transparency: num('data-transparency')
        }
      };
      el._fluidSimInstance = new FluidSim(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
