"""
Build the browser-side library from the original SWFs.

    python tools/build_library.py [--original DIR]

Reads loader.swf and game(original).swf, writes

    data/<movie>.json            characters, timelines, exports -- everything the runtime plays
    assets/<movie>/bitmaps.bin   every bitmap (PNG, or JPEG where the SWF had a plain JPEG),
                                 end to end; each bitmap character records its [offset, length]
    assets/<movie>/sounds.bin    every sound as the SWF stored it (MP3), packed the same way
    assets/fonts/                the embedded fonts as TTF (reference only: text is drawn
                                 from the glyph outlines in the JSON)
    data/dialogue.xml            the game's text, byte for byte
    data/sizes.json              the byte size of every file a movie downloads

One file per kind rather than one per bitmap: the game has two thousand bitmaps, and the
loader's progress bar wants a byte count that climbs smoothly.

Media decoding is FFDec's (work/ffdec/<movie>_media, produced by tools/extract.py);
structure is ours (tools/swf).  The two meet on character ids, and the build refuses to
finish if any character has no media or any media has no character.
"""

import argparse
import re
import json
import os
import shutil
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from swf.parse import SWF                                  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DEFAULT_ORIGINAL = r'D:\Claude_RTSGames\CRYSTALIEN\CrystAlienConflict'
MOVIES = {'loader': 'loader.swf', 'game': 'game(original).swf'}


def r2(v):
    return round(v, 2)


def r5(v):
    return round(v, 5)


def matrix(m):
    """Placement matrices: tx/ty arrive in twips."""
    return [r5(m[0]), r5(m[1]), r5(m[2]), r5(m[3]), r2(m[4] / 20.0), r2(m[5] / 20.0)]


def pmatrix(m):
    """Fill matrices are already in pixels (see shapes.py)."""
    return [r5(m[0]), r5(m[1]), r5(m[2]), r5(m[3]), r2(m[4]), r2(m[5])]


def path_string(cmds):
    out = []
    for c in cmds:
        out.append(c[0] + ' '.join('%g' % v for v in c[1:]) if len(c) > 1 else c[0])
    return ''.join(out)


def style(s):
    s = dict(s)
    if 'm' in s:
        s['m'] = pmatrix(s['m'])
    if 'fill' in s:
        s['fill'] = style(s['fill'])
    return s


def rect_of(cmds):
    """If a path is exactly one axis-aligned rectangle, return it as [x0,y0,x1,y1]."""
    if len(cmds) != 6 or cmds[0][0] != 'M' or cmds[-1][0] != 'Z':
        return None
    pts = [(cmds[0][1], cmds[0][2])] + [(c[1], c[2]) for c in cmds[1:5] if c[0] == 'L']
    if len(pts) != 5 or pts[0] != pts[4]:
        return None
    xs = sorted(set(p[0] for p in pts))
    ys = sorted(set(p[1] for p in pts))
    if len(xs) != 2 or len(ys) != 2:
        return None
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        if ax != bx and ay != by:
            return None
    return [xs[0], ys[0], xs[1], ys[1]]


def shape_json(ch, bitmaps):
    b = [r2(v / 20.0) for v in ch['bounds']]
    out = {'t': 'shape', 'b': b}
    layers = ch['layers']
    # Fast path: one clipped bitmap filling exactly its own rectangle -- which is how the
    # Flash IDE represents every imported bitmap dragged onto the stage.
    if (len(layers) == 1 and len(layers[0]['fills']) == 1 and not layers[0]['lines']
            and layers[0]['fills'][0]['style']['t'] == 'bitmap'):
        f = layers[0]['fills'][0]
        st = f['style']
        rect = rect_of(f['path'])
        bm = bitmaps.get(st['id'])
        m = st['m']
        if rect and bm and not st['repeat'] and abs(m[1]) < 1e-9 and abs(m[2]) < 1e-9:
            x0, y0 = m[4], m[5]
            x1, y1 = m[4] + m[0] * bm['w'], m[5] + m[3] * bm['h']
            lo_x, hi_x = min(x0, x1), max(x0, x1)
            lo_y, hi_y = min(y0, y1), max(y0, y1)
            if (abs(lo_x - rect[0]) < 0.06 and abs(lo_y - rect[1]) < 0.06
                    and abs(hi_x - rect[2]) < 0.06 and abs(hi_y - rect[3]) < 0.06):
                out['bmp'] = {'id': st['id'], 'm': pmatrix(m), 'smooth': st['smooth']}
                return out
    out['layers'] = [{
        'fills': [{'s': style(f['style']), 'p': path_string(f['path'])} for f in L['fills']],
        'lines': [{'s': style(l['style']), 'p': path_string(l['path'])} for l in L['lines']],
    } for L in layers]
    return out


