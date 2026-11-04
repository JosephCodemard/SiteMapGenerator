import type { Mesh } from './mesh';
import type { Ring, XY } from '../types';

/** Resample a polyline to roughly `spacing` metres between points (keeps the original vertices' shape). */
export function resample(line: Ring, spacing: number): XY[] {
  const out: XY[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / spacing));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

export function polylineLength(line: Ring): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return s;
}

/**
 * Left/right outline of a ribbon of total width `2 * half` around a polyline (miter-limited),
 * as two point lists of the same length.
 */
export function offsetOutline(pts: XY[], half: number): { left: XY[]; right: XY[] } {
  const n = pts.length;
  const dir = (i: number): XY => {
    const a = pts[Math.max(0, i)], b = pts[Math.min(n - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const left: XY[] = [], right: XY[] = [];
  for (let i = 0; i < n; i++) {
    const d0 = dir(i - 1), d1 = dir(i);
    const nx = -(d0[1] + d1[1]), ny = d0[0] + d1[0];
    const len = Math.hypot(nx, ny) || 1;
    // Miter length: half / cos(theta / 2), limited to 1.5x.
    const cos = Math.max(0.67, (nx / len) * -d1[1] + (ny / len) * d1[0]);
    const k = half / cos;
    left.push([pts[i][0] + (nx / len) * k, pts[i][1] + (ny / len) * k]);
    right.push([pts[i][0] - (nx / len) * k, pts[i][1] - (ny / len) * k]);
  }
  return { left, right };
}

/**
 * Closed solid ribbon along a polyline (bridge decks, walls): top surface at
 * `zTop[i]`, extending `depth` metres down, with end caps. Local coordinates.
 */
export function ribbonSolid(pts: XY[], zTop: number[], half: number, depth: number): Mesh {
  const n = pts.length;
  const { left, right } = offsetOutline(pts, half);
  const pos = new Float32Array(n * 4 * 3);
  // Layout per station i: 4i = left top, 4i+1 = right top, 4i+2 = left bottom, 4i+3 = right bottom.
  for (let i = 0; i < n; i++) {
    const set = (k: number, p: XY, z: number) => { pos[(4 * i + k) * 3] = p[0]; pos[(4 * i + k) * 3 + 1] = p[1]; pos[(4 * i + k) * 3 + 2] = z; };
    set(0, left[i], zTop[i]); set(1, right[i], zTop[i]);
    set(2, left[i], zTop[i] - depth); set(3, right[i], zTop[i] - depth);
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [lt, rt, lb, rb] = [4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3];
    const [lt2, rt2, lb2, rb2] = [lt + 4, rt + 4, lb + 4, rb + 4];
    idx.push(rt, rt2, lt2, rt, lt2, lt); // top
    idx.push(lb, lb2, rb2, lb, rb2, rb); // bottom
    idx.push(lt, lb2, lb, lt, lt2, lb2); // left side
    idx.push(rt, rb, rb2, rt, rb2, rt2); // right side
  }
  const e = 4 * (n - 1);
  idx.push(0, 2, 3, 0, 3, 1); // start cap (faces backwards)
  idx.push(e, e + 1, e + 3, e, e + 3, e + 2); // end cap
  return { positions: pos, indices: new Uint32Array(idx) };
}
