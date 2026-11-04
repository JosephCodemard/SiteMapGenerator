import { describe, expect, it } from 'vitest';
import { placeDormers } from '../src/process/dormers';
import { attachParts } from '../src/process/buildings';
import { wallLevels } from '../src/process/facades';
import type { Mesh } from '../src/process/mesh';
import { fitRoofParts } from '../src/process/roofparts';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import { parseOsm } from '../src/data/osm';
import type { Building, Raster, SiteData } from '../src/types';

function isWatertight(m: Mesh): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) for (let c = 0; c < 3; c++) {
    const k = `${m.indices[t + c]},${m.indices[t + ((c + 1) % 3)]}`;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  for (const [k, n] of edges) { const [a, b] = k.split(','); if (n !== 1 || edges.get(`${b},${a}`) !== 1) return false; }
  return true;
}
function raster(w: number, h: number, f: (x: number, y: number) => number): Raster {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f(i + 0.5, h - j - 0.5);
  return { width: w, height: h, minE: 1000, maxN: 2000 + h, res: 1, data };
}
const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const bld = (id: string, rings: [number, number][][], top = 12, tags: Record<string, string> = {}): Building => ({ id, rings, tags, ground: 0, top, source: 'lidar' });
const origin: [number, number] = [1000, 2000];
const flat0 = raster(80, 60, () => 0);

/** Georgian-style mansard across a 12 m deep terrace: wall to z=9, steep slope to a break 1.2 m in (z=12), then 20 degrees to the ridge. */
const mansard = (x: number, y: number) => {
  if (x < 10 || x > 40 || y < 10 || y > 22) return 0;
  const t = 6 - Math.abs(y - 16);
  return t < 1.2 ? 9 + 2.5 * t : 12 + 0.36 * (t - 1.2);
};

describe('mansard roofs', () => {
  it('fits a steep-then-shallow profile and builds a closed solid', () => {
    const dsm = raster(80, 60, mansard);
    const parts = fitRoofParts(bld('m', [sq(1010, 2010, 1040, 2022)]), dsm, flat0, origin)!;
    expect(parts.some((p) => p.fit.type === 'mansard')).toBe(true);
    const p = parts.find((q) => q.fit.type === 'mansard')!;
    expect(p.fit.profile!.length).toBe(3);
    expect(p.fit.rmse).toBeLessThan(0.4);
    expect(isWatertight(p.mesh)).toBe(true);
  });

  it('keeps a plain gable a gable', () => {
    const dsm = raster(80, 60, (x, y) => (x < 10 || x > 40 || y < 10 || y > 22 ? 0 : 8 + 0.6 * (6 - Math.abs(y - 16))));
    const parts = fitRoofParts(bld('g', [sq(1010, 2010, 1040, 2022)]), dsm, flat0, origin)!;
    expect(parts.every((p) => p.fit.type === 'gable')).toBe(true);
  });

  it('places dormers on the steep slope, as closed solids buried in the roof, and none on party walls', () => {
    const dsm = raster(80, 60, mansard);
    const b = bld('m', [sq(1010, 2010, 1040, 2022)]);
    const parts = fitRoofParts(b, dsm, flat0, origin)!;
    const p = parts.find((q) => q.fit.type === 'mansard')!;
    const res = placeDormers(p.region, p.fit, p.ground, origin, () => false);
    expect(res.list.length).toBeGreaterThan(4);
    expect(res.solids && isWatertight(res.solids)).toBe(true);
    expect(res.windows && isWatertight(res.windows)).toBe(true);
    // Everything stands on the two long (sloping) sides: northing-local 0..12 -> y near 10 and 22.
    for (const d of res.list) expect(Math.min(Math.abs(d.p[1] - 2010), Math.abs(d.p[1] - 2022))).toBeLessThan(1.5);
    const none = placeDormers(p.region, p.fit, p.ground, origin, () => true);
    expect(none.list).toHaveLength(0);
  });

  it('puts the top floor in the roof: wall storeys exclude the mansard attic', () => {
    const dsm = raster(80, 60, mansard);
    const b = bld('m', [sq(1010, 2010, 1040, 2022)], 12, { 'building:levels': '4' });
    b.roofParts = fitRoofParts(b, dsm, flat0, origin)!.map((p) => p.fit);
    expect(wallLevels(b)).toBe(3);
  });
});

