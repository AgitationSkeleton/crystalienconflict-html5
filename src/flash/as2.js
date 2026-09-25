// ActionScript 2's built-in functions and classes -- the ones this game calls, behaving
// the way Flash Player 8 behaved -- plus __as, the helpers the translated code uses where
// JavaScript and ActionScript disagree.

import { asString, stringToNumber, parseFloatAS2 } from './text.js';

// ---- __as: where the two languages differ --------------------------------------------------

// for..in in AVM1 runs newest-first: arrays from the highest index down, objects in
// reverse order of property creation.  Internal ($-prefixed) fields are never listed.
function keys(obj) {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object' && typeof obj !== 'function') return [];
  const own = Object.keys(obj).filter((k) => k.charCodeAt(0) !== 36);   // '$'
  if (Array.isArray(obj)) {
    const idx = [], named = [];
    for (const k of own) (/^(0|[1-9]\d*)$/.test(k) ? idx : named).push(k);
    idx.sort((a, b) => b - a);
    return named.reverse().concat(idx);
  }
  return own.reverse();
}

function set(obj, key, value) {
  if (obj !== null && obj !== undefined && (typeof obj === 'object' || typeof obj === 'function')) {
    obj[key] = value;
  }
  return value;
}

function upd(obj, key, delta, prefix) {
  if (obj === null || obj === undefined || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return prefix ? NaN : undefined;
  }
  const old = obj[key];
  const n = Number(old);
  obj[key] = n + delta;
  return prefix ? n + delta : n;
}

function op(obj, key, operator, value) {
  const cur = obj === null || obj === undefined ? undefined : obj[key];
  let r;
  switch (operator) {
    case '+': r = cur + value; break;
    case '-': r = cur - value; break;
    case '*': r = cur * value; break;
    case '/': r = cur / value; break;
    case '%': r = cur % value; break;
    case '<<': r = cur << value; break;
    case '>>': r = cur >> value; break;
    case '>>>': r = cur >>> value; break;
    case '&': r = cur & value; break;
    case '|': r = cur | value; break;
    case '^': r = cur ^ value; break;
    default: throw new Error('operator ' + operator);
  }
  return set(obj, key, r);
}

// ActionScript 2's ToNumber (SWF 7 and later): undefined and null are NaN, and strings are
// parsed by Flash's rules rather than JavaScript's (see text.js, stringToNumber).
export function toNumber(v) {
  switch (typeof v) {
    case 'number': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': return stringToNumber(v);
    case 'object':
    case 'function': {
      if (v === null) return NaN;
      const p = typeof v.valueOf === 'function' ? v.valueOf() : v;
      return p !== v && (typeof p !== 'object' || p === null) ? toNumber(p) : NaN;
    }
    default: return NaN;
  }
}

// ---- installation ------------------------------------------------------------------------

