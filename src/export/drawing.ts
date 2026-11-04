import { buildContext } from '../process/context';
import type { ContourLine } from '../process/contours';
import { roofLines } from '../process/roofs';
import { offsetOutline, resample } from '../process/ribbon';
import type { Tree } from '../process/trees';
import type { BBox, Ring, SiteData, XY } from '../types';

/** A layer in the 2D drawing model, shared by the SVG, PNG and DXF writers. */
export interface Layer {
  name: string; // CAD-style layer name
  label: string; // UI label
  stroke: string;
  /** AutoCAD Color Index for DXF. */
  aci: number;
  /** Line weight on paper (mm). */
  weight: number;
  fill?: string;
  dash?: string;
  items: Item[];
}

export type Item =
  | { t: 'line'; pts: Ring; z?: number; dashed?: boolean }
  | { t: 'poly'; rings: Ring[]; z?: number; thickness?: number }
  | { t: 'circle'; c: XY; r: number }
  /** A tree symbol at its true crown radius (a block INSERT in DXF). */
  | { t: 'tree'; c: XY; r: number }
  | { t: 'text'; p: XY; text: string; size: number; angle?: number };

/** Which context features are part of the drawing (mirrors the 3D feature switches). */
export interface DrawingFeatures {
  buildings: boolean;
  roads: boolean;
  paths: boolean;
  rail: boolean;
  water: boolean;
  green: boolean;
  bridges: boolean;
  walls: boolean;
  /** Trees to draw at crown radius (none = no trees). */
  trees: Tree[];
  /** Ridge and hip lines for buildings that have a fitted roof. */
  roofs: boolean;
}

export const ALL_FEATURES: DrawingFeatures = {
  buildings: true, roads: true, paths: true, rail: true, water: true, green: true, bridges: true, walls: true, trees: [], roofs: true,
};

export interface DrawingOptions {
  layers: Record<string, boolean>;
  buildingLabels: boolean;
  features?: DrawingFeatures;
}

export const LAYER_DEFS: Omit<Layer, 'items'>[] = [
  { name: 'GREEN', label: 'Parks & green space', stroke: '#9cc28a', aci: 82, weight: 0.13, fill: '#e3f0da' },
  { name: 'WOOD', label: 'Woodland', stroke: '#7aa56a', aci: 94, weight: 0.13, fill: '#cfe3c3' },
  { name: 'PAVED', label: 'Squares & pedestrian areas', stroke: '#c9c2b8', aci: 254, weight: 0.13, fill: '#f1ede7' },
  { name: 'WATER', label: 'Rivers & water bodies', stroke: '#5b9bd5', aci: 150, weight: 0.18, fill: '#cfe4f7' },
  { name: 'WATERWAY', label: 'River centrelines', stroke: '#3d7fc4', aci: 150, weight: 0.13, dash: '2 1' },
  { name: 'CONTOUR-MINOR', label: 'Contours (minor)', stroke: '#b08a5a', aci: 33, weight: 0.13 },
  { name: 'CONTOUR-MAJOR', label: 'Contours (major)', stroke: '#8a5a2b', aci: 32, weight: 0.3 },
  { name: 'CONTOUR-LABEL', label: 'Contour labels', stroke: '#8a5a2b', aci: 32, weight: 0.13 },
  { name: 'PATH', label: 'Footpaths & cycleways', stroke: '#8c8c8c', aci: 8, weight: 0.13, fill: '#f4efe6' },
  { name: 'ROAD-SURFACE', label: 'Roads (kerb lines)', stroke: '#333333', aci: 251, weight: 0.25, fill: '#ebebeb' },
  { name: 'ROAD-MINOR', label: 'Minor road centrelines', stroke: '#777777', aci: 9, weight: 0.13, dash: '3 1' },
  { name: 'ROAD-MAJOR', label: 'Major road centrelines', stroke: '#555555', aci: 8, weight: 0.18, dash: '3 1' },
  { name: 'RAIL', label: 'Railways', stroke: '#000000', aci: 7, weight: 0.35, fill: '#e2dfdb' },
  { name: 'RAIL-CL', label: 'Railway centrelines', stroke: '#000000', aci: 7, weight: 0.25, dash: '3 1' },
  { name: 'BRIDGE', label: 'Bridges', stroke: '#d0342c', aci: 1, weight: 0.5, fill: '#f6d9d6' },
  { name: 'WALL', label: 'Walls & fences', stroke: '#6b5a44', aci: 30, weight: 0.25 },
  { name: 'BUILDINGS', label: 'Building footprints', stroke: '#1a1a1a', aci: 7, weight: 0.35, fill: '#d9d4cc' },
  { name: 'ROOF', label: 'Roof ridges & hips', stroke: '#555555', aci: 8, weight: 0.18 },
  { name: 'BLDG-LABEL', label: 'Building heights', stroke: '#444444', aci: 8, weight: 0.13 },
  { name: 'TREES', label: 'Trees', stroke: '#4f8a3c', aci: 96, weight: 0.18 },
  { name: 'BOUNDARY', label: 'Site boundary', stroke: '#e0006b', aci: 6, weight: 0.5, dash: '4 1 1 1' },
];

