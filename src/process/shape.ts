import { intersection } from 'polygon-clipping';
import { openRing, pointInRings, signedArea } from './clip';
import type { BBox, Ring, XY } from '../types';

/**
 * Custom site shapes. A site is a BNG polygon (open ring, CCW) plus its bounding box; data is fetched for the
 * box and then clipped exactly to the polygon.
 */

export type ShapeKind = 'rect' | 'hexagon' | 'circle' | 'polygon';

export function bboxOf(ring: Ring): BBox {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of ring) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  return { minE: Math.floor(minE), minN: Math.floor(minN), maxE: Math.ceil(maxE), maxN: Math.ceil(maxN) };
}

/** Regular n-gon centred on (e, n) with circumradius r (metres), first vertex at `rotation` radians. */
export function regularPolygon(c: XY, r: number, sides: number, rotation = 0): Ring {
  return Array.from({ length: sides }, (_, i) => {
    const a = rotation + (2 * Math.PI * i) / sides;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as XY;
  });
}

export const hexagon = (c: XY, r: number): Ring => regularPolygon(c, r, 6, 0);
/** A circle as a 72-gon (error < 0.1 % of the radius). */
export const circle = (c: XY, r: number): Ring => regularPolygon(c, r, 72, 0);

export function rotatedRect(c: XY, w: number, h: number, angle: number): Ring {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as XY[]).map(([x, y]) => [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca] as XY);
}

/** Counter-clockwise open ring with duplicate closing/consecutive points removed. */
export function normaliseShape(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of openRing(ring)) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 0.01) out.push(p);
  }
  return signedArea(out) < 0 ? out.reverse() : out;
}

export const polygonArea = (ring: Ring) => Math.abs(signedArea(openRing(ring)));

/** A simple (non-self-intersecting) polygon check: no two non-adjacent edges cross. */
export function isSimple(ring: Ring): boolean {
  const r = openRing(ring), n = r.length;
  if (n < 3) return false;
  const cross = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const [a, b, c, d] = [r[i], r[(i + 1) % n], r[j], r[(j + 1) % n]];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
    }
  }
  return true;
}

/** Clip a polygon with holes (BNG rings) to the site shape; returns polygons with open rings. */
export function clipPolygonToShape(rings: Ring[], shape: Ring): Ring[][] {
  const close = (r: Ring): Ring => { const o = openRing(r); return [...o, o[0]]; };
  try {
    return intersection(rings.filter((r) => r.length >= 3).map(close), [close(shape)])
      .map((poly) => poly.map((r) => openRing(r as Ring)).filter((r) => r.length >= 3))
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

/** Clip a polyline to the shape: keeps the parts inside, split where it leaves and re-enters. */
export function clipPolylineToShape(line: Ring, shape: Ring): Ring[] {
  const poly = openRing(shape), n = poly.length;
  const parts: Ring[] = [];
  let cur: Ring = [];
  const flush = () => { if (cur.length > 1) parts.push(cur); cur = []; };
  for (let i = 0; i < line.length - 1; i++) {
    const [p, q] = [line[i], line[i + 1]];
    const ts = [0, 1];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    for (let k = 0; k < n; k++) {
      const a = poly[k], b = poly[(k + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
      const u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      if (ts[k + 1] - ts[k] < 1e-9) continue;
      const tm = (ts[k] + ts[k + 1]) / 2;
      const inside = pointInRings(p[0] + dx * tm, p[1] + dy * tm, [poly]);
      const a: XY = [p[0] + dx * ts[k], p[1] + dy * ts[k]], b: XY = [p[0] + dx * ts[k + 1], p[1] + dy * ts[k + 1]];
      if (inside) {
        const last = cur[cur.length - 1];
        if (!last || Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) { flush(); cur = [a]; }
        cur.push(b);
      } else flush();
    }
  }
  flush();
  return parts;
}

export const pointInShape = (p: XY, shape: Ring) => pointInRings(p[0], p[1], [openRing(shape)]);
