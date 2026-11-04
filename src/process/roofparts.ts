import { difference, intersection } from 'polygon-clipping';
import { openRing, pointInRings, signedArea } from './clip';
import { ClipperLib } from './buffer';
import { MeshBuilder, boxMesh, snap, solidWithFlatFloor, triangulate } from './geom';
import { buildingsMesh, type Mesh } from './mesh';
import { edgeDistance, orientedBox, profileT, profileZ, rawRoofMesh, roofedBuildingMesh, roofZ } from './roofs';
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
  /** The part's outline (open rings) and the ground under it: dormers are placed from these. */
  region: Ring[];
  ground: number;
}

/** Fitted roof height at a BNG point. */
export function roofHeightAt(f: RoofFit, e: number, n: number): number {
  if (f.type === 'flat') return f.eaves;
  const dx = e - f.centre[0], dy = n - f.centre[1];
  const u = dx * f.axis[0] + dy * f.axis[1], v = -dx * f.axis[1] + dy * f.axis[0];
  if (f.type === 'shed') { const [c, pa, pb] = f.plane!; return c + pa * u + pb * v; }
  if (f.type === 'mansard' && f.profile) return profileZ(f.profile, profileT(f, u, v));
  if (f.type === 'surface') return f.eaves;
  return roofZ(f.type as 'gable' | 'hip', f.eaves, f.ridge, f.a, f.b, u, v);
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
  /** Detect mansard (profile) roofs: a steep lower slope under a shallow or flat top. */
  mansards: boolean;
  /** Keep roofs that no standard shape fits (churches, vaults, domes) as the smoothed LIDAR surface instead of a flat block. */
  surfaceFallback: boolean;
  /** Detect industrial roofs: repeated gables, sawtooth and barrel vaults (several spans across a big footprint). */
  industrial: boolean;
  /** Split a footprint into levels where the roof steps (a house with a lower extension). */
  levels: boolean;
  /** Vegetation (0-1 greenness, from user imagery): LIDAR cells over trees are ignored when fitting roofs. */
  vegetation?: Raster | null;
}

export const DEFAULT_PART_OPTIONS: PartOptions = { stepThreshold: 0.8, maxRmse: 1.0, minArea: 12, mansards: true, surfaceFallback: true, industrial: true, levels: true };

/** OSM `roof:shape` -> the fitted type it asks for. */
const ROOF_TAG: Record<string, RoofFit['type']> = {
  gabled: 'gable', gable: 'gable', saltbox: 'shed', hipped: 'hip', 'half-hipped': 'hip', pyramidal: 'hip', hip: 'hip',
  skillion: 'shed', 'lean_to': 'shed', flat: 'flat', mansard: 'mansard', gambrel: 'mansard',
  dome: 'surface', round: 'surface', onion: 'surface', cone: 'hip', 'cross_gabled': 'surface', 'quadruple_saltbox': 'surface',
};

export const CHURCH = /^(church|cathedral|chapel|monastery|temple|mosque|synagogue|presbytery)$/;
export const isChurch = (b: Pick<Building, 'tags'>) => CHURCH.test(b.tags.building ?? '') || b.tags.amenity === 'place_of_worship';

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

function collect(region: Poly, dsm: Raster, box: ReturnType<typeof orientedBox>, inset: number, veg?: Raster | null): Sample[] {
  const outer = region[0];
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of outer) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / dsm.res)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / dsm.res));
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / dsm.res)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / dsm.res));
  const out: Sample[] = [];
  let masked = 0;
  const [ux, uy] = box.axis;
  for (let j = j0; j <= j1; j++) {
    const n = dsm.maxN - (j + 0.5) * dsm.res;
    for (let i = i0; i <= i1; i++) {
      const e = dsm.minE + (i + 0.5) * dsm.res;
      if (!pointInRings(e, n, region) || edgeDistance(e, n, region) < inset) continue;
      if (veg) {
        const vi = Math.floor((e - veg.minE) / veg.res), vj = Math.floor((veg.maxN - n) / veg.res);
        if (vi >= 0 && vj >= 0 && vi < veg.width && vj < veg.height && veg.data[vj * veg.width + vi] > 0.5) { masked++; continue; }
      }
      const dx = e - box.centre[0], dy = n - box.centre[1];
      out.push({ u: dx * ux + dy * uy, v: -dx * uy + dy * ux, z: dsm.data[j * dsm.width + i] });
    }
  }
  // A roof that is mostly "green" is a green roof or a bad mask: don't throw it away.
  if (masked > out.length) return veg ? collect(region, dsm, box, inset, null) : out;
  return out;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Cut the footprint along its long axis at roofline steps. Returns the strips (or the whole footprint). */
