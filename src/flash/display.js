// The display list: every kind of object a SWF can put on stage, the timeline player
// that animates MovieClips, and the ActionScript 2 properties and methods scripts use.
//
// Internal state lives in `$`-prefixed fields so it never collides with the variables
// ActionScript stores on the same objects; __as.keys() leaves those out of for..in.

import { mul, invert, apply, boundsOf, unionBounds, twip, cxMul } from './geom.js';

export const DEPTH_OFFSET = -16384;      // SWF depth d is ActionScript depth d - 16384

let nextInstance = 1;

export class DisplayObject {
  constructor(player, lib, cid) {
    this.$player = player;
    this.$lib = lib;
    this.$cid = cid;
    this.$char = cid != null ? lib.char(cid) : null;
    this.$parent = null;
    this.$depth = 0;
    this.$name = '';
    this.$m = [1, 0, 0, 1, 0, 0];
    this.$cx = null;
    this.$visible = true;
    this.$filters = null;
    this.$clipDepth = 0;
    this.$ratio = 0;
    this.$timeline = false;       // placed by a timeline (as opposed to a script)
    this.$placeFrame = 0;
    this.$scripted = false;       // transform taken over by script
    this.$removed = false;
    this.$sr = null;              // cached [scaleX, scaleY, rotation(rad), skew(rad)]
    this.$maskClip = null;        // setMask(): the clip masking this one
    this.$maskOf = null;          // setMask(): the clip this one masks
    this.$id = nextInstance++;
    this.$born = player ? player.frame : 0;   // (smooth drawing: the frame it was made in)
  }

  // Smooth drawing: where a script found the object when it first moved it in a frame, so that
  // a drawing made between two frames can show it part of the way (render.js, smoothed()).
  $moving() {
    const p = this.$player;
    const f = p ? p.frame : 0;
    if (this.$ipFrame !== f) {
      this.$ipFrame = f;
      this.$ipX = this.$m[4];
      this.$ipY = this.$m[5];
      if (p) p.lastMove = f;
    }
  }

  // ---- geometry ---------------------------------------------------------------------
  $setMatrix(m) {
    this.$m = m.slice();
    this.$sr = null;
  }

  $cacheSR() {
    if (!this.$sr) {
      const [a, b, c, d] = this.$m;
      const rx = Math.atan2(b, a);
      const ry = Math.atan2(-c, d);
      this.$sr = [Math.sqrt(a * a + b * b), Math.sqrt(c * c + d * d), rx, ry - rx];
    }
    return this.$sr;
  }

  $applySR() {
    const [sx, sy, rot, skew] = this.$sr;
    this.$m[0] = sx * Math.cos(rot);
    this.$m[1] = sx * Math.sin(rot);
    this.$m[2] = -sy * Math.sin(rot + skew);
    this.$m[3] = sy * Math.cos(rot + skew);
  }

  $worldMatrix() {
    let m = this.$m;
    for (let p = this.$parent; p; p = p.$parent) m = mul(p.$m, m);
    return m;
  }

  $localBounds() {
    return null;
  }

  $boundsIn(space) {
    // Bounds of this object in `space`'s coordinates (null = parent space).
    const lb = this.$localBounds();
    if (!lb) return null;
    if (space === undefined || space === null) return boundsOf(this.$m, lb);
    const toWorld = this.$worldMatrix();
    const toSpace = space ? invert(space.$worldMatrix()) : [1, 0, 0, 1, 0, 0];
    return boundsOf(mul(toSpace, toWorld), lb);
  }

  $level() {
    let o = this;
    while (o.$parent) o = o.$parent;
    return o;
  }

  $isOnStage() {
    let o = this;
    while (o.$parent) {
      if (o.$removed) return false;
      o = o.$parent;
    }
    return !o.$removed && o.$isLevel === true;
  }

  $hitShape(x, y) {
    return false;
  }

  $markRemoved() {
    this.$removed = true;
  }

  // ---- ActionScript 2 properties -----------------------------------------------------
  get _x() { return this.$removed ? undefined : this.$m[4]; }
  set _x(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    this.$moving();
    this.$m[4] = twip(v);
    this.$scripted = true;
  }

