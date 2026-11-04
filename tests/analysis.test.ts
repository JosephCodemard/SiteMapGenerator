import { describe, expect, it } from 'vitest';
import { sunHours, shadowMask } from '../src/analysis/shadow';
import { londonToUtc, sunPosition, sunTimes } from '../src/analysis/sun';
import { runTask, tasks } from '../src/analysis/tasks';
import { bathtubFlood, buildingFlood, pondingDepth } from '../src/analysis/flood';
import type { Building, Raster } from '../src/types';

const grid = (w: number, h: number, f: (x: number, y: number) => number, res = 1): Raster => {
  const data = new Float32Array(w * h);
  // x east, y north (metres from the south-west corner); row 0 is the north edge.
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f((i + 0.5) * res, (h - j - 0.5) * res);
  return { width: w, height: h, minE: 1000, maxN: 2000 + h * res, res, data };
};

describe('sun position', () => {
  const lat = 51.5, lon = 0;
  it('solar noon altitude = 90 - lat + declination on the solstices and equinox', () => {
    for (const [iso, decl] of [['2020-06-21', 23.44], ['2020-12-21', -23.44], ['2020-03-20', 0]] as const) {
      const t = sunTimes(new Date(`${iso}T00:00:00Z`), lat, lon)!;
      const s = sunPosition(t.noon, lat, lon);
      expect(s.altitude).toBeGreaterThan(90 - lat + decl - 0.5);
      expect(s.altitude).toBeLessThan(90 - lat + decl + 0.5);
      expect(Math.abs(s.azimuth - 180)).toBeLessThan(1.5);
    }
  });
  it('day length matches published values for London (about 16 h 38 m / 7 h 50 m / 12 h 08 m)', () => {
    const len = (iso: string) => { const t = sunTimes(new Date(`${iso}T00:00:00Z`), lat, lon)!; return (t.set.getTime() - t.rise.getTime()) / 3600000; };
    expect(len('2020-06-21')).toBeGreaterThan(16.4); expect(len('2020-06-21')).toBeLessThan(16.9);
    expect(len('2020-12-21')).toBeGreaterThan(7.6); expect(len('2020-12-21')).toBeLessThan(8.1);
    expect(len('2020-03-20')).toBeGreaterThan(12.0); expect(len('2020-03-20')).toBeLessThan(12.3);
  });
  it('rises in the east and sets in the west at the equinox; polar night has no sunrise', () => {
    const t = sunTimes(new Date('2020-03-20T00:00:00Z'), lat, lon)!;
    expect(Math.abs(sunPosition(new Date(t.rise.getTime() + 60000), lat, lon).azimuth - 90)).toBeLessThan(4);
    expect(Math.abs(sunPosition(new Date(t.set.getTime() - 60000), lat, lon).azimuth - 270)).toBeLessThan(4);
    expect(sunTimes(new Date('2020-12-21T00:00:00Z'), 80, 0)).toBeNull();
  });
});

describe('shadows', () => {
  // 10 m tall block at x 40..60, y 40..60 on flat ground, 120 m square.
  const dsm = grid(120, 120, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? 10 : 0));
  const at = (m: Uint8Array, x: number, y: number) => m[(120 - Math.floor(y) - 1) * 120 + Math.floor(x)];
  it('casts a shadow of length height / tan(altitude) away from the sun', () => {
    const m = shadowMask(dsm, { azimuth: 180, altitude: 30 }); // sun in the south: shadow falls north
    const L = 10 / Math.tan((30 * Math.PI) / 180); // 17.3 m
    expect(at(m, 50, 60 + L - 3)).toBe(1);
    expect(at(m, 50, 60 + L + 3)).toBe(0);
    expect(at(m, 50, 30)).toBe(0); // south of the block: sunlit
    expect(at(m, 50, 50)).toBe(0); // the roof is sunlit
    expect(at(m, 20, 70)).toBe(0); // beside the shadow
    const sunWest = shadowMask(dsm, { azimuth: 270, altitude: 30 }); // shadow to the east
    expect(at(sunWest, 60 + L - 3, 50)).toBe(1);
    expect(at(sunWest, 50, 70)).toBe(0);
  });
  it('is all shadow when the sun is down', () => {
    expect(shadowMask(dsm, { azimuth: 0, altitude: -5 }).every((v) => v === 1)).toBe(true);
  });
  it('open ground gets the full day of sun, the north side of a block gets less, the roof the same as open ground', () => {
    const r = sunHours(dsm, new Date('2020-03-20T00:00:00Z'), 51.4, -2.36, 30);
    expect(r.daylight).toBeGreaterThan(12.0);
    const at2 = (x: number, y: number) => r.hours[(r.raster.height - Math.floor(y) - 1) * r.raster.width + Math.floor(x)];
    expect(at2(5, 5)).toBeCloseTo(r.daylight, 1);
    expect(at2(50, 50)).toBeCloseTo(r.daylight, 1);
    expect(at2(50, 66)).toBeLessThan(r.daylight - 1.5);
    expect(at2(50, 20)).toBeGreaterThan(at2(50, 66));
    // Polar night: nothing.
    expect(Math.max(...sunHours(dsm, new Date('2020-12-21T00:00:00Z'), 80, 0).hours)).toBe(0);
  });
});

