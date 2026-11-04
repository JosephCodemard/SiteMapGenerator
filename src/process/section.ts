import type { Layer } from '../export/drawing';
import { buildContext } from './context';
import { openRing } from './clip';
import { sample } from './raster';
import { roofHeightAt } from './roofparts';
import { clipPolylineToShape } from './shape';
import type { Tree } from './trees';
import type { Building, BBox, Ring, RoofFit, SiteData, XY } from '../types';

/**
 * Side-elevation slice: the user draws a cut line A-B on the plan and gets a height profile looking to the
 * LEFT of the line (direction A -> B). Mode `section` cuts through buildings (solid poche, roof shape from the
 * fitted parts) and shows everything beyond in lighter elevation; mode `elevation` doesn't cut: every building
 * on the viewing side is drawn in elevation.
 */
export interface SectionOptions {
  mode: 'section' | 'elevation';
  /** How far beyond the cut to show (m). */
  depth: number;
  /** Vertical exaggeration (1 = true scale). */
  exaggeration: number;
  /** Sample spacing along the line (m). */
  spacing: number;
  label: string;
}

export const DEFAULT_SECTION: SectionOptions = { mode: 'section', depth: 60, exaggeration: 1, spacing: 0.5, label: 'A' };

export interface Section {
  a: XY;
  b: XY;
  length: number;
  /** Ground (DTM) profile: [chainage, level]. */
  ground: [number, number][];
  cuts: { id: string; t0: number; t1: number; ground: [number, number][]; top: [number, number][] }[];
  beyond: { id: string; dist: number; t0: number; t1: number; z0: number; z1: number }[];
  trees: { t: number; z: number; r: number; h: number }[];
  water: { t0: number; t1: number; z: number }[];
  zmin: number;
  zmax: number;
}

type Interval = [number, number];

/** Parts of the line a->b inside a polygon with holes, as chainage intervals. */
function inside(a: XY, b: XY, rings: Ring[]): Interval[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const toT = (p: XY) => Math.hypot(p[0] - a[0], p[1] - a[1]);
  const spans = (ring: Ring) => clipPolylineToShape([a, b], openRing(ring)).map((p): Interval => [toT(p[0]), toT(p[p.length - 1])]);
  let out = spans(rings[0]).map(([x, y]): Interval => [Math.min(x, y), Math.max(x, y)]);
  for (const hole of rings.slice(1)) {
    for (const [h0, h1] of spans(hole).map(([x, y]): Interval => [Math.min(x, y), Math.max(x, y)])) {
      out = out.flatMap(([s, e]): Interval[] => (h1 <= s || h0 >= e ? [[s, e]] : [[s, Math.max(s, h0)], [Math.min(e, h1), e]].filter(([p, q]) => q - p > 1e-6) as Interval[]));
    }
  }
  return out.filter(([s, e]) => e - s > 0.05 && s >= -1e-6 && e <= L + 1e-6);
}

function roofTop(b: Building, e: number, n: number): number {
  const fits: RoofFit[] = b.roofParts ?? (b.roof ? [b.roof] : []);
  for (const f of fits) {
    const dx = e - f.centre[0], dy = n - f.centre[1];
    const u = dx * f.axis[0] + dy * f.axis[1], v = -dx * f.axis[1] + dy * f.axis[0];
    if (Math.abs(u) <= f.a + 0.5 && Math.abs(v) <= f.b + 0.5) return f.type === 'flat' ? Math.max(f.eaves, b.ground + 2) : roofHeightAt(f, e, n);
  }
  return b.top;
}

