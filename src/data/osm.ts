import osmtogeojson from 'osmtogeojson';
import type { Feature, Geometry, Position } from 'geojson';
import { bboxToWGS, toBNG } from '../geo/bng';
import { clipPolygonToBox, clipPolyline } from '../process/clip';
import { clipPolygonToShape, clipPolylineToShape, pointInShape } from '../process/shape';
import type { AreaFeature, AreaKind, BBox, LineFeature, LineKind, PointFeature, PointKind, Ring, XY } from '../types';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OsmFootprint {
  id: string;
  rings: Ring[];
  tags: Record<string, string>;
}

export interface OsmResult {
  buildings: OsmFootprint[];
  lines: LineFeature[];
  areas: AreaFeature[];
  trees: XY[];
  points: PointFeature[];
}

function query(b: { west: number; south: number; east: number; north: number }): string {
  const bb = `(${b.south},${b.west},${b.north},${b.east})`;
  return `[out:json][timeout:120];
(
  wr["building"]${bb};
  way["highway"]${bb};
  way["railway"~"^(rail|light_rail|tram|narrow_gauge|preserved|disused)$"]${bb};
  way["waterway"~"^(river|canal|stream|brook|drain|ditch)$"]${bb};
  way["barrier"~"^(wall|retaining_wall|city_wall|fence)$"]${bb};
  wr["natural"~"^(water|wood|scrub|grassland|heath|wetland)$"]${bb};
  wr["waterway"="riverbank"]${bb};
  wr["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green|orchard|basin|reservoir)$"]${bb};
  wr["leisure"~"^(park|garden|pitch|playground|common|nature_reserve|golf_course)$"]${bb};
  wr["man_made"="bridge"]${bb};
  wr["place"="square"]${bb};
  node["natural"="tree"]${bb};
  node["entrance"]${bb};
  node["highway"~"^(crossing|traffic_signals|stop|give_way|bus_stop|street_lamp)$"]${bb};
  node["amenity"]${bb};
  node["shop"]${bb};
  node["tourism"]${bb};
  node["public_transport"]${bb};
  node["railway"~"^(station|halt|tram_stop)$"]${bb};
);
out body;
>;
out skel qt;`;
}

async function overpass(q: string, signal?: AbortSignal): Promise<unknown> {
  let lastErr: unknown;
  // Two rounds over the endpoint list with exponential backoff (Overpass is often busy).
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      // A busy server can hang for minutes; give up after 90 s and try the next one.
      const timeout = AbortSignal.timeout(90_000);
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.floor(attempt / ENDPOINTS.length)));
    }
  }
  throw new Error(`Overpass unavailable: ${String(lastErr)}`);
}

const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;
const MINOR = /^(tertiary|tertiary_link|unclassified|residential|service|living_street|road|busway)$/;
const PATH = /^(footway|path|cycleway|steps|pedestrian|bridleway|track|corridor)$/;

function lineKind(t: Record<string, string>): LineKind | null {
  if (t.highway) {
    if (MAJOR.test(t.highway)) return 'road-major';
    if (MINOR.test(t.highway)) return 'road-minor';
    if (PATH.test(t.highway)) return 'path';
    return null;
  }
  if (t.railway) return 'rail';
  if (t.waterway) return /^(river|canal)$/.test(t.waterway) ? 'river' : /^(stream|brook|drain|ditch)$/.test(t.waterway) ? 'stream' : null;
  if (/^(wall|retaining_wall|city_wall|fence)$/.test(t.barrier ?? '')) return 'wall';
  return null;
}

function areaKind(t: Record<string, string>): AreaKind | null {
  if (t.man_made === 'bridge') return 'bridge';
  if (t.natural === 'water' || t.waterway === 'riverbank' || /^(basin|reservoir)$/.test(t.landuse ?? '')) return 'water';
  if (t.natural === 'wood' || t.natural === 'scrub' || /^(forest|orchard)$/.test(t.landuse ?? '')) return 'wood';
  if (t.leisure || t.landuse || /^(grassland|heath|wetland)$/.test(t.natural ?? '')) return 'green';
  if (t.highway === 'pedestrian' || t.place === 'square' || t.area === 'yes') return 'paved';
  return null;
}

/** Classify a tagged node. */
export function pointKind(t: Record<string, string>): PointKind | null {
  if (t.entrance) return 'entrance';
  if (t.highway === 'crossing' || (t.crossing && t.highway !== 'footway')) return 'crossing';
  if (t.highway === 'traffic_signals') return 'signals';
  if (t.highway === 'stop') return 'stop';
  if (t.highway === 'give_way') return 'giveway';
  if (t.highway === 'street_lamp') return 'lamp';
  if (t.highway === 'bus_stop' || t.public_transport || /^(station|halt|tram_stop)$/.test(t.railway ?? '')) return 'transit';
  if (t.amenity && !/^(bench|waste_basket|bicycle_parking|post_box|drinking_water|recycling|parking_entrance)$/.test(t.amenity)) return 'poi';
  if (t.shop || t.tourism) return 'poi';
  return null;
}