  get _y() { return this.$removed ? undefined : this.$m[5]; }
  set _y(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    this.$moving();
    this.$m[5] = twip(v);
    this.$scripted = true;
  }

  get _xscale() { return this.$removed ? undefined : this.$cacheSR()[0] * 100; }
  set _xscale(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    this.$cacheSR()[0] = v / 100;
    this.$applySR();
    this.$scripted = true;
  }

  get _yscale() { return this.$removed ? undefined : this.$cacheSR()[1] * 100; }
  set _yscale(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    this.$cacheSR()[1] = v / 100;
    this.$applySR();
    this.$scripted = true;
  }

  get _rotation() {
    if (this.$removed) return undefined;
    let deg = this.$cacheSR()[2] * 180 / Math.PI;
    return deg;
  }
  set _rotation(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    let deg = v % 360;
    if (deg < -180) deg += 360;
    else if (deg > 180) deg -= 360;
    this.$cacheSR()[2] = deg * Math.PI / 180;
    this.$applySR();
    this.$scripted = true;
  }

  get _alpha() {
    if (this.$removed) return undefined;
    return (this.$cx ? this.$cx[3] : 256) * 100 / 256;
  }
  set _alpha(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    const cx = this.$cx ? this.$cx.slice() : [256, 256, 256, 256, 0, 0, 0, 0];
    cx[3] = Math.trunc(v * 256 / 100);         // 8.8 fixed point, as Flash stores it
    this.$cx = cx;
    this.$scripted = true;
  }

  get _visible() { return this.$removed ? undefined : this.$visible; }
  set _visible(v) {
    if (this.$removed) return;
    const was = this.$visible;
    this.$visible = typeof v === 'string' ? v !== '' && v !== '0' && v !== 'false' : !!v && v === v;
    if (this.$visible && !was) this.$shown = this.$player ? this.$player.frame : 0;   // (smooth drawing)
  }

  get _width() {
    if (this.$removed) return undefined;
    const b = this.$boundsIn();
    return b ? twip(b[2] - b[0]) : 0;
  }
  set _width(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    const lb = this.$localBounds();
    if (!lb || lb[2] === lb[0]) return;
    this.$cacheSR()[0] = v / (lb[2] - lb[0]);
    this.$applySR();
    this.$scripted = true;
  }

  get _height() {
    if (this.$removed) return undefined;
    const b = this.$boundsIn();
    return b ? twip(b[3] - b[1]) : 0;
  }
  set _height(v) {
    v = +v;
    if (Number.isNaN(v) || this.$removed) return;
    const lb = this.$localBounds();
    if (!lb || lb[3] === lb[1]) return;
    this.$cacheSR()[1] = v / (lb[3] - lb[1]);
    this.$applySR();
    this.$scripted = true;
  }

  get _name() { return this.$name; }
  set _name(v) {
    v = String(v);
    const p = this.$parent;
    if (p && p.$unlink) p.$unlink(this);
    this.$name = v;
    if (p && p.$link) p.$link(this);
  }

  get _parent() { return this.$parent || undefined; }
  get _root() { return this.$level(); }
  get _target() {
    const parts = [];
    let o = this;
    while (o.$parent) {
      parts.unshift(o.$name);
      o = o.$parent;
    }
    return '/' + parts.join('/');
  }

  get _xmouse() {
    const [x, y] = this.$player.mouse;
    return twip(apply(invert(this.$worldMatrix()), x, y)[0]);
  }
  get _ymouse() {
    const [x, y] = this.$player.mouse;
    return twip(apply(invert(this.$worldMatrix()), x, y)[1]);
  }

  get _quality() { return this.$player.quality; }
  set _quality(v) { this.$player.quality = String(v).toLowerCase(); }
  get _highquality() { return this.$player.quality === 'low' ? 0 : this.$player.quality === 'medium' ? 1 : 2; }
  get _url() { return this.$player.url; }
  get _droptarget() { return ''; }

  // Assigning filters copies them, as Flash does: changing a filter object afterwards
  // has no effect until it is assigned again (the game reassigns every frame it animates
  // one).  They are stored in the renderer's form, the same as filters from the SWF.
  get filters() {
    return (this.$filters || []).map((f) => Object.assign({}, f));
  }
  set filters(v) {
    if (this.$removed) return;
    const list = Array.isArray(v) ? v.map((f) => {
      if (f && typeof f.$toRender === 'function') return f.$toRender();
      return f && typeof f.type === 'string' ? f : null;
    }).filter(Boolean) : [];
    this.$filters = list.length ? list : null;
  }

