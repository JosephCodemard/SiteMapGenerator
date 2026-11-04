import { intersection } from 'polygon-clipping';
import { openRing, pointInRings, signedArea } from './clip';
import { ClipperLib } from './buffer';
import { MeshBuilder, boxMesh, snap, solidWithFlatFloor, triangulate } from './geom';
import { buildingsMesh, type Mesh } from './mesh';
import { edgeDistance, orientedBox, roofedBuildingMesh, roofZ } from './roofs';
import type { Building, Raster, Ring, RoofFit, XY } from '../types';

/**
 * LOD2-fit: interpret the LIDAR roof as standard shapes, per part of the building.
 *
 * 1. Terraces: the footprint is cut along its long axis wherever the roofline steps (party walls).
 * 2. L/T/U shapes: each piece is bisected until it is nearly a rectangle.
 * 3. Every part gets the best of flat / shed / gable / hip by least squares against the DSM.
 *
 * Each part is its own closed solid (walls and floor come from its outline), so roofs join the walls
 * and the ground by construction.
 */

export interface RoofPart {
  name: string;
  mesh: Mesh;
  fit: RoofFit;
  /** Chimneys and parapets standing on this roof (own layer). */
  details: { name: string; mesh: Mesh }[];
}

/** Fitted roof height at a BNG point. */
export function roofHeightAt(f: RoofFit, e: number, n: number): number {
  if (f.type === 'flat') return f.eaves;
  const dx = e - f.centre[0], dy = n - f.centre[1];
  const u = dx * f.axis[0] + dy * f.axis[1], v = -dx * f.axis[1] + dy * f.axis[0];
  if (f.type === 'shed') { const [c, pa, pb] = f.plane!; return c + pa * u + pb * v; }
  return roofZ(f.type, f.eaves, f.ridge, f.a, f.b, u, v);
}

const CHIMNEY_MIN = 0.9, CHIMNEY_MAX = 4.5, CHIMNEY_MAX_CELLS = 9;

/**
 * Chimneys: small clusters of DSM cells standing 0.9-4.5 m above the fitted roof. Each becomes a box over the
 * cluster's extent, reaching up to its highest LIDAR return.
 */
export function chimneys(region: Poly, f: RoofFit, dsm: Raster, origin: XY, id: string): { name: string; mesh: Mesh }[] {
  const cells = new Map<number, { e: number; n: number; z: number; base: number }>();
  let inside = 0;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of region[0]) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / dsm.res)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / dsm.res));
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / dsm.res)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / dsm.res));
  for (let j = j0; j <= j1; j++) {
    const n = dsm.maxN - (j + 0.5) * dsm.res;
    for (let i = i0; i <= i1; i++) {
      const e = dsm.minE + (i + 0.5) * dsm.res;
      if (!pointInRings(e, n, region) || edgeDistance(e, n, region) < 0.3) continue;
      inside++;
      const z = dsm.data[j * dsm.width + i], base = roofHeightAt(f, e, n);
      if (z - base >= CHIMNEY_MIN && z - base <= CHIMNEY_MAX) cells.set(j * dsm.width + i, { e, n, z, base });
    }
  }
  // A roof that is mostly "above" its fit is a bad fit, not a forest of chimneys.
  if (!cells.size || cells.size > 0.25 * inside) return [];
  const out: { name: string; mesh: Mesh }[] = [];
  const seen = new Set<number>();
  for (const [key] of cells) {
    if (seen.has(key)) continue;
    const comp: number[] = [], stack = [key];
    seen.add(key);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      for (const d of [-1, 1, -dsm.width, dsm.width, -dsm.width - 1, -dsm.width + 1, dsm.width - 1, dsm.width + 1]) {
        if (cells.has(k + d) && !seen.has(k + d)) { seen.add(k + d); stack.push(k + d); }
      }
    }
    if (comp.length > CHIMNEY_MAX_CELLS) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = -Infinity, base = Infinity;
    for (const k of comp) {
      const c = cells.get(k)!;
      x0 = Math.min(x0, c.e); x1 = Math.max(x1, c.e); y0 = Math.min(y0, c.n); y1 = Math.max(y1, c.n);
      top = Math.max(top, c.z); base = Math.min(base, c.base);
    }
    const h = dsm.res / 2 - 0.1;
    out.push({
      name: `chimney_${id}_${out.length + 1}`,
      mesh: boxMesh(x0 - h - origin[0], y0 - h - origin[1], x1 + h - origin[0], y1 + h - origin[1], base - 0.3, top),
    });
  }
  return out;
}

