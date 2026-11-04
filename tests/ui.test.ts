import { describe, expect, it } from 'vitest';
import { decodeState, encodeState, friendlyError } from '../src/ui/state';
import { geotiffBounds, parseWorldFile, worldFileBounds } from '../src/data/imagery';
import { toBNG } from '../src/geo/bng';

describe('share links', () => {
  const state = {
    v: 1 as const, bbox: { minE: 375031, minN: 164745, maxE: 375431, maxN: 165145 },
    shape: [[375100.123, 164800.456], [375300, 164800], [375200, 165000]] as [number, number][],
    redLine: null, cuts: [{ a: [375050, 164900] as [number, number], b: [375400, 164900] as [number, number] }],
    settings: { lod: 'lod2fit', fRoads: true, terrainStep: '-1', tbProject: 'Café “Bäth” — 100 %' },
  };
  it('round-trips a site, shape, sections and settings (including unicode) in a short URL-safe hash', () => {
    const h = encodeState(state);
    expect(h).toMatch(/^#s=[\w-]+$/);
    expect(h.length).toBeLessThan(900);
    const back = decodeState(h)!;
    expect(back.bbox).toEqual(state.bbox);
    expect(back.shape![0]).toEqual([375100.1, 164800.5]); // rounded to 0.1 m
    expect(back.cuts).toEqual(state.cuts);
    expect(back.settings.tbProject).toBe('Café “Bäth” — 100 %');
    expect(back.settings.fRoads).toBe(true);
  });
  it('rejects garbage, other hashes and impossible boxes', () => {
    expect(decodeState('')).toBeNull();
    expect(decodeState('#hello')).toBeNull();
    expect(decodeState('#s=!!!')).toBeNull();
    expect(decodeState('#s=' + btoa('{"v":1}'))).toBeNull();
    expect(decodeState(encodeState({ ...state, bbox: { minE: 5, minN: 5, maxE: 1, maxN: 9 } }))).toBeNull();
  });
  it('turns technical errors into advice', () => {
    expect(friendlyError('Fetching data', 'Overpass unavailable: Error: x')).toMatch(/OpenStreetMap's server is busy/);
    expect(friendlyError('Fetching data', 'No LIDAR coverage in this area')).toMatch(/no LIDAR/);
    expect(friendlyError('X', 'Failed to fetch')).toMatch(/didn't answer/);
    expect(friendlyError('X', 'Area is 6.00 km²; the limit is 4 km²')).toMatch(/smaller area/);
    expect(friendlyError('X', 'weird')).toBe('X failed: weird');
  });
});

describe('imagery georeferencing', () => {
  it('reads a world file and gives BNG bounds (pixel centres)', () => {
    const wf = parseWorldFile('0.25\n0\n0\n-0.25\n375000.125\n165000.875\n');
    expect(worldFileBounds(wf, 4000, 2000)).toEqual({ minE: 375000, maxE: 376000, maxN: 165001, minN: 164501 });
    expect(() => parseWorldFile('1 2 3')).toThrow(/world file/);
    expect(() => worldFileBounds(parseWorldFile('1 0.1 0 -1 0 0'), 10, 10)).toThrow(/Rotated/);
  });
  it('transforms GeoTIFF bounds from BNG, lat/lon and Web Mercator', () => {
    expect(geotiffBounds([1, 2, 3, 4], 27700)).toEqual({ bbox: { minE: 1, minN: 2, maxE: 3, maxN: 4 }, approx: false });
    const [e, n] = toBNG(-2.359, 51.3815);
    const ll = geotiffBounds([-2.359, 51.3815, -2.358, 51.3825], 4326);
    expect(ll.approx).toBe(true);
    expect(Math.hypot(ll.bbox.minE - e, ll.bbox.minN - n)).toBeLessThan(0.01);
    const x = (-2.359 * 20037508.34) / 180, y = (Math.log(Math.tan(((90 + 51.3815) * Math.PI) / 360)) / Math.PI) * 20037508.34;
    const m = geotiffBounds([x, y, x + 100, y + 100], 3857);
    expect(Math.hypot(m.bbox.minE - e, m.bbox.minN - n)).toBeLessThan(0.1);
    expect(() => geotiffBounds([0, 0, 1, 1], 2154)).toThrow(/Unsupported/);
  });
});
