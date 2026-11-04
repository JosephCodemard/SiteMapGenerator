import { describe, expect, it } from 'vitest';
import { parseGridRef, toBNG, toWGS } from '../src/geo/bng';
import { clipPolygonToBox, clipPolyline, clipRing, signedArea } from '../src/process/clip';
import { contourBands, contourLines } from '../src/process/contours';
import { buildingsMesh, terrainMesh, type Mesh } from '../src/process/mesh';
import { buildingHeights } from '../src/process/buildings';
import { fillNoData } from '../src/process/raster';
import { writeStl } from '../src/export/stl';
import { writeDxf } from '../src/export/dxf';
import type { Building, Raster } from '../src/types';

// Reference values: pyproj + official OSTN15 grid (tools/build_ostn15_correction.py).
const REF: [string, number, number, number, number][] = [
  ['Bath Abbey', -2.359, 51.3815, 375112.041, 164778.366],
  ['Royal Crescent', -2.3676, 51.3871, 374516.667, 165404.135],
  ['London', -0.1276, 51.5072, 530041.454, 180358.009],
  ['Newcastle', -1.6178, 54.9783, 424561.563, 564920.722],
];

describe('BNG / OSTN15', () => {
  it.each(REF)('%s matches OSTN15 to < 5 cm', (_, lon, lat, e, n) => {
    const [E, N] = toBNG(lon, lat);
    expect(Math.hypot(E - e, N - n)).toBeLessThan(0.05);
  });
  it('round-trips', () => {
    const [lon, lat] = toWGS(375112.041, 164778.366);
    expect(Math.abs(lon - -2.359)).toBeLessThan(1e-7);
    expect(Math.abs(lat - 51.3815)).toBeLessThan(1e-7);
  });
  it('parses grid refs', () => {
    expect(parseGridRef('ST 75000 64700')).toEqual([375000.5, 164700.5]);
    expect(parseGridRef('TQ3080')).toEqual([530500, 180500]);
    expect(parseGridRef('hello')).toBeNull();
  });
});

const box = { minE: 0, minN: 0, maxE: 10, maxN: 10 };

describe('clipping', () => {
  it('clips concave polygons without zero-width slivers', () => {
    // A "C" shape whose arms cross the left edge; Sutherland-Hodgman would leave a sliver along x = 0.
    const c: [number, number][] = [[-5, 0], [8, 0], [8, 10], [-5, 10], [-5, 7], [5, 7], [5, 3], [-5, 3]];
    const parts = clipPolygonToBox([c], box);
    const area = parts.reduce((a, p) => a + Math.abs(signedArea(p[0])), 0);
    expect(area).toBeCloseTo(8 * 10 - 5 * 4);
    for (const p of parts) {
      const m = buildingsMesh([{ id: 'c', tags: {}, ground: 0, top: 3, source: 'lidar', rings: p }], [0, 0], 0);
      expect(isWatertight(m)).toBe(true);
    }
  });
  it('clips rings to the bbox', () => {
    const r = clipRing([[-5, -5], [5, -5], [5, 5], [-5, 5]], box);
    expect(Math.abs(signedArea(r))).toBeCloseTo(25);
  });
  it('splits polylines that leave and re-enter', () => {
    const parts = clipPolyline([[-1, 5], [5, 5], [5, 15], [8, 15], [8, 5]], box);
    expect(parts).toHaveLength(2);
    expect(parts[0][0]).toEqual([0, 5]);
  });
});

function raster(w: number, h: number, f: (x: number, y: number) => number): Raster {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f(i, j);
  return { width: w, height: h, minE: 1000, maxN: 2000 + h, res: 1, data };
}

