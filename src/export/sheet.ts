import { layerSvg, type Layer } from './drawing';
import type { BBox, Ring } from '../types';

/**
 * Sheet engine: A-series paper chosen to fit the drawing at its scale, a map frame with BNG grid ticks and a
 * right-hand panel holding north arrow, scale bar, legend (generated from the layers present), notes, a
 * revision table and the title block.
 */
export type Paper = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
/** Portrait width x height in mm. */
export const PAPER: Record<Paper, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
const ORDER: Paper[] = ['A4', 'A3', 'A2', 'A1', 'A0'];

export interface TitleBlock {
  project: string;
  title: string;
  number: string;
  drawnBy: string;
  date: string;
  revision: string;
  status: string;
}

export const DEFAULT_BLOCK: TitleBlock = {
  project: 'Site model', title: 'Site plan', number: 'SP-001', drawnBy: '', date: new Date().toISOString().slice(0, 10), revision: 'P01', status: 'For information',
};

export interface SheetSpec {
  /** 'auto' picks the smallest A-size that fits. */
  paper: Paper | 'auto';
  /** Scale denominator (500 = 1:500). */
  scale: number;
  block: TitleBlock;
  legend: boolean;
  grid: boolean;
  notes?: string[];
}

export interface SheetLayout {
  paper: Paper;
  /** Paper size after orientation (mm). */
  w: number;
  h: number;
  landscape: boolean;
  map: { x: number; y: number; w: number; h: number };
  panel: { x: number; y: number; w: number; h: number };
  /** Whether the drawing fits the paper at this scale (A0 may not hold a large site at a large scale). */
  fits: boolean;
}

const MARGIN = 10;

/** Choose paper and place the map for an extent of `w` x `h` metres. */
export function layoutSheet(extentW: number, extentH: number, spec: Pick<SheetSpec, 'paper' | 'scale'>): SheetLayout {
  const k = 1000 / spec.scale;
  const mw = extentW * k, mh = extentH * k;
  const candidates: Paper[] = spec.paper === 'auto' ? ORDER : [spec.paper];
  const make = (p: Paper, landscape: boolean): SheetLayout => {
    const [pw, ph] = PAPER[p];
    const w = landscape ? ph : pw, h = landscape ? pw : ph;
    const panelW = p === 'A4' ? 62 : p === 'A3' ? 72 : 85;
    const area = { x: MARGIN, y: MARGIN, w: w - 2 * MARGIN - panelW, h: h - 2 * MARGIN };
    return {
      paper: p, w, h, landscape, panel: { x: w - MARGIN - panelW, y: MARGIN, w: panelW, h: h - 2 * MARGIN },
      map: { x: area.x + (area.w - Math.min(mw, area.w)) / 2, y: area.y + (area.h - Math.min(mh, area.h)) / 2, w: mw, h: mh }, fits: mw <= area.w + 1e-6 && mh <= area.h + 1e-6,
    };
  };
  let fallback: SheetLayout | null = null;
  for (const p of candidates) {
    for (const landscape of [mw >= mh, mw < mh]) {
      const l = make(p, landscape);
      fallback = l;
      if (l.fits) return l;
    }
  }
  return fallback!;
}

