// Text fields (DefineEditText), laid out and drawn the way Flash 8 does it.
//
// Every field in this game uses embedded outlines, so text is drawn from the fonts'
// own glyph shapes and advance widths -- the exact data Flash drew from -- rather than
// from a browser font.  Layout follows Flash's TextField rules: a 2px gutter on every
// side, the first baseline one ascent below it, lines one ascent+descent+leading apart,
// wrapping at spaces, and everything clipped to the field's rectangle.

import { mul, cxApplyRGBA, cssColor } from './geom.js';

const GUTTER = 2;

export class TextEngine {
  constructor(player) {
    this.player = player;
    this.caretOn = true;
  }

  // ---- variable binding --------------------------------------------------------------
  // A field with a variable name shows that variable, resolved on its parent timeline.
  // If the variable does not exist yet the field creates it from its own initial text,
  // as Flash does, so scripts reading it see the text the artist typed.
  bind(field) {
    const v = field.$variable;
    if (!v) return;
    const [obj, name] = this.resolve(field, v);
    if (!obj) return;
    const cur = obj[name];
    if (cur === undefined) {
      if (!field.$bound) obj[name] = field.$text;
    } else {
      field.$text = asString(cur);
    }
    field.$bound = true;
  }

  writeVariable(field) {
    const v = field.$variable;
    if (!v) return;
    const [obj, name] = this.resolve(field, v);
    if (obj) obj[name] = field.$text;
  }

  resolve(field, path) {
    // "name", "clip.name", "_root.clip.name", or Flash 4's "/clip:name".
    let obj = field.$parent;
    let p = path;
    const colon = p.lastIndexOf(':');
    if (colon >= 0) {
      const target = p.slice(0, colon);
      p = p.slice(colon + 1);
      obj = this.player.resolveTarget(obj, target);
      return [obj, p];
    }
    const parts = p.split('.');
    const name = parts.pop();
    for (const part of parts) {
      if (!obj) return [null, name];
      if (part === '_root') obj = obj.$level();
      else if (part === '_parent') obj = obj.$parent;
      else if (/^_level\d+$/.test(part)) obj = this.player.level(+part.slice(6));
      else obj = obj[part];
    }
    return [obj, name];
  }

  plain(field) {
    this.bind(field);
    return field.$html ? htmlToPlain(field.$text) : field.$text;
  }

  // ---- layout ------------------------------------------------------------------------
  runs(field) {
    // A list of runs {text, font, size, color, align}; HTML is parsed into the same form.
    const ch = field.$char;
    const base = {
      font: ch.font, size: ch.fontHeight || 12, color: field.$color, align: ch.align || 'left',
    };
    if (!field.$html) return [{ ...base, text: normaliseNewlines(field.$text) }];
    return parseHtml(field.$text, base, this.player, field.$lib);
  }

