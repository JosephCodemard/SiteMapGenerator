import { intersection } from 'polygon-clipping';
import { ClipperLib } from './buffer';
import { openRing, pointInRings, signedArea } from './clip';
import { MeshBuilder, snap, solidWithFlatFloor, triangulate } from './geom';
import { downsample, sample } from './raster';
import type { Mesh } from './mesh';
import type { Building, Raster, Ring, RoofFit, XY } from '../types';

// ------------------------------------------------------------------ LOD1.5: fitted roofs

/** Minimum-area oriented rectangle of a ring, with the long side first. */
export function orientedBox(ring: Ring): { centre: XY; axis: XY; a: number; b: number } {
  const pts = openRing(ring);
  let best: { area: number; c: XY; ax: XY; a: number; b: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 0.5) continue;
    const ux = (q[0] - p[0]) / l, uy = (q[1] - p[1]) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const c: XY = [cu * ux - cv * uy, cu * uy + cv * ux];
      // Make the first axis the long one.
      best = (u1 - u0) >= (v1 - v0)
        ? { area, c, ax: [ux, uy], a: (u1 - u0) / 2, b: (v1 - v0) / 2 }
        : { area, c, ax: [-uy, ux], a: (v1 - v0) / 2, b: (u1 - u0) / 2 };
    }
  }
  if (!best) throw new Error('degenerate footprint');
  return { centre: best.c, axis: best.ax, a: best.a, b: best.b };
}

/** Samples closer than this to the outline (m) are ignored: OSM outlines are rarely within 1 m of the true wall. */
const EDGE_INSET = 1.0;

export function edgeDistance(x: number, y: number, rings: Ring[]): number {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [x0, y0] = r[j], [x1, y1] = r[i];
      const dx = x1 - x0, dy = y1 - y0;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - x0 - t * dx, y - y0 - t * dy));
    }
  }
  return best;
}

/** Largest RMS error (m) against the LIDAR roof for which a fitted pitched roof is trusted. */
export const PITCH_MAX_RMSE = 1.2;

/** Roof height at box coordinates (u along the ridge, v across), for a shape with eaves `e`, ridge `r`. */
export function roofZ(type: 'gable' | 'hip', e: number, r: number, a: number, b: number, u: number, v: number): number {
  const s = (r - e) / b;
  const d = type === 'gable' ? b - Math.abs(v) : Math.min(b - Math.abs(v), a - Math.abs(u));
  return e + s * Math.max(0, d);
}

/** Height of a piecewise-linear roof profile `[t, z][]` at horizontal distance `t` in from the wall. */
export function profileZ(profile: [number, number][], t: number): number {
  if (t <= profile[0][0]) return profile[0][1];
  for (let k = 1; k < profile.length; k++) {
    const [t1, z1] = profile[k], [t0, z0] = profile[k - 1];
    if (t <= t1) return t1 > t0 ? z0 + ((z1 - z0) * (t - t0)) / (t1 - t0) : z1;
  }
  return profile[profile.length - 1][1];
}

/** Distance in from the wall for a mansard roof point (box coordinates). */
export const profileT = (f: RoofFit, u: number, v: number): number =>
  f.hipped ? Math.min(f.b - Math.abs(v), f.a - Math.abs(u)) : f.b - Math.abs(v);

/** Pitch of the main (upper) roof slope in degrees; 0 for flat roofs. */
export function pitchDeg(f: RoofFit): number {
  if (f.type === 'gable' || f.type === 'hip') return (Math.atan((f.ridge - f.eaves) / f.b) * 180) / Math.PI;
  if (f.type === 'shed' && f.plane) return (Math.atan(Math.hypot(f.plane[1], f.plane[2])) * 180) / Math.PI;
  if (f.type === 'mansard' && f.profile && f.profile.length > 1) {
    // The upper slope is what reads as "the roof" on a plan; the steep lower slope is shown as a break line.
    const [t0, z0] = f.profile[f.profile.length - 2], [t1, z1] = f.profile[f.profile.length - 1];
    return t1 > t0 ? (Math.atan((z1 - z0) / (t1 - t0)) * 180) / Math.PI : 0;
  }
  return 0;
}

