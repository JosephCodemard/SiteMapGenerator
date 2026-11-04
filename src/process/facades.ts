import { openRing, signedArea } from './clip';
import { mergeMeshes } from './geom';
import type { Mesh } from './mesh';
import { edgeDistance } from './roofs';
import type { Building, XY } from '../types';
import type { Entrance } from '../analysis/entrances';

/**
 * "LOD3-lite" facades, PROCEDURAL (not surveyed): there is no open elevation imagery, so facade detail is
 * generated from the data we do have: storeys (OSM `building:levels`, else height / 3.2 m), eaves height,
 * footprint edges (bay widths), party walls (edges shared with a neighbour get nothing), and entrances
 * (doors at OSM/inferred entrance positions). Everything protrudes slightly from the wall as separate objects
 * on their own layers, so it can be switched off or deleted without touching the building.
 */
export interface FacadeOptions {
  /** Bay width (m): one window per bay. */
  bay: number;
  windowHeight: number;
  /** Sill height above the floor (m). */
  sill: number;
  /** How far windows and string courses stand off the wall (m). */
  depth: number;
  /** Stop adding boxes beyond this many (keeps the model light). */
  maxBoxes: number;
}

export const DEFAULT_FACADE: FacadeOptions = { bay: 1.2, windowHeight: 1.4, sill: 0.9, depth: 0.08, maxBoxes: 60_000 };

export interface FacadeResult {
  windows: Mesh | null;
  doors: Mesh | null;
  courses: Mesh | null;
  stats: { windows: number; doors: number; courses: number; capped: boolean };
}