/** Shrink a polygon by `d` metres (Clipper), returns the inner outlines. */
function inset(region: Poly, d: number): Ring[] {
  const ox = region[0][0][0], oy = region[0][0][1], S = 100;
  const co = new ClipperLib.ClipperOffset(2, 0.05 * S);
  region.forEach((r, k) => {
    const p = openRing(r).map(([e, n]) => ({ X: Math.round((e - ox) * S), Y: Math.round((n - oy) * S) }));
    if ((signedArea(openRing(r)) > 0) !== (k === 0)) p.reverse();
    co.AddPath(p, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  });
  const out: ClipperLib.Paths = [];
  co.Execute(out, -d * S);
  return out.map((p) => p.map((q) => [q.X / S + ox, q.Y / S + oy] as XY));
}

/**
 * Parapet: on a flat roof, if the rim (0.3-1.1 m inside the wall) stands 0.35-1.8 m above the roof interior,
 * add a 0.35 m thick wall around the edge up to the rim height.
 */
export function parapet(region: Poly, f: RoofFit, dsm: Raster, origin: XY, id: string): { name: string; mesh: Mesh } | null {
  if (f.type !== 'flat') return null;
  const rim: number[] = [], core: number[] = [];
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of region[0]) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / dsm.res)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / dsm.res));
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / dsm.res)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / dsm.res));
  for (let j = j0; j <= j1; j++) {
    const n = dsm.maxN - (j + 0.5) * dsm.res;
    for (let i = i0; i <= i1; i++) {
      const e = dsm.minE + (i + 0.5) * dsm.res;
      if (!pointInRings(e, n, region)) continue;
      const d = edgeDistance(e, n, region), z = dsm.data[j * dsm.width + i];
      if (d >= 0.3 && d <= 1.1) rim.push(z); else if (d > 1.6) core.push(z);
    }
  }
  if (rim.length < 8 || core.length < 10) return null;
  const h = median(rim) - median(core);
  if (h < 0.35 || h > 1.8) return null;
  const inner = inset(region, 0.35);
  if (!inner.length) return null;
  const top = f.eaves;
  const local = (r: Ring) => openRing(r).map(([e, n]) => [e - origin[0], n - origin[1]] as XY);
  const { pts, tris } = triangulate([local(region[0]), ...inner.map(local)]);
  const mb = new MeshBuilder();
  const ids = pts.map(([x, y]) => mb.vertex(snap(x), snap(y), top + h));
  for (let t = 0; t < tris.length; t += 3) mb.tri(ids[tris[t]], ids[tris[t + 1]], ids[tris[t + 2]]);
  if (!mb.idx.length) return null;
  return { name: `parapet_${id}`, mesh: solidWithFlatFloor(mb.build(), top - 0.05) };
}

export interface PartOptions {
  /** Roofline step (m) between neighbouring 1 m slices that marks a party wall. */
  stepThreshold: number;
  /** Largest RMS error (m) for which a pitched/shed roof is trusted. */
  maxRmse: number;
  /** Smallest part (m²). */
  minArea: number;
}

export const DEFAULT_PART_OPTIONS: PartOptions = { stepThreshold: 0.8, maxRmse: 1.0, minArea: 12 };

type Poly = Ring[]; // polygon-clipping style: closed rings, outer first
const closeRing = (r: Ring): Ring => { const o = openRing(r); return [...o, o[0]]; };
const areaOf = (p: Poly) => p.reduce((s, r, k) => s + (k ? -1 : 1) * Math.abs(signedArea(openRing(r))), 0);

function rect(c: XY, ax: XY, u0: number, u1: number, v0: number, v1: number): Ring {
  const pt = (u: number, v: number): XY => [c[0] + u * ax[0] - v * ax[1], c[1] + u * ax[1] + v * ax[0]];
  return closeRing([pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)]);
}

function clip(poly: Poly, mask: Ring): Poly[] {
  try { return intersection(poly, [mask]).map((p) => p.map((r) => r as Ring)); } catch { return []; }
}

/** Area-weighted rectangle fill of a set of polygons (1 = perfectly rectangular). */
function fill(polys: Poly[]): number {
  let a = 0, f = 0;
  for (const p of polys) {
    const area = areaOf(p);
    let box;
    try { box = orientedBox(p[0]); } catch { return 0; }
    a += area; f += Math.min(1, area / (4 * box.a * box.b || 1)) * area;
  }
  return a ? f / a : 0;
}

