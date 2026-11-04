import { bufferLines, differencePolygons, unionPolygons, type Polygon } from './buffer';
import { buildContext, type Context } from './context';
import { drapeSurface, mergeMeshes, rasterizePolygons, solidWithFlatFloor, solidWithMirrorFloor, triCount } from './geom';
import { buildingsMesh, stepForTriangles, terrainGrid, terrainMesh, type Mesh, type TerrainGrid } from './mesh';
import { adaptiveTerrain } from './rtin';
import { resample, ribbonSolid } from './ribbon';
import { buildFacades } from './facades';
import { buildBridge } from './bridges';
import { findEntrances } from '../analysis/entrances';
import { buildMarkings } from './markings';
import { fitRoofParts, DEFAULT_PART_OPTIONS } from './roofparts';
import { partyWallTester, placeDormers } from './dormers';
import { edgeDistance } from './roofs';
import { fitRoof, rawRoofMesh, roofedBuildingMesh, roofRaster } from './roofs';
import { detectTrees, treesMesh, type Tree } from './trees';
import type { Building, Raster, SiteData } from '../types';

// ------------------------------------------------------------------ layers

export type LayerId =
  | 'terrain' | 'buildings' | 'details' | 'dormers' | 'pavements' | 'earthworks' | 'facade' | 'windows' | 'doors' | 'markings' | 'roads' | 'paths' | 'rail' | 'water' | 'green' | 'wood' | 'paved' | 'bridges' | 'walls' | 'trees';

export interface LayerDef {
  id: LayerId;
  label: string;
  /** Layer / file name in CAD exports. */
  cad: string;
  /** Display and material colour. */
  color: string;
}

/** Every 3D layer; exports write one OBJ group / STL file / DXF layer per entry. */
export const MODEL_LAYERS: LayerDef[] = [
  { id: 'terrain', label: 'Terrain', cad: 'TERRAIN', color: '#d8d3c4' },
  { id: 'buildings', label: 'Buildings', cad: 'BUILDINGS', color: '#f4f1ea' },
  { id: 'details', label: 'Chimneys & parapets', cad: 'ROOF-DETAIL', color: '#cfc7b8' },
  { id: 'dormers', label: 'Dormers (roof windows)', cad: 'ROOF-DORMERS', color: '#e6e0d2' },
  { id: 'roads', label: 'Roads', cad: 'ROADS', color: '#8f8b82' },
  { id: 'pavements', label: 'Pavements (raised at the kerb)', cad: 'PAVEMENTS', color: '#cfc9bc' },
  { id: 'earthworks', label: 'Embankments & banks', cad: 'EARTHWORKS', color: '#b3a77e' },
  { id: 'facade', label: 'Facade bands', cad: 'FACADE-BANDS', color: '#d9d2c3' },
  { id: 'windows', label: 'Windows', cad: 'FACADE-WINDOWS', color: '#7a96ad' },
  { id: 'doors', label: 'Doors', cad: 'FACADE-DOORS', color: '#6b4a2f' },
  { id: 'markings', label: 'Road markings', cad: 'ROAD-MARKINGS', color: '#f6f6f2' },
  { id: 'paths', label: 'Paths', cad: 'PATHS', color: '#c9b48e' },
  { id: 'rail', label: 'Railways', cad: 'RAIL', color: '#6b625a' },
  { id: 'water', label: 'Rivers & water', cad: 'WATER', color: '#6fa3d6' },
  { id: 'green', label: 'Parks & green', cad: 'GREEN', color: '#b5d29a' },
  { id: 'wood', label: 'Woodland', cad: 'WOODLAND', color: '#86ad6f' },
  { id: 'paved', label: 'Squares & paved', cad: 'PAVED', color: '#d8d2c6' },
  { id: 'bridges', label: 'Bridges', cad: 'BRIDGES', color: '#b8554d' },
  { id: 'walls', label: 'Walls & fences', cad: 'WALLS', color: '#a89b86' },
  { id: 'trees', label: 'Trees', cad: 'TREES', color: '#5f9a4c' },
];

