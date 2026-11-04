# PLAN: iteration 3 (data, roofs, terrain, drawings, analysis, UI)

_Written 2026-11-04, after iteration 2 (phases B and C, commit `d97e736`). Status of each item is tracked in section 9._

## 1. Constraints (unchanged, and they shape everything)

- **No backend.** Everything runs in the browser and is hosted on GitHub Pages.
- **No pre-baked Bath data.** Every dataset is fetched live for whatever area the user selects, anywhere in England.
- **No API keys.** A dataset is only used if it is reachable from a browser without a key and with CORS enabled. A user may *optionally* paste their own key for a keyed service, held in memory only.
- **Free and open licences** (OGL, ODbL, or similar). Anything that forbids derived data is display-only, or excluded.
- **Honesty over polish.** Analyses are screening tools and say so on the output. Nothing claims to be a certified flood, wind or crime assessment.

## 2. Dataset audit (probed live on 2026-11-04 from a browser origin)

| Dataset | Endpoint | Result | Plan |
|---|---|---|---|
| EA LIDAR DTM/DSM 1 m | `environment.data.gov.uk/spatialdata/lidar-composite-…/wcs` | ✔ used since iteration 1 | keep |
| OpenStreetMap (Overpass) | `overpass-api.de` + mirrors | ✔ but flaky; user-file fallback exists | add `entrance`, `crossing`, `traffic_signals`, `lit`, lane/turn/cycleway tags, `building:colour/material/levels`, `amenity/shop/public_transport` POIs, street lamps, benches; **IndexedDB response cache** |
| **Flood Zones 2 and 3** (EA, Flood Map for Planning) | `…/spatialdata/flood-map-for-planning-flood-zones/ogc/features/v1/collections/Flood_Zones_2_3_Rivers_and_Sea/items?bbox=…&crs=EPSG:27700` | ✔ CORS `*`, returns MultiPolygon with `flood_zone` (FZ2/FZ3) and `flood_source` | flood analysis overlay and drawing layer |
| EA recorded flood outlines, historic flood map, flood risk areas | `…/spatialdata/{recorded-flood-outlines,historic-flood-map,flood-risk-areas}/wms` | ✔ capabilities respond | optional overlays (verify layer names at build time) |
| **EA spatial flood defences** | ArcGIS `services.arcgis.com/JJzESW51TqeY9uat/…/SpatialFloodDefences/FeatureServer/0` | ✔ CORS `*`, polylines with `toe_level`, `asset_sub_type` | draw defences; use `toe_level` as a floor for flood-fill barriers |
| EA flood monitoring API (stations, readings, warnings) | `environment.data.gov.uk/flood-monitoring/id/…` | ✔ CORS `*` | nearest river gauge, to suggest a realistic flood stage |
| **Police street-level crime** | `data.police.uk/api/crimes-street/all-crime?poly=…&date=YYYY-MM` | ✔ CORS `*`, polygon search, 12 months of dates from `crimes-street-dates` | crime analysis (approximate: points are snapped to street "anchor" locations) |
| **Historic England NHLE** (listed buildings) | `services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/…/NHLE_v02_VIEW/FeatureServer/0` | ✔ CORS `*`, points in BNG with `Name`, `ListEntry`, `Grade` | tag buildings with grade, show in drawings, parse the listing text for storeys/materials (facades) |
| **Open-Meteo** (wind, current and archive) | `api.open-meteo.com`, `archive-api.open-meteo.com` | ✔ CORS `*`, no key, non-commercial | default wind direction/speed and a local wind rose for the wind panel |
| Sentinel-2 (STAC on AWS) | `earth-search.aws.element84.com` | ✔ reachable, 10 m | vegetation index only (too coarse for buildings); stretch goal |
| **OS Maps / Features / Names / Places APIs** | `api.os.uk/…` | ✖ key required (401) | not used. Optional user-supplied key later. |
| **OS OpenData bulk** (Open Roads, Zoomstack, OpenMap Local) | `api.os.uk/downloads/…` | ✖ whole-GB files, not tile-addressable, not browser-friendly | not used |
| **EA vertical aerial photography** | `…/spatialdata/vertical-aerial-photography/wms` | ✖ layers are tile *indexes* (10 KB outline image, nothing at Bath point queries); photos are zip downloads | not usable as a live source |
| Mapillary (street imagery) | `graph.mapillary.com` | ✖ token required | not used |
| Esri / Bing / Google imagery | tiles | ✖ ToS forbids extraction and derived data | display-only basemap at most, never in exports or analysis |
| ONS output areas (population) | ArcGIS | ✔ reachable, but needs layer discovery | optional. A building-footprint population proxy is used first. |

