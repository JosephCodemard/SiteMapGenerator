import { downsample } from '../process/raster';
import type { Raster } from '../types';

/**
 * Pedestrian-level wind *screening* model (2.5D, empirical). It is NOT CFD: it combines
 *   1. open-terrain log-law at 1.5 m reduced by the upwind frontal-area index (urban roughness),
 *   2. shelter in the wake of tall obstacles (about 8 obstacle heights downwind),
 *   3. channelling along open streets flanked by tall buildings.
 * Use it to compare layouts and find likely windy or sheltered areas, not to certify comfort.
 */
export interface WindOptions {
  /** Direction the wind blows *from*, degrees clockwise from north. */
  from: number;
  /** Reference speed in open terrain at 10 m (m/s). */
  speed: number;
}

export type LawsonClass = 0 | 1 | 2 | 3 | 4; // sitting, standing, strolling, walking, uncomfortable

export const LAWSON_LABELS = ['Sitting (≤ 4 m/s)', 'Standing (≤ 6)', 'Strolling (≤ 8)', 'Walking (≤ 10)', 'Uncomfortable (> 10)'];
export const lawsonClass = (v: number): LawsonClass => (v <= 4 ? 0 : v <= 6 ? 1 : v <= 8 ? 2 : v <= 10 ? 3 : 4);

export interface WindResult {
  /** Pedestrian-level speed / reference speed (0 inside buildings). */
  ratio: Float32Array;
  speed: Float32Array;
  classes: Uint8Array;
  raster: Raster;
  /** Open-terrain pedestrian ratio the other values are relative to. */
  openRatio: number;
  /** Area share (of open ground) per Lawson class. */
  share: number[];
}

const OPEN_RATIO = 0.67; // ln(1.5 / 0.03) / ln(10 / 0.03)
const MAX_CELLS = 1_000_000;
const REACH = 120; // m of upwind terrain considered
const WAKE = 8; // wake length in obstacle heights

export function windField(dsm: Raster, dtm: Raster, opts: WindOptions): WindResult {
  const f = Math.max(1, Math.ceil(Math.sqrt((dsm.width * dsm.height) / MAX_CELLS)));
  const surf = downsample(dsm, f), ground = downsample(dtm, f);
  const { width: w, height: h, res } = surf;
  const H = new Float32Array(w * h); // obstacle height above ground
  for (let k = 0; k < H.length; k++) H[k] = Math.max(0, surf.data[k] - ground.data[k]);
  const th = (opts.from * Math.PI) / 180;
  const ux = Math.sin(th), uy = Math.cos(th); // unit vector pointing upwind
  const px = -uy, py = ux; // perpendicular
  const ratio = new Float32Array(w * h);
  const stepM = Math.max(res, 2);
  const sample = (i: number, j: number, dx: number, dy: number, d: number) => {
    const x = Math.round(i + (dx * d) / res), y = Math.round(j - (dy * d) / res);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : H[y * w + x];
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const own = H[j * w + i];
      if (own > 2) { ratio[j * w + i] = 0; continue; }
      let shelter = 0, sumAbove = 0, n = 0, open60 = 0, n60 = 0;
      for (let d = stepM; d <= REACH; d += stepM) {
        const hh = sample(i, j, ux, uy, d);
        if (hh < 0) break;
        n++;
        sumAbove += Math.max(0, hh - 1.5);
        if (d <= 60) { n60++; if (hh < 2) open60++; }
        if (hh > 3) shelter = Math.max(shelter, Math.max(0, 1 - d / (WAKE * hh)) * Math.min(1, (hh - 1.5) / hh));
      }
      const lambda = n ? sumAbove / n / 25 : 0;
      let r = OPEN_RATIO / (1 + 2.5 * lambda);
      r *= 1 - 0.75 * shelter;
      // Channelling: open upwind run, tall buildings on both sides.
      if (n60 && open60 / n60 >= 0.85) {
        let left = false, right = false;
        for (let d = 3; d <= 12 && !(left && right); d += 3) {
          if (sample(i, j, px, py, d) > 6) left = true;
          if (sample(i, j, -px, -py, d) > 6) right = true;
        }
        if (left && right) r *= 1.35;
      }
      ratio[j * w + i] = Math.min(1.8, Math.max(0.05, r));
    }
  }
  const speed = new Float32Array(ratio.length), classes = new Uint8Array(ratio.length);
  const counts = [0, 0, 0, 0, 0];
  let open = 0;
  for (let k = 0; k < ratio.length; k++) {
    if (!ratio[k]) continue;
    speed[k] = ratio[k] * opts.speed;
    classes[k] = lawsonClass(speed[k]);
    counts[classes[k]]++; open++;
  }
  return { ratio, speed, classes, raster: surf, openRatio: OPEN_RATIO, share: counts.map((c) => (open ? c / open : 0)) };
}
