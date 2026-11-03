import proj4 from 'proj4';
import table from './ostn15-correction.json';
import type { BBox, XY } from '../types';

// proj4js only does the 7-parameter Helmert for OSGB36 (2-5 m error). We add an
// OSTN15 correction sampled on a 5 km grid (tools/build_ostn15_correction.py),
// which brings WGS84/ETRS89 <-> BNG to cm-level accuracy across England & Wales.
proj4.defs(
  'EPSG:27700',
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
    '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
);
const helmert = proj4('EPSG:4326', 'EPSG:27700');

function correction(e: number, n: number): XY {
  const { e0, n0, step, nx, ny, dx, dy } = table;
  const fx = Math.min(Math.max((e - e0) / step, 0), nx - 1.000001);
  const fy = Math.min(Math.max((n - n0) / step, 0), ny - 1.000001);
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const k = j * nx + i;
  const lerp = (a: number[]) =>
    ((1 - tx) * (1 - ty) * a[k] + tx * (1 - ty) * a[k + 1] +
      (1 - tx) * ty * a[k + nx] + tx * ty * a[k + nx + 1]) / 1000;
  return [lerp(dx), lerp(dy)];
}

/** WGS84 lon/lat -> BNG easting/northing. */
export function toBNG(lon: number, lat: number): XY {
  const [e, n] = helmert.forward([lon, lat]);
  const [dx, dy] = correction(e, n);
  return [e + dx, n + dy];
}

/** BNG easting/northing -> WGS84 lon/lat. */
export function toWGS(e: number, n: number): XY {
  const [dx, dy] = correction(e, n);
  const [lon, lat] = helmert.inverse([e - dx, n - dy]);
  return [lon, lat];
}

/** Lon/lat bounding box enclosing a BNG bbox. */
export function bboxToWGS(b: BBox): { west: number; south: number; east: number; north: number } {
  const pts = [
    toWGS(b.minE, b.minN), toWGS(b.maxE, b.minN),
    toWGS(b.maxE, b.maxN), toWGS(b.minE, b.maxN),
  ];
  return {
    west: Math.min(...pts.map((p) => p[0])),
    east: Math.max(...pts.map((p) => p[0])),
    south: Math.min(...pts.map((p) => p[1])),
    north: Math.max(...pts.map((p) => p[1])),
  };
}

const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

/** Parse an OS grid reference like "ST 750 647" or "ST7500064700". */
export function parseGridRef(s: string): XY | null {
  const m = s.toUpperCase().replace(/\s+/g, '').match(/^([A-HJ-Z])([A-HJ-Z])(\d*)$/);
  if (!m || m[3].length % 2 !== 0 || m[3].length > 10) return null;
  const l1 = LETTERS.indexOf(m[1]), l2 = LETTERS.indexOf(m[2]);
  // 500 km squares, then 100 km squares (see OS "A guide to coordinate systems").
  const e100 = ((l1 - 2) % 5) * 5 + (l2 % 5);
  const n100 = 19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5);
  const half = m[3].length / 2;
  const scale = 10 ** (5 - half);
  const de = half ? Number(m[3].slice(0, half)) * scale : 0;
  const dn = half ? Number(m[3].slice(half)) * scale : 0;
  return [e100 * 100000 + de + scale / 2 * (half ? 1 : 0), n100 * 100000 + dn + scale / 2 * (half ? 1 : 0)];
}