/** Box with its x-axis along the wall normal (0..depth), y-axis along the wall (±half), z-axis up: right-handed, outward faces. */
function wallBox(c: XY, d: XY, n: XY, depth: number, half: number, z0: number, z1: number, origin: XY): { p: number[]; i: number[] } {
  const corner = (x: number, y: number, z: number) => [c[0] + n[0] * x + d[0] * y - origin[0], c[1] + n[1] * x + d[1] * y - origin[1], z];
  const p = [
    ...corner(0, -half, z0), ...corner(depth, -half, z0), ...corner(depth, half, z0), ...corner(0, half, z0),
    ...corner(0, -half, z1), ...corner(depth, -half, z1), ...corner(depth, half, z1), ...corner(0, half, z1),
  ];
  return { p, i: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
}

export const levelsOf = (b: Building) => {
  const tagged = parseInt(b.tags['building:levels'] ?? '', 10);
  return tagged > 0 ? tagged : Math.max(1, Math.round((b.top - b.ground) / 3.2));
};

/**
 * Storeys that stand in the walls (below the eaves). A mansard or steep roof holds the top floor, lit by dormers, so
 * it does not count: with `building:levels` the tagged `roof:levels` (else 1 for a mansard) is taken off; without it
 * the count comes from the eaves height rather than the ridge.
 */
export function wallLevels(b: Building): number {
  const parts = b.roofParts ?? [];
  const attic = parts.some((r) => r.type === 'mansard' || (r.type !== 'flat' && r.type !== 'surface' && r.b > 0 && (r.ridge - r.eaves) / r.b >= 0.7));
  const eaves = parts.length ? Math.min(...parts.map((r) => r.eaves)) : b.top;
  const tagged = parseInt(b.tags['building:levels'] ?? '', 10);
  if (tagged > 0) {
    const roofLevels = parseInt(b.tags['roof:levels'] ?? '', 10);
    return Math.max(1, tagged - (roofLevels > 0 ? roofLevels : attic ? 1 : 0));
  }
  return Math.max(1, Math.round((eaves - b.ground) / 3.2));
}

export function buildFacades(buildings: Building[], entrances: Entrance[], origin: XY, opt: FacadeOptions = DEFAULT_FACADE): FacadeResult {
  const win: { name: string; mesh: Mesh }[] = [], door: { name: string; mesh: Mesh }[] = [], band: { name: string; mesh: Mesh }[] = [];
  const stats = { windows: 0, doors: 0, courses: 0, capped: false };
  const entrancesBy = new Map<string, Entrance[]>();
  for (const e of entrances) (entrancesBy.get(e.buildingId) ?? entrancesBy.set(e.buildingId, []).get(e.buildingId)!).push(e);
  const boxes = () => stats.windows + stats.doors + stats.courses;
  const bboxes = buildings.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of b.rings[0]) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  });
  /** Is this wall midpoint on (or against) another building's outline? */
  const shared = (self: number, m: XY) => buildings.some((o, k) => k !== self && m[0] >= bboxes[k][0] && m[0] <= bboxes[k][2] && m[1] >= bboxes[k][1] && m[1] <= bboxes[k][3] && edgeDistance(m[0], m[1], o.rings) < 0.6);

  for (let bi = 0; bi < buildings.length && boxes() < opt.maxBoxes; bi++) {
    const b = buildings[bi];
    const levels = wallLevels(b);
    const top = b.roofParts?.length ? Math.min(...b.roofParts.map((r) => r.eaves)) : b.top;
    const storey = (top - b.ground) / levels;
    if (storey < 2) continue;
    let ring = openRing(b.rings[0]);
    if (signedArea(ring) < 0) ring = [...ring].reverse();
    const wp: number[] = [], wi: number[] = [], dp: number[] = [], di: number[] = [], cp: number[] = [], ci: number[] = [];
    const W = { p: wp, i: wi }, D = { p: dp, i: di }, C = { p: cp, i: ci };
    const put = (t: { p: number[]; i: number[] }, box: { p: number[]; i: number[] }) => { const base = t.p.length / 3; t.p.push(...box.p); t.i.push(...box.i.map((x) => x + base)); };
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], c2 = ring[(k + 1) % ring.length];
      const len = Math.hypot(c2[0] - a[0], c2[1] - a[1]);
      if (len < 3) continue;
      const d: XY = [(c2[0] - a[0]) / len, (c2[1] - a[1]) / len];
      const n: XY = [d[1], -d[0]]; // outward for a counter-clockwise ring
      const mid: XY = [(a[0] + c2[0]) / 2, (a[1] + c2[1]) / 2];
      if (shared(bi, mid)) continue;
      const at = (s: number): XY => [a[0] + d[0] * s, a[1] + d[1] * s];
      // String courses at every floor line and under the eaves.
      for (let s = 1; s <= levels && boxes() < opt.maxBoxes; s++) {
        const z = b.ground + s * storey;
        put(C, wallBox(mid, d, n, opt.depth * 1.5, len / 2 - 0.1, z - 0.2, z, origin)); stats.courses++;
      }
      const bays = Math.floor((len - 1) / opt.bay);
      const x0 = (len - bays * opt.bay) / 2;
      // Door position: the bay nearest an entrance on this wall.
      let doorBay = -1;
      for (const e of entrancesBy.get(b.id) ?? []) {
        const t = (e.p[0] - a[0]) * d[0] + (e.p[1] - a[1]) * d[1];
        const dist = Math.abs((e.p[0] - a[0]) * n[0] + (e.p[1] - a[1]) * n[1]);
        if (t > 0 && t < len && dist < 1.5) doorBay = Math.min(bays - 1, Math.max(0, Math.floor((t - x0) / opt.bay)));
      }
      for (let bay = 0; bay < bays && boxes() < opt.maxBoxes; bay++) {
        const centre = at(x0 + (bay + 0.5) * opt.bay);
        for (let s = 0; s < levels; s++) {
          const zb = b.ground + s * storey;
          if (s === 0 && bay === doorBay) {
            put(D, wallBox(centre, d, n, opt.depth, 0.5, zb, zb + Math.min(2.2, storey - 0.3), origin)); stats.doors++;
            continue;
          }
          const h = Math.min(opt.windowHeight, storey - opt.sill - 0.45);
          if (h < 0.6) continue;
          put(W, wallBox(centre, d, n, opt.depth, Math.min(0.45, opt.bay * 0.36), zb + opt.sill, zb + opt.sill + h, origin)); stats.windows++;
        }
      }
    }
    const id = b.id.replace(/[^\w#-]/g, '_');
    const mk = (p: number[], i: number[]): Mesh => ({ positions: Float32Array.from(p), indices: Uint32Array.from(i) });
    if (wp.length) win.push({ name: `windows_${id}`, mesh: mk(wp, wi) });
    if (dp.length) door.push({ name: `doors_${id}`, mesh: mk(dp, di) });
    if (cp.length) band.push({ name: `courses_${id}`, mesh: mk(cp, ci) });
  }
  stats.capped = boxes() >= opt.maxBoxes;
  return { windows: win.length ? mergeMeshes(win) : null, doors: door.length ? mergeMeshes(door) : null, courses: band.length ? mergeMeshes(band) : null, stats };
}
