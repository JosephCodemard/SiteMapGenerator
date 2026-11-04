import type { Layer } from './drawing';

/**
 * Drawing styles for sheets (SVG / PNG / PDF). The geometry is the same for every style; a style restyles layers
 * (stroke, fill, weight, hatch patterns, filters) and sets the sheet's paper and ink. DXF always keeps the plain layers.
 *
 * - `standard`: the app's default colour drawing.
 * - `planning`: black-and-white, ISO 128 line weights, hatches (OS-style): for planning submissions and printing.
 * - `figure-ground`: Nolli plan: solid black buildings on white.
 * - `presentation`: soft colours, hillshade and drop shadows.
 * - `sketch`: hand-drawn look on warm paper: wobbling pencil lines, washes, pencil hatching (SVG filters).
 * - `blueprint`: white lines on blue.
 */
export type StyleId = 'standard' | 'planning' | 'figure-ground' | 'presentation' | 'sketch' | 'blueprint';

export interface DrawingStyle {
  id: StyleId;
  label: string;
  /** Sheet paper colour and the ink used for the frame, text and scale bar. */
  paper: string;
  ink: string;
  ink2: string;
  /** Font stack for sheet text. */
  font: string;
  /** SVG <defs> content (patterns, filters) the overrides refer to. */
  defs: string;
  /** Per-layer overrides; `hide` removes the layer. */
  layers: Record<string, Partial<Layer> & { hide?: boolean }>;
  /** Applied to every layer that has no filter of its own. */
  filter?: string;
  /** Overlay drawn above the paper before the layers (paper grain). */
  grain?: boolean;
  /** Hillshade underlay opacity multiplier (0 = none). */
  hillshade: number;
}

const pat = (id: string, w: number, h: number, body: string, extra = '') => `<pattern id="${id}" width="${w}" height="${h}" patternUnits="userSpaceOnUse"${extra}>${body}</pattern>`;
const DASH_DEFS =
  pat('p-diag', 1.2, 1.2, '<path d="M-0.3 1.5 L1.5 -0.3 M-0.3 0.3 L0.3 -0.3 M0.9 1.5 L1.5 0.9" stroke="#000" stroke-width="0.12"/>') +
  pat('p-dots', 2.2, 2.2, '<circle cx="0.6" cy="0.6" r="0.14" fill="#555"/><circle cx="1.7" cy="1.7" r="0.14" fill="#555"/>') +
  pat('p-wood', 3, 3, '<circle cx="1.5" cy="1.5" r="0.9" fill="none" stroke="#444" stroke-width="0.1"/><circle cx="1.5" cy="1.5" r="0.12" fill="#444"/>') +
  pat('p-water', 3, 1.4, '<path d="M0 0.7 Q0.75 0.1 1.5 0.7 T3 0.7" fill="none" stroke="#2b5d9b" stroke-width="0.14"/>') +
  pat('p-earth', 1.6, 1.6, '<path d="M0 0.8 L1.6 0.8 M0.8 0 L0.8 0.5" stroke="#444" stroke-width="0.1"/>') +
  pat('p-rail', 1.6, 1.6, '<path d="M0 0 L1.6 1.6" stroke="#000" stroke-width="0.12"/>') +
  pat('p-pave', 3, 3, '<path d="M0 1.5 L3 1.5 M1.5 0 L1.5 3" stroke="#bbb" stroke-width="0.06"/>') +
  pat('p-pencil-green', 1.6, 1.6, '<path d="M0.1 1.4 L1.4 0.1 M-0.2 0.5 L0.5 -0.2" stroke="#6f8f58" stroke-width="0.11" stroke-linecap="round"/>') +
  pat('p-pencil-grey', 1.4, 1.4, '<path d="M0 1.4 L1.4 0" stroke="#6b6358" stroke-width="0.08"/>') +
  pat('p-pencil-wood', 2.2, 2.2, '<path d="M0.1 2 L2 0.1 M-0.1 0.8 L0.8 -0.1 M1.3 2.3 L2.3 1.3" stroke="#56764a" stroke-width="0.13" stroke-linecap="round"/>');

