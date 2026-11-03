import earcut from 'earcut';
import { openRing, signedArea } from './clip';
import type { Building, Raster, XY } from '../types';

/** Indexed triangle mesh in local coordinates (x = E - originE, y = N - originN, z = m ODN). */
export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  /** Optional per-object index ranges [name, startIndex, count] (for OBJ objects). */
  parts?: [string, number, number][];
}

export interface TerrainOptions {
  /** Grid step in cells (1 = full 1 m resolution). */
  step: number;
  /** Close the surface with skirt walls and a flat base at this elevation (m ODN). */
  baseZ?: number;
}

/** Regular-grid terrain mesh from the DTM; optionally a closed (watertight) solid. */
export function terrainMesh(r: Raster, origin: XY, opts: TerrainOptions): Mesh {
  const cols = gridIndices(r.width, opts.step);
  const rows = gridIndices(r.height, opts.step);
  const nc = cols.length, nr = rows.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const x0 = r.minE + 0.5 * r.res, x1 = r.minE + (r.width - 0.5) * r.res;
  const y0 = r.maxN - (r.height - 0.5) * r.res, y1 = r.maxN - 0.5 * r.res;
  for (const j of rows) {
    for (const i of cols) {
      const e = r.minE + (i + 0.5) * r.res, n = r.maxN - (j + 0.5) * r.res;
      pos.push(e - origin[0], n - origin[1], r.data[j * r.width + i]);
      uv.push((e - x0) / (x1 - x0), (n - y0) / (y1 - y0));
    }
  }
  const idx: number[] = [];
  const v = (c: number, rr: number) => rr * nc + c;
  for (let rr = 0; rr < nr - 1; rr++) {
    for (let c = 0; c < nc - 1; c++) {
      const a = v(c, rr), b = v(c + 1, rr), cc = v(c, rr + 1), d = v(c + 1, rr + 1);
      idx.push(a, cc, b, b, cc, d); // CCW seen from +Z (rows run north -> south)
    }
  }

  if (opts.baseZ !== undefined) {
    // Perimeter, counter-clockwise seen from above: SW -> SE -> NE -> NW -> SW.
    const ring: number[] = [];
    for (let c = 0; c < nc - 1; c++) ring.push(v(c, nr - 1));
    for (let rr = nr - 1; rr > 0; rr--) ring.push(v(nc - 1, rr));
    for (let c = nc - 1; c > 0; c--) ring.push(v(c, 0));
    for (let rr = 0; rr < nr - 1; rr++) ring.push(v(0, rr));
    const first = pos.length / 3;
    for (const t of ring) {
      pos.push(pos[t * 3], pos[t * 3 + 1], opts.baseZ);
      uv.push(uv[t * 2], uv[t * 2 + 1]);
    }
    const centre = pos.length / 3;
    pos.push((x0 + x1) / 2 - origin[0], (y0 + y1) / 2 - origin[1], opts.baseZ);
    uv.push(0.5, 0.5);
    const m = ring.length;
    for (let k = 0; k < m; k++) {
      const t0 = ring[k], t1 = ring[(k + 1) % m];
      const b0 = first + k, b1 = first + ((k + 1) % m);
      idx.push(t0, b0, b1, t0, b1, t1); // outward walls
      idx.push(centre, b1, b0); // base, facing down
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), uvs: new Float32Array(uv) };
}

function gridIndices(n: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  out.push(n - 1);
  return out;
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