export const layerDef = (id: LayerId) => MODEL_LAYERS.find((l) => l.id === id)!;

export interface SceneObject {
  layer: LayerId;
  /** `mesh.parts` name the individual objects (one per building, tree, bridge …). */
  mesh: Mesh;
}

// ------------------------------------------------------------------ settings

export type BuildingLod = 'off' | 'lod1' | 'lod15' | 'lod2fit' | 'lod2';

export interface ModelSettings {
  /** Model scale denominator (1000 = 1:1000); converts print-scale millimetres to metres. */
  scaleDen: number;
  /** Terrain grid step in metres; 0 = pick the finest step within `maxTris`; -1 = adaptive (RTIN). */
  terrainStep: number;
  /** Adaptive terrain: largest vertical deviation from the DTM (m). */
  terrainTolerance: number;
  /** Triangle budget for the terrain when `terrainStep` is 0. */
  maxTris: number;
  buildings: BuildingLod;
  /** DSM downsampling for LOD2-raw roofs (1 = 1 m). */
  roofStep: number;
  roads: boolean;
  paths: boolean;
  rail: boolean;
  /** Pavements beside roads (tagged, mapped, or inferred along building frontage), raised at the kerb. */
  pavements: boolean;
  /** Steep embankments, cuttings and river banks next to roads, rail and water, as their own patches. */
  earthworks: boolean;
  water: boolean;
  green: boolean;
  bridges: boolean;
  walls: boolean;
  trees: 'off' | 'osm' | 'lidar';
  /** LOD2-fit only: model chimneys and parapets as separate objects. */
  roofDetails: boolean;
  /** LOD2-fit: dormer windows on steep and mansard roofs (procedural, on the facade bay rhythm). */
  roofWindows: boolean;
  /** LOD2-fit: detect mansard roofs and keep complex roofs (churches, domes) as the LIDAR surface. */
  complexRoofs: boolean;
  /** Road markings from OSM tags (centre/lane lines, zebras, cycle lanes, stop lines, double yellows). */
  markings: boolean;
  /** Procedural facades (string courses, windows, doors): not surveyed. */
  facades: boolean;
  /** Thickness of roads/paths/rail/green above the terrain, in mm at print scale. */
  reliefMm: number;
  /** How far rivers are carved below the banks, in mm at print scale (0 = don't carve). */
  waterDepthMm: number;
  /** Cell size for draped features in metres; 0 = automatic. */
  featureStep: number;
  /** Roads, paths, rail, water and parks as thin closed solids (print-ready); false = lighter open surfaces. */
  featureSolids: boolean;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  scaleDen: 1000, terrainStep: 0, terrainTolerance: 0.1, maxTris: 500_000, buildings: 'lod1', roofStep: 1,
  roads: true, paths: true, rail: true, pavements: true, earthworks: true, water: true, green: true, bridges: true, walls: true, trees: 'lidar', roofDetails: true, roofWindows: true, complexRoofs: true, markings: true, facades: false,
  reliefMm: 0.4, waterDepthMm: 1, featureStep: 0, featureSolids: true,
};

const mmToM = (mm: number, scaleDen: number) => Math.max(0.1, (mm * scaleDen) / 1000);

// ------------------------------------------------------------------ scene

export interface Scene {
  objects: SceneObject[];
  grid: TerrainGrid;
  /** The (possibly carved) DTM the terrain was built from. */
  terrainRaster: Raster;
  step: number;
  /** Closed terrain solid with a flat base at `baseZ` (same surface as the preview). */
  terrainSolid(baseZ: number): Mesh;
  /** Adaptive terrain only: the vertical tolerance actually used (m). */
  tolerance?: number;
  /** Triangles per layer. */
  stats: Record<string, number>;
  notes: string[];
  trees: Tree[];
}

export type Progress = (msg: string) => Promise<void> | void;

