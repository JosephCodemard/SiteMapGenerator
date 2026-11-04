import { bufferLines, differencePolygons, lineWidth, offsetPolygons, unionPolygons, type Polygon } from './buffer';
import { edgeDistance } from './roofs';
import { offsetOutline, resample } from './ribbon';
import { contourBands } from './contours';
import { rasterizePolygons } from './geom';
import type { Building, LineFeature, Raster, Ring, SiteData, XY } from '../types';

/**
 * Pavements, kerbs and earthworks: the parts of the street that make a road model usable for 3D modelling.
 *
 * - **Pavements** come from (1) `sidewalk=*` tags on the road, (2) separately mapped `footway=sidewalk` ways, and
 *   (3) where OSM has neither, an INFERRED strip beside roads that have buildings along them (flagged as inferred).
 * - Every feature class is made disjoint (carriageway > pavement > path), so nothing stacks or z-fights, and the
 *   carriageway outline is the **kerb line**.
 * - **Earthworks**: terrain steeper than 18 degrees beside roads, railways and rivers (embankments, cuttings, banks),
 *   found from the DTM, plus OSM `man_made=embankment` / `natural=cliff` edges.
 */
export interface Pavements {
  pavements: Polygon[];
  /** Carriageway outlines (the kerb line). */
  kerbs: Ring[];
  /** Metres of pavement that were inferred rather than mapped. */
  inferredMetres: number;
  mappedMetres: number;
}

type Side = 'left' | 'right';

/** Which sides of a road OSM says have a pavement; `none` = nothing tagged at all (a candidate for inference). */
export function sidewalkSides(t: Record<string, string>): { sides: Side[]; tagged: boolean; separate: boolean } {
  const yes = (v?: string) => !!v && /^(yes|both|left|right|lane|designated)$/.test(v);
  const sides = new Set<Side>();
  const sw = t.sidewalk;
  if (sw === 'both' || sw === 'yes') { sides.add('left'); sides.add('right'); }
  if (sw === 'left') sides.add('left');
  if (sw === 'right') sides.add('right');
  if (yes(t['sidewalk:left']) || t['sidewalk:both'] === 'yes') sides.add('left');
  if (yes(t['sidewalk:right']) || t['sidewalk:both'] === 'yes') sides.add('right');
  if (t['sidewalk:left'] === 'no') sides.delete('left');
  if (t['sidewalk:right'] === 'no') sides.delete('right');
  const any = ['sidewalk', 'sidewalk:left', 'sidewalk:right', 'sidewalk:both'].some((k) => t[k] !== undefined);
  const separate = ['sidewalk', 'sidewalk:left', 'sidewalk:right', 'sidewalk:both'].some((k) => t[k] === 'separate');
  return { sides: [...sides], tagged: any, separate };
}

