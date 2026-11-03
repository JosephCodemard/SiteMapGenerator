import type { Raster } from '../types';

/**
 * Fill NaN cells by repeatedly averaging valid 8-neighbours, growing inwards
 * from the edges of each hole. Returns the number of cells filled.
 */
export function fillNoData(r: Raster): number {
  const { width: w, height: h, data } = r;
  const isHole = (k: number) => Number.isNaN(data[k]);
  let frontier: number[] = [];
  let holes = 0;
  for (let k = 0; k < data.length; k++) {
    if (!isHole(k)) continue;
    holes++;
    if (neighbours(k, w, h).some((n) => !isHole(n))) frontier.push(k);
  }
  if (holes === data.length) throw new Error('No LIDAR coverage in this area');
  const queued = new Uint8Array(data.length);
  frontier.forEach((k) => (queued[k] = 1));
  while (frontier.length) {
    const vals = frontier.map((k) => {
      let s = 0, c = 0;
      for (const n of neighbours(k, w, h)) if (!isHole(n)) { s += data[n]; c++; }
      return s / c;
    });
    frontier.forEach((k, i) => (data[k] = vals[i]));
    const next: number[] = [];
    for (const k of frontier) {
      for (const n of neighbours(k, w, h)) {
        if (isHole(n) && !queued[n]) { queued[n] = 1; next.push(n); }
      }
    }
    frontier = next;
  }
  return holes;
}

function neighbours(k: number, w: number, h: number): number[] {
  const x = k % w, y = (k - x) / w;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
    }
  }
  return out;
}

/** Bilinear sample at a BNG point (clamped to the raster). */
export function sample(r: Raster, e: number, n: number): number {
  const fx = Math.min(Math.max((e - r.minE) / r.res - 0.5, 0), r.width - 1);
  const fy = Math.min(Math.max((r.maxN - n) / r.res - 0.5, 0), r.height - 1);
  const i = Math.min(Math.floor(fx), r.width - 2), j = Math.min(Math.floor(fy), r.height - 2);
  const tx = fx - i, ty = fy - j, d = r.data, w = r.width;
  const k = j * w + i;
  return (1 - tx) * (1 - ty) * d[k] + tx * (1 - ty) * d[k + 1] + (1 - tx) * ty * d[k + w] + tx * ty * d[k + w + 1];
}

/** Block-average downsample by an integer factor. */
export function downsample(r: Raster, f: number): Raster {
  if (f <= 1) return r;
  const w = Math.floor(r.width / f), h = Math.floor(r.height / f);
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) s += r.data[(j * f + y) * r.width + i * f + x];
      data[j * w + i] = s / (f * f);
    }
  }
  return { width: w, height: h, minE: r.minE, maxN: r.maxN, res: r.res * f, data };
}

/** Separable box blur, `passes` times (3 passes approximates a Gaussian). */
export function blur(r: Raster, radius: number, passes = 2): Raster {
  if (radius < 1) return r;
  const { width: w, height: h } = r;
  let src = Float32Array.from(r.data);
  let tmp = new Float32Array(src.length);
  const pass = (a: Float32Array, b: Float32Array, horizontal: boolean) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      const idx = (t: number) => (horizontal ? l * w + t : t * w + l);
      for (let t = 0; t < len; t++) {
        let s = 0, c = 0;
        for (let o = -radius; o <= radius; o++) {
          const u = t + o;
          if (u >= 0 && u < len) { s += a[idx(u)]; c++; }
        }
        b[idx(t)] = s / c;
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    pass(src, tmp, true);
    pass(tmp, src, false);
  }
  tmp = src;
  return { ...r, data: tmp };
}

export function minMax(data: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

/** Hillshade as RGBA bytes (ESRI formula, sun azimuth 315°, altitude 45°). */
export function hillshade(r: Raster, zFactor = 1): Uint8ClampedArray {
  const { width: w, height: h, data: d, res } = r;
  const out = new Uint8ClampedArray(w * h * 4);
  const zenith = (45 * Math.PI) / 180;
  const azimuth = ((360 - 315 + 90) * Math.PI) / 180;
  const at = (x: number, y: number) => d[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dzdx = ((at(x + 1, y) - at(x - 1, y)) * zFactor) / (2 * res); // east - west
      const dzdy = ((at(x, y + 1) - at(x, y - 1)) * zFactor) / (2 * res); // south - north
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const v = Math.cos(zenith) * Math.cos(slope) + Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);
      const k = (y * w + x) * 4;
      out[k] = out[k + 1] = out[k + 2] = 255 * Math.max(0, v);
      out[k + 3] = 255;
    }
  }
  return out;
}