const proj = (ring: Position[]): Ring => ring.map(([lon, lat]) => toBNG(lon, lat));

function polygons(g: Geometry): Position[][][] {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function clipPolygon(rings: Position[][], bbox: BBox): Ring[][] {
  return clipPolygonToBox(rings.map(proj), bbox);
}

/** Translate every OSM feature by `offset` (metres) and clip to `bbox`. */
export function shiftAndClip(r: OsmResult, offset: XY, bbox: BBox): OsmResult {
  const [dx, dy] = offset;
  const mv = (ring: Ring): Ring => ring.map(([e, n]) => [e + dx, n + dy]);
  const inBox = ([e, n]: XY) => e >= bbox.minE && e <= bbox.maxE && n >= bbox.minN && n <= bbox.maxN;
  return {
    buildings: r.buildings.flatMap((b) =>
      clipPolygonToBox(b.rings.map(mv), bbox).map((rings, k) => ({ ...b, id: k ? `${b.id}#${k}` : b.id, rings }))),
    areas: r.areas.flatMap((a) => clipPolygonToBox(a.rings.map(mv), bbox).map((rings) => ({ ...a, rings }))),
    lines: r.lines.flatMap((l) => clipPolyline(mv(l.coords), bbox).map((coords) => ({ ...l, coords }))),
    trees: r.trees.map(([e, n]) => [e + dx, n + dy] as XY).filter(inBox),
    points: r.points.map((q) => ({ ...q, p: [q.p[0] + dx, q.p[1] + dy] as XY })).filter((q) => inBox(q.p)),
  };
}

/** Clip every feature to a custom site outline (after `shiftAndClip` to its bounding box). */
export function clipToShape(r: OsmResult, shape: Ring): OsmResult {
  return {
    buildings: r.buildings.flatMap((b) => clipPolygonToShape(b.rings, shape).map((rings, k) => ({ ...b, id: k ? `${b.id}~${k}` : b.id, rings }))),
    areas: r.areas.flatMap((a) => clipPolygonToShape(a.rings, shape).map((rings) => ({ ...a, rings }))),
    lines: r.lines.flatMap((l) => clipPolylineToShape(l.coords, shape).map((coords) => ({ ...l, coords }))),
    trees: r.trees.filter((p) => pointInShape(p, shape)),
    points: r.points.filter((q) => pointInShape(q.p, shape)),
  };
}

/** Fetch OSM features in the bbox, project to BNG, classify and clip. */
export async function fetchOsm(bbox: BBox, signal?: AbortSignal): Promise<OsmResult> {
  const w = bboxToWGS(bbox);
  const pad = 0.0005;
  const raw = await overpass(query({ west: w.west - pad, south: w.south - pad, east: w.east + pad, north: w.north + pad }), signal);
  return parseOsm(raw, bbox);
}

/** Convert an Overpass JSON response into classified, clipped BNG features. */
export function parseOsm(raw: unknown, bbox: BBox): OsmResult {
  const fc = osmtogeojson(raw, { flatProperties: false }); // keep tags under properties.tags

  const out: OsmResult = { buildings: [], lines: [], areas: [], trees: [], points: [] };
  for (const f of fc.features as Feature<Geometry, Record<string, unknown>>[]) {
    const tags = (f.properties?.tags ?? {}) as Record<string, string>;
    const id = String(f.id ?? f.properties?.id ?? '');
    const g = f.geometry;
    if (!g) continue;

    if (g.type === 'Point') {
      const p = toBNG(g.coordinates[0], g.coordinates[1]);
      if (p[0] < bbox.minE || p[0] > bbox.maxE || p[1] < bbox.minN || p[1] > bbox.maxN) continue;
      if (tags.natural === 'tree') out.trees.push(p);
      else {
        const kind = pointKind(tags);
        if (kind) out.points.push({ id, kind, p, tags });
      }
      continue;
    }

    if (tags.building && tags.building !== 'no') {
      polygons(g).flatMap((poly) => clipPolygon(poly, bbox)).forEach((rings, k) => {
        out.buildings.push({ id: k ? `${id}#${k}` : id, rings, tags });
      });
      continue;
    }

    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const kind = lineKind(tags);
      if (!kind) continue;
      const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      for (const part of parts) {
        for (const coords of clipPolyline(proj(part), bbox)) {
          out.lines.push({
            id, kind, coords, tags, name: tags.name,
            bridge: !!tags.bridge && tags.bridge !== 'no',
            tunnel: !!tags.tunnel && tags.tunnel !== 'no',
          });
        }
      }
      continue;
    }

    const kind = areaKind(tags);
    if (!kind) continue;
    for (const poly of polygons(g)) {
      for (const rings of clipPolygon(poly, bbox)) out.areas.push({ id, kind, rings, tags });
    }
  }
  return out;
}