def cx(c):
    return None if c == [256, 256, 256, 256, 0, 0, 0, 0] else c


def filters(fs):
    out = []
    for f in fs:
        # Zero-radius blurs and zero-strength glows are no-ops the IDE leaves behind;
        # dropping them saves the renderer an offscreen pass per placement.
        if f['type'] == 'blur' and f['blurX'] == 0 and f['blurY'] == 0:
            continue
        if f['type'] in ('glow', 'dropShadow') and f.get('strength', 1) == 0:
            continue
        g = {k: (r5(v) if isinstance(v, float) else v) for k, v in f.items()}
        if 'matrix' in g:
            g['matrix'] = [r5(v) for v in f['matrix']]
        out.append(g)
    return out


def place_json(kind, p):
    code = {'place': 'P', 'move': 'M', 'replace': 'R'}[kind]
    o = {'o': code, 'd': p['depth']}
    if 'char' in p:
        o['c'] = p['char']
    if 'matrix' in p:
        o['m'] = matrix(p['matrix'])
    if 'cx' in p:
        o['x'] = cx(p['cx'])
    if 'ratio' in p:
        o['r'] = p['ratio']
    if 'name' in p:
        o['n'] = p['name']
    if 'clipDepth' in p:
        o['cd'] = p['clipDepth']
    if 'filters' in p:
        o['f'] = filters(p['filters'])
    if 'visible' in p:
        o['v'] = p['visible']
    if 'clipActions' in p:
        o['e'] = [{'ev': ca['events'], 'k': ca['key']} for ca in p['clipActions']]
    return o


def timeline_json(tl):
    frames = []
    for ops in tl.frames:
        out = []
        for op in ops:
            kind, p = op[0], op[1]
            if kind in ('place', 'move', 'replace'):
                out.append(place_json(kind, p))
            elif kind == 'remove':
                out.append({'o': 'X', 'd': p['depth']})
            elif kind == 'action':
                out.append({'o': 'A', 'i': p['n']})
            elif kind == 'sound':
                out.append({'o': 'S', 'id': p['id'], 'info': p['info']})
            elif kind == 'label':
                pass                              # carried in the labels table
            else:
                raise ValueError(kind)
        frames.append(out)
    # A sprite's frame count is authoritative; pad trailing empty frames it declares.
    while len(frames) < tl.frame_count:
        frames.append([])
    return {'n': tl.frame_count, 'labels': tl.labels, 'frames': frames}


class Pack:
    """Files written end to end; add() returns where each one landed."""

    def __init__(self, path):
        self.fh = open(path, 'wb')
        self.size = 0

    def add(self, src):
        with open(src, 'rb') as f:
            data = f.read()
        at = self.size
        self.fh.write(data)
        self.size += len(data)
        return [at, len(data)]

    def close(self):
        self.fh.close()


