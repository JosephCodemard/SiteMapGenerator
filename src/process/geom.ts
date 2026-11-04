import earcut from 'earcut';
import { pointInRings, signedArea } from './clip';
import type { Mesh } from './mesh';
import type { Ring, XY } from '../types';

/**
 * Mesh construction helpers shared by every model component: a welding mesh
 * builder, closed solids from open surfaces, draping polygons onto terrain.
 * Everything here works in *local* metres (BNG minus the site origin).
 */

/** Snap to a binary fraction so identical points computed by different code paths weld together. */
const SNAP = 1024;
export const snap = (v: number) => Math.round(v * SNAP) / SNAP;

export class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];
  private map = new Map<string, number>();

  /** Add (or reuse) a vertex; coordinates are snapped to 1/1024 m. */
  vertex(x: number, y: number, z: number): number {
    const xi = Math.round(x * SNAP), yi = Math.round(y * SNAP), zi = Math.round(z * SNAP);
    const key = `${xi},${yi},${zi}`;
    let i = this.map.get(key);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(xi / SNAP, yi / SNAP, zi / SNAP);
      this.map.set(key, i);
    }
    return i;
  }

  /** Unwelded vertex (for faces that must stay distinct, e.g. a duplicate surface). */
  free(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    if (a !== b && b !== c && a !== c) this.idx.push(a, b, c);
  }

  get triCount() { return this.idx.length / 3; }

  build(): Mesh {
    return { positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
  }
}

/** Merge named meshes into one mesh whose `parts` record each source (OBJ objects, DXF entities). */
export function mergeMeshes(list: { name: string; mesh: Mesh }[]): Mesh {
  list = list.filter((l) => l.mesh.indices.length > 0);
  let nv = 0, ni = 0;
  for (const { mesh } of list) { nv += mesh.positions.length; ni += mesh.indices.length; }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  const parts: [string, number, number][] = [];
  let vo = 0, io = 0;
  for (const { name, mesh } of list) {
    positions.set(mesh.positions, vo);
    const base = vo / 3;
    for (let k = 0; k < mesh.indices.length; k++) indices[io + k] = mesh.indices[k] + base;
    if (mesh.parts && mesh.parts.length) {
      for (const [n, s, c] of mesh.parts) parts.push([n, io + s, c]);
    } else parts.push([name, io, mesh.indices.length]);
    vo += mesh.positions.length;
    io += mesh.indices.length;
  }
  return { positions, indices, parts };
}

export const triCount = (m: Mesh | null | undefined) => (m ? m.indices.length / 3 : 0);

