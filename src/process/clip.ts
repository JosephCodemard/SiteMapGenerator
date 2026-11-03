import { intersection } from 'polygon-clipping';
import type { BBox, Ring, XY } from '../types';

/**
 * Exact intersection of a polygon (outer + holes) with a rectangle. Unlike
 * Sutherland-Hodgman this is correct for concave shapes and holes that cross
 * the boundary (they become notches), and it also repairs self-intersections.
 * Returns zero or more polygons with open rings.
 */
export function clipPolygonToBox(rings: Ring[], b: BBox): Ring[][] {
  const box: Ring = [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN], [b.minE, b.minN]];
  const closed = rings.filter((r) => r.length >= 3).map((r) => {
    const o = openRing(r);
    return [...o, o[0]];
  });
  if (!closed.length) return [];
  try {
    return intersection(closed, [box])
      .map((poly) => poly.map((r) => openRing(r as Ring)).filter((r) => r.length >= 3))
      .filter((poly) => poly.length > 0);
  } catch {
    // Badly broken input geometry: fall back to clipping the outer ring only.
    const outer = clipRing(rings[0], b);
    return outer.length >= 3 ? [[outer]] : [];
  }
}

/** Sutherland-Hodgman clip of a polygon ring to a rectangle. Returns an open ring. */
export function clipRing(ring: Ring, b: BBox): Ring {
  let pts = openRing(ring);
  const edges: [(p: XY) => boolean, (p: XY, q: XY) => XY][] = [
    [(p) => p[0] >= b.minE, (p, q) => lerpX(p, q, b.minE)],
    [(p) => p[0] <= b.maxE, (p, q) => lerpX(p, q, b.maxE)],
    [(p) => p[1] >= b.minN, (p, q) => lerpY(p, q, b.minN)],
    [(p) => p[1] <= b.maxN, (p, q) => lerpY(p, q, b.maxN)],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const next: Ring = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const pin = inside(p), qin = inside(q);
      if (pin) next.push(p);
      if (pin !== qin) next.push(cut(p, q));
    }
    pts = next;
  }
  return dedupe(pts);
}

/** Liang-Barsky clip of a polyline to a rectangle; may split into several parts. */
export function clipPolyline(line: Ring, b: BBox): Ring[] {
  const parts: Ring[] = [];
  let cur: Ring = [];
  for (let i = 0; i < line.length - 1; i++) {
    const seg = clipSegment(line[i], line[i + 1], b);
    if (!seg) {
      if (cur.length > 1) parts.push(cur);
      cur = [];
      continue;
    }
    const [a, c] = seg;
    const last = cur[cur.length - 1];
    if (!last || last[0] !== a[0] || last[1] !== a[1]) {
      if (cur.length > 1) parts.push(cur);
      cur = [a];
    }
    cur.push(c);
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

function clipSegment(p: XY, q: XY, b: BBox): [XY, XY] | null {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = 0, t1 = 1;
  const checks: [number, number][] = [
    [-dx, p[0] - b.minE], [dx, b.maxE - p[0]], [-dy, p[1] - b.minN], [dy, b.maxN - p[1]],
  ];
  for (const [pp, qq] of checks) {
    if (pp === 0) {
      if (qq < 0) return null;
    } else {
      const r = qq / pp;
      if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  const at = (t: number): XY => (t === 0 ? p : t === 1 ? q : [p[0] + t * dx, p[1] + t * dy]);
  return [at(t0), at(t1)];
}

const lerpX = (p: XY, q: XY, x: number): XY => [x, p[1] + ((x - p[0]) / (q[0] - p[0])) * (q[1] - p[1])];
const lerpY = (p: XY, q: XY, y: number): XY => [p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), y];

/** Drop a duplicated closing vertex. */
export function openRing(r: Ring): Ring {
  if (r.length > 1) {
    const a = r[0], z = r[r.length - 1];
    if (a[0] === z[0] && a[1] === z[1]) return r.slice(0, -1);
  }
  return r;
}

function dedupe(r: Ring): Ring {
  const out: Ring = [];
  for (const p of r) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 1e-6 || Math.abs(l[1] - p[1]) > 1e-6) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.abs(a[0] - z[0]) < 1e-6 && Math.abs(a[1] - z[1]) < 1e-6) out.pop();
  }
  return out;
}

export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

/** Even-odd point-in-polygon over all rings (outer + holes). */
export function pointInRings(x: number, y: number, rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
