import { pointInRings } from './clip';
import { sample } from './raster';
import type { OsmFootprint } from '../data/osm';
import type { Building, BuildingPart, HeightSource, Raster, Ring } from '../types';

export interface HeightOptions {
  /** Percentile of DSM values inside the footprint used as the block top (0-1). */
  roofPercentile: number;
  /** 'lidar' = LIDAR first, OSM tags as fallback; 'osm' = OSM tags first. */
  priority: 'lidar' | 'osm';
  /** Height used when nothing else is known (m). */
  defaultHeight: number;
}

export const DEFAULT_HEIGHTS: HeightOptions = { roofPercentile: 0.7, priority: 'lidar', defaultHeight: 7 };

const LEVEL_HEIGHT = 3;

function parseMetres(v?: string): number | null {
  if (!v) return null;
  const m = v.match(/^\s*([\d.]+)\s*(m|ft|')?\s*$/i);
  if (!m) return null;
  const x = parseFloat(m[1]);
  return m[2] && /ft|'/i.test(m[2]) ? x * 0.3048 : x;
}

function osmHeight(t: Record<string, string>): { h: number; source: HeightSource } | null {
  const h = parseMetres(t.height);
  if (h && h > 1) return { h, source: 'osm-height' };
  const lv = parseFloat(t['building:levels'] ?? '');
  if (lv > 0) {
    const roof = parseFloat(t['roof:levels'] ?? '') || 0;
    return { h: (lv + roof * 0.5) * LEVEL_HEIGHT + 1, source: 'osm-levels' };
  }
  return null;
}

function percentile(sorted: number[], p: number): number {
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[k];
}

/** LOD1: footprint + flat roof. Ground from DTM, top from DSM (nDSM) or OSM tags. */
export function buildingHeights(
  footprints: OsmFootprint[],
  dtm: Raster,
  dsm: Raster | null,
  opts: HeightOptions = DEFAULT_HEIGHTS,
): Building[] {
  return footprints.map((f) => {
    const ground: number[] = [];
    const surface: number[] = [];
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const [e, n] of f.rings[0]) {
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
      ground.push(sample(dtm, e, n));
    }
    // Cells whose centres fall inside the footprint.
    const i0 = Math.max(0, Math.floor((minE - dtm.minE) / dtm.res));
    const i1 = Math.min(dtm.width - 1, Math.ceil((maxE - dtm.minE) / dtm.res));
    const j0 = Math.max(0, Math.floor((dtm.maxN - maxN) / dtm.res));
    const j1 = Math.min(dtm.height - 1, Math.ceil((dtm.maxN - minN) / dtm.res));
    for (let j = j0; j <= j1; j++) {
      const n = dtm.maxN - (j + 0.5) * dtm.res;
      for (let i = i0; i <= i1; i++) {
        const e = dtm.minE + (i + 0.5) * dtm.res;
        if (!pointInRings(e, n, f.rings)) continue;
        ground.push(dtm.data[j * dtm.width + i]);
        if (dsm) surface.push(dsm.data[j * dsm.width + i]);
      }
    }
    if (dsm && surface.length < 3) {
      const ce = (minE + maxE) / 2, cn = (minN + maxN) / 2;
      surface.push(sample(dsm, ce, cn));
    }

    ground.sort((a, b) => a - b);
    const groundMin = ground[0];
    const groundMed = percentile(ground, 0.5);

    let lidarTop: number | null = null;
    if (dsm && surface.length) {
      surface.sort((a, b) => a - b);
      const top = percentile(surface, opts.roofPercentile);
      const h = top - groundMed;
      // Reject implausible LIDAR heights (misalignment, demolished/new buildings).
      if (h >= 2 && h <= 120) lidarTop = top;
    }
    const tagged = osmHeight(f.tags);

    let top: number, source: HeightSource;
    if (opts.priority === 'osm' && tagged) { top = groundMed + tagged.h; source = tagged.source; }
    else if (lidarTop !== null) { top = lidarTop; source = 'lidar'; }
    else if (tagged) { top = groundMed + tagged.h; source = tagged.source; }
    else { top = groundMed + opts.defaultHeight; source = 'default'; }

    return { id: f.id, rings: f.rings, tags: f.tags, ground: groundMin, top: Math.max(top, groundMin + 2), source };
  });
}

/** Interior point of a ring set (centroid of the outer ring, nudged inside if it falls in a notch). */
function interiorPoint(rings: Ring[]): [number, number] {
  const r = rings[0];
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  const c: [number, number] = [x / r.length, y / r.length];
  if (pointInRings(c[0], c[1], rings)) return c;
  // Try the midpoints between the centroid and each vertex.
  for (const p of r) {
    const m: [number, number] = [(p[0] + c[0]) / 2, (p[1] + c[1]) / 2];
    if (pointInRings(m[0], m[1], rings)) return m;
  }
  return r[0];
}

/** Give each `building:part` to the building that contains it (a part is a tower, nave or wing with its own roof). */
export function attachParts(buildings: Building[], parts: BuildingPart[]): void {
  for (const b of buildings) b.parts = undefined;
  for (const p of parts) {
    const q = interiorPoint(p.rings);
    // The smallest containing building wins (a part in an annexe inside a bigger outline).
    let host: Building | null = null, hostArea = Infinity;
    for (const b of buildings) {
      if (!pointInRings(q[0], q[1], b.rings)) continue;
      const a = Math.abs(b.rings[0].reduce((s, pt, i, arr) => { const n = arr[(i + 1) % arr.length]; return s + pt[0] * n[1] - n[0] * pt[1]; }, 0)) / 2;
      if (a < hostArea) { host = b; hostArea = a; }
    }
    if (host) (host.parts ??= []).push(p);
  }
}
