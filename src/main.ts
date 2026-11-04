import './style.css';
import { strToU8, zipSync } from 'fflate';
import { buildingAttributesCsv } from './export/attributes';
import { attachListed, fetchListed } from './data/nhle';
import { fetchSite, MAX_AREA_KM2, rasterToAsc, siteToGeoJson, type SiteInputs } from './data/site';
import { parseGridRef, toBNG, toWGS } from './geo/bng';
import { attachParts, buildingHeights, DEFAULT_HEIGHTS, type HeightOptions } from './process/buildings';
import { contourBands, contourLevels, contourLines, type ContourLine } from './process/contours';
import { stepForTriangles, terrainTriangles, type Mesh } from './process/mesh';
import { blur, downsample, hillshade, minMax } from './process/raster';
import {
  DEFAULT_SETTINGS, MODEL_LAYERS, buildScene, layerDef, treesFor, type ModelSettings, type Scene,
} from './process/scene';
import {
  buildDrawing, canvasToPng, defaultLayerToggles, LAYER_DEFS, svgToCanvas, textureCanvas,
  type DrawingFeatures, type Layer,
} from './export/drawing';
import { writeContourStackDxf, writeDxf, writeDxfMesh } from './export/dxf';
import { writeDxf2000 } from './export/dxf2000';
import { restyle, type SchemeId } from './export/layers';
import { svgsToPdf, type PdfPage } from './export/pdf';
import { DEFAULT_BLOCK, fitScale, writeSheet, type Paper } from './export/sheet';
import { buildSection, sectionLayers } from './process/section';
import { writeGlb } from './export/gltf';
import { writeObj } from './export/obj';
import { writeRhino } from './export/rhino';
import { writeThreeMf } from './export/threemf';
import { fuse, unionParts } from './process/solidify';
import { writeStl } from './export/stl';
import { initAnalysis } from './ui/analysis';
import { decodeState, encodeState, friendlyError } from './ui/state';
import { loadImagery, type Imagery } from './data/imagery';
import { applyImagery, pixelsOf } from './process/imagery';
import { buildContext } from './process/context';
import { axonSvg, DEFAULT_AXON } from './export/axon';
import { STYLES, type StyleId } from './export/styles';
import { AreaMap } from './view/map';
import { Viewer3D } from './view/viewer3d';
import { bboxOf, clipPolygonToShape, normaliseShape, polygonArea } from './process/shape';
import type { BBox, Ring, SiteData, XY } from './types';

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
let redLine: Ring | null = null;
let imagery: Imagery | null = null;
const overrides = new Map<string, number>();
let sections: { id: number; label: string; a: XY; b: XY }[] = [];
let activeSection = 0;
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

let busyDepth = 0;

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const b = $('busy');
  busyDepth++;
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
    log(`✖ ${friendlyError(label, e instanceof Error ? e.message : String(e))}`);
    return undefined;
  } finally {
    if (--busyDepth === 0) {
      b.hidden = true;
      document.querySelectorAll('button').forEach((x) => (x.disabled = false));
    }
  }
}

/** Update the busy banner from inside a long task (and let the browser paint it). */
async function stage(msg: string) {
  $('busy').textContent = `${msg}`;
  await tick();
}

/** While a pack is being made, downloads are collected instead of saved. */
let collector: { name: string; blob: Blob }[] | null = null;

function download(name: string, data: BlobPart | Blob, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (collector) { collector.push({ name, blob }); log(`+ ${name} (${(blob.size / 1e6).toFixed(1)} MB)`); return; }
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
    ...(imagery ? [`Imagery supplied by the user (${imagery.name}, ~${imagery.sourceRes.toFixed(2)} m/pixel): ${imagery.licence || 'licence not stated'}`] : []),
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
    pavements: checked('fPavements'),
    earthworks: checked('fEarth'),
    water: checked('fWater'),
    green: checked('fGreen'),
    bridges: checked('fBridges'),
    walls: checked('fWalls'),
    trees: checked('fTrees') ? (sel('treeMode') as ModelSettings['trees']) : 'off',
    roofDetails: true,
    roofWindows: checked('fRoofWin'),
    complexRoofs: checked('fComplex'),
    markings: checked('fMarkings'),
    facades: checked('fFacades'),
    reliefMm: num('reliefMm') || DEFAULT_SETTINGS.reliefMm,
    waterDepthMm: num('waterMm'),
    featureStep: num('featureStep'),
    featureSolids: checked('solids'),
  };
}