export function installBuiltins(player) {
  globalThis.__as = { keys, set, upd, op };
  installArrayExtras();

  const B = player.builtins;
  const clipOf = (t) => (t && t.$player ? t : null);

  // The standard classes and functions ActionScript shares with JavaScript.  Scripts see
  // them through the scope chain like any other global, so they have to be listed here.
  // Math is JavaScript's, except that Math.random and random() share one generator, which
  // a test can seed (player.seedRandom) to make a run repeatable.
  const AS2Math = Object.create(Math);
  AS2Math.random = () => player.random();
  Object.assign(B, {
    Math: AS2Math, Array, Object, Boolean, Date, Function, Error, parseInt, NaN, Infinity,
  });
  // String(): ActionScript prints numbers with 15 significant digits, not JavaScript's 17.
  function AS2String(v) {
    const s = arguments.length ? (typeof v === 'number' ? asString(v) : String(v)) : '';
    return new.target ? new String(s) : s;
  }
  AS2String.fromCharCode = String.fromCharCode;
  AS2String.prototype = String.prototype;
  B.String = AS2String;
  // Number() and friends convert strings ActionScript's way (see toNumber).
  function AS2Number(v) {
    const n = arguments.length ? toNumber(v) : 0;
    return new.target ? new Number(n) : n;
  }
  for (const k of ['MAX_VALUE', 'MIN_VALUE', 'NaN', 'NEGATIVE_INFINITY', 'POSITIVE_INFINITY']) AS2Number[k] = Number[k];
  AS2Number.prototype = Number.prototype;
  B.Number = AS2Number;
  B.isNaN = (v) => Number.isNaN(toNumber(v));
  B.isFinite = (v) => Number.isFinite(toNumber(v));
  B.parseFloat = (v) => parseFloatAS2(v === undefined ? 'undefined' : asString(v), false);

  B.random = (n) => {
    n = Math.trunc(+n);
    return n > 0 ? Math.floor(player.random() * n) : 0;
  };
  B.int = (v) => Math.trunc(+v) | 0;
  B.getTimer = () => Math.floor(performance.now() - player.startTime);
  B.getVersion = () => 'WIN 8,0,24,0';
  B.trace = (...a) => console.log('[trace]', ...a.map(asString));
  B.escape = escape;
  B.unescape = unescape;
  B.stopAllSounds = () => player.sound.stopAll();
  B.fscommand = (cmd, arg) => {
    cmd = String(cmd).toLowerCase();
    if (cmd === 'fullscreen') player.setFullscreen(String(arg) === 'true');
    // allowscale / showmenu / trapallkeys / quit: nothing to do in a page.
  };
  B.getURL = (url, win) => {
    url = String(url);
    if (/^javascript:/i.test(url) || /^fscommand:/i.test(url)) return;
    window.open(url, win ? String(win) : '_self', 'noopener');
  };
  B.loadMovieNum = (url, level) => player.loadMovieNum(String(url), Math.trunc(+level));
  // The game's own loadMovie is an old tracking loader pointing at a server that no
  // longer exists; in the original offline edition it failed silently.  So does this.
  B.loadMovie = () => {};
  B.unloadMovieNum = (level) => {
    const l = player.levels[level];
    if (l) {
      l.$markRemoved();
      player.levels[level] = undefined;
    }
  };
  B.setInterval = (a, b, ...rest) => {
    if (typeof a === 'function') return setInterval(() => { a(...rest); player.runQueue(); }, +b);
    const obj = a, name = String(b), ms = +rest[0], args = rest.slice(1);
    return setInterval(() => { player.callMethod(obj, name, args); player.runQueue(); }, ms);
  };
  B.clearInterval = (id) => clearInterval(id);
  B.setTimeout = (fn, ms, ...args) => setTimeout(() => { fn(...args); player.runQueue(); }, +ms);
  B.clearTimeout = (id) => clearTimeout(id);
  B.ASSetPropFlags = () => {};

  // ---- Key -----------------------------------------------------------------------------
  B.Key = {
    BACKSPACE: 8, CAPSLOCK: 20, CONTROL: 17, DELETEKEY: 46, DOWN: 40, END: 35, ENTER: 13,
    ESCAPE: 27, HOME: 36, INSERT: 45, LEFT: 37, PGDN: 34, PGUP: 33, RIGHT: 39, SHIFT: 16,
    SPACE: 32, TAB: 9, UP: 38,
    isDown: (code) => player.keys.has(+code),
    isToggled: () => false,
    getCode: () => player.lastKey,
    getAscii: () => player.lastAscii,
    addListener: (o) => { if (!player.keyListeners.includes(o)) player.keyListeners.push(o); },
    removeListener: (o) => {
      const i = player.keyListeners.indexOf(o);
      if (i >= 0) player.keyListeners.splice(i, 1);
      return i >= 0;
    },
  };

  // ASnative(800, 2) is Key.isDown itself, fetched from the player's native table.  The
  // game asks it about key code 4, the middle mouse button (see Player.mouseButton).
  B.ASnative = (a, b) => (+a === 800 && +b === 2 ? B.Key.isDown : undefined);

  // ---- Mouse -----------------------------------------------------------------------------
  B.Mouse = {
    hide: () => { player.mouseHidden = true; player.updateCursor(); return 1; },
    show: () => { player.mouseHidden = false; player.updateCursor(); return 0; },
    addListener: (o) => { if (!player.mouseListeners.includes(o)) player.mouseListeners.push(o); },
    removeListener: (o) => {
      const i = player.mouseListeners.indexOf(o);
      if (i >= 0) player.mouseListeners.splice(i, 1);
      return i >= 0;
    },
  };

  // ---- Stage / System / Selection ----------------------------------------------------------
  const stage = { scaleMode: 'showAll', align: '', showMenu: true, listeners: [] };
  Object.defineProperties(stage, {
    width: { get: () => 600 },
    height: { get: () => 400 },
    displayState: {
      get: () => (document.fullscreenElement ? 'fullScreen' : 'normal'),
      set: (v) => player.setFullscreen(String(v) === 'fullScreen'),
    },
  });
  stage.addListener = (o) => stage.listeners.push(o);
  stage.removeListener = (o) => {
    const i = stage.listeners.indexOf(o);
    if (i >= 0) stage.listeners.splice(i, 1);
  };
  B.Stage = stage;
  B.System = {
    security: { allowDomain: () => {}, allowInsecureDomain: () => {}, loadPolicyFile: () => {} },
    capabilities: { version: 'WIN 8,0,24,0', os: 'Windows XP', playerType: 'PlugIn', language: 'en',
      screenResolutionX: screen.width, screenResolutionY: screen.height, hasAudio: true },
    useCodepage: false,
  };
  B.Selection = {
    setFocus: (target) => {
      let f = typeof target === 'string' ? null : target;
      if (typeof target === 'string') {
        for (const c of player.allClips()) {
          for (const ch of c.$children) if (ch.$name === target || ch.$variable === target) f = ch;
        }
      }
      if (player.focus) player.focus.$focus = false;
      player.focus = f && f.$char && f.$char.t === 'edittext' ? f : null;
      if (player.focus) player.focus.$focus = true;
      return !!player.focus;
    },
    getFocus: () => (player.focus && !player.focus.$removed ? String(player.focus) : null),
    setSelection: () => {},
    getBeginIndex: () => -1,
    getEndIndex: () => -1,
    getCaretIndex: () => -1,
  };

  // ---- SharedObject ------------------------------------------------------------------------
  // The game saves its progress to a Local Shared Object; here that is localStorage.
  const sos = new Map();
  B.SharedObject = {
    getLocal(name) {
      name = String(name);
      if (sos.has(name)) return sos.get(name);
      const key = 'cac.so.' + name;
      let data = {};
      try {
        const raw = localStorage.getItem(key);
        if (raw) data = JSON.parse(raw);
      } catch (e) { /* storage unavailable or corrupt: start empty, as a new SO would */ }
      let saved = JSON.stringify(data);
      const so = {
        data,
        flush() {
          try {
            const now = JSON.stringify(so.data);
            if (now !== saved) localStorage.setItem(key, now);
            saved = now;
            return true;
          } catch (e) { return false; }
        },
        clear() {
          for (const k of Object.keys(so.data)) delete so.data[k];
          try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
        },
        getSize() { return JSON.stringify(so.data).length; },
      };
      sos.set(name, so);
      return so;
    },
  };
  // Flash wrote shared objects when the player closed, and the game never calls flush()
  // itself.  A browser tab can be closed or killed without warning, so progress is also
  // written whenever the page is hidden, and every few seconds if it has changed.
  const flushAll = () => { for (const so of sos.values()) so.flush(); };
  addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  setInterval(flushAll, 5000);

  // ---- XML ------------------------------------------------------------------------------------
  B.XML = makeXML(player);
  B.XMLNode = B.XML.$Node;

  // ---- Sound / Color -------------------------------------------------------------------------
  B.Sound = makeSound(player);
  B.Color = makeColor(player, clipOf);

  // ---- ContextMenu (the right-click menu) ------------------------------------------------------
  B.ContextMenu = function ContextMenu(cb) {
    this.customItems = [];
    this.builtInItems = {};
    this.onSelect = cb;
    this.hideBuiltInItems = function () { this.$hidden = true; };
  };
  B.ContextMenuItem = function ContextMenuItem(caption, cb, sep, enabled, visible) {
    this.caption = caption;
    this.onSelect = cb;
    this.separatorBefore = !!sep;
    this.enabled = enabled !== false;
    this.visible = visible !== false;
  };

  // ---- networking this game can no longer do ---------------------------------------------------
  // High scores went to LEGO's servers and a tracker loaded from elsewhere; both are gone.
  B.LoadVars = function LoadVars() {
    this.send = () => false;
    this.load = () => false;
    this.sendAndLoad = () => false;
    this.toString = () => '';
  };
  B.MovieClipLoader = function MovieClipLoader() {
    this.addListener = () => true;
    this.removeListener = () => true;
    this.loadClip = () => false;
    this.unloadClip = () => false;
  };

  // ---- flash.* ---------------------------------------------------------------------------------
  B.flash = makeFlashPackage(player);
}

