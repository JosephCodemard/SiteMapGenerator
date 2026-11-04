# Handoff: UK Site Model, iteration 1

_Status as of 2026-11-04. Iteration 1 (sections 1–6) was committed first; **iteration 2 (phases B and C, plus the UI rework) is described in section 7** and is committed on `main`._

_Iteration 3 (PLAN.md milestones M1–M6) is done: see sections 7b–7g. **Iteration 4 (roofs, infrastructure, drawings, section-picking bug) is section 7h.** What remains is listed in section 8, 7g's and 7h's "not done" lists._

## 1. Goal and context

- **What it is:** a static web app (GitHub Pages, free, no backend) for **architects** to produce site models and drawings for **England**, with Bath as the focus area.
- **Target tools:** AutoCAD and Rhino now, Revit later.
- **Workflows:** laser cutting and 3D printing are first-class, alongside CAD drawings.
- **Size limit:** up to 4 km² per site in the browser is acceptable. Larger sites may later go to a desktop app.
- **Detail level:** the user picks it. LOD1 blocks now, real roof shapes (LOD2) later.
- **Planned later:** satellite/aerial imagery, and inferring trees and other features from LIDAR plus imagery.

Iteration 1 scope was: fetch the core datasets and align them into one dataset, preview as a WebGL mesh, export STL/OBJ, and produce basic contour, footprint and road drawings. **That scope is complete.** Section 3 lists extras that were added along the way.

## 2. Verified facts about the data sources

All of these were checked live during development.

| Source | Endpoint / ID | Verified |
|---|---|---|
| EA LIDAR Composite **DTM** 1 m | `https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs`, CoverageId `13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m` | CORS `*`. Accepts WCS 2.0.1 `subset=E(..)&subset=N(..)`, returns a float32 GeoTIFF in EPSG:27700. Nodata `-3.4028e38`. 1 km² ≈ 4 MB in ≈ 2–5 s. A 4×4 km single request also works (67 MB, 16 s). |
| EA LIDAR Composite **DSM** (first return) 1 m | `.../lidar-composite-digital-surface-model-first-return-dsm-1m/wcs`, CoverageId `df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m` | Same behaviour as the DTM |
| EA hillshade WMS | `.../lidar-composite-digital-terrain-model-dtm-1m/wms`, layer `Lidar_Composite_Hillshade_DTM_1m` | Supports EPSG:3857; used as an on-map overlay |
| EA survey index | `.../spatialdata/survey-index-files/wfs` and `/ogc/features/v1` | Linked from the dataset page. **Not used yet**: likely gives the survey year per area (see next steps). |
| Overpass API | `https://overpass-api.de/api/interpreter` (mirrors: `overpass.private.coffee`, `overpass.kumi.systems`) | Main server: CORS `*`, works from browsers. **Unreliable:** 30 s to 3.6 min per query, sometimes 502/504 "at capacity". Both mirrors timed out from the dev machine, so whether they work is **unknown**. Plain curl's default User-Agent gets a 406; browsers are fine. |
| postcodes.io | `https://api.postcodes.io/postcodes/{pc}` | Returns `eastings` / `northings` directly. **Not exercised in the e2e test.** |
| OSTN15 | `https://cdn.proj.org/uk_os_OSTN15_NTv2_OSGBtoETRS.tif` (build-time only) | Baked into `src/geo/ostn15-correction.json`, a 5 km grid of (OSTN15 − Helmert) shifts. Interpolation error: mean 0.7 cm, max 12 cm. Tests match pyproj OSTN15 to < 5 cm. Helmert alone is only 0.37 m out in Bath. |

**OSM content in central Bath (Abbey, 500×500 m):** 667 buildings (only 2 of 500 have `height`, 19 have `building:levels`), about 590 lines (roads, paths, rivers), about 48 areas, 11 tree points.
**2×2 km Central Bath:** 5,846 buildings, 3,068 lines, 320 areas, 29 rail ways, 66 bridges.

## 3. What was built

```
src/
  main.ts              UI controller: state, busy/log, exports, wiring
  types.ts             BBox, Raster (north-up, cell centres), features, Building, SiteData
  geo/bng.ts           toBNG / toWGS (proj4 Helmert + OSTN15 table), grid-ref parser
  data/lidar.ts        WCS fetch in 1 km chunks, 4 in parallel, retries, mosaic, nodata -> NaN
  data/osm.ts          Overpass query (failover, backoff, 90 s timeout per request),
                       parseOsm (classify + clip), shiftAndClip
  data/site.ts         fetchSite orchestration (padded OSM, gap fill, alignment, heights);
                       ASC + GeoJSON dataset export
  process/clip.ts      exact polygon∩box (polygon-clipping), Liang-Barsky polylines,
                       point-in-polygon, signed area
  process/raster.ts    fillNoData, bilinear sample, downsample, box blur, hillshade
  process/align.ts     estimateOffset: OSM -> LIDAR roof shift (±3 m)
  process/buildings.ts LOD1 heights: DTM min ground, DSM percentile top, OSM fallback
  process/mesh.ts      terrain grid mesh (+ optional watertight skirt/base), building prisms (earcut)
  process/contours.ts  own marching squares -> joined, simplified polylines; d3-contour bands for laser
  export/obj.ts        OBJ + MTL, per-building objects, Z- or Y-up, texture UVs
  export/stl.ts        binary STL with scale / exaggeration / z offset
  export/dxf.ts        R12 (AC1009) writer: layers, POLYLINE with elevation/thickness, TEXT, CIRCLE;
                       laser contour stack
  export/drawing.ts    layer model (LAYER_DEFS), buildDrawing, SVG sheet (scale bar, north arrow,
                       attribution), SVG->canvas/PNG, 3D ground texture
  view/map.ts          MapLibre basemap, BNG-aligned rectangle drawing, LIDAR overlay
  view/viewer3d.ts     three.js preview (Z-up, OrbitControls, exaggeration)
  process/geom.ts      MeshBuilder (welding), closed solids from surfaces, grid draping, rasterising polygons  [iter 2]
  process/buffer.ts    centreline -> polygon buffering and unions (Clipper)  [iter 2]
  process/context.ts   merged road/path/rail/water polygons, bridge and wall lines  [iter 2]
  process/ribbon.ts    ribbon solids along polylines (bridge decks, walls)  [iter 2]
  process/roofs.ts     LOD1.5 roof fitting and meshes, LOD2-raw roofs  [iter 2]
  process/trees.ts     canopy-model tree detection, low-poly tree meshes  [iter 2]
  process/scene.ts     layers, ModelSettings, buildScene (everything the exporters and viewer consume)  [iter 2]
tests/core.test.ts     22 unit tests (CRS, clipping, watertightness/volume, heights, contours,
                       alignment, OSM parsing, STL/DXF)
tools/build_ostn15_correction.py   regenerates the OSTN15 table
tools/e2e/drive.mjs                Playwright smoke test (headless Chromium, live services)
tools/validate/check_exports.py    trimesh/ezdxf checks of exported STL/DXF
tools/validate/check_alignment.py  independent check of OSM vs LIDAR alignment
.github/workflows/deploy.yml       test -> build -> GitHub Pages
```