/**
 * Choose flat / gable / hip for a building by comparing each shape's RMS error
 * against the LIDAR surface inside the footprint. Returns null when the
 * footprint is too small or too irregular for a box roof.
 */
export function fitRoof(b: Building, dsm: Raster): RoofFit | null {
  const ring = b.rings[0];
  if (ring.length < 3) return null;
  let box;
  try { box = orientedBox(ring); } catch { return null; }
  const area = Math.abs(signedArea(openRing(ring))) - b.rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(openRing(r))), 0);
  if (area < 20 || box.b < 1.5 || area / (4 * box.a * box.b) < 0.6) return null;

  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of ring) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / dsm.res)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / dsm.res));
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / dsm.res)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / dsm.res));
  const samples: { u: number; v: number; z: number }[] = [];
  const [ux, uy] = box.axis;
  for (let j = j0; j <= j1; j++) {
    const n = dsm.maxN - (j + 0.5) * dsm.res;
    for (let i = i0; i <= i1; i++) {
      const e = dsm.minE + (i + 0.5) * dsm.res;
      if (!pointInRings(e, n, b.rings) || edgeDistance(e, n, b.rings) < EDGE_INSET) continue;
      const dx = e - box.centre[0], dy = n - box.centre[1];
      samples.push({ u: dx * ux + dy * uy, v: -dx * uy + dy * ux, z: dsm.data[j * dsm.width + i] });
    }
  }
  if (samples.length < 12) return null;
  const n = samples.length;
  const zs = samples.map((q) => q.z).sort((p, q) => p - q);
  const mean = zs.reduce((acc, v) => acc + v, 0) / n;
  const flat = Math.sqrt(zs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n);
  if (zs[n - 1] - zs[0] < 1.2) return flatFit(b, box, samples);

  // Least-squares z = eaves + k * t, with t the distance up the slope for each shape; the ridge is t = b.
  const { a, b: hw } = box;
  const shapes = (['gable', 'hip'] as const).map((type) => {
    const tOf = (q: { u: number; v: number }) => (type === 'gable' ? hw - Math.abs(q.v) : Math.min(hw - Math.abs(q.v), a - Math.abs(q.u)));
    let st = 0, sz = 0, stt = 0, stz = 0;
    for (const q of samples) { const t = tOf(q); st += t; sz += q.z; stt += t * t; stz += t * q.z; }
    const den = n * stt - st * st;
    const k = den > 1e-9 ? (n * stz - st * sz) / den : 0;
    const eaves = (sz - k * st) / n;
    const ridge = eaves + k * hw;
    const err = Math.sqrt(samples.reduce((acc, q) => acc + (roofZ(type, eaves, ridge, a, hw, q.u, q.v) - q.z) ** 2, 0) / n);
    return { type, eaves, ridge, err };
  });
  // A real roof rises at most ~42 degrees over the half-span, and eaves sit well above the ground. Anything else
  // is a stepped terrace, a hillside or a DSM artefact: keep the honest flat block rather than invent a pyramid.
  const ok = shapes.filter((q) => {
    const rise = q.ridge - q.eaves;
    return rise >= 1.2 && rise <= Math.min(0.9 * hw, 9) && hw <= 12 && q.eaves >= b.ground + 2 && q.err <= PITCH_MAX_RMSE && q.err < 0.75 * flat;
  });
  if (!ok.length) return flatFit(b, box, samples);
  const gable = ok.find((q) => q.type === 'gable'), hip = ok.find((q) => q.type === 'hip');
  const best = gable && hip ? (hip.err < gable.err * 0.95 ? hip : gable) : (gable ?? hip)!;
  return { type: best.type, eaves: best.eaves, ridge: best.ridge, ...box, rmse: best.err };
}