describe('spires, churches and OSM roof tags', () => {
  it('fits a steep pyramid on a small square tower', () => {
    const dsm = raster(80, 60, (x, y) => (x < 20 || x > 26 || y < 20 || y > 26 ? 0 : 14 + 4 * (3 - Math.max(Math.abs(x - 23), Math.abs(y - 23)))));
    const parts = fitRoofParts(bld('s', [sq(1020, 2020, 1026, 2026)], 20), dsm, flat0, origin)!;
    expect(parts[0].fit.type).toBe('hip');
    expect(parts[0].fit.ridge - parts[0].fit.eaves).toBeGreaterThan(8);
  });

  it('keeps an irregular church roof as the LIDAR surface instead of a flat block', () => {
    const dsm = raster(80, 60, (x, y) => (x < 10 || x > 40 || y < 10 || y > 30 ? 0 : 10 + 3 * Math.sin(x / 2.2) * Math.cos(y / 2.6) + 4 * Math.sin(x / 7)));
    const b = bld('c', [sq(1010, 2010, 1040, 2030)], 14, { building: 'church' });
    const parts = fitRoofParts(b, dsm, flat0, origin)!;
    expect(parts.some((p) => p.fit.type === 'surface')).toBe(true);
    expect(parts.every((p) => p.mesh.indices.length > 0)).toBe(true);
  });

  it('honours roof:shape=flat and parses building:part volumes', () => {
    const dsm = raster(80, 60, (x, y) => (x < 10 || x > 30 || y < 10 || y > 20 ? 0 : 8 + 0.5 * (5 - Math.abs(y - 15))));
    const flat = fitRoofParts(bld('f', [sq(1010, 2010, 1030, 2020)], 10, { 'roof:shape': 'flat' }), dsm, flat0, origin)!;
    expect(flat[0].fit.type).toBe('flat');
    const raw = {
      elements: [
        { type: 'node', id: 1, lat: 51.38, lon: -2.36 }, { type: 'node', id: 2, lat: 51.38, lon: -2.3595 },
        { type: 'node', id: 3, lat: 51.3804, lon: -2.3595 }, { type: 'node', id: 4, lat: 51.3804, lon: -2.36 },
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { 'building:part': 'yes', 'roof:shape': 'hipped', height: '20' } },
      ],
    };
    const r = parseOsm(raw, { minE: 0, minN: 0, maxE: 1e7, maxN: 1e7 });
    expect(r.parts).toHaveLength(1);
    expect(r.buildings).toHaveLength(0);
    const host = bld('h', r.parts[0].rings);
    attachParts([host], r.parts);
    expect(host.parts).toHaveLength(1);
  });
});

describe('scene with dormers', () => {
  it('builds dormers and their windows as layers', async () => {
    const dsm = raster(80, 60, mansard);
    const b = bld('m', [sq(1010, 2010, 1040, 2022)], 12);
    const site: SiteData = {
      bbox: { minE: 1000, minN: 2000, maxE: 1080, maxN: 2060 }, origin, dtm: flat0, dsm, buildings: [b], lines: [], areas: [], trees: [], points: [],
      osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
    };
    const scene = await buildScene(site, { ...DEFAULT_SETTINGS, buildings: 'lod2fit', trees: 'off', roads: false, paths: false, rail: false, water: false, green: false, bridges: false, walls: false, markings: false });
    expect(scene.objects.some((o) => o.layer === 'dormers')).toBe(true);
    expect(scene.objects.some((o) => o.layer === 'windows')).toBe(true);
    expect(b.dormers!.length).toBeGreaterThan(0);
  });
});

