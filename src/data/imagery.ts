import { fromArrayBuffer } from 'geotiff';
import { toBNG } from '../geo/bng';
import type { BBox } from '../types';

/**
 * Bring-your-own imagery. There is no open, keyless, high-resolution orthophoto service we can pull live, so the
 * user drops in a georeferenced image they are licensed to use: GeoTIFF (EPSG:27700, 4326 or 3857) or JPG/PNG with a
 * world file (BNG). It is resampled onto the site box and can underlay drawings and texture the 3D terrain.
 */
export interface Imagery {
  /** Canvas covering exactly `bbox` (north up). */
  canvas: HTMLCanvasElement;
  bbox: BBox;
  /** Ground size of one pixel in the source (m). */
  sourceRes: number;
  name: string;
  licence: string;
  note?: string;
}

/** Parse an ESRI world file (6 lines) into affine terms. */
export function parseWorldFile(text: string): { a: number; d: number; b: number; e: number; c: number; f: number } {
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length < 6 || v.some((x) => !Number.isFinite(x))) throw new Error('Not a valid world file (expected 6 numbers).');
  const [a, d, b, e, c, f] = v;
  return { a, d, b, e, c, f };
}

/** BNG bounds of an axis-aligned image from its world file (centre-of-pixel convention) and size. */
export function worldFileBounds(wf: ReturnType<typeof parseWorldFile>, w: number, h: number): BBox {
  if (Math.abs(wf.b) > 1e-9 || Math.abs(wf.d) > 1e-9) throw new Error('Rotated images are not supported: resample to north-up first.');
  const west = wf.c - wf.a / 2, north = wf.f - wf.e / 2;
  return { minE: west, maxN: north, maxE: west + wf.a * w, minN: north + wf.e * h };
}

/** Draw `src` (covering `srcBox`) into a canvas covering `site`. */
export function resampleToSite(src: CanvasImageSource & { width: number; height: number }, srcBox: BBox, site: BBox, maxPx = 4096): HTMLCanvasElement {
  const sw = site.maxE - site.minE, sh = site.maxN - site.minN;
  const px = Math.min(maxPx, Math.max(256, Math.round(Math.max(sw, sh) * (src.width / (srcBox.maxE - srcBox.minE)))));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(px * (sw >= sh ? 1 : sw / sh)); canvas.height = Math.round(px * (sh >= sw ? 1 : sh / sw));
  const k = canvas.width / sw;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (srcBox.minE - site.minE) * k, (site.maxN - srcBox.maxN) * k, (srcBox.maxE - srcBox.minE) * k, (srcBox.maxN - srcBox.minN) * k);
  return canvas;
}

const overlaps = (a: BBox, b: BBox) => a.minE < b.maxE && a.maxE > b.minE && a.minN < b.maxN && a.maxN > b.minN;

/** GeoTIFF bounds in BNG (corners transformed when the file is in lat/lon or Web Mercator; treated as axis-aligned). */
export function geotiffBounds(box: number[], epsg: number): { bbox: BBox; approx: boolean } {
  const [x0, y0, x1, y1] = box;
  if (epsg === 27700) return { bbox: { minE: x0, minN: y0, maxE: x1, maxN: y1 }, approx: false };
  const toLonLat = (x: number, y: number): [number, number] => {
    if (epsg === 4326) return [x, y];
    if (epsg === 3857) return [(x / 20037508.34) * 180, (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90];
    throw new Error(`Unsupported GeoTIFF projection EPSG:${epsg}. Use EPSG:27700, 4326 or 3857.`);
  };
  const [sw, ne] = [toBNG(...toLonLat(x0, y0)), toBNG(...toLonLat(x1, y1))];
  return { bbox: { minE: sw[0], minN: sw[1], maxE: ne[0], maxN: ne[1] }, approx: true };
}

async function loadGeoTiff(buf: ArrayBuffer, site: BBox): Promise<{ canvas: HTMLCanvasElement; bbox: BBox; res: number; note?: string }> {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const keys = img.getGeoKeys() as { ProjectedCSTypeGeoKey?: number; GeographicTypeGeoKey?: number };
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? 27700;
  const { bbox, approx } = geotiffBounds(img.getBoundingBox(), epsg);
  if (!overlaps(bbox, site)) throw new Error('This image does not overlap the site.');
  const w = img.getWidth(), h = img.getHeight();
  const bands = await img.readRasters({ interleave: true }) as unknown as ArrayLike<number>;
  const n = img.getSamplesPerPixel();
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const data = new ImageData(w, h);
  // 8-bit RGB(A) or single band; 16-bit is scaled by its maximum.
  let max = 255;
  if (bands instanceof Uint16Array) max = 65535;
  for (let k = 0; k < w * h; k++) {
    const r = bands[k * n], g = n > 2 ? bands[k * n + 1] : r, b = n > 2 ? bands[k * n + 2] : r;
    data.data[k * 4] = (r / max) * 255; data.data[k * 4 + 1] = (g / max) * 255; data.data[k * 4 + 2] = (b / max) * 255; data.data[k * 4 + 3] = 255;
  }
  src.getContext('2d')!.putImageData(data, 0, 0);
  return { canvas: resampleToSite(src, bbox, site), bbox, res: (bbox.maxE - bbox.minE) / w, note: approx ? 'Reprojected by its corners (treated as north-up in BNG): check alignment.' : undefined };
}

/** Load imagery from a GeoTIFF, or a JPG/PNG plus its world file. */
export async function loadImagery(files: File[], site: BBox, licence: string): Promise<Imagery> {
  const tif = files.find((f) => /\.tiff?$/i.test(f.name));
  if (tif) {
    const r = await loadGeoTiff(await tif.arrayBuffer(), site);
    return { canvas: r.canvas, bbox: site, sourceRes: r.res, name: tif.name, licence, note: r.note };
  }
  const image = files.find((f) => /\.(jpe?g|png)$/i.test(f.name));
  const world = files.find((f) => /\.(jgw|pgw|wld|jpgw|pngw)$/i.test(f.name));
  if (!image || !world) throw new Error('Choose a GeoTIFF, or a JPG/PNG together with its world file (.jgw/.pgw/.wld).');
  const bmp = await createImageBitmap(image);
  const wf = parseWorldFile(await world.text());
  const bbox = worldFileBounds(wf, bmp.width, bmp.height);
  if (!overlaps(bbox, site)) throw new Error('This image does not overlap the site (the world file is expected in British National Grid).');
  return { canvas: resampleToSite(bmp, bbox, site), bbox: site, sourceRes: Math.abs(wf.a), name: image.name, licence };
}