function flatFit(b: Building, box: ReturnType<typeof orientedBox>, samples: { z: number }[]): RoofFit {
  const mean = samples.reduce((s, q) => s + q.z, 0) / samples.length;
  const rmse = Math.sqrt(samples.reduce((s, q) => s + (q.z - mean) ** 2, 0) / samples.length);
  return { type: 'flat', eaves: b.top, ridge: b.top, ...box, rmse };
}

/** Ridge / hip / eaves line segments of a fitted roof, in BNG (for roof-plan drawings). */
export function roofLines(f: RoofFit): { ridge: [XY, XY] | null; hips: [XY, XY][]; z: number } {
  if (f.type === 'flat') return { ridge: null, hips: [], z: f.ridge };
  const { centre: [cx, cy], axis: [ux, uy], a, b } = f;
  const pt = (u: number, v: number): XY => [cx + u * ux - v * uy, cy + u * uy + v * ux];
  if (f.type === 'shed') {
    // The high edge of a mono-pitch roof is its "ridge".
    const [, pa, pb] = f.plane ?? [0, 1, 0];
    return Math.abs(pa) >= Math.abs(pb)
      ? { ridge: [pt(Math.sign(pa) * a, -b), pt(Math.sign(pa) * a, b)], hips: [], z: f.ridge }
      : { ridge: [pt(-a, Math.sign(pb) * b), pt(a, Math.sign(pb) * b)], hips: [], z: f.ridge };
  }
  if (f.type === 'mansard' && f.profile) {
    // Break lines (where the steep slope meets the upper one) as closed rectangles, and the top edge / ridge.
    const lines: [XY, XY][] = [];
    const rect = (t: number): XY[] => {
      const hu = f.hipped ? Math.max(0, a - t) : a, hv = Math.max(0, b - t);
      return [pt(-hu, -hv), pt(hu, -hv), pt(hu, hv), pt(-hu, hv)];
    };
    let ridge: [XY, XY] | null = null;
    f.profile.slice(1).forEach(([t], i, arr) => {
      const r = rect(t);
      if (i === arr.length - 1) {
        // The top: a ridge line when it closes to a point, else the edges of the flat top.
        if (b - t < 0.3) { ridge = [pt(-(f.hipped ? Math.max(0, a - b) : a), 0), pt(f.hipped ? Math.max(0, a - b) : a, 0)]; return; }
      }
      for (let q = 0; q < 4; q++) lines.push([r[q], r[(q + 1) % 4]]);
    });
    return { ridge, hips: lines, z: f.ridge };
  }
  const k = f.type === 'gable' ? a : Math.max(0, a - b);
  const hips: [XY, XY][] = f.type === 'hip'
    ? [[pt(-a, -b), pt(-k, 0)], [pt(-a, b), pt(-k, 0)], [pt(a, -b), pt(k, 0)], [pt(a, b), pt(k, 0)]]
    : [];
  return { ridge: [pt(-k, 0), pt(k, 0)], hips, z: f.ridge };
}

/** Planar roof regions in box coordinates, each with its height function. */
function roofRegions(f: RoofFit): { uv: XY[]; z: (u: number, v: number) => number }[] {
  const { a, b, eaves: e, ridge: r } = f;
  if (f.type === 'mansard' && f.profile) return profileRegions(f);
  const s = (r - e) / b;
  if (f.type === 'gable') {
    return [
      { uv: [[-a, 0], [a, 0], [a, b], [-a, b]], z: (_u, v) => e + s * (b - v) },
      { uv: [[-a, -b], [a, -b], [a, 0], [-a, 0]], z: (_u, v) => e + s * (b + v) },
    ];
  }
  const k = Math.max(0, a - b);
  return [
    { uv: [[-a, b], [-k, 0], [k, 0], [a, b]], z: (_u, v) => e + s * (b - v) },
    { uv: [[-a, -b], [a, -b], [k, 0], [-k, 0]], z: (_u, v) => e + s * (b + v) },
    { uv: [[a, -b], [a, b], [k, 0]], z: (u) => e + s * (a - u) },
    { uv: [[-a, b], [-a, -b], [-k, 0]], z: (u) => e + s * (a + u) },
  ];
}