  // String(clip) is the clip's path in dot notation, which is also what
  // Selection.getFocus() returns; the game compares the two.
  toString() {
    const parts = [];
    let o = this;
    while (o.$parent) {
      parts.unshift(o.$name);
      o = o.$parent;
    }
    parts.unshift(o.$name || '_level0');
    return parts.join('.');
  }

  getDepth() { return this.$depth; }

  swapDepths(target) {
    const p = this.$parent;
    if (!p || this.$removed) return;
    let depth;
    if (target instanceof DisplayObject) {
      if (target.$parent !== p) return;
      depth = target.$depth;
    } else {
      depth = Math.trunc(+target);
      if (Number.isNaN(depth)) return;
    }
    p.$swapDepth(this, depth);
    // A clip moved off its timeline depth stops being animated by that timeline.
    this.$timeline = false;
  }

  localToGlobal(pt) {
    if (!pt) return;
    const [x, y] = apply(this.$worldMatrix(), +pt.x, +pt.y);
    pt.x = x;
    pt.y = y;
  }

  globalToLocal(pt) {
    if (!pt) return;
    const [x, y] = apply(invert(this.$worldMatrix()), +pt.x, +pt.y);
    pt.x = x;
    pt.y = y;
  }

  getBounds(space) {
    const b = this.$boundsIn(space === undefined ? this : space) || [0, 0, 0, 0];
    return { xMin: b[0], yMin: b[1], xMax: b[2], yMax: b[3] };
  }

  hitTest(a, b, shape) {
    if (this.$removed || !this.$isOnStage()) return false;
    if (a instanceof DisplayObject) {
      const r1 = this.$boundsIn(false);
      const r2 = a.$boundsIn(false);
      if (!r1 || !r2) return false;
      return r1[0] <= r2[2] && r2[0] <= r1[2] && r1[1] <= r2[3] && r2[1] <= r1[3];
    }
    const x = +a, y = +b;
    if (shape) return this.$hitShapeWorld(x, y);
    const r = this.$boundsIn(false);
    return !!r && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  }

  $hitShapeWorld(x, y) {
    const inv = invert(this.$worldMatrix());
    const [lx, ly] = apply(inv, x, y);
    return this.$hitShape(lx, ly);
  }
}

// ---- static shapes ----------------------------------------------------------------------

export class ShapeObj extends DisplayObject {
  $localBounds() {
    return this.$char.b;
  }

  $hitShape(x, y) {
    const ch = this.$char;
    const b = ch.b;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
    if (ch.bmp) return true;                 // a bitmap's shape is its rectangle
    const ctx = this.$player.hitContext;
    for (let li = 0; li < ch.layers.length; li++) {
      const L = ch.layers[li];
      for (let fi = 0; fi < L.fills.length; fi++) {
        const p = this.$lib.path(`${this.$cid}:${li}:f${fi}`, L.fills[fi].p);
        if (ctx.isPointInPath(p, x, y, 'evenodd')) return true;
      }
      for (let i = 0; i < L.lines.length; i++) {
        const s = L.lines[i];
        const p = this.$lib.path(`${this.$cid}:${li}:l${i}`, s.p);
        ctx.lineWidth = Math.max(1, s.s.w);
        if (ctx.isPointInStroke(p, x, y)) return true;
      }
    }
    return false;
  }
}

export class MorphObj extends DisplayObject {
  $localBounds() {
    const t = this.$ratio / 65535, a = this.$char.b0, b = this.$char.b1;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
}

export class TextObj extends DisplayObject {
  $localBounds() {
    return this.$char.b;             // DefineText bounds are already in local space
  }
}

export class BitmapObj extends DisplayObject {
  // attachBitmap(): a BitmapData shown directly.
  constructor(player, lib, bmd, smoothing) {
    super(player, lib, null);
    this.$bmd = bmd;
    this.$smooth = !!smoothing;
  }

