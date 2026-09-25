"""
Shapes: SWF shape records -> drawable paths.

Flash stores a shape as a stream of edges.  Every edge knows the fill on its left
(fillStyle0), the fill on its right (fillStyle1) and its line style, and a new style
table can be declared part-way through, which starts a new layer drawn on top of
everything before it.

To draw it on a canvas the edges have to be regrouped: for each fill, take the edges
with that fill on the right as they are and the ones with it on the left reversed, so
every edge of that fill runs the same way round, then join them end to start into
closed contours.  Lines are simpler -- they are stroked in the order they were drawn.
This is the same reconstruction FFDec's SVG export does, and the build compares
against it.

Output coordinates are pixels (twips / 20).
"""

from .reader import read_matrix, read_rgb, read_rgba


def _fill_style(r, ver):
    t = r.u8()
    if t == 0x00:
        return {'t': 'solid', 'c': read_rgba(r) if ver >= 3 else read_rgb(r)}
    if t in (0x10, 0x12, 0x13):
        m = read_matrix(r)
        r.align()
        spread = r.ub(2)
        interp = r.ub(2)
        n = r.ub(4)
        stops = []
        for _ in range(n):
            ratio = r.u8()
            stops.append([ratio, read_rgba(r) if ver >= 3 else read_rgb(r)])
        f = {'t': {0x10: 'linear', 0x12: 'radial', 0x13: 'focal'}[t],
             'm': _px_matrix(m), 'spread': ['pad', 'reflect', 'repeat', 'pad'][spread],
             'interp': ['rgb', 'linear-rgb', 'rgb', 'rgb'][interp], 'stops': stops}
        if t == 0x13:
            f['focal'] = r.fixed8()
        return f
    if t in (0x40, 0x41, 0x42, 0x43):
        bid = r.u16()
        m = read_matrix(r)
        # Bitmap matrices map bitmap pixels to shape twips, so all six terms scale by 1/20.
        return {'t': 'bitmap', 'id': bid,
                'm': [m[0] / 20.0, m[1] / 20.0, m[2] / 20.0, m[3] / 20.0, m[4] / 20.0, m[5] / 20.0],
                'repeat': t in (0x40, 0x42), 'smooth': t in (0x40, 0x41)}
    raise ValueError('unknown fill style type 0x%02x' % t)


def _px_matrix(m):
    """Gradient matrices map the +/-16384-twip gradient square into shape twips."""
    return [m[0], m[1], m[2], m[3], m[4] / 20.0, m[5] / 20.0]


def _fill_styles(r, ver):
    n = r.u8()
    if n == 0xFF and ver >= 2:
        n = r.u16()
    return [_fill_style(r, ver) for _ in range(n)]


def _line_styles(r, ver):
    n = r.u8()
    if n == 0xFF and ver >= 2:
        n = r.u16()
    out = []
    for _ in range(n):
        w = r.u16() / 20.0
        if ver < 4:
            out.append({'w': w, 'c': read_rgba(r) if ver >= 3 else read_rgb(r)})
            continue
        r.align()
        ls = {'w': w,
              'startCap': ['round', 'none', 'square'][r.ub(2)],
              'join': ['round', 'bevel', 'miter'][r.ub(2)]}
        has_fill = r.ub(1)
        ls['noHScale'] = r.ub(1)
        ls['noVScale'] = r.ub(1)
        ls['pixelHinting'] = r.ub(1)
        r.ub(5)
        ls['noClose'] = r.ub(1)
        ls['endCap'] = ['round', 'none', 'square'][r.ub(2)]
        if ls['join'] == 'miter':
            ls['miter'] = r.fixed8()
        if has_fill:
            ls['fill'] = _fill_style(r, ver)
            ls['c'] = ls['fill'].get('c', [0, 0, 0, 255])
        else:
            ls['c'] = read_rgba(r)
        out.append(ls)
    return out