function drawingFeatures(): DrawingFeatures {
  const s = readSettings();
  return {
    buildings: s.buildings !== 'off', roads: s.roads, paths: s.paths, pavements: s.pavements, earthworks: s.earthworks, rail: s.rail, water: s.water, green: s.green,
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
  loadOverrides();
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
    attachParts(s.buildings, inputs!.parts);
    for (const b of s.buildings) {
      b.listed = listed.get(b.id);
      const h = overrides.get(b.id);
      if (h) { b.top = b.ground + h; b.source = 'override'; }
    }
    analyseImagery();
    if (settings.buildings === 'lod2' && s.buildings.length > 1500) {
      log(`LOD2 roofs for ${s.buildings.length} buildings can take a minute — raise “LIDAR-roof detail” to 2 m to speed it up.`);
    }
    scene = await buildScene(s, settings, stage);
    for (const n of scene.notes) log(n);
    texture = imagery && checked('imgTexture') ? imagery.canvas : null;
    if (!texture && checked('drape')) {
      await stage('Plan texture…');
      const layers = buildDrawing(s, [], { layers: defaultLayerToggles(), buildingLabels: false });
      texture = await textureCanvas(layers, s.bbox, Math.min(4096, Math.max(1024, (s.bbox.maxE - s.bbox.minE) * 2)));
    }
    if (!viewer) { viewer = new Viewer3D($('view-model')); wirePicking(viewer); }
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
    const named = await solidLayers(sc, baseZ);
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

/** Scene objects for export, optionally with overlapping buildings unioned (manifold-3d). */
async function exportObjects(sc: Scene): Promise<Scene['objects']> {
  if (!checked('solidUnion')) return sc.objects;
  await stage('Merging buildings (manifold)');
  const out: Scene['objects'] = [];
  for (const o of sc.objects) {
    if (o.layer !== 'buildings') { out.push(o); continue; }
    const r = await unionParts(o.mesh, 'buildings_union');
    log(`Union: ${r.merged} buildings merged${r.skipped.length ? `, ${r.skipped.length} skipped (not closed solids)` : ''}.`);
    out.push({ layer: 'buildings', mesh: r.mesh });
  }
  return out;
}

/** Layers for solid-model exports (STL/3MF): closed terrain, and optionally buildings fused into it. */
async function solidLayers(sc: Scene, baseZ: number): Promise<[string, Mesh][]> {
  const objs = await exportObjects(sc);
  const terrain = sc.terrainSolid(baseZ);
  if (!checked('stlFuse')) return [['TERRAIN', terrain], ...objs.filter((o) => o.layer !== 'terrain').map((o) => [layerDef(o.layer).cad, o.mesh] as [string, Mesh])];
  await stage('Fusing buildings into the terrain (manifold)');
  const own = objs.find((o) => o.layer === 'buildings');
  const bu = own ? (checked('solidUnion') ? { mesh: own.mesh } : await unionParts(own.mesh, 'buildings')) : null;
  const fused = await fuse(bu ? [terrain, bu.mesh] : [terrain]);
  log(`Fused ${fused.used} solids into one.`);
  return [['MODEL', fused.mesh], ...objs.filter((o) => o.layer !== 'terrain' && o.layer !== 'buildings').map((o) => [layerDef(o.layer).cad, o.mesh] as [string, Mesh])];
}

async function exportGlb() {
  if (!site) return;
  await busy('Exporting GLB', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    download(`site_${stamp()}_model.glb`, new Blob([writeGlb(await exportObjects(sc))]), 'model/gltf-binary');
  });
}

async function export3mf() {
  if (!site) return;
  await busy('Exporting 3MF', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    const { k, exag, baseZ } = stlParams();
    const layers = await solidLayers(sc, baseZ);
    const objects = layers.map(([name, mesh]) => ({ layer: (MODEL_LAYERS.find((l) => l.cad === name)?.id ?? 'terrain') as never, mesh }));
    download(`site_${stamp()}_1-${num('stlScale')}.3mf`, new Blob([writeThreeMf(objects, { scale: k, zExaggeration: exag, zOffset: baseZ }) as BlobPart]), 'model/3mf');
  });
}