  $localBounds() {
    return [0, 0, this.$bmd.width, this.$bmd.height];
  }
}

// ---- the drawing API ------------------------------------------------------------------

let nextGraphics = 1;

export class Graphics {
  constructor() {
    this.$id = nextGraphics++;
    this.ops = [];
    this.bounds = null;
    this.pen = [0, 0];
  }

  $extend(x, y, pad = 0) {
    this.bounds = unionBounds(this.bounds, [x - pad, y - pad, x + pad, y + pad]);
  }
}

// ---- MovieClip ----------------------------------------------------------------------------

export class MovieClip extends DisplayObject {
  constructor(player, lib, cid) {
    super(player, lib, cid);
    const ch = this.$char;
    this.$frames = ch ? ch.frames : [[]];
    this.$labels = ch ? ch.labels : {};
    this.$total = ch ? ch.n : 1;
    this.$cur = 0;                // 0 = not yet constructed
    this.$playing = true;
    this.$children = [];          // sorted by depth
    this.$gfx = null;
    this.$events = null;          // clip-event handlers from PlaceObject: [{ev:[...], key, fn}]
    this.$loaded = false;
    this.$enabled = true;
    this.$handCursor = true;
    this.$cacheAsBitmap = false;
    this.$isLevel = false;
  }

  // ---- display list -------------------------------------------------------------------
  $childAt(depth) {
    const c = this.$children;
    for (let i = 0; i < c.length; i++) if (c[i].$depth === depth) return c[i];
    return null;
  }

  $insert(child, depth) {
    child.$parent = this;
    child.$depth = depth;
    const c = this.$children;
    let i = c.length;
    while (i > 0 && c[i - 1].$depth > depth) i--;
    c.splice(i, 0, child);
    this.$link(child);
  }

  $remove(child) {
    const c = this.$children;
    const i = c.indexOf(child);
    if (i >= 0) c.splice(i, 1);
    this.$unlink(child);
    child.$markRemoved();
  }

  // A named child can be reached as a property of its parent -- unless the parent has a
  // variable of that name, which comes first in AVM1's lookup.  (The game relies on it:
  // new Game() puts a clip called "Game" on _root, and _root.Game must stay the class.)
  $link(child) {
    const n = child.$name;
    if (!n) return;
    if (!this.$links) this.$links = new Map();
    const cur = Object.getOwnPropertyDescriptor(this, n);
    if (cur && this.$links.get(n) !== cur.value) return;       // a variable: it wins
    Object.defineProperty(this, n, { value: child, writable: true, enumerable: true, configurable: true });
    this.$links.set(n, child);
  }

  $unlink(child) {
    const n = child.$name;
    if (!n || !this.$links || this.$links.get(n) !== child) return;
    this.$links.delete(n);
    if (this[n] === child) delete this[n];
    // Another child of the same name becomes the one found by that name.
    for (const c of this.$children) {
      if (c !== child && c.$name === n && !c.$removed) {
        this.$link(c);
        break;
      }
    }
  }

  $markRemoved() {
    if (this.$removed) return;
    this.$player.clipEvent(this, 'unload');
    if (typeof this.onUnload === 'function') this.$player.queueMethod(this, 'onUnload');
    this.$removed = true;
    for (const c of this.$children) c.$markRemoved();
    this.$player.forget(this);
  }

  $swapDepth(child, depth) {
    if (child.$depth === depth) return;
    const other = this.$childAt(depth);
    const c = this.$children;
    const from = child.$depth;
    c.splice(c.indexOf(child), 1);
    if (other) {
      c.splice(c.indexOf(other), 1);
      other.$depth = from;
      this.$reinsert(other);
    }
    child.$depth = depth;
    this.$reinsert(child);
  }

  $reinsert(child) {
    const c = this.$children;
    let i = c.length;
    while (i > 0 && c[i - 1].$depth > child.$depth) i--;
    c.splice(i, 0, child);
  }

  $localBounds() {
    let b = this.$gfx ? this.$gfx.bounds : null;
    for (const c of this.$children) {
      if (c.$clipDepth) continue;
      const cb = c.$boundsIn();
      if (cb) b = unionBounds(b, cb);
    }
    return b;
  }

