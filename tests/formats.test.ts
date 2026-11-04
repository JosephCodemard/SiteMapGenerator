import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { writeGlb } from '../src/export/gltf';
import { writeThreeMf } from '../src/export/threemf';
import { buildScene, DEFAULT_SETTINGS } from '../src/process/scene';
import type { Building, LineFeature, Raster, SiteData } from '../src/types';

const W = 120, H = 100;
const dtm: Raster = { width: W, height: H, minE: 1000, maxN: 2000 + H, res: 1, data: new Float32Array(W * H).map((_, i) => 20 + 0.05 * (i % W)) };
const sq = (x: number, y: number, s: number): [number, number][][] => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]];
const bld = (id: string, x: number, y: number): Building => ({ id, rings: sq(1000 + x, 2000 + y, 10), tags: {}, ground: 20, top: 29, source: 'lidar' });
const road: LineFeature = { id: 'r', kind: 'road-minor', coords: [[1000, 2020], [1120, 2020]], tags: { highway: 'residential' }, bridge: false, tunnel: false };
const site: SiteData = {
  bbox: { minE: 1000, minN: 2000, maxE: 1120, maxN: 2100 }, origin: [1060, 2050], dtm, dsm: null,
  buildings: [bld('a', 20, 40), bld('b', 60, 40)], lines: [road], areas: [], trees: [], points: [], osmOffset: [0, 0], fetchedAt: '', filledCells: 0,
};

describe('GLB and 3MF', () => {
  it('GLB: valid container, one node per layer and per part, Y-up bounds, materials per layer', async () => {
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', maxTris: 30_000 });
    const glb = writeGlb(sc.objects);
    const dv = new DataView(glb);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jl)));
    expect(json.asset.version).toBe('2.0');
    const layerNodes = json.scenes[0].nodes.map((n: number) => json.nodes[n].name);
    expect(layerNodes).toEqual(expect.arrayContaining(['TERRAIN', 'BUILDINGS', 'ROADS']));
    const b = json.nodes[json.scenes[0].nodes[layerNodes.indexOf('BUILDINGS')]];
    expect(b.children.map((c: number) => json.nodes[c].name).filter((n: string) => n.startsWith('building_'))).toEqual(['building_a', 'building_b']);
    expect(json.materials.map((m: { name: string }) => m.name)).toContain('ROADS');
    // The terrain's vertical extent (z-up 20..23) appears as glTF Y, and its y extent as -Z.
    const ta = json.accessors[json.meshes[json.nodes[json.nodes[json.scenes[0].nodes[0]].children[0]].mesh].primitives[0].attributes.POSITION];
    expect(ta.min[1]).toBeGreaterThan(19); expect(ta.max[1]).toBeLessThan(27.1);
    expect(ta.max[2]).toBeGreaterThan(ta.min[2]);
    expect(json.buffers[0].byteLength + 12 + 8 + jl + 8).toBe(glb.byteLength);
    // Every accessor reads inside the buffer.
    for (const a of json.accessors) { const v = json.bufferViews[a.bufferView]; expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength); }
  });
  it('3MF: a valid package with one coloured object per layer, in millimetres at model scale', async () => {
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', maxTris: 30_000 });
    const zip = unzipSync(writeThreeMf(sc.objects, { scale: 1, zExaggeration: 1, zOffset: 19 }));
    expect(Object.keys(zip).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(zip['3D/3dmodel.model']);
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toMatch(/<object id="\d+" type="model" name="TERRAIN"/);
    expect(xml).toMatch(/<base name="ROADS" displaycolor="#8F8B82FF"\/>/);
    const verts = (xml.match(/<vertex /g) ?? []).length, tris = (xml.match(/<triangle /g) ?? []).length;
    expect(verts).toBeGreaterThan(100);
    expect(tris).toBe(sc.objects.reduce((a, o) => a + o.mesh.indices.length / 3, 0));
    // Triangle indices stay inside each object's vertex list.
    for (const m of xml.matchAll(/<object[^>]*><mesh><vertices>(.*?)<\/vertices><triangles>(.*?)<\/triangles>/gs)) {
      const n = (m[1].match(/<vertex /g) ?? []).length;
      for (const t of m[2].matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) expect(Math.max(+t[1], +t[2], +t[3])).toBeLessThan(n);
    }
    // With the base at 19 m (below the 0.5 m building sink) nothing is negative.
    const zs = [...xml.matchAll(/z="([-\d.]+)"/g)].map((m) => +m[1]);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-0.001);
  });
});

