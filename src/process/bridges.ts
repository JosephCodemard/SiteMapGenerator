import type { BridgeLine } from './context';
import type { Mesh } from './mesh';
import { offsetOutline, polylineLength, resample, ribbonSolid } from './ribbon';
import type { Raster, XY } from '../types';

/**
 * Bridge as a set of named solids, built for later 3D modelling rather than as one slab:
 * - the deck, whose top follows the LIDAR surface between the abutments and is pinned to the approach road at both
 *   ends (blended over 8 m), with a thickness that grows with the span;
 * - a parapet along each edge;
 * - an abutment at each end, down to the lowest ground across the deck;
 * - piers under long spans wherever the ground is more than 2 m below the soffit.
 */
export interface BridgeOptions {
  /** Height of the parapet above the deck (m). */
  parapet: number;
  /** Surface the approach road sits on above the ground (m): the deck ends meet it. */
  roadLift: number;
}

/** Closed box with its x-axis along `dir`: centre `c`, half-length `hl`, half-width `hw`. Outward faces. */
function obox(c: XY, dir: XY, hl: number, hw: number, z0: number, z1: number): Mesh {
  const n: XY = [-dir[1], dir[0]];
  const corner = (a: number, b: number, z: number) => [c[0] + dir[0] * a + n[0] * b, c[1] + dir[1] * a + n[1] * b, z];
  const p = [corner(-hl, -hw, z0), corner(hl, -hw, z0), corner(hl, hw, z0), corner(-hl, hw, z0), corner(-hl, -hw, z1), corner(hl, -hw, z1), corner(hl, hw, z1), corner(-hl, hw, z1)].flat();
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
}

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

export function buildBridge(b: BridgeLine, id: string, origin: XY, ground: (x: number, y: number) => number, dsm: Raster | null, opt: BridgeOptions): { name: string; mesh: Mesh }[] {
  const pts = resample(b.coords.map(([e, n]) => [e - origin[0], n - origin[1]] as XY), 2);
  const n = pts.length;
  if (n < 2) return [];
  const half = b.width / 2;
  const span = polylineLength(b.coords);
  const g = pts.map(([x, y]) => ground(x, y));
  const dirAt = (k: number): XY => {
    const p = pts[Math.max(0, k - 1)], q = pts[Math.min(n - 1, k + 1)];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  // Lowest DSM across the deck at each station: ignores buildings standing on the bridge.
  const raw = pts.map((p, k) => {
    if (!dsm) return g[k] + 0.5;
    const d = dirAt(k);
    let m = Infinity;
    for (const off of [-half * 0.6, -half * 0.3, 0, half * 0.3, half * 0.6]) {
      const e = p[0] + origin[0] - d[1] * off, nn = p[1] + origin[1] + d[0] * off;
      const i = Math.floor((e - dsm.minE) / dsm.res), j = Math.floor((dsm.maxN - nn) / dsm.res);
      if (i >= 0 && j >= 0 && i < dsm.width && j < dsm.height) m = Math.min(m, dsm.data[j * dsm.width + i]);
    }
    return Number.isFinite(m) ? m : g[k];
  });
  const sm = raw.map((_, k) => { let s = 0, c = 0; for (let o = -3; o <= 3; o++) { const q = k + o; if (q >= 0 && q < n) { s += raw[q]; c++; } } return s / c; });
  const rise = Math.min(8, 1 + span * 0.08);
  const roadEnd = [g[0] + opt.roadLift, g[n - 1] + opt.roadLift];
  const dist = pts.map((_, k) => Math.min(k, n - 1 - k) * (span / Math.max(1, n - 1)));
  const top = sm.map((z, k) => {
    const lin = g[0] + (g[n - 1] - g[0]) * (n > 1 ? k / (n - 1) : 0);
    const free = Math.min(Math.max(z, g[k] + 0.3), Math.max(lin, g[k]) + rise);
    // Pin the deck to the road at each end, then let it follow the LIDAR in the middle.
    const end = k < n / 2 ? roadEnd[0] : roadEnd[1];
    const w = smooth(dist[k] / 8);
    return end * (1 - w) + free * w;
  });
  const thick = Math.min(1.8, Math.max(0.8, 0.6 + 0.02 * span));
  const out: { name: string; mesh: Mesh }[] = [{ name: `bridge_${id}`, mesh: ribbonSolid(pts, top, half, thick) }];

  // Parapets along both edges.
  const { left, right } = offsetOutline(pts, Math.max(0.2, half - 0.15));
  [['L', left], ['R', right]].forEach(([tag, line]) => {
    out.push({ name: `bridge_${id}_parapet_${tag}`, mesh: ribbonSolid(line as XY[], top.map((z) => z + opt.parapet), 0.15, opt.parapet + 0.05) });
  });

  // Abutments: from the lowest ground across the deck up to the soffit.
  const lowestAcross = (k: number) => {
    const d = dirAt(k);
    let m = g[k];
    for (const off of [-half, -half / 2, half / 2, half]) m = Math.min(m, ground(pts[k][0] - d[1] * off, pts[k][1] + d[0] * off));
    return m;
  };
  [0, n - 1].forEach((k, side) => {
    const d = dirAt(k);
    const c: XY = [pts[k][0] + d[0] * (side ? -0.6 : 0.6), pts[k][1] + d[1] * (side ? -0.6 : 0.6)];
    const z0 = lowestAcross(k) - 0.3, z1 = top[k] - thick + 0.05;
    if (z1 - z0 > 0.4) out.push({ name: `bridge_${id}_abutment_${side ? 'B' : 'A'}`, mesh: obox(c, d, 0.6, half, z0, z1) });
  });

  // Piers under long spans.
  if (span > 25) {
    const count = Math.ceil(span / 18) - 1;
    for (let q = 1; q <= count; q++) {
      const k = Math.round((q / (count + 1)) * (n - 1));
      const d = dirAt(k);
      const gz = Math.min(g[k], lowestAcross(k));
      const z1 = top[k] - thick + 0.05;
      if (z1 - gz < 2) continue;
      out.push({ name: `bridge_${id}_pier_${q}`, mesh: obox(pts[k], d, 0.7, half * 0.7, gz - 0.3, z1) });
    }
  }
  return out;
}
