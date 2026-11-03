import type { Layer } from './drawing';
import type { BBox, Ring, XY } from '../types';

/**
 * Minimal AutoCAD R12 (AC1009) ASCII DXF writer. R12 needs no handles and is
 * read by every version of AutoCAD, Rhino, Illustrator, QGIS, etc.
 *
 * - Contours are 2D polylines at their elevation (Z), so they're usable in 3D.
 * - Building footprints are closed polylines at ground level with thickness =
 *   block height, so they show as extruded LOD1 blocks in AutoCAD 3D views.
 */
export interface DxfOptions {
  /** Subtract this from coordinates (use [0, 0] for true BNG). */
  origin: XY;
  /** Text height scale: drawing scale denominator, so labels are sized for paper. */
  scale: number;
}

export function writeDxf(layers: Layer[], bbox: BBox, opts: DxfOptions): string {
  const o: string[] = [];
  const g = (code: number, v: string | number) => o.push(String(code), typeof v === 'number' ? fmt(v) : v);
  const [ox, oy] = opts.origin;
  const X = (e: number) => e - ox, Y = (n: number) => n - oy;

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMIN'); g(10, X(bbox.minE)); g(20, Y(bbox.minN)); g(30, 0);
  g(9, '$EXTMAX'); g(10, X(bbox.maxE)); g(20, Y(bbox.maxN)); g(30, 0);
  g(9, '$LUNITS'); g(70, 2);
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  ltype(g, 'CONTINUOUS', 'Solid line', []);
  ltype(g, 'DASHED', 'Dashed __ __ __', [2, -1]);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length + 1);
  layer(g, '0', 7, 'CONTINUOUS');
  for (const l of layers) layer(g, l.name, l.aci, l.dash ? 'DASHED' : 'CONTINUOUS');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layerName: string, pts: Ring, closed: boolean, z = 0, thickness = 0) => {
    g(0, 'POLYLINE'); g(8, layerName); g(66, 1);
    g(10, 0); g(20, 0); g(30, z);
    if (thickness) g(39, thickness);
    g(70, closed ? 1 : 0);
    for (const p of pts) { g(0, 'VERTEX'); g(8, layerName); g(10, X(p[0])); g(20, Y(p[1])); g(30, z); }
    g(0, 'SEQEND'); g(8, layerName);
  };
  for (const l of layers) {
    for (const it of l.items) {
      if (it.t === 'line') poly(l.name, it.pts, false, it.z ?? 0);
      else if (it.t === 'poly') for (const r of it.rings) poly(l.name, r, true, it.z ?? 0, it.thickness ?? 0);
      else if (it.t === 'circle') { g(0, 'CIRCLE'); g(8, l.name); g(10, X(it.c[0])); g(20, Y(it.c[1])); g(30, 0); g(40, it.r); }
      else {
        // Paper text size (mm) -> model metres at the drawing scale.
        const h = (it.size * opts.scale) / 1000;
        g(0, 'TEXT'); g(8, l.name); g(10, X(it.p[0])); g(20, Y(it.p[1])); g(30, 0); g(40, h); g(1, it.text);
        if (it.angle) g(50, it.angle);
        g(72, 1); g(73, 2); g(11, X(it.p[0])); g(21, Y(it.p[1])); g(31, 0);
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return o.join('\r\n') + '\r\n';
}

type G = (code: number, v: string | number) => void;

function ltype(g: G, name: string, desc: string, pattern: number[]) {
  g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, pattern.length);
  g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
  for (const p of pattern) g(49, p);
}

function layer(g: G, name: string, color: number, lt: string) {
  g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, lt);
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

/** Laser-cut stack: one layer per contour level, filled regions as closed polylines. */
export function writeContourStackDxf(
  bands: { level: number; polygons: Ring[][] }[],
  bbox: BBox,
  opts: { origin: XY; layout: 'stacked' | 'grid'; gap: number },
): string {
  const layers: Layer[] = [];
  const cols = Math.ceil(Math.sqrt(bands.length));
  const w = bbox.maxE - bbox.minE, h = bbox.maxN - bbox.minN;
  bands.forEach((b, i) => {
    const dx = opts.layout === 'grid' ? (i % cols) * (w + opts.gap) : 0;
    const dy = opts.layout === 'grid' ? -Math.floor(i / cols) * (h + opts.gap) : 0;
    const shift = (r: Ring): Ring => r.map(([x, y]) => [x + dx, y + dy]);
    const items: Layer['items'] = b.polygons.map((rings) => ({ t: 'poly' as const, rings: rings.map(shift), z: opts.layout === 'stacked' ? b.level : 0 }));
    if (opts.layout === 'grid') {
      items.push({ t: 'text', p: [bbox.minE + dx + w / 2, bbox.minN + dy - opts.gap / 3], text: `${b.level.toFixed(1)} m`, size: 5 });
    }
    layers.push({ name: `LEVEL_${b.level.toFixed(1).replace('.', '_').replace('-', 'M')}`, label: '', stroke: '#000', aci: (i % 6) + 1, weight: 0.1, items });
  });
  const ext: BBox = opts.layout === 'grid'
    ? { minE: bbox.minE, maxN: bbox.maxN, maxE: bbox.minE + cols * (w + opts.gap), minN: bbox.maxN - Math.ceil(bands.length / cols) * (h + opts.gap) }
    : bbox;
  return writeDxf(layers, ext, { origin: opts.origin, scale: 1000 });
}
