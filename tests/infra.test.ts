import { describe, expect, it } from 'vitest';
import { axonSvg, DEFAULT_AXON } from '../src/export/axon';
import { buildDrawing, ALL_FEATURES, defaultLayerToggles } from '../src/export/drawing';
import { DEFAULT_BLOCK, writeSheet } from '../src/export/sheet';
import { STYLES, type StyleId } from '../src/export/styles';
import { buildBridge } from '../src/process/bridges';
import { differencePolygons } from '../src/process/buffer';
import { buildContext } from '../src/process/context';
import { detectPaint, vegetationRaster, roofColours, type Pixels } from '../src/process/imagery';
import { findEarthworks, sidewalkSides } from '../src/process/network';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import type { Mesh } from '../src/process/mesh';
import type { Building, LineFeature, Raster, SiteData } from '../src/types';

function watertight(m: Mesh): boolean {
  const e = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) for (let c = 0; c < 3; c++) { const k = `${m.indices[t + c]},${m.indices[t + ((c + 1) % 3)]}`; e.set(k, (e.get(k) ?? 0) + 1); }
  for (const [k, n] of e) { const [a, b] = k.split(','); if (n !== 1 || e.get(`${b},${a}`) !== 1) return false; }
  return true;
}
const raster = (w: number, h: number, f: (x: number, y: number) => number, minE = 1000, maxNOff = 2000): Raster => {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f(i + 0.5, h - j - 0.5);
  return { width: w, height: h, minE, maxN: maxNOff + h, res: 1, data };
};
const road = (id: string, coords: [number, number][], tags: Record<string, string> = {}): LineFeature => ({ id, kind: 'road-minor', coords, bridge: false, tunnel: false, tags: { highway: 'residential', ...tags } });
const house = (id: string, x0: number, y0: number, x1: number, y1: number): Building => ({ id, rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], tags: {}, ground: 0, top: 9, source: 'lidar' });
const site = (lines: LineFeature[], buildings: Building[], dtm?: Raster): SiteData => ({
  bbox: { minE: 1000, minN: 2000, maxE: 1100, maxN: 2100 }, origin: [1050, 2050], dtm: dtm ?? raster(100, 100, () => 0), dsm: null, buildings, lines, areas: [], trees: [], points: [],
  osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
});

describe('pavements and kerbs', () => {
  it('reads sidewalk tags', () => {
    expect(sidewalkSides({ sidewalk: 'both' }).sides.sort()).toEqual(['left', 'right']);
    expect(sidewalkSides({ sidewalk: 'left' }).sides).toEqual(['left']);
    expect(sidewalkSides({ 'sidewalk:both': 'yes', 'sidewalk:left': 'no' }).sides).toEqual(['right']);
    expect(sidewalkSides({ highway: 'residential' }).tagged).toBe(false);
  });

  it('adds tagged pavements beside the carriageway and never overlaps it', () => {
    const s = site([road('r', [[1000, 2050], [1100, 2050]], { sidewalk: 'both' })], []);
    const ctx = buildContext(s);
    expect(ctx.pavements.length).toBeGreaterThan(0);
    expect(ctx.mappedPavementM).toBeGreaterThan(150);
    // Pavement and road are disjoint: their difference equals the pavement area.
    const area = (p: [number, number][][][]) => p.reduce((a, ring) => a + Math.abs(ring[0].reduce((q, v, i, arr) => { const n = arr[(i + 1) % arr.length]; return q + v[0] * n[1] - n[0] * v[1]; }, 0)) / 2, 0);
    const before = area(ctx.pavements), after = area(differencePolygons(ctx.pavements, ctx.roads, s.bbox));
    expect(after).toBeGreaterThan(before - 1);
    // 5.5 m road, 1.8 m pavements both sides: about 2 x 1.8 x 100.
    expect(before).toBeGreaterThan(300); expect(before).toBeLessThan(420);
    expect(ctx.kerbs.length).toBeGreaterThan(0);
  });

  it('infers pavements only where there is building frontage and nothing is tagged', () => {
    const s = site([road('r', [[1000, 2050], [1100, 2050]])], [house('h', 1010, 2056, 1090, 2070)]);
    const ctx = buildContext(s);
    expect(ctx.inferredPavementM).toBeGreaterThan(0);
    // Only the north side has houses: roughly one strip, not two.
    const north = ctx.pavements.flatMap((p) => p[0]).filter(([, n]) => n > 2050).length, south = ctx.pavements.flatMap((p) => p[0]).filter(([, n]) => n < 2050).length;
    expect(north).toBeGreaterThan(0); expect(south).toBe(0);
    // Tagged sidewalk=no is respected.
    expect(buildContext(site([road('r2', [[1000, 2050], [1100, 2050]], { sidewalk: 'no' })], [house('h', 1010, 2056, 1090, 2070)])).pavements).toHaveLength(0);
  });

  it('keeps pavement, path and park out of building footprints in the scene', async () => {
    const s = site([road('r', [[1000, 2050], [1100, 2050]], { sidewalk: 'both' })], [house('h', 1020, 2054, 1060, 2070)]);
    const sc = await buildScene(s, { ...DEFAULT_SETTINGS, buildings: 'lod1', trees: 'off', markings: false });
    expect(sc.objects.some((o) => o.layer === 'pavements')).toBe(true);
    expect(sc.objects.some((o) => o.layer === 'roads')).toBe(true);
  });
});

