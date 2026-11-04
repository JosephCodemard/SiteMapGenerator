import './style.css';
import { strToU8, zipSync } from 'fflate';
import { buildingAttributesCsv } from './export/attributes';
import { attachListed, fetchListed } from './data/nhle';
import { fetchSite, MAX_AREA_KM2, rasterToAsc, siteToGeoJson, type SiteInputs } from './data/site';
import { parseGridRef, toBNG, toWGS } from './geo/bng';
import { buildingHeights, DEFAULT_HEIGHTS, type HeightOptions } from './process/buildings';
import { contourBands, contourLevels, contourLines, type ContourLine } from './process/contours';
import { stepForTriangles, terrainTriangles, type Mesh } from './process/mesh';
import { blur, downsample, hillshade, minMax } from './process/raster';
import {
  DEFAULT_SETTINGS, MODEL_LAYERS, buildScene, layerDef, treesFor, type ModelSettings, type Scene,
} from './process/scene';
import {
  buildDrawing, canvasToPng, defaultLayerToggles, LAYER_DEFS, svgToCanvas, textureCanvas, writeSvg,
  type DrawingFeatures, type Layer,
} from './export/drawing';
import { writeContourStackDxf, writeDxf, writeDxfMesh } from './export/dxf';
import { writeObj } from './export/obj';
import { writeStl } from './export/stl';
import { initAnalysis } from './ui/analysis';
import { AreaMap } from './view/map';
import { Viewer3D } from './view/viewer3d';
import { bboxOf, clipPolygonToShape, polygonArea } from './process/shape';
import type { BBox, Ring, SiteData } from './types';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($(id).value);
const checked = (id: string) => $(id).checked;
const sel = (id: string) => $<HTMLSelectElement>(id).value;

const PRESETS: { name: string; lon: number; lat: number; size: number }[] = [
  { name: 'Bath Abbey & Roman Baths', lon: -2.3590, lat: 51.3815, size: 500 },
  { name: 'Royal Crescent & The Circus', lon: -2.3655, lat: 51.3865, size: 700 },
  { name: 'Pulteney Bridge & weir', lon: -2.3573, lat: 51.3830, size: 400 },
  { name: 'Bath Spa station & river', lon: -2.3570, lat: 51.3775, size: 600 },
  { name: 'Central Bath (2 × 2 km)', lon: -2.3600, lat: 51.3830, size: 2000 },
];

/** One-click starting points for the "what to include" table. */
const MODEL_PRESETS: Record<string, Record<string, string | boolean>> = {
  presentation: {
    fBuildings: true, lod: 'lod15', fRoads: true, fPaths: true, fRail: true, fWater: true, fGreen: true, fBridges: true, fWalls: true,
    fTrees: true, treeMode: 'lidar', maxTris: '1000000', terrainStep: '0', featureStep: '0', drape: false,
  },
  print: {
    fBuildings: true, lod: 'lod1', fRoads: true, fPaths: false, fRail: false, fWater: true, fGreen: true, fBridges: true, fWalls: false,
    fTrees: false, maxTris: '250000', terrainStep: '0', featureStep: '2', drape: false,
  },
  cad: {
    fBuildings: true, lod: 'lod1', fRoads: true, fPaths: true, fRail: true, fWater: true, fGreen: true, fBridges: true, fWalls: true,
    fTrees: true, treeMode: 'osm', maxTris: '250000', terrainStep: '0', featureStep: '4', drape: false,
  },
  terrain: {
    fBuildings: false, fRoads: false, fPaths: false, fRail: false, fWater: false, fGreen: false, fBridges: false, fWalls: false,
    fTrees: false, maxTris: '500000', terrainStep: '0', drape: false,
  },
};

// ---------------------------------------------------------------- state
let bbox: BBox;
let shape: Ring | null = null;
const shapeHistory: { bbox: BBox; shape: Ring | null }[] = [];
let site: SiteData | null = null;
let inputs: SiteInputs | null = null;
let scene: Scene | null = null;
let texture: HTMLCanvasElement | null = null;
let modelStale = false;
let osmData: unknown;
let contourCache: { key: string; lines: ContourLine[] } | null = null;
const layerToggles = defaultLayerToggles();
let viewer: Viewer3D | null = null;