const SHADOW = '<filter id="shadow" x="-5%" y="-5%" width="115%" height="115%"><feDropShadow dx="0.9" dy="0.9" stdDeviation="0.7" flood-color="#000" flood-opacity="0.28"/></filter>';
const ROUGH =
  '<filter id="rough" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="7" result="n"/>' +
  '<feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G"/></filter>';
const ROUGH_SHADOW =
  '<filter id="rough-shadow" x="-2%" y="-2%" width="106%" height="106%"><feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="7" result="n"/>' +
  '<feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
  '<feDropShadow in="d" dx="1.1" dy="1.1" stdDeviation="0.4" flood-color="#5a4a30" flood-opacity="0.35"/></filter>';
const GRAIN =
  '<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.2  0 0 0 0.16 0"/></filter>';

const HELV = 'Helvetica, Arial, sans-serif';
const PENCIL = '"Bradley Hand", "Segoe Print", "Comic Sans MS", "Chalkboard SE", cursive';

const mono = (stroke: string, weight: number, fill?: string): Partial<Layer> => ({ stroke, weight, fill: fill ?? 'none' });

export const STYLES: Record<StyleId, DrawingStyle> = {
  standard: { id: 'standard', label: 'Standard (colour)', paper: '#ffffff', ink: '#000000', ink2: '#555555', font: HELV, defs: '', layers: {}, hillshade: 1 },

  planning: {
    id: 'planning', label: 'Planning (black & white, ISO 128 weights, hatched)', paper: '#ffffff', ink: '#000000', ink2: '#444444', font: HELV, defs: DASH_DEFS, hillshade: 0,
    layers: {
      BUILDINGS: mono('#000', 0.35, 'url(#p-diag)'), LISTED: mono('#000', 0.5, 'url(#p-diag)'), 'ROAD-SURFACE': mono('#000', 0.25, '#fff'),
      KERB: mono('#000', 0.25), PAVEMENT: mono('#444', 0.13, 'url(#p-pave)'), PATH: mono('#444', 0.13, '#fff'),
      WATER: mono('#000', 0.18, 'url(#p-water)'), WATERWAY: mono('#000', 0.13), GREEN: mono('#777', 0.13, 'url(#p-dots)'), WOOD: mono('#555', 0.13, 'url(#p-wood)'),
      PAVED: mono('#888', 0.13, '#fff'), RAIL: mono('#000', 0.35, 'url(#p-rail)'), BRIDGE: mono('#000', 0.5, '#fff'), EARTHWORKS: mono('#000', 0.13, 'url(#p-earth)'),
      'EARTH-EDGE': mono('#000', 0.25), WEIR: mono('#000', 0.35), WALL: mono('#000', 0.25), TREES: mono('#222', 0.18),
      'CONTOUR-MINOR': mono('#888', 0.13), 'CONTOUR-MAJOR': mono('#444', 0.25), 'CONTOUR-LABEL': mono('#444', 0.13),
      'ROAD-MARK': mono('#000', 0.05, '#fff'), 'ROAD-MARK-Y': mono('#000', 0.05, '#bbb'), 'ROAD-MARK-CYCLE': mono('#000', 0.05, '#ddd'),
      ROOF: mono('#000', 0.18), 'ROOF-PITCH': mono('#000', 0.13), 'BLDG-LABEL': mono('#000', 0.13), ENTRANCE: mono('#000', 0.25), REDLINE: mono('#000', 0.7),
    },
  },

  'figure-ground': {
    id: 'figure-ground', label: 'Figure-ground (solid black buildings)', paper: '#ffffff', ink: '#000000', ink2: '#555555', font: HELV, defs: '', hillshade: 0,
    layers: {
      BUILDINGS: mono('#000', 0.1, '#000'), LISTED: mono('#000', 0.1, '#000'), 'ROAD-SURFACE': mono('#fff', 0, '#fff'), PAVEMENT: mono('#fff', 0, '#fff'), PATH: mono('#fff', 0, '#fff'),
      WATER: mono('#bbb', 0, '#d4d4d4'), GREEN: mono('#eee', 0, '#f2f2f2'), WOOD: mono('#ddd', 0, '#e4e4e4'), PAVED: mono('#fff', 0, '#fff'), RAIL: mono('#999', 0, '#cfcfcf'),
      BRIDGE: mono('#000', 0.1, '#000'), TREES: mono('#aaa', 0.1), EARTHWORKS: mono('#ccc', 0, '#ececec'),
      WATERWAY: { hide: true }, KERB: { hide: true }, 'ROAD-MARK': { hide: true }, 'ROAD-MARK-Y': { hide: true }, 'ROAD-MARK-CYCLE': { hide: true },
      'CONTOUR-MINOR': { hide: true }, 'CONTOUR-MAJOR': { hide: true }, 'CONTOUR-LABEL': { hide: true }, ROOF: { hide: true }, 'ROOF-PITCH': { hide: true },
      'SPOT-LEVEL': { hide: true }, 'EARTH-EDGE': { hide: true }, WALL: mono('#777', 0.1), ENTRANCE: { hide: true }, WEIR: { hide: true },
    },
  },

  presentation: {
    id: 'presentation', label: 'Presentation (soft colour, shadows)', paper: '#fbfaf7', ink: '#2c2a26', ink2: '#6a655b', font: HELV, defs: SHADOW, hillshade: 1.3,
    layers: {
      BUILDINGS: { stroke: '#7d7467', weight: 0.25, fill: '#fdfbf6', filter: 'url(#shadow)' }, LISTED: { stroke: '#7b2d8e', weight: 0.4, fill: '#f0e2f5' },
      'ROAD-SURFACE': { stroke: '#a9a397', weight: 0.13, fill: '#d6d1c6' }, KERB: { stroke: '#8d877b', weight: 0.13 }, PAVEMENT: { stroke: '#cfc8b9', weight: 0.1, fill: '#ebe7dc' },
      PATH: { stroke: '#cbb98f', weight: 0.1, fill: '#e8dcc0' }, GREEN: { stroke: '#a8c690', weight: 0.1, fill: '#d3e6bd' }, WOOD: { stroke: '#8cb077', weight: 0.1, fill: '#b2cf9e' },
      WATER: { stroke: '#7eb0d6', weight: 0.15, fill: '#b5d6ec' }, PAVED: { stroke: '#d8d2c6', weight: 0.1, fill: '#efebe2' }, RAIL: { stroke: '#7d766d', weight: 0.2, fill: '#b7b0a6' },
      EARTHWORKS: { stroke: '#c9bb8e', weight: 0.1, fill: '#dcd0a6' }, BRIDGE: { stroke: '#a45a52', weight: 0.35, fill: '#e7c9c4' }, TREES: { stroke: '#5f9a4c', weight: 0.15 },
    },
  },

  sketch: {
    id: 'sketch', label: 'Sketch (hand-drawn pencil & wash)', paper: '#f5eedd', ink: '#3b352c', ink2: '#6e6556', font: PENCIL, defs: DASH_DEFS + ROUGH + ROUGH_SHADOW + GRAIN, filter: 'url(#rough)', grain: true, hillshade: 0.5,
    layers: {
      BUILDINGS: { stroke: '#3b352c', weight: 0.32, fill: '#efe2c6', filter: 'url(#rough-shadow)' }, LISTED: { stroke: '#6b3a78', weight: 0.4, fill: '#e6d3e2', filter: 'url(#rough-shadow)' },
      'ROAD-SURFACE': { stroke: '#4a4339', weight: 0.2, fill: '#e6dcc5' }, KERB: { stroke: '#4a4339', weight: 0.18 }, PAVEMENT: { stroke: '#7a705e', weight: 0.12, fill: '#f0e7d2' },
      PATH: { stroke: '#7a705e', weight: 0.12, fill: '#ecdfc0' }, GREEN: { stroke: '#6f8f58', weight: 0.13, fill: 'url(#p-pencil-green)' }, WOOD: { stroke: '#56764a', weight: 0.13, fill: 'url(#p-pencil-wood)' },
      WATER: { stroke: '#4f7f95', weight: 0.2, fill: '#bcd6d6' }, PAVED: { stroke: '#8a8070', weight: 0.1, fill: '#f1e9d6' }, RAIL: { stroke: '#3b352c', weight: 0.3, fill: 'url(#p-pencil-grey)' },
      EARTHWORKS: { stroke: '#6b6358', weight: 0.1, fill: 'url(#p-pencil-grey)' }, BRIDGE: { stroke: '#3b352c', weight: 0.4, fill: '#e7d7c0' }, TREES: { stroke: '#56764a', weight: 0.22 },
      WALL: { stroke: '#3b352c', weight: 0.25 }, 'CONTOUR-MINOR': { stroke: '#a89877', weight: 0.1 }, 'CONTOUR-MAJOR': { stroke: '#8a7a5a', weight: 0.2 }, 'CONTOUR-LABEL': { stroke: '#6e6556', weight: 0.1 },
      'ROAD-MARK': { hide: true }, 'ROAD-MARK-Y': { hide: true }, 'ROAD-MARK-CYCLE': { hide: true }, 'SPOT-LEVEL': { stroke: '#6e6556', weight: 0.1 }, BOUNDARY: { stroke: '#a33', weight: 0.35, dash: '3 1.5' },
    },
  },

  blueprint: {
    id: 'blueprint', label: 'Blueprint (white on blue)', paper: '#14439a', ink: '#ffffff', ink2: '#bcd0f2', font: HELV, defs: pat('p-bp-hatch', 1.2, 1.2, '<path d="M-0.3 1.5 L1.5 -0.3" stroke="#9db9ec" stroke-width="0.1"/>'), hillshade: 0,
    layers: {
      BUILDINGS: mono('#ffffff', 0.35, 'url(#p-bp-hatch)'), LISTED: mono('#ffe08a', 0.45, 'url(#p-bp-hatch)'), 'ROAD-SURFACE': mono('#ffffff', 0.22, '#1b4fae'), KERB: mono('#ffffff', 0.22),
      PAVEMENT: mono('#9db9ec', 0.1, '#1a4aa5'), PATH: mono('#9db9ec', 0.1, '#1a4aa5'), GREEN: mono('#7fa0dc', 0.1, '#184699'), WOOD: mono('#7fa0dc', 0.1, '#164294'),
      WATER: mono('#bcd0f2', 0.18, '#0f3787'), PAVED: mono('#9db9ec', 0.1, '#1a4aa5'), RAIL: mono('#ffffff', 0.3, '#1b4fae'), BRIDGE: mono('#ffffff', 0.45, '#2a5dc0'),
      EARTHWORKS: mono('#7fa0dc', 0.1, '#1a4aa5'), TREES: mono('#bcd0f2', 0.15), WALL: mono('#ffffff', 0.2), 'CONTOUR-MINOR': mono('#6f93d6', 0.1), 'CONTOUR-MAJOR': mono('#9db9ec', 0.22),
      'CONTOUR-LABEL': mono('#bcd0f2', 0.1), 'ROAD-MARK': mono('#ffffff', 0.05, '#ffffff'), ROOF: mono('#ffffff', 0.15), BOUNDARY: mono('#ffd24a', 0.35),
    },
  },
};

export const STYLE_LIST = Object.values(STYLES);

/** Layers restyled for a style (items are shared, not copied). */
export function applyStyle(layers: Layer[], style: DrawingStyle): Layer[] {
  if (style.id === 'standard') return layers;
  return layers.flatMap((l) => {
    const o = style.layers[l.name];
    if (o?.hide) return [];
    const out = { ...l, ...(o ?? {}) } as Layer;
    // Text layers keep their ink; every layer takes the style's global filter unless it has its own.
    if (!out.filter && style.filter && !/LABEL|SPOT/.test(l.name)) out.filter = style.filter;
    if (!o && style.id !== 'standard') {
      // Anything the style doesn't know about is drawn in the style's ink at its original weight.
      out.stroke = style.ink; out.fill = l.fill && style.id !== 'sketch' ? style.paper : l.fill;
    }
    return [out];
  });
}