**Stack:**
- Vite 8, TypeScript 7
- MapLibre GL 6, three 0.187
- geotiff 3, proj4 2.22
- earcut 3, d3-contour 4, osmtogeojson 3 beta, polygon-clipping 0.15, fflate
- clipper-lib 6 (buffering/unions, added in iteration 2)

**Key decisions:**
- **Coordinates:** everything internal is BNG metres with ODN heights.
  - OBJ/STL use a local origin (site centre rounded to 10 m, written to `origin.txt`).
  - DXF defaults to true BNG, so it overlays OS mapping.
- **Site rectangle:** BNG-aligned and snapped to whole metres, so it lines up with the LIDAR grid. On the Web Mercator map it looks very slightly rotated.
- **OSM fetch margin:** OSM is fetched 5 m beyond the site, shifted by the estimated offset, then clipped exactly.
- **LOD1 block heights:**
  - Ground = lowest DTM value under the footprint, sunk 0.5 m.
  - Top = DSM percentile inside the footprint: 70th (typical roof), 40th (eaves), or 95th (ridge).
  - LIDAR heights are rejected if under 2 m or over 120 m above ground. Fallbacks: OSM `height`, then `building:levels`×3 + 1, then 7 m.
- **Terrain mesh:** a regular grid; the auto step keeps it under about 1 M vertices (2 m at 4 km²). No decimation yet.

**End-to-end performance** (headless Chromium, Abbey 0.25 km² and Central Bath 4 km²):

| | 0.25 km² | 4 km² |
|---|---|---|
| Fetch + model | ≈ 32–48 s | ≈ 40 s |
| STL size | 26 MB | 106 MB |
| PNG at 300 dpi, 1:1000 | 5 MB | 73 MB |
| DXF writer | — | 23 MB in 0.3 s (synthetic benchmark) |

Fetch time is dominated by Overpass when it's busy; LIDAR is ≈ 5 s.

