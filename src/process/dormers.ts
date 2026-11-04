import { openRing, signedArea } from './clip';
import type { Mesh } from './mesh';
import { edgeDistance } from './roofs';
import { roofHeightAt } from './roofparts';
import type { Building, Ring, RoofFit, XY } from '../types';

/**
 * Dormer windows on steep roofs: the top floor of a Georgian terrace usually sits in the mansard, lit by dormers.
 * LIDAR at 1 m cannot resolve them, so they are PROCEDURAL (not surveyed): placed on the bay rhythm of every
 * outward-facing roof slope that is steep enough, as closed solids buried in the roof plus a window recess each.
 */
export interface DormerOptions {
  /** One dormer every `every` bays of `bay` metres. */
  bay: number;
  every: number;
  width: number;
  /** Visible height of the dormer front above the roof (m). */
  height: number;
  /** Steepest-slope test: the roof must rise at least this much over 1.7 m from the wall. */
  minRise: number;
}

export const DEFAULT_DORMERS: DormerOptions = { bay: 1.2, every: 3, width: 1.1, height: 1.5, minRise: 1.0 };

export interface DormerResult {
  solids: Mesh | null;
  windows: Mesh | null;
  list: { p: XY; width: number; procedural: boolean }[];
}

/** Closed prism: a (lateral, z) polygon extruded from the front plane back by `depth`. Lateral = d, backwards = -n. */
function prism(poly: [number, number][], front: XY, d: XY, n: XY, depth: number, origin: XY): { p: number[]; i: number[] } {
  const p: number[] = [];
  for (const back of [0, depth]) {
    for (const [lat, z] of poly) p.push(front[0] + d[0] * lat - n[0] * back - origin[0], front[1] + d[1] * lat - n[1] * back - origin[1], z);
  }
  const k = poly.length, i: number[] = [];
  for (let q = 1; q < k - 1; q++) { i.push(0, q, q + 1); i.push(k, k + q + 1, k + q); }
  for (let q = 0; q < k; q++) { const r = (q + 1) % k; i.push(q, k + q, k + r, q, k + r, r); }
  // Orient outwards by signed volume.
  let vol = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  if (vol < 0) for (let t = 0; t < i.length; t += 3) [i[t + 1], i[t + 2]] = [i[t + 2], i[t + 1]];
  return { p, i };
}

/** Place dormers on one roof part. `isShared(midpoint)` says whether a wall is a party wall or an internal join. */
export function placeDormers(region: Ring[], fit: RoofFit, ground: number, origin: XY, isShared: (m: XY) => boolean, opt: DormerOptions = DEFAULT_DORMERS): DormerResult {
  const empty: DormerResult = { solids: null, windows: null, list: [] };
  if (fit.type === 'flat' || fit.type === 'shed' || fit.type === 'surface') return empty;
  if (fit.eaves < ground + 3) return empty;
  let ring = openRing(region[0]);
  if (signedArea(ring) < 0) ring = [...ring].reverse();
  const sp: number[] = [], si: number[] = [], wp: number[] = [], wi: number[] = [];
  const list: DormerResult['list'] = [];
  const add = (t: { p: number[]; i: number[] }, p: number[], i: number[]) => { const base = p.length / 3; p.push(...t.p); i.push(...t.i.map((x) => x + base)); };
  const hw = fit.b;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], c = ring[(k + 1) % ring.length];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len < 4) continue;
    const d: XY = [(c[0] - a[0]) / len, (c[1] - a[1]) / len], n: XY = [d[1], -d[0]];
    const mid: XY = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    if (isShared(mid) || edgeDistance(mid[0], mid[1], region.slice(1)) < 0.5) continue;
    const at = (s: number, t: number): XY => [a[0] + d[0] * s - n[0] * t, a[1] + d[1] * s - n[1] * t];
    // The slope must fall towards this wall and be steep.
    if (roofHeightAt(fit, ...at(len / 2, 1.7)) - roofHeightAt(fit, ...at(len / 2, 0.3)) < opt.minRise * 1.0) continue;
    const spacing = opt.every * opt.bay;
    const count = Math.floor((len - 1.2) / spacing) + 1;
    if (count < 1) continue;
    const tf = fit.type === 'mansard' && fit.profile ? Math.min(0.7, 0.6 * fit.profile[1][0]) : 0.9;
    for (let j = 0; j < count; j++) {
      const s = len / 2 + (j - (count - 1) / 2) * spacing;
      if (s - opt.width / 2 < 0.6 || s + opt.width / 2 > len - 0.6) continue;
      const front = at(s, tf);
      const zf = roofHeightAt(fit, front[0], front[1]);
      const reach = Math.max(1, hw * 0.9 - tf);
      // How far back the dormer must run for the roof to rise above its top.
      const want = opt.height + 0.35;
      let D = 0;
      for (let t = 0.5; t <= reach; t += 0.25) { D = t; if (roofHeightAt(fit, ...at(s, tf + t)) >= zf + want) break; }
      const zRear = roofHeightAt(fit, ...at(s, tf + D));
      const vis = Math.min(opt.height, zRear - zf - 0.05);
      if (vis < 0.9) continue;
      const pk = Math.min(0.35, Math.max(0, zRear - zf - vis - 0.05));
      const z0 = zf - 0.5, w = opt.width / 2, zt = zf + vis;
      const poly: [number, number][] = pk > 0.05 ? [[-w, z0], [w, z0], [w, zt], [0, zt + pk], [-w, zt]] : [[-w, z0], [w, z0], [w, zt], [-w, zt]];
      add(prism(poly, front, d, n, D, origin), sp, si);
      // Window: a shallow box proud of the dormer face.
      const wz0 = zf + 0.2, wz1 = zt - 0.2;
      if (wz1 - wz0 >= 0.5) add(prism([[-w * 0.6, wz0], [w * 0.6, wz0], [w * 0.6, wz1], [-w * 0.6, wz1]], [front[0] + n[0] * 0.05, front[1] + n[1] * 0.05], d, n, 0.05, origin), wp, wi);
      list.push({ p: front, width: opt.width, procedural: true });
    }
  }
  const mk = (p: number[], i: number[]): Mesh | null => (p.length ? { positions: Float32Array.from(p), indices: Uint32Array.from(i) } : null);
  return { solids: mk(sp, si), windows: mk(wp, wi), list };
}

/** Test whether a wall midpoint lies on another building's outline (a party wall). */
export function partyWallTester(buildings: Building[]): (self: Building, m: XY) => boolean {
  const boxes = buildings.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of b.rings[0]) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  });
  return (self, m) => buildings.some((o, k) => o !== self && m[0] >= boxes[k][0] && m[0] <= boxes[k][2] && m[1] >= boxes[k][1] && m[1] <= boxes[k][3] && edgeDistance(m[0], m[1], o.rings) < 0.6);
}
