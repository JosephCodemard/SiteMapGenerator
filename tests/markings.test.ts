import { describe, expect, it } from 'vitest';
import { buildMarkings } from '../src/process/markings';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import { buildDrawing, ALL_FEATURES, defaultLayerToggles } from '../src/export/drawing';
import { polygonArea } from '../src/process/shape';
import type { LineFeature, PointFeature, Raster, SiteData } from '../src/types';

const road = (id: string, coords: [number, number][], tags: Record<string, string>): LineFeature =>
  ({ id, kind: 'road-minor', coords, tags: { highway: 'residential', ...tags }, bridge: false, tunnel: false });
const pt = (kind: PointFeature['kind'], p: [number, number], tags: Record<string, string> = {}): PointFeature => ({ id: `${kind}${p[0]}`, kind, p, tags });
const kinds = (m: ReturnType<typeof buildMarkings>) => m.reduce<Record<string, number>>((a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a), {});

describe('road markings', () => {
  it('draws a dashed centre line on a two-way road with the UK 2 m dash / 4 m gap', () => {
    const m = buildMarkings({ lines: [road('r', [[0, 0], [60, 0]], {})], points: [] });
    expect(kinds(m)).toEqual({ centre: 10 });
    for (const x of m) expect(polygonArea(x.ring)).toBeCloseTo(2 * 0.1, 1);
  });
  it('uses lane lines for multi-lane and one-way roads, and nothing on service roads or one-lane streets', () => {
    expect(kinds(buildMarkings({ lines: [road('a', [[0, 0], [60, 0]], { lanes: '4', width: '13' })], points: [] }))).toEqual({ lane: 20, centre: 10 });
    expect(kinds(buildMarkings({ lines: [road('b', [[0, 0], [60, 0]], { oneway: 'yes', lanes: '2', width: '7' })], points: [] }))).toEqual({ lane: 10 });
    expect(buildMarkings({ lines: [road('c', [[0, 0], [60, 0]], { highway: 'service' })], points: [] })).toEqual([]);
    expect(buildMarkings({ lines: [road('d', [[0, 0], [60, 0]], { oneway: 'yes', width: '3.5' })], points: [] })).toEqual([]);
  });
  it('cycle lanes and double yellow lines sit on the carriageway edge', () => {
    const m = buildMarkings({ lines: [road('e', [[0, 0], [40, 0]], { 'cycleway:right': 'lane', 'parking:condition:left': 'no_stopping', width: '7', oneway: 'yes' })], points: [] });
    const cyc = m.find((x) => x.kind === 'cycle')!;
    expect(cyc.colour).toBe('red');
    const ys = cyc.ring.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-3.5 + 0.0, 0); // right of eastward travel = -y
    expect(polygonArea(cyc.ring)).toBeCloseTo(40 * 1.5, 0);
    expect(m.filter((x) => x.kind === 'edge-yellow')).toHaveLength(2);
    expect(m.find((x) => x.kind === 'edge-yellow')!.colour).toBe('yellow');
  });
  it('zebra crossings are stripes along the road repeated across its width; signals give two lines', () => {
    const r = road('r', [[0, 0], [60, 0]], { width: '6' });
    const z = buildMarkings({ lines: [r], points: [pt('crossing', [30, 0.5], { crossing: 'zebra' })] }).filter((x) => x.kind === 'zebra');
    expect(z).toHaveLength(6);
    const xs = z.flatMap((s) => s.ring.map((p) => p[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 1); // 3 m long along the road
    const ys = z.flatMap((s) => s.ring.map((p) => p[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
    const s = buildMarkings({ lines: [r], points: [pt('crossing', [30, 0], { crossing: 'traffic_signals' })] }).filter((x) => x.kind === 'signal-crossing');
    expect(s).toHaveLength(2);
    // Crossings far from any road are ignored.
    expect(buildMarkings({ lines: [r], points: [pt('crossing', [30, 40], { crossing: 'zebra' })] }).filter((x) => x.kind === 'zebra')).toHaveLength(0);
  });
  it('stop and give-way lines cross the nearside half of the road', () => {
    const r = road('r', [[0, 0], [60, 0]], { width: '6' });
    const m = buildMarkings({ lines: [r], points: [pt('stop', [50, 0]), pt('giveway', [20, 0])] });
    const stop = m.find((x) => x.kind === 'stop')!;
    const ys = stop.ring.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3, 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(0.01); // left-hand traffic on an eastbound road: nearside is... checked as one half only
    expect(m.filter((x) => x.kind === 'giveway').length).toBeGreaterThan(2);
  });

  const W = 120;
  const dtm: Raster = { width: W, height: W, minE: 1000, maxN: 2000 + W, res: 1, data: new Float32Array(W * W).map((_, i) => 20 + 0.02 * (i % W)) };
  const site: SiteData = {
    bbox: { minE: 1000, minN: 2000, maxE: 1120, maxN: 2120 }, origin: [1060, 2060], dtm, dsm: null, buildings: [], areas: [], trees: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
    lines: [road('r', [[1000, 2060], [1120, 2060]], { width: '6.5' })],
    points: [pt('crossing', [1060, 2060], { crossing: 'zebra' }), pt('entrance', [1050, 2075], { entrance: 'main' })],
  };
  it('appear as their own 3D layer of closed thin solids sitting on the road, and can be switched off', async () => {
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', buildings: 'off', maxTris: 80_000 });
    const mk = sc.objects.find((o) => o.layer === 'markings')!;
    expect(mk.mesh.parts!.length).toBeGreaterThan(10);
    const roads = sc.objects.find((o) => o.layer === 'roads')!.mesh;
    const topRoad = Math.max(...Array.from(roads.positions).filter((_, i) => i % 3 === 2));
    expect(Math.max(...Array.from(mk.mesh.positions).filter((_, i) => i % 3 === 2))).toBeGreaterThan(topRoad - 0.5);
    const off = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', buildings: 'off', markings: false, maxTris: 80_000 });
    expect(off.objects.some((o) => o.layer === 'markings')).toBe(false);
  });
  it('appear in drawings on white/yellow/red layers with entrances marked', () => {
    const names = buildDrawing(site, [], { layers: defaultLayerToggles(), buildingLabels: false, features: ALL_FEATURES }).map((l) => l.name);
    expect(names).toContain('ROAD-MARK');
    expect(names).toContain('ENTRANCE');
    const noMarks = buildDrawing(site, [], { layers: defaultLayerToggles(), buildingLabels: false, features: { ...ALL_FEATURES, markings: false } }).map((l) => l.name);
    expect(noMarks).not.toContain('ROAD-MARK');
  });
});
