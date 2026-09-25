// Matrices and colour transforms, in Flash's own terms.
//
// A matrix is [a, b, c, d, tx, ty]:  x' = a*x + c*y + tx,  y' = b*x + d*y + ty.
// A colour transform is [rm, gm, bm, am, ra, ga, ba, aa] with the multipliers in 8.8
// fixed point (256 == 1.0) and the additions in 0..255 units -- the representation Flash
// Player keeps internally, which is why `_alpha` reads back quantised.

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export const CX_IDENTITY = Object.freeze([256, 256, 256, 256, 0, 0, 0, 0]);

export function mul(p, c) {
  // parent * child: apply child first, then parent.
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [1, 0, 0, 1, -m[4], -m[5]];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function boundsOf(m, b) {
  // Axis-aligned bounds of rect b = [x0, y0, x1, y1] after transform m.
  const p = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// ---- colour transforms ---------------------------------------------------------------

export function cxMul(p, c) {
  // Concatenation as Flash does it: the child's transform is applied first.
  if (!p) return c;
  if (!c) return p;
  return [
    (p[0] * c[0]) >> 8, (p[1] * c[1]) >> 8, (p[2] * c[2]) >> 8, (p[3] * c[3]) >> 8,
    ((p[0] * c[4]) >> 8) + p[4], ((p[1] * c[5]) >> 8) + p[5],
    ((p[2] * c[6]) >> 8) + p[6], ((p[3] * c[7]) >> 8) + p[7],
  ];
}

export function cxIsIdentity(c) {
  return !c || (c[0] === 256 && c[1] === 256 && c[2] === 256 && c[3] === 256 &&
    c[4] === 0 && c[5] === 0 && c[6] === 0 && c[7] === 0);
}

export function cxAlphaOnly(c) {
  return c[0] === 256 && c[1] === 256 && c[2] === 256 && c[4] === 0 && c[5] === 0 &&
    c[6] === 0 && c[7] === 0;
}

export function cxApplyRGBA(c, rgba) {
  // rgba is [r, g, b, a] in 0..255.
  if (!c) return rgba;
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  return [
    cl(((rgba[0] * c[0]) >> 8) + c[4]),
    cl(((rgba[1] * c[1]) >> 8) + c[5]),
    cl(((rgba[2] * c[2]) >> 8) + c[6]),
    cl(((rgba[3] * c[3]) >> 8) + c[7]),
  ];
}

export function cssColor(rgba) {
  return `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${(rgba[3] / 255).toFixed(4)})`;
}

export function cxKey(c) {
  return c ? c.join(',') : 'id';
}

// ---- twips ------------------------------------------------------------------------------

// Flash stores positions in twips; assigning _x = 10.03 stores 10.05 (rounded to the
// nearest twip) and reading it back gives 10.05.  Rounding here keeps script arithmetic
// that reads positions back in step with the original.
export function twip(v) {
  return Math.round(v * 20) / 20;
}