  layout(field) {
    const ch = field.$char;
    const lib = field.$lib;
    const b = ch.b;
    const left = b[0] + GUTTER + (ch.leftMargin || 0);
    const right = b[2] - GUTTER - (ch.rightMargin || 0);
    const width = right - left;
    const wrap = !!(ch.wordWrap && ch.multiline);
    const multiline = !!ch.multiline;
    const leading = ch.leading || 0;

    const lines = [];
    let line = { items: [], width: 0, ascent: 0, descent: 0, align: 'left' };
    const pushLine = () => {
      lines.push(line);
      line = { items: [], width: 0, ascent: 0, descent: 0, align: line.align };
    };

    for (const run of this.runs(field)) {
      const font = lib.char(run.font);
      if (!font || !font.glyphs) continue;
      const scale = run.size / font.em;
      const asc = (font.ascent || font.em * 0.8) * scale;
      const desc = (font.descent || font.em * 0.2) * scale;
      line.align = run.align;
      const words = run.text.split(/(\n| )/);
      for (const w of words) {
        if (w === '') continue;
        if (w === '\n') {
          if (multiline) {
            line.ascent = Math.max(line.ascent, asc);
            line.descent = Math.max(line.descent, desc);
            pushLine();
            line.align = run.align;
          }
          continue;
        }
        const glyphs = [];
        let wWidth = 0;
        for (const c of w) {
          const gi = glyphIndex(font, c.codePointAt(0));
          const adv = gi >= 0 && font.advances ? font.advances[gi] * scale : run.size * 0.5;
          glyphs.push({ gi, adv });
          wWidth += adv;
        }
        if (wrap && w !== ' ' && line.width > 0 && line.width + wWidth > width) {
          // Trailing spaces do not count against the line they end.
          while (line.items.length && line.items[line.items.length - 1].space) {
            line.width -= line.items.pop().width;
          }
          pushLine();
          line.align = run.align;
        }
        if (w === ' ' && wrap && line.width === 0 && lines.length) continue;
        line.items.push({ glyphs, width: wWidth, font, run, scale, space: w === ' ' });
        line.width += wWidth;
        line.ascent = Math.max(line.ascent, asc);
        line.descent = Math.max(line.descent, desc);
      }
    }
    pushLine();
    // An empty line still has height, taken from the field's own font.
    const baseFont = lib.char(ch.font);
    if (baseFont) {
      const s = (ch.fontHeight || 12) / baseFont.em;
      for (const L of lines) {
        if (!L.ascent) L.ascent = (baseFont.ascent || baseFont.em * 0.8) * s;
        if (!L.descent) L.descent = (baseFont.descent || baseFont.em * 0.2) * s;
      }
    }
    return { lines, left, right, width, leading, top: b[1] + GUTTER };
  }

  // ---- drawing -----------------------------------------------------------------------
  draw(ctx, field, m, cx, renderer) {
    this.bind(field);
    const ch = field.$char;
    const L = this.layout(field);
    const b = ch.b;
    ctx.save();
    renderer.setTransform(ctx, m);
    if (ch.border) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    }
    ctx.beginPath();
    ctx.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    ctx.clip();
    let y = L.top;
    let caretX = null, caretY = null, caretH = 0;
    for (let i = 0; i < L.lines.length; i++) {
      const line = L.lines[i];
      y += line.ascent;
      let x = L.left;
      if (line.align === 'right') x = L.right - line.width;
      else if (line.align === 'center') x = L.left + (L.width - line.width) / 2;
      for (const item of line.items) {
        const col = cxApplyRGBA(cx, item.run.color || [0, 0, 0, 255]);
        ctx.fillStyle = cssColor(col);
        const gs = item.scale * 20;          // glyph paths are in (em / 20) units
        for (const g of item.glyphs) {
          if (g.gi >= 0 && item.font.glyphs[g.gi]) {
            const p = field.$lib.path(`font${item.run.font}:${g.gi}`, item.font.glyphs[g.gi]);
            renderer.setTransform(ctx, mul(m, [gs, 0, 0, gs, x, y]));
            ctx.fill(p, 'evenodd');
          }
          x += g.adv;
        }
      }
      caretX = x;
      caretY = y;
      caretH = line.ascent + line.descent;
      y += line.descent + L.leading;
    }
    if (field.$focus && this.caretOn && caretX !== null) {
      renderer.setTransform(ctx, m);
      ctx.fillStyle = cssColor(cxApplyRGBA(cx, field.$color));
      ctx.fillRect(caretX + 0.5, caretY - caretH * 0.8, 1, caretH);
    }
    ctx.restore();
  }

  // ---- input -------------------------------------------------------------------------
  // The one editable field in the game is the cheat-code entry.  Typing edits the text
  // and writes it back to the bound variable, which is what the OK button reads.
  keyInput(field, ev) {
    const ch = field.$char;
    if (ev.key === 'Backspace') {
      field.$text = [...field.$text].slice(0, -1).join('');
    } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
      if (ch.maxLength && [...field.$text].length >= ch.maxLength) return;
      field.$text += ev.key;
    } else {
      return;
    }
    this.writeVariable(field);
  }
}