const safe = (s: string) => s.replace(/[^\w#-]/g, '_');
const treeCache = new WeakMap<SiteData, Tree[]>();

/** Detect trees once per dataset (independent of the display mode). */
function allTrees(site: SiteData, ctx: Context): Tree[] {
  let t = treeCache.get(site);
  if (!t) {
    const exclude = [
      ...site.buildings.map((b) => b.rings),
      ...bufferLines(ctx.bridges.map((b) => ({ coords: b.coords, width: b.width + 3 })), site.bbox),
    ];
    // Without building footprints every roof would look like a tree, so only trust the OSM points then.
    t = detectTrees(site.dtm, site.buildings.length ? site.dsm : null, exclude, site.trees);
    treeCache.set(site, t);
  }
  return t;
}

/** Trees for a site and mode (also used by the drawings). */
export function treesFor(site: SiteData, mode: ModelSettings['trees']): Tree[] {
  if (mode === 'off') return [];
  const all = allTrees(site, buildContext(site));
  return mode === 'osm' ? all.filter((t) => t.source === 'osm') : all;
}

export function clearTreeCache(site: SiteData) {
  treeCache.delete(site);
}

/** Build every enabled 3D layer for a site. */
export async function buildScene(site: SiteData, s: ModelSettings, progress: Progress = () => {}): Promise<Scene> {
  const ctx = buildContext(site);
  const objects: SceneObject[] = [];
  const notes: string[] = [];
  const origin = site.origin;
  const add = (layer: LayerId, mesh: Mesh) => { if (mesh.indices.length) objects.push({ layer, mesh }); };

  // ---- terrain (optionally with the rivers carved in)
  await progress('Terrain…');
  const adaptive = s.terrainStep < 0;
  const step = adaptive ? 1 : s.terrainStep || stepForTriangles(site.dtm, s.maxTris);
  const depth = s.water && ctx.water.length && s.waterDepthMm > 0 ? mmToM(s.waterDepthMm, s.scaleDen) : 0;
  let raster = site.dtm;
  if (depth) {
    raster = { ...site.dtm, data: Float32Array.from(site.dtm.data) };
    const mask = rasterizePolygons(ctx.water, site.dtm);
    for (let k = 0; k < mask.length; k++) if (mask[k]) raster.data[k] -= depth;
  }
  // Draped features always follow the full-resolution surface; the preview/export mesh may be simplified.
  const grid = terrainGrid(raster, origin, { step: adaptive ? 1 : step });
  const original = depth ? terrainGrid(site.dtm, origin, { step: adaptive ? 1 : step }) : grid;
  let terrainSolid: (baseZ: number) => Mesh;
  let tolerance: number | undefined;
  if (site.shape) {
    // Custom outline: drape the polygon over the terrain grid, so the mesh edge is the outline exactly.
    const st = adaptive ? stepForTriangles(site.dtm, s.maxTris) : step;
    const g2 = terrainGrid(raster, origin, { step: st });
    const ring = site.shape.map(([e, n]) => [e - origin[0], n - origin[1]] as [number, number]);
    const open = drapeSurface([[ring]], g2.lines(1), g2.zAt, 0).build();
    const x0 = g2.xs[0], x1 = g2.xs[g2.nc - 1], y0 = g2.ys[g2.nr - 1], y1 = g2.ys[0];
    const uvs = new Float32Array((open.positions.length / 3) * 2);
    for (let i = 0; i < open.positions.length / 3; i++) { uvs[i * 2] = (open.positions[i * 3] - x0) / (x1 - x0); uvs[i * 2 + 1] = (open.positions[i * 3 + 1] - y0) / (y1 - y0); }
    open.uvs = uvs;
    add('terrain', open);
    terrainSolid = (baseZ) => solidWithFlatFloor(open, baseZ);
    if (adaptive) notes.push('Custom shape: terrain uses a uniform grid (adaptive terrain applies to rectangular sites).');
  } else if (adaptive) {
    const at = adaptiveTerrain(raster, origin, { tolerance: s.terrainTolerance, maxTris: s.maxTris });
    tolerance = at.tolerance;
    add('terrain', at.mesh);
    terrainSolid = at.solid;
    if (at.tolerance > s.terrainTolerance * 1.01) notes.push(`Adaptive terrain: tolerance raised to ${at.tolerance.toFixed(2)} m to stay within ${s.maxTris.toLocaleString()} triangles.`);
  } else {
    add('terrain', terrainMesh(raster, origin, { step }, grid));
    terrainSolid = (baseZ) => terrainMesh(raster, origin, { step, baseZ }, grid);
  }

  // ---- buildings
  if (s.buildings !== 'off' && site.buildings.length) {
    await progress('Buildings…');
    const bm = buildBuildings(site, s, notes);
    add('buildings', bm.buildings);
    if (bm.details.length) add('details', mergeMeshes(bm.details));
    if (bm.dormers.length) add('dormers', mergeMeshes(bm.dormers));
    if (!s.facades && bm.dormerWindows.length) add('windows', mergeMeshes(bm.dormerWindows));
    if (s.facades) {
      await progress('Facades…');
      const f = buildFacades(site.buildings, findEntrances(site.buildings, site.points, site.lines), origin);
      if (f.courses) add('facade', f.courses);
      if (f.windows) add('windows', mergeMeshes([{ name: 'facade_windows', mesh: f.windows }, ...bm.dormerWindows]));
      else if (bm.dormerWindows.length) add('windows', mergeMeshes(bm.dormerWindows));
      if (f.doors) add('doors', f.doors);
      notes.push(`Facades (procedural, not surveyed): ${f.stats.windows} windows, ${f.stats.doors} doors, ${f.stats.courses} bands${f.stats.capped ? ' — capped to keep the model light' : ''}.`);
    }
  }

  // ---- draped context features
  // Features must clear the simplified terrain: raise their relief above the adaptive tolerance.
  const relief = Math.max(mmToM(s.reliefMm, s.scaleDen), tolerance ? 1.5 * tolerance : 0);
  const fstep = s.featureStep || Math.max(2, adaptive ? 2 : step);
  const lines = (k: number) => grid.lines(Math.max(1, Math.round((fstep * k) / (adaptive ? 1 : step))));
  const pads = (name: string, polys: { name: string; rings: Polygon }[], k: number, lift: number): Mesh => {
    const g = lines(k);
    return mergeMeshes(polys.map(({ name: n, rings }) => {
      const surface = drapeSurface([rings], g, grid.zAt, s.featureSolids ? lift : Math.max(lift, 0.1)).build();
      return { name: `${name}_${n}`, mesh: s.featureSolids ? solidWithMirrorFloor(surface, lift + 0.15 * relief + 0.05) : surface };
    }));
  };
  const numbered = (polys: Polygon[]) => polys.map((rings, i) => ({ name: String(i + 1), rings }));
  const local = (polys: Polygon[]): Polygon[] => polys.map((p) => p.map((r) => r.map(([e, n]) => [e - origin[0], n - origin[1]] as [number, number])));

  // Ground features never overlap: carriageway > pavement > path > earthworks > parks; buildings cover them all.
  const bboxS = site.bbox;
  const bldPolys: Polygon[] = s.buildings !== 'off' ? site.buildings.map((b) => b.rings) : [];
  const under = (polys: Polygon[], over: Polygon[]) => differencePolygons(polys, over, bboxS);
  const kerb = Math.max(0.1, relief * 0.5);
  if (s.roads && ctx.roads.length) { await progress('Roads…'); add('roads', pads('road', numbered(local(ctx.roads)), 1, relief)); }
  if (s.pavements && ctx.pavements.length) { await progress('Pavements…'); add('pavements', pads('pavement', numbered(local(under(ctx.pavements, bldPolys))), 1, relief + kerb)); }
  if (s.paths && ctx.paths.length) { await progress('Paths…'); add('paths', pads('path', numbered(local(under(ctx.paths, bldPolys))), 1, relief * 0.9)); }
  const earthPolys = s.earthworks ? under(ctx.earthworks.areas, [...ctx.pavements, ...ctx.paths, ...bldPolys]) : [];
  if (earthPolys.length) { await progress('Embankments…'); add('earthworks', pads('earth', numbered(local(earthPolys)), 1, relief * 0.4)); }
  if (s.rail && ctx.rail.length) { await progress('Railways…'); add('rail', pads('rail', numbered(local(ctx.rail)), 1, relief * 1.2)); }
  if (s.markings && s.roads) {
    await progress('Road markings…');
    const marks = buildMarkings(site);
    if (marks.length) {
      const g = lines(1);
      const parts = marks.map((m, i) => {
        const ring = m.ring.map(([e, n]) => [e - origin[0], n - origin[1]] as [number, number]);
        const lift = relief + 0.06;
        const surface = drapeSurface([[ring]], g, grid.zAt, lift).build();
        return { name: `${m.kind}_${m.colour}_${i + 1}`, mesh: s.featureSolids ? solidWithMirrorFloor(surface, 0.06) : surface };
      });
      add('markings', mergeMeshes(parts));
    }
  }
  if (s.green) {
    await progress('Parks & woodland…');
    for (const [kind, lift] of [['green', 0.5], ['wood', 0.5], ['paved', 0.7]] as const) {
      const list = ctx.areas.filter((a) => a.kind === kind);
      if (!list.length) continue;
      // OSM areas often overlap (a park containing a garden): merge them so the solids don't stack.
      const covered = [...(s.roads ? ctx.roads : []), ...(s.pavements ? ctx.pavements : []), ...(s.paths ? ctx.paths : []), ...(s.rail ? ctx.rail : []), ...(s.water ? ctx.water : []), ...earthPolys, ...bldPolys];
      const polys = numbered(local(under(unionPolygons(list.map((a) => a.polygon), site.bbox), covered)));
      add(kind, pads(kind, polys, 2, relief * lift));
    }
  }
  if (s.water && ctx.water.length) {
    await progress('Rivers & water…');
    const g = lines(1);
    const top = (x: number, y: number) => original.zAt(x, y) - 0.3 * depth;
    const parts = local(ctx.water).map((rings, i) => {
      const surface = drapeSurface([rings], g, (x, y) => top(x, y), 0).build();
      return { name: `water_${i + 1}`, mesh: s.featureSolids ? solidWithMirrorFloor(surface, 0.7 * depth + Math.max(relief * 0.5, 0.1)) : surface };
    });
    add('water', mergeMeshes(parts));
  }

  // ---- bridges (deck follows the DSM along the centreline) and walls
  if (s.bridges && ctx.bridges.length) {
    await progress('Bridges…');
    const decks = ctx.bridges.flatMap((b, i) => buildBridge(b, safe(b.id) || String(i + 1), origin, original.zAt, site.dsm, { parapet: Math.max(0.5, relief * 2), roadLift: relief }));
    add('bridges', mergeMeshes(decks));
  }
  if (s.walls && ctx.walls.length) {
    await progress('Walls…');
    add('walls', mergeMeshes(ctx.walls.map((w, i) => {
      const pts = resample(w.coords.map(([e, n]) => [e - origin[0], n - origin[1]] as [number, number]), 2);
      return {
        name: `wall_${safe(w.id) || i + 1}`,
        mesh: ribbonSolid(pts, pts.map(([x, y]) => grid.zAt(x, y) + w.height), w.thickness / 2, w.height + 0.3),
      };
    })));
  }

  // ---- trees
  let trees: Tree[] = [];
  if (s.trees !== 'off') {
    await progress('Trees…');
    trees = allTrees(site, ctx);
    if (s.trees === 'lidar' && !site.buildings.length) notes.push('Trees: no OSM buildings loaded, so only OSM tree points are shown (LIDAR canopy can’t be told apart from roofs).');
    if (s.trees === 'osm') trees = trees.filter((t) => t.source === 'osm');
    if (trees.length) add('trees', treesMesh(trees, origin, grid.zAt));
  }

  const stats: Record<string, number> = {};
  for (const o of objects) stats[o.layer] = triCount(o.mesh);
  return { objects, grid, terrainRaster: raster, step, terrainSolid, tolerance, stats, notes, trees };
}

/** All buildings at the chosen LOD, one named part each. */
function buildBuildings(site: SiteData, s: ModelSettings, notes: string[]): { buildings: Mesh; details: { name: string; mesh: Mesh }[]; dormers: { name: string; mesh: Mesh }[]; dormerWindows: { name: string; mesh: Mesh }[] } {
  const origin = site.origin;
  const blocks: Building[] = [];
  const parts: { name: string; mesh: Mesh }[] = [];
  const details: { name: string; mesh: Mesh }[] = [];
  const dormers: { name: string; mesh: Mesh }[] = [], dormerWindows: { name: string; mesh: Mesh }[] = [];
  const party = partyWallTester(site.buildings);
  const dsm = site.dsm;
  const floor = (b: Building) => b.ground - 0.5;
  let pitched = 0, raw = 0;
  const partTypes = { flat: 0, shed: 0, gable: 0, hip: 0, mansard: 0, surface: 0 };
  const raster = dsm && s.buildings === 'lod2' ? roofRaster(dsm, s.roofStep) : null;
  for (const b of site.buildings) {
    b.roof = undefined;
    b.roofParts = undefined;
    if (s.buildings === 'lod2fit' && dsm) {
      const ps = fitRoofParts(b, dsm, site.dtm, origin, { ...DEFAULT_PART_OPTIONS, mansards: s.complexRoofs, surfaceFallback: s.complexRoofs, vegetation: site.vegetation }, s.roofDetails);
      if (ps) {
        b.roofParts = ps.map((p) => p.fit);
        b.dormers = undefined;
        if (s.roofWindows) {
          for (const p of ps) {
            const others = ps.filter((q) => q !== p).flatMap((q) => q.region);
            const r = placeDormers(p.region, p.fit, p.ground, origin, (m) => party(b, m) || (others.length > 0 && edgeDistance(m[0], m[1], others) < 0.4));
            if (r.solids) dormers.push({ name: `dormers_${p.name.replace(/^building_/, '')}`, mesh: r.solids });
            if (r.windows) dormerWindows.push({ name: `dormer_windows_${p.name.replace(/^building_/, '')}`, mesh: r.windows });
            if (r.list.length) (b.dormers ??= []).push(...r.list);
          }
        }
        for (const p of ps) { parts.push({ name: p.name, mesh: p.mesh }); partTypes[p.fit.type]++; details.push(...p.details); }
        continue;
      }
    } else if (s.buildings === 'lod15' && dsm) {
      const fit = fitRoof(b, dsm);
      if (fit) {
        b.roof = fit;
        const m = roofedBuildingMesh(b, fit, origin, floor(b));
        if (m) { parts.push({ name: `building_${safe(b.id)}`, mesh: m }); pitched++; continue; }
      }
    } else if (s.buildings === 'lod2' && raster) {
      const m = rawRoofMesh(b, raster, origin, floor(b));
      if (m) { parts.push({ name: `building_${safe(b.id)}`, mesh: m }); raw++; continue; }
    }
    blocks.push(b);
  }
  if (s.buildings === 'lod15') notes.push(dsm ? `LOD1.5: ${pitched} pitched roofs fitted, ${blocks.length} flat.` : 'LOD1.5 needs the LIDAR DSM; showing flat blocks.');
  if (s.buildings === 'lod2fit') {
    const n = Object.values(partTypes).reduce((a, c) => a + c, 0);
    notes.push(dsm ? `LOD2-fit: ${n} roof parts (${partTypes.gable} gable, ${partTypes.hip} hip, ${partTypes.mansard} mansard, ${partTypes.shed} shed, ${partTypes.surface} complex-surface, ${partTypes.flat} flat) on ${site.buildings.length - blocks.length} buildings; ${details.length} chimneys/parapets; ${dormers.length} roofs with dormer windows.` : 'LOD2-fit needs the LIDAR DSM; showing flat blocks.');
  }
  if (s.buildings === 'lod2') notes.push(raster ? `LOD2-raw: ${raw} LIDAR roofs, ${blocks.length} blocks.` : 'LOD2 needs the LIDAR DSM; showing flat blocks.');
  const flat = buildingsMesh(blocks, origin);
  return { buildings: mergeMeshes([...parts, { name: 'blocks', mesh: flat }]), details, dormers, dormerWindows };
}

