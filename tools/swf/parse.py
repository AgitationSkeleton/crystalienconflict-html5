"""
Parse an entire SWF into plain Python structures.

What comes out is the SWF's own model, not a renderer's: characters by id, and for
every timeline (the main one and each DefineSprite) the ordered list of display-list
operations per frame, exactly as Flash Player would apply them.  Scripts are not
decompiled here -- FFDec's deobfuscated export does that -- but every place a script
runs is recorded (frame + ordinal, button condition, clip event) so the translated
code can be attached to the right place.

Tags this build of the game does not contain are rejected loudly rather than skipped,
so a surprise shows up as an error instead of as something quietly missing on screen.
"""

import struct
import zlib

from .reader import (BitReader, read_rect, read_matrix, read_cxform, read_rgb, read_rgba,
                     read_filters, read_soundinfo, BLEND_NAMES)
from .shapes import read_shape_with_style, read_shape, read_morph_shape

TAG = {
    0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 4: 'PlaceObject', 5: 'RemoveObject',
    6: 'DefineBits', 7: 'DefineButton', 8: 'JPEGTables', 9: 'SetBackgroundColor',
    10: 'DefineFont', 11: 'DefineText', 12: 'DoAction', 13: 'DefineFontInfo',
    14: 'DefineSound', 15: 'StartSound', 17: 'DefineButtonSound', 18: 'SoundStreamHead',
    19: 'SoundStreamBlock', 20: 'DefineBitsLossless', 21: 'DefineBitsJPEG2',
    22: 'DefineShape2', 24: 'Protect', 26: 'PlaceObject2', 28: 'RemoveObject2',
    32: 'DefineShape3', 33: 'DefineText2', 34: 'DefineButton2', 35: 'DefineBitsJPEG3',
    36: 'DefineBitsLossless2', 37: 'DefineEditText', 39: 'DefineSprite', 43: 'FrameLabel',
    45: 'SoundStreamHead2', 46: 'DefineMorphShape', 48: 'DefineFont2', 56: 'ExportAssets',
    57: 'ImportAssets', 58: 'EnableDebugger', 59: 'DoInitAction', 62: 'DefineFontInfo2',
    64: 'EnableDebugger2', 65: 'ScriptLimits', 66: 'SetTabIndex', 69: 'FileAttributes',
    70: 'PlaceObject3', 73: 'DefineFontAlignZones', 74: 'CSMTextSettings', 75: 'DefineFont3',
    77: 'Metadata', 78: 'DefineScalingGrid', 83: 'DefineShape4', 84: 'DefineMorphShape2',
    86: 'DefineSceneAndFrameLabelData', 88: 'DefineFontName',
}

# Tags that carry nothing a player of this game can see or hear.  253 and 255 are the
# obfuscator's own markers (secureSWF-style); Protect and the debugger/metadata tags
# are authoring switches.
IGNORED = {'Protect', 'EnableDebugger', 'EnableDebugger2', 'Metadata', 'FileAttributes',
           'ScriptLimits', 'CSMTextSettings', 'DefineFontAlignZones', 'DefineFontName',
           'SoundStreamBlock'}
OBFUSCATOR_TAGS = {253, 255}

# Clip event flags as laid out in a SWF 6+ CLIPEVENTFLAGS (32 bits, MSB of first byte
# first).  Names match FFDec's onClipEvent(...) spelling so exported files line up.
CLIP_EVENTS = [
    'keyUp', 'keyDown', 'mouseUp', 'mouseDown', 'mouseMove', 'unload', 'enterFrame', 'load',
    'dragOver', 'rollOut', 'rollOver', 'releaseOutside', 'release', 'press', 'initialize', 'data',
    None, None, None, None, None, 'construct', 'keyPress', 'dragOut',
    None, None, None, None, None, None, None, None,
]

KEY_NAMES = {1: 'Left', 2: 'Right', 3: 'Home', 4: 'End', 5: 'Insert', 6: 'Delete',
             8: 'Backspace', 13: 'Enter', 14: 'Up', 15: 'Down', 16: 'PageUp',
             17: 'PageDown', 18: 'Tab', 19: 'Escape', 32: 'Space'}