async function export3dm() {
  if (!site) return;
  await busy('Exporting Rhino 3DM', async () => {
    const sc = await ensureModel();
    if (!sc) return;
    const [lo] = minMax(site!.dtm.data);
    const objects = (await exportObjects(sc)).map((o) => (o.layer === 'terrain' && checked('objSolid') ? { ...o, mesh: sc.terrainSolid(lo - 5) } : o));
    const bytes = await writeRhino(objects, site!.buildings, site!.origin, [`Fetched ${site!.fetchedAt}`, 'Sources: EA LIDAR (OGL v3), OpenStreetMap (ODbL)']);
    download(`site_${stamp()}.3dm`, new Blob([bytes as BlobPart]), 'application/octet-stream');
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

type DrawType = 'site' | 'location' | 'roof';

/** Layer visibility for the chosen drawing type (the Layers list is the base; types hide what they don't need). */
function togglesFor(type: DrawType): Record<string, boolean> {
  const t = { ...layerToggles };
  if (type === 'location') {
    for (const k of ['CONTOUR-MINOR', 'CONTOUR-MAJOR', 'CONTOUR-LABEL', 'SPOT-LEVEL', 'BLDG-LABEL', 'ROOF', 'ROOF-PITCH', 'TREES', 'ROAD-MARK', 'ROAD-MARK-Y', 'ROAD-MARK-CYCLE', 'ENTRANCE', 'BOUNDARY']) t[k] = false;
  } else if (type === 'roof') {
    for (const k of ['CONTOUR-MINOR', 'CONTOUR-MAJOR', 'CONTOUR-LABEL', 'SPOT-LEVEL', 'TREES', 'ROAD-MARK', 'ROAD-MARK-Y', 'ROAD-MARK-CYCLE', 'GREEN', 'WOOD', 'PAVED', 'PATH']) t[k] = false;
    t.ROOF = true; t['ROOF-PITCH'] = true; t['BLDG-LABEL'] = true;
  }
  return t;
}

/** The red line for a location plan: the drawn polygon, else the site outline. */
function effectiveRedLine(): Ring {
  if (redLine) return redLine;
  const b = site!.bbox;
  return site!.shape ?? [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN]];
}

function drawingLayers(type: DrawType = sel('drawType') as DrawType): Layer[] {
  const toggles = togglesFor(type);
  const contours = toggles['CONTOUR-MINOR'] || toggles['CONTOUR-MAJOR'] || toggles['CONTOUR-LABEL'] ? getContours() : [];
  return buildDrawing(site!, contours, {
    layers: toggles, buildingLabels: toggles['BLDG-LABEL'], features: drawingFeatures(),
    redLine: type === 'location' ? effectiveRedLine() : redLine,
  });
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

const TITLES: Record<DrawType, [string, string, number]> = {
  site: ['Site plan', 'SP', 0], location: ['Site location plan', 'SLP', 1250], roof: ['Roof plan', 'RP', 0],
};

function titleBlock(title: string, suffix = '') {
  return {
    ...DEFAULT_BLOCK, project: $('tbProject').value, title: title + suffix, number: $('tbNumber').value, drawnBy: $('tbBy').value,
    revision: $('tbRev').value, status: sel('tbStatus'), checkedBy: $('tbChecked').value, approvedBy: $('tbApproved').value, client: $('tbClient').value,
  };
}

function sheetSpec(scale: number, title: string, suffix = '') {
  return { paper: sel('paper') as Paper | 'auto', scale, block: titleBlock(title, suffix), legend: checked('sheetLegend'), grid: checked('sheetGrid'), notes: [`Heights in metres above ODN. Coordinates: British National Grid.`, ...(imagery ? [`Imagery: ${imagery.licence || imagery.name}`] : [])] };
}

/** One plan sheet (SVG at paper size). The location plan defaults to 1:1250, and any plan falls back to a scale that fits. */
function planSheet(type: DrawType) {
  const s = site!;
  const [title, , defScale] = TITLES[type];
  let scale = type === 'site' || type === 'roof' ? num('drawScale') : defScale;
  const ew = s.bbox.maxE - s.bbox.minE, eh = s.bbox.maxN - s.bbox.minN;
  const paper = sel('paper') as Paper | 'auto';
  const fit = fitScale(ew, eh, paper === 'auto' ? 'A0' : paper);
  if (scale < fit) { log(`${title}: 1:${scale} doesn't fit ${paper === 'auto' ? 'A0' : paper}; using 1:${fit}.`); scale = fit; }
  const r = writeSheet(drawingLayers(type), s.bbox, sheetSpec(scale, title), {
    underlay: imagery && checked('imgUnderlay') ? imagery.canvas.toDataURL('image/jpeg', 0.85) : checked('hillshade') || STYLES[sel('drawStyle') as StyleId].hillshade > 1 ? hillshadeDataUrl() : undefined, shape: s.shape,
    style: STYLES[sel('drawStyle') as StyleId],
  });
  $('sheetInfo').textContent = `${title}: ${r.layout.paper} ${r.layout.landscape ? 'landscape' : 'portrait'} at 1:${scale}${r.layout.fits ? '' : ' — does not fit: raise the scale'}`;
  return { ...r, scale, title };
}

/** Section / elevation sheet for one cut line. */
function sectionSheet(sec: { label: string; a: XY; b: XY }) {
  const s = site!;
  const opt = { mode: sel('secMode') as 'section' | 'elevation', depth: num('secDepth'), exaggeration: num('secExag') || 1, spacing: 0.5, label: sec.label };
  const data = buildSection(s, treesFor(s, readSettings().trees), sec.a, sec.b, opt);
  const { layers, bbox } = sectionLayers(data, opt);
  const scale = Math.max(100, fitScale(bbox.maxE - bbox.minE, (bbox.maxN - bbox.minN) / opt.exaggeration, (sel('paper') as Paper | 'auto') === 'auto' ? 'A3' : (sel('paper') as Paper)));
  const name = opt.mode === 'section' ? `Section ${sec.label}–${sec.label}` : `Elevation ${sec.label}–${sec.label}`;
  const r = writeSheet(layers, bbox, { ...sheetSpec(scale, name), grid: false, notes: [`Looking left of the line A→B. Vertical exaggeration ×${opt.exaggeration}.`, 'Levels in metres above ODN.'] }, { style: STYLES[sel('drawStyle') as StyleId] });
  return { ...r, layers, bbox, scale, name, data };
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
    el.innerHTML = planSheet(sel('drawType') as DrawType).svg;
    const svg = el.querySelector('svg')!;
    svg.style.width = 'min(96%, 1400px)';
    selectTab('drawing');
  });
}

async function exportSvg() {
  if (!(await prepareDrawing())) return;
  const type = sel('drawType') as DrawType;
  await busy('Exporting SVG', async () => {
    const r = planSheet(type);
    download(`site_${stamp()}_${type}_1-${r.scale}.svg`, r.svg, 'image/svg+xml');
  });
}

async function exportPng() {
  if (!(await prepareDrawing())) return;
  const type = sel('drawType') as DrawType;
  await busy('Exporting PNG', async () => {
    const r = planSheet(type);
    const canvas = await svgToCanvas(r.svg, { dpi: num('dpi') });
    download(`site_${stamp()}_${type}_1-${r.scale}_${num('dpi')}dpi.png`, await canvasToPng(canvas));
  });
}

/** DXF text for layers with the chosen version and layer standard. */
function dxfFor(layers: Layer[], box: BBox, origin: XY, scale: number): string {
  const styled = restyle(layers, sel('layerScheme') as SchemeId, $('layerPrefix').value.trim());
  return sel('dxfFormat') === 'r2000' ? writeDxf2000(styled, box, { origin, scale }) : writeDxf(styled, box, { origin, scale });
}

async function exportDxf() {
  if (!(await prepareDrawing())) return;
  await busy('Exporting DXF', async () => {
    const local = sel('dxfOrigin') === 'local';
    const dxf = dxfFor(drawingLayers(), site!.bbox, local ? site!.origin : [0, 0], num('drawScale'));
    download(`site_${stamp()}_${local ? 'local' : 'bng'}_${sel('dxfFormat')}.dxf`, dxf, 'application/dxf');
  });
}

/** Multi-page PDF: location plan (if a red line exists), site plan, roof plan (if roofs were fitted), and every section. */
async function exportPdf() {
  if (!(await prepareDrawing())) return;
  await busy('Building PDF pack', async () => {
    const pages: PdfPage[] = [];
    // PDF has no SVG filters (shadows, pencil wobble): pages keep patterns and colours but drop them.
    const push = (r: { svg: string; layout: { w: number; h: number } }) => pages.push({ svg: r.svg.replace(/ filter="url\(#[^"]+\)"/g, ''), w: r.layout.w, h: r.layout.h });
    if (redLine) push(planSheet('location'));
    push(planSheet('site'));
    if (site!.buildings.some((b) => b.roofParts || b.roof)) push(planSheet('roof'));
    for (const sec of sections) push(sectionSheet(sec));
    await stage(`Writing ${pages.length} PDF page${pages.length > 1 ? 's' : ''}`);
    download(`site_${stamp()}_drawings.pdf`, await svgsToPdf(pages), 'application/pdf');
  });
}

// ---- section list
function renderSections() {
  const el = $('sectionList');
  el.innerHTML = '';
  sections.forEach((sec) => {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="radio" name="sec" ${sec.id === activeSection ? 'checked' : ''}/> ${sec.label}–${sec.label} <span class="hint">${Math.hypot(sec.b[0] - sec.a[0], sec.b[1] - sec.a[1]).toFixed(0)} m</span><button title="Remove">✕</button>`;
    lab.querySelector('input')!.onchange = () => { activeSection = sec.id; refreshCuts(); };
    lab.querySelector('button')!.onclick = (e) => { e.preventDefault(); sections = sections.filter((q) => q.id !== sec.id); renderSections(); refreshCuts(); };
    el.appendChild(lab);
  });
  if (!sections.find((q) => q.id === activeSection) && sections[0]) activeSection = sections[0].id;
}

function refreshCuts() { areaMap.setCuts(sections, activeSection); }

const currentSection = () => sections.find((q) => q.id === activeSection);

async function secPreview() {
  const sec = currentSection();
  if (!site || !sec) return log('Draw a cut line on the map first.');
  await busy('Rendering section', async () => {
    const el = $('view-drawing');
    el.innerHTML = sectionSheet(sec).svg;
    el.querySelector('svg')!.style.width = 'min(96%, 1400px)';
    selectTab('drawing');
  });
}

async function secSvg() {
  const sec = currentSection();
  if (!site || !sec) return log('Draw a cut line on the map first.');
  await busy('Exporting section', async () => { const r = sectionSheet(sec); download(`site_${stamp()}_${r.name.replace(/\W+/g, '_')}.svg`, r.svg, 'image/svg+xml'); });
}

async function secDxf() {
  const sec = currentSection();
  if (!site || !sec) return log('Draw a cut line on the map first.');
  await busy('Exporting section DXF', async () => {
    const r = sectionSheet(sec);
    // Chainage along X, level (x exaggeration) along Y, in metres.
    download(`site_${stamp()}_${r.name.replace(/\W+/g, '_')}.dxf`, dxfFor(r.layers, r.bbox, [0, 0], r.scale), 'application/dxf');
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


// ---------------------------------------------------------------- imagery, picking, packs, links, shortcuts
/** Vegetation, roof colours and road paint from the user's image (when ticked and a site exists). */
function analyseImagery() {
  if (!site) return;
  if (!imagery || !checked('imgAnalyse')) { site.vegetation = null; site.detectedMarkings = undefined; return; }
  log(applyImagery(site, pixelsOf(imagery.canvas, imagery.bbox), buildContext(site).roads));
}
$('imgFile').onchange = async () => {
  const files = Array.from(($('imgFile') as HTMLInputElement).files ?? []);
  if (!files.length) return;
  await busy('Loading imagery', async () => {
    try {
      imagery = await loadImagery(files, bbox, $('imgLicence').value.trim());
      $('imgStatus').textContent = `${imagery.name}: ~${imagery.sourceRes.toFixed(2)} m/pixel. ${imagery.note ?? ''} Rebuild the model to texture the terrain.`;
      log(`Imagery loaded (${imagery.name}). ${imagery.note ?? ''}`);
      analyseImagery();
      if (scene) markStale();
    } catch (e) {
      imagery = null;
      $('imgStatus').textContent = '';
      log(`✖ ${e instanceof Error ? e.message : e}`);
    }
  });
};

const safeId = (id: string) => id.replace(/[^\w#-]/g, '_');
const ovKey = () => `ukdtm.ov.${bbox.minE},${bbox.minN},${bbox.maxE},${bbox.maxN}`;
function loadOverrides() {
  overrides.clear();
  try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(ovKey()) ?? '{}') as Record<string, number>)) overrides.set(k, v); } catch { /* ignore */ }
}
function saveOverrides() {
  try { localStorage.setItem(ovKey(), JSON.stringify(Object.fromEntries(overrides))); } catch { /* ignore */ }
}

function showBuilding(part: string | null) {
  const panel = $('bldPanel');
  if (!part || !site) { panel.hidden = true; return; }
  const b = site.buildings.find((q) => `building_${safeId(q.id)}` === part) ?? site.buildings.find((q) => part.startsWith(`building_${safeId(q.id)}_`));
  if (!b) { panel.hidden = true; return; }
  const rows: [string, string][] = [
    ['OSM id', b.id], ['Name', b.tags.name ?? '–'], ['Address', [b.tags['addr:housenumber'], b.tags['addr:street']].filter(Boolean).join(' ') || '–'],
    ['Storeys', b.tags['building:levels'] ?? '–'], ['Ground', `${b.ground.toFixed(2)} m ODN`], ['Top', `${b.top.toFixed(2)} m ODN`],
    ['Height', `${(b.top - b.ground).toFixed(1)} m (${b.source})`],
    ['Roof', (b.roofParts ?? (b.roof ? [b.roof] : [])).map((r) => r.type).join(' + ') || 'flat block'],
    ['Listed', b.listed ? `Grade ${b.listed.grade} · ${b.listed.name}` : '–'],
  ];
  panel.innerHTML = `<h4>Building</h4><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v.replace(/</g, '&lt;')}</td></tr>`).join('')}</table>` +
    `<div class="row"><input id="ovH" type="number" step="0.5" min="2" placeholder="override height (m)" value="${overrides.get(b.id) ?? ''}" />` +
    `<button id="ovApply">Apply</button><button id="ovClear" title="Back to the LIDAR height">Reset</button></div>`;
  panel.hidden = false;
  const apply = (h: number | null) => { h ? overrides.set(b.id, h) : overrides.delete(b.id); saveOverrides(); markStale(); log(h ? `Height of ${b.id} set to ${h} m — press “Update model”.` : `Height of ${b.id} reset — press “Update model”.`); };
  ($('ovApply') as HTMLElement).onclick = () => apply(Number($('ovH').value) || null);
  ($('ovClear') as HTMLElement).onclick = () => apply(null);
}

function wirePicking(v: Viewer3D) {
  let down: [number, number] | null = null;
  v.canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  v.canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const hit = v.pick(e.clientX, e.clientY);
    showBuilding(hit?.layer === 'buildings' ? hit.part : null);
  });
}

/** Packs: run the individual exports with downloads collected, then save one zip with a README. */
const PACKS: Record<string, { title: string; run: () => Promise<void>; about: string }> = {
  planning: { title: 'planning-drawings', about: 'Multi-page PDF (location plan if a red line is drawn, site plan, roof plan, sections), R2000 DXF with layers/lineweights/attributes, and the site plan as SVG.', run: async () => { await exportPdf(); await exportDxf(); await exportSvg(); } },
  cad: { title: 'cad-context-model', about: 'Rhino 3DM (layers, named objects, user text), AutoCAD polyface-mesh DXF, the 2D DXF drawing, and buildings.csv.', run: async () => { await export3dm(); await exportDxf3d(); await exportDxf(); if (site) download('buildings.csv', buildingAttributesCsv(site), 'text/csv'); } },
  print: { title: '3d-print', about: 'Per-layer STL (closed solids, mm at your model scale) and a coloured 3MF.', run: async () => { await exportStl(); await export3mf(); } },
  laser: { title: 'laser-cut', about: 'Contour-stack DXF in millimetres at model scale.', run: async () => { await exportLaser(); } },
};

async function runPack(kind: string) {
  const pack = PACKS[kind];
  if (!site || !pack) return;
  collector = [];
  try {
    await busy(`Building ${pack.title} pack`, pack.run);
  } finally {
    const files = collector;
    collector = null;
    if (files.length) {
      const entries: Record<string, Uint8Array> = {};
      for (const f of files) entries[f.name] = await blobBytes(f.blob);
      entries['README.txt'] = strToU8(readme(`Pack: ${pack.title}\n${pack.about}\n\nFiles:\n${files.map((f) => `- ${f.name}`).join('\n')}`));
      download(`site_${stamp()}_${pack.title}.zip`, new Blob([zip(entries, 0) as BlobPart]));
    } else log('The pack produced no files — see the messages above.');
  }
}
document.querySelectorAll<HTMLElement>('[data-pack]').forEach((b) => (b.onclick = () => runPack(b.dataset.pack!)));

function shareState() {
  const settings: Record<string, string | boolean> = {};
  document.querySelectorAll<HTMLInputElement>('[data-persist]').forEach((el) => { settings[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  return { v: 1 as const, bbox, shape, redLine, cuts: sections.map((q) => ({ a: q.a, b: q.b })), settings };
}

$('copyLink').onclick = async () => {
  const hash = encodeState(shareState());
  history.replaceState(null, '', hash);
  try { await navigator.clipboard.writeText(location.href); log('Link copied: it reopens this site, shape, sections and settings.'); }
  catch { log(`Link (copy it from the address bar): ${location.href}`); }
};

/** Reopen a shared site: settings first, then geometry. */
function restoreShare(): boolean {
  const st = decodeState(location.hash);
  if (!st) return false;
  for (const [id, v] of Object.entries(st.settings)) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el?.hasAttribute('data-persist')) { if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v); }
  }
  shape = st.shape ?? null;
  setBBox(st.bbox, false, true);
  areaMap.fitArea(st.bbox);
  if (st.redLine) { redLine = st.redLine; areaMap.setRedLine(st.redLine); }
  sections = (st.cuts ?? []).map((c, i) => ({ id: i + 1, label: String.fromCharCode(65 + (i % 26)), a: c.a, b: c.b }));
  activeSection = sections[0]?.id ?? 0;
  renderSections();
  refreshCuts();
  log('Opened a shared site. Press “Fetch & align data” to load it.');
  return true;
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === '?' || k === 'h') { ($('helpDlg') as unknown as HTMLDialogElement).showModal(); return; }
  const views: Record<string, 'iso' | 'top' | 'south' | 'east'> = { i: 'iso', t: 'top', s: 'south', e: 'east' };
  if (views[k] && viewer) { selectTab('model'); viewer.setView(views[k]); }
});
$('helpBtn').onclick = () => ($('helpDlg') as unknown as HTMLDialogElement).showModal();