  $hitShape(x, y) {
    if (this.$gfx && this.$gfx.bounds) {
      const g = this.$gfx.bounds;
      if (x >= g[0] && x <= g[2] && y >= g[1] && y <= g[3] && this.$player.hitGraphics(this, x, y)) return true;
    }
    for (let i = this.$children.length - 1; i >= 0; i--) {
      const c = this.$children[i];
      if (c.$clipDepth || !c.$visible) continue;
      const [lx, ly] = apply(invert(c.$m), x, y);
      if (c.$hitShape(lx, ly)) return true;
    }
    return false;
  }

  // ---- construction and the timeline --------------------------------------------------
  // Called when the clip first appears: build frame 1 and queue its scripts.
  $construct() {
    this.$cur = 1;
    this.$runFrame(1, false);
  }

  $runFrame(f, skipScripts) {
    const ops = this.$frames[f - 1] || [];
    for (let i = 0; i < ops.length; i++) this.$op(ops[i], f, skipScripts);
  }

  $op(op, frame, skipScripts) {
    switch (op.o) {
      case 'P': this.$place(op, frame); break;
      case 'M': this.$move(op); break;
      case 'R': this.$replace(op, frame); break;
      case 'X': {
        const c = this.$childAt(op.d + DEPTH_OFFSET);
        if (c && c.$timeline) this.$remove(c);
        break;
      }
      case 'A':
        if (!skipScripts) this.$player.queueFrameScript(this, frame, op.i);
        break;
      case 'S':
        if (!skipScripts) this.$player.sound.timelineSound(this, op.id, op.info);
        break;
      default:
        throw new Error('unknown timeline op ' + op.o);
    }
  }

  $place(op, frame) {
    const depth = op.d + DEPTH_OFFSET;
    if (this.$childAt(depth)) return;              // occupied: Flash ignores the tag
    const child = this.$player.create(this.$lib, op.c);
    if (!child) return;
    child.$timeline = true;
    child.$placeFrame = frame;
    if (op.m) child.$setMatrix(op.m);
    if (op.x !== undefined) child.$cx = op.x;
    if (op.r !== undefined) child.$ratio = op.r;
    if (op.cd) child.$clipDepth = op.cd + DEPTH_OFFSET;
    if (op.f) child.$filters = op.f.length ? op.f : null;
    if (op.v !== undefined) child.$visible = !!op.v;
    child.$name = op.n !== undefined ? op.n : (child instanceof MovieClip || child instanceof ButtonObj || child instanceof EditText ? 'instance' + child.$id : '');
    this.$insert(child, depth);
    if (op.e && child instanceof MovieClip) {
      child.$events = op.e.map((rec, i) => ({ ev: rec.ev, key: rec.k, key_: `c${this.$timelineKey()}:${frame}:${op.d}:${i}` }));
    }
    this.$player.didPlace(child);
  }

  $move(op) {
    const c = this.$childAt(op.d + DEPTH_OFFSET);
    if (!c) return;
    if (!c.$scripted) {
      if (op.m) c.$setMatrix(op.m);
      if (op.x !== undefined) c.$cx = op.x;
    }
    if (op.r !== undefined) c.$ratio = op.r;
    if (op.cd) c.$clipDepth = op.cd + DEPTH_OFFSET;
    if (op.f) c.$filters = op.f.length ? op.f : null;
  }

  $replace(op, frame) {
    const depth = op.d + DEPTH_OFFSET;
    const c = this.$childAt(depth);
    if (!c) return this.$place(op, frame);
    const nch = this.$lib.char(op.c);
    const swappable = (x) => x instanceof ShapeObj || x instanceof MorphObj || x instanceof TextObj;
    if (swappable(c) && nch && (nch.t === 'shape' || nch.t === 'morph' || nch.t === 'text')) {
      // Shapes are swapped in place, keeping whatever the timeline has not changed.
      const n = this.$player.create(this.$lib, op.c);
      n.$timeline = true;
      n.$placeFrame = c.$placeFrame;
      n.$setMatrix(op.m || c.$m);
      n.$cx = op.x !== undefined ? op.x : c.$cx;
      n.$ratio = op.r !== undefined ? op.r : c.$ratio;
      n.$clipDepth = op.cd ? op.cd + DEPTH_OFFSET : c.$clipDepth;
      n.$filters = op.f ? (op.f.length ? op.f : null) : c.$filters;
      const i = this.$children.indexOf(c);
      n.$parent = this;
      n.$depth = depth;
      n.$name = c.$name;
      this.$children[i] = n;
      c.$removed = true;
      return;
    }
    this.$remove(c);
    this.$place(op, frame);
  }

