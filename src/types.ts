/** All coordinates are British National Grid (EPSG:27700) metres unless noted. */
export type XY = [number, number];
export type Ring = XY[];

export interface BBox {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

/** North-up grid. Cell (i, j) centre = (minE + (i + .5) * res, maxN - (j + .5) * res). */
export interface Raster {
  width: number;
  height: number;
  minE: number;
  maxN: number;
  res: number;
  data: Float32Array;
}

export type LineKind =
  | 'road-major' | 'road-minor' | 'path' | 'rail' | 'river' | 'stream' | 'wall';
export type AreaKind = 'water' | 'green' | 'wood' | 'paved' | 'bridge';

export interface LineFeature {
  id: string;
  kind: LineKind;
  coords: Ring;
  bridge: boolean;
  tunnel: boolean;
  name?: string;
  tags: Record<string, string>;
}

export interface AreaFeature {
  id: string;
  kind: AreaKind;
  /** First ring is the outer boundary, the rest are holes. */
  rings: Ring[];
  tags: Record<string, string>;
}

export type HeightSource = 'lidar' | 'osm-height' | 'osm-levels' | 'default';

/** Fitted roof shape for LOD1.5: a flat block, or a gable / hip over the footprint's oriented box. */
export interface RoofFit {
  type: 'flat' | 'gable' | 'hip';
  /** Eaves and ridge, m ODN. */
  eaves: number;
  ridge: number;
  /** Oriented bounding box: centre, unit vector along the long axis, half-length (a) and half-width (b). */
  centre: XY;
  axis: XY;
  a: number;
  b: number;
  /** RMS error of the chosen shape against the DSM (m). */
  rmse: number;
}

export interface Building {
  id: string;
  rings: Ring[];
  tags: Record<string, string>;
  /** Lowest ground level (DTM) under the footprint, m ODN. */
  ground: number;
  /** Top of the LOD1 block, m ODN. */
  top: number;
  source: HeightSource;
  /** Fitted roof shape, set when the model is built at LOD1.5. */
  roof?: RoofFit;
}

/** The fetched, aligned dataset (everything in BNG / ODN heights). */
export interface SiteData {
  bbox: BBox;
  /** Local origin used for 3D exports (site centre, rounded to 10 m). */
  origin: XY;
  dtm: Raster;
  dsm: Raster | null;
  buildings: Building[];
  lines: LineFeature[];
  areas: AreaFeature[];
  trees: XY[];
  /** Shift applied to OSM features to match LIDAR (m east, m north). */
  osmOffset: XY;
  fetchedAt: string;
  filledCells: number;
}