/** Layers that start switched off (centrelines and labels are available but not shown by default). */
const OFF_BY_DEFAULT = new Set(['BLDG-LABEL', 'ROAD-MINOR', 'ROAD-MAJOR', 'RAIL-CL', 'WATERWAY']);

export function defaultLayerToggles(): Record<string, boolean> {
  return Object.fromEntries(LAYER_DEFS.map((l) => [l.name, !OFF_BY_DEFAULT.has(l.name)]));
}

/** Which drawing layers belong to each feature switch (so one checkbox controls model and drawing). */
export const FEATURE_LAYERS: Record<string, string[]> = {
  roads: ['ROAD-SURFACE', 'ROAD-MINOR', 'ROAD-MAJOR'],
  paths: ['PATH'],
  rail: ['RAIL', 'RAIL-CL'],
  water: ['WATER', 'WATERWAY'],
  green: ['GREEN', 'WOOD', 'PAVED'],
  bridges: ['BRIDGE'],
  walls: ['WALL'],
  trees: ['TREES'],
  buildings: ['BUILDINGS', 'ROOF', 'BLDG-LABEL'],
};

const LINE_LAYER: Record<string, string> = {
  'road-major': 'ROAD-MAJOR', 'road-minor': 'ROAD-MINOR', path: 'PATH',
  rail: 'RAIL-CL', river: 'WATERWAY', stream: 'WATERWAY', wall: 'WALL',
};
const AREA_LAYER: Record<string, string> = { green: 'GREEN', wood: 'WOOD', paved: 'PAVED' };

