# UK Site Model

A static web app (GitHub Pages, no backend) that builds architectural site models and drawings for anywhere in England, using Environment Agency LIDAR and OpenStreetMap. Tuned for Bath.

- **3D model, one object per thing:** terrain, buildings, roads, paths, railways, rivers and water, parks, woodland, squares, bridges, walls and fences, and trees. Each is a separate layer, and each building, tree and bridge is its own named object → OBJ (Rhino/Blender), per-layer STL (3D printing), polyface-mesh DXF (AutoCAD/Rhino).
- **You choose the detail:** every feature can be switched off; buildings can be blocks (LOD1), fitted pitched roofs (LOD1.5) or the LIDAR roof surface (LOD2-raw); terrain and feature meshes can be coarsened to a triangle budget.
- **2D:** contours, footprints, road kerb lines, paths, rail, rivers and water as polygons, bridge decks, walls, roof ridges/hips, trees at crown radius → SVG, PNG, layered DXF.
- **Physical models:** laser-cut contour stack DXF in mm at model scale; print-ready closed solids.
- **Data:** the aligned dataset as GeoJSON (EPSG:27700) plus DTM/DSM ESRI ASCII grids.

Everything runs in the browser. Data is fetched live from public APIs that allow browser access (CORS).

## Data sources

| Dataset | What it contains | How it's used |
|---|---|---|
| **EA LIDAR Composite DTM 1 m** (WCS) | Bare-earth elevation grid, buildings and vegetation removed. Metres above Ordnance Datum Newlyn (ODN), on British National Grid (BNG, EPSG:27700). Float32 GeoTIFF. | Terrain mesh, contours, hillshade, building ground levels |
| **EA LIDAR Composite DSM 1 m** (first return, WCS) | Top-of-surface elevation, including roofs and tree canopy. Same grid. | Building heights from DSM − DTM, and OSM alignment |
| **OpenStreetMap** (Overpass API) | Building footprints (+ `building:levels`, `height`, `roof:*`, heritage tags), roads by class, paths, rail, waterways, water areas, parks, woodland, squares, bridges, individual trees | All vector layers. In Bath, under 1 % of buildings have a `height` tag, so heights come from LIDAR. |
| **OSTN15** (Ordnance Survey) | Official WGS84/ETRS89 ↔ BNG transformation | Baked into `src/geo/ostn15-correction.json` by `tools/build_ostn15_correction.py`; cm-level accuracy |
| OSM raster tiles, EA hillshade WMS | Basemap and LIDAR coverage overlay | Area selection only |

## Processing pipeline

1. **Area:** a BNG-aligned rectangle (integer metres, ≤ 4 km²) drawn on the map, picked from a preset, or found by postcode or grid reference.
2. **LIDAR:** DTM and DSM are fetched as 1 km WCS chunks (4 in parallel, with retries) and stitched into one grid. Nodata holes are filled by interpolating from their edges.
3. **OSM:**
   - A single Overpass query fetches everything, with mirror fallback, backoff and a 90 s timeout per request.
   - osmtogeojson converts it, then features are projected to BNG through OSTN15 and classified.
   - If OSM is unavailable, you still get the terrain.
4. **Alignment:**
   - OSM is traced from aerial imagery that can be 1–3 m out (about 1.75 m east in central Bath).
   - The app searches shifts of up to ±3 m for the one where OSM footprints best match LIDAR roofs (nDSM > 2.5 m), then shifts all OSM features.
   - Polygons are clipped to the site exactly with `polygon-clipping`.
5. **Buildings:**
   - Ground = lowest DTM value under the footprint. Top = a chosen DSM percentile inside it (typical roof 70th, eaves 40th, ridge 95th). Fallbacks: OSM `height`, then `building:levels`, then 7 m.
   - **LOD1** is a closed block sunk 0.5 m into the terrain.
   - **LOD1.5** fits a flat, gable or hip roof to the footprint's oriented box by least squares against the DSM, and keeps it only if the RMS error is ≤ 1.2 m and the pitch is plausible. Stepped terraces on a hillside, and complex roofs, stay as blocks.
   - **LOD2-fit** splits the footprint into parts (one per house in a terrace, found from roofline steps along the long axis; L/T/U shapes bisected into rectangles) and fits flat, shed, gable or hip roofs to each by least squares against the DSM, ignoring edge samples. Each part is its own closed solid (`building_<id>_<n>`), so walls and floor join the roof and ground by construction.
   - **LOD2-raw** cuts the DSM grid to the footprint exactly (the roof edge follows the outline) with walls from the DSM. It looks like the real roofs but is noisy and not guaranteed watertight, so use it for visualisation.
