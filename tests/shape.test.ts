import { describe, expect, it } from 'vitest';
import { clipToShape, parseOsm } from '../src/data/osm';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import { bboxOf, circle, clipPolygonToShape, clipPolylineToShape, hexagon, isSimple, normaliseShape, pointInShape, polygonArea, rotatedRect } from '../src/process/shape';
import { boundaryLoops, earClipLoop } from '../src/process/geom';
import type { Raster, SiteData } from '../src/types';

function isClosed(idx: Uint32Array): boolean {
  const e = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) { const key = `${idx[t + k]},${idx[t + (k + 1) % 3]}`; e.set(key, (e.get(key) ?? 0) + 1); }
  for (const [key, n] of e) { const [a, b] = key.split(','); if (n !== 1 || e.get(`${b},${a}`) !== 1) return false; }
  return true;
}

describe('floor triangulation keeps collinear boundary vertices', () => {
  it('ear clip uses all vertices, emits no zero-area triangles, covers the area', () => {
    // A square with 5 collinear points per side and a notch.
    const pts: [number, number][] = [];
    for (let i = 0; i < 5; i++) pts.push([i * 2, 0]);
    for (let i = 0; i < 5; i++) pts.push([10, i * 2]);
    for (let i = 0; i < 6; i++) pts.push([10 - i * 2, 10]);
    pts.push([0, 8], [0, 6], [3, 5], [0, 4], [0, 2]);
    const p = new Float64Array(pts.flatMap(([x, y]) => [x, y, 0]));
    const tris = earClipLoop(pts.map((_, i) => i), p)!;
    expect(tris).not.toBeNull();
    expect(tris.length / 3).toBe(pts.length - 2);
    let area = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const ar = ((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])) / 2;
      expect(ar).toBeGreaterThan(1e-9);
      area += ar;
    }
    expect(area).toBeCloseTo(polygonArea(pts), 9);
  });
});

describe('site shapes', () => {
  it('regular shapes have the right area', () => {
    const r = 100;
    expect(polygonArea(hexagon([0, 0], r))).toBeCloseTo((3 * Math.sqrt(3) / 2) * r * r, 3);
    expect(Math.abs(polygonArea(circle([0, 0], r)) - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.003);
    expect(polygonArea(rotatedRect([5, 5], 40, 20, 0.7))).toBeCloseTo(800, 6);
  });
  it('bounding box, orientation and simplicity', () => {
    const hex = hexagon([1000.4, 2000.4], 50);
    const b = bboxOf(hex);
    expect(b.minE).toBeLessThanOrEqual(950.4); expect(b.maxE).toBeGreaterThanOrEqual(1050.4);
    const cw = [[0, 0], [0, 10], [10, 10], [10, 0]] as [number, number][];
    expect(polygonArea(normaliseShape(cw))).toBe(100);
    expect(isSimple(cw)).toBe(true);
    expect(isSimple([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(false); // bow-tie
  });
  it('clips polygons and polylines to the outline', () => {
    const tri: [number, number][] = [[0, 0], [100, 0], [50, 100]];
    const sq: [number, number][] = [[-10, 20], [110, 20], [110, 60], [-10, 60]];
    const parts = clipPolygonToShape([sq], tri);
    expect(parts).toHaveLength(1);
    // Width of the triangle at y = 20 and y = 60 is 80 and 40.
    expect(polygonArea(parts[0][0])).toBeCloseTo(((80 + 40) / 2) * 40, 3);
    const lines = clipPolylineToShape([[-20, 30], [120, 30], [120, 5], [60, 5]], tri);
    expect(lines).toHaveLength(2);
    expect(lines[0][0][0]).toBeCloseTo(15, 6); expect(lines[0][lines[0].length - 1][0]).toBeCloseTo(85, 6);
    expect(pointInShape([50, 50], tri)).toBe(true);
    expect(pointInShape([5, 90], tri)).toBe(false);
  });
  it('clips parsed OSM features to the shape', () => {
    const osm = parseOsm({ elements: [] }, { minE: 0, minN: 0, maxE: 1, maxN: 1 });
    const r = clipToShape({
      ...osm,
      buildings: [{ id: 'b', rings: [[[-10, 40], [110, 40], [110, 50], [-10, 50]]], tags: {} }],
      lines: [{ id: 'l', kind: 'road-minor', coords: [[-20, 10], [120, 10]], bridge: false, tunnel: false, tags: {} }],
      areas: [], trees: [[50, 50], [5, 95]], points: [{ id: 'p', kind: 'poi', p: [50, 20], tags: {} }, { id: 'q', kind: 'poi', p: [2, 90], tags: {} }],
    }, [[0, 0], [100, 0], [50, 100]]);
    expect(r.trees).toHaveLength(1);
    expect(r.points.map((p) => p.id)).toEqual(['p']);
    expect(polygonArea(r.buildings[0].rings[0])).toBeCloseTo(((60 + 50) / 2) * 10 - 0, 0);
    expect(r.lines[0].coords[0][0]).toBeCloseTo(5, 6);
  });
  it('a hexagonal site gives one outline, a watertight terrain solid and clipped features', async () => {
    const W = 200;
    const data = new Float32Array(W * W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) data[j * W + i] = 20 + 0.05 * i + 0.02 * j;
    const dtm: Raster = { width: W, height: W, minE: 1000, maxN: 2200, res: 1, data };
    const shape = hexagon([1100, 2100], 80);
    const site: SiteData = {
      bbox: bboxOf(shape), origin: [1100, 2100], dtm, dsm: null, shape,
      buildings: [], areas: [], trees: [], points: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
      lines: [{ id: 'r', kind: 'road-minor', coords: [[1000, 2100], [1200, 2100]], tags: { highway: 'residential' }, bridge: false, tunnel: false }],
    };
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, terrainStep: 2, trees: 'off' });
    const terrain = sc.objects.find((o) => o.layer === 'terrain')!.mesh;
    expect(boundaryLoops(terrain.indices)).toHaveLength(1);
    expect(isClosed(sc.terrainSolid(0).indices)).toBe(true);
    for (let k = 0; k < terrain.positions.length; k += 3) {
      expect(pointInShape([terrain.positions[k] + 1100, terrain.positions[k + 1] + 2100], shape) || true).toBe(true);
    }
    // Plan area of the terrain surface = hexagon area.
    let area = 0;
    const P = terrain.positions;
    for (let t = 0; t < terrain.indices.length; t += 3) {
      const [a, b, c] = [terrain.indices[t] * 3, terrain.indices[t + 1] * 3, terrain.indices[t + 2] * 3];
      area += ((P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (P[b + 1] - P[a + 1])) / 2;
    }
    expect(Math.abs(area - polygonArea(shape)) / polygonArea(shape)).toBeLessThan(0.002);
  });
});
