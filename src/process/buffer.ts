import * as CL from 'clipper-lib';
import { signedArea } from './clip';
import type { BBox, LineFeature, Ring } from '../types';

// clipper-lib is CommonJS; under Vite/Vitest the namespace may sit on `.default`.
export const ClipperLib: typeof CL = (CL as unknown as { default?: typeof CL }).default ?? CL;

/** Clipper works in integers; 100 units per metre gives centimetre precision. */
const S = 100;

/** A polygon: outer ring first, then holes. Rings are open (no repeated closing vertex). */
export type Polygon = Ring[];

/** Parse an OSM length such as "6", "6.5 m" or "20 ft" (metres). */
export function parseMetres(v?: string): number | null {
  if (!v) return null;
  const m = v.match(/^\s*([\d.]+)\s*(m|ft|')?\s*$/i);
  if (!m) return null;
  const x = parseFloat(m[1]);
  return m[2] && /ft|'/i.test(m[2]) ? x * 0.3048 : x;
}

const HIGHWAY_WIDTH: Record<string, number> = {
  motorway: 11, trunk: 11, primary: 9, secondary: 7.5, tertiary: 6.5,
  unclassified: 5.5, residential: 5.5, living_street: 5, road: 5.5, busway: 6,
  service: 3.5, track: 3, pedestrian: 4, footway: 2, path: 2, cycleway: 2.5, bridleway: 2.5, corridor: 2, steps: 1.5,
};

/** Width in metres of a linear feature: `width` tag, then lanes, then a class default. */
export function lineWidth(l: Pick<LineFeature, 'kind' | 'tags'>): number {
  const t = l.tags;
  const tagged = parseMetres(t.width) ?? parseMetres(t.est_width);
  if (tagged && tagged > 0.3) return Math.min(tagged, 60);
  switch (l.kind) {
    case 'rail': return 3.5 * Math.max(1, parseInt(t.tracks ?? '1', 10) || 1);
    case 'river': return t.waterway === 'canal' ? 6 : 8;
    case 'stream': return 1.5;
    case 'wall': return /^(fence)$/.test(t.barrier ?? '') ? 0.1 : 0.4;
    default: {
      const lanes = parseInt(t.lanes ?? '', 10);
      if (lanes > 0 && l.kind.startsWith('road')) return lanes * 3.25;
      return HIGHWAY_WIDTH[t.highway ?? ''] ?? (l.kind === 'path' ? 2 : 5.5);
    }
  }
}

const toPath = (r: Ring, ox: number, oy: number): CL.Path => r.map(([e, n]) => ({ X: Math.round((e - ox) * S), Y: Math.round((n - oy) * S) }));
const fromPath = (p: CL.Path, ox: number, oy: number): Ring => p.map((q) => [q.X / S + ox, q.Y / S + oy] as [number, number]);

function exPolygons(tree: CL.PolyTree, ox: number, oy: number): Polygon[] {
  const out: Polygon[] = [];
  for (const ex of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    const clean = (p: CL.Path) => ClipperLib.Clipper.CleanPolygon(p, 0.03 * S) ?? p;
    const outer = fromPath(clean(ex.outer), ox, oy);
    if (outer.length < 3) continue;
    out.push([outer, ...ex.holes.map((h) => fromPath(clean(h), ox, oy)).filter((h) => h.length >= 3)]);
  }
  return out;
}

function runUnion(subject: CL.Paths, bbox: BBox | undefined, ox: number, oy: number): Polygon[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  const merged = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  // Grow by 1 cm: outlines that merely touch at a point (a hole meeting its outer ring) overlap and merge,
  // which keeps the extruded solids manifold.
  const co = new ClipperLib.ClipperOffset(2, 0.02 * S);
  co.AddPaths(ClipperLib.Clipper.PolyTreeToPaths(merged), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  let tree = new ClipperLib.PolyTree();
  co.Execute(tree, 0.01 * S);
  if (bbox) {
    // Offsetting grows lines past the site edge: trim back to the box.
    const box = toPath([[bbox.minE, bbox.minN], [bbox.maxE, bbox.minN], [bbox.maxE, bbox.maxN], [bbox.minE, bbox.maxN]], ox, oy);
    const c2 = new ClipperLib.Clipper();
    c2.AddPaths(ClipperLib.Clipper.PolyTreeToPaths(tree), ClipperLib.PolyType.ptSubject, true);
    c2.AddPath(box, ClipperLib.PolyType.ptClip, true);
    tree = new ClipperLib.PolyTree();
    c2.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  }
  return exPolygons(tree, ox, oy);
}

/**
 * Turn centrelines into merged polygons: each line is offset by half its width
 * (round joins and ends, so consecutive ways meet cleanly), then everything is
 * unioned so junctions become single outlines.
 */
export function bufferLines(lines: { coords: Ring; width: number }[], bbox: BBox): Polygon[] {
  // Local coordinates keep Clipper's integers small (and fast).
  const ox = bbox.minE, oy = bbox.minN;
  const parts: CL.Paths = [];
  for (const l of lines) {
    if (l.coords.length < 2) continue;
    const co = new ClipperLib.ClipperOffset(2, 0.05 * S);
    co.AddPath(toPath(l.coords, ox, oy), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    const out: CL.Paths = [];
    co.Execute(out, (l.width / 2) * S);
    for (const p of out) parts.push(p);
  }
  return parts.length ? runUnion(parts, bbox, ox, oy) : [];
}

/** Union overlapping polygons (each with holes) into disjoint ones. */
export function unionPolygons(polys: Polygon[], bbox: BBox): Polygon[] {
  const ox = bbox.minE, oy = bbox.minN;
  const paths: CL.Paths = [];
  for (const poly of polys) {
    poly.forEach((ring, k) => {
      if (ring.length < 3) return;
      const p = toPath(ring, ox, oy);
      // Non-zero fill needs outers CCW and holes CW.
      if ((signedArea(ring) > 0) !== (k === 0)) p.reverse();
      paths.push(p);
    });
  }
  return paths.length ? runUnion(paths, bbox, ox, oy) : [];
}
