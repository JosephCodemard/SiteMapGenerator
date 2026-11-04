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
  | 'road-major' | 'road-minor' | 'path' | 'rail' | 'river' | 'stream' | 'wall'
  /** Weirs and dams (across a river), embankments and cliffs (the top edge, drawn with ticks), quays and piers. */
  | 'weir' | 'embankment' | 'cliff' | 'quay';
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

export type PointKind = 'entrance' | 'crossing' | 'signals' | 'stop' | 'giveway' | 'transit' | 'poi' | 'lamp';

/** A tagged OSM point (door, crossing, bus stop, shop ...). */
export interface PointFeature {
  id: string;
  kind: PointKind;
  p: XY;
  tags: Record<string, string>;
}

export interface ListedInfo {
  grade: string;
  entry: number;
  name: string;
}

export type HeightSource = 'lidar' | 'osm-height' | 'osm-levels' | 'default' | 'override';

/** Fitted roof shape for LOD1.5: a flat block, or a gable / hip over the footprint's oriented box. */
export interface RoofFit {
  /**
   * flat / shed (mono-pitch) / gable / hip, `mansard` (a profile roof: steep lower slope then a shallower or flat top,
   * with `profile`), or `surface` (a complex roof such as a church kept as the smoothed LIDAR surface).
   */
  type: 'flat' | 'shed' | 'gable' | 'hip' | 'mansard' | 'surface';
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
  /** Shed roofs: plane z = c + a*u + b*v in box coordinates (u along `axis`, v across). */
  plane?: [number, number, number];
  /** Mansard roofs: [t, z] break points from the eaves (t = 0, horizontal distance in from the wall) to the top (t = b). */
  profile?: [number, number][];
  /** Mansard roofs: the short ends slope too (hipped) rather than standing as vertical gable / party walls. */
  hipped?: boolean;
  /** Where the shape came from: LIDAR fit, or an OSM `roof:shape` tag. */
  hint?: string;
}

/** A `building:part` polygon from OSM: a separately tagged volume (tower, nave, wing) inside a building. */
export interface BuildingPart {
  id: string;
  rings: Ring[];
  tags: Record<string, string>;
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
  /** LOD2-fit: one fitted roof per part (house in a terrace, wing of an L-shape). */
  roofParts?: RoofFit[];
  /** Historic England listing, if any. */
  listed?: ListedInfo;
  /** OSM `building:part` volumes that lie inside this footprint (roof:shape, height, min_height ...). */
  parts?: BuildingPart[];
  /** Dormers and roof windows found or placed on the roofs (LOD2-fit). */
  dormers?: { p: XY; width: number; procedural: boolean }[];
  /** Mean roof colour from user imagery (#rrggbb). */
  roofColour?: string;
}

/** The fetched, aligned dataset (everything in BNG / ODN heights). */
export interface SiteData {
  bbox: BBox;
  /** Local origin used for 3D exports (site centre, rounded to 10 m). */
  origin: XY;
  dtm: Raster;
  dsm: Raster | null;
  /** Greenness 0-1 on a raster (from user imagery); roofs ignore LIDAR cells over vegetation. */
  vegetation?: Raster | null;
  /** Road paint found in user imagery (white / yellow blobs on the road surface). */
  detectedMarkings?: { kind: 'detected'; colour: 'white' | 'yellow' | 'red'; ring: Ring }[];
  buildings: Building[];
  lines: LineFeature[];
  areas: AreaFeature[];
  trees: XY[];
  /** Doors, crossings, stops, POIs (OSM). */
  points: PointFeature[];
  /** Custom site outline (BNG, CCW, open ring); absent for a plain rectangle. `bbox` then bounds it. */
  shape?: Ring;
  /** Shift applied to OSM features to match LIDAR (m east, m north). */
  osmOffset: XY;
  fetchedAt: string;
  filledCells: number;
}