def build(movie, swf_path, media_dir, out_assets, font_dir):
    swf = SWF(swf_path)
    img_dir = os.path.join(media_dir, 'images')
    snd_dir = os.path.join(media_dir, 'sounds')
    fnt_dir = os.path.join(media_dir, 'fonts')
    os.makedirs(out_assets, exist_ok=True)
    for old in ('bitmaps', 'sounds'):                      # the one-file-per-bitmap layout
        if os.path.isdir(os.path.join(out_assets, old)):
            shutil.rmtree(os.path.join(out_assets, old))
    os.makedirs(font_dir, exist_ok=True)
    bitmap_pack = Pack(os.path.join(out_assets, 'bitmaps.bin'))
    sound_pack = Pack(os.path.join(out_assets, 'sounds.bin'))

    # FFDec names media '<id>.ext', or '<id>_<linkage>.ext' when the SWF exports it.
    def by_id(d, skip_negative=False):
        out = {}
        if os.path.isdir(d):
            for f in os.listdir(d):
                m = re.match(r'(-?\d+)', f)
                if m and not (skip_negative and m.group(1).startswith('-')):
                    out[int(m.group(1))] = f
        return out
    images = by_id(img_dir)
    sounds = by_id(snd_dir, skip_negative=True)
    fonts = by_id(fnt_dir)

    bitmaps = {}
    chars = {}
    missing = []
    for cid, ch in sorted(swf.characters.items()):
        if ch['type'] == 'bitmap':
            f = images.get(cid)
            if not f:
                missing.append(('bitmap', cid))
                continue
            with Image.open(os.path.join(img_dir, f)) as im:
                w, h = im.size
                mime = Image.MIME[im.format]
            bitmaps[cid] = {'w': w, 'h': h}
            chars[cid] = {'t': 'bitmap', 'pack': bitmap_pack.add(os.path.join(img_dir, f)), 'type': mime,
                          'w': w, 'h': h}
    for cid, ch in sorted(swf.characters.items()):
        t = ch['type']
        if t == 'bitmap':
            continue
        if t == 'shape':
            chars[cid] = shape_json(ch, bitmaps)
        elif t == 'sprite':
            j = timeline_json(ch['timeline'])
            j['t'] = 'sprite'
            chars[cid] = j
        elif t == 'sound':
            f = sounds.get(cid)
            if not f:
                missing.append(('sound', cid))
                continue
            chars[cid] = {'t': 'sound', 'pack': sound_pack.add(os.path.join(snd_dir, f)), 'rate': ch['rate'],
                          'stereo': ch['stereo'], 'samples': ch['samples'], 'format': ch['format']}
        elif t == 'button':
            chars[cid] = {
                't': 'button', 'menu': ch['trackAsMenu'],
                'recs': [dict({'s': r['states'], 'c': r['char'], 'd': r['depth'], 'm': matrix(r['matrix']),
                               'x': cx(r['cx'])}, **({'f': filters(r['filters'])} if 'filters' in r else {}))
                         for r in ch['records']],
                'acts': [{'ev': a['events'], 'k': a['key']} for a in ch['actions']],
                'snd': ch['sounds'],
            }
        elif t == 'edittext':
            j = {k: v for k, v in ch.items() if k not in ('type', 'bounds')}
            j['t'] = 'edittext'
            j['b'] = [r2(v / 20.0) for v in ch['bounds']]
            for k in ('fontHeight', 'leftMargin', 'rightMargin', 'indent', 'leading'):
                if k in j:
                    j[k] = r2(j[k] / 20.0)
            chars[cid] = j
        elif t == 'text':
            chars[cid] = {'t': 'text', 'b': [r2(v / 20.0) for v in ch['bounds']], 'm': matrix(ch['matrix']),
                          'recs': [{'font': r['font'], 'color': r['color'], 'h': r2(r['height'] / 20.0),
                                    'x': r2(r['x'] / 20.0), 'y': r2(r['y'] / 20.0),
                                    'g': [[g, r2(a / 20.0)] for g, a in r['glyphs']]} for r in ch['records']]}
        elif t == 'font':
            f = fonts.get(cid)
            if f:
                shutil.copyfile(os.path.join(fnt_dir, f), os.path.join(font_dir, f))
            em = ch['emSquare']
            j = {'t': 'font', 'name': ch['name'], 'file': ('fonts/' + f) if f else None,
                 'bold': ch['bold'], 'italic': ch['italic'], 'em': em,
                 'codes': ch['codes'], 'glyphs': [path_string(g) for g in ch['glyphs']]}
            for k in ('ascent', 'descent', 'leading', 'advances', 'kerning'):
                if k in ch:
                    j[k] = ch[k]
            chars[cid] = j
        elif t == 'morph':
            def edges(es):
                out = []
                for e in es:
                    if e[0] == 'move':
                        out.append(['M', r2(e[1] / 20.0), r2(e[2] / 20.0), e[3], e[4], e[5]])
                    elif e[0] == 'line':
                        out.append(['L', r2(e[1] / 20.0), r2(e[2] / 20.0), r2(e[3] / 20.0), r2(e[4] / 20.0), e[5], e[6], e[7]])
                    else:
                        out.append(['Q', r2(e[1] / 20.0), r2(e[2] / 20.0), r2(e[3] / 20.0), r2(e[4] / 20.0),
                                    r2(e[5] / 20.0), r2(e[6] / 20.0), e[7], e[8], e[9]])
                return out

            def mstyle(s):
                s = dict(s)
                for k in ('m0', 'm1'):
                    if k in s:
                        s[k] = pmatrix(s[k])
                if 'fill' in s:
                    s['fill'] = mstyle(s['fill'])
                return s
            chars[cid] = {'t': 'morph', 'b0': [r2(v / 20.0) for v in ch['startBounds']],
                          'b1': [r2(v / 20.0) for v in ch['endBounds']],
                          'fills': [mstyle(s) for s in ch['fills']], 'lines': [mstyle(s) for s in ch['lines']],
                          'start': edges(ch['start']), 'end': edges(ch['end'])}
        else:
            raise ValueError('no JSON form for %s' % t)

    bitmap_pack.close()
    sound_pack.close()
    unused = [('bitmap', i) for i in images if i not in bitmaps] + \
             [('sound', i) for i in sounds if i not in chars]
    if missing or unused:
        raise SystemExit('%s: media and characters disagree -- missing %r, unused %r' % (movie, missing, unused))

    lib = {
        'movie': movie, 'version': swf.version, 'width': swf.width, 'height': swf.height,
        'fps': swf.fps, 'background': swf.background, 'exports': swf.exports,
        'root': timeline_json(swf.root), 'chars': {str(k): v for k, v in chars.items()},
    }
    return lib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--original', default=DEFAULT_ORIGINAL)
    args = ap.parse_args()
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    for movie, fname in MOVIES.items():
        lib = build(movie, os.path.join(args.original, fname),
                    os.path.join(ROOT, 'work', 'ffdec', movie + '_media'),
                    os.path.join(ROOT, 'assets', movie), os.path.join(ROOT, 'assets', 'fonts'))
        out = os.path.join(ROOT, 'data', movie + '.json')
        with open(out, 'w', encoding='utf-8') as fh:
            json.dump(lib, fh, separators=(',', ':'))
        kinds = {}
        for ch in lib['chars'].values():
            kinds[ch['t']] = kinds.get(ch['t'], 0) + 1
        print('%-7s %7.1f KB  %s' % (movie, os.path.getsize(out) / 1024.0,
                                     ', '.join('%s %d' % kv for kv in sorted(kinds.items()))))
    shutil.copyfile(os.path.join(args.original, 'dialogue.xml'), os.path.join(ROOT, 'data', 'dialogue.xml'))
    print('dialogue.xml copied')

    # The size of every file a movie downloads, keyed by URL.  getBytesTotal() has to be
    # known before the download starts -- the loader draws its progress bar from it.
    sizes = {}
    for movie in MOVIES:
        sizes['data/%s.json' % movie] = os.path.getsize(os.path.join(ROOT, 'data', movie + '.json'))
        for pack in ('bitmaps.bin', 'sounds.bin'):
            sizes['assets/%s/%s' % (movie, pack)] = os.path.getsize(os.path.join(ROOT, 'assets', movie, pack))
    with open(os.path.join(ROOT, 'data', 'sizes.json'), 'w', encoding='utf-8') as fh:
        json.dump(sizes, fh, separators=(',', ':'), sort_keys=True)
    print('sizes.json: %d files, %.1f MB' % (len(sizes), sum(sizes.values()) / 1048576.0))


if __name__ == '__main__':
    main()
