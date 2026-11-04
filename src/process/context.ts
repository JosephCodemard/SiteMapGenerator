import { bufferLines, differencePolygons, lineWidth, parseMetres, unionPolygons, type Polygon } from './buffer';
import { buildPavements, findEarthworks, type Earthworks } from './network';
import { rasterizePolygons } from './geom';
import { resample } from './ribbon';
import type { AreaFeature, LineFeature, Ring, SiteData } from '../types';

export interface BridgeLine {
  id: string;
  coords: Ring;
  width: number;
  kind: LineFeature['kind'];
  name?: string;
}

export interface WallLine {
  id: string;
  coords: Ring;
  height: number;
  thickness: number;
  type: string;
}

/** Real-world footprints of the linear features, ready for the 3D scene and the drawings (BNG coordinates). */
export interface Context {
  roads: Polygon[];
  paths: Polygon[];
  /** Pavements beside roads (tagged, mapped footway=sidewalk, or inferred along building frontage), disjoint from roads. */
  pavements: Polygon[];
  /** Carriageway outlines (kerb lines). */
  kerbs: Ring[];
  inferredPavementM: number;
  mappedPavementM: number;
  /** Embankments, cuttings and river banks (steep ground beside corridors) and OSM edge lines. */
  earthworks: Earthworks;
  /** Weir / dam lines across rivers. */
  weirs: Ring[];
  rail: Polygon[];
  /** Water polygons plus buffered river/canal centrelines, merged. */
  water: Polygon[];
  /** Individual park / wood / paved polygons (they keep their own identities). */
  areas: { id: string; kind: AreaFeature['kind']; polygon: Polygon }[];
  bridges: BridgeLine[];
  walls: WallLine[];
}

const WALL_DEFAULT: Record<string, [number, number]> = {
  wall: [1.8, 0.4], retaining_wall: [1.5, 0.5], city_wall: [4, 1.2], fence: [1.2, 0.15],
};

const cache = new WeakMap<SiteData, Context>();

/** Build (and cache) the merged feature polygons for a site. */
export function buildContext(site: SiteData): Context {
  const hit = cache.get(site);
  if (hit) return hit;
  const { bbox } = site;
  const solid = (l: LineFeature) => !l.tunnel && !l.bridge;
  const buf = (ls: LineFeature[]) => bufferLines(ls.map((l) => ({ coords: l.coords, width: lineWidth(l) })), bbox);

  const roads = buf(site.lines.filter((l) => solid(l) && (l.kind === 'road-major' || l.kind === 'road-minor')));
  const pave = buildPavements(site, roads);
  // Disjoint classes: carriageway first, then pavement, then the remaining paths; rail yields to roads (level crossings).
  const paths = differencePolygons(buf(site.lines.filter((l) => solid(l) && l.kind === 'path' && l.tags.footway !== 'sidewalk' && l.tags.footway !== 'crossing')), [...roads, ...pave.pavements], bbox);
  const rail = differencePolygons(buf(site.lines.filter((l) => solid(l) && l.kind === 'rail')), roads, bbox);

  // Water: OSM water polygons, plus river centrelines that no polygon already covers.
  const waterAreas = site.areas.filter((a) => a.kind === 'water').map((a) => a.rings);
  const dtm = site.dtm;
  const mask = waterAreas.length ? rasterizePolygons(waterAreas, dtm) : null;
  const covered = (l: LineFeature) => {
    if (!mask) return false;
    const pts = resample(l.coords, 3);
    let inside = 0;
    for (const [e, n] of pts) {
      const i = Math.floor((e - dtm.minE) / dtm.res), j = Math.floor((dtm.maxN - n) / dtm.res);
      if (i >= 0 && j >= 0 && i < dtm.width && j < dtm.height && mask[j * dtm.width + i]) inside++;
    }
    return inside / pts.length > 0.8;
  };
  const rivers = buf(site.lines.filter((l) => !l.tunnel && (l.kind === 'river' || l.kind === 'stream') && !covered(l)));
  const water = unionPolygons([...waterAreas, ...rivers], bbox);

  const bridges: BridgeLine[] = site.lines
    .filter((l) => l.bridge && !l.tunnel && /^(road-major|road-minor|path|rail)$/.test(l.kind))
    .map((l) => ({ id: l.id, coords: l.coords, width: lineWidth(l), kind: l.kind, name: l.name }));

  const walls: WallLine[] = site.lines.filter((l) => l.kind === 'wall' && !l.tunnel).map((l) => {
    const [h0, t0] = WALL_DEFAULT[l.tags.barrier] ?? [1.8, 0.4];
    return {
      id: l.id, coords: l.coords, type: l.tags.barrier,
      height: parseMetres(l.tags.height) ?? h0,
      thickness: Math.max(0.1, parseMetres(l.tags.width) ?? t0),
    };
  });

  const earthworks = findEarthworks(site, [...roads, ...rail, ...water]);
  const ctx: Context = {
    roads, paths, rail, water, bridges, walls, pavements: pave.pavements, kerbs: pave.kerbs, inferredPavementM: pave.inferredMetres, mappedPavementM: pave.mappedMetres,
    earthworks, weirs: site.lines.filter((l) => l.kind === 'weir').map((l) => l.coords),
    areas: site.areas.filter((a) => a.kind === 'green' || a.kind === 'wood' || a.kind === 'paved')
      .map((a) => ({ id: a.id, kind: a.kind, polygon: a.rings })),
  };
  cache.set(site, ctx);
  return ctx;
}