/** Smallest "nice" drawing scale at which the extent fits on `paper`. */
export function fitScale(extentW: number, extentH: number, paper: Paper | 'auto' = 'A1'): number {
  for (const s of [100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000]) {
    if (layoutSheet(extentW, extentH, { paper: paper === 'auto' ? 'A0' : paper, scale: s }).fits) return s;
  }
  return 10000;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export interface SheetOptions {
  /** Raster underlay (data URL) covering the bbox. */
  underlay?: string;
  /** Custom site outline: the drawing is clipped to it. */
  shape?: Ring;
  /** Extra images (e.g. analysis results) drawn over the map extent, below the layers. */
  images?: { href: string; opacity: number }[];
}

const nice = (target: number) => [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].reduce((a, c) => (c <= target ? c : a), 1);

/** Complete sheet as an SVG string in paper millimetres, plus its layout. */
export function writeSheet(layers: Layer[], bbox: BBox, spec: SheetSpec, opt: SheetOptions = {}): { svg: string; layout: SheetLayout } {
  const ew = bbox.maxE - bbox.minE, eh = bbox.maxN - bbox.minN;
  const lay = layoutSheet(ew, eh, spec);
  const k = 1000 / spec.scale;
  const { map: m, panel: p } = lay;
  const X = (e: number) => (m.x + (e - bbox.minE) * k).toFixed(2);
  const Y = (n: number) => (m.y + (bbox.maxN - n) * k).toFixed(2);
  const path = (pts: Ring, close: boolean) => pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0])} ${Y(q[1])}`).join('') + (close ? 'Z' : '');
  // Cap the clip box to the paper so an oversize drawing is cropped rather than spilling.
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${lay.w}mm" height="${lay.h}mm" viewBox="0 0 ${lay.w} ${lay.h}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<clipPath id="site">${opt.shape ? `<path d="${path(opt.shape, true)}"/>` : `<rect x="${m.x}" y="${m.y}" width="${m.w.toFixed(2)}" height="${m.h.toFixed(2)}"/>`}</clipPath>`,
  ];
  if (opt.underlay) out.push(`<g inkscape:groupmode="layer" inkscape:label="HILLSHADE" opacity="0.45"><image href="${opt.underlay}" x="${m.x}" y="${m.y}" width="${m.w.toFixed(2)}" height="${m.h.toFixed(2)}" preserveAspectRatio="none"/></g>`);
  for (const im of opt.images ?? []) out.push(`<image href="${im.href}" x="${m.x}" y="${m.y}" width="${m.w.toFixed(2)}" height="${m.h.toFixed(2)}" opacity="${im.opacity}" preserveAspectRatio="none"/>`);
  out.push(...layerSvg(layers, X, Y, k, path));

  // Frames.
  const rect = (x: number, y: number, w: number, h: number, sw = 0.35, fill = 'none') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#000" stroke-width="${sw}"/>`;
  const text = (x: number, y: number, size: number, t: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${esc(t)}</text>`;
  const f: string[] = [];
  f.push(rect(MARGIN, MARGIN, lay.w - 2 * MARGIN, lay.h - 2 * MARGIN, 0.7), rect(m.x, m.y, Math.min(m.w, lay.map.w), m.h, 0.35));
  f.push(`<line x1="${p.x}" y1="${p.y}" x2="${p.x}" y2="${p.y + p.h}" stroke="#000" stroke-width="0.5"/>`);

  // BNG grid ticks on the map frame.
  if (spec.grid) {
    const step = nice((ew / 6));
    const fe = Math.ceil(bbox.minE / step) * step, fn = Math.ceil(bbox.minN / step) * step;
    for (let e = fe; e <= bbox.maxE; e += step) {
      f.push(`<line x1="${X(e)}" y1="${m.y}" x2="${X(e)}" y2="${m.y + 2.5}" stroke="#000" stroke-width="0.25"/><line x1="${X(e)}" y1="${m.y + m.h - 2.5}" x2="${X(e)}" y2="${m.y + m.h}" stroke="#000" stroke-width="0.25"/>`);
      f.push(text(Number(X(e)), m.y + m.h + 3.6, 2, `${e}`, 'text-anchor="middle"'));
    }
    for (let n = fn; n <= bbox.maxN; n += step) {
      f.push(`<line x1="${m.x}" y1="${Y(n)}" x2="${m.x + 2.5}" y2="${Y(n)}" stroke="#000" stroke-width="0.25"/><line x1="${m.x + m.w - 2.5}" y1="${Y(n)}" x2="${m.x + m.w}" y2="${Y(n)}" stroke="#000" stroke-width="0.25"/>`);
      f.push(`<text x="${m.x - 1.2}" y="${Y(n)}" font-size="2" text-anchor="middle" transform="rotate(-90 ${m.x - 1.2} ${Y(n)})">${n}</text>`);
    }
  }

  // Right-hand panel, top to bottom.
  let y = p.y + 6;
  const cx = p.x + p.w / 2;
  f.push(`<g transform="translate(${cx} ${y + 2})"><path d="M0 -2 L5 12 L0 9 L-5 12 Z" fill="#000"/>${text(0, 18, 4, 'N', 'text-anchor="middle" font-weight="bold"')}</g>`);
  y += 26;
  // Scale bar.
  const bar = nice((p.w - 16) / k * 0.9 / 1), segs = 4;
  const bw = bar * k, x0 = p.x + 6;
  for (let i = 0; i < segs; i++) f.push(`<rect x="${(x0 + (i * bw) / segs).toFixed(2)}" y="${y}" width="${(bw / segs).toFixed(2)}" height="2" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.2"/>`);
  f.push(text(x0, y + 6, 2.2, '0'), text(x0 + bw, y + 6, 2.2, `${bar} m`, 'text-anchor="middle"'));
  y += 12;
  // Legend from the layers actually drawn.
  if (spec.legend) {
    f.push(text(p.x + 4, y, 2.8, 'Key', 'font-weight="bold"'));
    y += 4;
    const maxRows = Math.floor((p.h - 120 - (y - p.y)) / 4.6);
    for (const l of layers.filter((q) => q.items.length && q.name !== 'SECTION-ANNO' && !/^SHEET/.test(q.name)).slice(0, Math.max(4, maxRows))) {
      const dash = l.dash ? ` stroke-dasharray="${l.dash}"` : '';
      f.push(`<rect x="${p.x + 4}" y="${y - 2.6}" width="7" height="3.2" fill="${l.fill ?? 'none'}" stroke="${l.stroke}" stroke-width="${Math.max(0.2, l.weight)}"${dash}/>`);
      f.push(text(p.x + 13, y, 2.2, l.label));
      y += 4.6;
    }
    y += 2;
  }
  for (const line of spec.notes ?? []) { f.push(text(p.x + 4, y, 2, line)); y += 3.2; }

  // Bottom: revision table then title block, anchored to the panel bottom.
  const tbRows: [string, string][] = [
    ['Project', spec.block.project], ['Drawing', spec.block.title], ['Drawing no.', spec.block.number],
    ['Scale', `1:${spec.scale} @ ${lay.paper}`], ['Date', spec.block.date], ['Drawn by', spec.block.drawnBy], ['Status', spec.block.status],
  ];
  const rowH = 7, tbH = tbRows.length * rowH, revH = 4 * 5;
  const tbY = p.y + p.h - tbH, revY = tbY - revH - 4;
  f.push(rect(p.x, revY, p.w, revH), `<line x1="${p.x}" y1="${revY + 5}" x2="${p.x + p.w}" y2="${revY + 5}" stroke="#000" stroke-width="0.25"/>`);
  f.push(text(p.x + 2, revY + 3.6, 2.2, 'Rev', 'font-weight="bold"'), text(p.x + 12, revY + 3.6, 2.2, 'Date', 'font-weight="bold"'), text(p.x + 32, revY + 3.6, 2.2, 'Description', 'font-weight="bold"'));
  f.push(text(p.x + 2, revY + 8.6, 2.2, spec.block.revision), text(p.x + 12, revY + 8.6, 2.2, spec.block.date), text(p.x + 32, revY + 8.6, 2.2, 'First issue'));
  tbRows.forEach(([label, value], i) => {
    const ry = tbY + i * rowH;
    f.push(rect(p.x, ry, p.w, rowH, 0.25), text(p.x + 2, ry + 2.6, 1.8, label, 'fill="#555"'), text(p.x + 2, ry + 6, i === 1 ? 3.6 : 3, value, 'font-weight="bold"'));
  });
  f.push(text(p.x + 2, tbY - revH - 6, 1.7, 'Contains EA LIDAR data (OGL v3) and OpenStreetMap data (ODbL).', 'fill="#555"'));
  out.push(`<g id="SHEET" inkscape:groupmode="layer" inkscape:label="SHEET">${f.join('')}</g>`, '</svg>');
  return { svg: out.join('\n'), layout: lay };
}