// ---- helpers -------------------------------------------------------------------------------

function glyphIndex(font, code) {
  if (!font.$map) {
    font.$map = new Map();
    font.codes.forEach((c, i) => font.$map.set(c, i));
  }
  const i = font.$map.get(code);
  return i === undefined ? -1 : i;
}

function normaliseNewlines(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

// Number -> string as AVM1 does it: 15 significant digits, so 0.1 + 0.2 shows as 0.3.
export function asString(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    if (v === 0) return '0';
    let s = v.toPrecision(15);
    if (s.includes('e')) {
      let [mant, exp] = s.split('e');
      if (mant.includes('.')) mant = mant.replace(/\.?0+$/, '');
      return mant + 'e' + exp;
    }
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
    return s;
  }
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    const r = ENTITIES[e.toLowerCase()];
    return r === undefined ? m : r;
  });
}

function htmlToPlain(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, ''));
}

// The HTML Flash 8 text fields understand, reduced to what these fields use:
// <p align>, <font face size color>, <br>, <b>/<i> (drawn with the regular outlines when
// no bold/italic outlines are embedded, as the runs keep their font id).
function parseHtml(html, base, player, lib) {
  const runs = [];
  const stack = [{ ...base }];
  const top = () => stack[stack.length - 1];
  const re = /<(\/?)([a-z]+)([^>]*)>|([^<]+)/gi;
  let m;
  let firstParagraph = true;
  while ((m = re.exec(String(html)))) {
    if (m[4] !== undefined) {
      runs.push({ ...top(), text: decodeEntities(m[4]).replace(/\r\n?/g, '\n') });
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = {};
    m[3].replace(/(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g, (_, k, __, a, b2, c) => { attrs[k.toLowerCase()] = a ?? b2 ?? c; });
    if (tag === 'br') {
      runs.push({ ...top(), text: '\n' });
    } else if (tag === 'p') {
      if (closing) {
        stack.length > 1 && stack.pop();
        runs.push({ ...top(), text: '\n' });
      } else {
        if (!firstParagraph) { /* paragraphs are separated by the closing tag's newline */ }
        firstParagraph = false;
        stack.push({ ...top(), align: (attrs.align || top().align).toLowerCase() });
      }
    } else if (tag === 'font') {
      if (closing) {
        stack.length > 1 && stack.pop();
      } else {
        const s = { ...top() };
        if (attrs.size) s.size = attrs.size[0] === '+' || attrs.size[0] === '-' ? s.size + parseInt(attrs.size, 10) : parseInt(attrs.size, 10);
        if (attrs.color && /^#[0-9a-f]{6}$/i.test(attrs.color)) {
          const v = parseInt(attrs.color.slice(1), 16);
          s.color = [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
        }
        if (attrs.face) {
          const fid = findFont(lib, attrs.face, false);
          if (fid !== null) s.font = fid;
        }
        stack.push(s);
      }
    } else if (tag === 'b' || tag === 'i' || tag === 'u' || tag === 'a' || tag === 'span' || tag === 'textformat' || tag === 'li') {
      if (closing) stack.length > 1 && stack.pop();
      else stack.push({ ...top() });
    }
  }
  // The final paragraph's newline is not a line of its own.
  while (runs.length && runs[runs.length - 1].text === '\n') runs.pop();
  return runs;
}

function findFont(lib, face, bold) {
  let fallback = null;
  for (const id of Object.keys(lib.chars)) {
    const c = lib.chars[id];
    if (c.t !== 'font' || c.name !== face) continue;
    if (!!c.bold === !!bold) return +id;
    if (fallback === null) fallback = +id;
  }
  return fallback;
}