/** Build the layered drawing (BNG coordinates) from the dataset + contours. */
export function buildDrawing(site: SiteData, contours: ContourLine[], opts: DrawingOptions): Layer[] {
  const f = opts.features ?? ALL_FEATURES;
  const ctx = buildContext(site);
  const layers = new Map(LAYER_DEFS.map((d) => [d.name, { ...d, items: [] as Item[] }]));
  const add = (name: string, item: Item) => layers.get(name)!.items.push(item);

  if (f.green) for (const a of ctx.areas) add(AREA_LAYER[a.kind], { t: 'poly', rings: a.polygon });
  if (f.water) for (const p of ctx.water) add('WATER', { t: 'poly', rings: p });
  if (f.roads) for (const p of ctx.roads) add('ROAD-SURFACE', { t: 'poly', rings: p });
  if (f.paths) for (const p of ctx.paths) add('PATH', { t: 'poly', rings: p });
  if (f.rail) for (const p of ctx.rail) add('RAIL', { t: 'poly', rings: p });
  if (f.bridges) {
    for (const b of ctx.bridges) {
      // Deck outline: the buffered centreline, drawn as one closed polygon.
      const { left, right } = offsetOutline(resample(b.coords, 2), b.width / 2);
      add('BRIDGE', { t: 'poly', rings: [[...left, ...right.reverse()]] });
    }
    for (const a of site.areas) if (a.kind === 'bridge') add('BRIDGE', { t: 'poly', rings: a.rings });
  }
  if (f.walls) for (const w of ctx.walls) add('WALL', { t: 'line', pts: w.coords });
  // Centrelines (off by default) so CAD users can still pick them up; tunnels stay dashed.
  for (const l of site.lines) {
    const layer = LINE_LAYER[l.kind];
    if (!layer || l.kind === 'wall') continue;
    if (l.kind === 'path') continue;
    const feature = l.kind.startsWith('road') ? f.roads : l.kind === 'rail' ? f.rail : f.water;
    if (!feature) continue;
    if (l.tunnel) {
      // Tunnels are not in the polygons: show them dashed on the visible layer.
      add(l.kind.startsWith('road') ? 'ROAD-SURFACE' : l.kind === 'rail' ? 'RAIL' : 'WATER', { t: 'line', pts: l.coords, dashed: true });
    } else add(layer, { t: 'line', pts: l.coords });
  }
  for (const c of contours) {
    add(c.major ? 'CONTOUR-MAJOR' : 'CONTOUR-MINOR', { t: 'line', pts: c.closed ? [...c.coords, c.coords[0]] : c.coords, z: c.level });
    if (c.major && c.coords.length > 8) {
      const k = Math.floor(c.coords.length / 2);
      const [p, q] = [c.coords[k], c.coords[k + 1]];
      let angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      add('CONTOUR-LABEL', { t: 'text', p, text: c.level.toFixed(0), size: 2.5, angle });
    }
  }
  if (f.buildings) {
    for (const b of site.buildings) {
      add('BUILDINGS', { t: 'poly', rings: b.rings, z: b.ground, thickness: b.top - b.ground });
      if (f.roofs && b.roof && b.roof.type !== 'flat') {
        const rl = roofLines(b.roof);
        if (rl.ridge) add('ROOF', { t: 'line', pts: rl.ridge, z: rl.z });
        for (const h of rl.hips) add('ROOF', { t: 'line', pts: h, z: rl.z });
      }
      if (opts.buildingLabels) {
        const [e, n] = centroid(b.rings[0]);
        add('BLDG-LABEL', { t: 'text', p: [e, n], text: `${(b.top - b.ground).toFixed(1)}m`, size: 1.5 });
      }
    }
  }
  for (const t of f.trees) add('TREES', { t: 'tree', c: t.p, r: t.r });
  const { minE, minN, maxE, maxN } = site.bbox;
  add('BOUNDARY', { t: 'line', pts: [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN], [minE, minN]] });

  return [...layers.values()].filter((l) => opts.layers[l.name] !== false && l.items.length);
}