/** Planar facets of a mansard (profile) roof: one band per profile segment on each sloping side. */
function profileRegions(f: RoofFit): { uv: XY[]; z: (u: number, v: number) => number }[] {
  const { a, b } = f, prof = f.profile!;
  const out: { uv: XY[]; z: (u: number, v: number) => number }[] = [];
  const dedupe = (pts: XY[]) => pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });
  for (let k = 0; k + 1 < prof.length; k++) {
    const [t0, z0] = prof[k], [t1, z1] = prof[k + 1];
    if (t1 - t0 < 1e-6) continue;
    const zt = (t: number) => z0 + ((z1 - z0) * (t - t0)) / (t1 - t0);
    if (!f.hipped) {
      for (const sg of [1, -1]) {
        out.push({ uv: dedupe([[-a, sg * (b - t0)], [a, sg * (b - t0)], [a, sg * (b - t1)], [-a, sg * (b - t1)]]), z: (_u, v) => zt(b - Math.abs(v)) });
      }
      continue;
    }
    const A0 = a - t0, B0 = b - t0, A1 = Math.max(0, a - t1), B1 = Math.max(0, b - t1);
    out.push(
      { uv: dedupe([[-A0, B0], [A0, B0], [A1, B1], [-A1, B1]]), z: (_u, v) => zt(b - Math.abs(v)) },
      { uv: dedupe([[A0, -B0], [-A0, -B0], [-A1, -B1], [A1, -B1]]), z: (_u, v) => zt(b - Math.abs(v)) },
      { uv: dedupe([[A0, -B0], [A0, B0], [A1, B1], [A1, -B1]]), z: (u) => zt(a - Math.abs(u)) },
      { uv: dedupe([[-A0, B0], [-A0, -B0], [-A1, -B1], [-A1, B1]]), z: (u) => zt(a - Math.abs(u)) },
    );
  }
  return out;
}

/** Closed LOD1.5 solid for a building with a gable or hip roof; null when the fit is flat. */
export function roofedBuildingMesh(b: Building, f: RoofFit, origin: XY, floorZ: number): Mesh | null {
  if (f.type === 'flat' || f.type === 'shed' || f.type === 'surface') return null;
  const { centre: [cx, cy], axis: [ux, uy] } = f;
  const toLocal = (u: number, v: number): [number, number] => [cx + u * ux - v * uy - origin[0], cy + u * uy + v * ux - origin[1]];
  const toBox = (x: number, y: number): [number, number] => {
    const dx = x + origin[0] - cx, dy = y + origin[1] - cy;
    return [dx * ux + dy * uy, -dx * uy + dy * ux];
  };
  const close = (r: [number, number][]) => [...r, r[0]];
  const foot = b.rings.map((r) => close(openRing(r).map(([e, n]) => [e - origin[0], n - origin[1]] as [number, number])));
  const mb = new MeshBuilder();
  for (const reg of roofRegions(f)) {
    const poly = close(reg.uv.map(([u, v]) => toLocal(u, v)));
    let pieces: ReturnType<typeof intersection>;
    try { pieces = intersection([foot[0], ...foot.slice(1)], [poly]); } catch { return null; }
    for (const piece of pieces) {
      const { pts, tris } = triangulate(piece.map((r) => openRing(r as Ring)));
      const ids = pts.map(([x, y]) => {
        const sx = snap(x), sy = snap(y);
        const [u, v] = toBox(sx, sy);
        return mb.vertex(sx, sy, reg.z(u, v));
      });
      for (let t = 0; t < tris.length; t += 3) mb.tri(ids[tris[t]], ids[tris[t + 1]], ids[tris[t + 2]]);
    }
  }
  if (!mb.idx.length) return null;
  return solidWithFlatFloor(mb.build(), floorZ);
}

