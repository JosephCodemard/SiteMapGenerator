import { Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// MapLibre 6 loads an ES-module worker; let Vite bundle it so the URL survives dev pre-bundling and the build.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { toBNG, toWGS } from '../geo/bng';
import { bboxOf, circle, hexagon, normaliseShape, isSimple, type ShapeKind } from '../process/shape';
import type { BBox, Ring, XY } from '../types';

setWorkerUrl(workerUrl);

const EA_WMS =
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms' +
  '?service=WMS&request=GetMap&version=1.3.0&layers=Lidar_Composite_Hillshade_DTM_1m&styles=' +
  '&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}';

/** Basemap + BNG-aligned rectangle selection. */
export class AreaMap {
  map: MapLibre;
  private tool: ShapeKind | null = null;
  private start: [number, number] | null = null;
  private verts: XY[] = [];
  private hover: XY | null = null;
  /** Called with the finished outline (null = plain rectangle) and its bounding box. */
  onShape: (shape: Ring | null, b: BBox) => void = () => {};
  onChange: (b: BBox) => void = () => {};
  onMessage: (m: string) => void = () => {};
  /** Finished planning red-line outline (when the polygon tool was started for it). */
  onRedLine: (ring: Ring) => void = () => {};
  /** A finished section cut line A -> B (BNG). */
  onCut: (a: XY, b: XY) => void = () => {};
  private target: 'site' | 'redline' = 'site';
  private cutStart: XY | null = null;

  constructor(el: HTMLElement, center: [number, number]) {
    this.map = new MapLibre({
      container: el,
      center,
      zoom: 15,
      maxZoom: 19,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster', tileSize: 256, maxzoom: 19,
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
          lidar: {
            type: 'raster', tileSize: 256, tiles: [EA_WMS], minzoom: 11,
            attribution: 'LIDAR © Environment Agency (OGL v3)',
          },
          aoi: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          redline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          cuts: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'osm', type: 'raster', source: 'osm' },
          { id: 'lidar', type: 'raster', source: 'lidar', paint: { 'raster-opacity': 0.5 }, layout: { visibility: 'none' } },
          { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#e0006b', 'fill-opacity': 0.12 } },
          { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#e0006b', 'line-width': 2 } },
          { id: 'redline-line', type: 'line', source: 'redline', paint: { 'line-color': '#e00000', 'line-width': 3 } },
          { id: 'cuts-line', type: 'line', source: 'cuts', paint: { 'line-color': '#0b3d91', 'line-width': 2.5, 'line-dasharray': [3, 2] } },
          { id: 'cuts-pts', type: 'circle', source: 'cuts', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#0b3d91' } },
        ],
      },
    });
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    const bng = (e: { lngLat: { lng: number; lat: number } }): XY => toBNG(e.lngLat.lng, e.lngLat.lat);
    this.map.on('mousedown', (e) => {
      if (!this.tool || this.tool === 'polygon') return;
      e.preventDefault();
      this.start = bng(e);
    });
    this.map.on('mousemove', (e) => {
      if (!this.tool) return;
      const p = bng(e);
      if (this.tool === 'polygon') { this.hover = p; if (this.verts.length) this.showPolygon(); return; }
      if (this.start) this.preview(this.start, p);
    });
    this.map.on('mouseup', (e) => {
      if (!this.tool || this.tool === 'polygon' || !this.start) return;
      const [a, p] = [this.start, bng(e)];
      this.start = null;
      if (this.tool === 'rect') {
        const b = this.rect(a, p);
        this.setTool(null);
        if (b.maxE - b.minE >= 10 && b.maxN - b.minN >= 10) { this.setArea(b); this.onShape(null, b); }
        return;
      }
      this.finish(this.shapeFrom(a, p));
    });
    this.map.on('click', (e) => {
      if ((this.tool as string) === 'cut') {
        const p = bng(e);
        if (!this.cutStart) { this.cutStart = p; this.onMessage('Click the end of the cut line.'); return; }
        const a = this.cutStart;
        this.setTool(null);
        if (Math.hypot(p[0] - a[0], p[1] - a[1]) >= 3) this.onCut(a, p);
        return;
      }
      if (this.tool !== 'polygon') return;
      this.verts.push(bng(e));
      this.showPolygon();
    });
    this.map.on('dblclick', (e) => {
      if (this.tool !== 'polygon') return;
      e.preventDefault();
      this.verts.pop(); // the double-click's second click was added as a vertex
      this.finishPolygon();
    });
    window.addEventListener('keydown', (e) => {
      if (this.tool !== 'polygon') return;
      if (e.key === 'Enter') this.finishPolygon();
      else if (e.key === 'Backspace') { this.verts.pop(); this.showPolygon(); }
      else if (e.key === 'Escape') this.setTool(null);
    });
  }

  /** Outline for a drag from `a` to `b` with the current tool. */
  private shapeFrom(a: XY, b: XY): Ring | null {
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (this.tool === 'hexagon') return hexagon(a, r);
    if (this.tool === 'circle') return circle(a, r);
    return null; // rectangle
  }

  private preview(a: XY, b: XY) {
    const shape = this.shapeFrom(a, b);
    this.setArea(shape ? bboxOf(shape) : this.rect(a, b), true, shape);
  }

  private finish(shape: Ring | null) {
    const box = shape ? bboxOf(shape) : null;
    this.setTool(null);
    if (shape && box && box.maxE - box.minE >= 10) { this.setArea(box, true, shape); this.onShape(shape, box); }
  }

  private showPolygon() {
    const pts = this.hover && this.tool === 'polygon' ? [...this.verts, this.hover] : this.verts;
    (this.map.getSource(this.target === 'redline' ? 'redline' : 'aoi') as GeoJSONSource | undefined)?.setData({
      type: 'Feature', properties: {},
      geometry: pts.length > 2 ? { type: 'Polygon', coordinates: [[...pts.map(([e, n]) => toWGS(e, n)), toWGS(...pts[0])]] }
        : { type: 'LineString', coordinates: pts.map(([e, n]) => toWGS(e, n)) },
    });
  }

  private finishPolygon() {
    const ring = normaliseShape(this.verts);
    if (ring.length < 3) { this.onMessage('A polygon needs at least 3 corners.'); return; }
    if (!isSimple(ring)) { this.onMessage('The outline crosses itself — undo a corner (Backspace) and try again.'); return; }
    this.verts = [];
    if (this.target === 'redline') { this.setTool(null); this.setRedLine(ring); this.onRedLine(ring); return; }
    this.finish(ring);
  }

  private rect(a: [number, number], b: [number, number]): BBox {
    return {
      minE: Math.round(Math.min(a[0], b[0])), maxE: Math.round(Math.max(a[0], b[0])),
      minN: Math.round(Math.min(a[1], b[1])), maxN: Math.round(Math.max(a[1], b[1])),
    };
  }

  /** Start a drawing tool (rectangle: drag corner to corner; hexagon/circle: drag from the centre; polygon: click corners, double-click to finish). */
  setTool(kind: ShapeKind | 'cut' | null, target: 'site' | 'redline' = 'site') {
    this.tool = kind as ShapeKind | null;
    this.target = target;
    this.cutStart = null;
    this.start = null;
    this.verts = [];
    this.hover = null;
    kind ? this.map.dragPan.disable() : this.map.dragPan.enable();
    kind === 'polygon' ? this.map.doubleClickZoom.disable() : this.map.doubleClickZoom.enable();
    this.map.getCanvas().style.cursor = kind ? 'crosshair' : '';
  }

  /** Back-compat: rectangle tool on/off. */
  setDrawing(on: boolean) { this.setTool(on ? 'rect' : null); }

  /** Show the site (a BNG rectangle, or a custom outline). */
  setArea(b: BBox, preview = false, shape: Ring | null = null) {
    const ring = (shape ?? [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN]]).map(([e, n]) => toWGS(e, n));
    (this.map.getSource('aoi') as GeoJSONSource | undefined)?.setData({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    });
    if (!preview) this.onChange(b);
  }

  setRedLine(ring: Ring | null) {
    (this.map.getSource('redline') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: ring ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...ring, ring[0]].map(([e, n]) => toWGS(e, n)) } }] : [],
    });
  }

  /** Show the section cut lines (A, B markers). */
  setCuts(cuts: { a: XY; b: XY }[]) {
    (this.map.getSource('cuts') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: cuts.flatMap((c) => [
        { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [toWGS(...c.a), toWGS(...c.b)] } },
        { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: toWGS(...c.a) } },
        { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: toWGS(...c.b) } },
      ]),
    });
  }

  fitArea(b: BBox) {
    const sw = toWGS(b.minE, b.minN), ne = toWGS(b.maxE, b.maxN);
    this.map.fitBounds([sw, ne], { padding: 60, duration: 600 });
  }

  setLidarOverlay(on: boolean) {
    this.map.setLayoutProperty('lidar', 'visibility', on ? 'visible' : 'none');
  }

  flyTo(lon: number, lat: number) {
    this.map.flyTo({ center: [lon, lat], zoom: 16 });
  }
}
