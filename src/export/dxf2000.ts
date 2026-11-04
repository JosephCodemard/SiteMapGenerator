import type { Layer } from './drawing';
import { dxfLineweight, trueColour } from './layers';
import type { BBox, Ring, XY } from '../types';

/**
 * AutoCAD R2000 (AC1015) ASCII DXF writer for drawings.
 *
 * Compared with the R12 writer it adds entity handles, LWPOLYLINE, solid HATCH fills, line weights and true
 * colour per layer, a TREE block with INSERTs, and XDATA (application `UKDTM`) carrying building attributes.
 * Output follows the structure AutoCAD and ezdxf expect: BLOCK_RECORD table, *Model_Space/*Paper_Space blocks,
 * and a minimal OBJECTS section with the root dictionary.
 */
export interface Dxf2000Options {
  /** Subtract this from coordinates (use [0, 0] for true BNG). */
  origin: XY;
  /** Drawing scale denominator: text sizes on paper (mm) become model metres. */
  scale: number;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

export function writeDxf2000(layers: Layer[], bbox: BBox, opts: Dxf2000Options): string {
  const o: string[] = [];
  const g = (code: number, v: string | number) => o.push(String(code), typeof v === 'number' ? fmt(v) : v);
  const [ox, oy] = opts.origin;
  const X = (e: number) => e - ox, Y = (n: number) => n - oy;
  let handle = 0x20;
  const h = () => (handle++).toString(16).toUpperCase();

  // Fixed handles for the structures other records point at.
  const H = { modelRec: '1F', paperRec: '1E', treeRec: '1D', modelBlk: '20F', root: 'C', groupDict: 'D' };
  const hasTrees = layers.some((l) => l.items.some((i) => i.t === 'tree'));

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1015');
  g(9, '$HANDSEED'); g(5, 'FFFFF');
  g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMIN'); g(10, X(bbox.minE)); g(20, Y(bbox.minN)); g(30, 0);
  g(9, '$EXTMAX'); g(10, X(bbox.maxE)); g(20, Y(bbox.maxN)); g(30, 0);
  g(9, '$LUNITS'); g(70, 2);
  g(9, '$INSUNITS'); g(70, 6);
  g(9, '$LWDISPLAY'); g(290, 1);
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  // LTYPE
  g(0, 'TABLE'); g(2, 'LTYPE'); g(5, '5'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, 3);
  const ltype = (name: string, desc: string, pat: number[], handleId: string) => {
    g(0, 'LTYPE'); g(5, handleId); g(330, '5'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLinetypeTableRecord');
    g(2, name); g(70, 0); g(3, desc); g(72, 65); g(73, pat.length); g(40, pat.reduce((s, x) => s + Math.abs(x), 0));
    for (const p of pat) { g(49, p); g(74, 0); }
  };
  ltype('BYBLOCK', '', [], '14'); ltype('BYLAYER', '', [], '15'); ltype('CONTINUOUS', 'Solid line', [], '16');
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(5, '6'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, 1);
  ltype('DASHED', 'Dashed __ __ __', [2, -1], '17');
  g(0, 'ENDTAB');
  // LAYER
  g(0, 'TABLE'); g(2, 'LAYER'); g(5, '2'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, layers.length + 1);
  const layer = (name: string, aci: number, hex: string | null, lt: string, lw: number) => {
    g(0, 'LAYER'); g(5, h()); g(330, '2'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLayerTableRecord');
    g(2, name); g(70, 0); g(62, aci); if (hex) g(420, trueColour(hex)); g(6, lt); g(370, lw);
  };
  layer('0', 7, null, 'CONTINUOUS', 25);
  for (const l of layers) layer(l.name, l.aci, l.stroke, l.dash ? 'DASHED' : 'CONTINUOUS', dxfLineweight(l.weight));
  g(0, 'ENDTAB');
  // STYLE
  g(0, 'TABLE'); g(2, 'STYLE'); g(5, '3'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, 1);
  g(0, 'STYLE'); g(5, h()); g(330, '3'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbTextStyleTableRecord');
  g(2, 'STANDARD'); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  // APPID
  g(0, 'TABLE'); g(2, 'APPID'); g(5, '9'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, 2);
  for (const name of ['ACAD', 'UKDTM']) { g(0, 'APPID'); g(5, h()); g(330, '9'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbRegAppTableRecord'); g(2, name); g(70, 0); }
  g(0, 'ENDTAB');
  // BLOCK_RECORD
  g(0, 'TABLE'); g(2, 'BLOCK_RECORD'); g(5, '1'); g(330, 0); g(100, 'AcDbSymbolTable'); g(70, hasTrees ? 3 : 2);
  const rec = (name: string, id: string) => { g(0, 'BLOCK_RECORD'); g(5, id); g(330, '1'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbBlockTableRecord'); g(2, name); g(70, 0); g(280, 1); g(281, 0); };
  rec('*Model_Space', H.modelRec); rec('*Paper_Space', H.paperRec);
  if (hasTrees) rec('TREE', H.treeRec);
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'BLOCKS');
  const block = (name: string, rid: string, body: () => void) => {
    g(0, 'BLOCK'); g(5, h()); g(330, rid); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin'); g(2, name); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, name); g(1, '');
    body();
    g(0, 'ENDBLK'); g(5, h()); g(330, rid); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  };
  block('*Model_Space', H.modelRec, () => {});
  block('*Paper_Space', H.paperRec, () => {});
  if (hasTrees) {
    block('TREE', H.treeRec, () => {
      g(0, 'CIRCLE'); g(5, h()); g(330, H.treeRec); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbCircle'); g(10, 0); g(20, 0); g(30, 0); g(40, 1);
      for (const [a, b, c, d] of [[-0.1, 0, 0.1, 0], [0, -0.1, 0, 0.1]]) {
        g(0, 'LINE'); g(5, h()); g(330, H.treeRec); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbLine'); g(10, a); g(20, b); g(30, 0); g(11, c); g(21, d); g(31, 0);
      }
    });
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const head = (type: string, sub: string, layerName: string, extra?: { lw?: number; lt?: string; hex?: string }) => {
    g(0, type); g(5, h()); g(330, H.modelRec); g(100, 'AcDbEntity'); g(8, layerName);
    if (extra?.lt) g(6, extra.lt);
    if (extra?.hex) g(420, trueColour(extra.hex));
    g(100, sub);
  };
  const openRing = (r: Ring): Ring => {
    const a = r[0], z = r[r.length - 1];
    return r.length > 1 && a[0] === z[0] && a[1] === z[1] ? r.slice(0, -1) : r;
  };
  const lwpoly = (name: string, pts: Ring, closed: boolean, z = 0, thickness = 0, lt?: string, attrs?: Record<string, string | number>) => {
    head('LWPOLYLINE', 'AcDbPolyline', name, { lt });
    g(90, pts.length); g(70, closed ? 1 : 0); if (z) g(38, z); if (thickness) g(39, thickness);
    for (const p of pts) { g(10, X(p[0])); g(20, Y(p[1])); }
    if (attrs) {
      g(1001, 'UKDTM');
      for (const [k, v] of Object.entries(attrs)) { g(1000, `${k}=${v}`); }
    }
  };
  const hatch = (name: string, rings: Ring[], fill: string, z = 0) => {
    head('HATCH', 'AcDbHatch', name, { hex: fill });
    g(10, 0); g(20, 0); g(30, z); g(210, 0); g(220, 0); g(230, 1);
    g(2, 'SOLID'); g(70, 1); g(71, 0); g(91, rings.length);
    rings.forEach((r, k) => {
      const pts = openRing(r);
      g(92, k === 0 ? 3 : 2); g(72, 0); g(73, 1); g(93, pts.length);
      for (const p of pts) { g(10, X(p[0])); g(20, Y(p[1])); }
      g(97, 0);
    });
    g(75, 0); g(76, 1); g(98, 0);
  };
  for (const l of layers) {
    for (const it of l.items) {
      if (it.t === 'line') lwpoly(l.name, it.pts, false, it.z ?? 0, 0, it.dashed ? 'DASHED' : undefined);
      else if (it.t === 'poly') {
        const rings = it.rings.map(openRing).filter((r) => r.length >= 3);
        if (!rings.length) continue;
        if (l.fill && !it.thickness) hatch(l.name, rings, l.fill, it.z ?? 0);
        rings.forEach((r, k) => lwpoly(l.name, r, true, it.z ?? 0, k === 0 ? (it.thickness ?? 0) : 0, undefined, k === 0 ? it.attrs : undefined));
      } else if (it.t === 'circle') { head('CIRCLE', 'AcDbCircle', l.name); g(10, X(it.c[0])); g(20, Y(it.c[1])); g(30, 0); g(40, it.r); }
      else if (it.t === 'tree') {
        head('INSERT', 'AcDbBlockReference', l.name);
        g(2, 'TREE'); g(10, X(it.c[0])); g(20, Y(it.c[1])); g(30, 0); g(41, it.r); g(42, it.r); g(43, it.r);
      } else {
        const hgt = (it.size * opts.scale) / 1000;
        head('TEXT', 'AcDbText', l.name);
        g(10, X(it.p[0])); g(20, Y(it.p[1])); g(30, 0); g(40, hgt); g(1, it.text);
        if (it.angle) g(50, it.angle);
        g(72, 1); g(11, X(it.p[0])); g(21, Y(it.p[1])); g(31, 0); g(100, 'AcDbText'); g(73, 2);
      }
    }
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'OBJECTS');
  g(0, 'DICTIONARY'); g(5, H.root); g(330, 0); g(100, 'AcDbDictionary'); g(281, 1); g(3, 'ACAD_GROUP'); g(350, H.groupDict);
  g(0, 'DICTIONARY'); g(5, H.groupDict); g(330, H.root); g(100, 'AcDbDictionary'); g(281, 1);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return o.join('\r\n') + '\r\n';
}