def _clip_events(r):
    r.align()
    raw = r.u32()
    out = []
    for i, name in enumerate(CLIP_EVENTS):
        # byte order: the four bytes are read little-endian, but the flags are defined
        # MSB-first per byte in file order.
        byte = i // 8
        bit = 7 - (i % 8)
        if (raw >> (byte * 8 + bit)) & 1 and name:
            out.append(name)
    return raw, out


def _place(r, tag, end, version):
    if tag == 'PlaceObject':
        cid = r.u16()
        depth = r.u16()
        p = {'depth': depth, 'char': cid, 'matrix': read_matrix(r)}
        if r.pos < end:
            p['cx'] = read_cxform(r, False)
        return 'place', p

    flags = r.u8()
    flags2 = r.u8() if tag == 'PlaceObject3' else 0
    move = flags & 0x01
    p = {'depth': r.u16()}
    if tag == 'PlaceObject3':
        if flags2 & 0x08 or (flags2 & 0x10 and flags & 0x02):   # HasClassName / HasImage
            p['className'] = r.string()
    if flags & 0x02:
        p['char'] = r.u16()
    if flags & 0x04:
        p['matrix'] = read_matrix(r)
    if flags & 0x08:
        p['cx'] = read_cxform(r, True)
    if flags & 0x10:
        p['ratio'] = r.u16()
    if flags & 0x20:
        p['name'] = r.string()
    if flags & 0x40:
        p['clipDepth'] = r.u16()
    if tag == 'PlaceObject3':
        if flags2 & 0x01:
            p['filters'] = read_filters(r)
        if flags2 & 0x02:
            p['blend'] = BLEND_NAMES.get(r.u8(), 'normal')
        if flags2 & 0x04:
            p['cacheAsBitmap'] = r.u8()
        if flags2 & 0x20:
            p['visible'] = r.u8()
        if flags2 & 0x40:
            p['opaqueBackground'] = read_rgba(r)
    if flags & 0x80:
        r.u16()                                     # reserved
        _clip_events(r)                             # AllEventFlags
        events = []
        while True:
            raw, names = _clip_events(r)
            if raw == 0:
                break
            size = r.u32()
            start = r.pos
            key = None
            if 'keyPress' in names:
                key = r.u8()
            events.append({'events': names, 'key': key, 'size': size})
            r.pos = start + size
        p['clipActions'] = events

    if move and 'char' in p:
        return 'replace', p          # move + new character: swap the character in place
    if move:
        return 'move', p
    return 'place', p


class Timeline:
    def __init__(self, frame_count):
        self.frame_count = frame_count
        self.frames = [[]]            # ops per frame, filled as ShowFrame is reached
        self.labels = {}
        self.stream = None

    def op(self, *o):
        self.frames[-1].append(list(o))

    def show_frame(self):
        self.frames.append([])

    def finish(self):
        # The trailing list after the last ShowFrame is always empty in a well-formed file.
        if self.frames and not self.frames[-1]:
            self.frames.pop()
        return self