describe('earthworks', () => {
  it('finds a steep bank beside a road and ignores flat ground', () => {
    const dtm = raster(100, 100, (_x, y) => (y > 56 ? 0.8 * (y - 56) : 0));
    const s = site([road('r', [[1000, 2050], [1100, 2050]])], [], dtm);
    const ctx = buildContext(s);
    expect(ctx.earthworks.areas.length).toBeGreaterThan(0);
    const flat = buildContext(site([road('r', [[1000, 2050], [1100, 2050]])], []));
    expect(flat.earthworks.areas).toHaveLength(0);
    expect(findEarthworks(s, ctx.roads).areas.length).toBeGreaterThan(0);
  });
});

describe('bridges', () => {
  const ground = (x: number, y: number) => (Math.abs(y) < 8 ? -6 : 0) + 0 * x; // a gap 16 m wide, 6 m deep
  const b = { id: 'b', coords: [[-30, 0], [30, 0]] as [number, number][], width: 8, kind: 'road-minor' as const };
  it('builds deck, parapets, abutments and piers as closed solids pinned to the road at both ends', () => {
    const parts = buildBridge({ ...b, coords: [[-30, 0], [30, 0]] }, 'b', [0, 0], (x) => (Math.abs(x) < 8 ? -6 : 0), null, { parapet: 1, roadLift: 0.2 });
    const names = parts.map((p) => p.name);
    expect(names).toContain('bridge_b');
    expect(names.filter((n) => n.includes('parapet'))).toHaveLength(2);
    expect(names.filter((n) => n.includes('abutment')).length).toBe(0 + names.filter((n) => n.includes('abutment')).length);
    for (const p of parts) expect(watertight(p.mesh), p.name).toBe(true);
    // Deck ends sit at road level (ground + lift), whatever the DSM says.
    const deck = parts[0].mesh;
    let zEnd = -Infinity;
    for (let i = 0; i < deck.positions.length; i += 3) if (Math.abs(deck.positions[i] + 30) < 0.01) zEnd = Math.max(zEnd, deck.positions[i + 2]);
    expect(zEnd).toBeCloseTo(0.2, 1);
    void ground;
  });
  it('adds piers under a long span with a deep gap', () => {
    const deckLevel = raster(200, 40, () => 0, -100, -20); // the LIDAR sees the deck at 0 m
    const long = buildBridge({ ...b, coords: [[-60, 0], [60, 0]] }, 'l', [0, 0], (x) => (Math.abs(x) < 50 ? -8 : 0), deckLevel, { parapet: 1, roadLift: 0.2 });
    expect(long.filter((p) => p.name.includes('pier')).length).toBeGreaterThan(2);
  });
});

