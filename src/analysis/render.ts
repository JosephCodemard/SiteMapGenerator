import { hillshade, downsample } from '../process/raster';
import type { FlowEdge } from './footfall';
import type { Raster, Ring, SiteData } from '../types';

/** Colour ramps as [stop, [r, g, b]] with stop in 0..1. */
export type Ramp = [number, [number, number, number]][];

export const RAMPS: Record<string, Ramp> = {
  sun: [[0, [32, 40, 100]], [0.35, [70, 90, 170]], [0.7, [250, 200, 70]], [1, [255, 245, 150]]],
  depth: [[0, [190, 225, 250]], [0.5, [60, 130, 220]], [1, [10, 40, 140]]],
  heat: [[0, [255, 245, 170]], [0.4, [250, 170, 60]], [0.75, [220, 60, 40]], [1, [110, 10, 40]]],
  wind: [[0, [60, 140, 200]], [0.5, [250, 250, 200]], [1, [200, 60, 50]]],
};

export function colour(ramp: Ramp, t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1], [t1, c1] = ramp[i], f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return ramp[ramp.length - 1][1];
}

export const legendGradient = (ramp: Ramp) => `linear-gradient(90deg, ${ramp.map(([t, c]) => `rgb(${c.map(Math.round).join(',')}) ${Math.round(t * 100)}%`).join(', ')})`;

export interface View {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** BNG -> canvas pixel. */
  px: (e: number, n: number) => [number, number];
  scale: number;
}

/** Grey hillshade with building footprints and roads: the base every result is drawn over. */
export function baseView(site: SiteData, width = 1200): View {
  const { minE, minN, maxE, maxN } = site.bbox;
  const w = maxE - minE, h = maxN - minN;
  const scale = width / w;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width); canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d')!;
  const px = (e: number, n: number): [number, number] => [(e - minE) * scale, (maxN - n) * scale];
  ctx.fillStyle = '#f2f1ec';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const f = Math.max(1, Math.ceil(Math.sqrt((site.dtm.width * site.dtm.height) / 1e6)));
  const r = downsample(site.dtm, f);
  const tmp = document.createElement('canvas');
  tmp.width = r.width; tmp.height = r.height;
  const img = new ImageData(hillshade(r) as ImageDataArray, r.width, r.height);
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.35;
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
  const path = (ring: Ring) => { ring.forEach((p, i) => { const [x, y] = px(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
  ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = Math.max(1, scale * 4);
  for (const l of site.lines) {
    if (!/^road|path/.test(l.kind)) continue;
    ctx.lineWidth = l.kind === 'path' ? Math.max(0.6, scale * 1.2) : Math.max(1, scale * 4);
    ctx.beginPath(); path(l.coords); ctx.stroke();
  }
  return { canvas, ctx, px, scale };
}

export function drawBuildings(v: View, site: SiteData, fill = 'rgba(70,70,70,0.55)') {
  v.ctx.fillStyle = fill; v.ctx.strokeStyle = '#222'; v.ctx.lineWidth = 0.6;
  for (const b of site.buildings) {
    v.ctx.beginPath();
    for (const r of b.rings) { r.forEach((p, i) => { const [x, y] = v.px(p[0], p[1]); i ? v.ctx.lineTo(x, y) : v.ctx.moveTo(x, y); }); v.ctx.closePath(); }
    v.ctx.fill('evenodd'); v.ctx.stroke();
  }
}

/** Draw per-cell values over the view: `value(k)` returns a 0..1 position on the ramp, or NaN to skip. */
export function drawRaster(v: View, r: Raster, value: (k: number) => number, ramp: Ramp, alpha = 0.75) {
  const tmp = document.createElement('canvas');
  tmp.width = r.width; tmp.height = r.height;
  const img = new ImageData(r.width, r.height);
  for (let k = 0; k < r.width * r.height; k++) {
    const t = value(k);
    if (Number.isNaN(t)) continue;
    const [R, G, B] = colour(ramp, t);
    img.data[k * 4] = R; img.data[k * 4 + 1] = G; img.data[k * 4 + 2] = B; img.data[k * 4 + 3] = Math.round(alpha * 255);
  }
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  const [x0, y0] = v.px(r.minE, r.maxN), [x1, y1] = v.px(r.minE + r.width * r.res, r.maxN - r.height * r.res);
  v.ctx.imageSmoothingEnabled = false;
  v.ctx.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);
}

export function drawEdges(v: View, edges: FlowEdge[], ramp: Ramp) {
  v.ctx.lineCap = 'round';
  for (const e of [...edges].sort((a, b) => a.flow - b.flow)) {
    if (e.flow <= 0) continue;
    const [r, g, b] = colour(ramp, e.flow);
    v.ctx.strokeStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    v.ctx.lineWidth = Math.max(1.5, v.scale * (2 + 9 * e.flow));
    const [x0, y0] = v.px(e.a[0], e.a[1]), [x1, y1] = v.px(e.b[0], e.b[1]);
    v.ctx.beginPath(); v.ctx.moveTo(x0, y0); v.ctx.lineTo(x1, y1); v.ctx.stroke();
  }
}

export function drawPolygons(v: View, polys: Ring[][], fill: string, stroke: string) {
  v.ctx.fillStyle = fill; v.ctx.strokeStyle = stroke; v.ctx.lineWidth = 1.2;
  for (const rings of polys) {
    v.ctx.beginPath();
    for (const r of rings) { r.forEach((p, i) => { const [x, y] = v.px(p[0], p[1]); i ? v.ctx.lineTo(x, y) : v.ctx.moveTo(x, y); }); v.ctx.closePath(); }
    v.ctx.fill('evenodd'); v.ctx.stroke();
  }
}

export function drawOutline(v: View, shape: Ring) {
  v.ctx.strokeStyle = '#e0006b'; v.ctx.lineWidth = 2; v.ctx.setLineDash([8, 4]);
  v.ctx.beginPath(); shape.forEach((p, i) => { const [x, y] = v.px(p[0], p[1]); i ? v.ctx.lineTo(x, y) : v.ctx.moveTo(x, y); }); v.ctx.closePath(); v.ctx.stroke();
  v.ctx.setLineDash([]);
}
