import type { BBox, Ring, XY } from '../types';

/** Everything needed to reopen a site and its settings from a link (kept small enough for a URL hash). */
export interface ShareState {
  v: 1;
  bbox: BBox;
  shape?: Ring | null;
  redLine?: Ring | null;
  cuts?: { a: XY; b: XY }[];
  /** `[data-persist]` control values by element id. */
  settings: Record<string, string | boolean>;
}

const round = (r: Ring) => r.map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10] as XY);

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function encodeState(s: ShareState): string {
  const slim: ShareState = { ...s, shape: s.shape ? round(s.shape) : undefined, redLine: s.redLine ? round(s.redLine) : undefined };
  return `#s=${b64(JSON.stringify(slim))}`;
}

/** Parse a location hash; returns null for anything that isn't a valid share link. */
export function decodeState(hash: string): ShareState | null {
  const m = hash.match(/^#?s=([\w-]+)$/);
  if (!m) return null;
  try {
    const s = JSON.parse(unb64(m[1])) as ShareState;
    const b = s.bbox;
    if (s.v !== 1 || ![b?.minE, b?.minN, b?.maxE, b?.maxN].every(Number.isFinite) || b.maxE <= b.minE || b.maxN <= b.minN) return null;
    return { ...s, settings: s.settings ?? {} };
  } catch {
    return null;
  }
}

/** Turn technical failures into advice (the original message is still logged). */
export function friendlyError(label: string, message: string): string {
  const m = message.toLowerCase();
  if (/overpass|openstreetmap/.test(m)) return `${label}: OpenStreetMap's server is busy. Try again in a minute, or load your own OSM file (step 2).`;
  if (/no lidar coverage/.test(m)) return `${label}: the Environment Agency has no LIDAR for this area (England only, and some areas are missing).`;
  if (/failed to fetch|networkerror|load failed/.test(m)) return `${label}: a data service didn't answer. Check your connection and try again.`;
  if (/area is .* km²/.test(m)) return `${label}: ${message}. Draw a smaller area.`;
  if (/out of memory|array buffer allocation|invalid array length/.test(m)) return `${label}: the model is too big for this browser. Raise the terrain/feature mesh size, or choose a smaller area.`;
  return `${label} failed: ${message}`;
}