def _records(r, ver, nfill, nline, fills, lines, groups):
    """Walk shape records; append (fills, lines, edges) groups to `groups`."""
    x = y = 0
    f0 = f1 = ln = 0
    edges = []
    groups.append((fills, lines, edges))
    while True:
        if r.ub(1) == 0:                         # style change / end
            new_styles = r.ub(1)
            ch_line = r.ub(1)
            ch_f1 = r.ub(1)
            ch_f0 = r.ub(1)
            move = r.ub(1)
            if not (new_styles or ch_line or ch_f1 or ch_f0 or move):
                break
            if move:
                n = r.ub(5)
                x = r.sb(n)
                y = r.sb(n)
            if ch_f0:
                f0 = r.ub(nfill)
            if ch_f1:
                f1 = r.ub(nfill)
            if ch_line:
                ln = r.ub(nline)
            if new_styles:
                fills = _fill_styles(r, ver)
                lines = _line_styles(r, ver)
                r.align()
                nfill = r.ub(4)
                nline = r.ub(4)
                edges = []
                groups.append((fills, lines, edges))
                # New styles implicitly reset the current selections unless the same
                # record also set them, which the flags above already handled.
            edges.append(('move', x, y, f0, f1, ln))
        else:
            straight = r.ub(1)
            n = r.ub(4) + 2
            if straight:
                if r.ub(1):
                    dx = r.sb(n)
                    dy = r.sb(n)
                elif r.ub(1):
                    dx = 0
                    dy = r.sb(n)
                else:
                    dx = r.sb(n)
                    dy = 0
                edges.append(('line', x, y, x + dx, y + dy, f0, f1, ln))
                x += dx
                y += dy
            else:
                cx = x + r.sb(n)
                cy = y + r.sb(n)
                ax = cx + r.sb(n)
                ay = cy + r.sb(n)
                edges.append(('curve', x, y, cx, cy, ax, ay, f0, f1, ln))
                x, y = ax, ay
    r.align()


def _edges(group_edges):
    """Normalise a group's records into (x0,y0, [cx,cy], x1,y1, f0, f1, ln) tuples."""
    out = []
    for e in group_edges:
        if e[0] == 'line':
            _, x0, y0, x1, y1, f0, f1, ln = e
            out.append((x0, y0, None, None, x1, y1, f0, f1, ln))
        elif e[0] == 'curve':
            _, x0, y0, cx, cy, x1, y1, f0, f1, ln = e
            out.append((x0, y0, cx, cy, x1, y1, f0, f1, ln))
    return out


def _chain(segs):
    """Join directed segments (x0,y0,cx,cy,x1,y1) into closed/open contours."""
    by_start = {}
    for i, s in enumerate(segs):
        by_start.setdefault((s[0], s[1]), []).append(i)
    used = [False] * len(segs)
    contours = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        cur = [segs[i]]
        start = (segs[i][0], segs[i][1])
        end = (segs[i][4], segs[i][5])
        while end != start:
            nxt = None
            for j in by_start.get(end, ()):
                if not used[j]:
                    nxt = j
                    break
            if nxt is None:
                break
            used[nxt] = True
            cur.append(segs[nxt])
            end = (segs[nxt][4], segs[nxt][5])
        contours.append(cur)
    return contours


def _cmds(contours, close):
    cmds = []
    for c in contours:
        cmds.append(['M', c[0][0] / 20.0, c[0][1] / 20.0])
        for s in c:
            if s[2] is None:
                cmds.append(['L', s[4] / 20.0, s[5] / 20.0])
            else:
                cmds.append(['Q', s[2] / 20.0, s[3] / 20.0, s[4] / 20.0, s[5] / 20.0])
        if close:
            cmds.append(['Z'])
    return cmds


def build_layers(groups):
    layers = []
    for fills, lines, raw in groups:
        edges = _edges(raw)
        if not edges:
            continue
        layer = {'fills': [], 'lines': []}
        for fi in range(1, len(fills) + 1):
            segs = []
            for (x0, y0, cx, cy, x1, y1, f0, f1, ln) in edges:
                if f1 == fi:
                    segs.append((x0, y0, cx, cy, x1, y1))
                if f0 == fi:
                    segs.append((x1, y1, cx, cy, x0, y0))
            if segs:
                layer['fills'].append({'style': fills[fi - 1], 'path': _cmds(_chain(segs), True)})
        for li in range(1, len(lines) + 1):
            segs = [(x0, y0, cx, cy, x1, y1) for (x0, y0, cx, cy, x1, y1, f0, f1, ln) in edges if ln == li]
            if segs:
                layer['lines'].append({'style': lines[li - 1], 'path': _cmds(_chain(segs), False)})
        layers.append(layer)
    return layers