6. **Context features** (`src/process/context.ts`, `buffer.ts`, `scene.ts`):
   - Roads, paths and rail are offset from their centrelines (Clipper): `width` tag, then `lanes` × 3.25 m, then a class default; merged per class so junctions become single outlines (these give the drawing kerb lines).
   - Water = OSM water polygons + river centrelines that no polygon covers. The terrain is carved below the banks, and the water surface sits just under bank level.
   - Roads, paths, rail, water and parks are draped on the terrain by cutting their triangles along the terrain grid, then closed into thin solids (`relief` mm at print scale) or left as lighter open surfaces.
   - Bridge decks follow the lowest DSM across the deck, smoothed and kept within a gentle arch over the abutments. Walls and fences are thin solids. Tunnels are left out of 3D (dashed in drawings).
   - Trees are local maxima of the canopy height model (DSM − DTM, minus buildings and bridges), with OSM tree points taking priority.
7. **Terrain mesh:** either a regular grid, averaged (not just point-sampled) when coarsened, or **adaptive** (right-triangle bintree): the DTM is resampled onto a 2ᵏ+1 grid spanning the site and triangles split only where the vertical error exceeds your tolerance (±5 cm to ±1 m), with a triangle cap that raises the tolerance if needed. Pulteney: 318 k triangles on the 1 m grid → 54 k at ±10 cm. Draped features follow the full-resolution surface and are raised above the tolerance. The step is either set by you or the finest one within a triangle budget. It can be closed with walls and a base for a watertight solid.
8. **Contours:** marching squares on a smoothed grid of about 1.5 M cells, joined into polylines and simplified (Douglas–Peucker). Laser stacks use d3-contour's filled regions.

## Export conventions

- **OBJ:** local origin at the site centre rounded to 10 m (`origin.txt`; add it back to get BNG), metres, Z-up or Y-up. One group (`g`) and material per layer, one object (`o`) per building/tree/bridge/wall. Either **one .obj per layer** (best for Rhino/CAD) or one combined file.
- **STL:** one binary file per layer in a zip (or one merged file), mm at the chosen scale with vertical exaggeration and a base. All files share one origin and register when loaded together. Each layer is built from closed solids.
- **3D DXF:** AutoCAD R12 polyface meshes, one entity per building/tree/bridge, terrain in tiles under AutoCAD's 32,767-vertex limit. Layers `TERRAIN`, `BUILDINGS`, `ROADS`, `PATHS`, `RAIL`, `WATER`, `GREEN`, `WOODLAND`, `PAVED`, `BRIDGES`, `WALLS`, `TREES`.
- **2D DXF:** AutoCAD R12 with named layers (`ROAD-SURFACE`, `BUILDINGS`, `ROOF`, `WATER`, `BRIDGE`, `CONTOUR-MAJOR`, …). Contours are polylines at their elevation; footprints have thickness = building height; trees are INSERTs of a `TREE` block scaled to crown radius, so you can redefine the symbol. True BNG by default.
- **SVG/PNG:** a sheet at the chosen paper scale with scale bar, north arrow and attribution. The SVG layers are named groups (Illustrator/Inkscape).
- **Laser stack DXF:** one layer per level in mm at model scale, either laid out sheet by sheet or stacked at height.

## Choosing mesh size

| Control | Effect |
|---|---|
| Terrain resolution / triangle budget | Grid step in metres, or the finest step within 0.1–4 M triangles. Coarser terrain is box-averaged. |
| Roads, water & parks detail | Cell size (1–8 m) used to follow the terrain. |
| LIDAR-roof detail | Downsamples the DSM for LOD2-raw roofs. |
| Closed solids | Uncheck for open surfaces: roughly half the triangles for roads, water and parks. |

The 3D view lists triangles per layer and warns above 4 M.

## Known limits

- **LOD2.2 (clean roof faces, dormers, chimneys) is not available in the browser.** It needs the EA LIDAR *point clouds* (multi-GB LAZ downloads, not served by the WCS) and a C++ reconstructor such as roofer. A desktop app is the way to get it.
- Georgian terraces step down hillsides, so most central-Bath footprints do not fit a single gable/hip and stay as blocks at LOD1.5; use LOD2-raw for their real roofline.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # unit tests (geometry, CRS, exporters, watertightness)
npm run build   # static site in dist/
```

Deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`. In the repo, set *Settings → Pages → Source* to **GitHub Actions**.

## Licences and attribution

- Contains Environment Agency LIDAR data © Environment Agency copyright and/or database right, [Open Government Licence v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- OSTN15 © Ordnance Survey.

Exports include a `README.txt` with these notices.