/** Directed boundary edges (those without an opposite partner) chained into loops of vertex indices. */
export function boundaryLoops(idx: ArrayLike<number>): number[][] {
  const edges = new Map<number, number[]>();
  const has = new Set<string>();
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) has.add(`${idx[t + k]}>${idx[t + (k + 1) % 3]}`);
  }
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + (k + 1) % 3];
      if (!has.has(`${b}>${a}`)) {
        const l = edges.get(a);
        if (l) l.push(b); else edges.set(a, [b]);
      }
    }
  }
  const loops: number[][] = [];
  for (const [start] of edges) {
    while (edges.get(start)?.length) {
      const loop = [start];
      let cur = start;
      for (;;) {
        const next = edges.get(cur)?.pop();
        if (next === undefined) break;
        if (next === start) break;
        loop.push(next);
        cur = next;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Triangulate closed vertex loops (outer loops CCW with positive area, holes CW) seen from above.
 * Returns CCW triangles as vertex ids into `p` (flat xyz positions).
 */
export function triangulateLoops(loops: number[][], p: ArrayLike<number>): number[] {
  const rings = loops.map((l) => ({ l, ring: l.map((v) => [p[v * 3], p[v * 3 + 1]] as XY) }));
  const outers = rings.filter((r) => signedArea(r.ring) > 0);
  const holes = rings.filter((r) => signedArea(r.ring) <= 0);
  const out: number[] = [];
  for (const o of outers) {
    const mine = holes.filter((h) => pointInRings(h.ring[0][0], h.ring[0][1], [o.ring]));
    const flat: number[] = [];
    const ids: number[] = [];
    const holeStarts: number[] = [];
    const addRing = (r: { l: number[] }, rev: boolean) => {
      for (const v of rev ? [...r.l].reverse() : r.l) { flat.push(p[v * 3], p[v * 3 + 1]); ids.push(v); }
    };
    addRing(o, false);
    for (const h of mine) { holeStarts.push(ids.length); addRing(h, true); }
    const tris = earcut(flat, holeStarts.length ? holeStarts : null);
    for (let t = 0; t < tris.length; t += 3) {
      let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const cross = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) -
        (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      if (cross < 0) [b, c] = [c, b];
      out.push(ids[a], ids[b], ids[c]);
    }
  }
  return out;
}

/**
 * Close an open surface (outward = up, CCW seen from above) into a solid with a
 * flat floor at `floorZ`: walls drop from every boundary edge, and the floor is
 * the triangulated boundary (so it needs far fewer triangles than mirroring).
 */
export function solidWithFlatFloor(surface: Mesh, floorZ: number): Mesh {
  const p = surface.positions;
  const pos = Array.from(p);
  const idx = Array.from(surface.indices);
  const bottom = new Map<number, number>();
  const bot = (v: number) => {
    let b = bottom.get(v);
    if (b === undefined) {
      b = pos.length / 3;
      pos.push(p[v * 3], p[v * 3 + 1], floorZ);
      bottom.set(v, b);
    }
    return b;
  };
  const loops = boundaryLoops(surface.indices);
  for (const loop of loops) {
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      idx.push(a, bot(a), bot(b), a, bot(b), b);
    }
  }
  // Floor: the boundary loops, triangulated, facing down.
  const tris = triangulateLoops(loops, p);
  for (let t = 0; t < tris.length; t += 3) idx.push(bot(tris[t]), bot(tris[t + 2]), bot(tris[t + 1]));
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/**
 * Close an open surface into a solid by mirroring it `thickness(i)` metres lower
 * (used for draped pads, whose underside follows the ground).
 */
export function solidWithMirrorFloor(surface: Mesh, thickness: number): Mesh {
  const p = surface.positions;
  const n = p.length / 3;
  const pos = new Float32Array(p.length * 2);
  pos.set(p);
  for (let i = 0; i < n; i++) {
    pos[(n + i) * 3] = p[i * 3];
    pos[(n + i) * 3 + 1] = p[i * 3 + 1];
    pos[(n + i) * 3 + 2] = p[i * 3 + 2] - thickness;
  }
  const idx = Array.from(surface.indices);
  for (let t = 0; t < surface.indices.length; t += 3) {
    idx.push(n + surface.indices[t], n + surface.indices[t + 2], n + surface.indices[t + 1]);
  }
  for (const loop of boundaryLoops(surface.indices)) {
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      idx.push(a, n + a, n + b, a, n + b, b);
    }
  }
  return { positions: pos, indices: new Uint32Array(idx) };
}

// ------------------------------------------------------------ draping

/** Regular-ish grid lines in local metres (ascending). */
export interface GridLines {
  xs: number[];
  ys: number[];
}

type P = [number, number];

/** Clip a convex polygon to x >= c (keep=+1) or x <= c (keep=-1); axis 0 = x, 1 = y. Intersections are canonical. */
function clipHalf(poly: P[], axis: 0 | 1, c: number, keep: 1 | -1): P[] {
  const out: P[] = [];
  const o = 1 - axis;
  const inside = (p: P) => (keep > 0 ? p[axis] >= c : p[axis] <= c);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const pin = inside(p), qin = inside(q);
    if (pin) out.push(p);
    if (pin !== qin) {
      // Canonical order so both triangles sharing this edge compute the same point.
      const [a, b] = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
      const t = (c - a[axis]) / (b[axis] - a[axis]);
      const pt: P = [0, 0];
      pt[axis] = c;
      pt[o] = a[o] + t * (b[o] - a[o]);
      out.push(pt);
    }
  }
  return out;
}

function lowerBound(a: number[], v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** Cut a triangle along every grid line; calls `emit` with convex pieces, each inside one cell. */
export function cutTriangleToGrid(tri: [P, P, P], g: GridLines, emit: (poly: P[]) => void) {
  const { xs, ys } = g;
  const minX = Math.min(tri[0][0], tri[1][0], tri[2][0]), maxX = Math.max(tri[0][0], tri[1][0], tri[2][0]);
  // Cell i spans xs[i]..xs[i+1]; the outermost cells extend to infinity so nothing is dropped.
  const i0 = Math.max(0, lowerBound(xs, minX + 1e-9) - 1);
  const i1 = Math.min(xs.length - 2, Math.max(i0, lowerBound(xs, maxX - 1e-9) - 1));
  for (let i = i0; i <= i1; i++) {
    let strip: P[] = tri;
    if (i > 0) strip = clipHalf(strip, 0, xs[i], 1);
    if (strip.length >= 3 && i < xs.length - 2) strip = clipHalf(strip, 0, xs[i + 1], -1);
    if (strip.length < 3) continue;
    let sMin = Infinity, sMax = -Infinity;
    for (const q of strip) { sMin = Math.min(sMin, q[1]); sMax = Math.max(sMax, q[1]); }
    const j0 = Math.max(0, lowerBound(ys, sMin + 1e-9) - 1);
    const j1 = Math.min(ys.length - 2, Math.max(j0, lowerBound(ys, sMax - 1e-9) - 1));
    for (let j = j0; j <= j1; j++) {
      let cell: P[] = strip;
      if (j > 0) cell = clipHalf(cell, 1, ys[j], 1);
      if (cell.length >= 3 && j < ys.length - 2) cell = clipHalf(cell, 1, ys[j + 1], -1);
      if (cell.length >= 3) emit(cell);
    }
  }
}

/** Earcut a polygon (outer + holes, local coords, any winding) into CCW triangles. */
export function triangulate(rings: Ring[]): { pts: XY[]; tris: number[] } {
  const clean = rings.map((r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r))
    .filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 1e-4);
  if (!clean.length) return { pts: [], tris: [] };
  const oriented = clean.map((r, k) => ((signedArea(r) > 0) === (k === 0) ? r : [...r].reverse()));
  const flat: number[] = [];
  const holes: number[] = [];
  const pts: XY[] = [];
  oriented.forEach((r, k) => {
    if (k) holes.push(pts.length);
    for (const q of r) { flat.push(q[0], q[1]); pts.push(q); }
  });
  const raw = earcut(flat, holes.length ? holes : null);
  const tris: number[] = [];
  for (let t = 0; t < raw.length; t += 3) {
    let [a, b, c] = [raw[t], raw[t + 1], raw[t + 2]];
    const cross = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) -
      (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
    if (cross < 0) [b, c] = [c, b];
    tris.push(a, b, c);
  }
  return { pts, tris };
}

/**
 * Drape polygons over a height function: the polygon is triangulated, then each
 * triangle is cut along the grid lines so the surface follows the terrain.
 * Returns an open surface facing up (CCW from above); neighbours share vertices.
 */
export function drapeSurface(polys: Ring[][], g: GridLines, zAt: (x: number, y: number) => number, lift: number, into?: MeshBuilder): MeshBuilder {
  const mb = into ?? new MeshBuilder();
  for (const rings of polys) {
    const { pts, tris } = triangulate(rings);
    for (let t = 0; t < tris.length; t += 3) {
      const tri: [P, P, P] = [pts[tris[t]] as P, pts[tris[t + 1]] as P, pts[tris[t + 2]] as P];
      cutTriangleToGrid(tri, g, (poly) => {
        // Snap, drop repeated points, and skip pieces with no area (a triangle edge lying on a grid line).
        const sp: P[] = [];
        for (const [x, y] of poly) {
          const q: P = [snap(x), snap(y)];
          const l = sp[sp.length - 1];
          if (!l || l[0] !== q[0] || l[1] !== q[1]) sp.push(q);
        }
        if (sp.length > 1 && sp[0][0] === sp[sp.length - 1][0] && sp[0][1] === sp[sp.length - 1][1]) sp.pop();
        if (sp.length < 3 || polygonArea(sp) < 1e-6) return;
        const ids = sp.map(([x, y]) => mb.vertex(x, y, zAt(x, y) + lift));
        earClipConvex(sp, ids, mb);
      });
    }
  }
  return mb;
}

function polygonArea(p: P[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]);
  return a / 2;
}