import { fuse, unionParts } from '../src/process/solidify';
import { boxMesh, mergeMeshes } from '../src/process/geom';
import type { Mesh } from '../src/process/mesh';

function volume(m: Mesh): number {
  let v = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

describe('manifold unions', () => {
  it('unions overlapping buildings into one solid with the right volume, skipping non-manifold parts', async () => {
    const layer = mergeMeshes([
      { name: 'a', mesh: boxMesh(0, 0, 10, 10, 0, 10) },
      { name: 'b', mesh: boxMesh(5, 0, 15, 10, 0, 10) }, // overlaps a by 5 x 10 x 10
      { name: 'far', mesh: boxMesh(40, 0, 50, 10, 0, 5) },
      { name: 'open', mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) } },
    ]);
    const r = await unionParts(layer, 'buildings');
    expect(r.merged).toBe(3);
    expect(r.skipped).toEqual(['open']);
    expect(volume(r.mesh)).toBeCloseTo(1500 + 500, 1); // 15x10x10 + 10x10x5
    expect(r.mesh.parts).toEqual([['buildings', 0, r.mesh.indices.length]]);
  });
  it('fuses buildings to a terrain solid into one watertight solid', async () => {
    const { buildScene, DEFAULT_SETTINGS } = await import('../src/process/scene');
    const sc = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', roads: false, markings: false, maxTris: 20_000 });
    const terrain = sc.terrainSolid(15);
    const b = sc.objects.find((o) => o.layer === 'buildings')!.mesh;
    const bu = await unionParts(b, 'buildings');
    const r = await fuse([terrain, bu.mesh]);
    expect(r.used).toBe(2);
    // One closed shell: every directed edge has its reverse exactly once.
    const e = new Map<string, number>();
    for (let t = 0; t < r.mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) { const key = `${r.mesh.indices[t + k]},${r.mesh.indices[t + (k + 1) % 3]}`; e.set(key, (e.get(key) ?? 0) + 1); }
    for (const [key, n] of e) { const [x, y] = key.split(','); expect(n).toBe(1); expect(e.get(`${y},${x}`)).toBe(1); }
    // Volume = terrain solid + the parts of the buildings above the ground (the sunk 0.5 m is inside the terrain).
    expect(volume(r.mesh)).toBeGreaterThan(volume(terrain));
    expect(volume(r.mesh)).toBeLessThan(volume(terrain) + volume(bu.mesh));
  });
});

import { buildFacades, levelsOf } from '../src/process/facades';

