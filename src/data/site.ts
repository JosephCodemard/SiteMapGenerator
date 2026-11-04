import { fetchLidar } from './lidar';
import { clipToShape, fetchOsm, parseOsm, shiftAndClip, type OsmFootprint } from './osm';
import { polygonArea } from '../process/shape';
import { estimateOffset } from '../process/align';
import { buildingHeights, type HeightOptions } from '../process/buildings';
import { fillNoData } from '../process/raster';
import type { BBox, Raster, Ring, SiteData } from '../types';

export const MAX_AREA_KM2 = 4;

export interface FetchOptions {
  dsm: boolean;
  osm: boolean;
  /** Estimate and remove the OSM imagery offset using LIDAR roofs. */
  align: boolean;
  heights: HeightOptions;
  /** Overpass-JSON supplied by the user (e.g. from overpass-turbo); used instead of querying Overpass. */
  osmData?: unknown;
  /** Custom site outline (BNG); `bbox` passed to fetchSite must bound it. */
  shape?: Ring;
}

export type Log = (msg: string) => void;

/** Raw inputs kept so building heights can be recomputed without refetching. */
export interface SiteInputs {
  footprints: OsmFootprint[];
}

/** Fetch DTM, DSM and OSM for a BNG bbox and align them into one dataset. */
export async function fetchSite(bbox: BBox, opts: FetchOptions, log: Log, signal?: AbortSignal): Promise<{ site: SiteData; inputs: SiteInputs }> {
  const area = (opts.shape ? polygonArea(opts.shape) : (bbox.maxE - bbox.minE) * (bbox.maxN - bbox.minN)) / 1e6;
  if (area > MAX_AREA_KM2) throw new Error(`Area is ${area.toFixed(2)} km²; the limit is ${MAX_AREA_KM2} km²`);

  // OSM is fetched with a margin so features can be shifted into the site before clipping.
  const PAD = 5;
  const padded: BBox = { minE: bbox.minE - PAD, minN: bbox.minN - PAD, maxE: bbox.maxE + PAD, maxN: bbox.maxN + PAD };
  const progress = (name: string) => (d: number, t: number) => log(`${name}: ${d}/${t} tiles`);
  const tasks: [Promise<Raster>, Promise<Raster | null>, Promise<Awaited<ReturnType<typeof fetchOsm>> | null>] = [
    fetchLidar('dtm', bbox, progress('LIDAR DTM'), signal),
    opts.dsm ? fetchLidar('dsm', bbox, progress('LIDAR DSM'), signal) : Promise.resolve(null),
    opts.osm
      ? (log(opts.osmData ? 'OpenStreetMap: using your file…' : 'OpenStreetMap: querying Overpass…'),
        (opts.osmData ? Promise.resolve().then(() => parseOsm(opts.osmData, padded)) : fetchOsm(padded, signal)).then((r) => {
        log(`OpenStreetMap: ${r.buildings.length} buildings, ${r.lines.length} lines, ${r.areas.length} areas`);
        return r;
      }, (e) => {
        // Overpass is a shared, often overloaded service: keep the LIDAR rather than failing everything.
        if (signal?.aborted) throw e;
        log(`⚠ OpenStreetMap unavailable (${e instanceof Error ? e.message : e}). Continuing with terrain only — fetch again later for buildings & roads.`);
        return null;
      }))
      : Promise.resolve(null),
  ];
  const [dtm, dsm, rawOsm] = await Promise.all(tasks);

  const filled = fillNoData(dtm);
  if (filled) log(`DTM: filled ${filled.toLocaleString()} empty cells (${((100 * filled) / dtm.data.length).toFixed(1)}%)`);
  if (dsm) {
    // Where the DSM is missing, fall back to the DTM (no surface objects).
    for (let k = 0; k < dsm.data.length; k++) if (Number.isNaN(dsm.data[k])) dsm.data[k] = dtm.data[k];
  }

  let offset: [number, number] = [0, 0];
  if (rawOsm && dsm && opts.align) {
    ({ offset } = estimateOffset(rawOsm.buildings.map((b) => b.rings), dtm, dsm));
    log(`OSM → LIDAR alignment: shifted ${offset[0].toFixed(2)} m E, ${offset[1].toFixed(2)} m N`);
  }
  let osm = rawOsm ? shiftAndClip(rawOsm, offset, bbox) : null;
  if (osm && opts.shape) osm = clipToShape(osm, opts.shape);
  const footprints = osm?.buildings ?? [];
  const site: SiteData = {
    bbox,
    origin: [Math.round((bbox.minE + bbox.maxE) / 20) * 10, Math.round((bbox.minN + bbox.maxN) / 20) * 10],
    dtm, dsm,
    buildings: buildingHeights(footprints, dtm, dsm, opts.heights),
    lines: osm?.lines ?? [],
    areas: osm?.areas ?? [],
    trees: osm?.trees ?? [],
    points: osm?.points ?? [],
    shape: opts.shape,
    osmOffset: offset,
    fetchedAt: new Date().toISOString(),
    filledCells: filled,
  };
  return { site, inputs: { footprints } };
}