describe('flooding', () => {
  // A valley: low channel at x 0..10 (z = 5), banks rising 1 m per 10 m, plus an isolated hollow at x 80..90.
  const dtm = grid(120, 60, (x, y) => {
    if (x >= 80 && x < 90 && y >= 20 && y < 30) return 3; // hollow, unconnected
    return x < 10 ? 5 : 5 + (x - 10) * 0.1;
  });
  const sources = new Uint8Array(120 * 60);
  for (let j = 0; j < 60; j++) for (let i = 0; i < 10; i++) sources[j * 120 + i] = 1;
  it('fills only cells connected to the source and lower than the level', () => {
    const f = bathtubFlood(dtm, { level: 7, sources });
    const d = (x: number, y: number) => f.depth[(60 - Math.floor(y) - 1) * 120 + Math.floor(x)];
    expect(d(5, 30)).toBeCloseTo(2, 3);
    expect(d(25, 30)).toBeCloseTo(7 - (5 + 15.5 * 0.1), 1); // bank at x = 25.5: 6.55
    expect(d(40, 30)).toBe(0); // above the level
    expect(d(85, 25)).toBe(0); // the hollow is lower than the level but not connected
    expect(f.maxDepth).toBeCloseTo(2, 3);
    expect(f.volume).toBeGreaterThan(0);
    // Higher level, more area.
    expect(bathtubFlood(dtm, { level: 8, sources }).area).toBeGreaterThan(f.area);
  });
  it('a defence wall stops the water, and depth is still measured to the ground', () => {
    const wall = { lines: [[[1020, 2000], [1020, 2060]] as [number, number][]], height: 3 };
    const f = bathtubFlood(dtm, { level: 7, sources, defences: wall });
    const d = (x: number, y: number) => f.depth[(60 - Math.floor(y) - 1) * 120 + Math.floor(x)];
    expect(d(15, 30)).toBeGreaterThan(0);
    expect(d(25, 30)).toBe(0);
  });
  it('reports flooded buildings with depth against the walls', () => {
    const f = bathtubFlood(dtm, { level: 7, sources });
    const sq = (x: number, y: number, s: number): [number, number][][] => [[[1000 + x, 2000 + y], [1000 + x + s, 2000 + y], [1000 + x + s, 2000 + y + s], [1000 + x, 2000 + y + s]]];
    const bs: Building[] = [
      { id: 'wet', rings: sq(12, 20, 6), tags: {}, ground: 0, top: 9, source: 'lidar' },
      { id: 'dry', rings: sq(60, 20, 6), tags: {}, ground: 0, top: 9, source: 'lidar' },
    ];
    const r = buildingFlood(bs, f);
    expect(r.map((x) => x.id)).toEqual(['wet']);
    expect(r[0].depth).toBeGreaterThan(1.3);
    expect(r[0].wetFraction).toBe(1);
  });
  it('ponding finds closed depressions but not slopes that drain off the site', () => {
    const bowl = grid(60, 60, (x, y) => 10 + 0.05 * x + ((x - 30) ** 2 + (y - 30) ** 2 < 81 ? -2 : 0));
    const p = pondingDepth(bowl);
    expect(p.depth[(60 - 30 - 1) * 60 + 30]).toBeGreaterThan(1);
    expect(p.depth[(60 - 5 - 1) * 60 + 5]).toBe(0);
    expect(p.volume).toBeGreaterThan(100);
    expect(pondingDepth(grid(40, 40, (x) => 10 + 0.1 * x)).area).toBe(0);
  });
});

import { windField, lawsonClass } from '../src/analysis/wind';
import { kernelDensity, summariseCrimes, filterCrimes } from '../src/analysis/crime';
import { findEntrances } from '../src/analysis/entrances';
import { footfall } from '../src/analysis/footfall';
import type { LineFeature, PointFeature } from '../src/types';