function terraceStrips(b: Building, dsm: Raster, opt: PartOptions, outer: Poly = b.rings): Poly[] {
  let box;
  try { box = orientedBox(outer[0]); } catch { return [outer]; }
  if (box.a < 8) return [outer];
  const samples = collect(outer, dsm, box, 0.75, opt.vegetation);
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

/** Context for one part: what the OSM tags ask for and what kind of building it is. */
export interface FitContext {
  /** Requested shape (from `roof:shape`), if any. */
  want?: RoofFit['type'];
  church?: boolean;
}

interface Cand { fit: RoofFit; rank: number; ok: boolean; type: RoofFit['type'] }

/**
 * Mansard / gambrel search: a steep lower slope (60-75 degrees) up to a break at distance `tb` from the wall, then a
 * shallower slope (0 = flat top) to the top. Linear least squares for the break height and upper slope at each
 * (tb, steep slope) on a coarse grid; the best wins.
 */
function fitMansard(pts: Sample[], la: number, hw: number, hipped: boolean, ground: number, box: ReturnType<typeof orientedBox>): RoofFit | null {
  const n = pts.length;
  if (n < 24 || hw < 2.5 || hw > 12 || (hipped && la < hw)) return null;
  const t = pts.map((q) => (hipped ? Math.min(hw - Math.abs(q.v), la - Math.abs(q.u)) : hw - Math.abs(q.v)));
  let best: { err: number; tb: number; s1: number; s2: number; zb: number } | null = null;
  for (let tb = 0.8; tb <= Math.min(3.2, hw - 0.9); tb += 0.2) {
    let low = 0;
    for (const x of t) if (x < tb) low++;
    if (low < 8) continue;
    for (const s1 of [1.5, 2.0, 2.75, 3.7]) {
      // y = z - lower-slope contribution; model y = zb + s2 * max(0, t - tb)
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const ys: number[] = [], xs: number[] = [];
      for (let k = 0; k < n; k++) {
        const x = Math.max(0, t[k] - tb), y = pts[k].z - (t[k] < tb ? s1 * (t[k] - tb) : 0);
        xs.push(x); ys.push(y);
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const den = n * sxx - sx * sx;
      let s2 = den > 1e-9 ? (n * sxy - sx * sy) / den : 0;
      s2 = Math.min(0.8, Math.max(0, s2));
      if (s2 < 0.08) s2 = 0;
      const zb = (sy - s2 * sx) / n;
      let e2 = 0;
      for (let k = 0; k < n; k++) e2 += (zb + s2 * xs[k] - ys[k]) ** 2;
      const err = Math.sqrt(e2 / n);
      const eaves = zb - s1 * tb, ridge = zb + s2 * (hw - tb);
      if (s1 * tb < 1.5 || eaves < ground + 2 || ridge - eaves > 1.4 * hw + 1) continue;
      if (!best || err < best.err) best = { err, tb, s1, s2, zb };
    }
  }
  if (!best) return null;
  // Outline misalignment lowers the edge cells on ONE side only; a real mansard drops away on both long sides.
  // Compare each side's edge cells with where the upper slope would put them (extended down to the wall).
  const ext = [0, 0], ec = [0, 0];
  pts.forEach((q, k) => { if (t[k] < best!.tb) { const i = q.v > 0 ? 0 : 1; ext[i] += q.z - (best!.zb - best!.s2 * (best!.tb - t[k])); ec[i]++; } });
  if (ec[0] < 4 || ec[1] < 4 || ext[0] / ec[0] > -0.5 || ext[1] / ec[1] > -0.5) return null;
  const eaves = best.zb - best.s1 * best.tb, ridge = best.zb + best.s2 * (hw - best.tb);
  const profile: [number, number][] = [[0, eaves], [best.tb, best.zb], [hw, ridge]];
  return { type: 'mansard', eaves, ridge, ...box, a: la, b: hw, rmse: best.err, profile, hipped };
}

/** Choose the best standard shape for one part. */
export function fitPart(region: Poly, dsm: Raster, ground: number, opt: PartOptions, ctx: FitContext = {}): RoofFit | null {
  let box;
  try { box = orientedBox(region[0]); } catch { return null; }
  const { a, b } = box;
  const samples = collect(region, dsm, box, 0.75, opt.vegetation);
  const n = samples.length;
  if (n < 8) return null;
  const zs = samples.map((q) => q.z).sort((p, q) => p - q);
  const mean = zs.reduce((s, v) => s + v, 0) / n;
  const flatErr = Math.sqrt(zs.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const top = zs[Math.round(0.7 * (n - 1))];
  const flat: RoofFit = { type: 'flat', eaves: top, ridge: top, ...box, rmse: flatErr };
  if (ctx.want === 'flat') return { ...flat, hint: 'roof:shape' };
  const relief = zs[Math.round(0.95 * (n - 1))] - zs[Math.round(0.05 * (n - 1))];
  // OSM can ask for a shape the LIDAR only weakly supports: relax the acceptance tests for that shape.
  const lenient = (type: RoofFit['type']) => ctx.want === type;
  const maxRmse = opt.maxRmse * (ctx.church ? 1.4 : 1);
  if (zs[n - 1] - zs[0] < 1.0 && !ctx.want) return flat;

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
      // A pyramid on a small square tower (a spire) may rise much more steeply than a house roof.
      const spire = type === 'hip' && hw <= 5.5 && la <= 1.7 * hw;
      const riseCap = spire ? Math.min(5 * hw, 35) : Math.min(0.9 * hw, 9);
      const rises = rise >= 1.2 && rise <= riseCap && eaves >= ground + 2;
      if (!rises && !(lenient(type) && rise >= 0.6 && rise <= riseCap * 1.3)) return;
      const slope = rise / hw;
      const err = Math.sqrt(pts.reduce((acc, q) => acc + (eaves + slope * Math.max(0, tOf(q)) - q.z) ** 2, 0) / n);
      const ok = err <= maxRmse && err < 0.75 * flatErr;
      if (ok || (lenient(type) && err <= 1.6 * maxRmse)) cands.push({ fit: { type, eaves, ridge, ...fb, rmse: err }, rank, ok, type });
    });
  }
  // Shed: one tilted plane (a terrace on a slope, a lean-to, a mono-pitch).
  const plane = fitPlane(samples);
  if (plane) {
    const [c, pa, pb] = plane;
    const slope = Math.hypot(pa, pb);
    const deg = (Math.atan(slope) * 180) / Math.PI;
    const err = rmse((q) => c + pa * q.u + pb * q.v);
    const ok = deg >= 4 && deg <= 40 && err <= maxRmse && err < 0.6 * flatErr;
    if (ok || (lenient('shed') && deg >= 2 && deg <= 50 && err <= 1.6 * maxRmse)) {
      // Eaves = low corner, ridge = high corner of the box.
      const lo = c - Math.abs(pa) * a - Math.abs(pb) * b, hi = c + Math.abs(pa) * a + Math.abs(pb) * b;
      cands.push({ fit: { type: 'shed', eaves: lo, ridge: hi, ...box, rmse: err, plane }, rank: 2, ok, type: 'shed' });
    }
  }
  // Barrel vault (semi-circular or segmental): z = eaves + rise * arc(t), a two-parameter linear fit per frame.
  if (opt.mansards && (ctx.want === undefined || ctx.want === 'mansard')) {
    for (const { box: fb, pts } of frames) {
      const { b: hw } = fb;
      if (hw < 2.5 || hw > 16) continue;
      const g = (q: Sample) => { const x = Math.min(1, Math.max(0, (hw - Math.abs(q.v)) / hw)); return Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x))); };
      let sg = 0, sz = 0, sgg = 0, sgz = 0;
      for (const q of pts) { const v = g(q); sg += v; sz += q.z; sgg += v * v; sgz += v * q.z; }
      const den = n * sgg - sg * sg;
      if (den < 1e-9) continue;
      const rise = (n * sgz - sg * sz) / den, eaves = (sz - rise * sg) / n;
      if (rise < 1.0 || rise > 1.1 * hw || eaves < ground + 2) continue;
      const err = Math.sqrt(pts.reduce((acc, q) => acc + (eaves + rise * g(q) - q.z) ** 2, 0) / n);
      const best = Math.min(flatErr * 0.75, ...cands.filter((c) => c.ok).map((c) => c.fit.rmse));
      if (err > maxRmse || err > 0.7 * best || best - err < 0.15) continue;
      cands.push({ fit: { type: 'mansard', kind: 'barrel', eaves, ridge: eaves + rise, ...fb, rmse: err, profile: arcProfile(eaves, rise, hw), hipped: false }, rank: 3, ok: true, type: 'mansard' });
    }
  }
  // Mansard: needs samples close to the wall, where the steep slope shows.
  if (opt.mansards && (ctx.want === undefined || ctx.want === 'mansard')) {
    const near = collect(region, dsm, box, 0.5, opt.vegetation);
    // Judge the plain shapes on the same near-wall samples, where a steep lower slope would show.
    const onNear = (f: RoofFit) => Math.sqrt(near.reduce((acc, q) => {
      const e = box.centre[0] + q.u * box.axis[0] - q.v * box.axis[1], nn = box.centre[1] + q.u * box.axis[1] + q.v * box.axis[0];
      return acc + (roofHeightAt(f, e, nn) - q.z) ** 2;
    }, 0) / Math.max(1, near.length));
    const nm = near.reduce((acc, q) => acc + q.z, 0) / Math.max(1, near.length);
    const flatNear = Math.sqrt(near.reduce((acc, q) => acc + (q.z - nm) ** 2, 0) / Math.max(1, near.length));
    const simple = Math.min(flatNear, ...cands.filter((c) => c.ok).map((c) => onNear(c.fit)));
    for (const fb of frames.map((f) => f.box)) {
      const pts = fb.axis === box.axis ? near : near.map((q) => ({ u: q.v, v: -q.u, z: q.z }));
      for (const hipped of [false, true]) {
        const m = fitMansard(pts, fb.a, fb.b, hipped, ground, fb);
        if (!m) continue;
        // Five parameters: only accept when clearly better than a plain pitched roof (or when OSM says mansard).
        const ok = m.rmse <= maxRmse && m.rmse < 0.8 * simple && simple - m.rmse >= 0.25;
        if (ok || (lenient('mansard') && m.rmse <= 1.6 * maxRmse)) cands.push({ fit: m, rank: 3, ok, type: 'mansard' });
      }
    }
  }
  const usable = ctx.want ? cands.filter((c) => c.type === ctx.want) : cands.filter((c) => c.ok);
  if (!usable.length) {
    if (ctx.want === 'surface' || (opt.surfaceFallback && n >= (ctx.church ? 40 : 70) && relief >= (ctx.church ? 2.5 : 4.5) && flatErr >= (ctx.church ? 1.0 : 1.7))) {
      // Nothing standard fits (nave vault, dome, complex pitched cluster): keep the LIDAR surface rather than a flat top.
      return { type: 'surface', eaves: zs[Math.round(0.05 * (n - 1))], ridge: zs[Math.round(0.95 * (n - 1))], ...box, rmse: flatErr, hint: ctx.want ? 'roof:shape' : undefined };
    }
    // The tag asked for something LIDAR does not support: fall back to whatever fits on its own merits.
    if (ctx.want) return fitPart(region, dsm, ground, opt, { church: ctx.church });
    return flat;
  }
  // Lowest error wins; near-ties prefer the simpler shape (gable < hip < shed < mansard).
  // A mansard that beat the plain shapes on the near-wall samples wins outright (their errors are not comparable).
  const man = usable.filter((c) => c.type === 'mansard' && !c.fit.kind).sort((p, q) => p.fit.rmse - q.fit.rmse)[0];
  if (man) return ctx.want ? { ...man.fit, hint: 'roof:shape' } : man.fit;
  usable.sort((p, q) => p.fit.rmse - q.fit.rmse);
  const best = usable[0];
  const tied = usable.filter((c) => c.fit.rmse <= best.fit.rmse * 1.1).sort((p, q) => p.rank - q.rank)[0];
  return ctx.want ? { ...tied.fit, hint: 'roof:shape' } : tied.fit;
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

