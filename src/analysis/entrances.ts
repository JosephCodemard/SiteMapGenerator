import { openRing, signedArea } from '../process/clip';
import type { Building, LineFeature, PointFeature, XY } from '../types';

export interface Entrance {
  p: XY;
  buildingId: string;
  source: 'osm' | 'inferred';
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Closest point on a polyline to `p`. */
function nearestOnLine(l: XY[], p: XY): { q: XY; d: number } {
  let best = { q: l[0], d: Infinity };
  for (let i = 0; i < l.length - 1; i++) {
    const [a, b] = [l[i], l[i + 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1], ll = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ll));
    const q: XY = [a[0] + t * dx, a[1] + t * dy];
    const d = dist(p, q);
    if (d < best.d) best = { q, d };
  }
  return best;
}

/** Nearest point on a building outline. */
function nearestOnBuilding(b: Building, p: XY): { q: XY; d: number } {
  const r = openRing(b.rings[0]);
  return nearestOnLine([...r, r[0]], p);
}

/**
 * Entrances: OSM `entrance` nodes snapped to the nearest building outline (within 6 m), then, for each building
 * without one, an inferred door on the outline point nearest an accessible road or path (within 25 m).
 * Long frontages (> 30 m of outline facing the road) get an extra inferred door.
 */
export function findEntrances(buildings: Building[], points: PointFeature[], lines: LineFeature[], maxRoadDist = 25): Entrance[] {
  const out: Entrance[] = [];
  const has = new Set<string>();
  for (const pt of points) {
    if (pt.kind !== 'entrance' || pt.tags.entrance === 'emergency') continue;
    let best: { b: Building; q: XY; d: number } | null = null;
    for (const b of buildings) {
      const { q, d } = nearestOnBuilding(b, pt.p);
      if (d < 6 && (!best || d < best.d)) best = { b, q, d };
    }
    if (best) { out.push({ p: best.q, buildingId: best.b.id, source: 'osm' }); has.add(best.b.id); }
  }
  const ways = lines.filter((l) => /^(road-major|road-minor|path)$/.test(l.kind) && !l.tunnel);
  for (const b of buildings) {
    if (has.has(b.id) || Math.abs(signedArea(openRing(b.rings[0]))) < 12) continue;
    const ring = openRing(b.rings[0]);
    // The outline vertex/edge midpoint closest to any way.
    const candidates: XY[] = [];
    for (let i = 0; i < ring.length; i++) {
      const [a, c] = [ring[i], ring[(i + 1) % ring.length]];
      candidates.push([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]);
    }
    const scored = candidates.map((p) => ({ p, d: Math.min(...ways.map((l) => nearestOnLine(l.coords, p).d), Infinity) })).filter((s) => s.d <= maxRoadDist).sort((x, y) => x.d - y.d);
    if (!scored.length) continue;
    out.push({ p: scored[0].p, buildingId: b.id, source: 'inferred' });
    // One more door per ~30 m of outline that also faces a way.
    const facing = scored.filter((s) => s.d <= scored[0].d + 3).length;
    for (let k = 1; k < Math.min(facing, Math.floor(perimeter(ring) / 60) + 1); k++) {
      if (dist(scored[k].p, scored[0].p) > 15) out.push({ p: scored[k].p, buildingId: b.id, source: 'inferred' });
    }
  }
  return out;
}

const perimeter = (r: XY[]) => r.reduce((s, p, i) => s + dist(p, r[(i + 1) % r.length]), 0);