function centroid(r: Ring): XY {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

export interface SheetOptions {
  /** Drawing scale denominator, e.g. 500 for 1:500. */
  scale: number;
  title: string;
  /** Optional raster underlay (data URL) covering the bbox. */
  underlay?: string;
  /** Draw title strip, scale bar and north arrow. */
  furniture: boolean;
}

const MARGIN = 10; // mm
const STRIP = 18; // mm title strip

/** SVG in millimetres at the chosen scale. Layers are Inkscape/Illustrator-friendly groups. */
export function writeSvg(layers: Layer[], bbox: BBox, s: SheetOptions): string {
  const k = 1000 / s.scale; // mm per metre
  const wMap = (bbox.maxE - bbox.minE) * k, hMap = (bbox.maxN - bbox.minN) * k;
  const m = s.furniture ? MARGIN : 0;
  const W = wMap + 2 * m, H = hMap + 2 * m + (s.furniture ? STRIP : 0);
  const X = (e: number) => (m + (e - bbox.minE) * k).toFixed(2);
  const Y = (n: number) => (m + (bbox.maxN - n) * k).toFixed(2);
  const path = (pts: Ring, close: boolean) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])} ${Y(p[1])}`).join('') + (close ? 'Z' : '');

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
      `width="${W.toFixed(2)}mm" height="${H.toFixed(2)}mm" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" ` +
      `font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<clipPath id="site"><rect x="${m}" y="${m}" width="${wMap.toFixed(2)}" height="${hMap.toFixed(2)}"/></clipPath>`,
  ];
  if (s.underlay) {
    out.push(`<g inkscape:groupmode="layer" inkscape:label="HILLSHADE" id="HILLSHADE" opacity="0.45">` +
      `<image href="${s.underlay}" x="${m}" y="${m}" width="${wMap.toFixed(2)}" height="${hMap.toFixed(2)}" preserveAspectRatio="none"/></g>`);
  }
  for (const l of layers) {
    const dash = l.dash ? ` stroke-dasharray="${l.dash}"` : '';
    out.push(`<g inkscape:groupmode="layer" inkscape:label="${l.name}" id="${l.name}" clip-path="url(#site)" ` +
      `stroke="${l.stroke}" stroke-width="${l.weight}" stroke-linejoin="round" stroke-linecap="round" fill="${l.fill ?? 'none'}"${dash}>`);
    for (const it of l.items) {
      if (it.t === 'line') out.push(`<path d="${path(it.pts, false)}"${it.dashed ? ' stroke-dasharray="1.5 1" opacity="0.6"' : ''} fill="none"/>`);
      else if (it.t === 'poly') out.push(`<path d="${it.rings.map((r) => path(r, true)).join('')}" fill-rule="evenodd"/>`);
      else if (it.t === 'circle') out.push(`<circle cx="${X(it.c[0])}" cy="${Y(it.c[1])}" r="${(it.r * k).toFixed(2)}" fill="none"/>`);
      else if (it.t === 'tree') {
        out.push(`<circle cx="${X(it.c[0])}" cy="${Y(it.c[1])}" r="${(it.r * k).toFixed(2)}" fill="#4f8a3c" fill-opacity="0.14"/>` +
          `<circle cx="${X(it.c[0])}" cy="${Y(it.c[1])}" r="${Math.max(0.25, 0.25 * k).toFixed(2)}" fill="${l.stroke}" stroke="none"/>`);
      }
      else {
        out.push(`<text x="${X(it.p[0])}" y="${Y(it.p[1])}" font-size="${it.size}" fill="${l.stroke}" stroke="#fff" ` +
          `stroke-width="0.6" paint-order="stroke" text-anchor="middle" dominant-baseline="middle"` +
          `${it.angle ? ` transform="rotate(${(-it.angle).toFixed(1)} ${X(it.p[0])} ${Y(it.p[1])})"` : ''}>${it.text}</text>`);
      }
    }
    out.push('</g>');
  }
  if (s.furniture) out.push(furniture(W, wMap, hMap, s, bbox));
  out.push('</svg>');
  return out.join('\n');
}

