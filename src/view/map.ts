import { Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// MapLibre 6 loads an ES-module worker; let Vite bundle it so the URL survives dev pre-bundling and the build.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { toBNG, toWGS } from '../geo/bng';
import type { BBox } from '../types';

setWorkerUrl(workerUrl);

const EA_WMS =
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms' +
  '?service=WMS&request=GetMap&version=1.3.0&layers=Lidar_Composite_Hillshade_DTM_1m&styles=' +
  '&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}';

/** Basemap + BNG-aligned rectangle selection. */
export class AreaMap {
  map: MapLibre;
  private drawing = false;
  private start: [number, number] | null = null;
  onChange: (b: BBox) => void = () => {};

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
        },
        layers: [
          { id: 'osm', type: 'raster', source: 'osm' },
          { id: 'lidar', type: 'raster', source: 'lidar', paint: { 'raster-opacity': 0.5 }, layout: { visibility: 'none' } },
          { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#e0006b', 'fill-opacity': 0.12 } },
          { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#e0006b', 'line-width': 2 } },
        ],
      },
    });
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.map.on('mousedown', (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      this.start = toBNG(e.lngLat.lng, e.lngLat.lat);
    });
    this.map.on('mousemove', (e) => {
      if (!this.drawing || !this.start) return;
      this.setArea(this.rect(this.start, toBNG(e.lngLat.lng, e.lngLat.lat)), true);
    });
    this.map.on('mouseup', (e) => {
      if (!this.drawing || !this.start) return;
      const b = this.rect(this.start, toBNG(e.lngLat.lng, e.lngLat.lat));
      this.start = null;
      this.setDrawing(false);
      if (b.maxE - b.minE >= 10 && b.maxN - b.minN >= 10) this.setArea(b);
    });
  }

  private rect(a: [number, number], b: [number, number]): BBox {
    return {
      minE: Math.round(Math.min(a[0], b[0])), maxE: Math.round(Math.max(a[0], b[0])),
      minN: Math.round(Math.min(a[1], b[1])), maxN: Math.round(Math.max(a[1], b[1])),
    };
  }

  setDrawing(on: boolean) {
    this.drawing = on;
    on ? this.map.dragPan.disable() : this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  /** Show the BNG rectangle (it's slightly rotated on a Web Mercator map). */
  setArea(b: BBox, preview = false) {
    const ring = [
      toWGS(b.minE, b.minN), toWGS(b.maxE, b.minN), toWGS(b.maxE, b.maxN), toWGS(b.minE, b.maxN), toWGS(b.minE, b.minN),
    ];
    (this.map.getSource('aoi') as GeoJSONSource | undefined)?.setData({
      type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] },
    });
    if (!preview) this.onChange(b);
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
