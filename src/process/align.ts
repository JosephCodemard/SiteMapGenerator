import { pointInRings } from './clip';
import { blur } from './raster';
import type { Raster, Ring, XY } from '../types';

/**
 * OSM in England is mostly traced from aerial imagery, which can be offset from
 * the true ground position by 1-3 m. Estimate the shift that best fits OSM
 * footprints to LIDAR roofs: maximise (roof cells inside footprints) + (non-roof
 * cells in a 2 m band outside them), over shifts of up to ±3 m.
 */
export function estimateOffset(footprints: Ring[][], dtm: Raster, dsm: Raster, maxShift = 3): { offset: XY; gain: number } {
  const { width: w, height: h } = dtm;
  // Fractional footprint coverage per cell: centre test, then 4x4 supersampling on edge cells.
  const cover = new Float32Array(w * h);
  const boxes: [number, number, number, number, Ring[]][] = [];
  for (const rings of footprints) {
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const [e, n] of rings[0]) {
      minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const i0 = Math.max(0, Math.floor(minE - dtm.minE) - 1), i1 = Math.min(w - 1, Math.ceil(maxE - dtm.minE) + 1);
    const j0 = Math.max(0, Math.floor(dtm.maxN - maxN) - 1), j1 = Math.min(h - 1, Math.ceil(dtm.maxN - minN) + 1);
    boxes.push([i0, i1, j0, j1, rings]);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInRings(dtm.minE + i + 0.5, dtm.maxN - j - 0.5, rings)) cover[j * w + i] = 1;
      }
    }
  }
  const centre = Float32Array.from(cover);
  for (const [i0, i1, j0, j1, rings] of boxes) {
    for (let j = Math.max(1, j0); j <= Math.min(h - 2, j1); j++) {
      for (let i = Math.max(1, i0); i <= Math.min(w - 2, i1); i++) {
        const k = j * w + i, c = centre[k];
        if (centre[k - 1] === c && centre[k + 1] === c && centre[k - w] === c && centre[k + w] === c) continue;
        let n = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
          if (pointInRings(dtm.minE + i + (sx + 0.5) / 4, dtm.maxN - j - (sy + 0.5) / 4, rings)) n++;
        }
        cover[k] = Math.max(c ? 0 : cover[k], n / 16);
      }
    }
  }
  const inside: number[] = [], ring: number[] = [];
  for (let j = 3; j < h - 3; j++) {
    for (let i = 3; i < w - 3; i++) {
      const k = j * w + i;
      if (cover[k] > 0) inside.push(k);
      if (cover[k] < 1) {
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (cover[k + dy * w + dx] > 0) { near = true; break; }
        if (near) ring.push(k);
      }
    }
  }
  if (inside.length < 200) return { offset: [0, 0], gain: 0 };
  const sub = (a: number[]) => { const s = Math.max(1, Math.floor(a.length / 150_000)); return a.filter((_, n) => n % s === 0); };
  const ins = sub(inside), out = sub(ring);
  let wIn = 0, wOut = 0;
  for (const k of ins) wIn += cover[k];
  for (const k of out) wOut += 1 - cover[k];

  const binary = new Float32Array(w * h);
  for (let k = 0; k < binary.length; k++) binary[k] = dsm.data[k] - dtm.data[k] > 2.5 ? 1 : 0;
  // Soften roof edges slightly so the score is smooth between grid positions.
  const roof = blur({ ...dtm, data: binary }, 1, 1).data;
  const at = (x: number, y: number) => {
    x = Math.min(Math.max(x, 0), w - 1.001); y = Math.min(Math.max(y, 0), h - 1.001);
    const i = Math.floor(x), j = Math.floor(y), tx = x - i, ty = y - j, k = j * w + i;
    return (1 - tx) * (1 - ty) * roof[k] + tx * (1 - ty) * roof[k + 1] + (1 - tx) * ty * roof[k + w] + tx * ty * roof[k + w + 1];
  };
  // Shifting footprints by (+dx east, +dy north) compares them with roofs at col + dx, row - dy.
  const score = (dx: number, dy: number) => {
    let a = 0, b = 0;
    for (const k of ins) { const i = k % w; a += cover[k] * at(i + dx, (k - i) / w - dy); }
    for (const k of out) { const i = k % w; b += (1 - cover[k]) * at(i + dx, (k - i) / w - dy); }
    return a / wIn + 1 - b / wOut;
  };
  const base = score(0, 0);
  let best: XY = [0, 0], bestS = base;
  for (let dx = -maxShift; dx <= maxShift; dx++) {
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      const s = score(dx, dy);
      if (s > bestS) { bestS = s; best = [dx, dy]; }
    }
  }
  // Fine search; with metre-gridded data the optimum is often a flat plateau,
  // so take the centroid of all shifts scoring within a hair of the best.
  const fine: [number, number, number][] = [];
  for (let dx = best[0] - 1; dx <= best[0] + 1 + 1e-9; dx += 0.25) {
    for (let dy = best[1] - 1; dy <= best[1] + 1 + 1e-9; dy += 0.25) {
      if (Math.abs(dx) > maxShift || Math.abs(dy) > maxShift) continue;
      fine.push([dx, dy, score(dx, dy)]);
    }
  }
  bestS = Math.max(bestS, ...fine.map((f) => f[2]));
  const top = fine.filter((f) => f[2] >= bestS - 1e-3);
  best = [top.reduce((a, f) => a + f[0], 0) / top.length, top.reduce((a, f) => a + f[1], 0) / top.length];
  // Ignore tiny improvements (noise, or no buildings with clear roofs).
  return bestS - base > 0.01 ? { offset: best, gain: bestS - base } : { offset: [0, 0], gain: 0 };
}
