// Flash's bitmap filters, on the GPU (WebGL2), computed the way Flash Player computed
// them.  Ported from Ruffle's filter shaders (render/wgpu/shaders/filter and
// render/wgpu/src/filters), which reproduce Flash's output:
//
//   blur          a box blur exactly `blur` pixels wide, with fractional weights at both
//                 ends, run once per quality pass horizontally and then vertically, and
//                 rounded down to 8 bits after every step
//   glow          the filter colour where the blurred alpha is, times strength; inner and
//                 knockout variants, with or without the original drawn over it
//   drop shadow   a glow whose blurred alpha is read from `distance` pixels away
//   colour matrix on unpremultiplied colour, clamped
//
// Blur widths and distances are in stage pixels and scale with the stage only, never with
// the object's own transform.  Pixels are premultiplied throughout, as in Flash.

const PASS_SCALES = [1.0, 2.1, 2.7, 3.1, 3.5, 3.8, 4.0, 4.2, 4.4, 4.6, 5.0, 6.0, 6.0, 7.0, 7.0];

// A blur of 1 or less does nothing; scaling keeps it that way.
export function scaleBlur(b, s) {
  return (b - 1) * s + 1;
}

// How far (in device pixels) a filter list can spread an image beyond its edges.
export function filterPadding(filters, s) {
  let pad = 0;
  for (const f of filters) {
    if (f.type === 'blur' || f.type === 'glow' || f.type === 'dropShadow') {
      const k = PASS_SCALES[Math.min(15, Math.max(1, f.passes || 1)) - 1];
      pad += k * Math.max(0, scaleBlur(f.blurX || 0, s), scaleBlur(f.blurY || 0, s));
      if (f.type === 'dropShadow') pad += Math.abs(f.distance || 0) * s;
    }
  }
  return Math.ceil(pad) + 1;
}

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform ivec2 u_size;           // image size in pixels; everything outside is transparent
uniform ivec2 u_origin;         // where the viewport starts in the framebuffer
out vec4 o;
ivec2 here() { return ivec2(gl_FragCoord.xy) - u_origin; }
vec4 at(sampler2D t, ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= u_size.x || p.y >= u_size.y) return vec4(0.0);
  return texelFetch(t, p, 0);
}
`;

const BLUR = COMMON + `
uniform sampler2D u_tex;
uniform ivec2 u_dir;
uniform int u_m;                // whole-weight taps each side of the centre
uniform float u_alpha;          // weight of the one tap beyond them, each side
uniform float u_full;           // kernel width: the sum of all weights
void main() {
  ivec2 p = here();
  vec4 sum = vec4(0.0);
  for (int j = -u_m; j <= u_m; j++) sum += at(u_tex, p + u_dir * j);
  sum += u_alpha * (at(u_tex, p - u_dir * (u_m + 1)) + at(u_tex, p + u_dir * (u_m + 1)));
  o = floor(sum / u_full * 255.0) / 255.0;
}`;

const GLOW = COMMON + `
uniform sampler2D u_src;        // the image being filtered
uniform sampler2D u_blur;       // its blurred copy
uniform vec4 u_color;
uniform float u_strength;
uniform int u_inner;
uniform int u_knockout;
uniform int u_composite;
uniform vec2 u_offset;          // where the blurred alpha is read, relative (drop shadows)
float blurAlpha(vec2 q) {
  vec2 f = floor(q);
  vec2 w = q - f;
  ivec2 i = ivec2(f);
  float a00 = at(u_blur, i).a, a10 = at(u_blur, i + ivec2(1, 0)).a;
  float a01 = at(u_blur, i + ivec2(0, 1)).a, a11 = at(u_blur, i + ivec2(1, 1)).a;
  return mix(mix(a00, a10, w.x), mix(a01, a11, w.x), w.y);
}
void main() {
  ivec2 p = here();
  vec4 dest = at(u_src, p);
  float blur = blurAlpha(vec2(p) + u_offset);
  vec4 color = vec4(u_color.rgb, 1.0);
  if (u_inner != 0) {
    float a = u_color.a * clamp((1.0 - blur) * u_strength, 0.0, 1.0);
    if (u_knockout != 0) o = color * a * dest.a;
    else if (u_composite != 0) o = color * a * dest.a + dest * (1.0 - a);
    else o = color * a * dest.a;
  } else {
    float a = u_color.a * clamp(blur * u_strength, 0.0, 1.0);
    if (u_knockout != 0) o = color * a * (1.0 - dest.a);
    else if (u_composite != 0) o = color * a * (1.0 - dest.a) + dest;
    else o = color * a;
  }
}`;

const MATRIX = COMMON + `
uniform sampler2D u_tex;
uniform mat4 u_m;
uniform vec4 u_add;
void main() {
  vec4 src = at(u_tex, here());
  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec4 c = clamp(u_m * vec4(rgb, src.a) + u_add, 0.0, 1.0);
  o = vec4(c.rgb * c.a, c.a);
}`;

// The last step: into the canvas, turned the right way up (textures here are stored top
// row first, as canvases are; the drawing buffer is bottom row first).
const OUT = COMMON + `
uniform sampler2D u_tex;
void main() {
  ivec2 p = here();
  o = at(u_tex, ivec2(p.x, u_size.y - 1 - p.y));
}`;

export class GLFilters {
  // Null when there is no WebGL2, or when it is drawn in software (SwiftShader and the
  // like), where moving images between it and the 2D canvases costs more than the
  // filters are worth; the renderer then approximates with SVG filters instead.
  static create(force) {
    try {
      const f = new GLFilters();
      if (!f.gl) return null;
      if (!force && f.software()) return null;
      return f;
    } catch (e) {
      return null;
    }
  }

  software() {
    const gl = this.gl;
    // Firefox reports the real (sanitised) renderer here; Chromium and Safari only a
    // generic name, with the real one behind an extension Firefox has deprecated.
    let name = String(gl.getParameter(gl.RENDERER));
    if (/^(webkit webgl|webkit|mozilla)$/i.test(name)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    }
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return;
    this.gl = gl;
    this.programs = {
      blur: this.program(BLUR), glow: this.program(GLOW), matrix: this.program(MATRIX), out: this.program(OUT),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.source = this.texture();
    this.targets = [];            // [{ tex, fb }], grown to the largest image so far
    this.tw = 0;
    this.th = 0;
  }

  program(fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // Three render targets at least w x h (reallocated only when something bigger comes).
  ensureTargets(w, h) {
    const gl = this.gl;
    if (w <= this.tw && h <= this.th && this.targets.length) return;
    this.tw = Math.max(w, this.tw);
    this.th = Math.max(h, this.th);
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.targets = [];
    for (let i = 0; i < 3; i++) {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.tw, this.th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.targets.push({ tex, fb });
    }
  }

  // Draw one full-image pass with program `name` into `target` (null: the canvas).
  pass(name, target, w, h, setup) {
    const gl = this.gl;
    const { p, u } = this.programs[name];
    gl.useProgram(p);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, w, h);
      gl.uniform2i(u.u_origin, 0, 0);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, this.canvas.height - h, w, h);
      gl.uniform2i(u.u_origin, 0, this.canvas.height - h);
    }
    gl.uniform2i(u.u_size, w, h);
    setup(u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  bind(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // Blur `from` into a free target, `passes` times; returns the target holding the result.
  blur(from, w, h, bx, by, passes, free) {
    let cur = from;
    for (let n = 0; n < passes; n++) {
      for (const [size, dir] of [[bx, [1, 0]], [by, [0, 1]]]) {
        const full = Math.min(255, size);
        if (full <= 1) continue;
        const radius = (full - 1) / 2;
        const m = Math.ceil(radius) - 1;
        const alpha = Math.floor((radius - m) * 255) / 255;
        const out = free.find((t) => t !== cur);
        this.pass('blur', out, w, h, (u) => {
          this.bind(0, cur.tex, u.u_tex);
          this.gl.uniform2i(u.u_dir, dir[0], dir[1]);
          this.gl.uniform1i(u.u_m, m);
          this.gl.uniform1f(u.u_alpha, alpha);
          this.gl.uniform1f(u.u_full, full);
        });
        cur = out;
      }
    }
    return cur;
  }

  // Filter the top-left w x h of `src` (a canvas) and draw the result into `outCtx`.
  // Returns false if the GPU is unavailable, so the caller can fall back.
  run(src, w, h, filters, s, outCtx) {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    this.ensureTargets(w, h);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    // The source: a canvas's pixels are already premultiplied.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    let cur = { tex: this.source, fb: null };
    const T = this.targets;
    for (const f of filters) {
      if (f.type === 'blur') {
        const passes = Math.min(15, f.passes || 0);
        const bx = scaleBlur(f.blurX, s), by = scaleBlur(f.blurY, s);
        if (!passes || (bx <= 1 && by <= 1)) continue;
        cur = this.blur(cur, w, h, bx, by, passes, T);
      } else if (f.type === 'glow' || f.type === 'dropShadow') {
        const passes = Math.min(15, f.passes || 0);
        const bx = scaleBlur(f.blurX, s), by = scaleBlur(f.blurY, s);
        const free = T.filter((t) => t !== cur);
        const blurred = passes ? this.blur(cur, w, h, bx, by, passes, free) : cur;
        const out = T.find((t) => t !== cur && t !== blurred);
        const dist = f.type === 'dropShadow' ? (f.distance || 0) * s : 0;
        const ang = f.type === 'dropShadow' ? f.angle || 0 : 0;
        const c = f.color || [0, 0, 0, 255];
        const src0 = cur;
        this.pass('glow', out, w, h, (u) => {
          this.bind(0, src0.tex, u.u_src);
          this.bind(1, blurred.tex, u.u_blur);
          gl.uniform4f(u.u_color, c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255);
          gl.uniform1f(u.u_strength, f.strength === undefined ? 1 : f.strength);
          gl.uniform1i(u.u_inner, f.inner ? 1 : 0);
          gl.uniform1i(u.u_knockout, f.knockout ? 1 : 0);
          gl.uniform1i(u.u_composite, f.composite === 0 ? 0 : 1);
          gl.uniform2f(u.u_offset, -Math.cos(ang) * dist, -Math.sin(ang) * dist);
        });
        cur = out;
      } else if (f.type === 'colorMatrix') {
        const M = f.matrix;
        const m = new Float32Array(16);
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) m[col * 4 + row] = M[row * 5 + col];
        const out = T.find((t) => t !== cur);
        const src0 = cur;
        this.pass('matrix', out, w, h, (u) => {
          this.bind(0, src0.tex, u.u_tex);
          gl.uniformMatrix4fv(u.u_m, false, m);
          gl.uniform4f(u.u_add, M[4] / 255, M[9] / 255, M[14] / 255, M[19] / 255);
        });
        cur = out;
      }
    }
    const last = cur;
    this.pass('out', null, w, h, (u) => this.bind(0, last.tex, u.u_tex));
    outCtx.globalCompositeOperation = 'copy';
    outCtx.drawImage(this.canvas, 0, 0, w, h, 0, 0, w, h);
    outCtx.globalCompositeOperation = 'source-over';
    return true;
  }
}