/** Bisect a region until each piece is close to a rectangle. */
function decompose(region: Poly, minArea: number, depth = 0): Poly[] {
  let box;
  try { box = orientedBox(region[0]); } catch { return [region]; }
  const area = areaOf(region);
  const current = Math.min(1, area / (4 * box.a * box.b || 1));
  if (current >= 0.82 || depth >= 3 || area < 2 * minArea) return [region];
  const { centre, axis, a, b } = box;
  const perp: XY = [-axis[1], axis[0]];
  let best: { score: number; parts: Poly[] } | null = null;
  const verts = region.flatMap((r) => openRing(r));
  for (const dir of [0, 1] as const) {
    const ax = dir === 0 ? axis : perp, half = dir === 0 ? a : b, other = dir === 0 ? b : a;
    const seen = new Set<number>();
    for (const [x, y] of verts) {
      const t = (x - centre[0]) * ax[0] + (y - centre[1]) * ax[1];
      const key = Math.round(t * 2);
      if (seen.has(key) || Math.abs(t) > half - 1.5) continue;
      seen.add(key);
      const left = clip(region, rect(centre, ax, -half - 1, t, -other - 1, other + 1));
      const right = clip(region, rect(centre, ax, t, half + 1, -other - 1, other + 1));
      const parts = [...left, ...right].filter((p) => areaOf(p) >= minArea);
      if (parts.length < 2) continue;
      const score = fill(parts);
      if (!best || score > best.score) best = { score, parts };
    }
  }
  if (!best || best.score < current + 0.05) return [region];
  return best.parts.flatMap((p) => decompose(p, minArea, depth + 1));
}

interface Sample { u: number; v: number; z: number }

function collect(region: Poly, dsm: Raster, box: ReturnType<typeof orientedBox>, inset: number): Sample[] {
  const outer = region[0];
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of outer) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / dsm.res)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / dsm.res));
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / dsm.res)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / dsm.res));
  const out: Sample[] = [];
  const [ux, uy] = box.axis;
  for (let j = j0; j <= j1; j++) {
    const n = dsm.maxN - (j + 0.5) * dsm.res;
    for (let i = i0; i <= i1; i++) {
      const e = dsm.minE + (i + 0.5) * dsm.res;
      if (!pointInRings(e, n, region) || edgeDistance(e, n, region) < inset) continue;
      const dx = e - box.centre[0], dy = n - box.centre[1];
      out.push({ u: dx * ux + dy * uy, v: -dx * uy + dy * ux, z: dsm.data[j * dsm.width + i] });
    }
  }
  return out;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Cut the footprint along its long axis at roofline steps. Returns the strips (or the whole footprint). */
function terraceStrips(b: Building, dsm: Raster, opt: PartOptions): Poly[] {
  const outer = b.rings;
  let box;
  try { box = orientedBox(b.rings[0]); } catch { return [outer]; }
  if (box.a < 8) return [outer];
  const samples = collect(outer, dsm, box, 0.75);
  const nb = Math.ceil(2 * box.a);
  if (nb < 6 || samples.length < 24) return [outer];
  const buckets: number[][] = Array.from({ length: nb }, () => []);
  for (const s of samples) buckets[Math.min(nb - 1, Math.max(0, Math.floor(s.u + box.a)))].push(s.z);
  const med = buckets.map((z) => (z.length >= 3 ? median(z) : NaN));
  // Fill gaps, then median-filter to ignore single noisy slices.
  for (let i = 0; i < nb; i++) if (Number.isNaN(med[i])) med[i] = med[i - 1] ?? med.find((v) => !Number.isNaN(v)) ?? 0;
  const sm = med.map((_, i) => median([med[Math.max(0, i - 1)], med[i], med[Math.min(nb - 1, i + 1)]]));
  const cuts: number[] = [];
  let start = 0;
  for (let i = 0; i < nb - 1; i++) {
    if (Math.abs(sm[i + 1] - sm[i]) > opt.stepThreshold && i + 1 - start >= 3 && nb - (i + 1) >= 3) {
      cuts.push(i + 1 - box.a);
      start = i + 1;
    }
  }
  if (!cuts.length) return [outer];
  const edges = [-box.a - 1, ...cuts, box.a + 1];
  const strips: Poly[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    strips.push(...clip(outer, rect(box.centre, box.axis, edges[k], edges[k + 1], -box.b - 1, box.b + 1)).filter((p) => areaOf(p) >= opt.minArea));
  }
  return strips.length ? strips : [outer];
}

