import { sunPosition, sunTimes, sunVector, type Sun } from './sun';
import { downsample } from '../process/raster';
import type { Raster } from '../types';

/**
 * Heightfield shadow casting on the DSM (buildings, trees and terrain all cast shadows).
 * A cell is in shadow when, marching towards the sun, the surface rises above the sun ray.
 */
export function shadowMask(dsm: Raster, sun: Sun, maxDistance = 400): Uint8Array {
  const { width: w, height: h, data, res } = dsm;
  const out = new Uint8Array(w * h);
  if (sun.altitude <= 0) return out.fill(1);
  const { dx, dy, tanAlt } = sunVector(sun);
  let zmax = -Infinity;
  for (let k = 0; k < data.length; k++) if (data[k] > zmax) zmax = data[k];
  const step = res; // metres per sample along the ray
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const z0 = data[j * w + i];
      const reach = Math.min(maxDistance, (zmax - z0) / tanAlt);
      let shaded = 0;
      for (let d = step; d <= reach; d += step) {
        // North is up (row 0), so +northing = -row.
        const x = i + (dx * d) / res, y = j - (dy * d) / res;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) break;
        if (data[yi * w + xi] > z0 + d * tanAlt + 0.05) { shaded = 1; break; }
      }
      out[j * w + i] = shaded;
    }
  }
  return out;
}

export interface SunHours {
  /** Hours of direct sun per cell. */
  hours: Float32Array;
  raster: Raster;
  /** Hours between sunrise and sunset at the site (the maximum possible). */
  daylight: number;
  samples: number;
}

/** Cap on cells for the sun-hours run (the DSM is block-averaged to fit). */
const MAX_CELLS = 1_500_000;

/**
 * Hours of direct sun on `day` (UTC date): shadows sampled every `stepMinutes` between sunrise and sunset.
 * `lat`/`lon` locate the site (the sun is computed once for its centre).
 */
export function sunHours(dsm: Raster, day: Date, lat: number, lon: number, stepMinutes = 30, progress?: (f: number) => void): SunHours {
  const f = Math.max(1, Math.ceil(Math.sqrt((dsm.width * dsm.height) / MAX_CELLS)));
  const r = downsample(dsm, f);
  const hours = new Float32Array(r.width * r.height);
  const t = sunTimes(day, lat, lon);
  if (!t) return { hours, raster: r, daylight: 0, samples: 0 };
  const daylight = (t.set.getTime() - t.rise.getTime()) / 3600000;
  const n = Math.max(1, Math.round((daylight * 60) / stepMinutes));
  let samples = 0;
  for (let k = 0; k < n; k++) {
    // Midpoint of each slice, so the totals add up to the day length.
    const when = new Date(t.rise.getTime() + ((k + 0.5) / n) * (t.set.getTime() - t.rise.getTime()));
    const sun = sunPosition(when, lat, lon);
    if (sun.altitude <= 0.5) continue;
    const m = shadowMask(r, sun);
    for (let c = 0; c < m.length; c++) if (!m[c]) hours[c] += daylight / n;
    samples++;
    progress?.((k + 1) / n);
  }
  return { hours, raster: r, daylight, samples };
}