// ---------------------------------------------------------------- helpers
function log(msg: string) {
  const el = $('log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const b = $('busy');
  b.hidden = false;
  b.textContent = `${label}…`;
  document.querySelectorAll('button').forEach((x) => (x.disabled = true));
  await new Promise((r) => setTimeout(r, 30)); // let the UI repaint
  const t0 = performance.now();
  try {
    const result = await fn();
    const secs = (performance.now() - t0) / 1000;
    if (secs > 1) log(`${label} done in ${secs.toFixed(1)} s`);
    return result;
  } catch (e) {
    console.error(e);
    log(`✖ ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  } finally {
    b.hidden = true;
    document.querySelectorAll('button').forEach((x) => (x.disabled = false));
  }
}

/** Update the busy banner from inside a long task (and let the browser paint it). */
async function stage(msg: string) {
  $('busy').textContent = `${msg}`;
  await tick();
}

function download(name: string, data: BlobPart | Blob, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  log(`↓ ${name} (${(blob.size / 1e6).toFixed(1)} MB)`);
}

const stamp = () => `${bbox.minE}_${bbox.minN}`;

function readme(extra: string): string {
  if (!site) return '';
  const [oE, oN] = site.origin;
  const layers = scene ? Object.entries(scene.stats).map(([k, v]) => `  ${layerDef(k as never).cad}: ${v.toLocaleString()} triangles`) : [];
  return [
    'UK Site Model export',
    `Area: BNG E ${site.bbox.minE}-${site.bbox.maxE}, N ${site.bbox.minN}-${site.bbox.maxN} (EPSG:27700)`,
    `Local origin: E ${oE}, N ${oN} (add these to model X/Y to get British National Grid)`,
    'Heights: metres above Ordnance Datum Newlyn (ODN).',
    `OSM features shifted ${site.osmOffset[0].toFixed(2)} m E, ${site.osmOffset[1].toFixed(2)} m N to match LIDAR roofs.`,
    `Fetched: ${site.fetchedAt}`,
    extra,
    ...(layers.length ? ['', 'Layers:', ...layers] : []),
    '',
    'Sources & licences:',
    '- Environment Agency LIDAR Composite DTM & DSM 1m. © Environment Agency copyright and/or database right.',
    '  Open Government Licence v3: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    '- © OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright',
    '- WGS84 -> BNG via OSTN15 (Ordnance Survey).',
  ].join('\n');
}

const zip = (files: Record<string, Uint8Array>, level: 0 | 1 | 6 = 6) => zipSync(files, { level });
const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

// ---------------------------------------------------------------- area
function setBBox(b: BBox, fromMap = false, keepShape = false) {
  if (!keepShape) shape = null;
  bbox = b;
  for (const k of ['minE', 'minN', 'maxE', 'maxN'] as const) $(k).value = String(b[k]);
  const w = b.maxE - b.minE, h = b.maxN - b.minN;
  const km2 = (shape ? polygonArea(shape) : w * h) / 1e6;
  const mb = (w * h * 4 * (checked('useDsm') ? 2 : 1)) / 1e6;
  $('areaInfo').innerHTML = `${shape ? 'custom shape, bounds ' : ''}${w} × ${h} m · ${km2.toFixed(2)} km² · ~${mb.toFixed(0)} MB LIDAR download` +
    (km2 > MAX_AREA_KM2 ? ` <b style="color:#c00">exceeds ${MAX_AREA_KM2} km² limit</b>` : '');
  if (!fromMap) areaMap.setArea(b, true, shape);
  $('undoShape').disabled = shapeHistory.length === 0;
}

function centred(e: number, n: number, size: number): BBox {
  const h = size / 2;
  return { minE: Math.round(e - h), minN: Math.round(n - h), maxE: Math.round(e + h), maxN: Math.round(n + h) };
}

function goTo(b: BBox) {
  setBBox(b);
  areaMap.fitArea(b);
}

async function search(q: string) {
  q = q.trim();
  const size = bbox ? Math.max(bbox.maxE - bbox.minE, bbox.maxN - bbox.minN) : 500;
  const gr = parseGridRef(q);
  if (gr) return goTo(centred(gr[0], gr[1], size));
  const nums = q.split(/[\s,]+/).map(Number);
  if (nums.length === 2 && nums.every(Number.isFinite)) {
    // "E, N" if they look like BNG metres, else "lat, lon".
    if (Math.abs(nums[0]) > 1000) return goTo(centred(nums[0], nums[1], size));
    const [e, n] = toBNG(nums[1], nums[0]);
    return goTo(centred(e, n, size));
  }
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`);
  const json = await res.json();
  if (!res.ok || !json.result) return log(`✖ Couldn't find “${q}”. Try a postcode, grid reference or E,N.`);
  goTo(centred(json.result.eastings, json.result.northings, size));
}

// ---------------------------------------------------------------- settings
function heightOptions(): HeightOptions {
  const v = sel('heightMode');
  return v === 'osm'
    ? { ...DEFAULT_HEIGHTS, priority: 'osm' }
    : { ...DEFAULT_HEIGHTS, roofPercentile: Number(v) };
}

/** Read the "what to include" controls into model settings. */
function readSettings(): ModelSettings {
  return {
    scaleDen: num('stlScale'),
    terrainStep: num('terrainStep'),
    terrainTolerance: num('terrainTol'),
    maxTris: num('maxTris'),
    buildings: checked('fBuildings') ? (sel('lod') as ModelSettings['buildings']) : 'off',
    roofStep: num('roofStep'),
    roads: checked('fRoads'),
    paths: checked('fPaths'),
    rail: checked('fRail'),
    water: checked('fWater'),
    green: checked('fGreen'),
    bridges: checked('fBridges'),
    walls: checked('fWalls'),
    trees: checked('fTrees') ? (sel('treeMode') as ModelSettings['trees']) : 'off',
    roofDetails: true,
    markings: checked('fMarkings'),
    reliefMm: num('reliefMm') || DEFAULT_SETTINGS.reliefMm,
    waterDepthMm: num('waterMm'),
    featureStep: num('featureStep'),
    featureSolids: checked('solids'),
  };
}

function drawingFeatures(): DrawingFeatures {
  const s = readSettings();
  return {
    buildings: s.buildings !== 'off', roads: s.roads, paths: s.paths, rail: s.rail, water: s.water, green: s.green,
    bridges: s.bridges, walls: s.walls, markings: s.markings, roofs: s.buildings === 'lod15' || s.buildings === 'lod2fit',
    trees: site ? treesFor(site, s.trees) : [],
  };
}

const STORE = 'ukdtm.settings.v2';

function saveSettings() {
  const out: Record<string, string | boolean> = {};
  document.querySelectorAll<HTMLInputElement>('[data-persist]').forEach((el) => {
    out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  try { localStorage.setItem(STORE, JSON.stringify(out)); } catch { /* storage may be unavailable */ }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string | boolean>;
    for (const [id, v] of Object.entries(saved)) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el || !el.hasAttribute('data-persist')) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    }
  } catch { /* ignore corrupt settings */ }
}

function markStale() {
  modelStale = true;
  $('rebuild').classList.add('stale');
  updateMeshSummary();
}

function applyPreset(name: string) {
  for (const [id, v] of Object.entries(MODEL_PRESETS[name])) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  saveSettings();
  markStale();
}

// ---------------------------------------------------------------- data
async function fetchData() {
  const result = await busy('Fetching data', () =>
    fetchSite(bbox, { dsm: checked('useDsm'), osm: checked('useOsm'), align: checked('alignOsm'), heights: heightOptions(), osmData, shape: shape ?? undefined }, log));
  if (!result) return;
  ({ site, inputs } = result);
  scene = null;
  if (checked('useListed') && site.buildings.length) {
    try {
      const entries = await fetchListed(site.bbox);
      const n = attachListed(site.buildings, entries);
      log(`Historic England: ${entries.length} listing points, ${n} buildings tagged.`);
    } catch (e) { log(`⚠ Listed buildings unavailable (${e instanceof Error ? e.message : e}); continuing without.`); }
  }
  contourCache = null;
  document.querySelectorAll('.needs-data').forEach((s) => s.classList.remove('disabled'));
  showSummary();
  await rebuildModel();
  selectTab('model');
}

function showSummary() {
  if (!site) return;
  const [lo, hi] = minMax(site.dtm.data);
  const src = site.buildings.reduce<Record<string, number>>((a, b) => ((a[b.source] = (a[b.source] ?? 0) + 1), a), {});
  const count = (k: string) => site!.lines.filter((l) => l.kind === k).length;
  const areas = (k: string) => site!.areas.filter((a) => a.kind === k).length;
  const rows: [string, string | number][] = [
    ['Ground elevation', `${lo.toFixed(1)} – ${hi.toFixed(1)} m ODN`],
    ['DTM cells filled (no data)', site.filledCells.toLocaleString()],
    ['OSM shift to LIDAR (E, N)', `${site.osmOffset[0].toFixed(2)}, ${site.osmOffset[1].toFixed(2)} m`],
    ['Buildings', site.buildings.length],
    ['  height from LIDAR', src.lidar ?? 0],
    ['  from OSM height / levels', `${src['osm-height'] ?? 0} / ${src['osm-levels'] ?? 0}`],
    ['  default height', src.default ?? 0],
    ['Roads (major / minor)', `${count('road-major')} / ${count('road-minor')}`],
    ['Paths', count('path')],
    ['Railways', count('rail')],
    ['Rivers / streams', `${count('river')} / ${count('stream')}`],
    ['Water / green / wood areas', `${areas('water')} / ${areas('green')} / ${areas('wood')}`],
    ['Bridges (lines + areas)', site.lines.filter((l) => l.bridge).length + areas('bridge')],
    ['Walls & fences', count('wall')],
    ['Trees (OSM)', site.trees.length],
  ];
  $('summary').innerHTML = `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- 3D
function updateMeshSummary() {
  if (!site) { $('meshSummary').textContent = ''; $('terrainInfo').textContent = 'set mesh size below'; return; }
  const s = readSettings();
  const step = s.terrainStep || stepForTriangles(site.dtm, s.maxTris);
  const t = s.terrainStep < 0
    ? `adaptive, ≤ ${s.terrainTolerance} m error · ≤ ${(s.maxTris / 1e6).toFixed(2)} M triangles`
    : `${step} m grid · ${(terrainTriangles(site.dtm, step) / 1e6).toFixed(2)} M triangles`;
  $('terrainInfo').textContent = t;
  $('meshSummary').textContent = t;
}

function showLegend() {
  const el = $('legend');
  if (!scene) { el.hidden = true; return; }
  const total = Object.values(scene.stats).reduce((a, b) => a + b, 0);
  const rows = MODEL_LAYERS.filter((l) => scene!.stats[l.id]).map((l) =>
    `<label><input type="checkbox" data-layer="${l.id}" checked /><span class="swatch" style="background:${l.color}"></span> ${l.label}` +
    `<span class="n">${scene!.stats[l.id].toLocaleString()}</span></label>`).join('');
  el.innerHTML = `<h4>Layers (triangles)</h4>${rows}<div class="total ${total > 4e6 ? 'warn' : ''}">${total.toLocaleString()} total` +
    `${total > 4e6 ? ' — heavy: raise mesh sizes' : ''}</div>`;
  el.hidden = false;
  el.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((c) => {
    c.onchange = () => viewer?.setLayerVisible(c.dataset.layer as never, c.checked);
  });
}

async function rebuildModel() {
  if (!site || !inputs) return;
  await busy('Building model', async () => {
    const s = site!;
    const settings = readSettings();
    await stage('Heights…');
    const listed = new Map(s.buildings.filter((b) => b.listed).map((b) => [b.id, b.listed!]));
    s.buildings = buildingHeights(inputs!.footprints, s.dtm, s.dsm, heightOptions());
    for (const b of s.buildings) b.listed = listed.get(b.id);
    if (settings.buildings === 'lod2' && s.buildings.length > 1500) {
      log(`LOD2 roofs for ${s.buildings.length} buildings can take a minute — raise “LIDAR-roof detail” to 2 m to speed it up.`);
    }
    scene = await buildScene(s, settings, stage);
    for (const n of scene.notes) log(n);
    texture = null;
    if (checked('drape')) {
      await stage('Plan texture…');
      const layers = buildDrawing(s, [], { layers: defaultLayerToggles(), buildingLabels: false });
      texture = await textureCanvas(layers, s.bbox, Math.min(4096, Math.max(1024, (s.bbox.maxE - s.bbox.minE) * 2)));
    }
    viewer ??= new Viewer3D($('view-model'));
    $('view-model').querySelector('.empty')?.remove();
    viewer.setScene(scene, texture);
    viewer.setExaggeration(num('exag'));
    showLegend();
    const tris = Object.values(scene.stats).reduce((a, b) => a + b, 0);
    log(`Model: ${scene.tolerance !== undefined ? `adaptive terrain (±${scene.tolerance.toFixed(2)} m)` : `${scene.step} m terrain grid`}, ${(tris / 1e6).toFixed(2)} M triangles in ${Object.keys(scene.stats).length} layers, ${s.buildings.length} buildings`);
    contourCache = null;
    showSummary();
    updateStlInfo();
    updateMeshSummary();
    modelStale = false;
    $('rebuild').classList.remove('stale');
  });
}

/** Exports always use a model that matches the current settings. */
async function ensureModel(): Promise<Scene | null> {
  if (!site) return null;
  if (!scene || modelStale) await rebuildModel();
  return scene;
}

function stlParams() {
  const s = site!;
  const scaleDen = num('stlScale');
  const k = scaleDen === 1 ? 1 : 1000 / scaleDen; // output units per metre
  const exag = num('exag');
  const [lo] = minMax(s.dtm.data);
  // Base thickness is in output units (mm on the print, or metres at 1:1).
  const baseZ = lo - num('baseMm') / (k * exag);
  return { k, exag, baseZ, unit: scaleDen === 1 ? 'm' : 'mm' };
}

function updateStlInfo() {
  if (!site) return;
  const { k, exag, baseZ, unit } = stlParams();
  const [, hi] = minMax(site.dtm.data);
  const maxTop = Math.max(hi, ...site.buildings.map((b) => b.top));
  const w = (site.bbox.maxE - site.bbox.minE) * k, d = (site.bbox.maxN - site.bbox.minN) * k;
  const h = (maxTop - baseZ) * k * exag;
  const tris = scene ? Object.values(scene.stats).reduce((a, b) => a + b, 0) : 0;
  $('stlInfo').textContent = `Print size ≈ ${w.toFixed(0)} × ${d.toFixed(0)} × ${h.toFixed(0)} ${unit}` +
    (tris ? ` · ≈ ${(tris * 50 / 1e6).toFixed(0)} MB as STL` : '');
  const li = num('laserInterval');
  const levels = contourLevels(minMax(site.dtm.data)[0], hi, li).length;
  $('laserInfo').textContent = `${levels} layers · each layer = ${(li * k * exag).toFixed(2)} ${unit} sheet thickness at this scale/exaggeration`;
}

async function exportObj() {
  if (!site) return;
  await busy('Exporting OBJ', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    const s = site!;
    const [lo] = minMax(s.dtm.data);
    const objects = sc.objects.map((o) => (o.layer === 'terrain' && checked('objSolid')
      ? { ...o, mesh: sc.terrainSolid(lo - 5) }
      : o));
    const up = sel('objUp') as 'z' | 'y';
    const structure = sel('structure') as 'layers' | 'combined';
    const { obj, mtl, layers } = writeObj(objects, { up, structure, texture: texture ? 'terrain.png' : undefined });
    const files: Record<string, Uint8Array> = {
      'model.mtl': strToU8(mtl),
      'README.txt': strToU8(readme(`OBJ: units metres, ${up.toUpperCase()}-up, X = East - originE, Y = North - originN.\n` +
        (structure === 'layers' ? 'One .obj file per layer: import each into its own layer. Every building/tree/bridge is a named object.'
          : 'One .obj with a group (g) per layer and an object (o) per building/tree/bridge.'))),
      'origin.txt': strToU8(`${s.origin[0]} ${s.origin[1]} 0\n`),
      'buildings.csv': strToU8(buildingAttributesCsv(s)),
    };
    if (structure === 'combined') files['model.obj'] = await blobBytes(new Blob(obj));
    else for (const [name, parts] of Object.entries(layers)) files[`${name}.obj`] = await blobBytes(new Blob(parts));
    if (texture) files['terrain.png'] = await blobBytes(await canvasToPng(texture));
    download(`site_${stamp()}_obj.zip`, new Blob([zip(files, 1) as BlobPart]));
  });
}

async function exportStl() {
  if (!site) return;
  await busy('Exporting STL', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    const s = site!;
    const { k, exag, baseZ, unit } = stlParams();
    const t = { scale: k, zExaggeration: exag, zOffset: baseZ };
    const named: [string, Mesh][] = [['TERRAIN', sc.terrainSolid(baseZ)]];
    for (const o of sc.objects) if (o.layer !== 'terrain') named.push([layerDef(o.layer).cad, o.mesh]);
    const scaleName = `1-${num('stlScale')}_${unit}`;
    if (checked('stlMerge')) {
      download(`site_${stamp()}_${scaleName}.stl`, writeStl(named.map(([, m]) => m), t));
      return;
    }
    const files: Record<string, Uint8Array> = { 'buildings.csv': strToU8(buildingAttributesCsv(s)) };
    for (const [name, mesh] of named) files[`${name}.stl`] = new Uint8Array(writeStl([mesh], t));
    files['README.txt'] = strToU8(readme(`STL: units ${unit} at 1:${num('stlScale')}, vertical exaggeration ${exag}x. ` +
      'All files share one origin and register when loaded together. Layers are closed solids; overlapping shells (e.g. roads over terrain) are merged by your slicer. ' +
      'Trees and thin walls may be below printable size at small scales: leave those files out.'));
    download(`site_${stamp()}_stl_${scaleName}.zip`, new Blob([zip(files, 0) as BlobPart]));
  });
}

async function exportDxf3d() {
  if (!site) return;
  await busy('Exporting 3D DXF', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    const local = sel('dxfOrigin') === 'local';
    const dxf = writeDxfMesh(sc.objects, site!.bbox, { origin: local ? [0, 0] : site!.origin });
    download(`site_${stamp()}_${local ? 'local' : 'bng'}_3d.dxf`, dxf, 'application/dxf');
  });
}

// ---------------------------------------------------------------- drawings
function getContours(): ContourLine[] {
  const s = site!;
  const interval = num('interval'), majorEvery = num('majorEvery'), smooth = num('smooth');
  const key = `${interval}|${majorEvery}|${smooth}`;
  if (contourCache?.key === key) return contourCache.lines;
  // Keep the contour grid around 1.5 M cells; smooth to remove LIDAR noise.
  const f = Math.max(1, Math.ceil(Math.sqrt((s.dtm.width * s.dtm.height) / 1.5e6)));
  const grid = blur(downsample(s.dtm, f), smooth, 2);
  const lines = contourLines(grid, interval, majorEvery, grid.res * 0.15);
  contourCache = { key, lines };
  log(`Contours: ${lines.length} lines at ${interval} m (grid ${grid.res} m)`);
  return lines;
}

function drawingLayers(): Layer[] {
  const contours = layerToggles['CONTOUR-MINOR'] || layerToggles['CONTOUR-MAJOR'] || layerToggles['CONTOUR-LABEL'] ? getContours() : [];
  return buildDrawing(site!, contours, { layers: layerToggles, buildingLabels: layerToggles['BLDG-LABEL'], features: drawingFeatures() });
}

function hillshadeDataUrl(): string {
  const s = site!;
  const f = Math.max(1, Math.ceil(Math.sqrt((s.dtm.width * s.dtm.height) / 4e6)));
  const r = downsample(s.dtm, f);
  const canvas = document.createElement('canvas');
  canvas.width = r.width; canvas.height = r.height;
  canvas.getContext('2d')!.putImageData(new ImageData(hillshade(r) as ImageDataArray, r.width, r.height), 0, 0);
  return canvas.toDataURL('image/png');
}

function drawingSvg(): string {
  return writeSvg(drawingLayers(), site!.bbox, {
    scale: num('drawScale'),
    title: `Site plan — E ${site!.bbox.minE}, N ${site!.bbox.minN}`,
    underlay: checked('hillshade') ? hillshadeDataUrl() : undefined,
    furniture: true,
    shape: site!.shape,
  });
}

/** Drawings show building roof lines only after a model with fitted roofs has been built. */
async function prepareDrawing() {
  if (!site) return false;
  if (/^lod(15|2fit)$/.test(readSettings().buildings) && (!scene || modelStale)) await ensureModel();
  return true;
}

async function previewDrawing() {
  if (!(await prepareDrawing())) return;
  await busy('Rendering drawing', async () => {
    const el = $('view-drawing');
    el.innerHTML = drawingSvg();
    const svg = el.querySelector('svg')!;
    svg.style.width = 'min(96%, 1400px)';
    selectTab('drawing');
  });
}

async function exportSvg() {
  if (!(await prepareDrawing())) return;
  await busy('Exporting SVG', async () => download(`site_${stamp()}_1-${num('drawScale')}.svg`, drawingSvg(), 'image/svg+xml'));
}

async function exportPng() {
  if (!(await prepareDrawing())) return;
  await busy('Exporting PNG', async () => {
    const canvas = await svgToCanvas(drawingSvg(), { dpi: num('dpi') });
    download(`site_${stamp()}_1-${num('drawScale')}_${num('dpi')}dpi.png`, await canvasToPng(canvas));
  });
}

async function exportDxf() {
  if (!(await prepareDrawing())) return;
  await busy('Exporting DXF', async () => {
    const local = sel('dxfOrigin') === 'local';
    const dxf = writeDxf(drawingLayers(), site!.bbox, { origin: local ? site!.origin : [0, 0], scale: num('drawScale') });
    download(`site_${stamp()}_${local ? 'local' : 'bng'}.dxf`, dxf, 'application/dxf');
  });
}

async function exportLaser() {
  if (!site) return;
  await busy('Exporting laser-cut DXF', async () => {
    const s = site!;
    const { k, exag } = stlParams();
    const f = Math.max(1, Math.ceil(Math.sqrt((s.dtm.width * s.dtm.height) / 1e6)));
    const grid = blur(downsample(s.dtm, f), 2, 2);
    const [lo, hi] = minMax(grid.data);
    const levels = contourLevels(lo, hi, num('laserInterval'));
    // Bottom sheet is the full site; every other sheet is the area above its level.
    levels[0] = Math.min(levels[0], lo);
    const bands = contourBands(grid, levels);
    // Convert to mm on the cutting bed (origin at site SW corner).
    const toMm = (r: [number, number][]) => r.map(([e, n]) => [(e - s.bbox.minE) * k, (n - s.bbox.minN) * k] as [number, number]);
    const shapeMm = s.shape ? toMm(s.shape) : null;
    const mmBands = bands.map((b) => ({
      level: b.level,
      polygons: b.polygons.map((p) => p.map(toMm)).flatMap((rings) => (shapeMm ? clipPolygonToShape(rings, shapeMm) : [rings])),
    }));
    const mmBox: BBox = { minE: 0, minN: 0, maxE: (s.bbox.maxE - s.bbox.minE) * k, maxN: (s.bbox.maxN - s.bbox.minN) * k };
    const layout = sel('laserLayout') as 'grid' | 'stacked';
    const dxf = writeContourStackDxf(mmBands, mmBox, { origin: [0, 0], layout, gap: 10 });
    log(`Laser stack: ${levels.length} sheets, ${(num('laserInterval') * k * exag).toFixed(2)} mm material`);
    download(`site_${stamp()}_laser_1-${num('stlScale')}.dxf`, dxf, 'application/dxf');
  });
}

async function exportData() {
  if (!site) return;
  await busy('Exporting dataset', async () => {
    const s = site!;
    const files: Record<string, Uint8Array> = {
      'features_bng.geojson': strToU8(siteToGeoJson(s)),
      'buildings.csv': strToU8(buildingAttributesCsv(s)),
      'dtm_1m.asc': strToU8(rasterToAsc(s.dtm)),
      'README.txt': strToU8(readme('GeoJSON coordinates are EPSG:27700 (British National Grid). Grids are ESRI ASCII, 1 m, m ODN.')),
    };
    if (s.dsm) files['dsm_1m.asc'] = strToU8(rasterToAsc(s.dsm));
    download(`site_${stamp()}_data.zip`, new Blob([zip(files) as BlobPart]));
  });
}

// ---------------------------------------------------------------- UI wiring
function selectTab(name: string) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'map') areaMap.map.resize();
}

const start = PRESETS[0];
const areaMap = new AreaMap($('view-map'), [start.lon, start.lat]);
areaMap.onChange = () => { /* shape tools report through onShape */ };

areaMap.map.on('load', () => {
  const [e, n] = toBNG(start.lon, start.lat);
  setBBox(centred(e, n, start.size));
});

const preset = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => preset.add(new Option(`${p.name} (${p.size} m)`, String(i))));
preset.onchange = () => {
  const p = PRESETS[Number(preset.value)];
  if (!p) return;
  const [e, n] = toBNG(p.lon, p.lat);
  goTo(centred(e, n, p.size));
};

$('go').onclick = () => search($('search').value);
$('search').onkeydown = (e) => { if (e.key === 'Enter') search($('search').value); };
const SHAPE_HELP: Record<string, string> = {
  rect: 'Rectangle: drag corner to corner.',
  hexagon: 'Hexagon: drag from the centre outwards (the drag distance is the corner radius).',
  circle: 'Circle: drag from the centre outwards.',
  polygon: 'Polygon: click each corner, double-click or Enter to finish, Backspace removes the last corner, Esc cancels.',
};
$('shapeKind').onchange = () => { $('shapeHelp').textContent = SHAPE_HELP[sel('shapeKind')]; };
$('draw').onclick = () => { selectTab('map'); areaMap.setTool(sel('shapeKind') as never); log(SHAPE_HELP[sel('shapeKind')]); };
areaMap.onMessage = log;
areaMap.onShape = (sh, b) => {
  shapeHistory.push({ bbox, shape });
  shape = sh;
  setBBox(b, true, true);
};
$('undoShape').onclick = () => {
  const prev = shapeHistory.pop();
  if (!prev) return;
  shape = prev.shape;
  setBBox(prev.bbox, false, true);
};
$('lidarOverlay').onchange = () => areaMap.setLidarOverlay(checked('lidarOverlay'));
for (const k of ['minE', 'minN', 'maxE', 'maxN']) {
  $(k).onchange = () => {
    const b = { minE: num('minE'), minN: num('minN'), maxE: num('maxE'), maxN: num('maxN') };
    if (b.maxE > b.minE && b.maxN > b.minN) setBBox(b);
  };
}
$('useDsm').onchange = () => setBBox(bbox);
$('osmFile').onchange = async () => {
  const f = ($('osmFile') as HTMLInputElement).files?.[0];
  osmData = undefined;
  if (!f) return;
  try {
    osmData = JSON.parse(await f.text());
    log(`OSM file “${f.name}” loaded — it will be used instead of Overpass on the next fetch.`);
  } catch {
    log(`✖ “${f.name}” is not valid JSON. Export “raw OSM data” as JSON from overpass-turbo.`);
  }
};

$('fetch').onclick = fetchData;
$('rebuild').onclick = rebuildModel;
$('exag').oninput = () => {
  $('exagVal').textContent = `${num('exag').toFixed(1)}×`;
  viewer?.setExaggeration(num('exag'));
  updateStlInfo();
};
$('exportObj').onclick = exportObj;
$('exportStl').onclick = exportStl;
$('exportDxf3d').onclick = exportDxf3d;
$('previewDrawing').onclick = previewDrawing;
$('exportSvg').onclick = exportSvg;
$('exportPng').onclick = exportPng;
$('exportDxf').onclick = exportDxf;
$('exportLaser').onclick = exportLaser;
$('exportData').onclick = exportData;
document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab!)));
document.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => (b.onclick = () => applyPreset(b.dataset.preset!)));

loadSettings();
// Persist every remembered control; the ones that shape the model also flag it as out of date.
document.querySelectorAll<HTMLInputElement>('[data-persist]').forEach((el) => {
  el.addEventListener('change', () => {
    saveSettings();
    if (el.closest('#modelStep')) markStale();
    updateStlInfo();
  });
});
for (const id of ['stlScale']) $(id).addEventListener('change', () => { if (site) updateStlInfo(); });

const layersEl = $('layers');
for (const l of LAYER_DEFS) {
  const lab = document.createElement('label');
  lab.innerHTML = `<input type="checkbox" ${layerToggles[l.name] ? 'checked' : ''}/> <span class="swatch" style="background:${l.fill ?? l.stroke}"></span> ${l.label}`;
  lab.querySelector('input')!.onchange = (e) => { layerToggles[l.name] = (e.target as HTMLInputElement).checked; };
  layersEl.appendChild(lab);
}

initAnalysis({ site: () => site, log, busy, stage, selectTab, download });
document.querySelectorAll('.needs-data').forEach((s) => s.classList.add('disabled'));
updateMeshSummary();
// Exposed for debugging in the console.
Object.assign(window, { toBNG, toWGS, getSite: () => site, getScene: () => scene, setShape: (r: Ring) => areaMap.onShape(r, bboxOf(r)) });
