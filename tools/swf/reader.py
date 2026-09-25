"""
Low-level SWF reading: the bit reader and the shared record types.

Everything here follows the SWF File Format Specification (v10/v19) field for field.
Nothing is interpreted beyond what the format itself says; turning these records into
something a browser can draw is build_library.py's job.

Coordinates stay in twips (1/20 px) until the very end, so no precision is lost to
rounding before the runtime decides how to round -- Flash rounds positions to twips
itself, and reproducing that exactly matters more than it looks.
"""

import struct


class BitReader:
    """MSB-first bit fields interleaved with little-endian byte-aligned values."""

    def __init__(self, data, pos=0, end=None):
        self.data = data
        self.pos = pos
        self.end = len(data) if end is None else end
        self._bit = 0          # bits left in self._cur
        self._cur = 0

    # -- bit fields -----------------------------------------------------------------
    def align(self):
        self._bit = 0

    def ub(self, n):
        v = 0
        while n:
            if self._bit == 0:
                self._cur = self.data[self.pos]
                self.pos += 1
                self._bit = 8
            take = min(n, self._bit)
            self._bit -= take
            v = (v << take) | ((self._cur >> self._bit) & ((1 << take) - 1))
            n -= take
        return v

    def sb(self, n):
        if n == 0:
            return 0
        v = self.ub(n)
        if v & (1 << (n - 1)):
            v -= (1 << n)
        return v

    def fb(self, n):
        return self.sb(n) / 65536.0

    # -- byte aligned ---------------------------------------------------------------
    def u8(self):
        self.align()
        v = self.data[self.pos]
        self.pos += 1
        return v

    def s8(self):
        v = self.u8()
        return v - 256 if v > 127 else v

    def u16(self):
        self.align()
        v = struct.unpack_from('<H', self.data, self.pos)[0]
        self.pos += 2
        return v

    def s16(self):
        self.align()
        v = struct.unpack_from('<h', self.data, self.pos)[0]
        self.pos += 2
        return v

    def u32(self):
        self.align()
        v = struct.unpack_from('<I', self.data, self.pos)[0]
        self.pos += 4
        return v

    def s32(self):
        self.align()
        v = struct.unpack_from('<i', self.data, self.pos)[0]
        self.pos += 4
        return v

    def fixed(self):           # 16.16 signed
        return self.s32() / 65536.0

    def fixed8(self):          # 8.8 signed
        return self.s16() / 256.0

    def float32(self):
        self.align()
        v = struct.unpack_from('<f', self.data, self.pos)[0]
        self.pos += 4
        return v

    def string(self):
        self.align()
        end = self.data.index(0, self.pos)
        raw = self.data[self.pos:end]
        self.pos = end + 1
        # SWF 6+ strings are UTF-8.  A handful of authoring tools wrote Latin-1 anyway,
        # so fall back rather than lose the name.
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            return raw.decode('latin-1')

    def bytes(self, n):
        self.align()
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v

    def remaining(self):
        return self.end - self.pos


# ---- shared records ------------------------------------------------------------------

def read_rect(r):
    r.align()
    n = r.ub(5)
    x0, x1, y0, y1 = r.sb(n), r.sb(n), r.sb(n), r.sb(n)
    r.align()
    return [x0, y0, x1, y1]          # twips, [xmin, ymin, xmax, ymax]


def read_matrix(r):
    """Returns [a, b, c, d, tx, ty]: x' = a*x + c*y + tx, y' = b*x + d*y + ty (tx/ty twips)."""
    r.align()
    a = d = 1.0
    b = c = 0.0
    if r.ub(1):
        n = r.ub(5)
        a = r.fb(n)
        d = r.fb(n)
    if r.ub(1):
        n = r.ub(5)
        b = r.fb(n)          # RotateSkew0
        c = r.fb(n)          # RotateSkew1
    n = r.ub(5)
    tx = r.sb(n)
    ty = r.sb(n)
    r.align()
    return [a, b, c, d, tx, ty]


def read_cxform(r, with_alpha):
    """Returns [rm, gm, bm, am, ra, ga, ba, aa]; multipliers are 8.8 (256 == 1.0)."""
    r.align()
    has_add = r.ub(1)
    has_mult = r.ub(1)
    n = r.ub(4)
    rm = gm = bm = am = 256
    ra = ga = ba = aa = 0
    if has_mult:
        rm, gm, bm = r.sb(n), r.sb(n), r.sb(n)
        if with_alpha:
            am = r.sb(n)
    if has_add:
        ra, ga, ba = r.sb(n), r.sb(n), r.sb(n)
        if with_alpha:
            aa = r.sb(n)
    r.align()
    return [rm, gm, bm, am, ra, ga, ba, aa]


