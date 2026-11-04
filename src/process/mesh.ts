import earcut from 'earcut';
import { openRing, signedArea } from './clip';
import { blur } from './raster';
import type { Building, Raster, XY } from '../types';

/** Indexed triangle mesh in local coordinates (x = E - originE, y = N - originN, z = m ODN). */
export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  /** Optional per-object index ranges [name, startIndex, count] (for OBJ objects / DXF entities). */
  parts?: [string, number, number][];
}

export interface TerrainOptions {
  /** Grid step in cells (1 = full 1 m resolution). */
  step: number;
  /** Close the surface with skirt walls and a flat base at this elevation (m ODN). */
  baseZ?: number;
  /** Box-average the DTM over each step x step window instead of point-sampling (default true). */
  average?: boolean;
}

/** The terrain's vertex grid in local metres, with a height lookup that matches the mesh triangulation exactly. */
export interface TerrainGrid {
  /** Column x and row y coordinates (rows run north -> south, so `ys` is descending). */
  xs: number[];
  ys: number[];
  nc: number;
  nr: number;
  z: Float32Array;
  /** Height at a local point; identical to the mesh surface (same diagonal split). */
  zAt(x: number, y: number): number;
  /** Ascending grid lines keeping every `k`-th line (always including the last), for draping at a coarser cell size. */
  lines(k: number): { xs: number[]; ys: number[] };
}

function gridIndices(n: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  out.push(n - 1);
  return out;
}

export function terrainGrid(r: Raster, origin: XY, opts: Pick<TerrainOptions, 'step' | 'average'>): TerrainGrid {
  const step = Math.max(1, Math.round(opts.step));
  const src = step > 1 && opts.average !== false ? blur(r, Math.floor(step / 2), 1) : r;
  const cols = gridIndices(r.width, step), rows = gridIndices(r.height, step);
  const nc = cols.length, nr = rows.length;
  const xs = cols.map((i) => r.minE + (i + 0.5) * r.res - origin[0]);
  const ys = rows.map((j) => r.maxN - (j + 0.5) * r.res - origin[1]);
  const z = new Float32Array(nc * nr);
  for (let rr = 0; rr < nr; rr++) for (let c = 0; c < nc; c++) z[rr * nc + c] = src.data[rows[rr] * r.width + cols[c]];

  // Last index i in [0, n-2] with a[i] <= v (ascending) or a[i] >= v (descending).
  const find = (a: number[], v: number, desc: boolean) => {
    let lo = 0, hi = a.length - 2;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (desc ? a[m] >= v : a[m] <= v) lo = m; else hi = m - 1;
    }
    return lo;
  };
  const zAt = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, xs[0]), xs[nc - 1]), cy = Math.min(Math.max(y, ys[nr - 1]), ys[0]);
    const c = find(xs, cx, false), rr = find(ys, cy, true);
    const tx = (cx - xs[c]) / (xs[c + 1] - xs[c]), ty = (ys[rr] - cy) / (ys[rr] - ys[rr + 1]);
    const nw = z[rr * nc + c], ne = z[rr * nc + c + 1], sw = z[(rr + 1) * nc + c], se = z[(rr + 1) * nc + c + 1];
    // The mesh splits each cell along the NE-SW diagonal.
    return tx + ty <= 1 ? nw + tx * (ne - nw) + ty * (sw - nw) : se + (1 - tx) * (sw - se) + (1 - ty) * (ne - se);
  };
  const lines = (k: number) => {
    const pick = (a: number[]) => {
      const out = a.filter((_, i) => i % k === 0);
      if (out[out.length - 1] !== a[a.length - 1]) out.push(a[a.length - 1]);
      return out;
    };
    return { xs: pick(xs), ys: pick(ys).reverse() };
  };
  return { xs, ys, nc, nr, z, zAt, lines };
}

/** Terrain triangle count for a grid step (two per cell, before any skirt). */
export function terrainTriangles(r: Raster, step: number): number {
  return 2 * (gridIndices(r.width, step).length - 1) * (gridIndices(r.height, step).length - 1);
}