// ---------------------------------------------------------------- UI wiring
function selectTab(name: string) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'map') areaMap.map.resize();
}

log(`Build ${__BUILD__}`);
const start = PRESETS[0];
const areaMap = new AreaMap($('view-map'), [start.lon, start.lat]);
areaMap.onChange = () => { /* shape tools report through onShape */ };

areaMap.map.on('load', () => {
  if (restoreShare()) { loadOverrides(); return; }
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
$('exportGlb').onclick = exportGlb;
$('export3mf').onclick = export3mf;
$('export3dm').onclick = export3dm;
$('previewDrawing').onclick = previewDrawing;
$('exportSvg').onclick = exportSvg;
$('exportPng').onclick = exportPng;
$('exportDxf').onclick = exportDxf;
$('exportPdf').onclick = exportPdf;
$('exportAxon').onclick = async () => {
  if (!site) return;
  await ensureModel();
  await busy('Drawing the axonometric', async () => {
    const r = axonSvg(scene!, site!.origin, { ...DEFAULT_AXON, style: STYLES[sel('drawStyle') as StyleId], block: titleBlock('Axonometric view') });
    if (r.skipped.length) log(`Axonometric: skipped ${r.skipped.join(', ')} (too many faces for one SVG: raise the feature cell size or use a smaller site).`);
    const el = $('view-drawing');
    el.innerHTML = r.svg;
    el.querySelector('svg')!.style.width = 'min(96%, 1400px)';
    selectTab('drawing');
    download(`site_${stamp()}_axonometric.svg`, r.svg, 'image/svg+xml');
    log(`Axonometric: ${r.polygons.toLocaleString()} faces.`);
  });
};
$('drawRedLine').onclick = () => { selectTab('map'); areaMap.setTool('polygon', 'redline'); log('Red line: click each corner, double-click or Enter to finish.'); };
$('clearRedLine').onclick = () => { redLine = null; areaMap.setRedLine(null); };
areaMap.onRedLine = (ring) => { redLine = normaliseShape(ring); };
$('drawCut').onclick = () => { selectTab('map'); areaMap.setTool('cut'); log('Cut line: click the start (A), then the end (B). The view looks to the left of A→B.'); };
areaMap.onCutSelect = (id) => { activeSection = id; renderSections(); refreshCuts(); log(`Section ${sections.find((q) => q.id === id)?.label ?? ''}–${sections.find((q) => q.id === id)?.label ?? ''} selected.`); };
areaMap.onCut = (a, b) => {
  const id = (sections.at(-1)?.id ?? 0) + 1;
  const label = String.fromCharCode(64 + ((id - 1) % 26) + 1);
  sections.push({ id, label, a, b });
  activeSection = id;
  renderSections();
  refreshCuts();
  log(`Cut line ${label}–${label} added (${Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(0)} m).`);
};
$('secPreview').onclick = secPreview;
$('secSvg').onclick = secSvg;
$('secDxf').onclick = secDxf;
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
Object.assign(window, { toBNG, toWGS, getSite: () => site, getScene: () => scene, setShape: (r: Ring) => areaMap.onShape(r, bboxOf(r)), setRedLine: (r: Ring) => { areaMap.setRedLine(r); areaMap.onRedLine(r); }, addCut: (a: XY, b: XY) => areaMap.onCut(a, b) });