class SWF:
    def __init__(self, path):
        raw = open(path, 'rb').read()
        sig = raw[:3]
        self.version = raw[3]
        if sig == b'CWS':
            body = zlib.decompress(raw[8:])
        elif sig == b'FWS':
            body = raw[8:]
        else:
            raise ValueError('unsupported SWF signature %r' % sig)
        r = BitReader(body)
        rect = read_rect(r)
        self.width = (rect[2] - rect[0]) / 20.0
        self.height = (rect[3] - rect[1]) / 20.0
        rate_lo = r.u8()
        rate_hi = r.u8()
        self.fps = rate_hi + rate_lo / 256.0
        self.frame_count = r.u16()
        self.background = [0, 0, 0, 255]
        self.characters = {}
        self.exports = {}
        self.jpeg_tables = None
        self.unknown = {}
        self.root = self._tags(body, r.pos, len(body), Timeline(self.frame_count), None)

    # ---------------------------------------------------------------------------------
    def _tags(self, data, pos, end, tl, sprite_id):
        while pos < end:
            code_len = struct.unpack_from('<H', data, pos)[0]
            pos += 2
            code = code_len >> 6
            length = code_len & 0x3F
            if length == 0x3F:
                length = struct.unpack_from('<I', data, pos)[0]
                pos += 4
            body_start = pos
            body_end = pos + length
            pos = body_end
            name = TAG.get(code)
            r = BitReader(data, body_start, body_end)

            if code in OBFUSCATOR_TAGS:
                continue
            if name == 'End':
                break
            if name in IGNORED:
                continue
            if name is None:
                self.unknown[code] = self.unknown.get(code, 0) + 1
                continue

            if name == 'ShowFrame':
                tl.show_frame()
            elif name in ('PlaceObject', 'PlaceObject2', 'PlaceObject3'):
                kind, p = _place(r, name, body_end, self.version)
                tl.op(kind, p)
            elif name == 'RemoveObject':
                r.u16()
                tl.op('remove', {'depth': r.u16()})
            elif name == 'RemoveObject2':
                tl.op('remove', {'depth': r.u16()})
            elif name == 'FrameLabel':
                label = r.string()
                tl.labels.setdefault(label, len(tl.frames))    # 1-based frame number
                tl.op('label', {'name': label})
            elif name == 'DoAction':
                count = sum(1 for o in tl.frames[-1] if o[0] == 'action') + 1
                tl.op('action', {'n': count})
            elif name == 'DoInitAction':
                raise ValueError('DoInitAction present -- not handled (sprite %d)' % r.u16())
            elif name == 'StartSound':
                sid = r.u16()
                tl.op('sound', {'id': sid, 'info': read_soundinfo(r)})
            elif name in ('SoundStreamHead', 'SoundStreamHead2'):
                r.u8()
                b = r.u8()
                fmt = b >> 4
                count = r.u16()
                if count:
                    tl.stream = {'format': fmt, 'samplesPerFrame': count}
            elif name == 'SetBackgroundColor':
                self.background = read_rgb(r)
            elif name == 'JPEGTables':
                self.jpeg_tables = data[body_start:body_end]
            elif name == 'ExportAssets':
                for _ in range(r.u16()):
                    cid = r.u16()
                    self.exports[r.string()] = cid
            elif name == 'ImportAssets':
                raise ValueError('ImportAssets present -- the game expects a shared library')
            elif name == 'DefineSprite':
                sid = r.u16()
                fc = r.u16()
                sub = self._tags(data, r.pos, body_end, Timeline(fc), sid).finish()
                self.characters[sid] = {'type': 'sprite', 'timeline': sub}
            else:
                self._define(name, r, body_start, body_end, data)
        return tl.finish() if sprite_id is None else tl

    # ---------------------------------------------------------------------------------
    def _define(self, name, r, start, end, data):
        if name in ('DefineShape', 'DefineShape2', 'DefineShape3', 'DefineShape4'):
            ver = {'DefineShape': 1, 'DefineShape2': 2, 'DefineShape3': 3, 'DefineShape4': 4}[name]
            cid = r.u16()
            bounds = read_rect(r)
            ch = {'type': 'shape', 'bounds': bounds}
            if ver == 4:
                ch['edgeBounds'] = read_rect(r)
                r.ub(5)
                ch['fillWinding'] = r.ub(1)
                r.ub(2)
            ch.update(read_shape_with_style(r, ver))
            self.characters[cid] = ch

        elif name in ('DefineMorphShape', 'DefineMorphShape2'):
            cid = r.u16()
            self.characters[cid] = read_morph_shape(r, 2 if name == 'DefineMorphShape2' else 1)

        elif name in ('DefineBits', 'DefineBitsJPEG2', 'DefineBitsJPEG3',
                      'DefineBitsLossless', 'DefineBitsLossless2'):
            cid = r.u16()
            ch = {'type': 'bitmap', 'tag': name}
            if name in ('DefineBitsLossless', 'DefineBitsLossless2'):
                ch['format'] = r.u8()
                ch['width'] = r.u16()
                ch['height'] = r.u16()
            self.characters[cid] = ch

        elif name == 'DefineSound':
            cid = r.u16()
            b = r.u8()
            self.characters[cid] = {
                'type': 'sound',
                'format': b >> 4,
                'rate': [5512, 11025, 22050, 44100][(b >> 2) & 3],
                'bits16': (b >> 1) & 1,
                'stereo': b & 1,
                'samples': r.u32(),
            }

        elif name == 'DefineButton2':
            cid = r.u16()
            r.u8()                                   # reserved(7) + TrackAsMenu(1)
            track_menu = data[start + 2] & 1
            action_offset = r.u16()
            records = []
            while True:
                r.align()
                flags = r.u8()
                if flags == 0:
                    break
                rec = {
                    'states': [s for s, bit in (('up', 1), ('over', 2), ('down', 4), ('hit', 8)) if flags & bit],
                    'char': r.u16(),
                    'depth': r.u16(),
                    'matrix': read_matrix(r),
                    'cx': read_cxform(r, True),
                }
                if flags & 0x10:
                    rec['filters'] = read_filters(r)
                if flags & 0x20:
                    rec['blend'] = BLEND_NAMES.get(r.u8(), 'normal')
                records.append(rec)
            actions = []
            if action_offset:
                pos = start + 2 + 1 + action_offset
                while True:
                    size, cond = struct.unpack_from('<HH', data, pos)
                    actions.append(_button_condition(cond))
                    if size == 0:
                        break
                    pos += size
            self.characters[cid] = {'type': 'button', 'trackAsMenu': track_menu,
                                    'records': records, 'actions': actions, 'sounds': None}

        elif name == 'DefineButtonSound':
            cid = r.u16()
            sounds = []
            for _ in range(4):
                sid = r.u16()
                sounds.append({'id': sid, 'info': read_soundinfo(r)} if sid else None)
            self.characters[cid]['sounds'] = dict(zip(
                ['overUpToIdle', 'idleToOverUp', 'overUpToOverDown', 'overDownToOverUp'], sounds))

        elif name == 'DefineEditText':
            cid = r.u16()
            ch = {'type': 'edittext', 'bounds': read_rect(r)}
            r.align()
            f1 = r.u8()
            f2 = r.u8()
            has_text, ch['wordWrap'], ch['multiline'], ch['password'], ch['readOnly'], \
                has_color, has_max, has_font = [(f1 >> (7 - i)) & 1 for i in range(8)]
            has_font_class, ch['autoSize'], has_layout, ch['noSelect'], ch['border'], \
                ch['wasStatic'], ch['html'], ch['useOutlines'] = [(f2 >> (7 - i)) & 1 for i in range(8)]
            if has_font:
                ch['font'] = r.u16()
            if has_font_class:
                ch['fontClass'] = r.string()
            if has_font or has_font_class:
                ch['fontHeight'] = r.u16()
            if has_color:
                ch['color'] = read_rgba(r)
            if has_max:
                ch['maxLength'] = r.u16()
            if has_layout:
                ch['align'] = ['left', 'right', 'center', 'justify'][r.u8()]
                ch['leftMargin'] = r.u16()
                ch['rightMargin'] = r.u16()
                ch['indent'] = r.u16()
                ch['leading'] = r.s16()
            ch['variable'] = r.string()
            if has_text:
                ch['text'] = r.string()
            self.characters[cid] = ch

        elif name in ('DefineText', 'DefineText2'):
            cid = r.u16()
            ch = {'type': 'text', 'bounds': read_rect(r), 'matrix': read_matrix(r), 'records': []}
            gbits = r.u8()
            abits = r.u8()
            font = color = height = None
            x = y = 0
            while True:
                r.align()
                flags = r.u8()
                if flags == 0:
                    break
                if flags & 0x08:
                    font = r.u16()
                if flags & 0x04:
                    color = read_rgba(r) if name == 'DefineText2' else read_rgb(r)
                if flags & 0x01:
                    x = r.s16()
                if flags & 0x02:
                    y = r.s16()
                if flags & 0x08:
                    height = r.u16()
                glyphs = []
                for _ in range(r.u8()):
                    glyphs.append([r.ub(gbits), r.sb(abits)])
                ch['records'].append({'font': font, 'color': color, 'height': height,
                                      'x': x, 'y': y, 'glyphs': glyphs})
                x += sum(a for _, a in glyphs)
            self.characters[cid] = ch

        elif name in ('DefineFont2', 'DefineFont3'):
            cid = r.u16()
            flags = r.u8()
            has_layout = flags & 0x80
            wide_offsets = flags & 0x08
            wide_codes = flags & 0x04
            ch = {'type': 'font', 'tag': name, 'italic': (flags >> 1) & 1, 'bold': flags & 1,
                  'smallText': (flags >> 5) & 1}
            r.u8()                                    # language code
            nlen = r.u8()
            ch['name'] = r.bytes(nlen).rstrip(b'\0').decode('latin-1')
            n = r.u16()
            table = r.pos
            offs = [struct.unpack_from('<I' if wide_offsets else '<H', data,
                                       table + i * (4 if wide_offsets else 2))[0] for i in range(n)]
            code_off = struct.unpack_from('<I' if wide_offsets else '<H', data,
                                          table + n * (4 if wide_offsets else 2))[0] if n else 0
            glyphs = []
            for i in range(n):
                gr = BitReader(data, table + offs[i], end)
                glyphs.append(read_shape(gr))
            ch['glyphs'] = glyphs
            cr = BitReader(data, table + code_off, end) if n else r
            ch['codes'] = [(cr.u16() if wide_codes else cr.u8()) for _ in range(n)]
            if has_layout:
                ch['ascent'] = cr.u16()
                ch['descent'] = cr.u16()
                ch['leading'] = cr.s16()
                ch['advances'] = [cr.s16() for _ in range(n)]
                ch['glyphBounds'] = [read_rect(cr) for _ in range(n)]
                kern = []
                for _ in range(cr.u16()):
                    a = cr.u16() if wide_codes else cr.u8()
                    b = cr.u16() if wide_codes else cr.u8()
                    kern.append([a, b, cr.s16()])
                ch['kerning'] = kern
            ch['emSquare'] = 20480 if name == 'DefineFont3' else 1024
            self.characters[cid] = ch

        elif name in ('DefineFont', 'DefineFontInfo', 'DefineFontInfo2', 'DefineButton',
                      'DefineScalingGrid', 'DefineSceneAndFrameLabelData'):
            raise ValueError('%s present -- not expected in this game, not handled' % name)
        else:
            raise ValueError('unhandled tag %s' % name)


