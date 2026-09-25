// Drawing the display list onto a canvas.
//
// Flash renders in stage coordinates (600x400 here); this renders the same scene at the
// canvas's real resolution, so the picture is the original's, only sharper where the
// original was vector.  Bitmaps follow _quality exactly as Flash 8 did: at "medium" --
// which this game sets -- bitmaps are not smoothed.

import { mul, invert, cxMul, cxIsIdentity, cxAlphaOnly, cxApplyRGBA, cssColor, cxKey, boundsOf } from './geom.js';
import { MovieClip, ShapeObj, MorphObj, TextObj, EditText, ButtonObj, BitmapObj } from './display.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export class Renderer {
  constructor(canvas, player) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.player = player;
    this.stageW = 600;
    this.stageH = 400;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.tints = new Map();           // "bitmapId|cx" -> canvas
    this.filterDefs = new Map();      // key -> id
    this.filterSvg = null;
    this.scratch = [];                // offscreen canvases for filtered objects
  }

  // Fit the stage into the canvas, preserving aspect ratio (Flash's "showAll").
  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.scale = Math.min(w / this.stageW, h / this.stageH);
    this.offsetX = (w - this.stageW * this.scale) / 2;
    this.offsetY = (h - this.stageH * this.scale) / 2;
  }

  stageMatrix() {
    return [this.scale, 0, 0, this.scale, this.offsetX, this.offsetY];
  }

  // Canvas pixel -> stage coordinates.
  toStage(px, py) {
    return [(px - this.offsetX) / this.scale, (py - this.offsetY) / this.scale];
  }

  render(levels, background) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.offsetX, this.offsetY, this.stageW * this.scale, this.stageH * this.scale);
    ctx.clip();
    ctx.fillStyle = cssColor(background);
    ctx.fillRect(this.offsetX, this.offsetY, this.stageW * this.scale, this.stageH * this.scale);
    const sm = this.stageMatrix();
    for (const level of levels) if (level) this.draw(ctx, level, sm, null);
    ctx.restore();
  }

  // ---- the tree ----------------------------------------------------------------------
  draw(ctx, obj, parentM, parentCx) {
    if (!obj.$visible || obj.$removed || obj.$maskOf) return;     // a setMask() mask is never drawn
    const m = mul(parentM, obj.$m);
    const cx = cxMul(parentCx, obj.$cx);
    if (cx && cx[3] <= 0 && cx[7] <= 0) return;           // fully transparent
    const mask = obj.$maskClip;
    if (mask && !mask.$removed) {
      // The mask sits wherever it is in the display list; express its transform relative
      // to this object so the same code works on the stage and inside BitmapData.draw.
      const rel = mul(invert(obj.$worldMatrix()), mask.$worldMatrix());
      const clip = new Path2D();
      this.collectMask(clip, mask, mul(m, rel));
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clip(clip, 'nonzero');
      if (obj.$filters && obj.$filters.length) this.drawFiltered(ctx, obj, m, cx);
      else this.drawContent(ctx, obj, m, cx);
      ctx.restore();
      return;
    }
    if (obj.$filters && obj.$filters.length) return this.drawFiltered(ctx, obj, m, cx);
    this.drawContent(ctx, obj, m, cx);
  }

  drawContent(ctx, obj, m, cx) {
    if (obj instanceof MovieClip) {
      if (obj.$gfx && obj.$gfx.ops.length) this.drawGraphics(ctx, obj.$gfx, m, cx);
      this.drawChildren(ctx, obj.$children, m, cx);
    } else if (obj instanceof ShapeObj) {
      this.drawShape(ctx, obj, m, cx);
    } else if (obj instanceof ButtonObj) {
      this.drawChildren(ctx, obj.$children, m, cx);
    } else if (obj instanceof EditText) {
      this.player.text.draw(ctx, obj, m, cx, this);
    } else if (obj instanceof TextObj) {
      this.drawStaticText(ctx, obj, m, cx);
    } else if (obj instanceof MorphObj) {
      this.drawMorph(ctx, obj, m, cx);
    } else if (obj instanceof BitmapObj) {
      this.drawBitmapData(ctx, obj.$bmd, m, cx, obj.$smooth);
    }
  }

  drawChildren(ctx, children, m, cx) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.$clipDepth) {
        // A mask: everything above it up to clipDepth is drawn through its shape.
        let j = i + 1;
        while (j < children.length && children[j].$depth <= c.$clipDepth) j++;
        const masked = children.slice(i + 1, j);
        // A mask applies whether or not the mask itself is visible.
        ctx.save();
        const clip = new Path2D();
        this.collectMask(clip, c, mul(m, c.$m));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clip(clip, 'nonzero');
        for (const mc of masked) this.draw(ctx, mc, m, cx);
        ctx.restore();
        i = j - 1;
        continue;
      }
      this.draw(ctx, c, m, cx);
    }
  }

  collectMask(path, obj, m) {
    const dm = new DOMMatrix(m);
    if (obj instanceof ShapeObj) {
      const ch = obj.$char;
      if (ch.bmp) {
        const r = new Path2D();
        r.rect(ch.b[0], ch.b[1], ch.b[2] - ch.b[0], ch.b[3] - ch.b[1]);
        path.addPath(r, dm);
      } else {
        ch.layers.forEach((L, li) => L.fills.forEach((f, fi) => {
          path.addPath(obj.$lib.path(`${obj.$cid}:${li}:f${fi}`, f.p), dm);
        }));
      }
    } else if (obj instanceof MovieClip) {
      for (const c of obj.$children) if (!c.$clipDepth) this.collectMask(path, c, mul(m, c.$m));
    } else if (obj instanceof MorphObj) {
      const p = this.morphPaths(obj);
      for (const f of p.fills) path.addPath(f.path, dm);
    }
  }

  // ---- shapes ------------------------------------------------------------------------
  setTransform(ctx, m) {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  // Flash 8: at low and medium quality bitmaps are never smoothed; at high and best
  // they are smoothed where the fill asks for it.
  smoothing(flagged) {
    const q = this.player.quality;
    return (q === 'high' || q === 'best') && !!flagged;
  }

  drawShape(ctx, obj, m, cx) {
    const ch = obj.$char;
    if (ch.bmp) return this.drawBitmapChar(ctx, ch.bmp.id, mul(m, ch.bmp.m), cx, obj.$lib, ch.bmp.smooth);
    for (let li = 0; li < ch.layers.length; li++) {
      const L = ch.layers[li];
      for (let fi = 0; fi < L.fills.length; fi++) {
        const f = L.fills[fi];
        const path = obj.$lib.path(`${obj.$cid}:${li}:f${fi}`, f.p);
        this.fillPath(ctx, path, f.s, m, cx, obj.$lib);
      }
      for (let i = 0; i < L.lines.length; i++) {
        const l = L.lines[i];
        const path = obj.$lib.path(`${obj.$cid}:${li}:l${i}`, l.p);
        this.strokePath(ctx, path, l.s, m, cx);
      }
    }
  }

  fillPath(ctx, path, style, m, cx, lib) {
    this.setTransform(ctx, m);
    ctx.globalAlpha = 1;
    const t = style.t;
    if (t === 'solid') {
      ctx.fillStyle = cssColor(cxApplyRGBA(cx, style.c));
      ctx.fill(path, 'evenodd');
    } else if (t === 'linear' || t === 'radial' || t === 'focal') {
      const g = style.m;
      // Gradients live in a +/-819.2px square; draw them in that space.
      ctx.save();
      ctx.clip(path, 'evenodd');
      this.setTransform(ctx, mul(m, g));
      let grad;
      if (t === 'linear') grad = ctx.createLinearGradient(-819.2, 0, 819.2, 0);
      else {
        const fx = t === 'focal' ? (style.focal || 0) * 819.2 : 0;
        grad = ctx.createRadialGradient(fx, 0, 0, 0, 0, 819.2);
      }
      for (const [ratio, col] of style.stops) grad.addColorStop(ratio / 255, cssColor(cxApplyRGBA(cx, col)));
      ctx.fillStyle = grad;
      // Pad: cover the whole clip region generously in gradient space.
      ctx.fillRect(-819.2 * 64, -819.2 * 64, 819.2 * 128, 819.2 * 128);
      ctx.restore();
    } else if (t === 'bitmap') {
      const src = this.bitmapSource(style.id, cx, lib);
      if (!src) return;
      ctx.save();
      ctx.clip(path, 'evenodd');
      const bm = mul(m, style.m);
      this.setTransform(ctx, bm);
      ctx.imageSmoothingEnabled = this.smoothing(style.smooth);
      if (style.repeat) {
        ctx.fillStyle = ctx.createPattern(src, 'repeat');
        ctx.fillRect(-1e5, -1e5, 2e5, 2e5);          // clipped to the path above
      } else {
        ctx.drawImage(src, 0, 0);
      }
      ctx.restore();
    }
  }

  strokePath(ctx, path, style, m, cx) {
    this.setTransform(ctx, m);
    ctx.globalAlpha = 1;
    const col = style.c ? cxApplyRGBA(cx, style.c) : [0, 0, 0, 255];
    ctx.strokeStyle = cssColor(col);
    // Width 0 is a hairline: one device pixel at any scale.
    const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
    const w = style.w;
    ctx.lineWidth = w > 0 ? Math.max(w, 1 / Math.max(sx, 1e-6)) : 1 / Math.max(sx, 1e-6);
    ctx.lineCap = style.startCap === 'none' ? 'butt' : style.startCap || 'round';
    ctx.lineJoin = style.join || 'round';
    if (style.miter) ctx.miterLimit = style.miter;
    ctx.stroke(path);
  }

  // ---- bitmaps -----------------------------------------------------------------------
  bitmapSource(id, cx, lib) {
    const img = lib.bitmaps.get(id);
    if (!img) return null;
    if (cxIsIdentity(cx)) return img;
    return this.tinted(`${lib.movie}:${id}`, img, cx);
  }

  tinted(key, img, cx) {
    const k = key + '|' + cxKey(cx);
    let c = this.tints.get(k);
    if (c) {
      this.tints.delete(k);
      this.tints.set(k, c);          // LRU: most recent last
      return c;
    }
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    if (w && h) {
      const d = g.getImageData(0, 0, w, h);
      const p = d.data;
      const [rm, gm, bm, am, ra, ga, ba, aa] = cx;
      for (let i = 0; i < p.length; i += 4) {
        let v = ((p[i] * rm) >> 8) + ra; p[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        v = ((p[i + 1] * gm) >> 8) + ga; p[i + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
        v = ((p[i + 2] * bm) >> 8) + ba; p[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        v = ((p[i + 3] * am) >> 8) + aa; p[i + 3] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      g.putImageData(d, 0, 0);
    }
    this.tints.set(k, c);
    if (this.tints.size > 600) this.tints.delete(this.tints.keys().next().value);
    return c;
  }

  drawBitmapChar(ctx, id, m, cx, lib, smooth) {
    const img = lib.bitmaps.get(id);
    if (!img) return;
    this.setTransform(ctx, m);
    ctx.imageSmoothingEnabled = this.smoothing(smooth);
    if (cxIsIdentity(cx)) {
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0);
    } else if (cxAlphaOnly(cx) && cx[3] <= 256 && cx[7] === 0) {
      ctx.globalAlpha = Math.max(0, cx[3] / 256);
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 1;
      ctx.drawImage(this.tinted(`${lib.movie}:${id}`, img, cx), 0, 0);
    }
  }

  drawBitmapData(ctx, bmd, m, cx, smooth) {
    this.setTransform(ctx, m);
    ctx.imageSmoothingEnabled = this.smoothing(smooth);
    const src = bmd.$canvas;
    if (cxIsIdentity(cx)) {
      ctx.globalAlpha = 1;
      ctx.drawImage(src, 0, 0);
    } else if (cxAlphaOnly(cx) && cx[3] <= 256) {
      ctx.globalAlpha = Math.max(0, cx[3] / 256);
      ctx.drawImage(src, 0, 0);
      ctx.globalAlpha = 1;
    } else {
      ctx.drawImage(this.tinted(`bmd${bmd.$id}:${bmd.$version}`, src, cx), 0, 0);
    }
  }

  // ---- the drawing API ------------------------------------------------------------------
  drawGraphics(ctx, g, m, cx) {
    let fill = null;        // {kind, style}
    let fillPath = null;
    let strokeStyle = null;
    let strokePath = null;
    let pen = [0, 0];
    const flushStroke = () => {
      if (strokeStyle && strokePath) {
        this.setTransform(ctx, m);
        const col = cxApplyRGBA(cx, [(strokeStyle.c >> 16) & 255, (strokeStyle.c >> 8) & 255, strokeStyle.c & 255,
          Math.max(0, Math.min(255, Math.round(strokeStyle.a * 2.55)))]);
        ctx.strokeStyle = cssColor(col);
        const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
        ctx.lineWidth = strokeStyle.w > 0 ? strokeStyle.w : 1 / Math.max(sx, 1e-6);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 1;
        ctx.stroke(strokePath);
      }
      strokePath = null;
    };
    const flushFill = () => {
      if (fill && fillPath) {
        this.setTransform(ctx, m);
        ctx.globalAlpha = 1;
        if (fill.kind === 'solid') {
          const s = fill.style;
          ctx.fillStyle = cssColor(cxApplyRGBA(cx, [(s.c >> 16) & 255, (s.c >> 8) & 255, s.c & 255,
            Math.max(0, Math.min(255, Math.round(s.a * 2.55)))]));
          ctx.fill(fillPath, 'evenodd');
        } else if (fill.kind === 'bitmap') {
          const s = fill.style;
          const bmd = s.bmd;
          const src = bmd && (bmd.$canvas || null);
          if (src) {
            ctx.save();
            ctx.clip(fillPath, 'evenodd');
            this.setTransform(ctx, mul(m, s.m));
            ctx.imageSmoothingEnabled = this.smoothing(s.smooth);
            const img = cxIsIdentity(cx) ? src : this.tinted(`bmd${bmd.$id}:${bmd.$version}`, src, cx);
            if (s.repeat) {
              ctx.fillStyle = ctx.createPattern(img, 'repeat');
              ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
            } else {
              ctx.drawImage(img, 0, 0);
            }
            ctx.restore();
          }
        }
      }
      fillPath = null;
    };
    for (const op of g.ops) {
      switch (op[0]) {
        case 'ls':
          flushStroke();
          strokeStyle = op[1];
          break;
        case 'bf':
          flushFill();
          fill = { kind: 'solid', style: op[1] };
          fillPath = new Path2D();
          fillPath.moveTo(pen[0], pen[1]);
          break;
        case 'bb':
          flushFill();
          fill = { kind: 'bitmap', style: op[1] };
          fillPath = new Path2D();
          fillPath.moveTo(pen[0], pen[1]);
          break;
        case 'ef':
          flushFill();
          fill = null;
          break;
        case 'm':
          pen = [op[1], op[2]];
          if (fillPath) fillPath.moveTo(op[1], op[2]);
          if (strokeStyle) {
            if (!strokePath) strokePath = new Path2D();
            strokePath.moveTo(op[1], op[2]);
          }
          break;
        case 'l':
          if (fillPath) fillPath.lineTo(op[1], op[2]);
          if (strokeStyle) {
            if (!strokePath) { strokePath = new Path2D(); strokePath.moveTo(pen[0], pen[1]); }
            strokePath.lineTo(op[1], op[2]);
          }
          pen = [op[1], op[2]];
          break;
        case 'q':
          if (fillPath) fillPath.quadraticCurveTo(op[1], op[2], op[3], op[4]);
          if (strokeStyle) {
            if (!strokePath) { strokePath = new Path2D(); strokePath.moveTo(pen[0], pen[1]); }
            strokePath.quadraticCurveTo(op[1], op[2], op[3], op[4]);
          }
          pen = [op[3], op[4]];
          break;
        default:
          break;
      }
    }
    flushFill();
    flushStroke();
  }

  // ---- morph shapes -----------------------------------------------------------------------
  morphPaths(obj) {
    const ch = obj.$char;
    const t = obj.$ratio / 65535;
    const lerp = (a, b) => a + (b - a) * t;
    const fills = new Map();
    const lines = new Map();
    let f0 = 0, f1 = 0, ln = 0;
    const E0 = ch.start, E1 = ch.end;
    let k1 = 0;
    for (let i = 0; i < E0.length; i++) {
      const a = E0[i];
      if (a[0] === 'M') {
        f0 = a[3]; f1 = a[4]; ln = a[5];
        continue;
      }
      while (k1 < E1.length && E1[k1][0] === 'M') k1++;
      const b = E1[k1++] || a;
      const seg = (e) => (e[0] === 'L' ? [e[1], e[2], (e[1] + e[3]) / 2, (e[2] + e[4]) / 2, e[3], e[4]] : [e[1], e[2], e[3], e[4], e[5], e[6]]);
      const sa = seg(a), sb = seg(b);
      const s = sa.map((v, j) => lerp(v, sb[j]));
      const edge = s;
      const add = (map, idx, rev) => {
        if (!idx) return;
        if (!map.has(idx)) map.set(idx, []);
        map.get(idx).push(rev ? [edge[4], edge[5], edge[2], edge[3], edge[0], edge[1]] : edge);
      };
      add(fills, f1, false);
      add(fills, f0, true);
      add(lines, ln, false);
    }
    const toPath = (segs) => {
      const p = new Path2D();
      let last = null;
      for (const s of segs) {
        if (!last || last[0] !== s[0] || last[1] !== s[1]) p.moveTo(s[0], s[1]);
        p.quadraticCurveTo(s[2], s[3], s[4], s[5]);
        last = [s[4], s[5]];
      }
      return p;
    };
    // A fill's edges arrive in drawing order, the fill-0 ones reversed; join them end to
    // start into closed loops (as tools/swf/shapes.py does for ordinary shapes).
    const key = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
    const toLoops = (segs) => {
      const byStart = new Map();
      segs.forEach((s, i) => {
        const k = key(s[0], s[1]);
        if (!byStart.has(k)) byStart.set(k, []);
        byStart.get(k).push(i);
      });
      const used = new Uint8Array(segs.length);
      const p = new Path2D();
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        let s = segs[i];
        const first = key(s[0], s[1]);
        p.moveTo(s[0], s[1]);
        for (;;) {
          p.quadraticCurveTo(s[2], s[3], s[4], s[5]);
          const k = key(s[4], s[5]);
          if (k === first) break;
          const next = (byStart.get(k) || []).find((j) => !used[j]);
          if (next === undefined) break;
          used[next] = 1;
          s = segs[next];
        }
        p.closePath();
      }
      return p;
    };
    const lerpC = (c0, c1) => c0.map((v, j) => Math.round(lerp(v, c1[j])));
    return {
      fills: [...fills].map(([i, segs]) => ({ style: ch.fills[i - 1], path: toLoops(segs) })),
      lines: [...lines].map(([i, segs]) => ({ style: ch.lines[i - 1], path: toPath(segs) })),
      lerp, lerpC,
    };
  }

  drawMorph(ctx, obj, m, cx) {
    const P = this.morphPaths(obj);
    for (const f of P.fills) {
      const s = f.style;
      if (!s) continue;
      if (s.t === 'solid') {
        this.setTransform(ctx, m);
        ctx.fillStyle = cssColor(cxApplyRGBA(cx, P.lerpC(s.c0, s.c1)));
        ctx.fill(f.path, 'evenodd');
      } else if (s.t === 'bitmap') {
        const t = obj.$ratio / 65535;
        const bm = s.m0.map((v, j) => v + (s.m1[j] - v) * t);
        this.fillPath(ctx, f.path, { t: 'bitmap', id: s.id, m: bm, repeat: s.repeat, smooth: s.smooth }, m, cx, obj.$lib);
      } else {
        const t = obj.$ratio / 65535;
        const gm = s.m0.map((v, j) => v + (s.m1[j] - v) * t);
        const stops = s.stops.map(([r0, c0, r1, c1]) => [Math.round(r0 + (r1 - r0) * t), P.lerpC(c0, c1)]);
        this.fillPath(ctx, f.path, { t: s.t, m: gm, stops, focal: s.focal0 }, m, cx, obj.$lib);
      }
    }
    for (const l of P.lines) {
      const s = l.style;
      if (!s) continue;
      this.strokePath(ctx, l.path, { w: P.lerp(s.w0, s.w1), c: s.c0 ? P.lerpC(s.c0, s.c1) : [0, 0, 0, 255] }, m, cx);
    }
  }

  // ---- static text ------------------------------------------------------------------------
  drawStaticText(ctx, obj, m, cx) {
    const ch = obj.$char;
    const tm = mul(m, ch.m);
    for (const rec of ch.recs) {
      const font = obj.$lib.char(rec.font);
      if (!font) continue;
      const scale = rec.h / (font.em / 20);
      ctx.fillStyle = cssColor(cxApplyRGBA(cx, rec.color || [0, 0, 0, 255]));
      let x = rec.x;
      for (const [gi, adv] of rec.g) {
        const d = font.glyphs[gi];
        if (d) {
          const p = obj.$lib.path(`font${rec.font}:${gi}`, d);
          this.setTransform(ctx, mul(tm, [scale, 0, 0, scale, x, rec.y]));
          ctx.fill(p, 'evenodd');
        }
        x += adv;
      }
    }
  }

  // ---- filters ----------------------------------------------------------------------------
  // The object is drawn to an offscreen canvas in device space, then composited through
  // an SVG filter chain built from the Flash filter parameters.
  drawFiltered(ctx, obj, m, cx) {
    const lb = obj.$localBounds();
    if (!lb) return;
    const pad = this.filterPad(obj.$filters) * this.scale;
    const db = boundsOf(m, lb);
    const cw = ctx.canvas.width, chh = ctx.canvas.height;     // the stage, or a BitmapData
    const x0 = Math.max(-pad, Math.floor(db[0] - pad));
    const y0 = Math.max(-pad, Math.floor(db[1] - pad));
    const x1 = Math.min(cw + pad, Math.ceil(db[2] + pad));
    const y1 = Math.min(chh + pad, Math.ceil(db[3] + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0 || w * h > 16e6) return this.drawContent(ctx, obj, m, cx);
    const off = this.offscreen(w, h);
    const octx = off.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalAlpha = 1;
    octx.filter = 'none';
    octx.clearRect(0, 0, w, h);
    this.drawContent(octx, obj, mul([1, 0, 0, 1, -x0, -y0], m), cx);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = this.filterUrl(obj.$filters);
    ctx.drawImage(off, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
    this.scratch.push(off);
  }

  offscreen(w, h) {
    let c = this.scratch.pop();
    if (!c) c = document.createElement('canvas');
    if (c.width < w || c.height < h) {
      c.width = Math.max(c.width, w);
      c.height = Math.max(c.height, h);
    }
    return c;
  }

  filterPad(filters) {
    let p = 0;
    for (const f of filters) {
      const b = Math.max(f.blurX || 0, f.blurY || 0) * Math.sqrt(Math.max(1, f.passes || 1));
      p = Math.max(p, b * 1.5 + (f.distance || 0));
    }
    return Math.ceil(p) + 2;
  }

  filterUrl(filters) {
    const key = this.scale.toFixed(3) + '|' + JSON.stringify(filters);
    let id = this.filterDefs.get(key);
    if (!id) {
      id = 'cacf' + this.filterDefs.size;
      this.filterDefs.set(key, id);
      this.defineFilter(id, filters);
    }
    return `url(#${id})`;
  }

  defineFilter(id, filters) {
    if (!this.filterSvg) {
      this.filterSvg = document.createElementNS(SVGNS, 'svg');
      this.filterSvg.setAttribute('width', '0');
      this.filterSvg.setAttribute('height', '0');
      this.filterSvg.style.position = 'absolute';
      document.body.appendChild(this.filterSvg);
    }
    const fe = document.createElementNS(SVGNS, 'filter');
    fe.setAttribute('id', id);
    fe.setAttribute('x', '-50%');
    fe.setAttribute('y', '-50%');
    fe.setAttribute('width', '200%');
    fe.setAttribute('height', '200%');
    fe.setAttribute('color-interpolation-filters', 'sRGB');
    const s = this.scale;
    let src = 'SourceGraphic';
    let n = 0;
    const el = (tag, attrs) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      fe.appendChild(e);
      return e;
    };
    // Flash's blur is a box blur `passes` times; a box of width w has sigma w/sqrt(12),
    // and n passes compound to sigma * sqrt(n).
    const sigma = (b, passes) => (b * s / Math.sqrt(12)) * Math.sqrt(Math.max(1, passes || 1));
    for (const f of filters) {
      const out = 'r' + (n++);
      if (f.type === 'blur') {
        el('feGaussianBlur', { in: src, stdDeviation: `${sigma(f.blurX, f.passes)} ${sigma(f.blurY, f.passes)}`, result: out });
      } else if (f.type === 'colorMatrix') {
        const mm = f.matrix.slice();
        for (const i of [4, 9, 14, 19]) mm[i] = mm[i] / 255;
        el('feColorMatrix', { in: src, type: 'matrix', values: mm.join(' '), result: out });
      } else if (f.type === 'glow' || f.type === 'dropShadow') {
        const [r, g, b, a] = f.color;
        const strength = f.strength === undefined ? 1 : f.strength;
        const dist = f.type === 'dropShadow' ? f.distance * s : 0;
        const ang = f.type === 'dropShadow' ? f.angle : 0;
        el('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: `${sigma(f.blurX, f.passes)} ${sigma(f.blurY, f.passes)}`, result: out + 'b' });
        el('feOffset', { in: out + 'b', dx: dist * Math.cos(ang), dy: dist * Math.sin(ang), result: out + 'o' });
        // Strength scales the blurred alpha before it is coloured, as Flash's does.
        el('feComponentTransfer', { in: out + 'o', result: out + 's' }).appendChild((() => {
          const fa = document.createElementNS(SVGNS, 'feFuncA');
          fa.setAttribute('type', 'linear');
          fa.setAttribute('slope', String(strength));
          return fa;
        })());
        el('feFlood', { 'flood-color': `rgb(${r},${g},${b})`, 'flood-opacity': String(a / 255), result: out + 'c' });
        el('feComposite', { in: out + 'c', in2: out + 's', operator: 'in', result: out + 'g' });
        if (f.inner) {
          el('feComposite', { in: out + 'g', in2: 'SourceAlpha', operator: 'out', result: out + 'i' });
          el('feComposite', { in: out + 'i', in2: src, operator: 'atop', result: out });
        } else if (f.knockout) {
          el('feComposite', { in: out + 'g', in2: 'SourceAlpha', operator: 'out', result: out });
        } else {
          const mg = el('feMerge', { result: out });
          for (const inp of [out + 'g', src]) {
            const node = document.createElementNS(SVGNS, 'feMergeNode');
            node.setAttribute('in', inp);
            mg.appendChild(node);
          }
        }
      } else {
        continue;                   // bevel/convolution/gradient filters: not in this game
      }
      src = out;
    }
    this.filterSvg.appendChild(fe);
  }
}