const INFER = /^(primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/;

/** Spatial hash of building outlines for "is there a frontage here" tests. */
function frontage(buildings: Building[]) {
  const C = 25, grid = new Map<string, Building[]>();
  for (const b of buildings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, n] of b.rings[0]) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    for (let i = Math.floor((x0 - 8) / C); i <= Math.floor((x1 + 8) / C); i++) for (let j = Math.floor((y0 - 8) / C); j <= Math.floor((y1 + 8) / C); j++) {
      const k = `${i},${j}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(b);
    }
  }
  return (p: XY, r: number) => (grid.get(`${Math.floor(p[0] / C)},${Math.floor(p[1] / C)}`) ?? []).some((b) => edgeDistance(p[0], p[1], b.rings) < r);
}

/** Pavement strips and kerb lines for a site (BNG). `roads` is the merged carriageway polygon set. */
export function buildPavements(site: SiteData, roads: Polygon[]): Pavements {
  const { bbox } = site;
  const strips: Polygon[] = [];
  let inferred = 0, mapped = 0;
  const near = frontage(site.buildings);
  // Explicit sidewalks: footway=sidewalk ways (and their centre-lines, for the "already mapped" test).
  const walkLines = site.lines.filter((l) => l.kind === 'path' && !l.tunnel && !l.bridge);
  const sidewalkWays = walkLines.filter((l) => l.tags.footway === 'sidewalk');
  const pathNear = (p: XY, r: number) => walkLines.some((l) => l.coords.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < r));

  for (const l of site.lines) {
    if (!l.kind.startsWith('road') || l.tunnel || l.bridge) continue;
    const t = l.tags;
    const w = lineWidth(l);
    const pts = resample(l.coords, 2);
    if (pts.length < 2) continue;
    const { sides, tagged, separate } = sidewalkSides(t);
    const pw = parseFloat(t['sidewalk:width'] ?? '') || (l.kind === 'road-major' ? 2.2 : 1.8);
    const todo: { side: Side; inferred: boolean }[] = sides.map((side) => ({ side, inferred: false }));
    if (!tagged && !separate && INFER.test(t.highway ?? '')) {
      // Inference: a side qualifies when most sample points along it sit next to a building and no footway is mapped there.
      const { left, right } = offsetOutline(pts, w / 2 + 2.2);
      for (const [side, line] of [['left', left], ['right', right]] as const) {
        const probe = line.filter((_, i) => i % 3 === 0);
        if (probe.length < 2) continue;
        const hit = probe.filter((p) => near(p, 4.5) && !pathNear(p, 3)).length;
        if (hit / probe.length >= 0.5) todo.push({ side, inferred: true });
      }
    }
    for (const { side, inferred: inf } of todo) {
      const inner = offsetOutline(pts, w / 2 - 0.05)[side], outer = offsetOutline(pts, w / 2 + pw)[side];
      strips.push([[...inner, ...outer.slice().reverse()]]);
      const len = pts.length * 2;
      if (inf) inferred += len; else mapped += len;
    }
  }
  const walks = bufferLines(sidewalkWays.map((l) => ({ coords: l.coords, width: lineWidth(l) })), bbox);
  for (const m of sidewalkWays) mapped += m.coords.length * 2;
  const merged = unionPolygons([...strips, ...walks], bbox);
  const pavements = differencePolygons(merged, roads, bbox);
  const kerbs: Ring[] = roads.flatMap((p) => p.map((r) => [...r, r[0]]));
  return { pavements, kerbs, inferredMetres: inferred, mappedMetres: mapped };
}

// ------------------------------------------------------------------ earthworks

export interface Earthworks {
  /** Steep ground beside corridors (embankments, cuttings, river banks). */
  areas: Polygon[];
  /** OSM embankment / cliff / quay edges with the downhill side on the right (OSM convention). */
  edges: { coords: Ring; kind: LineFeature['kind'] }[];
}

/** Slope in degrees (central differences, 1 cell margin copied). */
export function slopeDegrees(r: Raster): Float32Array {
  const { width: w, height: h, data, res } = r;
  const out = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const dx = (data[j * w + i + 1] - data[j * w + i - 1]) / (2 * res), dy = (data[(j + 1) * w + i] - data[(j - 1) * w + i]) / (2 * res);
    out[j * w + i] = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  }
  return out;
}

/** Steep strips next to the given corridors (BNG polygons), at least `minCells` cells big. */
export function findEarthworks(site: SiteData, corridors: Polygon[], opt = { slope: 18, reach: 12, minCells: 12 }): Earthworks {
  const edges = site.lines.filter((l) => l.kind === 'embankment' || l.kind === 'cliff' || l.kind === 'quay').map((l) => ({ coords: l.coords, kind: l.kind }));
  if (!corridors.length) return { areas: [], edges };
  const dtm = site.dtm;
  const slope = slopeDegrees(dtm);
  const near = rasterizePolygons(offsetPolygons(corridors, opt.reach, site.bbox), dtm);
  const inside = rasterizePolygons(corridors, dtm);
  const bld = rasterizePolygons(site.buildings.map((b) => b.rings), dtm);
  const mask = new Float32Array(dtm.data.length);
  for (let k = 0; k < mask.length; k++) mask[k] = near[k] && !inside[k] && !bld[k] && slope[k] >= opt.slope ? 1 : 0;
  // Remove specks (open: a cell survives only with 2+ neighbours).
  const w = dtm.width, h = dtm.height, keep = new Float32Array(mask.length);
  let cells = 0;
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const k = j * w + i;
    if (!mask[k]) continue;
    const n = mask[k - 1] + mask[k + 1] + mask[k - w] + mask[k + w];
    if (n >= 2) { keep[k] = 1; cells++; }
  }
  if (cells < opt.minCells) return { areas: [], edges };
  const band = contourBands({ ...dtm, data: keep }, [0.5])[0];
  const areas: Polygon[] = band.polygons
    .map((p) => p.map((r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r)))
    .filter((p) => p[0].length >= 3 && Math.abs(p[0].reduce((s, q, i, a) => { const n = a[(i + 1) % a.length]; return s + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2 >= opt.minCells * 0.5);
  return { areas, edges };
}