**Consequence for imagery (section 4.7):** there is *no* keyless, openly licensed, high-resolution orthophoto we can pull live. So imagery is **bring-your-own**: the user drops in a georeferenced image (GeoTIFF, or JPG/PNG + world file) from any source they are licensed to use (Defra tile download, a drone survey, their client's OS contract). Everything imagery-based works on that file. Nothing imagery-based is required for the other features.

## 3. What we are *not* doing, and why

- **LOD2.2 from point clouds** — needs multi-GB LAZ and a C++ reconstructor. Replaced by the in-browser interpreted roofs in 4.2. A desktop app stays the route to true LOD2.2.
- **Photographic facades** — no open elevation imagery exists. Replaced by procedural facades from open data (4.4).
- **Learned segmentation of road markings from satellite images** — no open imagery to run it on. Replaced by OSM-driven markings; imagery only *refines* them when the user supplies it (4.5).
- **Real CFD wind or hydrodynamic flood modelling** — out of scope for a browser tool and they would give false confidence. We ship screening methods, labelled as such (4.8).

## 4. Features

### 4.1 Adaptive terrain decimation (priority from the user)

**Problem.** Today the terrain is a uniform grid. A flat square costs as much as a cliff.

**Method.** Right-triangle bintree (RTIN) simplification:
- Resample the (carved) DTM onto a (2ᵏ+1)² grid that exactly spans the site, so the mesh covers the site rectangle with no clipping.
- Compute per-triangle errors bottom-up, then emit the triangles whose error exceeds a vertical tolerance (0.05–1 m, user-chosen). RTIN is crack-free by construction.
- Boundary loop → skirt and flat base via the existing `solidWithFlatFloor`, so printing stays watertight.
- Draped features keep using a uniform drape grid with heights from the *full-resolution* raster. Their lift is raised to ≥ 1.5 × tolerance so they never sink under the simplified surface.

**UI.** Terrain resolution gets a third mode: *Adaptive (vertical error 0.1 m)*, with a live triangle estimate and a "max triangles" cap that raises the tolerance automatically.

**Acceptance.** On a flat test surface, ≥ 20× fewer triangles than the grid; maximum vertical error to the raster ≤ tolerance; one boundary loop; solid is watertight.

### 4.2 Interpreted LIDAR roofs: a new LOD ("LOD2-fit"), joined to the mesh

**Problem.** LOD2-raw is faithful but noisy and ragged. LOD1.5 only fits one shape per footprint, so Bath's stepped terraces fail (3 of 289 fitted).

**Method.**
1. **Split each footprint into parts.** Rotate to the dominant wall direction, rasterise the footprint at 0.5 m, and cover it greedily with maximal rectangles (rectilinear decomposition). Non-rectilinear footprints fall back to the oriented box.
2. **Split terraces along the ridge axis** wherever the DSM profile steps by more than 0.7 m (party-wall steps), so each house gets its own roof.
3. **Fit a standard shape per part** by least squares against the DSM, ignoring 1 m at the edges: flat, shed (single slope), gable, hip; the best RMSE wins. Parts with RMSE > threshold fall back to a flat top.
4. **Build each part as a closed solid** (`roofedBuildingMesh` generalised to shed and arbitrary orientation), named `building_<id>_<n>`. Walls and floor come from the boundary, so roofs are *joined to the building and to the terrain* by construction.
5. **Parapets / chimneys** (stretch): local maxima above the fitted plane become small prisms on their own layer.

**Why this beats "raw → planar".** Region-growing on a 1 m DSM gives staircase ridges. Fitting parametric shapes gives straight ridges, exact planes and clean CAD geometry.

**Acceptance.** Synthetic terrace of 5 stepped houses → 5 parts with the right eaves; watertight; RMSE reported; on the real Pulteney data the share of non-flat roofs rises well above 3 of 289, and nothing exceeds plausible pitch limits.

### 4.3 Manifold booleans (from iteration 3 in HANDOFF F)

`manifold-3d` (WASM) as an **on-demand** step in the export dialog:
- union overlapping OSM buildings into single solids;
- merge a layer's parts into one manifold per layer (for printing);
- fuse buildings to the terrain into **one printable solid**.

Loaded lazily so the first page load stays small. Failures fall back to the current separate solids with a notice.

### 4.4 Facades: what is possible without elevation imagery

We can raise *data* resolution, not *photographic* resolution.

| Source | What it gives | Use |
|---|---|---|
| OSM `building:levels`, `building:colour`, `building:material`, `roof:*`, `height`, `min_height`, `entrance`, `addr:*` | storeys, colours, door positions | storey count and floor lines; door openings at real entrance positions |
| **NHLE listing text** (fetched per listed entry) | Descriptions such as "3 storeys, 5 windows, ashlar, sash windows, parapet" | parse storeys/bay counts/material into facade parameters (Bath stone colour) |
| LIDAR | parapet height and roof/eaves edge, building height per part | storey height = (eaves − ground) / levels |
| Footprint edge lengths | bay widths | window grid pitch (default 1.0–1.3 m bays, adjustable) |

**Deliverable: "LOD3-lite" facades (optional per export).**
- Floor lines (string courses) on every storey; ground-floor plinth.
- Window openings as shallow recesses on a regular bay grid per facade edge, only on edges longer than 3 m and not on party walls (shared edges detected by overlap with neighbouring footprints).
- Doors at OSM `entrance` nodes (nearest facade edge), otherwise at the edge facing the nearest road.
- Facade surfaces, windows, doors and string courses go on separate layers (`FACADE-WALL`, `FACADE-WINDOW`, `FACADE-DOOR`).
- Default **off** and **limited by triangle budget** (windows are subdivided only above a size threshold). Clearly labelled *procedural, not surveyed*.
- Drawings: street elevations (4.6) use the same parameters.

### 4.5 Road and path markings (procedural, imagery-refined)

Satellite detection is not possible with open data (section 3). Instead, generate markings from OSM and road geometry:

| Marking | Rule |
|---|---|
| Centre line | dashed on two-way roads ≥ 5.5 m wide; solid on `no_overtaking`/double-yellow-capable roads (default off) |
| Lane lines | `lanes` ≥ 2 per direction; from `lanes`, `lanes:forward/backward`, `turn:lanes` |
| Zebra crossings | `highway=crossing` / `crossing=zebra` nodes on road: striped bars across the road width, perpendicular to the centreline, with Belisha-beacon marks |
| Signalised crossings | `crossing=traffic_signals`: two thin parallel lines |
| Stop and give-way lines | at `highway=stop`, `give_way`, `traffic_signals` nodes |
| Cycle lanes | `cycleway=lane/track` → coloured strip on the road edge |
| Parking bays | `parking:lane:*`, `amenity=parking` areas → bay outlines |
| Double yellow lines | `parking:condition=no_parking/no_stopping` (where tagged) |
| Footway edge/tactile | at crossing nodes (stretch) |

Output: new layers `ROAD-MARK-*` in drawings (SVG/PNG/DXF) and, in 3D, thin raised decals (0.5 × relief) on their own layer.
**Imagery refinement (optional, user-supplied):** with a user ortho loaded, markings can be snapped to the nearest white/yellow pixel ridge within 1 m. Marked *experimental*.
**Honesty:** OSM markings coverage is patchy. Defaults are conservative: only what the tags support is drawn, and the UI says "from OSM tags".

### 4.6 Drawings and export standards (iteration 4: D1, D2, D3, G)

**A sheet engine** replacing the single-viewport SVG:
- `Sheet` = A-series size and orientation, viewports (each with scale, extent, layer set), title block (project, drawing no., title, scale, date, drawn by, revision), revision table, north point, scale bar, legend generated from active layers, BNG grid ticks.
- One layout renders to **SVG, PNG, and multi-page PDF** (jsPDF + svg2pdf.js), plus a layered DXF.

**Side-elevation slice (section profile), added 2026-11-04.** The user draws a **cut line** on the map (or 3D view; several allowed, A–A, B–B) and gets a **side height profile** drawing:
- Sample the DTM, DSM and the scene's building/bridge/tree solids along the line at 0.25–0.5 m spacing. The ground line is drawn with section hatching below it; buildings the line passes through are **cut** (solid poché, with roof shape from LOD2-fit); everything beyond (up to a chosen depth) is shown in lighter elevation.
- Axes: BNG chainage along the line, levels in ODN with a datum, selectable vertical exaggeration (stated on the sheet), spot levels at ground changes and eaves/ridge heights, river levels, bridge decks.
- Output: SVG/PNG/PDF sheet viewport plus a DXF section on its own layers (`SECTION-GROUND`, `SECTION-CUT`, `SECTION-BEYOND`, `SECTION-ANNO`), and the cut line itself drawn with A–A markers on the site plan.
- Also usable for **site elevations**: a cut line with the view direction chosen and no depth limit gives a flat street elevation.
- **Acceptance:** a synthetic site (gable house on a slope + a tree) gives the exact ground profile, a cut gable outline with the right ridge height, and the tree in the beyond layer.

**Drawing types**, in priority order: (1) **site location plan with red-line boundary** drawn by the user (polygon tool on the map; planning-ready layout); (2) **block/site plan** with spot levels, kerbs, markings, trees, walls; (3) **sections** (user draws cut A–A; ground line, cut buildings with poché, beyond in elevation); (4) **street/site elevations** (project footprints with LOD2-fit roof profiles and the facade parameters); (5) **roof plan** (ridges, hips, pitch arrows with angle, flat-roof hatch); (6) **shadow study sheet** (grid of times); (7) **analysis sheets** (flood, wind, crime, footfall) with legends. Axonometric line drawings remain a stretch.

**Standard layers (AutoCAD).**
- Layer names follow a selectable scheme: *Simple* (today's), *UK BS 1192 / ISO 13567-style* (`A-SITE-ROAD`, `A-SITE-BLDG`, `A-SITE-TOPO-MNR`, `A-SITE-WATR`, `A-SITE-TREE`, `A-SITE-MARK`, `A-ANNO-TEXT`, …), or *AIA*.
- Colours by ACI + **true colour**, lineweights per ISO 128 (0.13/0.18/0.25/0.35/0.5/0.7 mm) written as DXF lineweights, linetypes (continuous, dashed, centre).
- **DXF R2000 (AC1015)** writer: entity handles, `LWPOLYLINE`, `HATCH` (solid fills for water/green/buildings, pattern for roads), `INSERT` blocks (tree, tree-with-trunk, north arrow, entrance), `TEXT`/`MTEXT`, `LAYOUT` with a paper-space viewport at scale (basic). 3D polyface meshes stay R12-compatible in a separate `_3D.dxf`.
- Objects: one entity per feature (building, tree, bridge); building polylines carry **XDATA** (OSM id, heights, LOD, listed grade); layer table with descriptions.
- A **Rhino 3DM** writer (rhino3dm.js, lazy): layers, per-object names, user text (OSM id, heights, grade), materials.
- **GLB** (presentations/web viewers) and **3MF** (colour printing) exporters, from the same `Scene`.
- Validation in the repo (`tools/validate`): ezdxf audit, trimesh closure, 3DM read-back; a manual AutoCAD/Rhino import checklist in the README.

### 4.7 Imagery (bring-your-own)

- Drop-in import of GeoTIFF (geotiff.js, already a dependency) or JPG/PNG + `.jgw/.pgw` world file, in EPSG:27700 or EPSG:4326/3857 (reprojected with the existing proj4/OSTN15 code).
- Uses: **(a)** terrain texture and roof colour in OBJ/GLB/3DM and the 3D view; **(b)** underlay in drawings (user-controlled opacity; excluded from exports unless ticked); **(c)** greenness (excess-green index, or NDVI if an NIR band exists) refining tree detection; **(d)** optional marking refinement (4.5).
- Metadata is kept in the export README, including the user's stated licence.
- Everything processed client-side in tiles (no full-resolution decode of huge files).

### 4.8 Analysis panel

A new **Analysis** tab with a layer-style results list, per-analysis parameters and a legend. Every result can be **exported** (PNG, GeoTIFF/ASC, GeoJSON, DXF layer, and as a drawing sheet). Heavy runs execute in a **Web Worker** with progress and cancel.

**Shadow and sun hours.**
- Sun position from first principles (NOAA algorithm; tested against published values; no dependency).
- Heightfield ray-march on the DSM (buildings, trees, terrain). Outputs: shadow at a chosen date/time with a slider; **hours of direct sun** map for a date or a range; standard UK planning dates (21 Mar/Jun/Sep/Dec) and a 2-hourly sheet; sunrise/sunset; vector shadow polygons for drawings.
- Accuracy: limited by the 1 m DSM; trees are treated as opaque solids (flagged).

**Wind (screening).**
- User chooses direction and reference speed; Open-Meteo suggests local values and a wind rose.
- Method: 2.5D **obstacle-shelter and channelling model**: upwind-fetch roughness from the DSM, shelter behind obstacles (empirical wake length ∝ height), speed-up at building corners and street canyons aligned with the wind (momentum-conserving channel factor), log-law with height. Output: normalised speed ratio map and **Lawson-style comfort bands** for the chosen speed.
- Labelled as an *indicative screening model*; not a substitute for CFD or wind-tunnel studies.

**Flooding (screening).**
- Overlay **EA Flood Zones 2/3** and flood defences (live).
- **Bathtub fill** on the DTM: user chooses a water level (relative to the nearest river-water polygon or absolute ODN, suggestion from the nearest gauge), the flood fills only cells connected to the water source, with EA defence `toe_level` as barriers. Output: depth map, flooded building count and per-building depth, flood-extent polygons.
- Optional "rain-ponding" mode: sink-fill depth map (low spots that collect surface water).
- Labelled as an *indicative extent*, not a flood-risk assessment.

**Crime.**
- Fetch 3–12 months of street-level crime from data.police.uk for the site polygon (polygon vertex limit handled by tiling).
- Kernel-density heatmap, category filter (anti-social behaviour, burglary, violent, theft, …), per-month trend, top streets.
- Caveat shown: locations are snapped to anonymised street points; counts are not rates.

**Entrances and pedestrian activity.**
- **Entrances**: OSM `entrance` nodes; where absent, inferred (the footprint edge nearest the road for buildings with road access; one per ~30 m of frontage). Shown, editable (click to add/remove), exportable.
- **Footfall heatmap**: a gravity-weighted route model on the OSM path graph. Origins = buildings weighted by floor area (residential) and entrances; destinations = POIs (shops, cafés, stations, bus stops, attractions via OSM tags) with category weights; route = shortest path with a mild preference for paths with crossings; accumulate edge flows (distance-decayed betweenness). Output: edge heatmap + hotspot list.
- User-adjustable weights, sliders for "residential / retail / transit". Labelled a *model of likely activity, not observed counts*.

### 4.10 Custom site shapes (added 2026-11-04)

**Goal.** The download area is no longer limited to a rectangle: the user can pick a **polygon, hexagon, circle, or any free-drawn shape** (and later import a GeoJSON/KML outline or a red-line from a planning application).

**Method.**
- The site is stored as a BNG **polygon** plus its bounding box. Fetching (LIDAR WCS, Overpass, flood, crime) still uses the bounding box. Everything is then **clipped to the polygon** with the existing exact clipper (`clipPolygonToBox` generalises to `clipPolygonToPolygon` using `polygon-clipping`/Clipper); raster cells outside the polygon become nodata.
- Preset shapes: rectangle, rotated rectangle, hexagon, circle/ellipse (radius from a centre click), regular n-gon, and "draw polygon" (click vertices, double-click to finish; undo).
- Terrain mesh: the RTIN or grid mesh is cut to the polygon outline, with the skirt/base built from the new boundary loop (`solidWithFlatFloor` already works from any boundary). Laser stacks and drawings use the polygon as the boundary layer; the drawing frame is the bounding box with the polygon drawn as a boundary line.
- Area limit (4 km²) applies to the polygon area; the LIDAR download is based on the bounding box and says so in the size estimate.

**Acceptance.** A hexagon site gives a single-outline watertight terrain solid, features clipped exactly to the edge, and an area figure equal to the polygon area.

### 4.9 Platform and UI

- **Web Workers** for: LIDAR/OSM parsing, scene building, tree detection, RTIN, analyses. A small typed RPC layer (no heavy dependency), cancellable, progress events. `process/*` is already framework-free.
- **Framework migration to Svelte 5** (compiled, small, fine on GitHub Pages) with a central store. The existing imperative `main.ts` (~500 lines) becomes components; the three.js, MapLibre and drawing code are reused unchanged.
- **Guided flow**: Site → Data → Model → Analysis → Export (packs). Output **packs**: *Planning drawings* (PDF + DXF), *CAD context model* (3DM/DXF/OBJ), *3D print* (STL/3MF at scale, sized to printer bed), *Laser-cut*, *Analysis report*, *Raw data*.
- **Shareable URL** (site, settings and active analysis in the hash), **undo** for boundary edits, red-line polygon and section-line tools on the map, building click panel (attributes, override height/roof/LOD, saved in localStorage), progress with named stages and cancel, friendly errors, onboarding tips.
- **IndexedDB cache** for LIDAR tiles and Overpass/Police/EA responses with date shown. (Cache only; this is not pre-baking.)

## 5. Architecture changes

```
src/
  workers/            rpc.ts, scene.worker.ts, analysis.worker.ts
  data/               osm.ts (extended query), lidar.ts, nhle.ts, floodzones.ts, defences.ts, police.ts, weather.ts, imagery.ts, cache.ts
  process/
    rtin.ts           adaptive terrain
    roofparts.ts      decomposition + terrace splitting + shed/gable/hip fitting
    facades.ts        procedural facade layers
    markings.ts       road/path markings
    solidify.ts       manifold-3d unions (lazy)
  analysis/
    sun.ts  shadow.ts  wind.ts  flood.ts  crime.ts  footfall.ts  entrances.ts  raster-export.ts
  export/
    layers.ts         layer-scheme registry (simple / BS1192 / AIA), lineweights, colours
    dxf2000.ts        R2000 writer (handles, LWPOLYLINE, HATCH, blocks, XDATA, layouts)
    sheet.ts          sheet engine + title block + legend
    pdf.ts            multi-page PDF
    gltf.ts  threemf.ts  rhino3dm.ts
  ui/                 Svelte components + store
```

## 6. Milestones (each ends with tests, validation and a commit)

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **M1** | Terrain and roofs | 4.1 RTIN adaptive terrain; 4.2 LOD2-fit roofs (parts, terraces, shed/gable/hip) | tests in 4.1/4.2 pass; Pulteney run shows share of fitted roofs; mesh sizes reported |
| **M2** | Data layers, markings and custom shapes | 4.10 custom site shapes (polygon, hexagon, circle, free-draw, clipped terrain and features); data modules (NHLE, flood zones, defences, police, weather, OSM extras) with caching; 4.5 markings; building attributes (grade, levels) into every export; GeoJSON gains eaves/ridge/LOD | each fetcher has a recorded-response test; markings appear in drawings and 3D |
| **M3** | Analysis | sun/shadow, flood (EA + bathtub), wind screening, crime, entrances, footfall; worker infrastructure; Analysis tab | numerical tests (sun positions, flood connectivity, shadow geometry); each result exports |
| **M4** | Drawings and standards | side-elevation slice from a drawn cut line (4.6); sheet engine, title block, red-line location plan, site plan, sections, elevations, shadow sheet; R2000 DXF with layers/lineweights/hatches/XDATA; PDF; layer schemes | ezdxf audit clean; per-layer entity checks; PDF renders in a headless browser |
| **M5** | Formats and facades | 3DM, GLB, 3MF; manifold unions; procedural facades | read-back validation in trimesh/rhino3dm; STL stays watertight after union |
| **M6** | UI platform | Svelte migration, guided packs, shareable URLs, undo, building panel, imagery import | the e2e driver passes against the new UI; the three-click path works |

Order rationale: M1 answers the user's two most specific requests (roofs, adaptive terrain) and needs no new UI. M2 feeds M3 and M4. M6 comes last so UI is built once against settled features. Workers (4.9) are introduced in M3, when the analyses need them, and then applied to the scene build.

## 7. Risks and decisions to review

| Risk | Mitigation |
|---|---|
| Overpass unreliability | IndexedDB cache, user file import (done), mirrors; messages say what is missing |
| Data.police.uk rate/size limits | tile the polygon, one month at a time, 15 req/s cap, cache |
| Analyses are mistaken for certified results | every panel and export states method, data, and limits |
| Svelte migration churn | done last (M6), behind unchanged `process/` and `export/` APIs |
| Browser memory on 4 km² (16 M cell rasters × several) | workers, Float32 rasters shared as transferables, tiling for analyses |
| R2000 DXF correctness | ezdxf audit in CI-style script, plus a manual AutoCAD/Rhino import checklist (cannot be automated here) |
| Imagery licensing | bring-your-own only; the user's licence note is carried into exports |
| Procedural facades look "authoritative" | labelled procedural; default off; separate layers |

## 8. Items carried over from HANDOFF.md (iterations 2 excluding 2A, 3 and 4)

- **Iteration 2:** B1–B8 done in iteration 2 (see HANDOFF §7). Remaining: **web workers** (4.9), **DXF R2000 hatches** (4.6), **real AutoCAD/Rhino import** (checklist, 4.6), weirs, `building:part` (4.2 uses it as the first source of parts when present), street names text (4.6).
- **Iteration 3:** C1/C2 done. F: **manifold-3d** (4.3), **3DM + GLB + 3MF** (4.6), **B2 mode 2 adaptive terrain** (4.1). C4 chimneys/parapets (4.2 stretch). C5 attributes (M2).
- **Iteration 4:** **D2 sheet engine + PDF**, **D1 location plan, site plan, sections, elevations, shadow study** (4.6, 4.8), **G guided flow, framework, shareable URLs** (4.9).

## 9. Status (updated as work lands)

| Item | Status |
|---|---|
| Dataset audit | done (section 2) |
| M1 adaptive terrain (RTIN) | **done**: 318 k → 54 k triangles at ±10 cm on Pulteney; tests pass |
| M1 chimneys and parapets | **done**: separate `ROOF-DETAIL` layer; Pulteney 701 chimneys, 21 parapets |
| M1 LOD2-fit roofs (terrace split, L-shape decomposition, flat/shed/gable/hip) | **done**: on Pulteney, 289 buildings → 557 parts, 67 non-flat (LOD1.5 found 3); terraces step per house; verified in the browser |
| Custom site shapes (4.10) | planned in M2 |
| Side-elevation slice (4.6) | planned in M4 |
| M2 – M6 | not started |