  $timelineKey() {
    return this.$isLevel ? 'root' : String(this.$cid);
  }

  // One tick of the timeline, if playing.
  $advance() {
    if (!this.$playing || this.$total <= 1) return;
    const next = this.$cur + 1;
    if (next > this.$total) this.$gotoFrame(1, true);
    else {
      this.$cur = next;
      this.$runFrame(next, false);
    }
  }

  $frameOf(f) {
    if (typeof f === 'string') {
      if (Object.prototype.hasOwnProperty.call(this.$labels, f)) return this.$labels[f];
      const n = Number(f);
      if (f.trim() !== '' && !Number.isNaN(n)) return Math.trunc(n);
      return null;
    }
    const n = Math.trunc(+f);
    return Number.isNaN(n) ? null : n;
  }

  $gotoFrame(target, looping) {
    if (target < 1) target = 1;
    if (target > this.$total) target = this.$total;
    const cur = this.$cur;
    if (target === cur && !looping) return;
    if (target > cur) {
      for (let f = cur + 1; f <= target; f++) {
        this.$cur = f;
        this.$runFrame(f, f < target);
      }
      return;
    }
    // Backwards: rebuild what the timeline would have at `target`, keeping every object
    // that is still the same placement (same character, placed on the same frame).
    const state = new Map();                     // depth -> { op, frame }
    for (let f = 1; f <= target; f++) {
      for (const op of this.$frames[f - 1] || []) {
        if (op.o === 'P') {
          if (!state.has(op.d)) state.set(op.d, { op: Object.assign({}, op), frame: f });
        } else if (op.o === 'M') {
          const s = state.get(op.d);
          if (s) Object.assign(s.op, op, { o: 'P', c: s.op.c });
        } else if (op.o === 'R') {
          const s = state.get(op.d);
          state.set(op.d, { op: Object.assign({}, s ? s.op : {}, op, { o: 'P' }), frame: s && s.op.c === op.c ? s.frame : f });
        } else if (op.o === 'X') {
          state.delete(op.d);
        }
      }
    }
    for (const c of this.$children.slice()) {
      if (!c.$timeline) continue;
      const s = state.get(c.$depth - DEPTH_OFFSET);
      if (!s || s.op.c !== c.$cid || s.frame !== c.$placeFrame) this.$remove(c);
    }
    this.$cur = target;
    for (const [d, s] of state) {
      const c = this.$childAt(d + DEPTH_OFFSET);
      if (c) {
        if (!c.$scripted) {
          if (s.op.m) c.$setMatrix(s.op.m);
          c.$cx = s.op.x !== undefined ? s.op.x : null;
        }
        if (s.op.r !== undefined) c.$ratio = s.op.r;
      } else {
        this.$place(s.op, s.frame);
      }
    }
    for (const op of this.$frames[target - 1] || []) {
      if (op.o === 'A') this.$player.queueFrameScript(this, target, op.i);
      else if (op.o === 'S') this.$player.sound.timelineSound(this, op.id, op.info);
    }
  }

  // ---- ActionScript 2 -----------------------------------------------------------------
  get _currentframe() { return this.$removed ? undefined : this.$cur; }
  get _totalframes() { return this.$removed ? undefined : this.$total; }
  get _framesloaded() { return this.$removed ? undefined : this.$total; }
  get enabled() { return this.$enabled; }
  set enabled(v) { this.$enabled = !!v; }
  get useHandCursor() { return this.$handCursor; }
  set useHandCursor(v) { this.$handCursor = !!v; }
  get cacheAsBitmap() { return this.$cacheAsBitmap; }
  set cacheAsBitmap(v) { this.$cacheAsBitmap = !!v; }

  play() { if (!this.$removed) this.$playing = true; }
  stop() { if (!this.$removed) this.$playing = false; }

  gotoAndPlay(f) {
    if (this.$removed) return;
    const n = this.$frameOf(f);
    if (n === null) return;
    this.$playing = true;
    this.$gotoFrame(n, false);
  }

