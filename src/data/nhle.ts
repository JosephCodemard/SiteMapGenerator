import { getJson, DAY } from './cache';
import { pointInRings } from '../process/clip';
import { edgeDistance } from '../process/roofs';
import type { BBox, Building, ListedInfo, XY } from '../types';

/** Historic England National Heritage List (listed buildings): ArcGIS FeatureServer, BNG, no key, CORS open. */
const URL_BASE = 'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer/0/query';

export interface ListedEntry extends ListedInfo {
  p: XY;
}

export function nhleUrl(b: BBox, pad = 10): string {
  const q = new URLSearchParams({
    where: '1=1', geometry: `${b.minE - pad},${b.minN - pad},${b.maxE + pad},${b.maxN + pad}`, geometryType: 'esriGeometryEnvelope',
    inSR: '27700', outSR: '27700', spatialRel: 'esriSpatialRelIntersects', outFields: 'Name,ListEntry,Grade', returnGeometry: 'true',
    resultRecordCount: '2000', f: 'json',
  });
  return `${URL_BASE}?${q}`;
}

interface NhleResponse {
  features?: { attributes: { Name: string; ListEntry: number; Grade: string }; geometry?: { points?: number[][]; x?: number; y?: number } }[];
}

export function parseNhle(json: NhleResponse): ListedEntry[] {
  const out: ListedEntry[] = [];
  for (const f of json.features ?? []) {
    const pts = f.geometry?.points ?? (f.geometry?.x !== undefined ? [[f.geometry.x, f.geometry.y!]] : []);
    for (const p of pts) out.push({ entry: f.attributes.ListEntry, name: f.attributes.Name, grade: f.attributes.Grade, p: [p[0], p[1]] });
  }
  return out;
}

export async function fetchListed(b: BBox): Promise<ListedEntry[]> {
  return parseNhle(await getJson<NhleResponse>(nhleUrl(b), DAY));
}

/**
 * Attach each listing to the building that contains its point, else the nearest footprint within `maxDist` m.
 * When several listings share a building the highest grade (I < II* < II) wins. Returns how many buildings were tagged.
 */
export function attachListed(buildings: Building[], entries: ListedEntry[], maxDist = 8): number {
  const rank: Record<string, number> = { I: 0, 'II*': 1, II: 2 };
  for (const b of buildings) b.listed = undefined;
  for (const e of entries) {
    let best: Building | null = null, bestD = Infinity;
    for (const b of buildings) {
      const d = pointInRings(e.p[0], e.p[1], b.rings) ? 0 : edgeDistance(e.p[0], e.p[1], b.rings);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD <= maxDist) {
      const cur = best.listed;
      if (!cur || (rank[e.grade] ?? 3) < (rank[cur.grade] ?? 3)) best.listed = { grade: e.grade, entry: e.entry, name: e.name };
    }
  }
  return buildings.filter((b) => b.listed).length;
}
