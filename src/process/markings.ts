import { lineWidth } from './buffer';
import { offsetOutline, resample } from './ribbon';
import type { LineFeature, PointFeature, Ring, SiteData, XY } from '../types';

/**
 * Road markings generated from OSM tags and road geometry (there is no open imagery to detect them from).
 * Only what the tags support is drawn, so coverage follows OSM's: treat it as indicative.
 */
export type MarkingKind = 'detected' | 'centre' | 'lane' | 'edge-yellow' | 'cycle' | 'zebra' | 'signal-crossing' | 'stop' | 'giveway';
export type MarkingColour = 'white' | 'yellow' | 'red';

export interface Marking {
  kind: MarkingKind;
  colour: MarkingColour;
  /** Closed-polygon rings in BNG (open rings, CCW not guaranteed). */
  ring: Ring;
}

const DASH = 2, GAP = 4; // UK centre/lane line pattern (m)
const LINE_W = 0.1;

const MARKED = /^(primary|secondary|tertiary|unclassified|residential)(_link)?$/;

const len = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Points along a polyline from distance s0 to s1 (including intermediate vertices). */
function subline(line: Ring, s0: number, s1: number): XY[] {
  const out: XY[] = [];
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]], l = len(a, b);
    if (acc + l > s0 && acc < s1) {
      const at = (s: number): XY => { const t = (s - acc) / l; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
      if (!out.length) out.push(at(Math.max(s0, acc)));
      out.push(at(Math.min(s1, acc + l)));
    }
    acc += l;
  }
  return out;
}

/** The polyline shifted sideways by `off` metres (positive = left of travel). */
function shifted(line: Ring, off: number): XY[] {
  if (Math.abs(off) < 1e-6) return line;
  const pts = resample(line, 2);
  const { left, right } = offsetOutline(pts, Math.abs(off));
  return off > 0 ? left : right;
}

function stripe(pts: XY[], width: number): Ring | null {
  if (pts.length < 2) return null;
  const { left, right } = offsetOutline(pts, width / 2);
  return [...left, ...[...right].reverse()];
}

/** Dashed (or solid when gap = 0) stripes along an offset of the line. */
function dashed(line: Ring, off: number, width: number, dash: number, gap: number): Ring[] {
  const path = shifted(line, off);
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += len(path[i], path[i + 1]);
  if (total < 1) return [];
  if (gap <= 0) { const r = stripe(path, width); return r ? [r] : []; }
  const out: Ring[] = [];
  for (let s = (total % (dash + gap)) / 2; s + dash <= total + 1e-6; s += dash + gap) {
    const r = stripe(subline(path, s, s + dash), width);
    if (r) out.push(r);
  }
  return out;
}

interface Hit { dir: XY; width: number; at: XY; line: LineFeature; dist: number }

/** Nearest marked road to a point: direction of travel there, its width, and the closest point on it. */
function nearestRoad(roads: LineFeature[], p: XY, maxDist = 8): Hit | null {
  let best: Hit | null = null;
  for (const l of roads) {
    for (let i = 0; i < l.coords.length - 1; i++) {
      const [a, b] = [l.coords[i], l.coords[i + 1]];
      const dx = b[0] - a[0], dy = b[1] - a[1], ll = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll));
      const q: XY = [a[0] + t * dx, a[1] + t * dy];
      const d = len(p, q);
      if (d <= maxDist && (!best || d < best.dist)) { const m = Math.sqrt(ll); best = { dir: [dx / m, dy / m], width: lineWidth(l), at: q, line: l, dist: d }; }
    }
  }
  return best;
}

const rect = (c: XY, dir: XY, along: number, across: number): Ring => {
  const n: XY = [-dir[1], dir[0]];
  const pt = (a: number, b: number): XY => [c[0] + dir[0] * a + n[0] * b, c[1] + dir[1] * a + n[1] * b];
  return [pt(-along / 2, -across / 2), pt(along / 2, -across / 2), pt(along / 2, across / 2), pt(-along / 2, across / 2)];
};