describe('wind screening', () => {
  const flatDtm = grid(200, 200, () => 0);
  // 20 m tall block at x 90..110, y 90..110; two long 15 m walls forming a channel at y 40..46 (x 20..180).
  const dsm = grid(200, 200, (x, y) => ((x >= 90 && x < 110 && y >= 90 && y < 110) || (x >= 20 && x < 180 && (y >= 30 && y < 40 || y >= 46 && y < 56)) ? (y > 80 ? 20 : 15) : 0));
  const at = (r: { ratio: Float32Array }, x: number, y: number) => r.ratio[(200 - Math.floor(y) - 1) * 200 + Math.floor(x)];
  it('open ground keeps the open-terrain ratio; the lee of a tall block is sheltered; walls are zero', () => {
    const r = windField(dsm, flatDtm, { from: 270, speed: 10 }); // wind from the west, blowing east
    const open = at(r, 20, 150);
    expect(open).toBeCloseTo(r.openRatio, 1);
    expect(at(r, 118, 100)).toBeLessThan(open * 0.55); // 8 m behind the block (0.4 H)
    // The wake is about 8 block heights (160 m) long, so the flow recovers gradually with distance.
    expect(at(r, 150, 100)).toBeGreaterThan(at(r, 118, 100));
    expect(at(r, 195, 100)).toBeGreaterThan(at(r, 150, 100));
    expect(at(r, 195, 100)).toBeLessThan(open);
    expect(at(r, 100, 100)).toBe(0);
  });
  it('a street aligned with the wind and flanked by tall buildings accelerates the flow', () => {
    const r = windField(dsm, flatDtm, { from: 270, speed: 10 });
    expect(at(r, 100, 43)).toBeGreaterThan(at(r, 20, 150) * 1.15);
    const cross = windField(dsm, flatDtm, { from: 0, speed: 10 }); // wind across the street
    expect(at(cross, 100, 43)).toBeLessThan(at(r, 100, 43));
  });
  it('speed scales with the reference and Lawson classes follow the thresholds', () => {
    const a = windField(dsm, flatDtm, { from: 270, speed: 5 }), b = windField(dsm, flatDtm, { from: 270, speed: 15 });
    expect(b.speed[100 * 200 + 20] / a.speed[100 * 200 + 20]).toBeCloseTo(3, 5);
    expect([3, 5, 7, 9, 12].map(lawsonClass)).toEqual([0, 1, 2, 3, 4]);
    expect(b.share.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(b.share[4] + b.share[3]).toBeGreaterThan(a.share[4] + a.share[3]);
  });
});

describe('crime', () => {
  it('kernel density peaks at the cluster and conserves mass', () => {
    const like = { width: 100, height: 100, minE: 0, maxN: 100, res: 1 };
    const d = kernelDensity([{ p: [50, 50] }, { p: [51, 50] }, { p: [20, 80] }], like, 6);
    const idx = (e: number, n: number) => (100 - Math.floor(n) - 1) * 100 + Math.floor(e);
    expect(d[idx(50, 50)]).toBeGreaterThan(d[idx(20, 80)]);
    expect(d[idx(50, 50)]).toBeGreaterThan(d[idx(70, 50)] * 20);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 1);
  });
  it('summarises by category, month and street, and filters', () => {
    const cr = (category: string, month: string, street: string) => ({ category, month, street, outcome: null, p: [0, 0] as [number, number] });
    const list = [cr('burglary', '2026-07', 'A St'), cr('burglary', '2026-08', 'A St'), cr('shoplifting', '2026-08', 'B St')];
    const s = summariseCrimes(list);
    expect(s.total).toBe(3);
    expect(s.byCategory[0]).toEqual(['burglary', 2]);
    expect(s.byMonth).toEqual([['2026-07', 1], ['2026-08', 2]]);
    expect(s.byStreet[0]).toEqual(['A St', 2]);
    expect(filterCrimes(list, 'shoplifting')).toHaveLength(1);
    expect(filterCrimes(list, 'all')).toHaveLength(3);
  });
});

