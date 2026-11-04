import { getJson, DAY } from './cache';
import type { BBox, Ring } from '../types';

/** EA spatial flood defences (walls, embankments, gates, barriers): ArcGIS FeatureServer, BNG, CORS open, no key. */
const BASE = 'https://services.arcgis.com/JJzESW51TqeY9uat/arcgis/rest/services/SpatialFloodDefences/FeatureServer/0/query';

export interface FloodDefence {
  name: string;
  type: string;
  /** Level at the toe of the defence (m ODN), when recorded. */
  toe: number | null;
  lines: Ring[];
}

export function defencesUrl(b: BBox, pad = 20): string {
  const q = new URLSearchParams({
    where: '1=1', geometry: `${b.minE - pad},${b.minN - pad},${b.maxE + pad},${b.maxN + pad}`, geometryType: 'esriGeometryEnvelope',
    inSR: '27700', outSR: '27700', outFields: 'asset_name,asset_sub_type,toe_level', returnGeometry: 'true', resultRecordCount: '2000', f: 'json',
  });
  return `${BASE}?${q}`;
}

interface Resp {
  features?: { attributes: { asset_name?: string; asset_sub_type?: string; toe_level?: number | null }; geometry?: { paths?: number[][][] } }[];
}

export function parseDefences(r: Resp): FloodDefence[] {
  return (r.features ?? []).filter((f) => f.geometry?.paths?.length).map((f) => ({
    name: f.attributes.asset_name ?? '', type: f.attributes.asset_sub_type ?? '', toe: f.attributes.toe_level ?? null,
    lines: f.geometry!.paths!.map((p) => p.map(([e, n]) => [e, n] as [number, number])),
  }));
}

export const fetchDefences = async (b: BBox) => parseDefences(await getJson<Resp>(defencesUrl(b), DAY));
