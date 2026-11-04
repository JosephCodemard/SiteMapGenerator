import { pointInRings } from './clip';
import { rasterizePolygons } from './geom';
import type { BBox, Building, Raster, Ring, SiteData } from '../types';

/**
 * What can be read from a user-supplied orthophoto with plain image processing (no ML, nothing uploaded):
 * - vegetation (excess-green index), so LIDAR cells over trees are not mistaken for roofs;
 * - mean roof colour per building;
 * - road paint: white / yellow blobs standing out from the asphalt, kept as detected markings.
 * It needs the pixels, not the canvas, so every function takes an RGBA buffer on a north-up box.
 */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  bbox: BBox;
}

export const pixelsOf = (canvas: HTMLCanvasElement, bbox: BBox): Pixels => ({
  data: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height, bbox,
});

const px = (im: Pixels, e: number, n: number) => {
  const i = Math.floor(((e - im.bbox.minE) / (im.bbox.maxE - im.bbox.minE)) * im.width), j = Math.floor(((im.bbox.maxN - n) / (im.bbox.maxN - im.bbox.minN)) * im.height);
  return i >= 0 && j >= 0 && i < im.width && j < im.height ? (j * im.width + i) * 4 : -1;
};

/** Excess green, 0-1 (2g - r - b, normalised): > 0.5 reads as plant cover. */
const greenness = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (2 * g - r - b) / 255 * 3 + 0.0));

/** Vegetation on the DTM grid (mean greenness per cell, then thresholded at 0.5 by the roof fitter). */
export function vegetationRaster(im: Pixels, grid: Raster): Raster {
  const out = new Float32Array(grid.width * grid.height);
  const cell = (im.width / (im.bbox.maxE - im.bbox.minE)) * grid.res; // image pixels per grid cell
  const step = Math.max(1, Math.floor(cell / 4));
  for (let j = 0; j < grid.height; j++) {
    for (let i = 0; i < grid.width; i++) {
      const e0 = grid.minE + i * grid.res, n1 = grid.maxN - j * grid.res;
      let s = 0, c = 0;
      for (let dy = 0; dy < cell; dy += step) for (let dx = 0; dx < cell; dx += step) {
        const k = px(im, e0 + (dx / cell) * grid.res, n1 - (dy / cell) * grid.res);
        if (k < 0) continue;
        s += greenness(im.data[k], im.data[k + 1], im.data[k + 2]); c++;
      }
      out[j * grid.width + i] = c ? s / c : 0;
    }
  }
  return { ...grid, data: out };
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Mean non-green colour inside each footprint (the roof, seen from above). */
export function roofColours(im: Pixels, buildings: Building[]): number {
  let n = 0;
  for (const b of buildings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [e, nn] of b.rings[0]) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, nn); y1 = Math.max(y1, nn); }
    let r = 0, g = 0, bl = 0, c = 0;
    const stp = Math.max(0.25, (im.bbox.maxE - im.bbox.minE) / im.width);
    for (let e = x0; e <= x1; e += stp) for (let nn = y0; nn <= y1; nn += stp) {
      if (!pointInRings(e, nn, b.rings)) continue;
      const k = px(im, e, nn);
      if (k < 0 || greenness(im.data[k], im.data[k + 1], im.data[k + 2]) > 0.5) continue;
      r += im.data[k]; g += im.data[k + 1]; bl += im.data[k + 2]; c++;
    }
    if (c >= 6) { b.roofColour = hex(r / c, g / c, bl / c); n++; }
  }
  return n;
}

/**
 * Road paint: inside the road polygons, pixels much brighter than the asphalt (white) or yellow become blobs; thin
 * elongated blobs (lines) and bar-like blobs (zebra stripes) are kept as rectangles. Needs about 15 cm pixels or finer.
 */
