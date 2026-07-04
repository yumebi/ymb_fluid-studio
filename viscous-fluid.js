/*
 * ViscousFluid - lightweight WebGL2 viscous liquid effect.
 * Drop-in, dependency-free. Original implementation (metaball field +
 * fake dome shading), not based on any external fluid-sim source.
 *
 * Usage (auto-init):
 *   <canvas data-viscous-fluid data-mode="cursor" data-color-a="#7a1f2b" data-color-b="#e8b4bc"></canvas>
 *   <script src="viscous-fluid.js"></script>
 *
 * Usage (manual):
 *   const fx = new ViscousFluid(canvasOrSelector, { mode: 'ambient', colorA: '#7a1f2b', colorB: '#e8b4bc' });
 *   fx.setMode('cursor'); fx.setColors('#000','#fff'); fx.destroy();
 */
(function (global) {
  'use strict';

  var MAX_BLOBS = 8;

  var VERT_SRC = [
    '#version 300 es',
    'void main() {',
    '  vec2 pos[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));',
    '  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 uResolution;',
    'uniform float uTime;',
    'uniform vec2 uBlobPos[' + MAX_BLOBS + '];',
    'uniform float uBlobR[' + MAX_BLOBS + '];',
    'uniform int uBlobCount;',
    'uniform vec3 uColorA;',
    'uniform vec3 uColorB;',
    'uniform vec2 uLightPos;',
    'out vec4 fragColor;',

    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
    '}',
    'float valueNoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;',
    '}',

    'float field(vec2 p) {',
    '  float f = 0.0;',
    '  for (int i = 0; i < ' + MAX_BLOBS + '; i++) {',
    '    if (i >= uBlobCount) break;',
    '    vec2 d = p - uBlobPos[i];',
    '    float r2 = uBlobR[i] * uBlobR[i];',
    '    f += r2 / max(dot(d, d), 1.0);',
    '  }',
    '  return f;',
    '}',

    'void main() {',
    '  vec2 uv = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);',
    '  float e = 1.5;',
    '  float f = field(uv);',
    '  float iso = 1.0;',
    '  float edge = smoothstep(iso - 0.18, iso + 0.06, f);',
    '  if (edge <= 0.003) { discard; }',

    '  float fx = field(uv + vec2(e, 0.0)) - field(uv - vec2(e, 0.0));',
    '  float fy = field(uv + vec2(0.0, e)) - field(uv - vec2(0.0, e));',
    '  vec3 normal = normalize(vec3(-fx * 35.0, -fy * 35.0, 1.0));',

    '  vec3 viewDir = vec3(0.0, 0.0, 1.0);',
    '  vec3 lightDir = normalize(vec3(uLightPos - uv, 240.0));',
    '  float diff = max(dot(normal, lightDir), 0.0);',
    '  vec3 h = normalize(lightDir + viewDir);',
    '  float spec = pow(max(dot(normal, h), 0.0), 46.0);',
    '  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);',

    '  float wobble = valueNoise(uv * 0.045 + uTime * 0.12) * 0.18;',
    '  vec3 base = mix(uColorA, uColorB, clamp(diff * 0.85 + wobble, 0.0, 1.0));',
    '  vec3 col = base + spec * 0.85 + fresnel * 0.3;',

    '  fragColor = vec4(col, edge);',
    '}'
  ].join('\n');

  function hexToRgb01(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
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
      throw new Error('ViscousFluid shader compile error: ' + log);
    }
    return sh;
  }

  function hash2(x, y) {
    var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }
  function valueNoise2D(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    var a = hash2(ix, iy);
    var b = hash2(ix + 1, iy);
    var c = hash2(ix, iy + 1);
    var d = hash2(ix + 1, iy + 1);
    var ux = fx * fx * (3 - 2 * fx);
    var uy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * ux + (c - a) * uy * (1 - ux) + (d - b) * ux * uy;
  }
  // divergence-free potential -> curl gives smooth, swirling, liquid-like flow
  function potential(x, y, t) {
    return valueNoise2D(x + t * 0.6, y - t * 0.4) +
      0.5 * valueNoise2D(x * 2.1 - t * 0.3, y * 2.1 + t * 0.5);
  }
  function curlFlow(x, y, t) {
    var e = 0.06;
    var n1 = potential(x, y + e, t);
    var n2 = potential(x, y - e, t);
    var n3 = potential(x + e, y, t);
    var n4 = potential(x - e, y, t);
    return { x: (n1 - n2) / (2 * e), y: -(n3 - n4) / (2 * e) };
  }

  function Blob(x, y, r) {
    this.x = x; this.y = y; this.r = r;
    this.vx = 0; this.vy = 0;
    this.tx = x; this.ty = y;
    this.nx = Math.random() * 1000; this.ny = Math.random() * 1000;
  }

  function ViscousFluid(target, options) {
    options = options || {};
    var canvas = typeof target === 'string' ? document.querySelector(target) : target;
    if (!canvas) throw new Error('ViscousFluid: target not found');
    if (canvas.tagName !== 'CANVAS') {
      var c = document.createElement('canvas');
      canvas.appendChild(c);
      canvas = c;
    }
    this.canvas = canvas;

    this.mode = options.mode || 'cursor';
    this.colorA = hexToRgb01(options.colorA || '#7a1f2b');
    this.colorB = hexToRgb01(options.colorB || '#e8b4bc');
    this.viscosity = options.viscosity != null ? options.viscosity : 0.06;
    this.blobCount = Math.min(options.blobCount || 5, MAX_BLOBS);
    this.scale = options.scale || 1;
    this.speed = options.speed != null ? options.speed : 1;

    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('ViscousFluid: WebGL2 not supported');
    this.gl = gl;

    var prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('ViscousFluid program link error: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.u = {
      resolution: gl.getUniformLocation(prog, 'uResolution'),
      time: gl.getUniformLocation(prog, 'uTime'),
      blobPos: gl.getUniformLocation(prog, 'uBlobPos'),
      blobR: gl.getUniformLocation(prog, 'uBlobR'),
      blobCount: gl.getUniformLocation(prog, 'uBlobCount'),
      colorA: gl.getUniformLocation(prog, 'uColorA'),
      colorB: gl.getUniformLocation(prog, 'uColorB'),
      lightPos: gl.getUniformLocation(prog, 'uLightPos')
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.blobs = [];
    this.pointer = { x: 0, y: 0, active: false };
    this._time = 0;
    this._lastT = 0;
    this._raf = null;
    this._destroyed = false;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);

    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('resize', this._onResize);

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(canvas);
    }

    this._onResize();
    this._initBlobs();
    this._raf = requestAnimationFrame(this._tick);
  }

  ViscousFluid.prototype._onPointerMove = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.active = true;
  };

  ViscousFluid.prototype._onResize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.gl.viewport(0, 0, w, h);
  };

  ViscousFluid.prototype._initBlobs = function () {
    var w = this.canvas.width, h = this.canvas.height;
    var baseR = Math.min(w, h) * 0.09 * this.scale;
    this.blobs = [];
    for (var i = 0; i < this.blobCount; i++) {
      var x = w * 0.5 + (Math.random() - 0.5) * w * 0.3;
      var y = h * 0.5 + (Math.random() - 0.5) * h * 0.3;
      var r = baseR * (1 - i * 0.12);
      this.blobs.push(new Blob(x, y, Math.max(r, baseR * 0.3)));
    }
  };

  ViscousFluid.prototype._updateCursor = function (dt) {
    var dpr = this.dpr;
    var leadX = this.pointer.active ? this.pointer.x * dpr : this.canvas.width * 0.5;
    var leadY = this.pointer.active ? this.pointer.y * dpr : this.canvas.height * 0.5;
    var stiffness = 0.22 * (1 - this.viscosity) + 0.02;
    var damping = 1 - this.viscosity * 0.6;
    var freq = 0.0022;
    var turb = (0.7 * (1 - this.viscosity) + 0.08) * 320;

    for (var i = 0; i < this.blobs.length; i++) {
      var b = this.blobs[i];
      var targetX = i === 0 ? leadX : this.blobs[i - 1].x;
      var targetY = i === 0 ? leadY : this.blobs[i - 1].y;
      var lag = i === 0 ? 1 : 0.32;
      b.vx += (targetX - b.x) * stiffness * lag;
      b.vy += (targetY - b.y) * stiffness * lag;

      var flow = curlFlow(b.x * freq, b.y * freq, this._time);
      b.vx += flow.x * turb * dt;
      b.vy += flow.y * turb * dt;

      if (i > 0) {
        var prev = this.blobs[i - 1];
        b.vx += prev.vx * 0.12;
        b.vy += prev.vy * 0.12;
      }

      b.vx *= damping;
      b.vy *= damping;
      b.x += b.vx * dt * 60 * this.speed;
      b.y += b.vy * dt * 60 * this.speed;
    }
  };

  ViscousFluid.prototype._updateAmbient = function (dt) {
    var w = this.canvas.width, h = this.canvas.height;
    var freq = 0.0016;
    var flowScale = (0.6 * (1 - this.viscosity) + 0.12) * 340;
    var damping = 0.95 - this.viscosity * 0.05;
    for (var i = 0; i < this.blobs.length; i++) {
      var b = this.blobs[i];
      var flow = curlFlow(b.x * freq + b.nx, b.y * freq + b.ny, this._time * 0.4 * this.speed);
      b.vx += flow.x * flowScale * dt;
      b.vy += flow.y * flowScale * dt;
      b.vx *= damping;
      b.vy *= damping;
      b.x += b.vx * dt * 60 * this.speed;
      b.y += b.vy * dt * 60 * this.speed;

      var margin = b.r;
      if (b.x < margin) { b.x = margin; b.vx *= -0.5; }
      if (b.x > w - margin) { b.x = w - margin; b.vx *= -0.5; }
      if (b.y < margin) { b.y = margin; b.vy *= -0.5; }
      if (b.y > h - margin) { b.y = h - margin; b.vy *= -0.5; }
    }
  };

  ViscousFluid.prototype._tick = function (now) {
    if (this._destroyed) return;
    var dt = this._lastT ? Math.min((now - this._lastT) / 1000, 0.05) : 0.016;
    this._lastT = now;
    this._time += dt;

    if (this.mode === 'ambient') {
      this._updateAmbient(dt);
    } else {
      this._updateCursor(dt);
    }

    this._render();
    this._raf = requestAnimationFrame(this._tick);
  };

  ViscousFluid.prototype._render = function () {
    var gl = this.gl, u = this.u;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var flatPos = new Float32Array(MAX_BLOBS * 2);
    var flatR = new Float32Array(MAX_BLOBS);
    for (var i = 0; i < this.blobs.length; i++) {
      flatPos[i * 2] = this.blobs[i].x;
      flatPos[i * 2 + 1] = this.blobs[i].y;
      flatR[i] = this.blobs[i].r;
    }

    gl.uniform2f(u.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.time, this._time);
    gl.uniform2fv(u.blobPos, flatPos);
    gl.uniform1fv(u.blobR, flatR);
    gl.uniform1i(u.blobCount, this.blobs.length);
    gl.uniform3f(u.colorA, this.colorA[0], this.colorA[1], this.colorA[2]);
    gl.uniform3f(u.colorB, this.colorB[0], this.colorB[1], this.colorB[2]);
    var lead = this.blobs[0];
    gl.uniform2f(u.lightPos, lead.x - lead.r * 0.6, lead.y - lead.r * 0.6);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  ViscousFluid.prototype.setMode = function (mode) {
    this.mode = mode;
  };

  ViscousFluid.prototype.setColors = function (colorA, colorB) {
    this.colorA = hexToRgb01(colorA);
    this.colorB = hexToRgb01(colorB);
  };

  ViscousFluid.prototype.setViscosity = function (v) {
    this.viscosity = Math.max(0, Math.min(0.95, v));
  };

  ViscousFluid.prototype.destroy = function () {
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('resize', this._onResize);
    if (this._resizeObserver) this._resizeObserver.disconnect();
  };

  global.ViscousFluid = ViscousFluid;

  function autoInit() {
    var nodes = document.querySelectorAll('[data-viscous-fluid]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el._viscousFluidInstance) continue;
      var opts = {
        mode: el.getAttribute('data-mode') || undefined,
        colorA: el.getAttribute('data-color-a') || undefined,
        colorB: el.getAttribute('data-color-b') || undefined,
        viscosity: el.hasAttribute('data-viscosity') ? parseFloat(el.getAttribute('data-viscosity')) : undefined,
        blobCount: el.hasAttribute('data-blob-count') ? parseInt(el.getAttribute('data-blob-count'), 10) : undefined,
        scale: el.hasAttribute('data-scale') ? parseFloat(el.getAttribute('data-scale')) : undefined,
        speed: el.hasAttribute('data-speed') ? parseFloat(el.getAttribute('data-speed')) : undefined
      };
      el._viscousFluidInstance = new ViscousFluid(el, opts);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