describe('entrances and footfall', () => {
  const road = (id: string, coords: [number, number][], kind: LineFeature['kind'] = 'road-minor', name?: string): LineFeature =>
    ({ id, kind, coords, tags: { highway: kind === 'path' ? 'footway' : 'residential' }, bridge: false, tunnel: false, name });
  const house = (id: string, x: number, y: number, tags: Record<string, string> = { building: 'house' }): Building =>
    ({ id, rings: [[[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8]]], tags, ground: 0, top: 6, source: 'lidar' });

  it('finds OSM entrances on the outline, and infers doors facing the nearest way for the rest', () => {
    const bs = [house('a', 10, 5), house('b', 40, 5), house('far', 10, 200)];
    const pts: PointFeature[] = [{ id: 'e', kind: 'entrance', p: [14, 5.5], tags: { entrance: 'main' } }];
    const es = findEntrances(bs, pts, [road('r', [[0, 0], [100, 0]])]);
    const a = es.find((e) => e.buildingId === 'a')!;
    expect(a.source).toBe('osm');
    expect(a.p[1]).toBeCloseTo(5, 1); // snapped onto the wall
    const b = es.find((e) => e.buildingId === 'b')!;
    expect(b.source).toBe('inferred');
    expect(b.p[1]).toBeCloseTo(5, 1); // the south wall faces the road
    expect(es.some((e) => e.buildingId === 'far')).toBe(false); // no way within 25 m
  });

  // 5 x 5 street grid, 50 m spacing; houses on the south-west, a bus stop at the north-east corner.
  const lines: LineFeature[] = [];
  for (let k = 0; k < 5; k++) {
    lines.push(road(`h${k}`, Array.from({ length: 5 }, (_, i) => [i * 50, k * 50] as [number, number]), 'road-minor', `Row ${k}`));
    lines.push(road(`v${k}`, Array.from({ length: 5 }, (_, i) => [k * 50, i * 50] as [number, number]), 'road-minor', `Col ${k}`));
  }
  const houses = [house('h1', 2, 2), house('h2', 52, 2), house('h3', 2, 52)];
  const stop: PointFeature = { id: 's', kind: 'transit', p: [200, 200], tags: { highway: 'bus_stop' } };
  it('flow concentrates on routes from the houses to the stop, and trips are conserved', () => {
    const es = findEntrances(houses, [], lines);
    const r = footfall(houses, es, [stop], lines);
    expect(r.origins).toBeGreaterThan(0);
    expect(r.destinations).toBe(1);
    // Inflow at the stop node (200,200) equals the total supply.
    const at = (p: [number, number], q: [number, number]) => (e: { a: [number, number]; b: [number, number] }) => [e.a, e.b].some((x) => x[0] === p[0] && x[1] === p[1]) && [e.a, e.b].some((x) => x[0] === q[0] && x[1] === q[1]);
    const into = r.edges.filter((e) => [e.a, e.b].some((x) => x[0] === 200 && x[1] === 200)).reduce((s, e) => s + e.raw, 0);
    const supply = houses.reduce((s) => s + 8 * 8 * 2 / 100, 0);
    expect(into).toBeCloseTo(supply, 6);
    // Busy near the houses and the stop; quiet at the far corner (200, 0), which isn't on any shortest route.
    const busy = r.edges.filter((e) => e.flow > 0.5).length;
    expect(busy).toBeGreaterThan(0);
    const far = r.edges.find(at([200, 0], [200, 50]))!;
    expect(far.raw).toBe(0);
    expect(Math.max(...r.edges.map((e) => e.flow))).toBe(1);
    expect(r.hotspots[0].flow).toBe(1);
  });
  it('transit weight and missing destinations behave', () => {
    const es = findEntrances(houses, [], lines);
    expect(footfall(houses, es, [], lines).edges.every((e) => e.raw === 0)).toBe(true);
    const near: PointFeature = { id: 'n', kind: 'poi', p: [0, 50], tags: { amenity: 'cafe' } };
    const r = footfall(houses, es, [stop, near], lines);
    const flowToCafe = r.edges.filter((e) => [e.a, e.b].some((x) => x[0] === 0 && x[1] === 50)).reduce((s, e) => s + e.raw, 0);
    expect(flowToCafe).toBeGreaterThan(0);
    const heavy = footfall(houses, es, [stop, near], lines, { residential: 1, retail: 1, transit: 0.01 });
    expect(heavy.edges.filter((e) => [e.a, e.b].some((x) => x[0] === 200 && x[1] === 200)).reduce((s, e) => s + e.raw, 0))
      .toBeLessThan(r.edges.filter((e) => [e.a, e.b].some((x) => x[0] === 200 && x[1] === 200)).reduce((s, e) => s + e.raw, 0));
  });
});

describe('time zones and tasks', () => {
  it('converts UK wall-clock time to UTC with BST', () => {
    expect(londonToUtc('2026-06-21', '12:00').toISOString()).toBe('2026-06-21T11:00:00.000Z');
    expect(londonToUtc('2026-12-21', '12:00').toISOString()).toBe('2026-12-21T12:00:00.000Z');
    expect(londonToUtc('2026-03-29', '12:00').toISOString()).toBe('2026-03-29T11:00:00.000Z'); // clocks go forward that morning
  });
  it('tasks run inline when there is no Worker, with progress', async () => {
    const dsm = grid(30, 30, () => 0);
    const frac: number[] = [];
    const r = await runTask('sunHours', { dsm, day: '2020-03-20', lat: 51.4, lon: -2.36, step: 60 }, (f) => frac.push(f));
    expect(r.daylight).toBeGreaterThan(12);
    expect(frac.at(-1)).toBeCloseTo(1, 6);
    expect(Object.keys(tasks)).toEqual(['sunHours', 'shadowAt', 'flood', 'ponding', 'wind', 'footfall']);
    const s = await runTask('shadowAt', { dsm, azimuth: 180, altitude: 20 });
    expect(s.mask.every((v) => v === 0)).toBe(true);
  });
});