export function buildSection(site: SiteData, trees: Tree[], a: XY, b: XY, opt: SectionOptions = DEFAULT_SECTION): Section {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1) throw new Error('The cut line is too short.');
  const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
  const nx = -dy, ny = dx; // viewing side: left of travel
  const at = (t: number): XY => [a[0] + dx * t, a[1] + dy * t];
  const gz = (t: number) => { const [e, n] = at(t); return sample(site.dtm, e, n); };
  const steps = Math.max(2, Math.ceil(L / opt.spacing));
  const ground: [number, number][] = [];
  for (let i = 0; i <= steps; i++) { const t = (L * i) / steps; ground.push([t, gz(t)]); }

  const sec: Section = { a, b, length: L, ground, cuts: [], beyond: [], trees: [], water: [], zmin: Math.min(...ground.map((g) => g[1])), zmax: Math.max(...ground.map((g) => g[1])) };
  const signed = (p: XY) => (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
  const along = (p: XY) => (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;

  for (const bd of site.buildings) {
    const cut = opt.mode === 'section' ? inside(a, b, bd.rings) : [];
    if (cut.length) {
      cut.forEach(([t0, t1], k) => {
        const n = Math.max(2, Math.ceil((t1 - t0) / opt.spacing));
        const top: [number, number][] = [], gr: [number, number][] = [];
        for (let i = 0; i <= n; i++) {
          const t = t0 + ((t1 - t0) * i) / n, [e, nn] = at(t);
          top.push([t, roofTop(bd, e, nn)]); gr.push([t, gz(t)]);
        }
        sec.cuts.push({ id: cut.length > 1 ? `${bd.id}_${k + 1}` : bd.id, t0, t1, ground: gr, top });
        sec.zmax = Math.max(sec.zmax, ...top.map((q) => q[1]));
      });
      continue;
    }
    const ring = openRing(bd.rings[0]);
    const ds = ring.map(signed);
    const cd = ds.reduce((s, v) => s + v, 0) / ds.length;
    const nearest = Math.min(...ds);
    // Elevation draws everything on or beyond the line (including buildings the line passes through).
    const onSide = opt.mode === 'elevation' ? Math.max(...ds) > 0.01 : nearest > -0.01 && cd > 0;
    if (!onSide || nearest > opt.depth) continue;
    const ts = ring.map(along);
    const t0 = Math.max(0, Math.min(...ts)), t1 = Math.min(L, Math.max(...ts));
    if (t1 - t0 < 0.5) continue;
    sec.beyond.push({ id: bd.id, dist: Math.max(0, nearest), t0, t1, z0: bd.ground, z1: bd.top });
    sec.zmax = Math.max(sec.zmax, bd.top);
  }
  sec.beyond.sort((p, q) => q.dist - p.dist); // far first, so near buildings overdraw

  for (const t of trees) {
    const d = signed(t.p), s = along(t.p);
    if (s < -t.r || s > L + t.r || d > opt.depth || d < -3) continue;
    sec.trees.push({ t: s, z: sample(site.dtm, t.p[0], t.p[1]), r: t.r, h: t.h });
    sec.zmax = Math.max(sec.zmax, sample(site.dtm, t.p[0], t.p[1]) + t.h);
  }

  for (const poly of buildbase(site)) {
    for (const [t0, t1] of inside(a, b, poly)) {
      const mid = at((t0 + t1) / 2);
      sec.water.push({ t0, t1, z: sample(site.dtm, mid[0], mid[1]) });
    }
  }
  return sec;
}

const buildbase = (site: SiteData): Ring[][] => buildContext(site).water;

const L = (name: string, label: string, stroke: string, weight: number, fill?: string): Layer => ({ name, label, stroke, aci: 7, weight, fill, items: [] });

/** The section as drawing layers in (chainage, level x exaggeration) coordinates, plus the box to draw them in. */
export function sectionLayers(sec: Section, opt: SectionOptions): { layers: Layer[]; bbox: BBox } {
  const e = opt.exaggeration;
  const base = Math.floor(sec.zmin / 5) * 5 - 5, top = Math.ceil((sec.zmax + 3) / 5) * 5;
  const P = (t: number, z: number): XY => [t, z * e];
  const beyond = L('SECTION-BEYOND', 'Beyond (elevation)', '#8a8a8a', 0.18, '#ece9e3');
  const trees = L('SECTION-TREE', 'Trees', '#4f8a3c', 0.18, '#cfe3c3');
  const ground = L('SECTION-GROUND', 'Ground', '#5a3d1e', 0.7, '#d9ccb0');
  const water = L('SECTION-WATER', 'Water', '#3d7fc4', 0.5);
  const cut = L('SECTION-CUT', 'Cut buildings', '#000000', 0.5, '#1d1d1d');
  const anno = L('SECTION-ANNO', 'Levels & notes', '#333333', 0.13);

  for (const bd of sec.beyond) beyond.items.push({ t: 'poly', rings: [[P(bd.t0, bd.z0), P(bd.t1, bd.z0), P(bd.t1, bd.z1), P(bd.t0, bd.z1)]] });
  for (const t of sec.trees) {
    const pts: XY[] = [];
    for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push(P(t.t + Math.cos(a) * t.r, t.z + t.h * 0.65 + Math.sin(a) * t.h * 0.35)); }
    trees.items.push({ t: 'poly', rings: [pts] });
    trees.items.push({ t: 'line', pts: [P(t.t, t.z), P(t.t, t.z + t.h * 0.4)] });
  }
  ground.items.push({ t: 'poly', rings: [[...sec.ground.map(([t, z]) => P(t, z)), P(sec.length, base), P(0, base)]] });
  ground.items.push({ t: 'line', pts: sec.ground.map(([t, z]) => P(t, z)) });
  for (const w of sec.water) water.items.push({ t: 'line', pts: [P(w.t0, w.z), P(w.t1, w.z)] });
  for (const c of sec.cuts) {
    cut.items.push({ t: 'poly', rings: [[...c.top.map(([t, z]) => P(t, z)), ...[...c.ground].reverse().map(([t, z]) => P(t, z))]] });
    const hi = c.top.reduce((m, q) => (q[1] > m[1] ? q : m));
    anno.items.push({ t: 'text', p: P(hi[0], hi[1] + 1.2 / e), text: hi[1].toFixed(2), size: 2 });
  }
  // Level grid every 5 m and the datum.
  for (let z = base; z <= top; z += 5) {
    anno.items.push({ t: 'line', pts: [P(0, z), P(sec.length, z)] });
    anno.items.push({ t: 'text', p: P(2.5, z + 0.9 / e), text: `${z} m`, size: 2 });
  }
  anno.items.push({ t: 'text', p: P(sec.length / 2, top - 1.2 / e), text: `${opt.mode === 'section' ? 'Section' : 'Elevation'} ${opt.label}–${opt.label} · levels m ODN · vertical exaggeration ×${e}`, size: 3 });
  return { layers: [beyond, trees, ground, water, cut, anno].filter((l) => l.items.length), bbox: { minE: 0, maxE: sec.length, minN: base * e, maxN: top * e } };
}