export function detectPaint(im: Pixels, roads: Ring[][]): { kind: 'detected'; colour: 'white' | 'yellow'; ring: Ring }[] {
  const res = (im.bbox.maxE - im.bbox.minE) / im.width;
  if (res > 0.3 || !roads.length) return [];
  const grid = { width: im.width, height: im.height, minE: im.bbox.minE, maxN: im.bbox.maxN, res };
  const mask = rasterizePolygons(roads, grid);
  const lum = (k: number) => 0.3 * im.data[k] + 0.59 * im.data[k + 1] + 0.11 * im.data[k + 2];
  const ls: number[] = [];
  for (let m = 0; m < mask.length; m += 7) if (mask[m]) ls.push(lum(m * 4));
  if (ls.length < 200) return [];
  ls.sort((a, b) => a - b);
  const asphalt = ls[Math.floor(ls.length / 2)];
  const class_ = new Uint8Array(mask.length); // 1 white, 2 yellow
  for (let m = 0; m < mask.length; m++) {
    if (!mask[m]) continue;
    const k = m * 4, r = im.data[k], g = im.data[k + 1], b = im.data[k + 2];
    if (r > 150 && g > 130 && b < 0.6 * g && r - b > 70) class_[m] = 2;
    else if (lum(k) > asphalt + 55 && Math.max(r, g, b) - Math.min(r, g, b) < 45) class_[m] = 1;
  }
  const out: { kind: 'detected'; colour: 'white' | 'yellow'; ring: Ring }[] = [];
  const seen = new Uint8Array(mask.length);
  for (let m = 0; m < class_.length; m++) {
    if (!class_[m] || seen[m]) continue;
    const cls = class_[m], comp: number[] = [], stack = [m];
    seen[m] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      comp.push(q);
      const x = q % im.width;
      for (const nb of [x > 0 ? q - 1 : -1, x < im.width - 1 ? q + 1 : -1, q - im.width, q + im.width]) {
        if (nb >= 0 && nb < class_.length && class_[nb] === cls && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    if (comp.length * res * res < 0.04) continue; // < 0.04 m2: speckle
    const pts: Ring = comp.map((q) => [im.bbox.minE + ((q % im.width) + 0.5) * res, im.bbox.maxN - (Math.floor(q / im.width) + 0.5) * res]);
    // Oriented extent by principal axes (the blob's points are unordered, so a hull-edge search would not do).
    let mx = 0, my = 0;
    for (const q of pts) { mx += q[0]; my += q[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of pts) { sxx += (q[0] - mx) ** 2; syy += (q[1] - my) ** 2; sxy += (q[0] - mx) * (q[1] - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax: [number, number] = [Math.cos(th), Math.sin(th)];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of pts) {
      const u = (q[0] - mx) * ax[0] + (q[1] - my) * ax[1], v = -(q[0] - mx) * ax[1] + (q[1] - my) * ax[0];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const len = u1 - u0 + res, wid = v1 - v0 + res;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const box = { axis: ax, centre: [mx + cu * ax[0] - cv * ax[1], my + cu * ax[1] + cv * ax[0]] as [number, number] };
    // Markings are long and narrow (a line 0.1-0.4 m wide, a zebra bar 0.5 m x 3 m), and well filled by their box.
    if (len < 0.4 || wid > 0.8 || comp.length * res * res < 0.55 * len * wid) continue;
    const [ux, uy] = box.axis, [cx, cy] = box.centre;
    const w = Math.max(wid, 0.1) / 2, l = len / 2;
    out.push({
      kind: 'detected', colour: cls === 2 ? 'yellow' : 'white',
      ring: [[cx - ux * l + uy * w, cy - uy * l - ux * w], [cx + ux * l + uy * w, cy + uy * l - ux * w], [cx + ux * l - uy * w, cy + uy * l + ux * w], [cx - ux * l - uy * w, cy - uy * l + ux * w]],
    });
  }
  return out;
}

/** Run every imagery analysis on a site; returns a one-line summary for the log. */
export function applyImagery(site: SiteData, im: Pixels, roadPolys: Ring[][]): string {
  site.vegetation = vegetationRaster(im, site.dtm);
  const coloured = roofColours(im, site.buildings);
  site.detectedMarkings = detectPaint(im, roadPolys);
  const veg = site.vegetation.data.reduce((a, v) => a + (v > 0.5 ? 1 : 0), 0) / site.vegetation.data.length;
  return `Imagery analysed: ${Math.round(veg * 100)}% vegetation (ignored when fitting roofs), ${coloured} roof colours, ${site.detectedMarkings.length} paint markings` +
    `${(im.bbox.maxE - im.bbox.minE) / im.width > 0.3 ? ' (pixels coarser than 30 cm: paint not attempted)' : ''}.`;
}
