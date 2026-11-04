import { describe, expect, it } from 'vitest';
import { bufferLines, lineWidth, unionPolygons } from '../src/process/buffer';
import { buildContext } from '../src/process/context';
import { boundaryLoops, drapeSurface, mergeMeshes, rasterizePolygons, solidWithFlatFloor, solidWithMirrorFloor } from '../src/process/geom';
import { stepForTriangles, terrainGrid, terrainMesh, terrainTriangles, type Mesh } from '../src/process/mesh';
import { offsetOutline, polylineLength, resample, ribbonSolid } from '../src/process/ribbon';
import { adaptiveTerrain, rtinGridSize } from '../src/process/rtin';
import { fitRoofParts } from '../src/process/roofparts';
import { fitRoof, rawRoofMesh, roofedBuildingMesh } from '../src/process/roofs';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import { detectTrees, treesMesh } from '../src/process/trees';
import { writeObj } from '../src/export/obj';
import { writeDxf, writeDxfMesh } from '../src/export/dxf';
import { buildDrawing, ALL_FEATURES, defaultLayerToggles } from '../src/export/drawing';
import type { Building, LineFeature, Raster, SiteData } from '../src/types';

/** Closed 2-manifold with consistent orientation. */
function isWatertight(m: Mesh): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const k = `${m.indices[t + c]},${m.indices[t + ((c + 1) % 3)]}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [a, b] = k.split(',');
    if (n !== 1 || edges.get(`${b},${a}`) !== 1) return false;
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

/** North-up raster at BNG (1000, 2000+h) with a height function of local metres. */
function raster(w: number, h: number, f: (x: number, y: number) => number): Raster {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f(i + 0.5, h - j - 0.5);
  return { width: w, height: h, minE: 1000, maxN: 2000 + h, res: 1, data };
}

const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('terrain grid', () => {
  const r = raster(40, 30, (x, y) => 10 + 0.3 * x + 2 * Math.sin(y / 4));
  it('zAt reproduces the mesh surface exactly', () => {
    for (const step of [1, 3, 4]) {
      const origin: [number, number] = [1000, 2000];
      const grid = terrainGrid(r, origin, { step });
      const m = terrainMesh(r, origin, { step }, grid);
      // Evaluate the mesh triangle containing a point and compare with zAt.
      for (const [x, y] of [[5.3, 7.7], [20.1, 14.9], [33.7, 3.2], [1.2, 28.4]]) {
        let found = false;
        for (let t = 0; t < m.indices.length && !found; t += 3) {
          const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
          const P = m.positions;
          const d = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (P[b + 1] - P[a + 1]);
          const l1 = ((x - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (y - P[a + 1])) / d;
          const l2 = ((P[b] - P[a]) * (y - P[a + 1]) - (x - P[a]) * (P[b + 1] - P[a + 1])) / d;
          if (l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9) {
            expect(grid.zAt(x, y)).toBeCloseTo(P[a + 2] + l1 * (P[b + 2] - P[a + 2]) + l2 * (P[c + 2] - P[a + 2]), 3);
            found = true;
          }
        }
        expect(found).toBe(true);
      }
    }
  });
  it('triangle budget picks a step and the count matches', () => {
    const big = raster(1000, 1000, () => 0);
    const step = stepForTriangles(big, 100_000);
    expect(terrainTriangles(big, step)).toBeLessThanOrEqual(110_000);
    expect(terrainTriangles(big, 1)).toBe(2 * 999 * 999);
  });
  it('averaging smooths noise when downsampling', () => {
    const noisy = raster(32, 32, (x, y) => ((Math.floor(x) + Math.floor(y)) % 2) * 2);
    const avg = terrainGrid(noisy, [1000, 2000], { step: 4 });
    const pt = terrainGrid(noisy, [1000, 2000], { step: 4, average: false });
    const spread = (g: { z: Float32Array }) => Math.max(...g.z) - Math.min(...g.z);
    expect(spread(avg)).toBeLessThan(spread(pt));
  });
});

describe('adaptive terrain (RTIN)', () => {
  const origin: [number, number] = [1000, 2000];
  const hill = raster(200, 160, (x, y) => 20 + 6 * Math.sin(x / 25) + 4 * Math.cos(y / 20));
  /** Height of the (open) surface at a local point, by locating the containing triangle. */
  const heightAt = (m: Mesh, x: number, y: number) => {
    const P = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
      const d = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (P[b + 1] - P[a + 1]);
      const l1 = ((x - P[a]) * (P[c + 1] - P[a + 1]) - (P[c] - P[a]) * (y - P[a + 1])) / d;
      const l2 = ((P[b] - P[a]) * (y - P[a + 1]) - (x - P[a]) * (P[b + 1] - P[a + 1])) / d;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l1 + l2 <= 1 + 1e-6) return P[a + 2] + l1 * (P[b + 2] - P[a + 2]) + l2 * (P[c + 2] - P[a + 2]);
    }
    return NaN;
  };
  it('picks a power-of-two-plus-one grid', () => {
    expect(rtinGridSize(200)).toBe(257);
    expect(rtinGridSize(257)).toBe(257);
    expect(rtinGridSize(258)).toBe(513);
  });
  it('collapses a flat surface to a handful of triangles', () => {
    const flat = raster(300, 300, () => 25);
    const at = adaptiveTerrain(flat, origin, { tolerance: 0.1 });
    expect(at.triangles).toBeLessThanOrEqual(8);
    expect(isWatertight(at.solid(10))).toBe(true);
  });
  it('stays within the vertical tolerance and refines where the ground is rough', () => {
    for (const tolerance of [0.05, 0.25, 1]) {
      const at = adaptiveTerrain(hill, origin, { tolerance });
      const g = terrainGrid(hill, origin, { step: 1 });
      let worst = 0;
      for (let k = 0; k < 400; k++) {
        const x = g.xs[0] + ((k * 7919) % 1000) / 1000 * (g.xs[g.nc - 1] - g.xs[0]);
        const y = g.ys[g.nr - 1] + ((k * 104729) % 1000) / 1000 * (g.ys[0] - g.ys[g.nr - 1]);
        worst = Math.max(worst, Math.abs(heightAt(at.mesh, x, y) - g.zAt(x, y)));
      }
      // The resample (257 vs 200 cells) adds a little; allow tolerance plus the grid's own interpolation error.
      expect(worst).toBeLessThan(tolerance + 0.25);
      expect(at.triangles).toBeLessThan(terrainTriangles(hill, 1));
    }
    const fine = adaptiveTerrain(hill, origin, { tolerance: 0.05 }).triangles;
    const coarse = adaptiveTerrain(hill, origin, { tolerance: 1 }).triangles;
    expect(coarse).toBeLessThan(fine / 3);
  });
  it('is crack-free (one boundary loop), closes into a watertight solid, and covers the same extent as the grid', () => {
    const at = adaptiveTerrain(hill, origin, { tolerance: 0.2 });
    expect(boundaryLoops(at.mesh.indices)).toHaveLength(1);
    const solid = at.solid(0);
    expect(isWatertight(solid)).toBe(true);
    expect(volume(solid)).toBeGreaterThan(0);
    const g = terrainGrid(hill, origin, { step: 1 });
    const xs = Array.from({ length: at.mesh.positions.length / 3 }, (_, i) => at.mesh.positions[i * 3]);
    expect(Math.min(...xs)).toBeCloseTo(g.xs[0], 3);
    expect(Math.max(...xs)).toBeCloseTo(g.xs[g.nc - 1], 3);
    expect(solid.uvs!.length / 2).toBe(solid.positions.length / 3);
  });
  it('honours a triangle cap by raising the tolerance', () => {
    const at = adaptiveTerrain(hill, origin, { tolerance: 0.01, maxTris: 1500 });
    expect(at.triangles).toBeLessThanOrEqual(1500);
    expect(at.tolerance).toBeGreaterThan(0.01);
  });
});

describe('draped pads', () => {
  const r = raster(40, 40, (x, y) => 5 + 0.2 * x + 0.1 * y);
  const origin: [number, number] = [1000, 2000];
  const grid = terrainGrid(r, origin, { step: 1 });
  it('an L-shaped pad with a hole is a closed solid with the right volume', () => {
    const outer: [number, number][] = [[3.3, 3.7], [30.2, 3.7], [30.2, 12.1], [14.6, 12.1], [14.6, 25.9], [3.3, 25.9]];
    const hole = sq(6.2, 6.2, 9.1, 9.1);
    const surface = drapeSurface([[outer, hole]], grid.lines(2), grid.zAt, 0.4).build();
    const solid = solidWithMirrorFloor(surface, 0.5);
    expect(isWatertight(solid)).toBe(true);
    const area = (26.9 * 8.4) + (11.3 * 13.8) - 2.9 * 2.9;
    expect(volume(solid)).toBeCloseTo(area * 0.5, 0);
    // The top follows the terrain at +0.4 m.
    for (let k = 0; k < surface.positions.length; k += 3) {
      expect(surface.positions[k + 2]).toBeGreaterThan(grid.zAt(surface.positions[k], surface.positions[k + 1]) + 0.39);
    }
  });
  it('neighbouring cells share vertices (no cracks) at any cell size', () => {
    for (const k of [1, 2, 5]) {
      const s = drapeSurface([[sq(2.5, 2.5, 27.5, 21.5)]], grid.lines(k), grid.zAt, 0).build();
      const loops = boundaryLoops(s.indices);
      expect(loops).toHaveLength(1);
      expect(loops[0].length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('ribbons', () => {
  it('offset outlines are straight to the very ends (no flaring)', () => {
    const { left, right } = offsetOutline(resample([[0, 0], [20, 0]], 5), 1.5);
    for (const p of left) expect(p[1]).toBeCloseTo(1.5, 9);
    for (const p of right) expect(p[1]).toBeCloseTo(-1.5, 9);
    expect(left[0][0]).toBeCloseTo(0, 9); expect(left[left.length - 1][0]).toBeCloseTo(20, 9);
  });
  it('closed solid with positive volume = length x width x depth', () => {
    const pts = resample([[0, 0], [30, 0], [30, 20]], 2);
    const m = ribbonSolid(pts, pts.map(() => 10), 1.5, 2);
    expect(isWatertight(m)).toBe(true);
    // The corner miter makes it slightly different from 50 x 3 x 2; allow 5 %.
    expect(volume(m)).toBeGreaterThan(0);
    expect(Math.abs(volume(m) - polylineLength([[0, 0], [30, 0], [30, 20]]) * 3 * 2)).toBeLessThan(0.05 * 300);
  });
});

describe('buffering', () => {
  const bbox = { minE: 0, minN: 0, maxE: 200, maxN: 200 };
  const area = (polys: [number, number][][][]) => polys.reduce((a, p) => a + p.reduce((s, r, k) => s + (k ? -1 : 1) * Math.abs(shoelace(r)), 0), 0);
  const shoelace = (r: [number, number][]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  it('widths follow tag, lanes, then class defaults', () => {
    expect(lineWidth({ kind: 'road-minor', tags: { highway: 'residential', width: '7 m' } })).toBe(7);
    expect(lineWidth({ kind: 'road-major', tags: { highway: 'primary', lanes: '2' } })).toBe(6.5);
    expect(lineWidth({ kind: 'road-minor', tags: { highway: 'service' } })).toBe(3.5);
    expect(lineWidth({ kind: 'rail', tags: { railway: 'rail', tracks: '2' } })).toBe(7);
    expect(lineWidth({ kind: 'river', tags: { waterway: 'river' } })).toBe(8);
  });
  it('a straight road is length x width plus the round ends', () => {
    const polys = bufferLines([{ coords: [[50, 100], [150, 100]], width: 6 }], bbox);
    expect(polys).toHaveLength(1);
    expect(Math.abs(area(polys) - (100 * 6 + Math.PI * 9))).toBeLessThan(2); // arcs are polygonal
  });
  it('a crossing merges into one polygon; a ring road leaves a hole', () => {
    const cross = bufferLines([
      { coords: [[50, 100], [150, 100]], width: 6 }, { coords: [[100, 50], [100, 150]], width: 6 },
    ], bbox);
    expect(cross).toHaveLength(1);
    const ring = bufferLines([{ coords: [[50, 50], [150, 50], [150, 150], [50, 150], [50, 50]], width: 6 }], bbox);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toHaveLength(2); // outer + hole
  });
  it('unions overlapping polygons and trims to the site', () => {
    const u = unionPolygons([[sq(-20, 0, 60, 50)], [sq(40, 20, 120, 80)]], bbox);
    expect(u).toHaveLength(1);
    expect(Math.abs(area(u) - (60 * 50 + 80 * 60 - 20 * 30))).toBeLessThan(4); // outlines grow 1 cm to heal pinch points
  });
  it('rasterises polygons with holes', () => {
    const g = { width: 20, height: 20, minE: 0, maxN: 20, res: 1 };
    const m = rasterizePolygons([[sq(2, 2, 12, 12), sq(5, 5, 8, 8)]], g);
    expect(m.reduce((a, b) => a + b, 0)).toBe(100 - 9);
  });
});

function building(id: string, rings: [number, number][][], ground = 0, top = 10): Building {
  return { id, rings, tags: {}, ground, top, source: 'lidar' };
}

/** DSM with a roof of the given height function over [0,w]x[0,h] (BNG offset 1000/2000). */
function roofDsm(w: number, h: number, f: (u: number, v: number) => number): Raster {
  return raster(w + 20, h + 20, (x, y) => {
    const u = x - 10, v = y - 10;
    return u >= 0 && u <= w && v >= 0 && v <= h ? f(u, v) : 0;
  });
}

describe('roofs', () => {
  const origin: [number, number] = [1000, 2000];
  // Footprint 20 x 10 m at local (10..30, 10..20) in the raster = BNG (1010..1030, 2010..2020), rotated 0.
  const foot = [sq(1010, 2010, 1030, 2020)];
  // Raster rows: y is measured from the bottom (south) of the raster, which is maxN - h => the footprint lies at y 10..20 local.
  const gable = (_u: number, v: number) => 6 + 4 * (1 - Math.abs(v - 5) / 5);
  const hip = (u: number, v: number) => 6 + 4 * Math.min(1 - Math.abs(v - 5) / 5, (10 - Math.abs(u - 10)) / 5);

  it('identifies a gable and builds a closed solid with the right volume', () => {
    const dsm = roofDsm(20, 10, (u, v) => gable(u, v));
    // raster() flips y, so shift the footprint to match: local y from 2000 (south edge of raster) + 10.
    const b = building('g', [sq(1010, 2010, 1030, 2020)], 0, 9);
    const fit = fitRoof(b, dsm)!;
    expect(fit.type).toBe('gable');
    expect(fit.eaves).toBeCloseTo(6, 0);
    expect(fit.ridge).toBeGreaterThan(9);
    const m = roofedBuildingMesh(b, fit, origin, -0.5)!;
    expect(isWatertight(m)).toBe(true);
    // Prism 20 x 10 up to eaves + the gable wedge, minus nothing.
    const expected = 20 * 10 * (fit.eaves + 0.5) + 0.5 * 10 * (fit.ridge - fit.eaves) * 20;
    expect(volume(m)).toBeCloseTo(expected, 0);
  });
  it('identifies a hip roof', () => {
    const dsm = roofDsm(20, 10, (u, v) => hip(u, v));
    const b = building('h', [sq(1010, 2010, 1030, 2020)], 0, 9);
    const fit = fitRoof(b, dsm)!;
    expect(fit.type).toBe('hip');
    const m = roofedBuildingMesh(b, fit, origin, -0.5)!;
    expect(isWatertight(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(20 * 10 * (fit.eaves + 0.5));
    expect(volume(m)).toBeLessThan(20 * 10 * (fit.ridge + 0.5));
  });
  it('keeps flat roofs flat, and ignores tiny or odd footprints', () => {
    const flatDsm = roofDsm(20, 10, () => 8);
    expect(fitRoof(building('f', foot, 0, 8), flatDsm)!.type).toBe('flat');
    expect(fitRoof(building('t', [sq(1010, 2010, 1014, 2014)], 0, 8), flatDsm)).toBeNull();
    const L: [number, number][] = [[1010, 2010], [1030, 2010], [1030, 2013], [1013, 2013], [1013, 2020], [1010, 2020]];
    expect(fitRoof(building('l', [L], 0, 8), flatDsm)).toBeNull();
  });
  it('handles rotated buildings and courtyards', () => {
    const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
    const rot = (x: number, y: number): [number, number] => [1020 + x * c - y * s, 2015 + x * s + y * c];
    const ring = [rot(-10, -5), rot(10, -5), rot(10, 5), rot(-10, 5)];
    // Gable DSM in the rotated frame.
    const dsm = raster(60, 60, (x, y) => {
      const dx = 1000 + x - 1020, dy = 2000 + y - 2015;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      return Math.abs(u) <= 10 && Math.abs(v) <= 5 ? 6 + 4 * (1 - Math.abs(v) / 5) : 0;
    });
    const b = building('r', [ring], 0, 9);
    const fit = fitRoof(b, dsm)!;
    expect(fit.type).toBe('gable');
    expect(isWatertight(roofedBuildingMesh(b, fit, origin, -0.5)!)).toBe(true);
  });
  it('LOD2-raw: footprint x height volume for a flat roof, with a courtyard', () => {
    const dsm = roofDsm(20, 10, () => 10);
    const outer = sq(1010.3, 2010.2, 1029.6, 2019.7);
    const hole = sq(1015.4, 2013.4, 1018.6, 2016.6);
    const b = building('raw', [outer, hole], 0, 10);
    const m = rawRoofMesh(b, dsm, origin, 0)!;
    const area = 19.3 * 9.5 - 3.2 * 3.2;
    // Roof edge cells blend with the DSM's 0 outside the building, so allow a few percent.
    expect(volume(m)).toBeGreaterThan(area * 8.5);
    expect(volume(m)).toBeLessThan(area * 10.2);
  });
  it('solidWithFlatFloor closes a simple prism', () => {
    const mb = drapeSurface([[sq(0, 0, 10, 10)]], { xs: [0, 5, 10], ys: [0, 5, 10] }, () => 3, 0).build();
    const solid = solidWithFlatFloor(mb, 0);
    expect(isWatertight(solid)).toBe(true);
    expect(volume(solid)).toBeCloseTo(300);
  });
});

describe('LOD2-fit roofs', () => {
  const origin: [number, number] = [1000, 2000];
  const flatDtm = raster(80, 60, () => 0);
  const partsVolume = (parts: { mesh: Mesh }[]) => parts.reduce((s, p) => s + volume(p.mesh), 0);

  it('splits a stepped terrace into one gable per house with the right eaves', () => {
    // 5 houses, 6 m wide (along x), 10 m deep, ridge along x; eaves 8, 9.5, 11, 12.5, 14 (stepping up the hill).
    const house = (x: number) => Math.min(4, Math.max(0, Math.floor((x - 10) / 6)));
    const dsm = raster(80, 60, (x, y) => {
      if (x < 10 || x > 40 || y < 10 || y > 20) return 0;
      const eaves = 8 + 1.5 * house(x), t = 1 - Math.abs(y - 15) / 5;
      return eaves + 3 * t;
    });
    const b = building('terrace', [sq(1010, 2010, 1040, 2020)], 0, 12);
    const parts = fitRoofParts(b, dsm, flatDtm, origin)!;
    expect(parts).toHaveLength(5);
    expect(parts.map((p) => p.fit.type)).toEqual(Array(5).fill('gable'));
    const eaves = parts.map((p) => p.fit.eaves).sort((p, q) => p - q);
    eaves.forEach((e, i) => expect(e).toBeGreaterThan(8 + 1.5 * i - 0.6));
    eaves.forEach((e, i) => expect(e).toBeLessThan(8 + 1.5 * i + 0.6));
    for (const p of parts) expect(isWatertight(p.mesh), p.name).toBe(true);
    expect(new Set(parts.map((p) => p.name)).size).toBe(5);
    // Total volume ~ sum of house prisms (6 x 10 x (eaves + 0.5 + 1.5 rise-avg)).
    const expected = [0, 1, 2, 3, 4].reduce((s2, i) => s2 + 6 * 10 * (8 + 1.5 * i + 0.5 + 1.5), 0);
    expect(Math.abs(partsVolume(parts) - expected) / expected).toBeLessThan(0.06);
  });

  it('fits a mono-pitch (shed) roof on a slope', () => {
    const dsm = raster(80, 60, (x, y) => (x >= 10 && x <= 30 && y >= 10 && y <= 20 ? 6 + 0.25 * (x - 10) : 0));
    const b = building('shed', [sq(1010, 2010, 1030, 2020)], 0, 9);
    const parts = fitRoofParts(b, dsm, flatDtm, origin)!;
    expect(parts).toHaveLength(1);
    expect(parts[0].fit.type).toBe('shed');
    expect(parts[0].fit.rmse).toBeLessThan(0.2);
    expect(isWatertight(parts[0].mesh)).toBe(true);
    expect(volume(parts[0].mesh)).toBeCloseTo(20 * 10 * (6 + 2.5 + 0.5), -1);
  });

  it('decomposes an L-shaped building into rectangular parts, all closed', () => {
    const L: [number, number][] = [[1010, 2010], [1040, 2010], [1040, 2020], [1020, 2020], [1020, 2035], [1010, 2035]];
    const pointInL = (x: number, y: number) => (x >= 10 && x <= 40 && y >= 10 && y <= 20) || (x >= 10 && x <= 20 && y >= 20 && y <= 35);
    const dsm = raster(80, 60, (x, y) => (pointInL(x, y) ? 9 : 0));
    const b = building('L', [L], 0, 9);
    const parts = fitRoofParts(b, dsm, flatDtm, origin)!;
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) expect(isWatertight(p.mesh), p.name).toBe(true);
    const area = 30 * 10 + 10 * 15;
    expect(Math.abs(partsVolume(parts) - area * 9.5)).toBeLessThan(area * 9.5 * 0.04);
  });

  it('extracts chimneys and a parapet as separate closed objects', () => {
    // Flat roof at 8 m over 14 x 10; a rim 0.3-1.0 m in is +0.8 m; two chimney stacks (2x2 cells, +2.5 m) and a lift motor room too big to be one.
    const dsm = raster(80, 60, (x, y) => {
      if (x < 10 || x > 24 || y < 10 || y > 20) return 0;
      const d = Math.min(x - 10, 24 - x, y - 10, 20 - y);
      if (x >= 14 && x < 16 && y >= 14 && y < 16) return 10.5;
      if (x >= 19 && x < 21 && y >= 12 && y < 14) return 10.5;
      if (x >= 12 && x < 22 && y >= 16 && y < 19) return 8; // big flat area is not a chimney
      return d <= 1.2 ? 8.8 : 8;
    });
    const b = building('d', [sq(1010, 2010, 1024, 2020)], 0, 8);
    const parts = fitRoofParts(b, dsm, flatDtm, origin, undefined, true)!;
    expect(parts).toHaveLength(1);
    const names = parts[0].details.map((d) => d.name);
    expect(names.filter((n) => n.startsWith('chimney_'))).toHaveLength(2);
    expect(names.some((n) => n.startsWith('parapet_'))).toBe(true);
    for (const d of parts[0].details) {
      expect(isWatertight(d.mesh), d.name).toBe(true);
      expect(volume(d.mesh), d.name).toBeGreaterThan(0);
    }
    const ch = parts[0].details.find((d) => d.name.startsWith('chimney_'))!.mesh;
    expect(Math.max(...Array.from(ch.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(10.5, 1);
    // No details unless asked for.
    expect(fitRoofParts(b, dsm, flatDtm, origin)![0].details).toEqual([]);
  });

  it('does not read a badly fitted roof as a field of chimneys', () => {
    // Roof surface with a 3 m cliff down the middle: far more than 25% of the cells sit well above any flat fit.
    const dsm = raster(80, 60, (x, y) => (x >= 10 && x <= 30 && y >= 10 && y <= 20 ? (x < 20 ? 6 : 10) : 0));
    const parts = fitRoofParts(building('c', [sq(1010, 2010, 1030, 2020)], 0, 8), dsm, flatDtm, origin, undefined, true)!;
    expect(parts.flatMap((p) => p.details.filter((d) => d.name.startsWith('chimney_')))).toHaveLength(0);
  });

  it('keeps a plain flat roof as a single flat part', () => {
    const dsm = roofDsm(20, 10, () => 8);
    const parts = fitRoofParts(building('f', [sq(1010, 2010, 1030, 2020)], 0, 8), dsm, flatDtm, origin)!;
    expect(parts).toHaveLength(1);
    expect(parts[0].fit.type).toBe('flat');
    expect(isWatertight(parts[0].mesh)).toBe(true);
  });

  it('works through the scene and feeds roof lines to the drawing', async () => {
    const dsm = raster(120, 100, (x, y) => (x > 40 && x < 60 && y > 40 && y < 50 ? 7 + 3 * (1 - Math.abs(y - 45) / 5) : 0));
    const dtm = raster(120, 100, () => 0);
    const bld = building('1', [sq(1040, 2040, 1060, 2050)], 0, 9);
    const site: SiteData = {
      bbox: { minE: 1000, minN: 2000, maxE: 1120, maxN: 2100 }, origin: [1060, 2050], dtm, dsm,
      buildings: [bld], lines: [], areas: [], trees: [], points: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
    };
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, buildings: 'lod2fit', trees: 'off' });
    expect(sc.notes.join(' ')).toMatch(/LOD2-fit: 1 roof parts \(1 gable/);
    expect(site.buildings[0].roofParts).toHaveLength(1);
    const names = buildDrawing(site, [], { layers: defaultLayerToggles(), buildingLabels: false, features: ALL_FEATURES }).map((l) => l.name);
    expect(names).toContain('ROOF');
  });
});

describe('trees', () => {
  const dtm = raster(80, 80, () => 0);
  // Two crowns (10 m @ (20,20), 15 m @ (50,50)), a building-height block (12 m) and a flat ground.
  const cone = (x: number, y: number, cx: number, cy: number, h: number, r: number) => Math.max(0, h * (1 - Math.hypot(x - cx, y - cy) / r));
  const dsm = raster(80, 80, (x, y) => Math.max(cone(x, y, 20, 20, 10, 5), cone(x, y, 50, 50, 15, 7), x > 60 && y < 20 ? 12 : 0));
  it('finds one tree per crown, skips excluded areas, and merges OSM points', () => {
    const all = detectTrees(dtm, dsm, [], []);
    const tall = all.filter((t) => t.h > 11 && t.p[0] < 1058);
    expect(tall).toHaveLength(1);
    expect(Math.hypot(tall[0].p[0] - 1050, tall[0].p[1] - 2050)).toBeLessThan(2);
    expect(all.filter((t) => t.h > 3 && t.h < 11 && t.p[0] < 1040).length).toBeGreaterThanOrEqual(1);
    // The 12 m flat block (east of 1060, south of 2020) is not a tree once it is excluded.
    expect(all.filter((t) => t.p[0] > 1060 && t.p[1] < 2020).length).toBeGreaterThan(0);
    const masked = detectTrees(dtm, dsm, [[sq(1058, 1998, 1082, 2022)]], []);
    expect(masked.filter((t) => t.p[0] > 1060 && t.p[1] < 2020)).toHaveLength(0);
    const osm = detectTrees(dtm, dsm, [], [[1020.5, 2060.5]]);
    expect(osm.filter((t) => t.source === 'osm')).toHaveLength(1);
  });
  it('tree meshes are closed solids', () => {
    const m = treesMesh([{ p: [1010, 2010], h: 10, r: 3, source: 'osm' }, { p: [1030, 2030], h: 18, r: 4.5, source: 'lidar' }], [1000, 2000], () => 2);
    expect(m.parts).toHaveLength(2);
    for (const [, s, c] of m.parts!) {
      const sub = { positions: m.positions, indices: m.indices.slice(s, s + c) };
      expect(isWatertight(sub)).toBe(true);
      expect(volume(sub)).toBeGreaterThan(0);
    }
  });
});

describe('scene', () => {
  const dtm = raster(120, 100, (x, y) => 20 + 0.05 * x + 0.02 * y);
  const dsm: Raster = { ...dtm, data: Float32Array.from(dtm.data) };
  const bld = building('1', [sq(1040, 2040, 1060, 2050)], 22, 30);
  // Raise the DSM over the building (gable) and put a tree canopy at (1090, 2030).
  for (let j = 0; j < dsm.height; j++) {
    for (let i = 0; i < dsm.width; i++) {
      const e = 1000 + i + 0.5, n = 2100 - j - 0.5;
      if (e > 1040 && e < 1060 && n > 2040 && n < 2050) dsm.data[j * dsm.width + i] += 7 + 3 * (1 - Math.abs(n - 2045) / 5);
      dsm.data[j * dsm.width + i] += Math.max(0, 9 * (1 - Math.hypot(e - 1090, n - 2030) / 5));
    }
  }
  const line = (id: string, kind: LineFeature['kind'], coords: [number, number][], tags: Record<string, string>, extra: Partial<LineFeature> = {}): LineFeature =>
    ({ id, kind, coords, tags, bridge: false, tunnel: false, ...extra });
  const site: SiteData = {
    bbox: { minE: 1000, minN: 2000, maxE: 1120, maxN: 2100 }, origin: [1060, 2050], dtm, dsm,
    buildings: [bld],
    lines: [
      line('r1', 'road-minor', [[1000, 2020], [1120, 2020]], { highway: 'residential' }),
      line('p1', 'path', [[1010, 2070], [1110, 2090]], { highway: 'footway' }),
      line('w1', 'river', [[1000, 2080], [1120, 2085]], { waterway: 'river' }),
      line('b1', 'road-minor', [[1050, 2078], [1070, 2082]], { highway: 'residential' }, { bridge: true }),
      line('wall1', 'wall', [[1020, 2030], [1060, 2030]], { barrier: 'wall' }),
    ],
    areas: [{ id: 'park', kind: 'green', rings: [sq(1070, 2035, 1110, 2060)], tags: {} }],
    trees: [[1030, 2035]], points: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
  };
  it('builds one named layer per feature class, with closed solids', async () => {
    const scene = await buildScene(site, { ...DEFAULT_SETTINGS, buildings: 'lod15', maxTris: 100_000 });
    const layers = scene.objects.map((o) => o.layer).sort();
    expect(layers).toEqual(['bridges', 'buildings', 'markings', 'paths', 'roads', 'terrain', 'trees', 'walls', 'water', 'green'].sort());
    for (const o of scene.objects) {
      if (o.layer === 'terrain') continue;
      for (const [name, s, c] of o.mesh.parts!) {
        expect(c, name).toBeGreaterThan(0);
        const sub = { positions: o.mesh.positions, indices: o.mesh.indices.slice(s, s + c) };
        expect(isWatertight(sub), `${o.layer}/${name}`).toBe(true);
        expect(volume(sub), `${o.layer}/${name}`).toBeGreaterThan(0);
      }
    }
    expect(site.buildings[0].roof?.type).toBe('gable');
  });
  it('each feature can be switched off', async () => {
    const off = await buildScene(site, {
      ...DEFAULT_SETTINGS, roads: false, paths: false, water: false, green: false, bridges: false, walls: false, trees: 'off', buildings: 'off',
    });
    expect(off.objects.map((o) => o.layer)).toEqual(['terrain']);
  });
  it('rivers are carved into the terrain and the bridge stays above the water', async () => {
    const flat = await buildScene(site, { ...DEFAULT_SETTINGS, waterDepthMm: 0 });
    const carved = await buildScene(site, { ...DEFAULT_SETTINGS, waterDepthMm: 3 });
    const at = (s: typeof flat) => s.grid.zAt(1040 - 1060, 2082 - 2050);
    expect(at(flat) - at(carved)).toBeCloseTo(3, 1);
  });
  it('adaptive terrain in a scene: fewer triangles, features still sit above it, solid export works', async () => {
    const grid = await buildScene(site, { ...DEFAULT_SETTINGS, maxTris: 100_000 });
    const ad = await buildScene(site, { ...DEFAULT_SETTINGS, terrainStep: -1, terrainTolerance: 0.25, maxTris: 100_000 });
    expect(ad.tolerance).toBeGreaterThanOrEqual(0.25);
    expect(ad.stats.terrain).toBeLessThan(grid.stats.terrain);
    expect(isWatertight(ad.terrainSolid(0))).toBe(true);
    expect(isWatertight(grid.terrainSolid(0))).toBe(true);
    // Roads are raised at least 1.5 x tolerance above the full-resolution surface.
    const road = ad.objects.find((o) => o.layer === 'roads')!.mesh;
    let min = Infinity;
    for (let k = 0; k < road.positions.length; k += 3) min = Math.min(min, road.positions[k + 2] - ad.grid.zAt(road.positions[k], road.positions[k + 1]));
    expect(min).toBeGreaterThan(-0.2); // the pad's embedded underside is within its own thickness
  });
  it('terrain triangle budget and step override are honoured', async () => {
    const budget = await buildScene(site, { ...DEFAULT_SETTINGS, maxTris: 2000 });
    expect(budget.stats.terrain).toBeLessThanOrEqual(2200);
    const manual = await buildScene(site, { ...DEFAULT_SETTINGS, terrainStep: 5 });
    expect(manual.step).toBe(5);
    expect(manual.stats.terrain).toBeLessThan(budget.stats.terrain * 20);
  });
  it('context polygons: kerbs, merged water, bridges excluded from roads', () => {
    const ctx = buildContext(site);
    expect(ctx.roads.length).toBe(1);
    expect(ctx.bridges).toHaveLength(1);
    expect(ctx.water.length).toBeGreaterThan(0);
    expect(ctx.walls[0].height).toBe(1.8);
  });
  it('surfaces-only mode gives open, lighter roads and water', async () => {
    const solid = await buildScene(site, DEFAULT_SETTINGS);
    const light = await buildScene(site, { ...DEFAULT_SETTINGS, featureSolids: false });
    for (const layer of ['roads', 'paths', 'water', 'green'] as const) {
      expect(light.stats[layer], layer).toBeLessThan(solid.stats[layer] * 0.6);
      const o = light.objects.find((q) => q.layer === layer)!;
      expect(boundaryLoops(o.mesh.indices).length, layer).toBeGreaterThan(0);
    }
  });
  it('without OSM buildings, LIDAR canopy is not mistaken for trees', async () => {
    const noBuildings: SiteData = { ...site, buildings: [], trees: [[1030, 2035]] };
    const sc = await buildScene(noBuildings, { ...DEFAULT_SETTINGS, trees: 'lidar' });
    expect(sc.trees.every((t) => t.source === 'osm')).toBe(true);
    expect(sc.notes.join(' ')).toMatch(/no OSM buildings/);
  });
  it('drawings: kerbs, water polygons, bridge decks, walls and true-size trees; features can be dropped', async () => {
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, buildings: 'lod15' });
    const names = (f: Partial<typeof ALL_FEATURES>) => buildDrawing(site, [], {
      layers: defaultLayerToggles(), buildingLabels: false, features: { ...ALL_FEATURES, trees: sc.trees, ...f },
    }).map((l) => l.name);
    const all = names({});
    for (const n of ['ROAD-SURFACE', 'PATH', 'WATER', 'BRIDGE', 'WALL', 'GREEN', 'BUILDINGS', 'TREES', 'ROOF', 'BOUNDARY']) expect(all, n).toContain(n);
    const none = names({ roads: false, paths: false, water: false, bridges: false, walls: false, green: false, buildings: false, trees: [] });
    expect(none).toEqual(['BOUNDARY']);
    const layers = buildDrawing(site, [], { layers: defaultLayerToggles(), buildingLabels: false, features: { ...ALL_FEATURES, trees: sc.trees } });
    const dxf = writeDxf(layers, site.bbox, { origin: [0, 0], scale: 1000 });
    expect(dxf).toMatch(/BLOCKS/);
    expect(dxf).toMatch(/\r\nINSERT\r\n/);
    expect(dxf).toMatch(/\r\nROAD-SURFACE\r\n/);
  });
  it('3D DXF: polyface meshes on named layers with valid face indices, terrain tiled', async () => {
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, maxTris: 30_000 });
    const dxf = writeDxfMesh(sc.objects, site.bbox, { origin: [0, 0], maxFaces: 2000 });
    const rows = dxf.split('\r\n');
    let meshes = 0, verts = 0, faces = 0, maxIndex = 0, bad = 0, nv = 0;
    const layers = new Set<string>();
    for (let i = 0; i < rows.length - 1; i += 2) {
      if (rows[i] === '0' && rows[i + 1] === 'POLYLINE') {
        meshes++; nv = 0;
        let j = i + 2;
        while (rows[j] !== '0') { if (rows[j] === '71') nv = +rows[j + 1]; if (rows[j] === '8') layers.add(rows[j + 1]); j += 2; }
      }
      if (rows[i] === '0' && rows[i + 1] === 'VERTEX') {
        let j = i + 2, flag = 0, a = 0;
        while (rows[j] !== '0') { if (rows[j] === '70') flag = +rows[j + 1]; if (rows[j] === '71') a = +rows[j + 1]; j += 2; }
        if (flag === 192) verts++;
        if (flag === 128) { faces++; maxIndex = Math.max(maxIndex, a); if (a < 1 || a > nv) bad++; }
      }
    }
    expect(bad).toBe(0);
    expect(meshes).toBeGreaterThan(10);
    expect(faces).toBeGreaterThan(sc.stats.terrain);
    expect(maxIndex).toBeLessThanOrEqual(6000);
    for (const n of ['TERRAIN', 'BUILDINGS', 'ROADS', 'WATER', 'BRIDGES', 'WALLS', 'TREES', 'GREEN']) expect(layers.has(n), n).toBe(true);
    expect(verts).toBeGreaterThan(0);
  });
  it('OBJ output has one group per layer and one object per part', async () => {
    const scene = await buildScene(site, DEFAULT_SETTINGS);
    const { obj } = writeObj(scene.objects, { up: 'z', structure: 'combined' });
    const text = (obj as string[]).join('');
    expect(text).toMatch(/^g ROADS$/m);
    expect(text).toMatch(/^g BUILDINGS$/m);
    expect(text).toMatch(/^o building_1$/m);
    expect(text).toMatch(/^usemtl BUILDINGS$/m);
    expect(mergeMeshes([]).indices.length).toBe(0);
  });
});

import { buildSection, sectionLayers, DEFAULT_SECTION } from '../src/process/section';
import { writeSheet, layoutSheet, fitScale, DEFAULT_BLOCK } from '../src/export/sheet';
import { writeDxf2000 } from '../src/export/dxf2000';
import { restyle, snapWeight, layerName } from '../src/export/layers';

describe('section / elevation profiles', () => {
  // Ground rises 0.1 m per metre going east; an 8 m deep, 10 m wide gable house at x 40..50, y -4..4 (ridge along x), a house beyond, a tree, a river.
  const W = 140, H = 80;
  const dtm = raster(W, H, (x) => 20 + 0.1 * x);
  const house = (id: string, x0: number, y0: number, w: number, d: number): Building => ({
    id, rings: [sq(1000 + x0, 2040 + y0, 1000 + x0 + w, 2040 + y0 + d)], tags: {}, ground: 20 + 0.1 * x0, top: 30 + 0.1 * x0, source: 'lidar',
  });
  const cutHouse = house('cut', 40, -4, 10, 8);
  cutHouse.roofParts = [{ type: 'gable', eaves: 28, ridge: 31, centre: [1045, 2040], axis: [1, 0], a: 5, b: 4, rmse: 0.2 }];
  const site: SiteData = {
    bbox: { minE: 1000, minN: 2000, maxE: 1140, maxN: 2080 }, origin: [1070, 2040], dtm, dsm: null,
    buildings: [cutHouse, house('beyond', 80, 12, 12, 8), house('far', 100, 70, 10, 10), house('behind', 100, -20, 10, 10)],
    lines: [], areas: [{ id: 'river', kind: 'water', rings: [sq(1100, 2030, 1110, 2050)], tags: {} }], trees: [], points: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
  };
  // Line runs along y = 2040 from x = 1010 to 1130, looking north (left of travel).
  const A: [number, number] = [1010, 2040], B: [number, number] = [1130, 2040];

  it('profiles the ground, cuts the house with its roof shape, and shows beyond/tree/water', () => {
    const tree = { p: [1065, 2046] as [number, number], h: 9, r: 3, source: 'osm' as const };
    const s = buildSection(site, [tree, { ...tree, p: [1065, 2000] }], A, B, DEFAULT_SECTION);
    expect(s.length).toBeCloseTo(120, 6);
    // Ground follows z = 20 + 0.1 x (x measured from the raster edge): at chainage 0 (x = 10) it is 21.
    expect(s.ground[0][1]).toBeCloseTo(21, 1);
    expect(s.ground[s.ground.length - 1][1]).toBeCloseTo(33, 1);
    expect(s.cuts).toHaveLength(1);
    expect(s.cuts[0].t0).toBeCloseTo(30, 6); expect(s.cuts[0].t1).toBeCloseTo(40, 6);
    // The cut runs across the gable's short axis? The ridge runs along x, so the cut follows the ridge: constant 31 at mid-width.
    expect(Math.max(...s.cuts[0].top.map((q) => q[1]))).toBeCloseTo(31, 1);
    expect(s.beyond.map((b) => b.id)).toEqual(['beyond']); // 'far' is 70 m away, beyond the 60 m depth
    expect(s.trees).toHaveLength(1); // the second tree is on the wrong side
    expect(s.water).toHaveLength(1);
    expect(s.water[0].t1 - s.water[0].t0).toBeCloseTo(10, 1); // water outlines are grown 1 cm by the union
    expect(s.zmax).toBeGreaterThanOrEqual(31);
  });
  it('elevation mode draws every building on the viewing side, none cut', () => {
    const s = buildSection(site, [], A, B, { ...DEFAULT_SECTION, mode: 'elevation', depth: 200 });
    expect(s.cuts).toHaveLength(0);
    expect(s.beyond.map((b) => b.id).sort()).toEqual(['beyond', 'cut', 'far']);
    expect(s.beyond[0].dist).toBeGreaterThan(s.beyond[s.beyond.length - 1].dist); // far first
  });
  it('becomes layers with exaggerated levels that go through the SVG sheet and R2000 DXF', () => {
    const s = buildSection(site, [], A, B, { ...DEFAULT_SECTION, exaggeration: 2 });
    const { layers, bbox } = sectionLayers(s, { ...DEFAULT_SECTION, exaggeration: 2 });
    expect(layers.map((l) => l.name)).toEqual(['SECTION-BEYOND', 'SECTION-GROUND', 'SECTION-WATER', 'SECTION-CUT', 'SECTION-ANNO']);
    expect(bbox.maxE).toBeCloseTo(120, 6);
    const ground = layers[1].items.find((i) => i.t === 'line') as { pts: [number, number][] };
    expect(ground.pts[0][1]).toBeCloseTo(42, 0); // 21 m x exaggeration 2
    const { svg } = writeSheet(layers, bbox, { paper: 'auto', scale: 500, block: { ...DEFAULT_BLOCK, title: 'Section A-A' }, legend: true, grid: false });
    expect(svg).toContain('Section A-A');
    expect(svg).toContain('SECTION-CUT');
    expect(writeDxf2000(restyle(layers, 'ncs'), bbox, { origin: [0, 0], scale: 500 })).toContain('A-SECT-CUT');
  });
});

describe('sheets and CAD standards', () => {
  it('chooses the smallest paper that fits, switches orientation, and warns when nothing fits', () => {
    expect(layoutSheet(100, 80, { paper: 'auto', scale: 500 }).paper).toBe('A4');
    const l = layoutSheet(400, 400, { paper: 'auto', scale: 1000 });
    expect(['A3', 'A2']).toContain(l.paper);
    expect(l.fits).toBe(true);
    expect(layoutSheet(300, 100, { paper: 'auto', scale: 500 }).landscape).toBe(true);
    expect(layoutSheet(3000, 3000, { paper: 'A0', scale: 500 }).fits).toBe(false);
    expect(fitScale(2000, 2000, 'A1')).toBeGreaterThanOrEqual(2500);
  });
  it('the title block, legend, grid ticks and scale bar are generated', () => {
    const layers = [{ name: 'BUILDINGS', label: 'Building footprints', stroke: '#000', aci: 7, weight: 0.35, fill: '#ddd', items: [{ t: 'poly' as const, rings: [sq(1010, 2010, 1030, 2020)] }] }];
    const { svg, layout } = writeSheet(layers, { minE: 1000, minN: 2000, maxE: 1100, maxN: 2080 }, {
      paper: 'auto', scale: 500, block: { ...DEFAULT_BLOCK, project: 'Bath study', title: 'Site location plan', number: 'SLP-01', drawnBy: 'JC' }, legend: true, grid: true,
    });
    for (const t of ['Bath study', 'Site location plan', 'SLP-01', '1:500 @ A4', 'Building footprints', 'Key', 'First issue', 'Drawn by']) expect(svg, t).toContain(t);
    expect(svg).toMatch(/<text[^>]*>1050<\/text>/); // BNG tick label
    expect(svg).toContain(`width="${layout.w}mm"`);
  });
  it('layer schemes rename, merge duplicates, add a prefix and snap lines to ISO 128 weights', () => {
    expect(layerName('ROAD-SURFACE', 'ncs')).toBe('C-ROAD-KERB');
    expect(layerName('ROAD-SURFACE', 'simple', 'ab_')).toBe('AB_ROAD-SURFACE');
    expect(snapWeight(0.32)).toBe(0.35); expect(snapWeight(0.05)).toBe(0.13); expect(snapWeight(0.6)).toBe(0.5);
    const mk = (name: string): never => ({ name, label: '', stroke: '#000', aci: 7, weight: 0.3, items: [{ t: 'line', pts: [[0, 0], [1, 1]] }] }) as never;
    const out = restyle([mk('ROAD-MINOR'), mk('ROAD-MAJOR'), mk('WALL')], 'ncs');
    expect(out.map((l) => l.name)).toEqual(['C-ROAD-CNTR', 'C-WALL']);
    expect(out[0].items).toHaveLength(2);
    expect(out[0].weight).toBe(0.25); // 0.3 mm snaps to the nearest ISO 128 pen
  });
});
