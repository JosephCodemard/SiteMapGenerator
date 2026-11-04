import { getJson, DAY } from './cache';
import type { BBox, XY } from '../types';

/**
 * Environment Agency oblique aerial photography INDEX (Open Government Licence). The index is queryable from a browser
 * (WFS, CORS open, no key); the photographs themselves are only published as zip downloads per OS grid tile from the
 * Defra Data Services Platform, so they cannot be shown or used live. Each index entry has the AIRCRAFT position,
 * the heading and a view angle, but no camera tilt or lens data: the photos can be looked at, not measured or
 * draped. The app therefore lists which photos exist near the site, so a user can fetch the right tile.
 */
export interface ObliquePhoto {
  filename: string;
  /** Aircraft position at exposure (BNG). */
  p: XY;
  /** Aircraft heading in degrees. */
  heading: number;
  /** `iva` field of the index (view angle; meaning is not documented in the metadata). */
  iva: number | null;
  date: string;
  year: string;
  /** 'Incident Response' (flood events) or 'Other' (bespoke surveys). */
  type: string;
  /** OS grid reference of the tile the photo is delivered in. */
  tile: string;
}

const WFS = 'https://environment.data.gov.uk/spatialdata/survey-index-files/wfs';
const LAYER = 'dataset-9f0fa3fc-a860-4729-adc9-47fe53f658d0:Oblique_photography_index_catalogue';

export function obliqueUrl(b: BBox, pad: number): string {
  const q = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: LAYER, outputFormat: 'application/json', count: '500',
    bbox: `${b.minE - pad},${b.minN - pad},${b.maxE + pad},${b.maxN + pad},urn:ogc:def:crs:EPSG::27700`,
  });
  return `${WFS}?${q}`;
}

interface Resp {
  features?: { geometry?: { coordinates?: number[] }; properties: Record<string, unknown> }[];
}

export function parseOblique(r: Resp): ObliquePhoto[] {
  return (r.features ?? []).filter((f) => f.geometry?.coordinates?.length === 2).map((f) => {
    const p = f.properties;
    return {
      filename: String(p.filename ?? ''), p: [f.geometry!.coordinates![0], f.geometry!.coordinates![1]] as XY, heading: Number(p.heading ?? 0),
      iva: p.iva === null || p.iva === undefined ? null : Number(p.iva), date: String(p.dos ?? '').slice(0, 10), year: String(p.year ?? ''),
      type: String(p.type ?? ''), tile: String(p.os_ref ?? ''),
    };
  });
}

/** Photos whose aircraft position lies within `pad` metres of the site (default 1.5 km: the camera looks sideways from a distance). */
export const fetchOblique = async (b: BBox, pad = 1500) => parseOblique(await getJson<Resp>(obliqueUrl(b, pad), DAY));

/** One-line summary for the log. */
export function obliqueSummary(photos: ObliquePhoto[]): string {
  if (!photos.length) return 'EA oblique photography: no photos indexed within 1.5 km of this site (the archive is mostly flood-incident flights).';
  const by = new Map<string, number>();
  for (const p of photos) by.set(`${p.year} ${p.type}`, (by.get(`${p.year} ${p.type}`) ?? 0) + 1);
  const tiles = [...new Set(photos.map((p) => p.tile))].slice(0, 6).join(', ');
  return `EA oblique photography: ${photos.length} photos within 1.5 km (${[...by].map(([k, n]) => `${n} × ${k}`).join(', ')}). Download tiles ${tiles} from the Defra Data Services Platform to view them; they cannot be measured (no camera tilt in the index).`;
}
