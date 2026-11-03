import { contours as d3contours } from 'd3-contour';
import type { Raster, Ring, XY } from '../types';

export interface ContourLine {
  level: number;
  major: boolean;
  closed: boolean;
  coords: Ring;
}

export function contourLevels(min: number, max: number, interval: number): number[] {
  const out: number[] = [];
  for (let z = Math.ceil(min / interval) * interval; z <= max; z += interval) out.push(+z.toFixed(6));
  return out;
}

/**
 * Marching squares over cell centres. Produces polylines per level, joined
 * across cells; lines that reach the raster edge stay open.
 */
export function contourLines(r: Raster, interval: number, majorEvery: number, tolerance = 0): ContourLine[] {
  const { width: w, height: h, data: d } = r;
  const [lo, hi] = range(d);
  // A level exactly at the min/max only touches cells, it doesn't cross them.
  const levels = contourLevels(lo, hi, interval).filter((z) => z > lo && z < hi);
  // Segments per level, keyed by edge id. Edge ids: 2*(j*w+i) = horizontal edge
  // from (i,j) to (i+1,j); 2*(j*w+i)+1 = vertical edge from (i,j) to (i,j+1).
  const segs = new Map<number, [number, number][]>();
  levels.forEach((_, li) => segs.set(li, []));

  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const k = j * w + i;
      const a = d[k], b = d[k + 1], c = d[k + w + 1], e = d[k + w]; // TL TR BR BL
      const cmin = Math.min(a, b, c, e), cmax = Math.max(a, b, c, e);
      let li = lowerBound(levels, cmin);
      for (; li < levels.length && levels[li] <= cmax; li++) {
        const z = levels[li];
        const code = (a > z ? 8 : 0) | (b > z ? 4 : 0) | (c > z ? 2 : 0) | (e > z ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const top = 2 * k, bottom = 2 * (k + w), left = 2 * k + 1, right = 2 * (k + 1) + 1;
        const out = segs.get(li)!;
        const centreAbove = (a + b + c + e) / 4 > z;
        switch (code) {
          case 1: case 14: out.push([left, bottom]); break;
          case 2: case 13: out.push([bottom, right]); break;
          case 3: case 12: out.push([left, right]); break;
          case 4: case 11: out.push([top, right]); break;
          case 6: case 9: out.push([top, bottom]); break;
          case 7: case 8: out.push([left, top]); break;
          case 5: // TR & BL above (saddle)
            if (centreAbove) out.push([left, top], [bottom, right]);
            else out.push([left, bottom], [top, right]);
            break;
          case 10: // TL & BR above (saddle)
            if (centreAbove) out.push([left, bottom], [top, right]);
            else out.push([left, top], [bottom, right]);
            break;
        }
      }
    }
  }

  const point = (edge: number, z: number): XY => {
    const k = edge >> 1, i = k % w, j = (k - i) / w;
    const k2 = edge & 1 ? k + w : k + 1;
    const t = (z - d[k]) / (d[k2] - d[k]);
    const fi = edge & 1 ? i : i + t, fj = edge & 1 ? j + t : j;
    return [r.minE + (fi + 0.5) * r.res, r.maxN - (fj + 0.5) * r.res];
  };

  const lines: ContourLine[] = [];
  levels.forEach((z, li) => {
    const major = Math.abs(z / (interval * majorEvery) - Math.round(z / (interval * majorEvery))) < 1e-6;
    for (const chain of joinSegments(segs.get(li)!)) {
      let coords = chain.edges.map((ed) => point(ed, z));
      if (tolerance > 0) coords = simplify(coords, tolerance, chain.closed);
      if (coords.length >= 2) lines.push({ level: z, major, closed: chain.closed, coords });
    }
  });
  return lines;
}

function joinSegments(segs: [number, number][]): { edges: number[]; closed: boolean }[] {
  const adj = new Map<number, number[]>(); // edge -> segment indices
  segs.forEach(([p, q], s) => {
    (adj.get(p) ?? adj.set(p, []).get(p)!).push(s);
    (adj.get(q) ?? adj.set(q, []).get(q)!).push(s);
  });
  const used = new Uint8Array(segs.length);
  const next = (edge: number): number | undefined => adj.get(edge)?.find((s) => !used[s]);
  const walk = (start: number, chain: number[]) => {
    let edge = start;
    for (let s = next(edge); s !== undefined; s = next(edge)) {
      used[s] = 1;
      const [p, q] = segs[s];
      edge = p === edge ? q : p;
      chain.push(edge);
    }
  };
  const out: { edges: number[]; closed: boolean }[] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [p, q] = segs[s];
    const fwd = [p, q];
    walk(q, fwd);
    const closed = fwd[fwd.length - 1] === p && fwd.length > 2;
    if (closed) { out.push({ edges: fwd.slice(0, -1), closed }); continue; }
    const back: number[] = [];
    walk(p, back);
    out.push({ edges: [...back.reverse(), ...fwd], closed: false });
  }
  return out;
}

/** Filled regions >= level for each level (for laser-cut / stacked contour models). */
export function contourBands(r: Raster, levels: number[]): { level: number; polygons: Ring[][] }[] {
  // d3-contour treats values as pixel centres with the grid outside as -Infinity,
  // so regions are closed along the raster edge — exactly what a cut layer needs.
  const gen = d3contours().size([r.width, r.height]).smooth(true);
  return levels.map((level) => {
    const mp = gen.contour(Array.from(r.data), level);
    const polygons = mp.coordinates.map((poly) =>
      poly.map((ring) => ring.map(([x, y]) => [r.minE + x * r.res, r.maxN - y * r.res] as XY)),
    );
    return { level, polygons };
  });
}

/** Douglas-Peucker. */
export function simplify(pts: Ring, tol: number, closed = false): Ring {
  if (pts.length < 3) return pts;
  const src = closed ? [...pts, pts[0]] : pts;
  const keep = new Uint8Array(src.length);
  keep[0] = keep[src.length - 1] = 1;
  const stack: [number, number][] = [[0, src.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1, bestD = t2;
    for (let k = s + 1; k < e; k++) {
      const dd = segDist2(src[k], src[s], src[e]);
      if (dd > bestD) { bestD = dd; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  const out = src.filter((_, k) => keep[k]);
  if (closed) out.pop();
  return closed && out.length < 3 ? pts : out;
}

function segDist2(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

function range(d: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}