/** ESRI ASCII grid (opens in QGIS, ArcGIS, Rhino plugins, Global Mapper). */
export function rasterToAsc(r: Raster): string {
  const head = `ncols ${r.width}\nnrows ${r.height}\nxllcorner ${r.minE}\nyllcorner ${r.maxN - r.height * r.res}\n` +
    `cellsize ${r.res}\nNODATA_value -9999\n`;
  const rows: string[] = [];
  for (let j = 0; j < r.height; j++) {
    const row = new Array<string>(r.width);
    for (let i = 0; i < r.width; i++) {
      const v = r.data[j * r.width + i];
      row[i] = Number.isNaN(v) ? '-9999' : v.toFixed(2);
    }
    rows.push(row.join(' '));
  }
  return head + rows.join('\n') + '\n';
}

/** The aligned vector dataset as GeoJSON in EPSG:27700 (OGC CRS84 is not used). */
export function siteToGeoJson(site: SiteData): string {
  const features: unknown[] = [];
  const close = (r: [number, number][]) => [...r, r[0]];
  for (const b of site.buildings) {
    features.push({
      type: 'Feature', id: b.id,
      properties: { layer: 'building', ground_m: +b.ground.toFixed(2), top_m: +b.top.toFixed(2), height_m: +(b.top - b.ground).toFixed(2), height_source: b.source,
        ...(b.roofParts ? { roof_parts: b.roofParts.map((r) => r.type).join(','), eaves_m: +Math.min(...b.roofParts.map((r) => r.eaves)).toFixed(2), ridge_m: +Math.max(...b.roofParts.map((r) => r.ridge)).toFixed(2) } : {}),
        ...(b.listed ? { listed_grade: b.listed.grade, listed_entry: b.listed.entry, listed_name: b.listed.name } : {}), ...b.tags },
      geometry: { type: 'Polygon', coordinates: b.rings.map(close) },
    });
  }
  for (const a of site.areas) {
    features.push({ type: 'Feature', id: a.id, properties: { layer: a.kind, ...a.tags }, geometry: { type: 'Polygon', coordinates: a.rings.map(close) } });
  }
  for (const l of site.lines) {
    features.push({ type: 'Feature', id: l.id, properties: { layer: l.kind, bridge: l.bridge, tunnel: l.tunnel, ...l.tags }, geometry: { type: 'LineString', coordinates: l.coords } });
  }
  for (const t of site.trees) features.push({ type: 'Feature', properties: { layer: 'tree' }, geometry: { type: 'Point', coordinates: t } });
  for (const q of site.points) features.push({ type: 'Feature', id: q.id, properties: { layer: q.kind, ...q.tags }, geometry: { type: 'Point', coordinates: q.p } });
  if (site.shape) features.push({ type: 'Feature', properties: { layer: 'site' }, geometry: { type: 'Polygon', coordinates: [[...site.shape, site.shape[0]]] } });
  return JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27700' } },
    features,
  });
}
