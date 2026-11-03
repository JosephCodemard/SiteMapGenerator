# UK Site Model

A static web app (GitHub Pages, no backend) that builds architectural site models and drawings for anywhere in England, using Environment Agency LIDAR and OpenStreetMap. Tuned for Bath.

- **3D:** terrain plus LOD1 building blocks (flat-roofed extrusions), with an optional draped map texture → OBJ (Rhino/AutoCAD), watertight STL (3D printing).
- **2D:** contours, building footprints, roads, paths, rail, rivers, water, parks, woodland, bridges, trees → SVG, PNG, DXF (AutoCAD R12).
- **Physical models:** laser-cut contour stack DXF in mm at model scale.
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
5. **Buildings (LOD1):**
   - Ground = lowest DTM value under the footprint.
   - Top = a chosen percentile of DSM values inside it: typical roof 70th, eaves 40th, ridge 95th.
   - Fallbacks, in order: OSM `height`, then `building:levels`, then 7 m.
   - Each block is a closed, outward-facing prism sunk 0.5 m into the terrain.
6. **Terrain mesh:** a regular grid; the step is picked automatically to stay under about 1 M vertices. It can be closed with walls and a base for a watertight solid.
7. **Contours:** marching squares on a smoothed grid of about 1.5 M cells, joined into polylines and simplified (Douglas–Peucker). Laser stacks use d3-contour's filled regions.

## Export conventions

- **OBJ:**
  - Local origin at the site centre, rounded to 10 m (`origin.txt`); add it back to get BNG.
  - Metres, Z-up (Rhino/AutoCAD) or Y-up.
  - One object per building; terrain texture in `terrain.png`.
- **STL:** binary; mm at the chosen scale (1:500 to 1:5000) with vertical exaggeration and a base thickness. Each body is closed.
- **DXF:**
  - AutoCAD R12, with named layers (`CONTOUR-MAJOR`, `BUILDINGS`, `ROAD-MINOR`, …).
  - Contours are polylines at their elevation. Footprints are closed polylines at ground level, with thickness set to building height, so they show as 3D blocks in AutoCAD.
  - Coordinates are true BNG by default.
- **SVG/PNG:** a sheet at the chosen paper scale with scale bar, north arrow and attribution. The SVG layers are named groups (Illustrator/Inkscape).
- **Laser stack DXF:** one layer per level in mm at model scale, either laid out sheet by sheet or stacked at height.

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
