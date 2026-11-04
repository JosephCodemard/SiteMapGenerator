import { pointInRings } from '../process/clip';
import { edgeDistance } from '../process/roofs';
import type { Building, Raster, Ring } from '../types';

/**
 * Screening flood extent on the DTM. These are *indicative* extents, not a flood-risk assessment.
 *
 * Bathtub: water at `level` (m ODN) spreads from the source cells to every connected cell lower than the level.
 * Defences are walls of `defenceHeight` above the ground along the given lines.
 */
export interface FloodResult {
  /** Depth (m) per cell, 0 where dry. */
  depth: Float32Array;
  raster: Raster;
  floodedCells: number;
  /** Flooded area (m²) and volume (m³). */
  area: number;
  volume: number;
  maxDepth: number;
}

export interface FloodOptions {
  level: number;
  /** Cells where water starts (e.g. the river): 1 = source. */
  sources: Uint8Array;
  /** Defence lines in BNG and their height above ground (m). */
  defences?: { lines: Ring[]; height: number };
}

/** Raise the ground by `height` along each line so the fill cannot pass. */
function applyDefences(dtm: Raster, lines: Ring[], height: number): Float32Array {
  const out = Float32Array.from(dtm.data);
  for (const l of lines) {
    for (let i = 0; i < l.length - 1; i++) {
      const [a, b] = [l[i], l[i + 1]];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (dtm.res * 0.5)));
      for (let s = 0; s <= n; s++) {
        const e = a[0] + ((b[0] - a[0]) * s) / n, nn = a[1] + ((b[1] - a[1]) * s) / n;
        const ci = Math.floor((e - dtm.minE) / dtm.res), cj = Math.floor((dtm.maxN - nn) / dtm.res);
        // Thicken by one cell so a 4-connected fill can't slip through a diagonal gap.
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) {
          const x = ci + ox, y = cj + oy;
          if (x >= 0 && y >= 0 && x < dtm.width && y < dtm.height) out[y * dtm.width + x] = dtm.data[y * dtm.width + x] + height;
        }
      }
    }
  }
  return out;
}

export function bathtubFlood(dtm: Raster, opts: FloodOptions): FloodResult {
  const { width: w, height: h } = dtm;
  const ground = opts.defences ? applyDefences(dtm, opts.defences.lines, opts.defences.height) : dtm.data;
  const wet = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let k = 0; k < wet.length; k++) if (opts.sources[k]) { wet[k] = 1; stack.push(k); }
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w, y = (k - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (!wet[q] && ground[q] < opts.level) { wet[q] = 1; stack.push(q); }
    }
  }
  const depth = new Float32Array(w * h);
  let cells = 0, volume = 0, maxDepth = 0;
  const a = dtm.res * dtm.res;
  for (let k = 0; k < wet.length; k++) {
    if (!wet[k]) continue;
    // Depth is measured to the real ground (a defence's crest is not a floor).
    const d = opts.level - dtm.data[k];
    if (d > 0.005) { depth[k] = d; cells++; volume += d * a; maxDepth = Math.max(maxDepth, d); }
  }
  return { depth, raster: dtm, floodedCells: cells, area: cells * a, volume, maxDepth };
}

/**
 * Surface-water ponding: depth of every closed depression (priority-flood from the edges, Barnes 2014).
 * Water that can run off the site does not pond.
 */
export function pondingDepth(dtm: Raster): FloodResult {
  const { width: w, height: h, data } = dtm;
  const filled = Float32Array.from(data);
  const done = new Uint8Array(w * h);
  // Binary min-heap of (level, index).
  const hk: number[] = [], hi: number[] = [];
  const push = (key: number, idx: number) => {
    let i = hk.length; hk.push(key); hi.push(idx);
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= key) break; hk[i] = hk[p]; hi[i] = hi[p]; i = p; }
    hk[i] = key; hi[i] = idx;
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [hk[0], hi[0]];
    const key = hk.pop()!, idx = hi.pop()!;
    if (hk.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hk.length) break;
        if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= key) break;
        hk[i] = hk[c]; hi[i] = hi[c]; i = c;
      }
      hk[i] = key; hi[i] = idx;
    }
    return top;
  };
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const k = y * w + x; if (!done[k]) { done[k] = 1; push(data[k], k); } }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const k = y * w + x; if (!done[k]) { done[k] = 1; push(data[k], k); } }
  while (hk.length) {
    const [lvl, k] = pop();
    const x = k % w, y = (k - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (done[q]) continue;
      done[q] = 1;
      filled[q] = Math.max(data[q], lvl);
      push(filled[q], q);
    }
  }
  const depth = new Float32Array(w * h);
  let cells = 0, volume = 0, maxDepth = 0;
  const a = dtm.res * dtm.res;
  for (let k = 0; k < depth.length; k++) {
    const d = filled[k] - data[k];
    if (d > 0.02) { depth[k] = d; cells++; volume += d * a; maxDepth = Math.max(maxDepth, d); }
  }
  return { depth, raster: dtm, floodedCells: cells, area: cells * a, volume, maxDepth };
}

export interface BuildingFlood {
  id: string;
  /** Deepest water against the footprint (m). */
  depth: number;
  /** Share of the footprint cells that are wet. */
  wetFraction: number;
}

/** Per-building flood depth: the deepest wet cell inside, or touching, the footprint. */
export function buildingFlood(buildings: Building[], flood: FloodResult, threshold = 0.05): BuildingFlood[] {
  const r = flood.raster;
  const out: BuildingFlood[] = [];
  for (const b of buildings) {
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const [e, n] of b.rings[0]) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
    const i0 = Math.max(0, Math.floor((minE - 1 - r.minE) / r.res)), i1 = Math.min(r.width - 1, Math.ceil((maxE + 1 - r.minE) / r.res));
    const j0 = Math.max(0, Math.floor((r.maxN - maxN - 1) / r.res)), j1 = Math.min(r.height - 1, Math.ceil((r.maxN - minN + 1) / r.res));
    let depth = 0, wet = 0, inside = 0;
    for (let j = j0; j <= j1; j++) {
      const n = r.maxN - (j + 0.5) * r.res;
      for (let i = i0; i <= i1; i++) {
        const e = r.minE + (i + 0.5) * r.res;
        const d = flood.depth[j * r.width + i];
        const inFoot = pointInRings(e, n, b.rings);
        if (inFoot) { inside++; if (d > threshold) wet++; }
        // Water standing against a wall (within 1.5 m of the footprint) counts as well as water inside.
        if (d > depth && (inFoot || edgeDistance(e, n, b.rings) <= 1.5)) depth = d;
      }
    }
    if (depth > threshold) out.push({ id: b.id, depth, wetFraction: inside ? wet / inside : 0 });
  }
  return out;
}