function installArrayExtras() {
  const def = (obj, name, value) => Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false });
  def(Array, 'CASEINSENSITIVE', 1);
  def(Array, 'DESCENDING', 2);
  def(Array, 'UNIQUESORT', 4);
  def(Array, 'RETURNINDEXEDARRAY', 8);
  def(Array, 'NUMERIC', 16);
  def(Array.prototype, 'sortOn', function (field, options) {
    return sortOn(this, field, options);
  });
}

// ---- Array sorting, as Flash Player did it ----------------------------------------------
// Flash's sort is a quicksort that is not stable, and the order it leaves equal elements
// in matters: the pathfinder sorts its open list with sortOn("f", Array.NUMERIC), and
// ties (and NaNs, which compare equal) decide which way units go.  This follows Ruffle's
// reproduction of it (core/src/avm1/globals/array.rs), case by case.

const CASEINSENSITIVE = 1, DESCENDING = 2, UNIQUESORT = 4, RETURNINDEXEDARRAY = 8, NUMERIC = 16;

function compareValues(a, b, options) {
  let r;
  if (typeof a === 'number' && typeof b === 'number' && (options & NUMERIC)) {
    r = a < b ? -1 : a > b ? 1 : 0;              // NaN compares equal to everything
  } else {
    let x = asStringValue(a), y = asStringValue(b);
    if (options & CASEINSENSITIVE) { x = x.toLowerCase(); y = y.toLowerCase(); }
    r = x < y ? -1 : x > y ? 1 : 0;              // UTF-16 code units, as Flash compared
  }
  return (options & DESCENDING) ? -r : r;
}