  gotoAndStop(f) {
    if (this.$removed) return;
    const n = this.$frameOf(f);
    this.$playing = false;
    if (n === null) return;
    this.$gotoFrame(n, false);
  }

  nextFrame() {
    if (this.$removed) return;
    this.$playing = false;
    if (this.$cur < this.$total) this.$gotoFrame(this.$cur + 1, false);
  }

  prevFrame() {
    if (this.$removed) return;
    this.$playing = false;
    if (this.$cur > 1) this.$gotoFrame(this.$cur - 1, false);
  }

  getNextHighestDepth() {
    let max = -1;
    for (const c of this.$children) if (c.$depth > max) max = c.$depth;
    return max + 1;
  }

  getBytesLoaded() { return this.$lib.bytesLoaded; }
  getBytesTotal() { return this.$lib.bytesTotal; }

  attachMovie(linkage, name, depth, init) {
    if (this.$removed) return undefined;
    const cid = this.$lib.exportId(String(linkage));
    if (cid === null) return undefined;
    return this.$player.attach(this, this.$lib, cid, String(name), Math.trunc(+depth), init);
  }

  createEmptyMovieClip(name, depth) {
    if (this.$removed) return undefined;
    return this.$player.attach(this, this.$lib, null, String(name), Math.trunc(+depth), null);
  }

  removeMovieClip() {
    // Only clips at non-negative depths can be removed -- in practice, those a script
    // created (timeline clips sit at negative depths until swapDepths moves them).  The
    // upper bound is Flash Player's, as Ruffle has it: 2130706416 less the depth offset.
    if (this.$removed || !this.$parent || this.$depth < 0 || this.$depth >= 2130706416 + DEPTH_OFFSET) return;
    this.$parent.$remove(this);
  }

  // setMask(mc): this clip is drawn only where mc's shapes are, and mc itself is no
  // longer drawn.  The mask keeps its own place in the display list and moves with it.
  setMask(mc) {
    if (this.$removed) return false;
    if (this.$maskClip) this.$maskClip.$maskOf = null;
    const m = mc instanceof DisplayObject && !mc.$removed ? mc : null;
    if (m) {
      if (m.$maskOf && m.$maskOf !== this) m.$maskOf.$maskClip = null;
      m.$maskOf = this;
    }
    this.$maskClip = m;
    return true;
  }

  attachBitmap(bmd, depth, pixelSnapping, smoothing) {
    if (this.$removed || !bmd) return;
    depth = Math.trunc(+depth);
    const old = this.$childAt(depth);
    if (old) this.$remove(old);
    const b = new BitmapObj(this.$player, this.$lib, bmd, smoothing);
    this.$insert(b, depth);
  }

  // Drawing API.  Colours are 0xRRGGBB, alphas 0..100.
  $g() {
    if (!this.$gfx) this.$gfx = new Graphics();
    return this.$gfx;
  }

  clear() {
    if (this.$gfx) {
      // (Smooth drawing: the last frame's drawing is kept, the first time it is cleared in a
      // frame, to be blended with this frame's -- render.js, blendedGfx.)
      const p = this.$player;
      const f = p ? p.frame : 0;
      if (this.$gfxFrame !== f) {
        this.$gfxPrev = this.$gfx;
        this.$gfxFrame = f;
        if (p) p.lastMove = f;
      }
      this.$gfx = new Graphics();
    }
  }

  lineStyle(thickness, rgb, alpha) {
    const g = this.$g();
    if (thickness === undefined || thickness === null || Number.isNaN(+thickness)) {
      g.ops.push(['ls', null]);
      g.line = null;
      return;
    }
    g.line = { w: +thickness, c: (+rgb || 0) >>> 0, a: alpha === undefined ? 100 : +alpha };
    g.ops.push(['ls', g.line]);
  }

  beginFill(rgb, alpha) {
    const g = this.$g();
    g.ops.push(['bf', { c: (+rgb || 0) >>> 0, a: alpha === undefined ? 100 : +alpha }]);
  }

  beginBitmapFill(bmd, matrix, repeat, smoothing) {
    const g = this.$g();
    const m = matrix ? [+matrix.a, +matrix.b, +matrix.c, +matrix.d, +matrix.tx, +matrix.ty] : [1, 0, 0, 1, 0, 0];
    g.ops.push(['bb', { bmd, m, repeat: repeat !== false, smooth: !!smoothing }]);
  }

