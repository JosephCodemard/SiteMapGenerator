import type { Layer } from './drawing';

/**
 * Layer naming schemes and line weights for CAD export.
 *
 * - **simple**: the app's own readable names (`ROAD-SURFACE`, `BUILDINGS`).
 * - **ncs**: US National CAD Standard / AIA style `DISCIPLINE-MAJOR-MINOR` names (`C-ROAD-KERB`, `A-SITE-BLDG`,
 *   `C-TOPO-MAJR`), widely used in UK practices too.
 * An optional prefix (e.g. a project code) is added to either, because real BS EN ISO 13567 codes are firm- and
 * project-specific: set your own prefix, or rename layers after import.
 */
export type SchemeId = 'simple' | 'ncs';

export const SCHEMES: Record<SchemeId, { label: string; map: Record<string, string> }> = {
  simple: { label: 'Simple (readable names)', map: {} },
  ncs: {
    label: 'NCS / AIA style (C-ROAD-KERB, A-SITE-BLDG …)',
    map: {
      BUILDINGS: 'A-SITE-BLDG', LISTED: 'A-SITE-BLDG-LIST', 'BLDG-LABEL': 'A-ANNO-TEXT', ROOF: 'A-ROOF-RIDG', 'ROOF-PITCH': 'A-ROOF-PTCH',
      ENTRANCE: 'A-SITE-ENTR', 'ROAD-SURFACE': 'C-ROAD-KERB', 'ROAD-MINOR': 'C-ROAD-CNTR', 'ROAD-MAJOR': 'C-ROAD-CNTR',
      'ROAD-MARK': 'C-ROAD-MARK', 'ROAD-MARK-Y': 'C-ROAD-MARK-YLW', 'ROAD-MARK-CYCLE': 'C-ROAD-MARK-CYCL', PATH: 'C-PATH', RAIL: 'C-RAIL',
      'RAIL-CL': 'C-RAIL-CNTR', WATER: 'C-WATR', WATERWAY: 'C-WATR-CNTR', BRIDGE: 'C-BRDG', WALL: 'C-WALL', GREEN: 'L-AREA-GRSS',
      WOOD: 'L-PLNT-WOOD', PAVED: 'L-PAVE', TREES: 'L-PLNT-TREE', 'CONTOUR-MINOR': 'C-TOPO-MNOR', 'CONTOUR-MAJOR': 'C-TOPO-MAJR',
      'CONTOUR-LABEL': 'C-TOPO-TEXT', 'SPOT-LEVEL': 'C-TOPO-SPOT', BOUNDARY: 'C-PROP-BNDY', REDLINE: 'C-PROP-REDL',
      'SECTION-GROUND': 'A-SECT-GRND', 'SECTION-CUT': 'A-SECT-CUT', 'SECTION-BEYOND': 'A-SECT-BYND', 'SECTION-ANNO': 'A-SECT-ANNO',
      'SECTION-WATER': 'A-SECT-WATR', 'SECTION-TREE': 'A-SECT-TREE', 'SHEET-FRAME': 'G-ANNO-TTLB', 'SHEET-TEXT': 'G-ANNO-TEXT',
    },
  },
};

/** ISO 128 pen widths (mm). */
export const ISO_WEIGHTS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7];

export const snapWeight = (w: number) => ISO_WEIGHTS.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));

/** DXF lineweight code (hundredths of a millimetre). */
export const dxfLineweight = (mm: number) => Math.round(snapWeight(mm) * 100);

const clean = (s: string) => s.replace(/[<>/\\":;?*|=`,]/g, '_').toUpperCase();

export function layerName(name: string, scheme: SchemeId, prefix = ''): string {
  return clean(prefix + (SCHEMES[scheme].map[name] ?? name));
}

/** Layers renamed for a scheme, with weights snapped to the ISO 128 series. Items are shared, not copied. */
export function restyle(layers: Layer[], scheme: SchemeId, prefix = ''): Layer[] {
  const seen = new Map<string, Layer>();
  for (const l of layers) {
    const name = layerName(l.name, scheme, prefix);
    const hit = seen.get(name);
    // Two internal layers can map to one scheme layer (e.g. major/minor centrelines): merge their items.
    if (hit) hit.items = [...hit.items, ...l.items];
    else seen.set(name, { ...l, name, weight: snapWeight(l.weight) });
  }
  return [...seen.values()];
}

/** `#rrggbb` -> 24-bit integer for DXF group code 420. */
export const trueColour = (hex: string) => parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