// ActionScript's string conversion for sorting: undefined is "undefined" here, not "".
function asStringValue(v) {
  return v === undefined ? 'undefined' : asString(v);
}

function flashQuicksort(items, cmp) {
  // items: [originalIndex, value] pairs, sorted in place.
  if (items.length < 2) return;
  const stack = [[0, items.length - 1]];
  while (stack.length) {
    const [low, high] = stack.pop();
    if (low >= high) continue;
    const pivot = items[low][1];                 // always the leftmost element
    let left = low + 1;
    let right = high;
    for (;;) {
      while (left < right && cmp(pivot, items[left][1]) > 0) left++;
      while (right > low && cmp(pivot, items[right][1]) <= 0) right--;
      if (left >= right) break;
      const t = items[left]; items[left] = items[right]; items[right] = t;
    }
    const t = items[low]; items[low] = items[right]; items[right] = t;
    stack.push([right + 1, high]);
    if (right > 0) stack.push([low, right - 1]);
  }
}

function sortOn(arr, field, options) {
  let fields;
  if (Array.isArray(field)) {
    if (!field.length) return arr;
    fields = field.map((f) => [asStringValue(f), 0]);
    if (Array.isArray(options) && options.length === field.length) {
      options.forEach((o, i) => { fields[i][1] = Math.trunc(+o) | 0; });
    } else if (options !== undefined && (typeof options !== 'object' || options === null)) {
      const o = Math.trunc(+options) | 0;
      fields.forEach((f) => { f[1] = o; });
    }
  } else if (field === undefined) {
    return undefined;
  } else {
    fields = [[asStringValue(field), typeof options === 'number' ? Math.trunc(options) | 0 : 0]];
  }
  const main = fields[0][1];
  const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const cmp = (a, b) => {
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const [f, o] of fields) {
        const r = compareValues(own(a, f), own(b, f), o);
        if (r) return r;
      }
      return 0;
    }
    return compareValues(a, b, main);
  };
  const items = arr.map((v, i) => [i, v]);
  flashQuicksort(items, cmp);
  if (main & UNIQUESORT) {
    for (let i = 1; i < items.length; i++) if (cmp(items[i - 1][1], items[i][1]) === 0) return 0;
  }
  if (main & RETURNINDEXEDARRAY) return items.map((p) => p[0]);
  items.forEach((p, i) => { arr[i] = p[1]; });
  return arr;
}

