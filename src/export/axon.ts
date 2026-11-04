import { MODEL_LAYERS, type LayerId, type Scene } from '../process/scene';
import { STYLES, type DrawingStyle } from './styles';
import type { TitleBlock } from './sheet';
import type { XY } from '../types';

/**
 * Axonometric / isometric line-and-tone drawing of the 3D model as vector SVG.
 * Faces are back-face culled, shaded by a fixed light and painted far to near (painter's algorithm); crease and
 * boundary edges of the massing layers become pen lines, drawn with the faces they belong to so hidden lines stay
 * hidden. Ground layers (terrain, roads, water ...) are drawn first as flat tones, then the volumes on top, so a
 * building is never hidden by terrain behind it: this is a presentation drawing, not a hidden-line section.
 */
export interface AxonOptions {
  /** Direction the viewer stands in, degrees clockwise from north (225 = from the south-west). */
  azimuth: number;
  /** Elevation of the view above the horizon (35.264 = true isometric, 30 = classic axonometric). */
  elevation: number;
  style: DrawingStyle;
  block: TitleBlock;
  /** Largest number of polygons written (the rest of the ground layers are skipped). */
  budget: number;
  /** Edge lines on the massing layers. */
  edges: boolean;
}

export const DEFAULT_AXON: Omit<AxonOptions, 'block'> = { azimuth: 225, elevation: 35.264, style: STYLES.standard, budget: 90_000, edges: true };

const GROUND: LayerId[] = ['earthworks', 'green', 'wood', 'paved', 'water', 'paths', 'pavements', 'rail', 'roads', 'markings'];
const VOLUME: LayerId[] = ['buildings', 'details', 'dormers', 'windows', 'doors', 'facade', 'walls', 'bridges', 'trees'];
const EDGE_LAYERS = new Set<LayerId>(['buildings', 'details', 'dormers', 'bridges', 'walls']);

interface Item { depth: number; svg: string }

const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c: number[]) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** Layer colours per style (so a "planning" axon is grey, a "sketch" one warm). */
function layerColour(id: LayerId, style: DrawingStyle): string {
  const base = MODEL_LAYERS.find((l) => l.id === id)!.color;
  if (style.id === 'figure-ground') return id === 'buildings' ? '#2a2a2a' : id === 'water' ? '#d4d4d4' : '#f2f2f2';
  if (style.id === 'planning') return ['buildings', 'details', 'dormers'].includes(id) ? '#d9d9d9' : id === 'water' ? '#dfe9f2' : '#f5f5f5';
  if (style.id === 'blueprint') return id === 'buildings' ? '#3f72cc' : '#1a4aa5';
  if (style.id === 'sketch') return ({ buildings: '#fbf4e2', details: '#e6d9bc', dormers: '#e6d9bc', roads: '#c9bda0', pavements: '#d8cdb2', water: '#a9cccf', green: '#cfdab0', wood: '#b6c898', terrain: '#d8cdb0' } as Record<string, string>)[id] ?? base;
  // Keep the terrain a little darker than the buildings so massing reads against it.
  if (id === 'terrain') return toHex(hexToRgb(base).map((v) => v * 0.9));
  return base;
}