def read_shape_with_style(r, ver):
    fills = _fill_styles(r, ver)
    lines = _line_styles(r, ver)
    r.align()
    nfill = r.ub(4)
    nline = r.ub(4)
    groups = []
    _records(r, ver, nfill, nline, fills, lines, groups)
    return {'layers': build_layers(groups)}


def read_shape(r):
    """A font glyph: no style tables, fill style 1 means 'ink'."""
    r.align()
    nfill = r.ub(4)
    nline = r.ub(4)
    groups = []
    _records(r, 1, nfill, nline, [{'t': 'solid', 'c': [0, 0, 0, 255]}], [], groups)
    layers = build_layers(groups)
    return layers[0]['fills'][0]['path'] if layers and layers[0]['fills'] else []


# ---- morph shapes ----------------------------------------------------------------------

def _morph_fill(r):
    t = r.u8()
    if t == 0x00:
        return {'t': 'solid', 'c0': read_rgba(r), 'c1': read_rgba(r)}
    if t in (0x10, 0x12, 0x13):
        m0 = _px_matrix(read_matrix(r))
        m1 = _px_matrix(read_matrix(r))
        n = r.u8() & 0x0F
        stops = []
        for _ in range(n):
            s0 = r.u8(); c0 = read_rgba(r); s1 = r.u8(); c1 = read_rgba(r)
            stops.append([s0, c0, s1, c1])
        f = {'t': {0x10: 'linear', 0x12: 'radial', 0x13: 'focal'}[t], 'm0': m0, 'm1': m1, 'stops': stops}
        if t == 0x13:
            f['focal0'] = r.fixed8(); f['focal1'] = r.fixed8()
        return f
    if t in (0x40, 0x41, 0x42, 0x43):
        bid = r.u16()
        m0 = read_matrix(r); m1 = read_matrix(r)
        return {'t': 'bitmap', 'id': bid, 'm0': [v / 20.0 for v in m0], 'm1': [v / 20.0 for v in m1],
                'repeat': t in (0x40, 0x42), 'smooth': t in (0x40, 0x41)}
    raise ValueError('unknown morph fill 0x%02x' % t)


def read_morph_shape(r, ver):
    from .reader import read_rect
    ch = {'type': 'morph', 'startBounds': read_rect(r), 'endBounds': read_rect(r)}
    if ver == 2:
        ch['startEdgeBounds'] = read_rect(r)
        ch['endEdgeBounds'] = read_rect(r)
        r.u8()
    offset = r.u32()
    end_edges_at = r.pos + offset
    n = r.u8()
    if n == 0xFF:
        n = r.u16()
    fills = [_morph_fill(r) for _ in range(n)]
    n = r.u8()
    if n == 0xFF:
        n = r.u16()
    lines = []
    for _ in range(n):
        if ver == 1:
            lines.append({'w0': r.u16() / 20.0, 'w1': r.u16() / 20.0, 'c0': read_rgba(r), 'c1': read_rgba(r)})
        else:
            w0 = r.u16() / 20.0; w1 = r.u16() / 20.0
            r.align()
            ls = {'w0': w0, 'w1': w1, 'startCap': ['round', 'none', 'square'][r.ub(2)],
                  'join': ['round', 'bevel', 'miter'][r.ub(2)]}
            has_fill = r.ub(1)
            r.ub(3); r.ub(5)
            ls['noClose'] = r.ub(1)
            ls['endCap'] = ['round', 'none', 'square'][r.ub(2)]
            if ls['join'] == 'miter':
                ls['miter'] = r.fixed8()
            if has_fill:
                ls['fill'] = _morph_fill(r)
            else:
                ls['c0'] = read_rgba(r); ls['c1'] = read_rgba(r)
            lines.append(ls)

    # Start and end edges share one topology: the n-th edge of each corresponds.  Keep
    # them as parallel edge lists so the runtime can blend then chain.
    def edge_list(rr):
        rr.align()
        nf = rr.ub(4)
        nl = rr.ub(4)
        groups = []
        _records(rr, 3, nf, nl, [], [], groups)
        return [e for g in groups for e in g[2]]

    start = edge_list(r)
    r.pos = end_edges_at
    r._bit = 0
    end = edge_list(r)
    ch['fills'] = fills
    ch['lines'] = lines
    ch['start'] = [list(e) for e in start]
    ch['end'] = [list(e) for e in end]
    return ch