// ---- XML ----------------------------------------------------------------------------------------

function makeXML(player) {
  class XMLNode {
    constructor(type, value) {
      this.nodeType = type;
      this.nodeName = type === 1 ? value : null;
      this.nodeValue = type === 3 ? value : null;
      this.attributes = {};
      this.childNodes = [];
      this.parentNode = null;
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() {
      const p = this.parentNode;
      if (!p) return null;
      return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
    }
    get previousSibling() {
      const p = this.parentNode;
      if (!p) return null;
      return p.childNodes[p.childNodes.indexOf(this) - 1] || null;
    }
    appendChild(n) { n.parentNode = this; this.childNodes.push(n); }
    hasChildNodes() { return this.childNodes.length > 0; }
    toString() {
      if (this.nodeType === 3) return escapeXML(this.nodeValue);
      const attrs = Object.keys(this.attributes).map((k) => ` ${k}="${escapeXML(String(this.attributes[k]))}"`).join('');
      const inner = this.childNodes.map(String).join('');
      if (!this.nodeName) return inner;
      return inner ? `<${this.nodeName}${attrs}>${inner}</${this.nodeName}>` : `<${this.nodeName}${attrs} />`;
    }
  }

  class XML extends XMLNode {
    constructor(src) {
      super(1, null);
      this.ignoreWhite = false;
      this.loaded = false;
      this.status = 0;
      if (src !== undefined) this.parseXML(String(src));
    }
    parseXML(src) {
      this.childNodes = [];
      const doc = new DOMParser().parseFromString(src, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        this.status = -1;
        return;
      }
      const convert = (dn, parent) => {
        for (const c of dn.childNodes) {
          if (c.nodeType === 1) {
            const n = new XMLNode(1, c.nodeName);
            for (const a of c.attributes) n.attributes[a.name] = a.value;
            parent.appendChild(n);
            convert(c, n);
          } else if (c.nodeType === 3 || c.nodeType === 4) {
            if (this.ignoreWhite && !/\S/.test(c.nodeValue)) continue;
            parent.appendChild(new XMLNode(3, c.nodeValue));
          }
        }
      };
      convert(doc, this);
      this.status = 0;
    }
    load(url) {
      this.loaded = false;
      fetch(String(url)).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.arrayBuffer();
      }).then((buf) => {
        this.parseXML(decodeText(buf));
        this.loaded = true;
        player.queueMethod(this, 'onLoad', true);
        player.runQueue();
      }).catch(() => {
        player.queueMethod(this, 'onLoad', false);
        player.runQueue();
      });
      return true;
    }
    createElement(name) { return new XMLNode(1, name); }
    createTextNode(v) { return new XMLNode(3, v); }
  }
  XML.$Node = XMLNode;
  return XML;
}

function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  return new TextDecoder('utf-8').decode(b);
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Sound ----------------------------------------------------------------------------------------

function makeSound(player) {
  // A Sound object is a volume control for a clip (or, with no clip, for everything).
  return function Sound(target) {
    const owner = target && target.$player ? target : null;
    const holder = owner || player;
    this.setVolume = (v) => {
      holder.$soundVolume = +v;
      player.sound.refreshVolumes();
    };
    this.getVolume = () => (holder.$soundVolume === undefined ? 100 : holder.$soundVolume);
    this.setPan = (p) => { holder.$soundPan = +p; };
    this.getPan = () => holder.$soundPan || 0;
    this.attachSound = (name) => {
      const lib = (owner || player.levels[0]).$lib;
      this.$id = lib.exportId(String(name));
      this.$lib = lib;
    };
    this.start = (offset, loops) => {
      if (this.$id === undefined || this.$id === null) return;
      const e = player.sound.start(this.$lib, this.$id, owner || player.levels[0], { loops: +loops || 1 });
      if (e) e.onComplete = () => { player.queueMethod(this, 'onSoundComplete'); };
    };
    this.stop = () => player.sound.stopOwnedBy(owner || player.levels[0], this.$id);
    Object.defineProperty(this, 'position', { get: () => 0 });
    Object.defineProperty(this, 'duration', { get: () => 0 });
  };
}

// ---- Color -----------------------------------------------------------------------------------------