/** Least squares z = c + a*u + b*v. */
function fitPlane(s: Sample[]): [number, number, number] | null {
  let n = 0, su = 0, sv = 0, sz = 0, suu = 0, suv = 0, svv = 0, suz = 0, svz = 0;
  for (const q of s) { n++; su += q.u; sv += q.v; sz += q.z; suu += q.u * q.u; suv += q.u * q.v; svv += q.v * q.v; suz += q.u * q.z; svz += q.v * q.z; }
  // Solve [n su sv; su suu suv; sv suv svv] [c a b]^T = [sz suz svz]^T by Cramer's rule.
  const M = [[n, su, sv], [su, suu, suv], [sv, suv, svv]];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-9) return null;
  const rhs = [sz, suz, svz];
  const sol = [0, 1, 2].map((c) => det(M.map((row, r) => row.map((v, k) => (k === c ? rhs[r] : v)))) / d);
  return [sol[0], sol[1], sol[2]];
}

/** Choose the best standard shape for one part. */
export function fitPart(region: Poly, dsm: Raster, ground: number, opt: PartOptions): RoofFit | null {
  let box;
  try { box = orientedBox(region[0]); } catch { return null; }
  const { a, b } = box;
  const samples = collect(region, dsm, box, 0.75);
  const n = samples.length;
  if (n < 8) return null;
  const zs = samples.map((q) => q.z).sort((p, q) => p - q);
  const mean = zs.reduce((s, v) => s + v, 0) / n;
  const flatErr = Math.sqrt(zs.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const top = zs[Math.round(0.7 * (n - 1))];
  const flat: RoofFit = { type: 'flat', eaves: top, ridge: top, ...box, rmse: flatErr };
  if (zs[n - 1] - zs[0] < 1.0) return flat;

  type Cand = { fit: RoofFit; rank: number };
  const cands: Cand[] = [];
  const rmse = (f: (q: Sample) => number) => Math.sqrt(samples.reduce((s, q) => s + (f(q) - q.z) ** 2, 0) / n);

  // Gable and hip: z = eaves + k * t, with t the distance up the slope; the ridge is t = hw. The ridge may run
  // along either side of the box (a terrace house usually has its ridge across the strip's long side).
  const frames: { box: typeof box; pts: Sample[] }[] = [
    { box, pts: samples },
    { box: { centre: box.centre, axis: [-box.axis[1], box.axis[0]] as XY, a: b, b: a }, pts: samples.map((q) => ({ u: q.v, v: -q.u, z: q.z })) },
  ];
  for (const { box: fb, pts } of frames) {
    const { a: la, b: hw } = fb;
    if (hw < 1.5 || hw > 12) continue;
    (['gable', 'hip'] as const).forEach((type, rank) => {
      if (type === 'hip' && la < hw) return;
      const tOf = (q: Sample) => (type === 'gable' ? hw - Math.abs(q.v) : Math.min(hw - Math.abs(q.v), la - Math.abs(q.u)));
      let st = 0, sz = 0, stt = 0, stz = 0;
      for (const q of pts) { const t = tOf(q); st += t; sz += q.z; stt += t * t; stz += t * q.z; }
      const den = n * stt - st * st;
      const k = den > 1e-9 ? (n * stz - st * sz) / den : 0;
      const eaves = (sz - k * st) / n, ridge = eaves + k * hw;
      const rise = ridge - eaves;
      if (rise < 1.2 || rise > Math.min(0.9 * hw, 9) || eaves < ground + 2) return;
      const slope = rise / hw;
      const err = Math.sqrt(pts.reduce((acc, q) => acc + (eaves + slope * Math.max(0, tOf(q)) - q.z) ** 2, 0) / n);
      if (err <= opt.maxRmse && err < 0.75 * flatErr) cands.push({ fit: { type, eaves, ridge, ...fb, rmse: err }, rank });
    });
  }
  // Shed: one tilted plane (a terrace on a slope, a lean-to, a mono-pitch).
  const plane = fitPlane(samples);
  if (plane) {
    const [c, pa, pb] = plane;
    const slope = Math.hypot(pa, pb);
    const deg = (Math.atan(slope) * 180) / Math.PI;
    const err = rmse((q) => c + pa * q.u + pb * q.v);
    if (deg >= 4 && deg <= 40 && err <= opt.maxRmse && err < 0.6 * flatErr) {
      // Eaves = low corner, ridge = high corner of the box.
      const lo = c - Math.abs(pa) * a - Math.abs(pb) * b, hi = c + Math.abs(pa) * a + Math.abs(pb) * b;
      cands.push({ fit: { type: 'shed', eaves: lo, ridge: hi, ...box, rmse: err, plane }, rank: 2 });
    }
  }
  if (!cands.length) return flat;
  // Lowest error wins; near-ties prefer the simpler shape (gable < hip < shed).
  cands.sort((p, q) => p.fit.rmse - q.fit.rmse);
  const best = cands[0];
  const tied = cands.filter((c) => c.fit.rmse <= best.fit.rmse * 1.1).sort((p, q) => p.rank - q.rank)[0];
  return tied.fit;
}

/** Closed solid for a mono-pitch roof over a part. */
function shedMesh(region: Poly, f: RoofFit, origin: XY, floorZ: number): Mesh | null {
  if (!f.plane) return null;
  const [c, pa, pb] = f.plane;
  const { centre, axis: [ux, uy] } = f;
  const local = region.map((r) => openRing(r).map(([e, n]) => [e - origin[0], n - origin[1]] as XY));
  const { pts, tris } = triangulate(local);
  const mb = new MeshBuilder();
  const ids = pts.map(([x, y]) => {
    const sx = snap(x), sy = snap(y);
    const dx = sx + origin[0] - centre[0], dy = sy + origin[1] - centre[1];
    return mb.vertex(sx, sy, c + pa * (dx * ux + dy * uy) + pb * (-dx * uy + dy * ux));
  });
  for (let t = 0; t < tris.length; t += 3) mb.tri(ids[tris[t]], ids[tris[t + 1]], ids[tris[t + 2]]);
  return mb.idx.length ? solidWithFlatFloor(mb.build(), floorZ) : null;
}

/** Lowest ground under a part, from the DTM. */
function groundUnder(region: Poly, dtm: Raster): number {
  let lo = Infinity;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of region[0]) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dtm.minE) / dtm.res)), i1 = Math.min(dtm.width - 1, Math.ceil((maxE - dtm.minE) / dtm.res));
  const j0 = Math.max(0, Math.floor((dtm.maxN - maxN) / dtm.res)), j1 = Math.min(dtm.height - 1, Math.ceil((dtm.maxN - minN) / dtm.res));
  for (let j = j0; j <= j1; j++) {
    const n = dtm.maxN - (j + 0.5) * dtm.res;
    for (let i = i0; i <= i1; i++) {
      if (pointInRings(dtm.minE + (i + 0.5) * dtm.res, n, region)) lo = Math.min(lo, dtm.data[j * dtm.width + i]);
    }
  }
  return Number.isFinite(lo) ? lo : dtm.data[Math.min(dtm.data.length - 1, Math.max(0, j0 * dtm.width + i0))];
}