/** 3x3 median of a DSM: removes single-cell spikes before a complex roof is meshed from it directly. */
const smoothCache = new WeakMap<Raster, Raster>();
function smoothedDsm(dsm: Raster): Raster {
  let s = smoothCache.get(dsm);
  if (s) return s;
  const out = new Float32Array(dsm.data.length);
  const w = dsm.width, h = dsm.height, win = new Array<number>(9);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = Math.min(w - 1, Math.max(0, i + di)), y = Math.min(h - 1, Math.max(0, j + dj));
        win[c++] = dsm.data[y * w + x];
      }
      win.sort((p, q) => p - q);
      out[j * w + i] = win[4];
    }
  }
  s = { ...dsm, data: out };
  smoothCache.set(dsm, s);
  return s;
}

/** Quarter-ellipse profile of a barrel vault: eaves at t = 0, crown at t = hw (8 segments). */
export function arcProfile(eaves: number, rise: number, hw: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 8; k++) { const th = (k / 8) * (Math.PI / 2); out.push([hw * (1 - Math.cos(th)), eaves + rise * Math.sin(th)]); }
  return out;
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/**
 * Industrial roofs: the same section repeated across a big footprint. Searches a period (4-15 m) along each axis,
 * averages the LIDAR over one period, and accepts it when the periodic profile explains the roof far better than a
 * flat top. The profile decides the kind:
 * - peak mid-period, triangular -> a row of gables (multi-span / ridge-and-furrow);
 * - peak mid-period, rounded    -> a row of barrel vaults;
 * - peak at the end of the period -> sawtooth (a long slope then a vertical glazed face).
 * Each period becomes its own closed part (footprint clipped to the strip), so partial end bays stay correct.
 */