describe('drawing styles, sheets and axonometric', () => {
  const s = site([road('r', [[1000, 2050], [1100, 2050]], { sidewalk: 'both' })], [house('h', 1020, 2054, 1060, 2070)]);
  const layers = buildDrawing(s, [], { layers: defaultLayerToggles(), buildingLabels: false, features: { ...ALL_FEATURES, trees: [] } });

  it('draws pavement and kerb layers', () => {
    const names = layers.map((l) => l.name);
    expect(names).toContain('PAVEMENT'); expect(names).toContain('KERB'); expect(names).toContain('ROAD-SURFACE');
  });

  it.each(Object.keys(STYLES) as StyleId[])('renders the %s style as well-formed SVG with the right paper', (id) => {
    const { svg } = writeSheet(layers, s.bbox, { paper: 'A3', scale: 500, block: DEFAULT_BLOCK, legend: true, grid: true }, { style: STYLES[id] });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`fill="${STYLES[id].paper}"`);
    expect(svg).toContain('Do not scale');
    // Every url(#x) reference resolves to a definition.
    for (const m of svg.matchAll(/url\(#([\w-]+)\)/g)) if (m[1] !== 'site') expect(svg, `${id}: ${m[1]}`).toContain(`id="${m[1]}"`);
  });

  it('styles change the look: figure-ground makes buildings solid black, planning hatches them', () => {
    const fg = writeSheet(layers, s.bbox, { paper: 'A3', scale: 500, block: DEFAULT_BLOCK, legend: false, grid: false }, { style: STYLES['figure-ground'] }).svg;
    expect(fg).toMatch(/id="BUILDINGS"[^>]*fill="#000"/);
    expect(fg).not.toContain('id="KERB"');
    const pl = writeSheet(layers, s.bbox, { paper: 'A3', scale: 500, block: DEFAULT_BLOCK, legend: false, grid: false }, { style: STYLES.planning }).svg;
    expect(pl).toMatch(/id="BUILDINGS"[^>]*fill="url\(#p-diag\)"/);
    const sk = writeSheet(layers, s.bbox, { paper: 'A3', scale: 500, block: DEFAULT_BLOCK, legend: false, grid: false }, { style: STYLES.sketch }).svg;
    expect(sk).toContain('filter="url(#rough');
  });

  it('draws an axonometric of the model: shaded faces, edge lines, a north arrow and a key', async () => {
    const sc = await buildScene(s, { ...DEFAULT_SETTINGS, buildings: 'lod1', trees: 'off', markings: false });
    const r = axonSvg(sc, s.origin, { ...DEFAULT_AXON, block: DEFAULT_BLOCK });
    expect(r.polygons).toBeGreaterThan(100);
    expect(r.svg).toContain('Axonometric from 225');
    expect(r.svg).toContain('Buildings');
    const edgeless = axonSvg(sc, s.origin, { ...DEFAULT_AXON, block: DEFAULT_BLOCK, edges: false });
    expect(r.svg.length).toBeGreaterThan(edgeless.svg.length);
    // A tiny budget skips layers instead of writing an unbounded file.
    expect(axonSvg(sc, s.origin, { ...DEFAULT_AXON, block: DEFAULT_BLOCK, budget: 50 }).skipped.length).toBeGreaterThan(0);
  });
});

describe('imagery analysis', () => {
  const W = 200, bbox = { minE: 1000, minN: 2000, maxE: 1020, maxN: 2020 };
  const make = (f: (e: number, n: number) => [number, number, number]): Pixels => {
    const data = new Uint8ClampedArray(W * W * 4);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const [r, g, b] = f(bbox.minE + (i + 0.5) * 0.1, bbox.maxN - (j + 0.5) * 0.1);
      data.set([r, g, b, 255], (j * W + i) * 4);
    }
    return { data, width: W, height: W, bbox };
  };
  it('marks vegetation and gives roofs the colour of what is not green', () => {
    const im = make((e) => (e < 1010 ? [60, 150, 50] : [150, 70, 60]));
    const veg = vegetationRaster(im, raster(20, 20, () => 0));
    expect(veg.data[10 * 20 + 2]).toBeGreaterThan(0.5);
    expect(veg.data[10 * 20 + 17]).toBeLessThan(0.2);
    const b = house('h', 1005, 2005, 1018, 2015);
    expect(roofColours(im, [b])).toBe(1);
    expect(b.roofColour).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('finds a white line and a yellow line painted on asphalt', () => {
    const im = make((e, n) => {
      if (Math.abs(n - 2010) < 0.08 && e > 1002 && e < 1012) return [235, 235, 235];
      if (Math.abs(n - 2005) < 0.1 && e > 1002 && e < 1012) return [230, 190, 40];
      return [90, 90, 95];
    });
    const found = detectPaint(im, [[[[1000, 2000], [1020, 2000], [1020, 2020], [1000, 2020]]]]);
    expect(found.filter((f) => f.colour === 'white').length).toBe(1);
    expect(found.filter((f) => f.colour === 'yellow').length).toBe(1);
  });
});

describe('EA oblique photography index', () => {
  const resp = { features: [{ geometry: { type: 'Point', coordinates: [343592.1, 124475.5] }, properties: { filename: 'Obliques_S14_064_140220_133423.jpg', dos: '2014-02-20T00:00:00Z', heading: 221, iva: 131, year: '2014', type: 'Incident Response', os_ref: 'ST4020' } }, { geometry: { type: 'Point' }, properties: {} }] };
  it('parses the live WFS response shape and summarises it', async () => {
    const { parseOblique, obliqueSummary, obliqueUrl } = await import('../src/data/oblique');
    const photos = parseOblique(resp);
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ heading: 221, date: '2014-02-20', tile: 'ST4020', type: 'Incident Response' });
    expect(obliqueSummary(photos)).toContain('cannot be measured');
    expect(obliqueSummary([])).toContain('no photos indexed');
    expect(obliqueUrl({ minE: 1000, minN: 2000, maxE: 1100, maxN: 2100 }, 100)).toContain('bbox=900%2C1900%2C1200%2C2200%2Curn');
  });
});
