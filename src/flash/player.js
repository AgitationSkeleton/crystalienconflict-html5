// The player: levels, the frame loop, the action queue, input, and the ActionScript scope.
//
// Frame cycle (23 times a second, the loader's rate -- which governs every level, as it
// does in Flash):
//
//   1. Go through the clips on stage newest first.  Flash Player keeps every clip in one
//      list, in the order they were made, and walks it from the most recent, so a
//      level's root (and its onEnterFrame) comes after everything in it.  For each clip,
//      queue its enterFrame handlers, then advance its timeline, which applies the new
//      frame's placements and queues that frame's scripts.  A clip made during this pass
//      is first advanced on the next frame.
//   2. Run the action queue in order.  Scripts can queue more (a goto queues the target
//      frame's script; attaching a clip queues its first frame), and those run too.
//   3. Draw.
//
// Scripts run inside `with (scope)`, where scope is a proxy giving ActionScript 2's
// lookup chain: the timeline, then _global, then the built-ins.  Assignments land on the
// timeline.  See tools/transpile.py for the other half of this.

import { MovieClip, ShapeObj, MorphObj, TextObj, EditText, ButtonObj, DEPTH_OFFSET } from './display.js';
import { Renderer } from './render.js';
import { TextEngine } from './text.js';
import { SoundSystem } from './sound.js';
import { installBuiltins } from './as2.js';
import { apply, invert } from './geom.js';

// Button key conditions use their own codes, not key codes.
const BUTTON_KEYS = {
  ArrowLeft: 1, ArrowRight: 2, Home: 3, End: 4, Insert: 5, Delete: 6, Backspace: 8,
  Enter: 13, ArrowUp: 14, ArrowDown: 15, PageUp: 16, PageDown: 17, Tab: 18, Escape: 19, ' ': 32,
};