/** Regular-grid terrain mesh from the DTM; optionally a closed (watertight) solid. */
export function terrainMesh(r: Raster, origin: XY, opts: TerrainOptions, grid = terrainGrid(r, origin, opts)): Mesh {
  const { xs, ys, nc, nr, z } = grid;
  const ring = opts.baseZ !== undefined ? 2 * (nc - 1) + 2 * (nr - 1) : 0;
  const nv = nc * nr + (ring ? ring + 1 : 0);
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const ux = xs[nc - 1] - xs[0], uy = ys[0] - ys[nr - 1];
  for (let rr = 0; rr < nr; rr++) {
    for (let c = 0; c < nc; c++) {
      const k = rr * nc + c;
      pos[k * 3] = xs[c]; pos[k * 3 + 1] = ys[rr]; pos[k * 3 + 2] = z[k];
      uv[k * 2] = (xs[c] - xs[0]) / ux; uv[k * 2 + 1] = (ys[rr] - ys[nr - 1]) / uy;
    }
  }
  const idx = new Uint32Array((nc - 1) * (nr - 1) * 6 + ring * 9);
  let o = 0;
  const v = (c: number, rr: number) => rr * nc + c;
  for (let rr = 0; rr < nr - 1; rr++) {
    for (let c = 0; c < nc - 1; c++) {
      const a = v(c, rr), b = v(c + 1, rr), cc = v(c, rr + 1), d = v(c + 1, rr + 1);
      idx[o++] = a; idx[o++] = cc; idx[o++] = b; idx[o++] = b; idx[o++] = cc; idx[o++] = d; // CCW seen from +Z
    }
  }

  if (opts.baseZ !== undefined) {
    // Perimeter, counter-clockwise seen from above: SW -> SE -> NE -> NW -> SW.
    const per: number[] = [];
    for (let c = 0; c < nc - 1; c++) per.push(v(c, nr - 1));
    for (let rr = nr - 1; rr > 0; rr--) per.push(v(nc - 1, rr));
    for (let c = nc - 1; c > 0; c--) per.push(v(c, 0));
    for (let rr = 0; rr < nr - 1; rr++) per.push(v(0, rr));
    const first = nc * nr;
    per.forEach((t, k) => {
      pos[(first + k) * 3] = pos[t * 3]; pos[(first + k) * 3 + 1] = pos[t * 3 + 1]; pos[(first + k) * 3 + 2] = opts.baseZ!;
      uv[(first + k) * 2] = uv[t * 2]; uv[(first + k) * 2 + 1] = uv[t * 2 + 1];
    });
    const centre = first + ring;
    pos[centre * 3] = (xs[0] + xs[nc - 1]) / 2; pos[centre * 3 + 1] = (ys[0] + ys[nr - 1]) / 2; pos[centre * 3 + 2] = opts.baseZ;
    uv[centre * 2] = 0.5; uv[centre * 2 + 1] = 0.5;
    const m = per.length;
    for (let k = 0; k < m; k++) {
      const t0 = per[k], t1 = per[(k + 1) % m];
      const b0 = first + k, b1 = first + ((k + 1) % m);
      idx[o++] = t0; idx[o++] = b0; idx[o++] = b1; idx[o++] = t0; idx[o++] = b1; idx[o++] = t1; // outward walls
      idx[o++] = centre; idx[o++] = b1; idx[o++] = b0; // base, facing down
    }
  }
  return { positions: pos, indices: idx.subarray(0, o), uvs: uv };
}

/** LOD1 blocks: each building is a closed prism from (ground - sink) to top. */
export function buildingsMesh(buildings: Building[], origin: XY, sink = 0.5, minBase = -Infinity): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const parts: [string, number, number][] = [];
  for (const b of buildings) {
    const start = idx.length;
    const zb = Math.max(b.ground - sink, minBase), zt = b.top;
    // Outer ring CCW, holes CW (seen from above), duplicate closing vertex removed.
    const valid = (r: XY[]) => r.length >= 3 && Math.abs(signedArea(r)) > 0.01;
    const local = b.rings.map((r, k) => {
      const o = openRing(r).map(([e, n]) => [e - origin[0], n - origin[1]] as XY);
      const ccw = signedArea(o) > 0;
      return (k === 0) === ccw ? o : o.reverse();
    });
    if (!valid(local[0])) continue;
    const rings = [local[0], ...local.slice(1).filter(valid)];

    const flat: number[] = [];
    const holes: number[] = [];
    rings.forEach((r, k) => {
      if (k) holes.push(flat.length / 2);
      for (const p of r) flat.push(p[0], p[1]);
    });
    const tris = earcut(flat, holes.length ? holes : null);
    if (!tris.length) continue;

    const nv = flat.length / 2;
    const topBase = pos.length / 3;
    for (let k = 0; k < nv; k++) pos.push(flat[2 * k], flat[2 * k + 1], zt);
    const botBase = pos.length / 3;
    for (let k = 0; k < nv; k++) pos.push(flat[2 * k], flat[2 * k + 1], zb);

    for (let t = 0; t < tris.length; t += 3) {
      let [a, b2, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const cross = (flat[2 * b2] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) -
        (flat[2 * b2 + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      if (cross < 0) [b2, c] = [c, b2];
      idx.push(topBase + a, topBase + b2, topBase + c); // roof, facing up
      idx.push(botBase + a, botBase + c, botBase + b2); // floor, facing down
    }
    let offset = 0;
    for (const r of rings) {
      for (let k = 0; k < r.length; k++) {
        const p = offset + k, q = offset + ((k + 1) % r.length);
        idx.push(topBase + p, botBase + p, botBase + q, topBase + p, botBase + q, topBase + q);
      }
      offset += r.length;
    }
    parts.push([`building_${b.id.replace(/[^\w#-]/g, '_')}`, start, idx.length - start]);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), parts };
}

/** Pick a mesh step so the terrain has at most ~maxVerts vertices. */
export function autoStep(r: Raster, maxVerts = 1_000_000): number {
  return Math.max(1, Math.ceil(Math.sqrt((r.width * r.height) / maxVerts)));
}

/** Smallest step whose terrain stays within a triangle budget. */
export function stepForTriangles(r: Raster, maxTris: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((2 * r.width * r.height) / maxTris)));
}