describe('procedural facades', () => {
  const house = (id: string, x: number, y: number, w: number, d: number, tags: Record<string, string> = { 'building:levels': '3' }): Building =>
    ({ id, rings: [[[x, y], [x + w, y], [x + w, y + d], [x, y + d]]], tags, ground: 0, top: 10.5, source: 'lidar' });
  const closed = (m: Mesh) => {
    const e = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) { const key = `${m.indices[t + k]},${m.indices[t + (k + 1) % 3]}`; e.set(key, (e.get(key) ?? 0) + 1); }
    for (const [key, n] of e) { const [a, b] = key.split(','); if (n !== 1 || e.get(`${b},${a}`) !== 1) return false; }
    return true;
  };
  it('storeys come from tags, else height', () => {
    expect(levelsOf(house('a', 0, 0, 5, 5))).toBe(3);
    expect(levelsOf(house('b', 0, 0, 5, 5, {}))).toBe(3); // 10.5 / 3.2 = 3.3
  });
  it('puts a window in every bay on every storey of free walls, bands under each floor, all outside the wall', () => {
    const b = house('a', 100, 100, 20, 10);
    const f = buildFacades([b], [], [100, 100]);
    // Long walls: floor((20-1)/1.2) = 15 bays; short walls: floor((10-1)/1.2) = 7 bays; 3 storeys.
    expect(f.stats.windows).toBe(3 * (15 * 2 + 7 * 2));
    expect(f.stats.courses).toBe(4 * 3); // 3 floor lines x 4 walls
    expect(f.stats.doors).toBe(0);
    expect(closed(f.windows!)).toBe(true);
    // Windows stand proud of the wall: no vertex inside the footprint (local coordinates 0..20 x 0..10), all within 0.1 m outside.
    const p = f.windows!.positions;
    for (let i = 0; i < p.length; i += 3) {
      const inside = p[i] > 0.001 && p[i] < 19.999 && p[i + 1] > 0.001 && p[i + 1] < 9.999;
      expect(inside).toBe(false);
      expect(p[i + 2]).toBeGreaterThan(0.8); expect(p[i + 2]).toBeLessThan(10.5);
    }
  });
  it('skips party walls, and puts a door (not a window) at the entrance bay', () => {
    const a = house('a', 0, 0, 12, 8), b = house('b', 12, 0, 12, 8); // share the wall x = 12
    const solo = buildFacades([a], [], [0, 0]).stats.windows;
    const both = buildFacades([a, b], [], [0, 0]).stats.windows;
    expect(both).toBeLessThan(2 * solo);
    expect(both).toBe(2 * solo - 2 * 3 * Math.floor((8 - 1) / 1.2));
    const withDoor = buildFacades([a], [{ p: [6, 0], buildingId: 'a', source: 'osm' }], [0, 0]);
    expect(withDoor.stats.doors).toBe(1);
    expect(withDoor.stats.windows).toBe(solo - 1);
    expect(closed(withDoor.doors!)).toBe(true);
  });
  it('respects the box budget and ignores tiny or low buildings', () => {
    const many = Array.from({ length: 30 }, (_, i) => house(`h${i}`, i * 30, 0, 20, 10));
    const f = buildFacades(many, [], [0, 0], { bay: 1.2, windowHeight: 1.4, sill: 0.9, depth: 0.08, maxBoxes: 500 });
    expect(f.stats.capped).toBe(true);
    expect(f.stats.windows + f.stats.doors + f.stats.courses).toBeLessThan(700);
    expect(buildFacades([{ ...house('s', 0, 0, 2, 2), top: 2 }], [], [0, 0]).stats.windows).toBe(0);
  });
  it('is its own set of layers in the scene, off by default', async () => {
    const { buildScene, DEFAULT_SETTINGS } = await import('../src/process/scene');
    const off = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', maxTris: 20_000 });
    expect(off.objects.some((o) => o.layer === 'windows')).toBe(false);
    const on = await buildScene(site, { ...DEFAULT_SETTINGS, trees: 'off', facades: true, maxTris: 20_000 });
    expect(on.objects.map((o) => o.layer)).toEqual(expect.arrayContaining(['facade', 'windows']));
    expect(on.notes.join(' ')).toMatch(/Facades \(procedural, not surveyed\)/);
  });
});

import { writeRhino } from '../src/export/rhino';

describe('Rhino 3DM', () => {
  it('writes layers with colours, named objects and building user text that read back', async () => {
    const { buildScene, DEFAULT_SETTINGS } = await import('../src/process/scene');
    const b = { ...site.buildings[0], listed: { grade: 'II', entry: 42, name: 'THE HOUSE' } };
    const s2: SiteData = { ...site, buildings: [b, site.buildings[1]] };
    const sc = await buildScene(s2, { ...DEFAULT_SETTINGS, trees: 'off', maxTris: 20_000 });
    const bytes = await writeRhino(sc.objects, s2.buildings, s2.origin, ['test note']);
    expect(new TextDecoder().decode(bytes.slice(0, 20))).toContain('3D Geometry File');
    const rhino = (await import('rhino3dm')) as never as { default: () => Promise<any> };
    const r = await (rhino.default ?? rhino)();
    const back = r.File3dm.fromByteArray(bytes);
    const layers = Array.from({ length: back.layers().count }, (_, i) => back.layers().get(i).name);
    expect(layers).toEqual(expect.arrayContaining(['TERRAIN', 'BUILDINGS', 'ROADS']));
    const names: string[] = [];
    let userText = '';
    for (let i = 0; i < back.objects().count; i++) {
      const a = back.objects().get(i).attributes();
      names.push(a.name);
      if (a.name === 'building_a') userText = `${a.getUserString('osm_id')}|${a.getUserString('top_m')}|${a.getUserString('listed')}`;
    }
    expect(names).toEqual(expect.arrayContaining(['building_a', 'building_b']));
    expect(userText).toBe('a|29.00|II (42) THE HOUSE');
    expect(back.strings().get('origin_easting')).toEqual(['origin_easting', '1060']);
    const colour = back.layers().get(layers.indexOf('ROADS')).color;
    expect([colour.r, colour.g, colour.b]).toEqual([143, 139, 130]);
  });
});