const sideTag = (t: Record<string, string>, key: string, side: 'left' | 'right') => t[`${key}:${side}`] ?? t[`${key}:both`] ?? t[key];

/** All markings the tags of the site's roads and points support. */
export function buildMarkings(site: Pick<SiteData, 'lines' | 'points'> & { detectedMarkings?: Marking[] }): Marking[] {
  const out: Marking[] = [...(site.detectedMarkings ?? [])];
  const add = (kind: MarkingKind, colour: MarkingColour, rings: Ring[]) => rings.forEach((ring) => out.push({ kind, colour, ring }));
  const roads = site.lines.filter((l) => l.kind.startsWith('road') && !l.bridge && !l.tunnel && MARKED.test(l.tags.highway ?? ''));

  for (const l of roads) {
    const w = lineWidth(l);
    const oneway = /^(yes|1|-1)$/.test(l.tags.oneway ?? '');
    const lanes = parseInt(l.tags.lanes ?? '', 10) || (!oneway && w >= 5.5 ? 2 : 1);
    // A road with two or more lanes gets lines between them (the middle one is the centre line on two-way roads).
    if (lanes >= 2 && w >= 4.8) {
      const lw = w / lanes;
      for (let k = 1; k < lanes; k++) add(k * 2 === lanes && !oneway ? 'centre' : 'lane', 'white', dashed(l.coords, (k - lanes / 2) * lw, LINE_W, DASH, GAP));
    }
    // Cycle lanes (painted strips on the carriageway edge).
    for (const [side, sgn] of [['left', 1], ['right', -1]] as const) {
      if (sideTag(l.tags, 'cycleway', side) === 'lane') add('cycle', 'red', dashed(l.coords, sgn * (w / 2 - 0.75), 1.5, 0, 0));
      const cond = sideTag(l.tags, 'parking:condition', side) ?? sideTag(l.tags, 'parking:lane', side);
      if (cond === 'no_parking' || cond === 'no_stopping') {
        add('edge-yellow', 'yellow', dashed(l.coords, sgn * (w / 2 - 0.3), LINE_W, 0, 0));
        add('edge-yellow', 'yellow', dashed(l.coords, sgn * (w / 2 - 0.45), LINE_W, 0, 0));
      }
    }
  }

  for (const p of site.points as PointFeature[]) {
    if (p.kind !== 'crossing' && p.kind !== 'stop' && p.kind !== 'giveway') continue;
    const hit = nearestRoad(roads, p.p);
    if (!hit) continue;
    const { dir, width, at } = hit;
    const n: XY = [-dir[1], dir[0]];
    if (p.kind === 'crossing') {
      const type = p.tags.crossing ?? '';
      if (/^(zebra|uncontrolled|marked)$/.test(type) || p.tags.crossing_ref === 'zebra') {
        // Stripes run along the road, repeated across its width (0.5 m bars on a 1 m pitch).
        const count = Math.max(2, Math.floor(width / 1.0));
        for (let k = 0; k < count; k++) {
          const off = (k - (count - 1) / 2) * 1.0;
          add('zebra', 'white', [rect([at[0] + n[0] * off, at[1] + n[1] * off], dir, 3, 0.5)]);
        }
      } else if (type === 'traffic_signals') {
        for (const s of [-1.5, 1.5]) add('signal-crossing', 'white', [rect([at[0] + dir[0] * s, at[1] + dir[1] * s], n, width, 0.3)]);
      }
    } else {
      // Stop / give-way line across the nearside half of the carriageway, just before the junction.
      const centre: XY = [at[0] - n[0] * width / 4, at[1] - n[1] * width / 4];
      if (p.kind === 'stop') add('stop', 'white', [rect(centre, n, width / 2, 0.3)]);
      else for (const r of dashed([[centre[0] - n[0] * width / 4, centre[1] - n[1] * width / 4], [centre[0] + n[0] * width / 4, centre[1] + n[1] * width / 4]], 0, 0.3, 0.45, 0.3)) add('giveway', 'white', [r]);
    }
  }
  return out;
}