export function fitPeriodic(region: Poly, dsm: Raster, opt: PartOptions): { poly: Poly; fit: RoofFit }[] | null {
  let box;
  try { box = orientedBox(region[0]); } catch { return null; }
  if (areaOf(region) < 120) return null;
  const samples = collect(region, dsm, box, 0.75, opt.vegetation);
  const n = samples.length;
  if (n < 80) return null;
  const mean = samples.reduce((acc, q) => acc + q.z, 0) / n;
  const flatErr = Math.sqrt(samples.reduce((acc, q) => acc + (q.z - mean) ** 2, 0) / n);
  if (flatErr < 0.45) return null;
  let best: { axis: 'u' | 'v'; P: number; err: number; prof: number[]; W: number; bins: number } | null = null;
  for (const axis of ['u', 'v'] as const) {
    const W = 2 * (axis === 'u' ? box.a : box.b);
    const w = (q: Sample) => (axis === 'u' ? q.u : q.v) + W / 2; // 0..W
    for (let P = 4; P <= 15 && P * 2 <= W + 0.5; P += 0.5) {
      // Bin by phase (about one bin per metre: the LIDAR is 1 m); the profile is the mean per bin.
      const BINS = Math.max(4, Math.min(16, Math.floor(P)));
      const sum = new Array(BINS).fill(0), cnt = new Array(BINS).fill(0);
      const bin = samples.map((q) => Math.min(BINS - 1, Math.floor((mod(w(q), P) / P) * BINS)));
      samples.forEach((q, i) => { sum[bin[i]] += q.z; cnt[bin[i]]++; });
      if (cnt.some((c) => c < 4)) continue;
      const prof = sum.map((v, i) => v / cnt[i]);
      let e2 = 0;
      samples.forEach((q, i) => { e2 += (q.z - prof[bin[i]]) ** 2; });
      const err = Math.sqrt(e2 / n);
      const amp = Math.max(...prof) - Math.min(...prof);
      if (amp < 1.2 || amp > 0.9 * P || err > 0.45 * flatErr) continue;
      // Prefer the shortest period that explains the roof about as well as any (2P always fits if P does).
      if (!best || err < best.err * 0.92) best = { axis, P, err, prof, W, bins: BINS };
    }
  }
  if (!best) return null;
  const { axis, P, prof, W, bins: BINS } = best;
  const kv = prof.indexOf(Math.min(...prof)), kp = prof.indexOf(Math.max(...prof));
  const rising = mod(kp - kv, BINS) / BINS; // fraction of the period from valley to crest
  const symmetric = rising > 0.3 && rising < 0.7;
  // Where a cell starts (w from the box centre): at the valley for a rising sawtooth, at the crest for a falling one,
  // half a period before the crest for a symmetric roof (valleys sit between spans). Refined below.
  const startBin0 = symmetric ? kp + 0.5 - BINS / 2 : rising >= 0.7 ? kv : kp;
  const wOf = (q: Sample) => (axis === 'u' ? q.u : q.v) + W / 2;
  const SHAPES = {
    tri: (x: number) => 1 - Math.abs(2 * x - 1),
    arc: (x: number) => Math.sqrt(Math.max(0, 1 - (1 - 2 * x) ** 2)),
    up: (x: number) => x,
    down: (x: number) => 1 - x,
  };
  /** z = z0 + A * shape(phase) by least squares: the exact crest height, which bin means undersample. */
  const regress = (shape: (x: number) => number, startBin: number) => {
    const cs = (startBin / BINS) * P;
    let sg = 0, sz = 0, sgg = 0, sgz = 0;
    for (const q of samples) { const g = shape(mod(wOf(q) - cs, P) / P); sg += g; sz += q.z; sgg += g * g; sgz += g * q.z; }
    const den = n * sgg - sg * sg;
    const A = den > 1e-9 ? (n * sgz - sg * sz) / den : 0, z0 = (sz - A * sg) / n;
    let e2 = 0;
    for (const q of samples) e2 += (z0 + A * shape(mod(wOf(q) - cs, P) / P) - q.z) ** 2;
    return { z0, A, err: Math.sqrt(e2 / n), startBin };
  };
  // The crest bin is only good to about a bin: scan the phase a little either way.
  const scan = (shape: (x: number) => number) => {
    let bestR = regress(shape, startBin0);
    for (let d = -1.5; d <= 1.5; d += 0.25) { const r = regress(shape, startBin0 + d); if (r.err < bestR.err) bestR = r; }
    return bestR;
  };
  const tri = symmetric ? scan(SHAPES.tri) : null, arc = symmetric ? scan(SHAPES.arc) : null;
  const saw = symmetric ? null : scan(rising >= 0.7 ? SHAPES.up : SHAPES.down);
  const round = !!(tri && arc && arc.err < 0.7 * tri.err);
  const chosen = symmetric ? (round ? arc! : tri!) : saw!;
  const cellStart = (chosen.startBin / BINS) * P - W / 2;
  const zv = chosen.z0, A = Math.abs(chosen.A);
  if (A < 1.0 || chosen.err > 0.5 * flatErr) return null;
  const cells: number[] = [];
  for (let c = cellStart - Math.ceil(W / P + 1) * P; c < W / 2 + P; c += P) cells.push(c);
  // Boundaries inside the footprint; a sliver at either end joins its neighbour.
  const bounds = cells.filter((c) => c > -W / 2 + 0.3 * P && c < W / 2 - 0.3 * P);
  const strips: { w0: number; w1: number; cell: number }[] = [];
  const edges = [-W / 2 - 2, ...bounds, W / 2 + 2];
  for (let k = 0; k + 1 < edges.length; k++) strips.push({ w0: edges[k], w1: edges[k + 1], cell: k === 0 ? (bounds[0] ?? W / 2) - P : edges[k] });
  const [ax, ay] = box.axis;
  const pt = (u: number, v: number): XY => [box.centre[0] + u * ax - v * ay, box.centre[1] + u * ay + v * ax];
  const out: { poly: Poly; fit: RoofFit }[] = [];
  for (const s of strips) {
    const rectPoly: Ring = axis === 'u'
      ? closeRing([pt(s.w0, -box.b - 2), pt(s.w1, -box.b - 2), pt(s.w1, box.b + 2), pt(s.w0, box.b + 2)])
      : closeRing([pt(-box.a - 2, s.w0), pt(box.a + 2, s.w0), pt(box.a + 2, s.w1), pt(-box.a - 2, s.w1)]);
    for (const piece of clip(region, rectPoly).filter((p) => areaOf(p) >= 3)) {
      const mid = s.cell + P / 2;
      let fit: RoofFit;
      if (symmetric) {
        // Nominal full cell, so a partial end bay still has its ridge in the right place.
        const centre = axis === 'u' ? pt(mid, 0) : pt(0, mid);
        const ridgeAxis: XY = axis === 'u' ? [-ay, ax] : [ax, ay];
        const half = (axis === 'u' ? box.b : box.a) + 2;
        fit = { type: 'gable', eaves: zv, ridge: zv + A, centre, axis: ridgeAxis, a: half, b: P / 2, rmse: chosen.err, kind: 'multi-gable' };
        if (round) fit = { ...fit, type: 'mansard', kind: 'barrel', profile: arcProfile(zv, A, P / 2), hipped: false };
      } else {
        // Sawtooth: one plane per period along w (up or down the slope), steps between strips are the glazed faces.
        const slope = (rising >= 0.7 ? 1 : -1) * (A / P);
        const w0cell = s.cell;
        const zAtCell = rising >= 0.7 ? zv : zv + A;
        const gu = axis === 'u' ? slope : 0, gv = axis === 'v' ? slope : 0;
        const c = zAtCell - slope * w0cell;
        fit = { type: 'shed', eaves: zv, ridge: zv + A, ...box, rmse: chosen.err, plane: [c, gu, gv], kind: 'sawtooth' };
      }
      out.push({ poly: piece, fit });
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * Multi-level roofs (a house with a lower extension, a tower rising from a nave): cut the region across a roofline
 * step and keep the cut when the two pieces fit far better than the whole. The step test is cheap (median profile
 * along each axis); the decision is made by actually fitting both pieces.
 */
function splitLevels(region: Poly, dsm: Raster, ground: number, opt: PartOptions, depth = 0): Poly[] {
  if (depth >= 2 || areaOf(region) < 2.5 * opt.minArea) return [region];
  let box;
  try { box = orientedBox(region[0]); } catch { return [region]; }
  const whole = fitPart(region, dsm, ground, opt, {});
  if (!whole || !Number.isFinite(whole.rmse) || whole.rmse < 0.55) return [region];
  const samples = collect(region, dsm, box, 0.75, opt.vegetation);
  if (samples.length < 40) return [region];
  type Cut = { axis: 'u' | 'v'; t: number; step: number };
  const cuts: Cut[] = [];
  for (const axis of ['u', 'v'] as const) {
    const half = axis === 'u' ? box.a : box.b;
    const nb = Math.ceil(2 * half);
    if (nb < 8) continue;
    const buckets: number[][] = Array.from({ length: nb }, () => []);
    for (const q of samples) buckets[Math.min(nb - 1, Math.max(0, Math.floor((axis === 'u' ? q.u : q.v) + half)))].push(q.z);
    const med = buckets.map((z) => (z.length >= 3 ? median(z) : NaN));
    for (let i = 0; i < nb; i++) if (Number.isNaN(med[i])) med[i] = med[i - 1] ?? med.find((v) => !Number.isNaN(v)) ?? 0;
    for (let i = 3; i < nb - 3; i++) {
      // Level change across i: compare the 2 slices either side (damps single noisy slices).
      const step = Math.abs((med[i + 1] + med[i + 2]) / 2 - (med[i - 1] + med[i - 2]) / 2);
      if (step >= 1.2) cuts.push({ axis, t: i - half, step });
    }
  }
  cuts.sort((p, q) => q.step - p.step);
  let bestPieces: Poly[] | null = null, bestErr = whole.rmse * 0.65;
  const tried: Cut[] = [];
  for (const c of cuts) {
    if (tried.length >= 4) break;
    if (tried.some((d) => d.axis === c.axis && Math.abs(d.t - c.t) < 2)) continue;
    tried.push(c);
    const { centre, axis: ax, a, b } = box;
    const perp: XY = [-ax[1], ax[0]];
    const dir = c.axis === 'u' ? ax : perp;
    const rectFor = (lo: number, hi: number) => (c.axis === 'u' ? rect(centre, ax, lo, hi, -b - 1, b + 1) : rect(centre, ax, -a - 1, a + 1, lo, hi));
    void dir;
    const L = c.axis === 'u' ? a : b;
    const pieces = [...clip(region, rectFor(-L - 1, c.t)), ...clip(region, rectFor(c.t, L + 1))].filter((p) => areaOf(p) >= opt.minArea);
    if (pieces.length < 2) continue;
    let w2 = 0, tot = 0;
    for (const p of pieces) {
      const f = fitPart(p, dsm, ground, opt, {});
      if (!f || !Number.isFinite(f.rmse)) { w2 = Infinity; break; }
      const ar = areaOf(p);
      w2 += ar * f.rmse * f.rmse; tot += ar;
    }
    const err = Math.sqrt(w2 / tot);
    if (err < bestErr) { bestErr = err; bestPieces = pieces; }
  }
  return bestPieces ? bestPieces.flatMap((p) => splitLevels(p, dsm, ground, opt, depth + 1)) : [region];
}

/** A region of a footprint together with what OSM says about it. */
interface Region { poly: Poly; want?: RoofFit['type']; minHeight: number; tags: Record<string, string>; /** Already fitted (industrial strips). */ fit?: RoofFit }

const wantOf = (tags: Record<string, string>): RoofFit['type'] | undefined => ROOF_TAG[(tags['roof:shape'] ?? '').toLowerCase()];

/** Regions to fit: `building:part` volumes when OSM has them, otherwise the footprint split into terrace strips / rectangles. */
function regionsOf(b: Building, dsm: Raster, opt: PartOptions, groundOf?: (r: Poly) => number): Region[] {
  const parts = !!b.parts?.length;
  const foot: Poly = b.rings.map(closeRing);
  const split = (poly: Poly, tags: Record<string, string>, strips: boolean): Region[] => {
    const want = wantOf(tags);
    const minHeight = parseFloat(tags.min_height ?? '') || 0;
    // Industrial roofs first: a sawtooth would otherwise be cut into 'terrace' strips at every glazed step.
    if (opt.industrial && !want) {
      const periodic = fitPeriodic(poly.map(closeRing), dsm, opt);
      if (periodic) return periodic.map((q) => ({ poly: q.poly, fit: q.fit, minHeight, tags }));
    }
    const pieces = strips && !want ? terraceStrips(b, dsm, opt, poly) : [poly];
    const flat = pieces.flatMap((s) => decompose(s.map(closeRing), opt.minArea));
    // A roof the standard shapes fit badly may be several levels (house + extension): split it where the roofline steps.
    const out: Region[] = [];
    for (const r of flat) {
      const g = groundOf?.(r) ?? 0;
      const levels = opt.levels && !want && !parts ? splitLevels(r, dsm, g, opt) : [r];
      for (const poly of levels) out.push({ poly, want, minHeight, tags });
    }
    return out;
  };
  if (!b.parts?.length) return split(foot, b.tags, true);
  const out: Region[] = [];
  let rest: Poly[] = [foot];
  for (const part of b.parts) {
    const mask = part.rings.map(closeRing);
    for (const piece of clip(foot, mask[0]).filter((p) => areaOf(p) >= opt.minArea)) out.push(...split(piece, { ...b.tags, ...part.tags }, false));
    // Whatever the part covers is removed from the remainder (min_height parts float over, they don't replace what is below).
    if (!(parseFloat(part.tags.min_height ?? '') > 0.5)) {
      rest = rest.flatMap((r) => { try { return difference(r, [mask[0]]).map((q) => q.map((ring) => ring as Ring)); } catch { return [r]; } }).filter((p) => areaOf(p) >= opt.minArea);
    }
  }
  for (const r of rest) out.push(...split(r, b.tags, true));
  return out;
}

/** Interpret one building's roof as a set of standard-shaped parts, or null if there is nothing to fit. */
export function fitRoofParts(b: Building, dsm: Raster, dtm: Raster, origin: XY, opt: PartOptions = DEFAULT_PART_OPTIONS, withDetails = false): RoofPart[] | null {
  if (b.rings[0].length < 3) return null;
  const regions = regionsOf(b, dsm, opt, (r) => groundUnder(r, dtm));
  const church = isChurch(b);
  const parts: RoofPart[] = [];
  const base = `building_${b.id.replace(/[^\w#-]/g, '_')}`;
  let k = 0;
  for (const { poly: region, want, minHeight, fit: preset } of regions) {
    const ground = groundUnder(region, dtm) + minHeight;
    let fit = preset ?? fitPart(region, dsm, ground, opt, { want, church });
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
    if (fit.type === 'gable' || fit.type === 'hip' || fit.type === 'mansard') mesh = roofedBuildingMesh(pseudo, fit, origin, floorZ);
    else if (fit.type === 'shed') mesh = shedMesh(region, fit, origin, floorZ);
    else if (fit.type === 'surface') mesh = rawRoofMesh(pseudo, smoothedDsm(dsm), origin, floorZ);
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
    if (withDetails && fit.type !== 'surface') {
      const id = partName.replace(/^building_/, '');
      details.push(...chimneys(region, fit, dsm, origin, id));
      const par = parapet(region, fit, dsm, origin, id);
      if (par) details.push(par);
    }
    parts.push({ name: partName, mesh, fit, details, region: rings, ground });
  }
  return parts.length ? parts : null;
}
