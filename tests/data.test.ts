import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, clearMemoryCache } from '../src/data/cache';
import { attachListed, nhleUrl, parseNhle } from '../src/data/nhle';
import { fetchFloodZones, floodZonesUrl, parseFloodZones } from '../src/data/floodzones';
import { parseDefences, defencesUrl } from '../src/data/defences';
import { crimeUrl, fetchCrimes, monthsBack, parseCrimes, policePoly } from '../src/data/police';
import { windRose, windUrl } from '../src/data/weather';
import { parseOsm, pointKind } from '../src/data/osm';
import { toWGS } from '../src/geo/bng';
import { buildingAttributesCsv } from '../src/export/attributes';
import { siteToGeoJson } from '../src/data/site';
import type { Building } from '../src/types';

const bbox = { minE: 375031, minN: 164745, maxE: 375431, maxN: 165145 };
const mockFetch = (map: Record<string, unknown>) => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const key = Object.keys(map).find((k) => url.includes(k));
    return key ? { ok: true, status: 200, json: async () => map[key] } : { ok: false, status: 404, json: async () => ({}) };
  }));
  return calls;
};
beforeEach(() => clearMemoryCache());
afterEach(() => vi.unstubAllGlobals());

describe('cache', () => {
  it('returns the stored value until it expires', async () => {
    let n = 0;
    const f = async () => ++n;
    expect(await cached('k', 1000, f)).toBe(1);
    expect(await cached('k', 1000, f)).toBe(1);
    expect(await cached('k', -1, f)).toBe(2);
  });
});

describe('Historic England listings', () => {
  const fixture = { features: [
    { attributes: { Name: '6-9, ABBEY CHURCH YARD', ListEntry: 1393988, Grade: 'II' }, geometry: { points: [[375038, 164763]] } },
    { attributes: { Name: 'ABBEY', ListEntry: 1, Grade: 'I' }, geometry: { points: [[375040, 164764]] } },
    { attributes: { Name: 'FAR AWAY', ListEntry: 2, Grade: 'II*' }, geometry: { points: [[375400, 165100]] } },
  ] };
  it('builds a BNG envelope query and parses points', () => {
    expect(nhleUrl(bbox)).toContain('geometry=375021%2C164735%2C375441%2C165155');
    expect(nhleUrl(bbox)).toContain('inSR=27700');
    const e = parseNhle(fixture);
    expect(e).toHaveLength(3);
    expect(e[0]).toEqual({ entry: 1393988, name: '6-9, ABBEY CHURCH YARD', grade: 'II', p: [375038, 164763] });
  });
  it('attaches to the containing building, highest grade wins, far points are ignored', () => {
    const sq = (x: number, y: number, s: number) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]] as [number, number][][];
    const bs: Building[] = [
      { id: 'a', rings: sq(375030, 164755, 20), tags: {}, ground: 0, top: 9, source: 'lidar' },
      { id: 'b', rings: sq(375200, 164900, 10), tags: {}, ground: 0, top: 9, source: 'lidar' },
    ];
    expect(attachListed(bs, parseNhle(fixture))).toBe(1);
    expect(bs[0].listed).toEqual({ grade: 'I', entry: 1, name: 'ABBEY' });
    expect(bs[1].listed).toBeUndefined();
  });
});