describe('industrial and multi-level roofs', () => {
  const big = raster(120, 80, () => 0);
  const hall = (f: (x: number, y: number) => number) => raster(120, 80, (x, y) => (x < 10 || x > 90 || y < 10 || y > 50 ? 0 : f(x, y)));
  const foot = [sq(1010, 2010, 1090, 2050)];
  const types = (parts: ReturnType<typeof fitRoofParts>) => parts!.map((p) => `${p.fit.type}:${p.fit.kind ?? ''}`);

  it('splits a wide hall of repeated gables into one gable per span', () => {
    // 8 m spans along x, ridge along y: z = 7 + 2.4 * triangle(phase)
    const dsm = hall((x) => 7 + 2.4 * (1 - Math.abs(2 * (((x - 10) % 8) / 8) - 1)));
    const parts = fitRoofParts(bld('mg', foot, 10), dsm, big, origin)!;
    expect(parts).toHaveLength(10);
    expect(new Set(types(parts))).toEqual(new Set(['gable:multi-gable']));
    for (const p of parts) { expect(isWatertight(p.mesh), p.name).toBe(true); expect(p.fit.ridge - p.fit.eaves).toBeGreaterThan(1.8); }
  });

  it('recognises a sawtooth roof and builds one sloping strip per tooth', () => {
    // 10 m teeth rising along x then dropping vertically: z = 6 + 3 * phase
    const dsm = hall((x) => 6 + 3 * (((x - 10) % 10) / 10));
    const parts = fitRoofParts(bld('st', foot, 10), dsm, big, origin)!;
    expect(parts.length).toBeGreaterThanOrEqual(8);
    expect(new Set(types(parts))).toEqual(new Set(['shed:sawtooth']));
    for (const p of parts) expect(isWatertight(p.mesh), p.name).toBe(true);
  });

  it('recognises repeated barrel vaults and a single vault', () => {
    const arc = (t: number) => Math.sqrt(Math.max(0, 1 - (1 - 2 * t) ** 2));
    const rep = fitRoofParts(bld('bv', foot, 11), hall((x) => 6 + 4 * arc(((x - 10) % 10) / 10)), big, origin)!;
    expect(rep.length).toBeGreaterThanOrEqual(8);
    expect(new Set(types(rep))).toEqual(new Set(['mansard:barrel']));
    for (const p of rep) expect(isWatertight(p.mesh), p.name).toBe(true);
    // One semi-circular vault, 12 m span, across a 30 m shed.
    const single = raster(80, 60, (x, y) => (x < 10 || x > 40 || y < 10 || y > 22 ? 0 : 6 + 5.5 * Math.sqrt(Math.max(0, 1 - ((y - 16) / 6) ** 2))));
    const one = fitRoofParts(bld('one', [sq(1010, 2010, 1040, 2022)], 12), single, flat0, origin)!;
    expect(one.some((p) => p.fit.kind === 'barrel')).toBe(true);
    expect(isWatertight(one.find((p) => p.fit.kind === 'barrel')!.mesh)).toBe(true);
  });

  it('does not turn an ordinary gabled terrace house or a flat roof into an industrial roof', () => {
    const gable = raster(80, 60, (x, y) => (x < 10 || x > 40 || y < 10 || y > 22 ? 0 : 8 + 0.6 * (6 - Math.abs(y - 16))));
    expect(types(fitRoofParts(bld('g', [sq(1010, 2010, 1040, 2022)]), gable, flat0, origin))).toEqual(['gable:']);
    const flat = hall(() => 9);
    expect(types(fitRoofParts(bld('f', foot, 9), flat, big, origin))).toEqual(['flat:']);
  });

  it('splits a house and its lower flat extension into two levels', () => {
    // 12 x 8 m gabled house (eaves 6, ridge 9.6, ridge along x) + 8 x 8 m flat extension at z = 3.5 to the east.
    const dsm = raster(80, 60, (x, y) => {
      if (y < 10 || y > 18) return 0;
      if (x >= 10 && x <= 22) return 6 + 0.9 * (4 - Math.abs(y - 14));
      if (x > 22 && x <= 30) return 3.5;
      return 0;
    });
    const L = [[[1010, 2010], [1030, 2010], [1030, 2018], [1010, 2018]]] as [number, number][][];
    const parts = fitRoofParts(bld('ext', L, 9), dsm, flat0, origin)!;
    expect(parts.length).toBe(2);
    const heights = parts.map((p) => p.fit.ridge).sort((p, q) => p - q);
    expect(heights[0]).toBeLessThan(4.2); expect(heights[1]).toBeGreaterThan(8.5);
    for (const p of parts) expect(isWatertight(p.mesh), p.name).toBe(true);
  });
});