  endFill() {
    this.$g().ops.push(['ef']);
  }

  moveTo(x, y) {
    const g = this.$g();
    x = +x; y = +y;
    g.ops.push(['m', x, y]);
    g.pen = [x, y];
    g.$extend(x, y);
  }

  lineTo(x, y) {
    const g = this.$g();
    x = +x; y = +y;
    g.ops.push(['l', x, y]);
    const pad = g.line ? g.line.w / 2 : 0;
    g.$extend(g.pen[0], g.pen[1], pad);
    g.$extend(x, y, pad);
    g.pen = [x, y];
  }

  curveTo(cx, cy, x, y) {
    const g = this.$g();
    cx = +cx; cy = +cy; x = +x; y = +y;
    g.ops.push(['q', cx, cy, x, y]);
    g.$extend(cx, cy);
    g.$extend(x, y);
    g.pen = [x, y];
  }
}

// ---- Buttons --------------------------------------------------------------------------------

export class ButtonObj extends DisplayObject {
  constructor(player, lib, cid) {
    super(player, lib, cid);
    this.$state = 'up';
    this.$children = [];
    this.$enabled = true;
    this.$handCursor = true;
  }

  $construct() {
    this.$setState('up');
  }

  $setState(state) {
    this.$state = state;
    for (const c of this.$children) c.$markRemoved();
    this.$children = [];
    for (const rec of this.$char.recs) {
      if (!rec.s.includes(state)) continue;
      const c = this.$player.create(this.$lib, rec.c);
      if (!c) continue;
      c.$setMatrix(rec.m);
      c.$cx = rec.x;
      if (rec.f) c.$filters = rec.f.length ? rec.f : null;
      c.$parent = this;
      c.$depth = rec.d;
      c.$timeline = true;
      this.$children.push(c);
      this.$player.didPlace(c);
    }
    this.$children.sort((a, b) => a.$depth - b.$depth);
  }

  $hitArea(x, y) {
    // Hit-test against the button's hit-state records.
    for (const rec of this.$char.recs) {
      if (!rec.s.includes('hit')) continue;
      const c = this.$player.hitProbe(this.$lib, rec.c);
      if (!c) continue;
      const [lx, ly] = apply(invert(rec.m), x, y);
      if (c.$hitShape(lx, ly)) return true;
    }
    return false;
  }

  $hitShape(x, y) {
    return this.$hitArea(x, y);
  }

  $localBounds() {
    let b = null;
    for (const c of this.$children) b = unionBounds(b, c.$boundsIn());
    return b;
  }

  $markRemoved() {
    this.$removed = true;
    for (const c of this.$children) c.$markRemoved();
  }

  get enabled() { return this.$enabled; }
  set enabled(v) { this.$enabled = !!v; }
  get useHandCursor() { return this.$handCursor; }
  set useHandCursor(v) { this.$handCursor = !!v; }
}

// ---- Text fields ------------------------------------------------------------------------------

export class EditText extends DisplayObject {
  constructor(player, lib, cid) {
    super(player, lib, cid);
    const ch = this.$char;
    this.$text = ch.text !== undefined ? ch.text : '';
    this.$html = !!ch.html;
    this.$variable = ch.variable || '';
    this.$color = ch.color ? ch.color.slice() : [0, 0, 0, 255];
    this.$scroll = 1;
    this.$focus = false;
  }

  $localBounds() {
    return this.$char.b;
  }

  $hitShape(x, y) {
    const b = this.$char.b;
    return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }

  get text() { return this.$player.text.plain(this); }
  set text(v) {
    this.$text = String(v);
    this.$html = false;
    this.$player.text.writeVariable(this);
  }

  get htmlText() { return this.$text; }
  set htmlText(v) {
    this.$text = String(v);
    this.$player.text.writeVariable(this);
  }

  get textColor() { return (this.$color[0] << 16) | (this.$color[1] << 8) | this.$color[2]; }
  set textColor(v) {
    v = (+v) >>> 0;
    this.$color = [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
  }

  get variable() { return this.$variable || null; }
  set variable(v) { this.$variable = v ? String(v) : ''; }
}
