import { rasterizePolygons } from './geom';
import type { Mesh } from './mesh';
import { blur } from './raster';
import type { Raster, XY } from '../types';
import type { Polygon } from './buffer';

export interface Tree {
  /** BNG position. */
  p: XY;
  /** Height above ground (m). */
  h: number;
  /** Crown radius (m). */
  r: number;
  source: 'osm' | 'lidar';
}

export interface TreeOptions {
  /** Ignore canopy below this height above ground (m). */
  minHeight: number;
  /** Safety cap on the number of detected trees. */
  max: number;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = { minHeight: 2.5, max: 20000 };

/** Rule-of-thumb crown radius from height. */
export const crownRadius = (h: number) => Math.min(8, Math.max(1.5, 0.2 * h + 1));

function dilate(mask: Uint8Array, w: number, h: number, cells: number): Uint8Array {
  let cur = mask;
  for (let it = 0; it < cells; it++) {
    const next = Uint8Array.from(cur);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (cur[k]) continue;
        if ((i > 0 && cur[k - 1]) || (i < w - 1 && cur[k + 1]) || (j > 0 && cur[k - w]) || (j < h - 1 && cur[k + w])) next[k] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Find individual trees as local maxima of the canopy height model (DSM - DTM),
 * ignoring buildings and bridge decks (`exclude`, dilated by 2 m). OSM tree
 * points are kept as they are and suppress detections around them.
 */
export function detectTrees(dtm: Raster, dsm: Raster | null, exclude: Polygon[], osm: XY[], opts: TreeOptions = DEFAULT_TREE_OPTIONS): Tree[] {
  const { width: w, height: h, res } = dtm;
  const trees: Tree[] = [];
  const taken = new Uint8Array(w * h);
  const mark = (i: number, j: number, rad: number) => {
    const c = Math.ceil(rad / res);
    for (let y = Math.max(0, j - c); y <= Math.min(h - 1, j + c); y++) {
      for (let x = Math.max(0, i - c); x <= Math.min(w - 1, i + c); x++) {
        if ((x - i) ** 2 + (y - j) ** 2 <= c * c) taken[y * w + x] = 1;
      }
    }
  };
  const cellOf = (p: XY): [number, number] => [Math.floor((p[0] - dtm.minE) / res), Math.floor((dtm.maxN - p[1]) / res)];

  let chm: Raster | null = null;
  if (dsm) {
    const raw = new Float32Array(w * h);
    for (let k = 0; k < raw.length; k++) raw[k] = Math.max(0, dsm.data[k] - dtm.data[k]);
    chm = blur({ ...dtm, data: raw }, 1, 1);
  }

  for (const p of osm) {
    const [i, j] = cellOf(p);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    let top = 0;
    if (chm) for (let y = Math.max(0, j - 2); y <= Math.min(h - 1, j + 2); y++) for (let x = Math.max(0, i - 2); x <= Math.min(w - 1, i + 2); x++) top = Math.max(top, chm.data[y * w + x]);
    const ht = top >= opts.minHeight ? Math.min(top, 40) : 8;
    const r = crownRadius(ht);
    trees.push({ p, h: ht, r, source: 'osm' });
    mark(i, j, r * 0.7);
  }
  if (!chm) return trees;

  const skip = dilate(rasterizePolygons(exclude, dtm), w, h, Math.ceil(2 / res));
  const cand: number[] = [];
  const d = chm.data;
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const k = j * w + i, v = d[k];
      if (v < opts.minHeight || v > 45 || skip[k]) continue;
      if (v >= d[k - 1] && v >= d[k + 1] && v >= d[k - w] && v >= d[k + w] && v >= d[k - w - 1] && v >= d[k - w + 1] && v >= d[k + w - 1] && v >= d[k + w + 1]) cand.push(k);
    }
  }
  cand.sort((a, b) => d[b] - d[a]);
  let detected = 0;
  for (const k of cand) {
    if (taken[k]) continue;
    const i = k % w, j = (k - i) / w;
    const ht = d[k], r = crownRadius(ht);
    trees.push({ p: [dtm.minE + (i + 0.5) * res, dtm.maxN - (j + 0.5) * res], h: ht, r, source: 'lidar' });
    mark(i, j, r * 0.7);
    if (++detected >= opts.max) break;
  }
  return trees;
}

// ---------------------------------------------------------------- geometry

const T = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]]
  .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];

/**
 * Low-poly trees: a six-sided trunk and an icosahedral crown (32 triangles each),
 * every tree its own part. `zAt` gives local ground height.
 */
export function treesMesh(trees: Tree[], origin: XY, zAt: (x: number, y: number) => number): Mesh {
  const SIDES = 6;
  const perTreeV = SIDES * 2 + 2 + 12;
  const pos = new Float32Array(trees.length * perTreeV * 3);
  const idx: number[] = [];
  const parts: [string, number, number][] = [];
  trees.forEach((t, n) => {
    const x = t.p[0] - origin[0], y = t.p[1] - origin[1];
    const z0 = zAt(x, y);
    const base = n * perTreeV;
    let o = base * 3;
    const put = (a: number, b: number, c: number) => { pos[o++] = a; pos[o++] = b; pos[o++] = c; };
    const tr = Math.max(0.12, 0.012 * t.h), th = t.h * 0.4;
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      put(x + Math.cos(a) * tr, y + Math.sin(a) * tr, z0 - 0.2);
    }
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      put(x + Math.cos(a) * tr, y + Math.sin(a) * tr, z0 + th);
    }
    put(x, y, z0 - 0.2); put(x, y, z0 + th);
    const cz = z0 + t.h * 0.65, rz = t.h * 0.35;
    for (const [vx, vy, vz] of ICO_V) put(x + vx * t.r, y + vy * t.r, cz + vz * rz);
    const start = idx.length;
    const bot = base + SIDES * 2, top = bot + 1, ico = top + 1;
    for (let s = 0; s < SIDES; s++) {
      const s2 = (s + 1) % SIDES;
      idx.push(base + s, base + s2, base + SIDES + s2, base + s, base + SIDES + s2, base + SIDES + s);
      idx.push(bot, base + s2, base + s); // bottom cap faces down
      idx.push(top, base + SIDES + s, base + SIDES + s2);
    }
    for (let f = 0; f < ICO_F.length; f += 3) idx.push(ico + ICO_F[f], ico + ICO_F[f + 1], ico + ICO_F[f + 2]);
    parts.push([`tree_${n + 1}`, start, idx.length - start]);
  });
  return { positions: pos, indices: new Uint32Array(idx), parts };
}