function makeColor(player, clipOf) {
  return function Color(target) {
    const clip = clipOf(target);
    this.setRGB = (rgb) => {
      if (!clip) return;
      rgb = (+rgb) >>> 0;
      const a = clip.$cx ? clip.$cx : [256, 256, 256, 256, 0, 0, 0, 0];
      clip.$cx = [0, 0, 0, a[3], (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, a[7]];
      clip.$scripted = true;
    };
    this.getRGB = () => {
      if (!clip || !clip.$cx) return 0;
      return (clip.$cx[4] << 16) | (clip.$cx[5] << 8) | clip.$cx[6];
    };
    // Multipliers arrive as percentages, offsets as 0..255; strings are numbers here.
    this.setTransform = (t) => {
      if (!clip || !t) return;
      const c = clip.$cx ? clip.$cx.slice() : [256, 256, 256, 256, 0, 0, 0, 0];
      const pct = (v, i) => { if (v !== undefined) c[i] = Math.trunc(Number(v) * 256 / 100); };
      const off = (v, i) => { if (v !== undefined) c[i] = Math.trunc(Number(v)); };
      pct(t.ra, 0); pct(t.ga, 1); pct(t.ba, 2); pct(t.aa, 3);
      off(t.rb, 4); off(t.gb, 5); off(t.bb, 6); off(t.ab, 7);
      clip.$cx = c;
      clip.$scripted = true;
    };
    this.getTransform = () => {
      const c = clip && clip.$cx ? clip.$cx : [256, 256, 256, 256, 0, 0, 0, 0];
      return { ra: c[0] * 100 / 256, ga: c[1] * 100 / 256, ba: c[2] * 100 / 256, aa: c[3] * 100 / 256,
        rb: c[4], gb: c[5], bb: c[6], ab: c[7] };
    };
  };
}

// ---- flash.geom / flash.filters / flash.display ------------------------------------------------------

let bmdIds = 1;

function makeFlashPackage(player) {
  function Matrix(a, b, c, d, tx, ty) {
    this.a = a === undefined ? 1 : +a;
    this.b = b === undefined ? 0 : +b;
    this.c = c === undefined ? 0 : +c;
    this.d = d === undefined ? 1 : +d;
    this.tx = tx === undefined ? 0 : +tx;
    this.ty = ty === undefined ? 0 : +ty;
  }
  Matrix.prototype.identity = function () { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.tx = 0; this.ty = 0; };
  Matrix.prototype.translate = function (x, y) { this.tx += +x; this.ty += +y; };
  Matrix.prototype.scale = function (sx, sy) {
    this.a *= sx; this.b *= sy; this.c *= sx; this.d *= sy; this.tx *= sx; this.ty *= sy;
  };
  Matrix.prototype.rotate = function (q) {
    const cos = Math.cos(q), sin = Math.sin(q);
    const { a, b, c, d, tx, ty } = this;
    this.a = a * cos - b * sin; this.b = a * sin + b * cos;
    this.c = c * cos - d * sin; this.d = c * sin + d * cos;
    this.tx = tx * cos - ty * sin; this.ty = tx * sin + ty * cos;
  };
  Matrix.prototype.concat = function (m) {
    const { a, b, c, d, tx, ty } = this;
    this.a = a * m.a + b * m.c; this.b = a * m.b + b * m.d;
    this.c = c * m.a + d * m.c; this.d = c * m.b + d * m.d;
    this.tx = tx * m.a + ty * m.c + m.tx; this.ty = tx * m.b + ty * m.d + m.ty;
  };
  Matrix.prototype.clone = function () { return new Matrix(this.a, this.b, this.c, this.d, this.tx, this.ty); };
  Matrix.prototype.createBox = function (sx, sy, rot, tx, ty) {
    this.identity(); this.rotate(rot || 0); this.scale(sx, sy); this.translate(tx || 0, ty || 0);
  };

  function Rectangle(x, y, w, h) {
    this.x = +x || 0; this.y = +y || 0; this.width = +w || 0; this.height = +h || 0;
  }
  Rectangle.prototype.clone = function () { return new Rectangle(this.x, this.y, this.width, this.height); };

  function Point(x, y) { this.x = +x || 0; this.y = +y || 0; }

  function ColorTransform(rm, gm, bm, am, ro, go, bo, ao) {
    this.redMultiplier = rm === undefined ? 1 : +rm; this.greenMultiplier = gm === undefined ? 1 : +gm;
    this.blueMultiplier = bm === undefined ? 1 : +bm; this.alphaMultiplier = am === undefined ? 1 : +am;
    this.redOffset = +ro || 0; this.greenOffset = +go || 0; this.blueOffset = +bo || 0; this.alphaOffset = +ao || 0;
  }

  // Filters: AS2 objects that turn into the renderer's filter description.  Alphas are
  // 0..1 here and 0..255 in the SWF; blur quality is the number of passes.  Out-of-range
  // values are clamped the way Flash clamps them (the game animates a blur through
  // negative values, and passes alpha 100 meaning "opaque").
  const clamp = (v, lo, hi) => (Number.isNaN(+v) ? lo : Math.max(lo, Math.min(hi, +v)));
  const rgba = (color, alpha) => {
    color = (+color) >>> 0;
    const a = alpha === undefined ? 1 : clamp(alpha, 0, 1);
    return [(color >> 16) & 255, (color >> 8) & 255, color & 255, Math.round(a * 255)];
  };
  const blurOf = (v) => clamp(v, 0, 255);
  const passesOf = (q) => Math.trunc(clamp(q, 0, 15));
  function BlurFilter(bx, by, q) {
    this.blurX = bx === undefined ? 4 : +bx; this.blurY = by === undefined ? 4 : +by; this.quality = q === undefined ? 1 : +q;
  }
  BlurFilter.prototype.$toRender = function () {
    return { type: 'blur', blurX: blurOf(this.blurX), blurY: blurOf(this.blurY), passes: passesOf(this.quality) };
  };
  BlurFilter.prototype.clone = function () { return new BlurFilter(this.blurX, this.blurY, this.quality); };

  function GlowFilter(color, alpha, bx, by, strength, quality, inner, knockout) {
    this.color = color === undefined ? 0xff0000 : +color; this.alpha = alpha === undefined ? 1 : +alpha;
    this.blurX = bx === undefined ? 6 : +bx; this.blurY = by === undefined ? 6 : +by;
    this.strength = strength === undefined ? 2 : +strength; this.quality = quality === undefined ? 1 : +quality;
    this.inner = !!inner; this.knockout = !!knockout;
  }
  GlowFilter.prototype.$toRender = function () {
    return { type: 'glow', color: rgba(this.color, this.alpha), blurX: blurOf(this.blurX), blurY: blurOf(this.blurY),
      strength: clamp(this.strength, 0, 255), inner: this.inner ? 1 : 0, knockout: this.knockout ? 1 : 0,
      passes: passesOf(this.quality) };
  };
  GlowFilter.prototype.clone = function () {
    return new GlowFilter(this.color, this.alpha, this.blurX, this.blurY, this.strength, this.quality, this.inner, this.knockout);
  };

  function DropShadowFilter(distance, angle, color, alpha, bx, by, strength, quality, inner, knockout) {
    this.distance = distance === undefined ? 4 : +distance; this.angle = angle === undefined ? 45 : +angle;
    this.color = +color || 0; this.alpha = alpha === undefined ? 1 : +alpha;
    this.blurX = bx === undefined ? 4 : +bx; this.blurY = by === undefined ? 4 : +by;
    this.strength = strength === undefined ? 1 : +strength; this.quality = quality === undefined ? 1 : +quality;
    this.inner = !!inner; this.knockout = !!knockout;
  }
  DropShadowFilter.prototype.$toRender = function () {
    return { type: 'dropShadow', color: rgba(this.color, this.alpha), blurX: blurOf(this.blurX), blurY: blurOf(this.blurY),
      angle: this.angle * Math.PI / 180, distance: +this.distance || 0, strength: clamp(this.strength, 0, 255),
      inner: this.inner ? 1 : 0, knockout: this.knockout ? 1 : 0, passes: passesOf(this.quality) };
  };

  function ColorMatrixFilter(matrix) {
    this.matrix = Array.isArray(matrix) ? matrix.slice() : [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  }
  ColorMatrixFilter.prototype.$toRender = function () { return { type: 'colorMatrix', matrix: this.matrix.map(Number) }; };
  ColorMatrixFilter.prototype.clone = function () { return new ColorMatrixFilter(this.matrix); };

  // BitmapData: an offscreen canvas.  The game uses it for the minimap -- a picture of the
  // terrain drawn once, and a shroud layer punched through as the map is explored -- and
  // for the tiled wind/snow layer.
  function BitmapData(w, h, transparent, fill) {
    w = Math.max(1, Math.trunc(+w) || 1);
    h = Math.max(1, Math.trunc(+h) || 1);
    this.$canvas = document.createElement('canvas');
    this.$canvas.width = w;
    this.$canvas.height = h;
    this.$ctx = this.$canvas.getContext('2d');
    this.$id = bmdIds++;
    this.$version = 0;
    this.transparent = transparent !== false;
    const f = fill === undefined ? 0xffffffff : (+fill) >>> 0;
    this.fillRect(new Rectangle(0, 0, w, h), this.transparent ? f : (f | 0xff000000) >>> 0);
  }
  Object.defineProperties(BitmapData.prototype, {
    width: { get() { return this.$canvas.width; } },
    height: { get() { return this.$canvas.height; } },
    rectangle: { get() { return new Rectangle(0, 0, this.$canvas.width, this.$canvas.height); } },
  });
  BitmapData.prototype.fillRect = function (r, argb) {
    if (!r) return;
    argb = (+argb) >>> 0;
    let a = this.transparent ? (argb >>> 24) : 255;
    const ctx = this.$ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.beginPath();
    ctx.rect(+r.x, +r.y, +r.width, +r.height);
    ctx.clip();
    ctx.fillStyle = `rgba(${(argb >> 16) & 255},${(argb >> 8) & 255},${argb & 255},${a / 255})`;
    ctx.fillRect(+r.x, +r.y, +r.width, +r.height);
    ctx.restore();
    this.$version++;
  };
  BitmapData.prototype.draw = function (source, matrix, cxform, blend, clip, smoothing) {
    if (!source) return;
    const m = matrix ? [+matrix.a, +matrix.b, +matrix.c, +matrix.d, +matrix.tx, +matrix.ty] : [1, 0, 0, 1, 0, 0];
    const ctx = this.$ctx;
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(+clip.x, +clip.y, +clip.width, +clip.height);
      ctx.clip();
    }
    if (source instanceof BitmapData) {
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(source.$canvas, 0, 0);
    } else if (source.$player) {
      const r = player.renderer;
      const saved = r.scale;
      r.scale = 1;
      r.drawContent(ctx, source, m, null);
      r.scale = saved;
    }
    ctx.restore();
    this.$version++;
  };
  BitmapData.prototype.getPixel = function (x, y) {
    const d = this.$ctx.getImageData(Math.trunc(x), Math.trunc(y), 1, 1).data;
    return (d[0] << 16) | (d[1] << 8) | d[2];
  };
  BitmapData.prototype.getPixel32 = function (x, y) {
    const d = this.$ctx.getImageData(Math.trunc(x), Math.trunc(y), 1, 1).data;
    return ((d[3] << 24) | (d[0] << 16) | (d[1] << 8) | d[2]) >>> 0;
  };
  BitmapData.prototype.setPixel = function (x, y, c) {
    this.fillRect(new Rectangle(Math.trunc(x), Math.trunc(y), 1, 1), ((+c) | 0xff000000) >>> 0);
  };
  BitmapData.prototype.dispose = function () { this.$canvas.width = this.$canvas.height = 1; };
  BitmapData.prototype.clone = function () {
    const b = new BitmapData(this.width, this.height, this.transparent, 0);
    b.$ctx.drawImage(this.$canvas, 0, 0);
    return b;
  };
  BitmapData.loadBitmap = function (name) {
    // A library bitmap by linkage name, as a BitmapData.
    for (const l of player.levels) {
      if (!l) continue;
      const id = l.$lib.exportId(String(name));
      if (id === null) continue;
      const img = l.$lib.bitmaps.get(id);
      if (!img) continue;
      const b = new BitmapData(img.width, img.height, true, 0);
      b.$ctx.drawImage(img, 0, 0);
      return b;
    }
    return undefined;
  };

  return {
    geom: { Matrix, Rectangle, Point, ColorTransform },
    filters: { BlurFilter, GlowFilter, DropShadowFilter, ColorMatrixFilter },
    display: { BitmapData },
  };
}