## 4. Errors found, with root cause and fix

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Map never fired `load`; "Worker failed to load" | MapLibre 6 loads an ES-module worker by a URL that Vite's dependency pre-bundling breaks | `setWorkerUrl()` with `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` plus `worker: { format: 'es' }` in `vite.config.ts`. Verified in dev **and** the production build. |
| 2 | OSM returned 0 features although Overpass sent 800 KB | osmtogeojson 3.x defaults to `flatProperties: true`, so `properties.tags` was undefined | `osmtogeojson(raw, { flatProperties: false })`; regression test added |
| 3 | Footprints sat ≈ 1.75 m west of LIDAR roofs (≈ 1.0 m over 2×2 km) | Imagery offset in OSM tracing. The conversion maths was ruled out: it matches pyproj OSTN15. | `process/align.ts` estimates the shift from LIDAR roofs and applies it to all OSM features. Independent check: residual best offset 0.00 m with a symmetric score. UI toggle "Auto-align OSM to LIDAR"; the shift is shown in the summary and in the export `README.txt`. |
| 3a | Alignment estimate quantised to 1 m (test wanted 1.5, got 2 then 1) | Centre-point footprint mask, plus bilinear sampling of a binary roof mask gives a flat-topped score | 4×4 supersampled coverage on edge cells, a light blur of the roof mask, and the centroid of the near-max plateau. Unit test recovers (1.5, 1.0) m. |
| 4 | Non-watertight building at the site edge (courtyard) | Hole clipped by the site boundary shared an edge with the outer ring | Exact clipping with `polygon-clipping`; the courtyard becomes a notch. Test added. |
| 5 | Another non-watertight concave building at the edge | Sutherland–Hodgman clipping leaves zero-width slivers on concave polygons | Same fix (#4); "C-shape" test added |
| 6 | Contour line along the raster edge | A level exactly equal to the grid minimum is degenerate | Skip levels ≤ min or ≥ max |
| 7 | Hillshade lit wrongly (caught before the first run) | Altitude used where zenith belongs; y-gradient sign | Rewritten to the standard ESRI formula |
| 8 | TypeScript: `maplibre-gl` has no default export | MapLibre 6 API change | Named imports |
| 9 | One 4 km² fetch failed: "Overpass unavailable" | Overpass at capacity, mirrors unreachable | OSM failure is now **non-fatal**: terrain still builds, with a warning to refetch. Each request has a 90 s timeout so a hung server fails over. |
| 10 | Validator reported 2 of 647 STL bodies open | **False positive.** STL has no connectivity; trimesh welds vertices of *overlapping OSM buildings* | Per-object check on the OBJ: 644 of 644 buildings closed and outward-facing, terrain closed. Overlapping shells remain in the STL; slicers merge them. |

## 5. Known limitations and untested items

**Not tested:**
- Real imports into **AutoCAD and Rhino**. DXF passed `ezdxf` audit (0 errors) and STL/OBJ passed trimesh checks, but neither was opened in the actual applications. Also check OBJ texture orientation in Rhino, and the Y-up OBJ in Blender/SketchUp.
- The browser test (`tools/e2e/drive.mjs`) did **not** exercise:
  - mouse rectangle drawing
  - postcode or grid-reference search
  - the "stacked" laser layout
  - DXF local-origin mode
  - the "OSM tags first" height mode

**Platform risks:**
- **Safari/iOS canvas limits:** `svgToCanvas` caps at 200 M px, but Safari's limit is about 16.7 M px, so large PNG exports will fail there. The fix is to cap per browser or render in tiles.
- **Main thread:** all processing runs on it, so the UI freezes for several seconds on 4 km² sites. Move the work to Web Workers (Comlink).

**Data quality:**
- **Overpass reliability** is the biggest real-world risk (see next steps, item A).
- **Survey dates vary:** the DSM/DTM composite is a mosaic of surveys from different years. 73 of 5,799 buildings in Central Bath fell back to the default 7 m height, which suggests a mismatch between the LIDAR date and OSM (new builds, demolitions) or very small structures. The survey year isn't shown yet.
- **Overlapping OSM buildings** (building + part, duplicates) produce overlapping solids. No union is done.

**Feature gaps** (iteration 1 list; the first, second and fourth were closed in iteration 2, see section 7):
- ~~The 3D export contains only terrain + buildings.~~ Now one layer per feature class.
- ~~Roads and rail are centrelines in drawings.~~ Now kerb outlines, with centrelines on optional layers.
- DXF is R12: no HATCH fills, no LWPOLYLINE, no true colour.
- ~~Tree symbols are plain circles.~~ Now crown-radius symbols; DXF uses a TREE block.

**Housekeeping:**
- **OSM tile usage policy:** `tile.openstreetmap.org` is fine for light use, but should be swapped (e.g. OpenFreeMap or OS Maps API) if traffic grows.
- **No caching between sessions:** add IndexedDB caching of LIDAR tiles and OSM responses.

## 6. How to run and verify

```bash
npm install
npm run dev                 # http://localhost:5173
npm test                    # 156 unit tests
npm run build               # dist/ (relative base, works under /<repo>/)

# Optional end-to-end test (live services):
npm i -D playwright && npx playwright install chromium
node tools/e2e/drive.mjs /tmp/e2e-out            # or pass a URL as the 2nd arg
# Validate outputs (Python: numpy trimesh networkx ezdxf scipy shapely):
python tools/validate/check_exports.py /tmp/e2e-out
unzip /tmp/e2e-out/site_*_data.zip -d /tmp/e2e-data && python tools/validate/check_alignment.py /tmp/e2e-data
```

In headless Chromium, WebGL needs `--use-angle=swiftshader --enable-unsafe-swiftshader`; the driver already passes these.

**Deploy:** push to GitHub, then set *Settings → Pages → Source = GitHub Actions*.

---

## 7. Iteration 2: phases B and C (done 2026-11-04)

### 7.1 What the user asked for, and where it lives

| Priority | Delivered | Code |
|---|---|---|
| 1. More detail (roads, bridges, rivers, roofs, trees), each optional | Roads/paths/rail from buffered centrelines; rivers and water as polygons with the terrain carved; bridge decks from the DSM; walls/fences; LOD1 / LOD1.5 / LOD2-raw roofs; trees detected from LIDAR (or OSM points). Each has its own checkbox in the UI and applies to 3D **and** drawings. | `process/buffer.ts`, `context.ts`, `ribbon.ts`, `roofs.ts`, `trees.ts`, `scene.ts` |
| 2. Separate objects and layers | `Scene` = one object per layer (`MODEL_LAYERS`), parts = one per building/tree/bridge/wall. OBJ: groups + materials, one file per layer or combined. STL: one file per layer. DXF 3D: polyface meshes on named layers. Drawings: kerb lines, water polygons, bridge decks, roof lines, tree blocks on separate layers. | `export/obj.ts`, `stl.ts`, `dxf.ts` (`writeDxfMesh`), `drawing.ts` |
| 3. Mesh size | Terrain: step or triangle budget (0.1–4 M), box-averaged when coarsened. Features: draped cell size 1–8 m. LOD2 roofs: DSM downsampling. Closed solids vs open surfaces. Live triangle counts per layer. | `process/mesh.ts` (`terrainGrid`, `stepForTriangles`), `scene.ts` |
| 4. UI | Four numbered steps (Site, Data, Model, Export); a feature checklist with per-feature options; quick presets (Presentation, 3D print, CAD context, Terrain only); mesh-size panel with a live triangle estimate; per-layer legend/visibility in the 3D view; stale-model highlighting (exports rebuild automatically); settings remembered in localStorage; load-your-own-OSM-file. Still vanilla TypeScript. | `index.html`, `main.ts`, `style.css`, `view/viewer3d.ts` |

### 7.2 C3 (LOD2.2) answer

**Not possible in the browser.** roofer is a C++ reconstructor, the input is the EA LIDAR *point cloud* (multi-GB LAZ tiles; the WCS only serves rasters, and the portal downloads aren't CORS-readable), and robust plane segmentation on 1 m rasters is not a substitute. Recommendation: a desktop app (or the offline Bath pipeline in H) that runs roofer and writes tiled CityJSON/glTF. The web app already has the extension point: per-building meshes with names, so a pre-baked LOD2.2 tile can replace `buildBuildings()` in `process/scene.ts`.

### 7.3 Key design decisions

- **One geometry kernel (`process/geom.ts`).**
  - `MeshBuilder` welds vertices on a 1/1024 m grid, so different code paths that compute the same point agree.
  - `solidWithFlatFloor` / `solidWithMirrorFloor` close any open surface into a solid from its boundary loops. Buildings and pads share this.
  - `drapeSurface` triangulates a polygon (earcut) and cuts each triangle along the terrain grid lines using canonical intersections, so neighbours share vertices (no cracks) and the surface follows the terrain. `TerrainGrid.zAt` uses the same diagonal split as the mesh, so draped features sit exactly on it.
  - Convex pieces are ear-clipped, not fanned, to avoid zero-area triangles (trimesh strips those and opens the mesh).
- **Clipper (`clipper-lib`, pure JS, BSL)** for buffering and unions, in local coordinates scaled ×100. Outlines are grown by 1 cm after union to remove pinch points. 7,200 street segments take about 0.45 s.
- **Relief and depth are in mm at print scale** (`reliefMm`, `waterDepthMm`, multiplied by scale/1000). Roads/paths/rail/green are thin solids that sit above the terrain (embedded slightly into it). Rivers are carved into the DTM copy (`Scene.terrainRaster`), and the water solid sits just under bank level.
- **Overlapping OSM areas are unioned per class** for 3D (a park containing a garden would otherwise stack as coincident solids). Drawings keep every polygon.
- **LOD1.5 is deliberately conservative.** Pitched roofs are accepted only with RMSE ≤ 1.2 m, a plausible pitch (rise ≤ 0.9 × half-span, ≤ 9 m), and a clear improvement over a flat top. On the Pulteney Bridge test area only 3 of 289 buildings qualified: terraces step down the slope, so a single ridge doesn't fit. They remain honest blocks. Samples within 1 m of the outline are ignored because OSM outlines are rarely that accurate.
- **LIDAR trees need OSM buildings** to separate canopy from roofs. With no buildings loaded, only OSM tree points are used (and the app says so). Without this guard, a terrain-only run turned every roof into a tree.

### 7.4 Verified, and known issues

**Verified:**
- 51 unit tests (`npm test`): terrain sampler equals the mesh, draped pads (with holes) are watertight with exact volume, ribbons, buffering, gable/hip fits (including rotated), LOD2-raw volume, tree detection and meshes, scene layers, every feature switch, carve depth, triangle budget, OBJ groups, DXF 3D face indices, drawing layers.
- Live end-to-end on the Pulteney Bridge preset (308 buildings, 7 rivers, 4 bridges, 23 walls) using a saved Overpass response (`tools/e2e/drive.mjs <out> <url> 2 <osm.json>`): all exports download, no console errors.
- `tools/validate/check_exports.py`:
  - ezdxf: 3D and 2D DXF audit with 0 errors.
  - trimesh: per-layer STL closure. All bridges, buildings (291/291), green, paved, terrain, water, walls and trees are closed. 1 of 8 road bodies and 1 of 17 path bodies have one doubled edge (a sub-millimetre pinch at a grid line).
- Scale check (synthetic 2 × 2 km, 4,900 buildings, 140 road/path lines, `buildScene` in node): about 3.6 s at LOD1, 3.7 s LOD1.5, 6.9 s LOD2-raw (4.5 s at 2 m roof detail). Dense road networks are the heaviest layer (about 2.6 M triangles for a street every 28 m, about twice Bath's density). Real Pulteney roads are 75 k. The legend warns above 4 M triangles; "surfaces" mode and the feature cell size are the levers.

**Not verified:**
- Opening the new OBJ/STL/DXF in real AutoCAD and Rhino (only ezdxf/trimesh).
- A full 4 km² run in the browser (Overpass was too slow to repeat); processing is still on the main thread.
- Rhino's handling of OBJ groups vs one-file-per-layer.

**Known issues:**
- **LOD2-raw is noisy** (1 m DSM edges give ragged walls) and is not guaranteed watertight. The UI and README say "visualisation".
- **Overlapping buildings** are still separate solids (F: manifold-3d unions).
- Bridge decks use the bridge *line* only; `man_made=bridge` polygons appear in drawings, not 3D. Pulteney Bridge's shops are in the buildings layer.
- Trees below printable size at small scales; the STL README says to leave that file out.
- `featureStep` and `maxTris` are independent: a very coarse terrain with a fine feature step wastes triangles.

**Not done from B and C (still open in section 8):**
- B2 mode 2 (imprinted constrained-Delaunay terrain, adaptive decimation). Mesh size is uniform grid plus averaging for now.
- B5 canopy surface; B7 street names, `building:part`, stepped `highway=steps`; B8 3MF, DXF R2000 hatches.
- C2 vertical-error simplification (DSM downsampling only); C4 chimneys/parapets; C5 attributes in exports beyond object names (OSM id) and the GeoJSON height properties (eaves/ridge/LOD are not written yet).
- Weirs (`waterway=weir`) are excluded from the OSM query.

---

## 7b. Iteration 3, milestone M1 (2026-11-04)

The full plan is in `PLAN.md` (datasets audited live, milestones M1–M6). Done so far:
- **Adaptive terrain** (`process/rtin.ts`): RTIN with a vertical tolerance and triangle cap; crack-free, one boundary loop, closes via `solidWithFlatFloor`. `Scene.terrainSolid(baseZ)` replaces direct `terrainMesh` calls in exports.
- **LOD2-fit roofs** (`process/roofparts.ts`): terrace strips, rectangle decomposition, flat/shed/gable/hip per part, either ridge orientation. Roof lines in drawings use `Building.roofParts`.
- Known: 1 of 557 Pulteney parts has an open edge (pinch); chimneys/parapets not yet.
- Added to the plan on request: custom site shapes (M2) and side-elevation slices from a drawn cut line (M4).

## 7c. Iteration 3, milestone M2 (2026-11-04)

Custom shapes (`process/shape.ts`, `view/map.ts` tools, `SiteData.shape`), data fetchers (`data/{cache,nhle,floodzones,defences,police,weather}.ts`), OSM points (entrances, crossings, POIs, stops: `SiteData.points`), road markings (`process/markings.ts`), `export/attributes.ts`. Fixed on the way:
- `offsetOutline` flared both ends of every ribbon (zero end-direction): fixed (also affected bridge decks and walls).
- Floors triangulated with earcut dropped collinear boundary vertices (T-junctions against walls): `earClipLoop` now uses every vertex.
- Dropping "tiny" draped pieces left holes: only exactly-degenerate pieces are dropped now.
Verified: hexagonal site end to end in the browser (STL closure for terrain, buildings, markings 88/88).

## 7d. Iteration 3, milestone M3 (2026-11-04)

`src/analysis/`: `sun`, `shadow`, `flood`, `wind`, `crime`, `entrances`, `footfall`, `render`, `tasks` (+ `analysis.worker.ts`; `runTask` falls back to inline when there is no Worker), UI in `src/ui/analysis.ts`. Tested against analytic answers (day length, noon altitude, shadow length = h / tan(alt), flood connectivity, trip conservation). Live e2e: shadow 2.4 s, wind 1.1 s, flood 4.1 s (EA fetch), crime 6.9 s (6 months), footfall 1.1 s on Pulteney.
Lessons: data.police.uk sometimes errors without CORS headers (rate limiting): `fetchCrimes` retries then skips a month and warns. The wind and footfall models are heuristics: calibrate against CFD/counts before trusting numbers; the UI says so.
Not done: analysis results are not yet embedded in drawing sheets (M4), and the scene itself isn't built in a worker yet (M6).

## 7e. Iteration 3, milestone M4 (2026-11-04)

`export/{layers,dxf2000,sheet,pdf}.ts`, `process/section.ts`, drawing layers (REDLINE, SPOT-LEVEL, ROOF-PITCH, LISTED), map tools for red line and cut lines, `main.ts` drawing flow (`planSheet`, `sectionSheet`, `exportPdf`). `writeSvg` is now only used for the 3D ground texture; sheets come from `writeSheet`.
Gotchas: `layerSvg` is shared by both writers; the DXF section uses chainage/level coordinates (not BNG); R2000 files need BLOCK_RECORD/handles for ezdxf and AutoCAD, so keep that structure when editing; jspdf/svg2pdf.js are dynamically imported (build splits them). Installing a dependency prunes `npm i --no-save playwright`: reinstall it before running `tools/e2e/drive.mjs`.
Not verified: opening the R2000 DXF in real AutoCAD/Rhino (ezdxf only); PDF rendering in Acrobat.

## 7f. Iteration 3, milestone M5 (2026-11-04)

`export/{gltf,threemf,rhino}.ts`, `process/{solidify,facades}.ts`, export UI for GLB/3MF/3DM + union/fuse options, facade layers. manifold-3d and rhino3dm are dynamically imported and their `.wasm` files are loaded with `?url` imports in the browser (vite bundles them); in Node (vitest) they load directly.
Build gotcha: `rhino3dm`'s default entry pulls in Node modules (`ws`, `fs`) and breaks `vite build`; the browser path imports `rhino3dm/rhino3dm.module.js`, tests use the CommonJS entry via a runtime specifier. Always run `npm run build` and, ideally, `tools/e2e/drive.mjs` against `vite preview` (production bundle), not just the dev server.
Known: a fused STL can contain an inverted shell for an enclosed courtyard void (legitimate); facade windows on slopes use the building's lowest ground level, so uphill windows can sit slightly into the ground.

## 7g. Iteration 3, milestone M6 (2026-11-04)

Done: `ui/state.ts` (share links, friendly errors), `data/imagery.ts`, viewer picking/views, packs via a download collector (`collector` in `main.ts`: exports call `download()`, which stores instead of saving while a pack runs), building override panel, nested-safe `busy()` (depth counter), help dialog, shortcuts.
**Deliberately not done, and why:**
- *Svelte migration.* The UI is ~600 lines of imperative TypeScript in `main.ts` plus `ui/analysis.ts`; `process/`, `export/`, `analysis/` and `data/` are framework-free and unaffected. A migration would rewrite working, e2e-verified UI for no user-visible gain in this iteration and risks regressions. The sensible time is when UI state (settings, sections, results) needs reactive sharing between many components. Until then keep adding modules under `src/ui/` like `analysis.ts`.
- *Scene build in a worker.* `Scene` carries closures (`terrainSolid`, `grid.zAt`) and big typed arrays; moving it needs a message-based redesign (return meshes + a sampler id). Analyses already run in a worker. The main thread is blocked for a few seconds on large sites during model builds.
- *Imagery-based vegetation index and marking snapping:* imagery is display/texture only.
Test harness notes: software WebGL is flaky under load (screenshots time out when stale Chromium processes are running: `pkill -f chromium`); a second page in the same context may never initialise the map, so test link reopening by reloading the same page.

## 7h. Iteration 4 (2026-11-04)

Full status table: PLAN.md section 10; imagery research: section 11. 156 tests (`npm test`), production build verified with `tools/e2e/drive.mjs` (all exports, analyses, new styles and axonometric, no console errors) and `tools/e2e/cut.mjs` (map cut lines with real clicks).

**Bug fixed.** Cut lines could not be drawn on the map: `view/map.ts` ran the rectangle tool's `mouseup` for the cut tool, which reset the tool before the second click. The cut tool now has its own path, a rubber-band preview, Esc to cancel, an orange highlight for the active line and click-to-select (`onCutSelect`).

**Roofs** (`process/roofparts.ts`, `roofs.ts`, `dormers.ts`, `facades.ts`):
- New `RoofFit` types `mansard` (profile `[t, z][]`, optional `hipped`) and `surface` (complex roof kept as smoothed LIDAR). Mansard is judged on near-wall samples (inset 0.5 m), because at 1 m resolution the steep slope is one cell wide; it must show on both long sides. On real Royal Crescent/Circus data 63 of ~520 parts fit as mansards, 30 as surface: **not validated against ground truth**, so check a few by eye against imagery before relying on them.
- OSM `roof:shape`, `min_height` and `building:part` are used (`Building.parts`, `attachParts`; `SiteInputs.parts` so a height rebuild keeps them). Parts only help where OSM has them; the Abbey extract had none.
- Dormers are procedural (layer `dormers`, windows into `windows`): setting `roofWindows`. Facade wall storeys exclude a mansard/steep attic (`wallLevels`).
- Imagery (`process/imagery.ts`): vegetation raster (`SiteData.vegetation`) masks tree returns in roof fits; roof colours; paint detection -> `SiteData.detectedMarkings` merged by `buildMarkings`. Triggered by `analyseImagery()` in `main.ts` (after loading an image and on every rebuild).
- Settings `complexRoofs` (mansards + surface fallback) and `roofWindows`; UI rows in the feature table.

**Infrastructure** (`process/network.ts`, `context.ts`, `bridges.ts`, `scene.ts`):
- `Context` gained `pavements`, `kerbs`, `earthworks`, `weirs`, `inferredPavementM`, `mappedPavementM`; `paths` and `rail` are now made disjoint from roads/pavements. New Clipper helpers `differencePolygons`, `intersectPolygons`, `offsetPolygons`.
- Pavements are inferred only where no sidewalk tag exists, the road class is residential or above, and at least half the sample points along a side have a building within 4.5 m and no mapped path within 3 m. They are INFERRED data: the setting `pavements` turns them off.
- Scene layers `pavements` (raised by a kerb height above the road), `earthworks`; bridges are `buildBridge` parts (deck, parapets, abutments, piers). Ground features are subtracted from each other and from building footprints before draping.
- OSM query additionally fetches `building:part`, weirs, embankments, cliffs, quays/piers (`LineKind`: weir, embankment, cliff, quay).
- Not done: monotone river levels and 3D weirs; terrain re-triangulated around the road corridors; tunnel portals.

**Drawings** (`export/styles.ts`, `sheet.ts`, `axon.ts`, `drawing.ts`):
- `STYLES`/`applyStyle` restyle layers for SVG/PNG/PDF only (DXF keeps plain layers). New drawing layers PAVEMENT, KERB, EARTHWORKS, EARTH-EDGE, WEIR (NCS names added; `ROAD-SURFACE` now maps to `C-ROAD-PVMT`, `KERB` to `C-ROAD-KERB`).
- Sheet: style paper/ink/font, ISO 19650 status, checked/approved/client, zone references, do-not-scale note.
- Axonometric: `axonSvg(scene, origin, opts)`, button "Axonometric (SVG)". Face budget 90 000; layers over budget are skipped and reported. PDF export strips `filter=` attributes (svg2pdf has no filters), so the sketch style loses its wobble and shadows there.

**Optional real-data test:** `BATH_DATA=<dir> npx vitest run tests/real-bath.test.ts` with `rc_dsm.tif`, `rc_dtm.tif` (EA WCS) in the directory; the Overpass extract is fetched once and cached. `tests/helpers/bath.ts` can build a `SiteData` offline for any area.

### 7h-2. Later the same day
- Roofs: `fitPeriodic` (industrial: multi-gable, barrel, sawtooth; runs BEFORE terrace splitting, which would otherwise cut a sawtooth at every glazed step), `splitLevels` (multi-level), barrel candidate in `fitPart`. `RoofFit.kind` labels them; their `type` stays gable / mansard / shed, so no new branches were needed in drawing/section code (barrel draws only its crown line). `complexRoofs` switches all of mansard / industrial / multi-level / surface fallback.
- `data/oblique.ts`: EA oblique photo INDEX lookup (see PLAN section 12 for why it is an index only). Called from `fetchSite`, never fatal.
- Build stamp: `__BUILD__` (vite.config.ts `define`) is logged first in the app log.
- `tools/e2e/cut.mjs <out> <url> <osm.json>` now follows the user's path. If a user reports the cut tool broken, first check the `Build` line in their log.
- Not validated: industrial roofs on a real factory (no extract was obtainable); mansards and multi-level splits have no ground truth.

## 8. Next steps

Ordered by value to the architecture and fabrication workflow. Each item says where it fits in the current code.

### A. Make OSM reliable (do this first) — bring-your-own OSM file DONE; caching and pre-baked Bath extract still open

Overpass is a shared, free service, and it already failed once in testing.

- **Allow users to bring their own data** - Overpass API is sometimes unreliable, so give a guide to users on how to bring their own data (ie downloaded from overpass turbo)


### B. Context features as separate 3D objects — DONE in iteration 2 (see section 7 for what remains)

This is the user's main request: roads, railways, parks, water, bridges and trees as real geometry. Each type becomes its own OBJ object or group, its own STL body, its own material, and its own DXF layer.

**B1. Build polygons from lines.** Add `process/buffer.ts`. Offset each OSM centreline to a polygon. Width priority: `width` tag, then `lanes` × 3.25 m, then a class default:

| Class | Default width |
|---|---|
| motorway / trunk | 11 m |
| primary | 9 m |
| secondary | 7.5 m |
| tertiary | 6.5 m |
| residential / unclassified | 5.5 m |
| service | 3.5 m |
| footway / path / cycleway | 2 m |
| steps | 1.5 m |
| rail | 3.5 m per track (`tracks` tag), including ballast |
| river / canal centreline with no water polygon | `width` tag, else 8 m |
| stream / drain | 1.5 m |

- **Library:** use a robust offset/union library. Clipper2 (JS/WASM port) is the strongest option; `@turf/buffer` is heavier. Union polygons per class with polygon-clipping or Clipper2, so junctions merge cleanly.
- **Drawings benefit too:** roads get **kerb lines** (the outline of the merged road polygon) instead of centrelines. Keep centrelines on their own `*-CL` layer.

**B2. Put the features on the terrain.** Two modes, built in this order:

1. **Draped overlay solids (simpler, first):**
   - Triangulate each feature polygon with interior grid points so it follows the slope, then sample the DTM.
   - Visual/OBJ: offset +0.05 m to avoid flicker against the terrain.
   - Printing: closed thin solids, i.e. roads slightly recessed, pavements and parks slightly raised, water recessed. Make the relief adjustable in mm at print scale, e.g. roads −0.3 mm, kerbs and parks +0.3 mm.
2. **Imprinted terrain (better, second):**
   - Re-triangulate the terrain as a constrained Delaunay mesh (e.g. `cdt2d` or `poly2tri`), with every feature boundary as a constraint. The terrain splits into patches labelled road, rail, water, green and wood. Each patch is an OBJ group with its own material, so Rhino users can pick a road surface directly.
   - The same constrained triangulation enables **terrain decimation**: fewer triangles on flat areas while keeping feature edges. This replaces the regular grid and solves the 100 MB STL problem.

**B3. Water.**
- Water polygons (`natural=water`, `water=river`, `waterway=riverbank`) become a flat water-surface object.
- Water level: a low percentile of DTM samples along the polygon edge, because LIDAR has no returns over water and the filled DTM is unreliable there.
- Optionally carve the terrain 0.5–1 m below the water level so the river reads in physical models.
- Weirs (`waterway=weir`, e.g. Pulteney weir) are lines → thin solid steps.

**B4. Bridges.**
- Sources: `bridge=yes` ways (already flagged in `LineFeature.bridge`) and `man_made=bridge` polygons (already the `BRIDGE` area layer).
- Deck height: sample the **DSM** along the centreline. It captures the deck, while the DTM usually shows the ground or water underneath. Clamp and smooth it, and check it against DTM at the two abutments.
- Deck: the buffered road polygon (B1) extruded from deck top down 0.8–1.2 m. Use the `man_made=bridge` outline when available.
- Piers: optional, later (OSM `bridge:support` is rare). For printing, give the deck supports or fuse it to the banks.
- Remove bridge spans from the draped and imprinted road layer (B2) so roads don't double up.
- Tunnels (`tunnel=yes`, already flagged): exclude from 3D; dashed in drawings (already done).

**B5. Parks, green and woodland.**
- Imprinted or draped patches (B2), with materials: green `#c3d9a8`, wood `#93b67b`, paved `#d8d2c6`. Reuse `TEXTURE_STYLE` in `export/drawing.ts`.
- Optional: a woodland **canopy surface** from the DSM (a smoothed canopy height model) as its own mesh, useful for massing studies.

**B6. Trees.** OSM has only 11 tree points around the Abbey, so detect them from the LIDAR:
- **Canopy height model:** nDSM (DSM − DTM), with building footprints masked out (dilated about 1.5 m) and values under 2.5 m removed.
- **Tree tops:** local-maximum detection with a window that grows with height (e.g. radius = 1 + 0.08·h m). Crown radius from a watershed on the canopy model, or rule of thumb ≈ 0.2·h + 1 m.
- **Merge** with OSM `natural=tree` points (which have `species` and `genus` tags) and `natural=tree_row` lines.
- **Output:**
  - 3D: low-poly "lollipop" (cylinder trunk + icosphere crown) or cone. Use instancing in three.js. In STL, enforce minimum printable sizes at scale, or skip trees.
  - Drawings: crown circles at true radius (already a `TREES` layer). In DXF, define a **BLOCK** and **INSERT** it per tree (R12 supports this) so AutoCAD users can swap in their own symbol.
  - Data: GeoJSON points with height and crown radius.
- **UI:** toggle "Trees: none / OSM only / LIDAR-detected".

**B7. Other features** (cheap wins from OSM):
- `barrier=wall|retaining_wall|city_wall|fence` → thin extruded walls (default heights 1.2–2 m; `height` tag).
- `highway=steps` → stepped ribbon, or keep as a hatched polygon.
- `building:part` → per-part heights and roof tags. A prerequisite for LOD2 in OSM-tagged areas.
- Street names → text along roads (`ROAD-NAME` layer). Building and landmark names (`name` on buildings) → labels.
- `amenity`/`historic` points of interest → optional labels.

**B8. Export structure once features exist.**
- **OBJ:** one object per feature class (or per feature, optional), with materials per class. The **3MF** format carries per-object colour and material and is the best target for multi-colour printers.
- **STL:** zip with **one STL per class** (terrain, buildings, roads, water, green, trees, bridges), all sharing the same transform, so they register when loaded together.
- **DXF:**
  - Move to **R2000 (AC1015)** for HATCH (fills for water, green and buildings), LWPOLYLINE and true colour. R2000 needs entity handles. Either extend `export/dxf.ts` or evaluate a maintained JS DXF writer.
  - Add an optional 3D-mesh DXF (POLYFACE or 3DFACE) so AutoCAD gets the terrain and features as geometry.

### C. Rooftops and detailed buildings (user-selectable LOD) — C1/C2 DONE; C3 not possible in the browser (section 7.2)

The goal is "highly detailed" buildings: real roof shapes for Bath's pitched and mansard terraces, chimneys, and parapets. LOD here follows the CityGML levels; the user picks one per export.

| LOD | What the user gets | Source | Where it runs |
|---|---|---|---|
| LOD1 (done) | Flat-topped block per footprint | DTM + DSM percentile | Browser |
| LOD1.5 | Walls to eaves height + a simple roof volume to ridge height | DSM 40th / 95th percentiles (already computed) | Browser |
| LOD2-raw ("LIDAR roofs") | Actual DSM surface inside each footprint, simplified, with walls down to ground | DSM clipped per footprint | Browser |
| **LOD2.2 (target)** | Clean planar roof faces: gables, hips, mansards, dormers; watertight solids | LIDAR **point cloud** or DSM, plus footprints | **Offline pipeline**, results hosted |
| LOD2.2+ | Chimneys, parapets, roof furniture as separate objects | Point cloud residuals above the roof planes | Offline |
| LOD3 (research) | Facade openings | No open data source; possibly procedural only | n/a |

**C1. LOD1.5 (quick win).** Wall height = 40th-percentile DSM; ridge = 95th. Roof volume: a straight-skeleton roof of the footprint, scaled to the ridge-minus-eaves height. This gives a plausible hip roof even without roof-type detection. Straight-skeleton libraries exist in JS/WASM; evaluate them for robustness on messy OSM polygons.

**C2. LOD2-raw (browser).**
- Cut the DSM to each footprint (exact, using the polygon coverage already computed in `align.ts`) and triangulate with constrained Delaunay.
- Simplify to a vertical error (0.1–0.3 m, user setting).
- Add walls from the roof edge down to the ground.
- Remove tree contamination using the canopy model from B6 (overhanging canopy shows up as high, rough patches at footprint edges).
- Downsides: noisy, stepped at 1 m, not planar. It reads well in renders, less well in CAD.

**C3. LOD2.2 (the "proper" model).** Use the **point cloud**, not the 1 m DSM.
- **Data:** the EA **National LIDAR Programme** publishes classified point clouds (LAZ), downloadable per tile from the Defra Survey Data Download portal. **Verify** the classification classes, point density over Bath, the licence (expected OGL), and whether downloads can be automated.
- **Tool:** **roofer** (open source, from the 3D BAG team; reconstructs LOD1.2/1.3/2.2 from point cloud + footprints, outputs CityJSON). Running a proven reconstructor offline beats writing roof fitting from scratch. Alternatives to compare: plane segmentation (RANSAC / region growing) + roof graph building, or model-driven fitting of roof primitives (gable, hip, mansard, flat).
- **Pipeline** (Python/C++, run locally or in a GitHub Action, Bath only):
  1. Download the NLP LAZ tiles for Bath.
  2. Get footprints from OSM (aligned with `estimateOffset` logic, ported to Python) and/or OS OpenMap Local.
  3. Run roofer to produce CityJSON with LOD2.2 solids.
  4. Validate the results with val3dity (CityJSON validator: closed, oriented, planar).
  5. Bake into a web-friendly tiled format (e.g. 250 m tiles of compressed CityJSON / FlatGeobuf of roof faces, or glTF per tile) with an index.
- **Hosting:** check the size budget. GitHub Pages allows a 1 GB site and 100 MB per file, so tile the data. If Bath LOD2 doesn't fit, use Cloudflare R2 (free tier, CORS configurable). **GitHub release assets are likely not CORS-readable from the page; verify before relying on them.**
- **Browser side:** for sites inside Bath coverage, load LOD2.2 tiles, clip to the site, and offer LOD2 in the dropdown. Outside coverage, fall back to LOD1.5 / LOD2-raw.
- **Bath specifics:**
  - Georgian terraces: OSM often splits terraces per house, so roofs should be reconstructed per house with shared party walls.
  - Roofs are predominantly mansard or double-pitched behind parapets, with large chimney stacks. Test reconstruction quality on the Royal Crescent, the Circus and Great Pulteney Street as reference sites.

**C4. Roof details.** Chimneys are small local maxima, 0.5–3 m above the fitted roof plane: extract them as separate small prisms (own layer/object). Parapets come from the difference between footprint-edge heights and eaves. Dormers are handled by roofer at LOD2.2.

**C5. Building attributes** carried into every export (OBJ object names, 3DM user text, GeoJSON properties):
- OSM id
- ground / eaves / ridge heights
- height source and LOD
- listed status (OSM `heritage` / `listed_status` now; Historic England National Heritage List as the authoritative source, which needs a licence and CORS check)
- survey year (E)

**C6. Facades (LOD3)** have no open data source. Options: procedural window grids from `building:levels` (looks fake; architects mostly want clean white massing anyway), or imagery-assisted work (out of scope). Recommend: **don't do LOD3**; make LOD2.2 excellent.

### D. Proper architectural drawings

Aim for drawing sets an architect can submit or present, following UK conventions:
- Line weights per ISO 128: 0.13 / 0.18 / 0.25 / 0.35 / 0.5 / 0.7 mm.
- Layer naming in a BS EN ISO 13567 / Uniclass-style scheme, configurable, with today's simple names as the default.
- A-series sheets, a title block, revision box, north point, scale bar, key/legend, and BNG grid ticks with coordinates.

**D1. Drawing types**, in priority order:
1. **Site location plan** (1:1250 or 1:2500) with a **red-line boundary** drawn by the user as a polygon. This is a standard UK planning-application drawing. **Flag:** many local planning authorities expect OS-licensed base mapping for location plans; an OSM base may not be accepted. Document this and consider an OS Maps API option (free tier needs a key, so there are client-side key-exposure considerations).
2. **Block / site plan** (1:500 or 1:200):
   - footprints with heights
   - contours and spot levels
   - roads with kerb lines (B1)
   - trees with crown spread (B6)
   - boundary walls (B7)
   - water and bridges
3. **Roof plan** (needs LOD2, C3): ridges, hips and valleys as lines, pitch arrows with angles, flat-roof hatch, chimneys.
4. **Sections:**
   - The user draws a cut line A–A (multiple allowed). Sample DTM + DSM + LOD solids along it.
   - Draw the ground line with section hatching, cut buildings with solid fill (poché), and buildings beyond in elevation (projected, lighter weight).
   - Add a datum line with ODN levels and vertical exaggeration noted on the sheet.
5. **Street / site elevations:**
   - Project buildings onto a chosen line or bearing with hidden-line removal.
   - LOD1 gives rectangles; LOD2 gives true roof profiles.
6. **Axonometric / isometric and perspective line drawings** as vector output from the 3D model with hidden lines removed. Implementation options:
   - analytic: project faces, then remove hidden parts with polygon booleans (fine for LOD1/2 counts)
   - an edge-projection library for three.js (one exists from the three-mesh-bvh author; **evaluate**)
   - depth-buffer edge detection (raster only)
7. **Shadow studies:**
   - Sun position for a date and time (a solar library such as SunCalc); standard UK dates are 21 March, 21 June and 21 December at set hours.
   - Raster: three.js shadow maps.
   - Vector: project building solids onto the ground and union them.
   - Output a sheet with a grid of times. Very common for planning in dense historic areas like Bath.
8. **Site analysis maps:** slope (%), aspect, elevation bands (colour-tinted by height), canopy cover, viewshed from a point (optional).

**D2. Sheet engine.**
- A layout model of sheet size, viewports (each with its own scale and layers), a title block (project, drawing number, title, scale, date, drawn by, revision) and legend.
- One layout renders to SVG, PNG and multi-page PDF (PDF via the SVG → PDF route planned earlier, e.g. jsPDF + svg2pdf).
- For CAD, export model-space geometry plus the sheet as a separate DXF. True DXF paper-space layouts with viewports are complex; defer.

**D3. Graphic quality:**
- hatches (DXF R2000 HATCH; SVG patterns)
- road edge casings and names along paths
- contour labels placed so they don't collide and are oriented uphill
- spot heights at key points (corners, road centrelines, thresholds)
- legend generated from active layers
- consistent style presets: "Planning (mono)", "Presentation (colour)", "Laser-ready (cut/engrave colours)"

### E. Aerial and satellite imagery

**E1. Licensing first.** This decides what is possible, so verify before building anything.

| Source | Resolution | Licence (to verify) | Use |
|---|---|---|---|
| EA Vertical Aerial Photography (Defra portal) | High (cm-level, varies) | Expected OGL; confirm, plus coverage and date over Bath | Terrain texture, roof colour, vegetation |
| Aerial Photography Great Britain (APGB) | 12.5–25 cm | Public sector only (PSGA); probably **not** usable for an open app | — |
| Sentinel-2 (Copernicus) | 10 m | Free and open | Vegetation index / green-space mapping only; too coarse for buildings |
| Bing / Esri / Google / Mapbox satellite | High | Terms generally forbid extraction and derived datasets | **Don't use** for analysis; maybe display only, per their terms |
| NLP LIDAR intensity / returns | Point-level | OGL (as LIDAR) | Surface classification without imagery |

**E2. Uses, in order of value:**
1. **Terrain and roof texture** in the OBJ/3DM/GLB preview: an orthophoto clipped to the site and aligned using BNG georeferencing.
2. **Vegetation:** combine canopy height from nDSM with greenness from imagery (a near-infrared vegetation index if a band is available, otherwise from RGB). This separates trees from buildings and street furniture far better than height alone, so it feeds tree detection (B6) and roof cleaning (C2).
3. **Surface classification** (grass / paved / water / roof) by pixel classification using imagery + nDSM + LIDAR intensity. Start with a simple classifier (random forest trained on OSM-labelled areas), done offline for Bath. This fills gaps where OSM lacks landuse polygons.
4. **Road edges and kerbs** from imagery would need ML segmentation. Low priority: Bath OSM roads are good, and B1 buffering covers drawings.

**E3. Where it runs:** imagery is heavy. Display tiles in the browser; do analysis offline in the Bath data pipeline (C3) and publish results as vector layers.

### F. High-detail models (geometry quality and formats)

- **Robust booleans:** use **manifold-3d** (WASM; guaranteed-manifold mesh booleans). It enables:
  - unioning overlapping OSM buildings into clean solids (fixes the overlapping-shells limitation)
  - carving roads and rivers into terrain for physical models
  - fusing buildings to the terrain into **one printable solid**
  - splitting large models into printer-bed tiles with registration pins or holes
- **Terrain:**
  - constrained Delaunay with feature edges plus adaptive decimation (B2 mode 2)
  - optional finer terrain from point-cloud ground points (C3 pipeline) where 1 m isn't enough (kerbs, steps)
- **Formats:**
  - **3DM** via rhino3dm.js: layers, materials, object names and user text attributes. Native for Rhino; Revit 2023+ links 3DM.
  - **GLB:** presentations, web viewers, Blender.
  - **3MF:** colour / multi-material printing.
  - **CityJSON:** interoperability with GIS and urban-modelling tools.
  - **IFC** (later): site + building proxies via web-ifc, for Revit/BIM.
  - Keep OBJ / STL / DXF.
- **Fabrication options:**
  - minimum feature size per scale (auto-thicken thin walls, drop details under e.g. 0.8 mm at scale)
  - base styles (flat plinth, contoured edge, plinth with engraved title)
  - laser stack improvements: building footprints and roads as engrave lines on each sheet, registration holes, sheet nesting to material size, kerf compensation
  - CNC: heightmap / STL for 2.5D milling, with a tool-diameter-aware smoothing option
- **Quality checks before download:** run manifold and watertight checks on every export, and report anything not closed. This is what `tools/validate/` does today, moved into the app.

### G. Easy UI

The current UI is one long panel of controls. Target: **an architect gets a useful pack in 3 clicks**, with full control available but hidden.

**G1. Guided flow:**
1. **Site:** search (postcode with autocomplete; postcodes.io has an autocomplete endpoint), address, or grid reference. Draw a rectangle *or* red-line polygon; rotate the rectangle; size presets (200 m / 500 m / 1 km). Live feedback on area, data size and coverage, e.g. "LOD2 available here".
2. **What do you need?** Pick from output **packs**:
   - **Planning drawings:** location plan, site plan, sections, shadow study → PDF + DXF
   - **CAD context model:** 3DM / DXF / OBJ with layers
   - **3D print model:** STL / 3MF at a chosen scale, sized to the user's printer bed
   - **Laser-cut model:** contour stack + engraving, sized to the user's sheet material
   - **Raw data:** GeoJSON + grids
3. **Review:** 3D and sheet previews side by side, a layer list with per-layer LOD (e.g. buildings LOD2, trees symbols, roads draped), and print dimensions / sheet count / file sizes shown before export.
4. **Download:** a single zip pack with a README explaining how to import into AutoCAD, Rhino and Revit.

**G2. Supporting UX:**
- an "Advanced" drawer per step (today's settings)
- settings persisted in localStorage
- **shareable URL** (site + settings in the URL hash)
- a progress bar with named stages and **cancel**
- friendly error states, e.g. "OpenStreetMap is busy, using the cached Bath dataset from <date>"
- **undo** for boundary edits
- onboarding tooltips
- keyboard shortcuts in the 3D view
- section-line and red-line drawing tools on both the map and the 3D view
- clicking a building shows its attributes (height source, listed status) and lets the user override its height or LOD, with overrides saved

**G3. Tech for the UI:** vanilla TypeScript won't scale to this.
- Adopt a component framework (Svelte or React) with a central store.
- Move all processing into **Web Workers**, so the UI never freezes.
- Keep `src/process`, `src/export` and `src/data` framework-free (they already are) so they can run in workers or a future desktop app.
- Desktop-first layout; tablet usable; phones out of scope.

### H. Platform

- **Web Workers** (see G3).
- **Survey year:** query the EA survey-index WFS and show the survey year(s) for the site. Add the newer National LIDAR Programme DTM/DSM as a source option (same WCS pattern; IDs to confirm).
- **Safari:** canvas-size caps per browser (see section 5).
- **"Bath data build" pipeline** (one place for C3, E2/E3 and A):
  - Pre-baked OSM extract, LOD2.2 buildings, imagery-derived layers and a tree inventory.
  - Versioned, with a manifest the app reads, and dates shown in the UI.
- **Desktop app later** for larger sites: a desktop shell around the same `process/` and `export/` code, with native pipelines (roofer, PDAL) bundled.
- **Revit path:** 3DM (2023+) or DWG/DXF link now, IFC later.

### Suggested roadmap

**Iteration 2: reliability + context features.**
- A: pre-baked Bath OSM + IndexedDB cache.
- B1 road/rail polygons + kerb lines.
- B2 draped feature solids.
- B3 water, B4 bridges, B6 LIDAR trees.
- B8 per-class OBJ / STL, DXF R2000 with hatches.
- Web Workers.
- Real AutoCAD / Rhino import test of all exports.

**Iteration 3: buildings + model quality.**
- C1 LOD1.5, C2 LOD2-raw.
- F: manifold-3d unions/booleans, single-solid printing, 3DM + GLB + 3MF export.
- B2 mode 2: imprinted, decimated terrain.

**Iteration 4: proper drawings + UI.**
- D2 sheet engine with PDF.
- D1: site location plan with red line, site plan, sections, elevations, shadow study.
- G: guided flow with output packs, framework migration, shareable URLs.

**Iteration 5: offline Bath pipeline.**
- C3 LOD2.2 via roofer from NLP point clouds, plus C4 chimneys.
- E: imagery licensing confirmed → textures, vegetation and surface classification.
- D1 roof plans and axonometric line drawings.

**Before starting iteration 5, verify:**
- NLP point cloud availability, density and licence over Bath
- EA aerial imagery licence and coverage
- roofer output quality on the Royal Crescent / Circus test sites
- the hosting size budget