// ------------------------------------------------------------------ LOD2-raw: LIDAR roof surface

const CS = 1000; // clipper units per metre (mm)

/**
 * Roof = the DSM surface inside the footprint: each grid triangle is cut to the
 * footprint, so the roof edge follows the outline exactly. Walls are built from
 * the footprint ring with heights sampled from the DSM. Not guaranteed watertight
 * (hairline cracks where wall tops meet the roof), so intended for visualisation.
 */
export function rawRoofMesh(b: Building, dsm: Raster, origin: XY, floorZ: number): Mesh | null {
  const ring = openRing(b.rings[0]);
  if (ring.length < 3) return null;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of ring) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
  const res = dsm.res;
  const i0 = Math.max(0, Math.floor((minE - dsm.minE) / res - 0.5)), i1 = Math.min(dsm.width - 1, Math.ceil((maxE - dsm.minE) / res - 0.5) + 1);
  const j0 = Math.max(0, Math.floor((dsm.maxN - maxN) / res - 0.5)), j1 = Math.min(dsm.height - 1, Math.ceil((dsm.maxN - minN) / res - 0.5) + 1);
  if (i1 - i0 < 1 || j1 - j0 < 1) return null;
  const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
  const gx = (i: number) => dsm.minE + (i + 0.5) * res, gy = (j: number) => dsm.maxN - (j + 0.5) * res;
  const lo = (e: number, n: number): [number, number] => [e - origin[0], n - origin[1]];

  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) inside[j * nx + i] = pointInRings(gx(i0 + i), gy(j0 + j), b.rings) ? 1 : 0;
  // Quads crossed by the outline (or a hole) need exact clipping.
  const marked = new Uint8Array(nx * ny);
  for (const r of b.rings) {
    const pts = openRing(r);
    for (let k = 0; k < pts.length; k++) {
      const [e0, n0] = pts[k], [e1, n1] = pts[(k + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(e1 - e0, n1 - n0) / (res * 0.25)));
      for (let s = 0; s <= steps; s++) {
        const e = e0 + ((e1 - e0) * s) / steps, n = n0 + ((n1 - n0) * s) / steps;
        const qi = Math.floor((e - dsm.minE) / res - 0.5) - i0, qj = Math.floor((dsm.maxN - n) / res - 0.5) - j0;
        if (qi >= 0 && qj >= 0 && qi < nx - 1 && qj < ny - 1) marked[qj * nx + qi] = 1;
      }
    }
  }

  // Footprint as Clipper polygons (outer CCW, holes CW), relative to the building's corner.
  const fx = Math.floor(minE), fy = Math.floor(minN);
  const clipPaths = b.rings.map((r, k) => {
    const p = openRing(r).map(([e, n]) => ({ X: Math.round((e - fx) * CS), Y: Math.round((n - fy) * CS) }));
    if ((signedArea(openRing(r)) > 0) !== (k === 0)) p.reverse();
    return p;
  });

  // Roof samples at the very edge can fall in the street when the outline is a metre out: never let the roof
  // drop below the low end of the roof interior.
  const inner: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (inside[j * nx + i]) inner.push(dsm.data[(j0 + j) * dsm.width + i0 + i]);
  inner.sort((p, q) => p - q);
  const low = inner.length ? inner[Math.floor(inner.length * 0.1)] - 0.3 : floorZ + 3;
  const mb = new MeshBuilder();
  const zAt = (i: number, j: number) => Math.max(low, dsm.data[(j0 + j) * dsm.width + i0 + i]);
  const emitTri = (p: [XY, XY, XY], z: [number, number, number]) => {
    const ids = p.map(([e, n], k) => { const [x, y] = lo(e, n); return mb.vertex(x, y, z[k]); });
    mb.tri(ids[0], ids[1], ids[2]);
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const cnt = inside[k] + inside[k + 1] + inside[k + nx] + inside[k + nx + 1];
      if (!marked[k] && cnt === 0) continue;
      const A: XY = [gx(i0 + i), gy(j0 + j)], B: XY = [gx(i0 + i + 1), A[1]], C: XY = [A[0], gy(j0 + j + 1)], D: XY = [B[0], C[1]];
      const za = zAt(i, j), zb = zAt(i + 1, j), zc = zAt(i, j + 1), zd = zAt(i + 1, j + 1);
      const tris: { v: [XY, XY, XY]; z: [number, number, number] }[] = [
        { v: [A, C, B], z: [za, zc, zb] }, { v: [B, C, D], z: [zb, zc, zd] },
      ];
      if (!marked[k] && cnt === 4) { for (const t of tris) emitTri(t.v, t.z); continue; }
      for (const t of tris) {
        const c = new ClipperLib.Clipper();
        c.AddPaths(clipPaths, ClipperLib.PolyType.ptSubject, true);
        c.AddPath(t.v.map(([e, n]) => ({ X: Math.round((e - fx) * CS), Y: Math.round((n - fy) * CS) })), ClipperLib.PolyType.ptClip, true);
        const tree = new ClipperLib.PolyTree();
        c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        // Plane through the three corners: z = z0 + gx * (e - e0) + gy * (n - n0).
        const [p0, p1, p2] = t.v, [z0, z1, z2] = t.z;
        const det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        const gxx = ((z1 - z0) * (p2[1] - p0[1]) - (z2 - z0) * (p1[1] - p0[1])) / det;
        const gyy = ((z2 - z0) * (p1[0] - p0[0]) - (z1 - z0) * (p2[0] - p0[0])) / det;
        for (const ex of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
          const rings = [ex.outer, ...ex.holes].map((r) => r.map((q) => [q.X / CS + fx - origin[0], q.Y / CS + fy - origin[1]] as XY));
          const { pts, tris: idx } = triangulate(rings);
          const ids = pts.map(([x, y]) => {
            const sx = snap(x), sy = snap(y);
            return mb.vertex(sx, sy, z0 + gxx * (sx + origin[0] - p0[0]) + gyy * (sy + origin[1] - p0[1]));
          });
          for (let q = 0; q < idx.length; q += 3) mb.tri(ids[idx[q]], ids[idx[q + 1]], ids[idx[q + 2]]);
        }
      }
    }
  }
  if (!mb.idx.length) return null;

  // Walls + floor from the footprint, with wall tops following the DSM.
  const roof = mb.build();
  const pos = Array.from(roof.positions);
  const idx = Array.from(roof.indices);
  const rings = b.rings.map((r, k) => {
    const o = openRing(r).map(([e, n]) => [e - origin[0], n - origin[1]] as XY);
    return (signedArea(o) > 0) === (k === 0) ? o : o.reverse();
  });
  for (const r of rings) {
    const top: number[] = [], bot: number[] = [];
    for (const [x, y] of r) {
      top.push(pos.length / 3); pos.push(x, y, Math.max(floorZ + 1, low, sample(dsm, x + origin[0], y + origin[1])));
      bot.push(pos.length / 3); pos.push(x, y, floorZ);
    }
    for (let k = 0; k < r.length; k++) {
      const q = (k + 1) % r.length;
      idx.push(top[k], bot[k], bot[q], top[k], bot[q], top[q]);
    }
  }
  const { pts, tris } = triangulate(rings);
  const base = pos.length / 3;
  for (const [x, y] of pts) pos.push(x, y, floorZ);
  for (let t = 0; t < tris.length; t += 3) idx.push(base + tris[t], base + tris[t + 2], base + tris[t + 1]);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** DSM resampled for LOD2-raw (block average by an integer factor). */
export const roofRaster = (dsm: Raster, step: number) => (step > 1 ? downsample(dsm, step) : dsm);
