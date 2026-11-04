import { getJson, DAY } from './cache';
import { bboxToWGS } from '../geo/bng';
import type { BBox, Ring } from '../types';

/**
 * Environment Agency Flood Map for Planning (Flood Zones 2 and 3, rivers and sea), OGC API Features. CORS open,
 * no key. Coordinates are requested in British National Grid. This is an *indicative* planning layer.
 */
const BASE = 'https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones/ogc/features/v1/collections/Flood_Zones_2_3_Rivers_and_Sea/items';

export interface FloodZone {
  zone: 'FZ2' | 'FZ3';
  source: string;
  /** Polygons with holes (open rings, BNG). */
  polygons: Ring[][];
}

interface Fc {
  features?: { properties: { flood_zone?: string; flood_source?: string }; geometry: { type: string; coordinates: number[][][][] | number[][][] } | null }[];
  links?: { rel: string; href: string }[];
}

export function floodZonesUrl(b: BBox, limit = 1000): string {
  const w = bboxToWGS({ minE: b.minE - 5, minN: b.minN - 5, maxE: b.maxE + 5, maxN: b.maxN + 5 });
  const q = new URLSearchParams({ f: 'json', bbox: `${w.west},${w.south},${w.east},${w.north}`, limit: String(limit), crs: 'http://www.opengis.net/def/crs/EPSG/0/27700' });
  return `${BASE}?${q}`;
}

export function parseFloodZones(fc: Fc): FloodZone[] {
  const open = (r: number[][]): Ring => { const o = r.map(([e, n]) => [e, n] as [number, number]); const a = o[0], z = o[o.length - 1]; return a[0] === z[0] && a[1] === z[1] ? o.slice(0, -1) : o; };
  const out: FloodZone[] = [];
  for (const f of fc.features ?? []) {
    const zone = f.properties.flood_zone;
    if ((zone !== 'FZ2' && zone !== 'FZ3') || !f.geometry) continue;
    const polys = f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]) : [f.geometry.coordinates as number[][][]];
    out.push({ zone, source: f.properties.flood_source ?? '', polygons: polys.map((p) => p.map(open)) });
  }
  return out;
}

/** All zones intersecting the box, following `next` links (at most 6 pages). */
export async function fetchFloodZones(b: BBox): Promise<FloodZone[]> {
  let url: string | undefined = floodZonesUrl(b);
  const out: FloodZone[] = [];
  for (let page = 0; url && page < 6; page++) {
    const fc: Fc = await getJson<Fc>(url, DAY);
    out.push(...parseFloodZones(fc));
    url = fc.links?.find((l) => l.rel === 'next')?.href;
    if (!fc.features?.length) break;
  }
  return out;
}
