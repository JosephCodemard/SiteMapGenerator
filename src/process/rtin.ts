import { solidWithFlatFloor } from './geom';
import type { Mesh } from './mesh';
import type { Raster, XY } from '../types';

/**
 * Adaptive terrain: right-triangle bintree (RTIN) simplification, after Evans et al. and the
 * public-domain "Martini" formulation. The DTM is resampled onto a (2^k + 1)^2 grid that exactly spans the
 * site, per-triangle errors are accumulated bottom-up, and a triangle is only split while its vertical error
 * exceeds the tolerance. Neighbouring triangles always agree on shared edges, so the mesh has no cracks.
 */

export interface AdaptiveOptions {
  /** Largest vertical deviation from the resampled DTM (m). */
  tolerance: number;
  /** If set, the tolerance is raised until the mesh has at most this many triangles. */
  maxTris?: number;
}

export interface AdaptiveTerrain {
  /** Open surface, CCW from above, with UVs. */
  mesh: Mesh;
  /** Tolerance actually used (m); larger than requested when `maxTris` forced it up. */
  tolerance: number;
  gridSize: number;
  triangles: number;
  /** Closed solid with a flat base at `baseZ` (walls from the boundary, floor triangulated). */
  solid(baseZ: number): Mesh;
}

/** Largest grid we resample to; keeps memory around 200 MB for a 4 km edge. */
const MAX_GRID = 4097;

/** Grid size (2^k + 1) covering `cells` samples. */
export function rtinGridSize(cells: number): number {
  let n = 2;
  while (n + 1 < cells && n + 1 < MAX_GRID) n *= 2;
  return n + 1;
}

/** Corner coordinates of triangle `i` in Martini's numbering. */
function coords(i: number, tile: number, out: Int32Array) {
  let id = i + 2;
  let ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0;
  if (id & 1) { bx = by = cx = tile; } else { ax = ay = cy = tile; }
  while ((id >>= 1) > 1) {
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    if (id & 1) { bx = ax; by = ay; ax = cx; ay = cy; } else { ax = bx; ay = by; bx = cx; by = cy; }
    cx = mx; cy = my;
  }
  out[0] = ax; out[1] = ay; out[2] = bx; out[3] = by;
}

export function adaptiveTerrain(r: Raster, origin: XY, opts: AdaptiveOptions): AdaptiveTerrain {
  const N = rtinGridSize(Math.max(r.width, r.height));
  const tile = N - 1;
  const x0 = r.minE + 0.5 * r.res - origin[0], x1 = r.minE + (r.width - 0.5) * r.res - origin[0];
  const yN = r.maxN - 0.5 * r.res - origin[1], yS = r.maxN - (r.height - 0.5) * r.res - origin[1];

  // Resample the DTM bilinearly onto the square index grid (row 0 = north, like the raster).
  const terrain = new Float32Array(N * N);
  const { width: w, height: h, data } = r;
  for (let gy = 0; gy < N; gy++) {
    const fy = (gy / tile) * (h - 1), j = Math.min(Math.floor(fy), h - 2), ty = fy - j;
    for (let gx = 0; gx < N; gx++) {
      const fx = (gx / tile) * (w - 1), i = Math.min(Math.floor(fx), w - 2), tx = fx - i;
      const k = j * w + i;
      terrain[gy * N + gx] = (1 - tx) * (1 - ty) * data[k] + tx * (1 - ty) * data[k + 1] + (1 - tx) * ty * data[k + w] + tx * ty * data[k + w + 1];
    }
  }

  // Errors, bottom-up over all triangles.
  const errors = new Float32Array(N * N);
  const numTriangles = tile * tile * 2 - 2;
  const numParents = numTriangles - tile * tile;
  const c = new Int32Array(4);
  for (let i = numTriangles - 1; i >= 0; i--) {
    coords(i, tile, c);
    const [ax, ay, bx, by] = c;
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    const cx = mx + my - ay, cy = my + ax - mx;
    const mid = my * N + mx;
    const err = Math.abs((terrain[ay * N + ax] + terrain[by * N + bx]) / 2 - terrain[mid]);
    errors[mid] = Math.max(errors[mid], err);
    if (i < numParents) {
      errors[mid] = Math.max(errors[mid], errors[((ay + cy) >> 1) * N + ((ax + cx) >> 1)], errors[((by + cy) >> 1) * N + ((bx + cx) >> 1)]);
    }
  }

  const count = (maxError: number): number => {
    let n = 0;
    const rec = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
      if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * N + mx] > maxError) {
        rec(cx, cy, ax, ay, mx, my);
        rec(bx, by, cx, cy, mx, my);
      } else n++;
    };
    rec(0, 0, tile, tile, tile, 0);
    rec(tile, tile, 0, 0, 0, tile);
    return n;
  };

  let tol = Math.max(opts.tolerance, 1e-4);
  if (opts.maxTris) while (count(tol) > opts.maxTris && tol < 200) tol *= 1.3;

  // Emit vertices (indexed lazily) and triangles.
  const index = new Uint32Array(N * N);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const vertex = (gx: number, gy: number): number => {
    const k = gy * N + gx;
    if (!index[k]) {
      const u = gx / tile, v = gy / tile;
      pos.push(x0 + u * (x1 - x0), yN + v * (yS - yN), terrain[k]);
      uv.push(u, 1 - v);
      index[k] = pos.length / 3;
    }
    return index[k] - 1;
  };
  const emit = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    if (Math.abs(ax - cx) + Math.abs(ay - cy) > 1 && errors[my * N + mx] > tol) {
      emit(cx, cy, ax, ay, mx, my);
      emit(bx, by, cx, cy, mx, my);
    } else {
      // Grid y runs south, so the world is mirrored in y: swap to keep counter-clockwise from above.
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const [p, q, s] = [vertex(ax, ay), vertex(bx, by), vertex(cx, cy)];
      if (cross > 0) idx.push(p, s, q); else idx.push(p, q, s);
    }
  };
  emit(0, 0, tile, tile, tile, 0);
  emit(tile, tile, 0, 0, 0, tile);

  const mesh: Mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: new Float32Array(uv) };
  return {
    mesh, tolerance: tol, gridSize: N, triangles: idx.length / 3,
    solid: (baseZ: number) => solidWithFlatFloor(mesh, baseZ),
  };
}