def _button_condition(cond):
    """BUTTONCONDACTION flags -> the FFDec-style on(...) text and a structured form."""
    names = []
    # The SWF layout is: first byte = IdleToOverDown, OutDownToIdle, OutDownToOverDown,
    # OverDownToOutDown, OverDownToOverUp, OverUpToOverDown, OverUpToIdle, IdleToOverUp;
    # second byte = KeyPress(7), OverDownToIdle(1).  Read little-endian as a u16, the
    # first byte is the low byte.
    b0 = cond & 0xFF
    b1 = cond >> 8
    idle_to_over_down = (b0 >> 7) & 1
    out_down_to_idle = (b0 >> 6) & 1
    out_down_to_over_down = (b0 >> 5) & 1
    over_down_to_out_down = (b0 >> 4) & 1
    over_down_to_over_up = (b0 >> 3) & 1
    over_up_to_over_down = (b0 >> 2) & 1
    over_up_to_idle = (b0 >> 1) & 1
    idle_to_over_up = b0 & 1
    key = b1 >> 1
    over_down_to_idle = b1 & 1

    # FFDec's own ordering for the on(...) list, so file names match exactly.
    if over_up_to_over_down:
        names.append('press')
    if over_down_to_over_up:
        names.append('release')
    if out_down_to_idle:
        names.append('releaseOutside')
    if idle_to_over_up:
        names.append('rollOver')
    if over_up_to_idle:
        names.append('rollOut')
    if out_down_to_over_down or idle_to_over_down:
        names.append('dragOver')
    if over_down_to_out_down or over_down_to_idle:
        names.append('dragOut')
    if key:
        names.append('keyPress ' + KEY_NAMES.get(key, repr(chr(key)) if 32 < key < 127 else str(key)))
    return {'events': names, 'key': key or None}