/** Closed 2-manifold with consistent orientation: every directed edge appears once, its reverse once. */
function isWatertight(m: Mesh): boolean {
  const key = (a: number, b: number) => `${a},${b}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const k = key(m.indices[t + c], m.indices[t + ((c + 1) % 3)]);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [a, b] = k.split(',');
    if (n !== 1 || edges.get(key(+b, +a)) !== 1) return false;
  }
  return true;
}

function volume(m: Mesh): number {
  let v = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

describe('meshes', () => {
  const r = raster(21, 15, (x, y) => 10 + x * 0.5 + Math.sin(y));
  it('terrain solid is watertight with outward normals', () => {
    for (const step of [1, 2, 4]) {
      const m = terrainMesh(r, [1000, 2000], { step, baseZ: 0 });
      expect(isWatertight(m)).toBe(true);
      expect(volume(m)).toBeGreaterThan(0);
    }
  });
  it('terrain surface faces up', () => {
    const m = terrainMesh(r, [1000, 2000], { step: 1 });
    const p = m.positions, [a, b, c] = [m.indices[0] * 3, m.indices[1] * 3, m.indices[2] * 3];
    const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    expect(nz).toBeGreaterThan(0);
  });
  it('buildings (incl. courtyards, either winding) are watertight with correct volume', () => {
    const b: Building = {
      id: 'way/1', tags: {}, ground: 10, top: 20, source: 'lidar',
      rings: [[[0, 0], [0, 10], [10, 10], [10, 0]], [[3, 3], [7, 3], [7, 7], [3, 7]]],
    };
    const m = buildingsMesh([b], [0, 0], 0);
    expect(isWatertight(m)).toBe(true);
    expect(volume(m)).toBeCloseTo((100 - 16) * 10, 3);
  });
});

describe('buildings', () => {
  it('takes height from DSM - DTM and falls back to OSM levels', () => {
    const dtm = raster(40, 40, () => 50);
    const dsm = raster(40, 40, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? 62 : 50));
    const sq = (x0: number, y0: number, s: number) =>
      [[[1000 + x0, 2040 - y0], [1000 + x0 + s, 2040 - y0], [1000 + x0 + s, 2040 - y0 - s], [1000 + x0, 2040 - y0 - s]]] as [number, number][][];
    const [lidar, tagged] = buildingHeights(
      [{ id: 'a', rings: sq(10, 10, 10), tags: {} }, { id: 'b', rings: sq(25, 25, 8), tags: { 'building:levels': '3' } }],
      dtm, dsm,
    );
    expect(lidar.source).toBe('lidar');
    expect(lidar.top - lidar.ground).toBeCloseTo(12);
    expect(tagged.source).toBe('osm-levels');
    expect(tagged.top - tagged.ground).toBeCloseTo(10);
  });
});

describe('rasters & contours', () => {
  it('fills holes', () => {
    const r = raster(10, 10, (x) => x);
    r.data[55] = NaN; r.data[56] = NaN;
    expect(fillNoData(r)).toBe(2);
    expect(r.data[55]).toBeCloseTo(5, 0);
  });
  it('contours of a plane are straight lines at the right place', () => {
    const r = raster(20, 10, (x) => x); // value x at cell centre E = 1000 + x + 0.5
    const lines = contourLines(r, 5, 2);
    expect(lines.map((l) => l.level)).toEqual([5, 10, 15]);
    for (const l of lines) {
      expect(l.closed).toBe(false);
      for (const [e] of l.coords) expect(e).toBeCloseTo(1000 + l.level + 0.5);
    }
    expect(lines.find((l) => l.level === 10)!.major).toBe(true);
  });
  it('contours of a hill are closed rings', () => {
    const r = raster(41, 41, (x, y) => 100 - Math.hypot(x - 20, y - 20));
    const ring = contourLines(r, 10, 5).find((l) => l.level === 90)!;
    expect(ring.closed).toBe(true);
    const radius = ring.coords.map(([e, n]) => Math.hypot(e - 1020.5, n - (2041 - 20.5)));
    radius.forEach((d) => expect(d).toBeCloseTo(10, 0));
  });
  it('bands use the same coordinates as lines', () => {
    const r = raster(20, 10, (x) => x);
    const [band] = contourBands(r, [10]);
    const minE = Math.min(...band.polygons[0][0].map((p) => p[0]));
    expect(minE).toBeCloseTo(1010.5);
  });
});

describe('exporters', () => {
  it('writes binary STL with the right size', () => {
    const m = terrainMesh(raster(5, 5, () => 1), [1000, 2000], { step: 1, baseZ: 0 });
    const buf = writeStl([m], { scale: 1, zExaggeration: 1, zOffset: 0 });
    expect(buf.byteLength).toBe(84 + (m.indices.length / 3) * 50);
    expect(new DataView(buf).getUint32(80, true)).toBe(m.indices.length / 3);
  });
  it('writes R12 DXF with layers and elevations', () => {
    const dxf = writeDxf(
      [{ name: 'CONTOUR-MAJOR', label: '', stroke: '#000', aci: 32, weight: 0.3, items: [{ t: 'line', pts: [[0, 0], [1, 1]], z: 25 }] }],
      box, { origin: [0, 0], scale: 500 },
    );
    expect(dxf).toContain('AC1009');
    expect(dxf).toMatch(/LAYER\r\n2\r\nCONTOUR-MAJOR/);
    expect(dxf).toMatch(/POLYLINE\r\n8\r\nCONTOUR-MAJOR\r\n66\r\n1\r\n10\r\n0\r\n20\r\n0\r\n30\r\n25/);
    expect(dxf.trim().endsWith('EOF')).toBe(true);
  });
});

import { parseOsm } from '../src/data/osm';

describe('OSM parsing', () => {
  it('classifies buildings, bridges, roads and trees from Overpass JSON', () => {
    const n = (id: number, lon: number, lat: number, tags?: Record<string, string>) => ({ type: 'node', id, lon, lat, tags });
    const raw = {
      elements: [
        n(1, -2.3595, 51.3810), n(2, -2.3590, 51.3810), n(3, -2.3590, 51.3814), n(4, -2.3595, 51.3814),
        n(5, -2.3600, 51.3812), n(6, -2.3580, 51.3812),
        n(7, -2.3592, 51.3816, { natural: 'tree' }),
        { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', 'building:levels': '4' } },
        { type: 'way', id: 11, nodes: [5, 6], tags: { highway: 'primary', bridge: 'yes', name: 'Test St' } },
      ],
    };
    const [e, nn] = toBNG(-2.359, 51.3812);
    const r = parseOsm(raw, { minE: e - 300, minN: nn - 300, maxE: e + 300, maxN: nn + 300 });
    expect(r.buildings).toHaveLength(1);
    expect(r.buildings[0].tags['building:levels']).toBe('4');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ kind: 'road-major', bridge: true, name: 'Test St' });
    expect(r.trees).toHaveLength(1);
  });
});

import { estimateOffset } from '../src/process/align';
import { shiftAndClip } from '../src/data/osm';

describe('OSM to LIDAR alignment', () => {
  it('recovers a known footprint offset from DSM roofs', () => {
    const W = 120;
    const blocks: [number, number, number, number][] = [[10, 10, 30, 25], [50, 12, 70, 40], [20, 50, 45, 70], [70, 60, 100, 90], [15, 85, 40, 110]];
    const dtm = raster(W, W, () => 20);
    // Roofs in grid cells (i = E offset, j = rows from north).
    const dsm = raster(W, W, (x, y) => (blocks.some(([a, b, c, d]) => x >= a && x < c && y >= b && y < d) ? 30 : 20));
    const toRing = ([a, b, c, d]: number[], dx: number, dy: number): [number, number][] => {
      const e0 = 1000 + a + dx, e1 = 1000 + c + dx, n0 = 2000 + W - d + dy, n1 = 2000 + W - b + dy;
      return [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];
    };
    // OSM footprints drawn 1.5 m west and 1 m south of the true roofs.
    const footprints = blocks.map((b) => [toRing(b, -1.5, -1)]);
    const { offset } = estimateOffset(footprints, dtm, dsm);
    expect(offset[0]).toBeCloseTo(1.5, 1);
    expect(offset[1]).toBeCloseTo(1, 1);
  });

  it('turns courtyards cut by the site edge into notches, keeping blocks watertight', () => {
    const outer: [number, number][] = [[0, -5], [20, -5], [20, 10], [0, 10]];
    const hole: [number, number][] = [[5, -2], [15, -2], [15, 5], [5, 5]];
    const r = shiftAndClip({ buildings: [{ id: 'r/1', rings: [outer, hole], tags: {} }], lines: [], areas: [], trees: [], points: [] }, [0, 0], { minE: -10, minN: 0, maxE: 30, maxN: 30 });
    expect(r.buildings[0].rings).toHaveLength(1);
    expect(Math.abs(signedArea(r.buildings[0].rings[0]))).toBeCloseTo(20 * 10 - 10 * 5);
    const m = buildingsMesh([{ ...r.buildings[0], ground: 0, top: 5, source: 'lidar' }], [0, 0], 0);
    expect(isWatertight(m)).toBe(true);
  });
});