/** Interpret one building's roof as a set of standard-shaped parts, or null if there is nothing to fit. */
export function fitRoofParts(b: Building, dsm: Raster, dtm: Raster, origin: XY, opt: PartOptions = DEFAULT_PART_OPTIONS, withDetails = false): RoofPart[] | null {
  if (b.rings[0].length < 3) return null;
  const regions = terraceStrips(b, dsm, opt).flatMap((strip) => decompose(strip.map(closeRing), opt.minArea));
  const parts: RoofPart[] = [];
  const base = `building_${b.id.replace(/[^\w#-]/g, '_')}`;
  let k = 0;
  for (const region of regions) {
    const ground = groundUnder(region, dtm);
    let fit = fitPart(region, dsm, ground, opt);
    if (!fit) {
      // Too few LIDAR samples (a tiny wing): keep it as a block at the building's height rather than leave a hole.
      let box;
      try { box = orientedBox(region[0]); } catch { continue; }
      fit = { type: 'flat', eaves: b.top, ridge: b.top, ...box, rmse: NaN };
    }
    const floorZ = ground - 0.5;
    const rings = region.map((r) => openRing(r));
    const pseudo: Building = { id: b.id, rings, tags: b.tags, ground, top: fit.ridge, source: b.source };
    let mesh: Mesh | null = null;
    if (fit.type === 'gable' || fit.type === 'hip') mesh = roofedBuildingMesh(pseudo, fit, origin, floorZ);
    else if (fit.type === 'shed') mesh = shedMesh(region, fit, origin, floorZ);
    if (!mesh) {
      // Flat (or a pitched fit that failed to build): a block at the fitted height.
      const top = Math.max(fit.type === 'flat' ? fit.eaves : fit.ridge, ground + 2.5);
      mesh = buildingsMesh([{ ...pseudo, top, ground: floorZ }], origin, 0);
      if (fit.type !== 'flat') fit.type = 'flat';
    }
    if (!mesh.indices.length) continue;
    k++;
    const partName = regions.length > 1 ? `${base}_${k}` : base;
    const details: RoofPart['details'] = [];
    if (withDetails) {
      const id = partName.replace(/^building_/, '');
      details.push(...chimneys(region, fit, dsm, origin, id));
      const par = parapet(region, fit, dsm, origin, id);
      if (par) details.push(par);
    }
    parts.push({ name: partName, mesh, fit, details });
  }
  return parts.length ? parts : null;
}
