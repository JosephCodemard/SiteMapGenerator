// @ts-nocheck
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { fetchOsm, parseOsm, shiftAndClip } from '../../src/data/osm';
import { estimateOffset } from '../../src/process/align';
import { attachParts, buildingHeights } from '../../src/process/buildings';
import { fillNoData } from '../../src/process/raster';
import type { BBox, Raster, SiteData } from '../../src/types';

/** Real-data helper for optional tests: `BATH_DATA=<dir>` holds `<name>_dsm.tif`, `<name>_dtm.tif` (EA WCS downloads). */
export const dataDir = process.env.BATH_DATA ?? '';

async function loadTif(path: string, bbox: BBox): Promise<Raster> {
  const buf = readFileSync(path);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const img = await tiff.getImage();
  const w = img.getWidth(), h = img.getHeight();
  const [tMinE, , , tMaxN] = img.getBoundingBox();
  const band = (await img.readRasters({ samples: [0] }))[0] as ArrayLike<number>;
  const data = new Float32Array(w * h);
  for (let k = 0; k < data.length; k++) data[k] = band[k] < -1000 || !Number.isFinite(band[k]) ? NaN : band[k];
  void bbox;
  return { width: w, height: h, minE: tMinE, maxN: tMaxN, res: 1, data };
}

/** Build a SiteData offline from saved LIDAR plus an Overpass response (fetched once and cached next to the rasters). */
export async function loadSite(name: string, bbox: BBox): Promise<SiteData> {
  const dtm = await loadTif(`${dataDir}/${name}_dtm.tif`, bbox);
  const dsm = await loadTif(`${dataDir}/${name}_dsm.tif`, bbox);
  fillNoData(dtm);
  for (let k = 0; k < dsm.data.length; k++) if (Number.isNaN(dsm.data[k])) dsm.data[k] = dtm.data[k];
  const cache = `${dataDir}/${name}_osm.json`;
  let raw: unknown;
  if (existsSync(cache)) raw = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    // fetchOsm parses internally; to cache the raw JSON, call the same endpoint through it once.
    const { bboxToWGS } = await import('../../src/geo/bng');
    const w = bboxToWGS(bbox);
    const q = `[out:json][timeout:120];(wr["building"](${w.south},${w.west},${w.north},${w.east});wr["building:part"](${w.south},${w.west},${w.north},${w.east});way["highway"](${w.south},${w.west},${w.north},${w.east});way["railway"](${w.south},${w.west},${w.north},${w.east});way["waterway"](${w.south},${w.west},${w.north},${w.east});wr["natural"="water"](${w.south},${w.west},${w.north},${w.east});wr["waterway"="riverbank"](${w.south},${w.west},${w.north},${w.east});wr["man_made"="bridge"](${w.south},${w.west},${w.north},${w.east});way["barrier"~"wall|retaining_wall|fence"](${w.south},${w.west},${w.north},${w.east}););out body;>;out skel qt;`;
    void fetchOsm;
    // Overpass is flaky and rejects unknown clients: retry across mirrors with a User-Agent.
    const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    for (let attempt = 0; attempt < 9 && !raw; attempt++) {
      try {
        const res = await fetch(urls[attempt % 3], { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'uk-site-model-tests/1.0' }, signal: AbortSignal.timeout(100_000) });
        if (res.ok) raw = await res.json();
      } catch { /* try the next mirror */ }
      if (!raw) await new Promise((r) => setTimeout(r, 4000));
    }
    if (!raw) throw new Error('Overpass unavailable');
    writeFileSync(cache, JSON.stringify(raw));
  }
  const padded = { minE: bbox.minE - 5, minN: bbox.minN - 5, maxE: bbox.maxE + 5, maxN: bbox.maxN + 5 };
  const rawOsm = parseOsm(raw, padded);
  const { offset } = estimateOffset(rawOsm.buildings.map((b) => b.rings), dtm, dsm);
  const osm = shiftAndClip(rawOsm, offset, bbox);
  const buildings = buildingHeights(osm.buildings, dtm, dsm);
  attachParts(buildings, osm.parts);
  return {
    bbox, origin: [Math.round((bbox.minE + bbox.maxE) / 20) * 10, Math.round((bbox.minN + bbox.maxN) / 20) * 10], dtm, dsm,
    buildings, lines: osm.lines, areas: osm.areas, trees: osm.trees, points: osm.points,
    osmOffset: offset, fetchedAt: '', filledCells: 0,
  };
}