def read_rgb(r):
    return [r.u8(), r.u8(), r.u8(), 255]


def read_rgba(r):
    return [r.u8(), r.u8(), r.u8(), r.u8()]


def read_argb(r):
    a = r.u8()
    return [r.u8(), r.u8(), r.u8(), a]


FILTER_NAMES = {0: 'dropShadow', 1: 'blur', 2: 'glow', 3: 'bevel',
                4: 'gradientGlow', 5: 'convolution', 6: 'colorMatrix', 7: 'gradientBevel'}


def read_filters(r):
    out = []
    for _ in range(r.u8()):
        fid = r.u8()
        f = {'type': FILTER_NAMES.get(fid, str(fid))}
        if fid == 0:                                  # DropShadow
            f['color'] = read_rgba(r)
            f['blurX'] = r.fixed(); f['blurY'] = r.fixed()
            f['angle'] = r.fixed(); f['distance'] = r.fixed()
            f['strength'] = r.fixed8()
            f['inner'] = r.ub(1); f['knockout'] = r.ub(1); f['composite'] = r.ub(1)
            f['passes'] = r.ub(5)
        elif fid == 1:                                # Blur
            f['blurX'] = r.fixed(); f['blurY'] = r.fixed()
            f['passes'] = r.ub(5); r.ub(3)
        elif fid == 2:                                # Glow
            f['color'] = read_rgba(r)
            f['blurX'] = r.fixed(); f['blurY'] = r.fixed()
            f['strength'] = r.fixed8()
            f['inner'] = r.ub(1); f['knockout'] = r.ub(1); f['composite'] = r.ub(1)
            f['passes'] = r.ub(5)
        elif fid == 3:                                # Bevel
            f['shadow'] = read_rgba(r); f['highlight'] = read_rgba(r)
            f['blurX'] = r.fixed(); f['blurY'] = r.fixed()
            f['angle'] = r.fixed(); f['distance'] = r.fixed()
            f['strength'] = r.fixed8()
            f['inner'] = r.ub(1); f['knockout'] = r.ub(1); f['composite'] = r.ub(1)
            f['onTop'] = r.ub(1); f['passes'] = r.ub(4)
        elif fid in (4, 7):                           # GradientGlow / GradientBevel
            n = r.u8()
            f['colors'] = [read_rgba(r) for _ in range(n)]
            f['ratios'] = [r.u8() for _ in range(n)]
            f['blurX'] = r.fixed(); f['blurY'] = r.fixed()
            f['angle'] = r.fixed(); f['distance'] = r.fixed()
            f['strength'] = r.fixed8()
            f['inner'] = r.ub(1); f['knockout'] = r.ub(1); f['composite'] = r.ub(1)
            f['onTop'] = r.ub(1); f['passes'] = r.ub(4)
        elif fid == 5:                                # Convolution
            mx, my = r.u8(), r.u8()
            f['matrixX'] = mx; f['matrixY'] = my
            f['divisor'] = r.float32(); f['bias'] = r.float32()
            f['matrix'] = [r.float32() for _ in range(mx * my)]
            f['default'] = read_rgba(r)
            r.ub(6); f['clamp'] = r.ub(1); f['preserveAlpha'] = r.ub(1)
        elif fid == 6:                                # ColorMatrix
            f['matrix'] = [r.float32() for _ in range(20)]
        else:
            raise ValueError('unknown filter id %d' % fid)
        r.align()
        out.append(f)
    return out


BLEND_NAMES = {0: 'normal', 1: 'normal', 2: 'layer', 3: 'multiply', 4: 'screen',
               5: 'lighten', 6: 'darken', 7: 'difference', 8: 'add', 9: 'subtract',
               10: 'invert', 11: 'alpha', 12: 'erase', 13: 'overlay', 14: 'hardlight'}


def read_soundinfo(r):
    r.align()
    r.ub(2)
    info = {'syncStop': r.ub(1), 'syncNoMultiple': r.ub(1)}
    has_env, has_loops, has_out, has_in = r.ub(1), r.ub(1), r.ub(1), r.ub(1)
    if has_in:
        info['inPoint'] = r.u32()
    if has_out:
        info['outPoint'] = r.u32()
    if has_loops:
        info['loops'] = r.u16()
    if has_env:
        info['envelope'] = [[r.u32(), r.u16(), r.u16()] for _ in range(r.u8())]
    return info