export function axonSvg(scene: Scene, origin: XY, opt: AxonOptions): { svg: string; w: number; h: number; polygons: number; skipped: string[] } {
  const az = (opt.azimuth * Math.PI) / 180, el = (opt.elevation * Math.PI) / 180;
  const f: XY = [-Math.sin(az), -Math.cos(az)];
  const r: XY = [f[1], -f[0]];
  const ce = Math.cos(el), se = Math.sin(el);
  const toCam: [number, number, number] = [-f[0] * ce, -f[1] * ce, se];
  const la = az - Math.PI / 3, lel = (50 * Math.PI) / 180;
  const light: [number, number, number] = [Math.sin(la) * Math.cos(lel), Math.cos(la) * Math.cos(lel), Math.sin(lel)];
  const proj = (x: number, y: number, z: number): XY => [x * r[0] + y * r[1], z * ce + (x * f[0] + y * f[1]) * se];
  const depthOf = (x: number, y: number, z: number) => (x * f[0] + y * f[1]) * ce - z * se;

  const style = opt.style;
  const ground: Item[] = [], volume: Item[] = [], lines: Item[] = [];
  const skipped: string[] = [];
  let polygons = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: XY) => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); };
  const strokeCol = style.id === 'figure-ground' ? 'none' : style.ink;

  const emit = (into: Item[], id: LayerId, m: { positions: Float32Array; indices: Uint32Array }, topOnly: boolean, rank: number) => {
    const p = m.positions;
    const base = hexToRgb(layerColour(id, style));
    const tris: { depth: number; pts: XY[]; shade: number; n: [number, number, number]; a: number[] }[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const ia = m.indices[t] * 3, ib = m.indices[t + 1] * 3, ic = m.indices[t + 2] * 3;
      const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
      const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      if (topOnly && nz < 0.6) continue;
      if (nx * toCam[0] + ny * toCam[1] + nz * toCam[2] <= 0) continue;
      const shade = 0.5 + 0.5 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
      const pts = [proj(p[ia], p[ia + 1], p[ia + 2]), proj(p[ib], p[ib + 1], p[ib + 2]), proj(p[ic], p[ic + 1], p[ic + 2])];
      tris.push({ depth: (depthOf(p[ia], p[ia + 1], p[ia + 2]) + depthOf(p[ib], p[ib + 1], p[ib + 2]) + depthOf(p[ic], p[ic + 1], p[ic + 2])) / 3 + rank, pts, shade, n: [nx, ny, nz], a: [ia, ib, ic] });
    }
    if (polygons + tris.length > opt.budget) { skipped.push(id); return; }
    polygons += tris.length;
    const sw = style.id === 'figure-ground' ? 0 : 0.06;
    for (const t of tris) {
      t.pts.forEach(grow);
      const c = toHex(base.map((v) => v * (0.62 + 0.5 * t.shade * (style.id === 'blueprint' ? 0.8 : 1))));
      into.push({ depth: t.depth, svg: `<path d="M${t.pts.map((q) => `${q[0].toFixed(2)} ${(-q[1]).toFixed(2)}`).join('L')}Z" fill="${c}" stroke="${c}" stroke-width="${sw}"/>` });
    }
    if (!opt.edges || !EDGE_LAYERS.has(id)) return;
    // Crease and boundary edges, keyed by welded endpoints (1 mm).
    const key = (i: number) => `${Math.round(p[i] * 1000)},${Math.round(p[i + 1] * 1000)},${Math.round(p[i + 2] * 1000)}`;
    const edges = new Map<string, { a: number; b: number; ns: [number, number, number][]; depth: number }>();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const ia = t.a[k], ib = t.a[(k + 1) % 3];
        const ka = key(ia), kb = key(ib), ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const e = edges.get(ek);
        if (e) { e.ns.push(t.n); e.depth = Math.min(e.depth, t.depth); } else edges.set(ek, { a: ia, b: ib, ns: [t.n], depth: t.depth });
      }
    }
    // Back-facing neighbours were culled, so an edge with one visible face is either a silhouette or a crease.
    const all = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const ka = key(m.indices[t + k] * 3), kb = key(m.indices[t + ((k + 1) % 3)] * 3), ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      all.set(ek, (all.get(ek) ?? 0) + 1);
    }
    for (const [ek, e] of edges) {
      const crease = e.ns.length === 1 ? true : e.ns[0][0] * e.ns[1][0] + e.ns[0][1] * e.ns[1][1] + e.ns[0][2] * e.ns[1][2] < Math.cos((28 * Math.PI) / 180);
      if (!crease || (e.ns.length === 2 && (all.get(ek) ?? 0) > 2)) continue;
      const pa = proj(p[e.a], p[e.a + 1], p[e.a + 2]), pb = proj(p[e.b], p[e.b + 1], p[e.b + 2]);
      lines.push({ depth: e.depth - 0.002, svg: `<path d="M${pa[0].toFixed(2)} ${(-pa[1]).toFixed(2)}L${pb[0].toFixed(2)} ${(-pb[1]).toFixed(2)}" fill="none" stroke="${strokeCol}" stroke-width="0.12"/>` });
    }
  };

  // Terrain: the DTM on a coarse grid (the exported mesh can be hundreds of thousands of triangles).
  const tr = scene.terrainRaster;
  const stride = Math.max(1, Math.ceil(Math.sqrt((tr.width * tr.height) / 16000)));
  const gw = Math.floor((tr.width - 1) / stride), gh = Math.floor((tr.height - 1) / stride);
  const tpos: number[] = [], tidx: number[] = [];
  for (let j = 0; j <= gh; j++) for (let i = 0; i <= gw; i++) {
    const ci = Math.min(tr.width - 1, i * stride), cj = Math.min(tr.height - 1, j * stride);
    tpos.push(tr.minE + (ci + 0.5) * tr.res - origin[0], tr.maxN - (cj + 0.5) * tr.res - origin[1], tr.data[cj * tr.width + ci]);
  }
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * (gw + 1) + i;
    tidx.push(k, k + gw + 1, k + 1, k + 1, k + gw + 1, k + gw + 2);
  }
  emit(ground, 'terrain', { positions: Float32Array.from(tpos), indices: Uint32Array.from(tidx) }, false, 1e6);
  GROUND.forEach((id, rank) => {
    for (const o of scene.objects) if (o.layer === id) emit(ground, id, o.mesh, true, 1e5 - rank * 10);
  });
  for (const id of VOLUME) for (const o of scene.objects) if (o.layer === id) {
    emit(volume, id, o.mesh, false, 0);
  }
  const order = (a: Item, b: Item) => b.depth - a.depth;
  ground.sort(order); volume.sort(order);
  const all = [...volume, ...lines].sort(order);

  // Fit to an A3 landscape sheet.
  const pw = 420, ph = 297, M = 10, panel = 70;
  const aw = pw - 2 * M - panel, ah = ph - 2 * M;
  const ew = Math.max(1e-6, x1 - x0), eh = Math.max(1e-6, y1 - y0);
  const k = Math.min(aw / ew, ah / eh) * 0.96;
  const tx = M + (aw - ew * k) / 2 - x0 * k, ty = M + (ah - eh * k) / 2 + y1 * k;
  const ink = style.ink;
  const present = [...new Set(scene.objects.map((o) => o.layer))].filter((l) => l !== 'terrain');
  const legend = present.map((id, i) => `<rect x="${pw - M - panel + 4}" y="${M + 60 + i * 5}" width="6" height="3" fill="${layerColour(id, style)}" stroke="${ink}" stroke-width="0.2"/><text x="${pw - M - panel + 13}" y="${M + 62.5 + i * 5}" font-size="2.4" fill="${ink}">${MODEL_LAYERS.find((l) => l.id === id)!.label}</text>`).join('');
  const north = proj(0, 1, 0); // where north points on screen
  const na = (Math.atan2(north[0], north[1]) * 180) / Math.PI;
  const b = opt.block;
  const rows: [string, string][] = [['Project', b.project], ['Drawing', b.title], ['Drawing no.', b.number], ['Scale', 'NTS (axonometric)'], ['Date', b.date], ['Status', b.status]];
  const tbY = ph - M - rows.length * 6.4;
  const tb = rows.map(([l, v], i) => `<rect x="${pw - M - panel}" y="${tbY + i * 6.4}" width="${panel}" height="6.4" fill="none" stroke="${ink}" stroke-width="0.25"/><text x="${pw - M - panel + 2}" y="${tbY + i * 6.4 + 2.5}" font-size="1.8" fill="${style.ink2}">${l}</text><text x="${pw - M - panel + 2}" y="${tbY + i * 6.4 + 5.6}" font-size="3" font-weight="bold" fill="${ink}">${esc(v)}</text>`).join('');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}mm" height="${ph}mm" viewBox="0 0 ${pw} ${ph}" font-family='${style.font.replace(/'/g, '')}'>`,
    `<defs>${style.defs}<clipPath id="axon-clip"><rect x="${M}" y="${M}" width="${aw}" height="${ah}"/></clipPath></defs>`,
    `<rect width="100%" height="100%" fill="${style.paper}"/>`,
    ...(style.grain ? [`<rect width="100%" height="100%" filter="url(#grain)" opacity="0.5"/>`] : []),
    `<g clip-path="url(#axon-clip)"><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})" stroke-linejoin="round"${style.filter ? ` filter="${style.filter}"` : ''}>`,
    ...ground.map((i) => i.svg), ...all.map((i) => i.svg),
    `</g></g>`,
    `<rect x="${M}" y="${M}" width="${pw - 2 * M}" height="${ph - 2 * M}" fill="none" stroke="${ink}" stroke-width="0.7"/>`,
    `<line x1="${pw - M - panel}" y1="${M}" x2="${pw - M - panel}" y2="${ph - M}" stroke="${ink}" stroke-width="0.5"/>`,
    `<g transform="translate(${pw - M - panel / 2} ${M + 24}) rotate(${na.toFixed(1)})"><path d="M0 -10 L4 6 L0 3 L-4 6 Z" fill="${ink}"/><text x="0" y="-12" font-size="4" text-anchor="middle" font-weight="bold" fill="${ink}">N</text></g>`,
    `<text x="${pw - M - panel + 4}" y="${M + 55}" font-size="2.8" font-weight="bold" fill="${ink}">Key</text>`, legend, tb,
    `<text x="${pw - M - panel + 2}" y="${tbY - 2}" font-size="1.7" fill="${style.ink2}">Axonometric from ${Math.round(opt.azimuth)}°, elevation ${opt.elevation.toFixed(0)}°. Contains EA LIDAR (OGL v3), © OpenStreetMap contributors (ODbL).</text>`,
    '</svg>',
  ].join('\n');
  return { svg, w: pw, h: ph, polygons, skipped };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