function furniture(W: number, wMap: number, hMap: number, s: SheetOptions, b: BBox): string {
  const m = MARGIN, k = 1000 / s.scale;
  const y0 = m + hMap + 4;
  // Scale bar: a round length close to 1/4 of the map width.
  const target = (wMap / 4) / k;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].reduce((a, c) => (c <= target ? c : a), 1);
  const segs = 4, segLen = (nice * k) / segs;
  const bar = Array.from({ length: segs }, (_, i) =>
    `<rect x="${(m + i * segLen).toFixed(2)}" y="${y0}" width="${segLen.toFixed(2)}" height="2" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.2"/>`).join('');
  const labels = `<text x="${m}" y="${y0 + 6}" font-size="2.5">0</text>` +
    `<text x="${(m + nice * k).toFixed(2)}" y="${y0 + 6}" font-size="2.5" text-anchor="middle">${nice} m</text>`;
  const nx = W - m - 6, ny = y0 + 1;
  const north = `<g transform="translate(${nx.toFixed(2)} ${ny.toFixed(2)})"><path d="M0 -1 L3 9 L0 7 L-3 9 Z" fill="#000"/>` +
    `<text x="0" y="13" font-size="3" text-anchor="middle">N</text></g>`;
  const title = `<text x="${(W / 2).toFixed(2)}" y="${y0 + 3}" font-size="4" text-anchor="middle" font-weight="bold">${escapeXml(s.title)}</text>` +
    `<text x="${(W / 2).toFixed(2)}" y="${y0 + 8}" font-size="2.5" text-anchor="middle">Scale 1:${s.scale} · BNG E ${b.minE}–${b.maxE}, N ${b.minN}–${b.maxN} · Heights m ODN</text>` +
    `<text x="${(W / 2).toFixed(2)}" y="${y0 + 12}" font-size="2" text-anchor="middle" fill="#555">` +
    `Contains Environment Agency LIDAR data © Environment Agency (OGL v3) · © OpenStreetMap contributors (ODbL)</text>`;
  const frame = `<rect x="${m}" y="${m}" width="${wMap.toFixed(2)}" height="${hMap.toFixed(2)}" fill="none" stroke="#000" stroke-width="0.35"/>`;
  return `<g id="SHEET" inkscape:groupmode="layer" inkscape:label="SHEET">${frame}${bar}${labels}${north}${title}</g>`;
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Rasterise an SVG string (in mm) to a canvas, either at a DPI or a fixed pixel width. */
export async function svgToCanvas(svg: string, size: { dpi: number } | { width: number }): Promise<HTMLCanvasElement> {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
  const mmW = parseFloat(vb[1]), mmH = parseFloat(vb[2]);
  let w = 'dpi' in size ? (mmW / 25.4) * size.dpi : size.width;
  let h = (w * mmH) / mmW;
  const maxSide = 16000, maxArea = 200e6;
  const f = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
  w = Math.round(w * f); h = Math.round(h * f);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
}

/** Ground texture for the 3D model: same layers, styled with real-world widths. */
const TEXTURE_STYLE: Record<string, { stroke: string; weight: number; fill?: string }> = {
  GREEN: { stroke: '#c3d9a8', weight: 0, fill: '#c3d9a8' },
  WOOD: { stroke: '#93b67b', weight: 0, fill: '#93b67b' },
  PAVED: { stroke: '#d8d2c6', weight: 0, fill: '#d8d2c6' },
  WATER: { stroke: '#86b2dc', weight: 0, fill: '#86b2dc' },
  PATH: { stroke: '#c9b48e', weight: 0, fill: '#c9b48e' },
  'ROAD-SURFACE': { stroke: '#a7a399', weight: 0, fill: '#a7a399' },
  RAIL: { stroke: '#6b625a', weight: 0, fill: '#6b625a' },
  BRIDGE: { stroke: '#8f8b82', weight: 0, fill: '#8f8b82' },
  BUILDINGS: { stroke: '#b9b3a8', weight: 0, fill: '#b9b3a8' },
};

export async function textureCanvas(layers: Layer[], bbox: BBox, width: number): Promise<HTMLCanvasElement> {
  const styled = layers
    .filter((l) => TEXTURE_STYLE[l.name])
    .map((l) => ({ ...l, ...TEXTURE_STYLE[l.name], dash: undefined, fill: TEXTURE_STYLE[l.name].fill }));
  // At 1:1000, 1 mm of SVG = 1 m on the ground, so weights above are metres.
  const svg = writeSvg(styled, bbox, { scale: 1000, title: '', furniture: false })
    .replace('fill="#ffffff"', 'fill="#e6e2d6"');
  return svgToCanvas(svg, { width });
}