/**
 * Triangulate a convex CCW polygon, using every vertex (including collinear ones on its edges, which
 * neighbouring cells share) without emitting zero-area triangles.
 */
function earClipConvex(p: P[], ids: number[], mb: MeshBuilder) {
  const idx = p.map((_, i) => i);
  const cross = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  while (idx.length > 3) {
    let cut = -1, best = 0;
    for (let i = 0; i < idx.length; i++) {
      const a = p[idx[(i + idx.length - 1) % idx.length]], b = p[idx[i]], c = p[idx[(i + 1) % idx.length]];
      const cr = cross(a, b, c);
      if (cr > best) { best = cr; cut = i; }
    }
    if (cut < 0) return; // all remaining points collinear
    const n = idx.length;
    mb.tri(ids[idx[(cut + n - 1) % n]], ids[idx[cut]], ids[idx[(cut + 1) % n]]);
    idx.splice(cut, 1);
  }
  if (idx.length === 3 && Math.abs(cross(p[idx[0]], p[idx[1]], p[idx[2]])) > 1e-9) mb.tri(ids[idx[0]], ids[idx[1]], ids[idx[2]]);
}

/** Rasterise polygons (even-odd) into a 0/1 mask on a raster grid by scanlines. */
export function rasterizePolygons(
  polys: Ring[][],
  grid: { width: number; height: number; minE: number; maxN: number; res: number },
  mask?: Uint8Array,
): Uint8Array {
  const { width: w, height: h, minE, maxN, res } = grid;
  const out = mask ?? new Uint8Array(w * h);
  for (const rings of polys) {
    const rows: number[][] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x0, y0] = ring[j], [x1, y1] = ring[i];
        if (y0 === y1) continue;
        // Rows whose centre (maxN - (r + .5) * res) lies within [min(y), max(y)).
        const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
        const r0 = Math.max(0, Math.ceil((maxN - hi) / res - 0.5)), r1 = Math.min(h - 1, Math.floor((maxN - lo) / res - 0.5));
        for (let r = r0; r <= r1; r++) {
          const y = maxN - (r + 0.5) * res;
          if (y < lo || y >= hi) continue;
          const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
          (rows[r] ??= []).push(x);
        }
      }
    }
    rows.forEach((xs, r) => {
      if (!xs) return;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - minE) / res - 0.5)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - minE) / res - 0.5));
        for (let c = c0; c <= c1; c++) out[r * w + c] = 1;
      }
    });
  }
  return out;
}