describe('EA flood zones, defences, wind, crime', () => {
  it('parses flood-zone MultiPolygons in BNG and follows next links', async () => {
    const page = (zone: string, next?: string) => ({
      features: [{ properties: { flood_zone: zone, flood_source: 'river' }, geometry: { type: 'MultiPolygon', coordinates: [[[[1, 1], [5, 1], [5, 5], [1, 5], [1, 1]]]] } }],
      links: next ? [{ rel: 'next', href: next }] : [],
    });
    expect(floodZonesUrl(bbox)).toContain('crs=http%3A%2F%2Fwww.opengis.net%2Fdef%2Fcrs%2FEPSG%2F0%2F27700');
    const calls = mockFetch({ 'items?': page('FZ2', 'https://x.test/page2'), 'x.test/page2': page('FZ3') });
    const zones = await fetchFloodZones(bbox);
    expect(zones.map((z) => z.zone)).toEqual(['FZ2', 'FZ3']);
    expect(zones[0].polygons[0][0]).toHaveLength(4); // closing vertex dropped
    expect(calls).toHaveLength(2);
    expect(parseFloodZones({ features: [{ properties: { flood_zone: 'FZ1' }, geometry: null }] })).toEqual([]);
  });
  it('parses defences with toe levels', () => {
    expect(defencesUrl(bbox)).toContain('inSR=27700');
    const d = parseDefences({ features: [{ attributes: { asset_name: 'Wall', asset_sub_type: 'Flood wall', toe_level: 21.3 }, geometry: { paths: [[[1, 2], [3, 4]]] } }, { attributes: {} }] });
    expect(d).toEqual([{ name: 'Wall', type: 'Flood wall', toe: 21.3, lines: [[[1, 2], [3, 4]]] }]);
  });
  it('builds the police polygon in lat,lng order and parses crimes to BNG', async () => {
    const poly = policePoly([[375031, 164745], [375431, 164745], [375431, 165145], [375031, 165145]]);
    const [lat, lng] = poly.split(':')[0].split(',').map(Number);
    const [lon0, lat0] = toWGS(375031, 164745);
    expect(lat).toBeCloseTo(lat0, 4); expect(lng).toBeCloseTo(lon0, 4);
    expect(crimeUrl([[0, 0], [1, 0], [1, 1]], '2026-08')).toContain('date=2026-08');
    expect(monthsBack('2026-02', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    const [lon, la] = toWGS(375200, 164900);
    const crime = { category: 'burglary', month: '2026-08', location: { latitude: String(la), longitude: String(lon), street: { name: 'On or near Bridge Street' } }, outcome_status: null };
    mockFetch({ 'crimes-street-dates': [{ date: '2026-08' }], 'crimes-street/all-crime': [crime] });
    const out = await fetchCrimes([[375031, 164745], [375431, 164745], [375431, 165145], [375031, 165145]], bbox, 2);
    expect(out).toHaveLength(2); // one per month
    expect(out[0].street).toBe('Bridge Street');
    expect(Math.hypot(out[0].p[0] - 375200, out[0].p[1] - 164900)).toBeLessThan(0.1);
    expect(parseCrimes([crime])[0].category).toBe('burglary');
  });
  it('summarises a wind rose', () => {
    const dirs = [...Array(80).fill(225), ...Array(20).fill(45)];
    const speeds = [...Array(80).fill(6), ...Array(20).fill(2)];
    const r = windRose(speeds, dirs);
    expect(r.prevailing).toBe(225);
    expect(r.frequency[10]).toBeCloseTo(0.8, 6);
    expect(r.meanSpeed[10]).toBe(6);
    expect(r.mean).toBeCloseTo(5.2, 6);
    expect(r.frequency.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(windUrl(51.38, -2.36, 30, new Date('2026-11-04T00:00:00Z'))).toContain('start_date=2026-09-28&end_date=2026-10-28');
  });
});

describe('OSM points', () => {
  it('classifies entrances, crossings, signals and POIs, and skips street furniture', () => {
    expect(pointKind({ entrance: 'main' })).toBe('entrance');
    expect(pointKind({ highway: 'crossing', crossing: 'zebra' })).toBe('crossing');
    expect(pointKind({ highway: 'traffic_signals' })).toBe('signals');
    expect(pointKind({ highway: 'bus_stop' })).toBe('transit');
    expect(pointKind({ amenity: 'cafe' })).toBe('poi');
    expect(pointKind({ amenity: 'bench' })).toBeNull();
    const r = parseOsm({ elements: [
      { type: 'node', id: 1, lat: 51.3815, lon: -2.359, tags: { entrance: 'yes' } },
      { type: 'node', id: 2, lat: 51.3816, lon: -2.3591, tags: { natural: 'tree' } },
      { type: 'node', id: 3, lat: 51.3815, lon: -2.3592, tags: { amenity: 'pub', name: 'X' } },
    ] }, { minE: 374000, minN: 164000, maxE: 376000, maxN: 166000 });
    expect(r.points.map((p) => p.kind).sort()).toEqual(['entrance', 'poi']);
    expect(r.trees).toHaveLength(1);
  });
});

describe('building attributes', () => {
  it('writes one CSV row per building with roof and listing data, and GeoJSON carries the same', () => {
    const b: Building = { id: 'way/1', rings: [[[0, 0], [10, 0], [10, 10]]], tags: { name: 'The "Crescent", No. 1', 'addr:housenumber': '1', 'addr:street': 'Royal Crescent', 'building:levels': '4' }, ground: 20, top: 32.5, source: 'lidar',
      listed: { grade: 'I', entry: 1394, name: 'ROYAL CRESCENT' },
      roofParts: [{ type: 'gable', eaves: 29, ridge: 32, centre: [0, 0], axis: [1, 0], a: 5, b: 3, rmse: 0.4 }, { type: 'flat', eaves: 30, ridge: 30, centre: [0, 0], axis: [1, 0], a: 5, b: 3, rmse: 0.2 }] };
    const site = { buildings: [b], areas: [], lines: [], trees: [], points: [] } as never;
    const csv = buildingAttributesCsv(site).split('\n');
    expect(csv[0]).toMatch(/^id,object_name,name,address,levels/);
    expect(csv[1]).toContain('"The ""Crescent"", No. 1",1 Royal Crescent,4');
    expect(csv[1]).toContain('gable+flat,29.00,32.00,I,1394,ROYAL CRESCENT');
    const gj = JSON.parse(siteToGeoJson(site));
    expect(gj.features[0].properties).toMatchObject({ roof_parts: 'gable,flat', eaves_m: 29, ridge_m: 32, listed_grade: 'I' });
  });
});