export class Player {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.fps = 23;
    this.quality = 'high';
    this.url = location.href;
    this.levels = [];
    this.flashVars = opts.flashVars || {};
    this.renderer = new Renderer(canvas, this);
    this.text = new TextEngine(this);
    this.sound = new SoundSystem(this);
    this.global = {};                  // _global
    this.builtins = {};
    this.queue = [];
    this.scopes = new WeakMap();
    this.mouse = [0, 0];
    this.mouseDown = false;
    this.keys = new Set();
    this.lastKey = 0;
    this.lastAscii = 0;
    this.keyListeners = [];
    this.mouseListeners = [];
    this.clips = new Set();             // every clip, oldest first: Flash's execution list
    this.withEvents = new Set();        // clips with onClipEvent handlers or on* methods
    this.hover = null;                  // button under the mouse
    this.pressed = null;                // button the mouse went down on
    this.focus = null;                  // focused input text field
    this.mouseHidden = false;
    this.frame = 0;
    this.errors = new Map();            // script key -> count, so a failing script logs once
    const hc = document.createElement('canvas');
    hc.width = hc.height = 1;
    this.hitContext = hc.getContext('2d');
    this.openMovie = opts.openMovie || null;   // "game.swf" -> { lib, ready } (see loadMovieNum)
    this.onError = opts.onError || ((key, e) => console.error('[as2]', key, e));
    this.startTime = performance.now();
    this.random = Math.random;
    installBuiltins(this);
  }

  // A repeatable random sequence (mulberry32), for tests.
  seedRandom(seed) {
    let a = seed >>> 0;
    this.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // loadMovieNum(url, n), the loader's way of starting the game.  The SWF's file name
  // picks one of this port's converted movies; the level exists at once (the loader
  // stops and hides it every frame while it downloads) and its first frame is built
  // when everything has arrived.
  loadMovieNum(url, n) {
    const file = String(url).replace(/[?#].*$/, '').split('/').pop().toLowerCase();
    const movie = this.openMovie ? this.openMovie(file) : null;
    if (!movie) {
      console.warn('[player] loadMovieNum: no movie called', url);
      return;
    }
    const old = this.levels[n];
    if (old) old.$markRemoved();
    const root = this.placeholderLevel(n, movie.lib);
    movie.ready.then(() => {
      if (this.levels[n] === root && !root.$removed) this.finishLevel(root, movie.lib);
    }, (e) => this.onError('loadMovieNum ' + url, e));
  }

  setFullscreen(on) {
    const el = this.canvas.parentElement || this.canvas;
    try {
      if (on && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) { /* not allowed here: Flash ignored the request too */ }
  }

  // ---- levels --------------------------------------------------------------------------
  level(n) {
    return this.levels[n] || undefined;
  }

  async loadLevel(n, lib) {
    const root = new MovieClip(this, lib, null);
    root.$frames = lib.json.root.frames;
    root.$labels = lib.json.root.labels;
    root.$total = lib.json.root.n;
    root.$isLevel = true;
    root.$name = '_level' + n;
    root.$levelNumber = n;
    for (const [k, v] of Object.entries(this.flashVars)) if (n === 0) root[k] = v;
    this.levels[n] = root;
    this.track(root);
    root.$construct();
    this.runQueue();
    return root;
  }

  // A level that exists (so _level1.stop() works, as the loader expects) but whose movie
  // is still downloading: its byte counts are live, and its first frame is built the
  // moment the library is complete.
  placeholderLevel(n, lib) {
    const root = new MovieClip(this, lib, null);
    root.$isLevel = true;
    root.$pending = true;
    root.$name = '_level' + n;
    root.$levelNumber = n;
    root.$frames = [[]];
    root.$total = 1;
    root.$cur = 1;
    this.levels[n] = root;
    this.track(root);
    return root;
  }

  finishLevel(root, lib) {
    root.$frames = lib.json.root.frames;
    root.$labels = lib.json.root.labels;
    root.$total = lib.json.root.n;
    root.$pending = false;
    root.$cur = 0;
    const playing = root.$playing;
    root.$construct();
    root.$playing = playing && root.$playing;
  }

  // ---- object creation -----------------------------------------------------------------
  create(lib, cid) {
    const ch = lib.char(cid);
    if (!ch) return null;
    switch (ch.t) {
      case 'sprite': return new MovieClip(this, lib, cid);
      case 'shape': return new ShapeObj(this, lib, cid);
      case 'morph': return new MorphObj(this, lib, cid);
      case 'text': return new TextObj(this, lib, cid);
      case 'edittext': return new EditText(this, lib, cid);
      case 'button': return new ButtonObj(this, lib, cid);
      default: return null;              // bitmaps, fonts and sounds are not placed
    }
  }

  // Throwaway instance for hit-testing button hit states without building them.
  hitProbe(lib, cid) {
    const key = lib.movie + ':' + cid;
    if (!this.probes) this.probes = new Map();
    let p = this.probes.get(key);
    if (!p) {
      p = this.create(lib, cid);
      if (p instanceof MovieClip) p.$construct();
      this.probes.set(key, p);
    }
    return p;
  }

  didPlace(child) {
    if (child instanceof MovieClip) {
      this.track(child);
      child.$construct();
      if (child.$events) this.withEvents.add(child);
      this.clipEvent(child, 'initialize');
      this.clipEvent(child, 'construct');
      this.clipEvent(child, 'load');
      child.$loaded = true;
    } else if (child instanceof ButtonObj) {
      child.$construct();
    } else if (child instanceof EditText) {
      this.text.bind(child);
    }
  }

  attach(parent, lib, cid, name, depth, init) {
    const old = parent.$childAt(depth);
    if (old) parent.$remove(old);
    const clip = new MovieClip(this, lib, cid);
    clip.$name = name;
    if (init && typeof init === 'object') {
      for (const k of Object.keys(init)) clip[k] = init[k];
    }
    parent.$insert(clip, depth);
    this.track(clip);
    clip.$construct();
    this.clipEvent(clip, 'load');
    clip.$loaded = true;
    return clip;
  }

  // The execution list (see the top of this file).  A clip joins it when it is made,
  // before its first frame places any children, so they run ahead of it.
  track(clip) {
    this.clips.add(clip);
  }

  forget(clip) {
    this.clips.delete(clip);
    this.withEvents.delete(clip);
    if (this.focus && this.focus.$removed) this.focus = null;
  }

  // ---- scripts ---------------------------------------------------------------------------
  scope(clip) {
    let s = this.scopes.get(clip);
    if (s) return s;
    const player = this;
    s = new Proxy(clip, {
      has(t, k) {
        return typeof k === 'string' && k !== '__as' && k !== 'undefined';
      },
      get(t, k) {
        if (typeof k !== 'string') return undefined;
        if (k in t) return t[k];
        if (k.charCodeAt(0) === 95 && k.startsWith('_level')) {
          const n = Number(k.slice(6));
          if (!Number.isNaN(n)) return player.levels[n];
        }
        if (k === '_global') return player.global;
        if (k in player.global) return player.global[k];
        return player.builtins[k];
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
      deleteProperty(t, k) {
        delete t[k];
        return true;
      },
    });
    this.scopes.set(clip, s);
    return s;
  }

  movieOf(clip) {
    return clip.$lib.movie;
  }

  script(clip, key) {
    // Each movie's translated scripts register themselves when their file loads.
    const all = globalThis.__scripts || {};
    const reg = all[this.movieOf(clip)];
    return reg ? reg[key] : undefined;
  }

  run(key, clip, thisObj) {
    const fn = this.script(clip, key);
    if (!fn) return;
    try {
      fn.call(thisObj || clip, this.scope(clip));
    } catch (e) {
      const n = (this.errors.get(key) || 0) + 1;
      this.errors.set(key, n);
      if (n === 1) this.onError(key, e);
    }
  }

  queueFrameScript(clip, frame, n) {
    const key = clip.$isLevel ? `root:${frame}:${n}` : `s${clip.$cid}:${frame}:${n}`;
    this.queue.push(() => {
      if (!clip.$removed) this.run(key, clip);
    });
  }

  queueMethod(obj, name, ...args) {
    this.queue.push(() => this.callMethod(obj, name, args));
  }

  callMethod(obj, name, args = []) {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    try {
      fn.apply(obj, args);
    } catch (e) {
      const key = (obj.$name || 'object') + '.' + name;
      const n = (this.errors.get(key) || 0) + 1;
      this.errors.set(key, n);
      if (n === 1) this.onError(key, e);
    }
  }

  // onClipEvent(...) handlers from the PlaceObject that put this clip on stage.  They
  // run on the clip, in the clip's scope.
  clipEvent(clip, ev, keyCode) {
    if (!clip.$events) return;
    for (const rec of clip.$events) {
      if (!rec.ev.includes(ev)) continue;
      if (ev === 'keyPress' && rec.key !== keyCode) continue;
      this.queue.push(() => {
        if (clip.$removed && ev !== 'unload') return;
        const fn = this.script(clip.$parent || clip, rec.key_);
        if (!fn) return;
        try {
          fn.call(clip, this.scope(clip));
        } catch (e) {
          const n = (this.errors.get(rec.key_) || 0) + 1;
          this.errors.set(rec.key_, n);
          if (n === 1) this.onError(rec.key_, e);
        }
      });
    }
  }

  runQueue() {
    // Scripts may queue more scripts; keep going until it drains (with a backstop).
    let guard = 0;
    while (this.queue.length && guard++ < 100000) {
      const job = this.queue.shift();
      job();
    }
  }

  // ---- the frame -------------------------------------------------------------------------
  tick() {
    this.frame++;
    // Newest first, over the clips there were when the frame began.  The order decides
    // which script has the last word when two change the same clip in one frame: the
    // game's main loop, _level1's onEnterFrame, runs after the frame scripts of the clips
    // it drives, so a clip it restarts is not halted by a stop() its old frame queued.
    const clips = [...this.clips];
    for (let i = clips.length - 1; i >= 0; i--) this.stepClip(clips[i]);
    this.runQueue();
    this.updateHover();
    // A text field's caret blinks about twice a second (12 frames on, 12 off).
    this.text.caretOn = Math.floor((this.frame - this.text.caretFrom) / 12) % 2 === 0;
  }

  stepClip(clip) {
    // Not clips that have gone, levels still downloading, or the insides of hitProbe()'s
    // throwaway instances, which are never on stage.
    if (clip.$removed || clip.$pending || !clip.$isOnStage()) return;
    if (clip.$loaded || clip.$isLevel) {
      this.clipEvent(clip, 'enterFrame');
      if (typeof clip.onEnterFrame === 'function') {
        this.queue.push(() => {
          if (!clip.$removed) this.callMethod(clip, 'onEnterFrame');
        });
      }
    }
    clip.$advance();
  }

  draw() {
    const bg = this.levels[0] ? this.levels[0].$lib.json.background : [0, 0, 0, 255];
    this.renderer.render(this.levels, bg);
  }

  // ---- lookup helpers ----------------------------------------------------------------------
  resolveTarget(from, path) {
    if (!path) return from;
    let obj = path[0] === '/' ? from.$level() : from;
    for (const part of path.split(/[/.]/)) {
      if (!part) continue;
      if (part === '..' || part === '_parent') obj = obj && obj.$parent;
      else if (part === '_root') obj = obj && obj.$level();
      else if (/^_level\d+$/.test(part)) obj = this.levels[+part.slice(6)];
      else obj = obj && obj[part];
      if (!obj) return null;
    }
    return obj;
  }

  // Every clip currently on stage, in display order (for broadcasts).
  *allClips() {
    const walk = function* (o) {
      yield o;
      for (const c of o.$children) if (c instanceof MovieClip) yield* walk(c);
    };
    for (const level of this.levels) if (level && !level.$pending) yield* walk(level);
  }

  *allButtons() {
    const walk = function* (o) {
      for (const c of o.$children) {
        if (c instanceof ButtonObj) yield c;
        else if (c instanceof MovieClip) yield* walk(c);
      }
    };
    for (const level of this.levels) if (level && !level.$pending) yield* walk(level);
  }

  // ---- mouse -------------------------------------------------------------------------------
  pointerMove(x, y) {
    this.mouse = [x, y];
    this.broadcastMouse('onMouseMove', 'mouseMove');
    this.updateHover();
  }

  // Flash Player on Windows reported mouse buttons to Key.isDown as virtual-key codes:
  // 1 left, 2 right, 4 middle.  Only the left button did anything else.
  mouseButton(domButton, down) {
    const code = { 0: 1, 1: 4, 2: 2 }[domButton];
    if (code === undefined) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  pointerDown(x, y) {
    this.mouse = [x, y];
    this.sound.unlock();
    this.mouseDown = true;
    this.keys.add(1);
    this.updateHover();
    if (this.hover) {
      this.pressed = this.hover;
      this.buttonEvent(this.hover, 'press', 'down', 'overUpToOverDown');
    }
    // Focus follows the click for input text fields.
    const field = this.inputFieldAt(x, y);
    if (this.focus && this.focus !== field) this.focus.$focus = false;
    this.focus = field;
    if (field) field.$focus = true;
    this.broadcastMouse('onMouseDown', 'mouseDown');
  }

  pointerUp(x, y) {
    this.mouse = [x, y];
    this.mouseDown = false;
    this.keys.delete(1);
    this.updateHover();
    const p = this.pressed;
    this.pressed = null;
    if (p) {
      if (p === this.hover) this.buttonEvent(p, 'release', 'over', 'overDownToOverUp');
      else this.buttonEvent(p, 'releaseOutside', 'up', null);
    }
    this.broadcastMouse('onMouseUp', 'mouseUp');
  }

  wheel(delta) {
    for (const l of this.mouseListeners.slice()) this.queueMethod(l, 'onMouseWheel', delta);
  }

  broadcastMouse(method, clipEvent) {
    for (const c of [...this.allClips()]) {
      this.clipEvent(c, clipEvent);
      if (typeof c[method] === 'function') this.queueMethod(c, method);
    }
    for (const l of this.mouseListeners.slice()) this.queueMethod(l, method);
  }

  inputFieldAt(x, y) {
    const walk = (o) => {
      for (let i = o.$children.length - 1; i >= 0; i--) {
        const c = o.$children[i];
        if (!c.$visible) continue;
        if (c instanceof EditText && !c.$char.readOnly && c.hitTest(x, y, false)) return c;
        if (c instanceof MovieClip) {
          const r = walk(c);
          if (r) return r;
        }
      }
      return null;
    };
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const l = this.levels[i];
      if (!l || l.$pending || !l.$visible) continue;
      const r = walk(l);
      if (r) return r;
    }
    return null;
  }

  buttonAt(x, y) {
    // Topmost enabled, visible button whose hit area contains the point.
    const visibleChain = (o) => {
      for (; o; o = o.$parent) if (!o.$visible || o.$removed) return false;
      return true;
    };
    let best = null;
    for (const b of this.allButtons()) {
      if (!b.$enabled || !visibleChain(b)) continue;
      const [lx, ly] = apply(invert(b.$worldMatrix()), x, y);
      if (b.$hitArea(lx, ly)) best = b;       // later in display order = on top
    }
    return best;
  }

  updateHover() {
    const [x, y] = this.mouse;
    const b = this.buttonAt(x, y);
    if (b === this.hover) return;
    const old = this.hover;
    this.hover = b;
    if (old && !old.$removed) {
      if (this.mouseDown && this.pressed === old) this.buttonEvent(old, 'dragOut', 'over', null);
      else this.buttonEvent(old, 'rollOut', 'up', 'overUpToIdle');
    }
    if (b) {
      if (this.mouseDown && this.pressed === b) this.buttonEvent(b, 'dragOver', 'down', null);
      else if (!this.mouseDown) this.buttonEvent(b, 'rollOver', 'over', 'idleToOverUp');
    }
    this.updateCursor();
  }

  buttonEvent(button, ev, state, soundSlot) {
    if (state && button.$state !== state) button.$setState(state);
    const ch = button.$char;
    if (soundSlot && ch.snd && ch.snd[soundSlot]) {
      const s = ch.snd[soundSlot];
      this.sound.start(button.$lib, s.id, button.$parent, s.info || {});
    }
    ch.acts.forEach((a, i) => {
      if (a.ev.includes(ev)) this.queueButtonAction(button, i);
    });
    this.runQueue();
  }

  queueButtonAction(button, i) {
    const tl = button.$parent;
    const key = `b${button.$cid}:${i}`;
    this.queue.push(() => {
      if (tl && !tl.$removed) this.run(key, tl);
    });
  }

  updateCursor() {
    let c = 'default';
    if (this.mouseHidden) c = 'none';
    else if (this.hover && this.hover.$handCursor) c = 'pointer';
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  // ---- keyboard --------------------------------------------------------------------------
  keyDown(ev) {
    this.sound.unlock();
    const code = ev.keyCode;
    const repeat = this.keys.has(code);
    this.keys.add(code);
    this.lastKey = code;
    this.lastAscii = ev.key.length === 1 ? ev.key.charCodeAt(0) : (code === 13 ? 13 : code === 8 ? 8 : 0);
    if (this.focus && !this.focus.$removed) this.text.keyInput(this.focus, ev);
    for (const l of this.keyListeners.slice()) this.queueMethod(l, 'onKeyDown');
    for (const c of [...this.allClips()]) {
      this.clipEvent(c, 'keyDown');
      if (typeof c.onKeyDown === 'function' && c === this.focus) this.queueMethod(c, 'onKeyDown');
    }
    // Button key conditions fire on the press, not the repeat.
    if (!repeat) {
      const bk = BUTTON_KEYS[ev.key] !== undefined ? BUTTON_KEYS[ev.key]
        : (ev.key.length === 1 ? ev.key.charCodeAt(0) : null);
      if (bk !== null) {
        for (const b of [...this.allButtons()]) {
          if (!b.$enabled) continue;
          b.$char.acts.forEach((a, i) => {
            if (a.k === bk) this.queueButtonAction(b, i);
          });
        }
        for (const c of [...this.allClips()]) this.clipEvent(c, 'keyPress', bk);
      }
    }
    this.runQueue();
  }

  keyUp(ev) {
    this.keys.delete(ev.keyCode);
    this.lastKey = ev.keyCode;
    for (const l of this.keyListeners.slice()) this.queueMethod(l, 'onKeyUp');
    for (const c of [...this.allClips()]) this.clipEvent(c, 'keyUp');
    this.runQueue();
  }

  // ---- hit testing the drawing API ---------------------------------------------------------
  hitGraphics(clip, x, y) {
    const g = clip.$gfx;
    if (!g) return false;
    const p = new Path2D();
    let open = false;
    for (const op of g.ops) {
      if (op[0] === 'bf' || op[0] === 'bb') open = true;
      else if (op[0] === 'ef') open = false;
      else if (op[0] === 'm') p.moveTo(op[1], op[2]);
      else if (op[0] === 'l') p.lineTo(op[1], op[2]);
      else if (op[0] === 'q') p.quadraticCurveTo(op[1], op[2], op[3], op[4]);
    }
    return this.hitContext.isPointInPath(p, x, y, 'evenodd');
  }
}

export { DEPTH_OFFSET };
