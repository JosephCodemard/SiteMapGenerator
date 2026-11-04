import { openRing, signedArea } from '../process/clip';
import type { Entrance } from './entrances';
import type { Building, LineFeature, PointFeature, XY } from '../types';

/**
 * Footfall (pedestrian activity) model: a gravity-weighted route model on the OSM street/path network.
 * Origins are building entrances weighted by floor area; destinations are shops, cafés, attractions, stops and
 * commercial buildings; each origin spreads its trips over destinations by weight * exp(-distance / beta) and the
 * trips follow shortest paths. Edge flow = relative activity. It is a MODEL of likely activity, not counted data.
 */
export interface FootfallWeights {
  residential: number;
  retail: number;
  transit: number;
}

export const DEFAULT_WEIGHTS: FootfallWeights = { residential: 1, retail: 1, transit: 1 };

export interface FlowEdge {
  a: XY;
  b: XY;
  /** Relative activity, 0..1 of the busiest segment. */
  flow: number;
  raw: number;
  kind: string;
}

export interface FootfallResult {
  edges: FlowEdge[];
  /** Busiest segments, merged by street name where known. */
  hotspots: { name: string; flow: number; at: XY }[];
  origins: number;
  destinations: number;
}

const RESIDENTIAL = /^(house|apartments|residential|terrace|detached|semidetached_house|dormitory|bungalow|flats)$/;
const COMMERCIAL = /^(retail|commercial|office|supermarket|hotel|restaurant|pub|kiosk)$/;
const POI_WEIGHT: Record<string, number> = { cafe: 4, restaurant: 4, pub: 4, bar: 3, fast_food: 3, museum: 6, theatre: 5, cinema: 5, library: 3, school: 3, university: 4, place_of_worship: 2, pharmacy: 3, bank: 2 };

const key = (p: XY) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;

interface Graph {
  nodes: XY[];
  adj: { to: number; len: number; edge: number }[][];
  edges: { a: number; b: number; kind: string; name?: string }[];
}

export function buildGraph(lines: LineFeature[]): Graph {
  const ids = new Map<string, number>();
  const g: Graph = { nodes: [], adj: [], edges: [] };
  const node = (p: XY) => {
    const k = key(p);
    let i = ids.get(k);
    if (i === undefined) { i = g.nodes.length; ids.set(k, i); g.nodes.push(p); g.adj.push([]); }
    return i;
  };
  for (const l of lines) {
    if (!/^(road-major|road-minor|path)$/.test(l.kind) || l.tunnel || /^(motorway|trunk)/.test(l.tags.highway ?? '') || l.tags.foot === 'no') continue;
    for (let i = 0; i < l.coords.length - 1; i++) {
      const a = node(l.coords[i]), b = node(l.coords[i + 1]);
      if (a === b) continue;
      const len = Math.hypot(l.coords[i + 1][0] - l.coords[i][0], l.coords[i + 1][1] - l.coords[i][1]);
      const e = g.edges.length;
      g.edges.push({ a, b, kind: l.kind, name: l.name });
      g.adj[a].push({ to: b, len, edge: e });
      g.adj[b].push({ to: a, len, edge: e });
    }
  }
  return g;
}

/** Nearest graph node within `maxDist` (spatial hash). */
function snapper(g: Graph, maxDist: number) {
  const cell = maxDist, grid = new Map<string, number[]>();
  g.nodes.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  return (p: XY): number => {
    let best = -1, bd = maxDist;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(g.nodes[i][0] - p[0], g.nodes[i][1] - p[1]);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
}

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    let i = this.k.length; this.k.push(key); this.v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): [number, number] {
    const t: [number, number] = [this.k[0], this.v[0]];
    const key = this.k.pop()!, val = this.v.pop()!;
    if (this.k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= this.k.length) break;
        if (c + 1 < this.k.length && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = key; this.v[i] = val;
    }
    return t;
  }
}

const levels = (b: Building) => Math.max(1, parseFloat(b.tags['building:levels'] ?? '') || Math.round((b.top - b.ground) / 3));
const floorArea = (b: Building) => Math.abs(signedArea(openRing(b.rings[0]))) * levels(b);

export function footfall(
  buildings: Building[], entrances: Entrance[], points: PointFeature[], lines: LineFeature[],
  weights: FootfallWeights = DEFAULT_WEIGHTS, beta = 300, maxDist = 900,
): FootfallResult {
  const g = buildGraph(lines);
  const snap = snapper(g, 40);
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const supply = new Map<number, number>(), demand = new Map<number, number>();
  const add = (m: Map<number, number>, n: number, w: number) => { if (n >= 0 && w > 0) m.set(n, (m.get(n) ?? 0) + w); };
  const perBuilding = new Map<string, number>();
  for (const e of entrances) perBuilding.set(e.buildingId, (perBuilding.get(e.buildingId) ?? 0) + 1);
  for (const e of entrances) {
    const b = byId.get(e.buildingId);
    if (!b) continue;
    const kind = b.tags.building ?? '';
    const share = floorArea(b) / 100 / (perBuilding.get(b.id) ?? 1);
    const n = snap(e.p);
    if (RESIDENTIAL.test(kind) || kind === 'yes' || kind === '') add(supply, n, share * weights.residential);
    else add(supply, n, share * 0.5 * weights.residential);
    if (COMMERCIAL.test(kind)) add(demand, n, (share / 2) * weights.retail);
  }
  for (const p of points) {
    if (p.kind === 'transit') add(demand, snap(p.p), 10 * weights.transit);
    else if (p.kind === 'poi') add(demand, snap(p.p), (POI_WEIGHT[p.tags.amenity ?? ''] ?? (p.tags.shop ? 3 : p.tags.tourism ? 5 : 1)) * weights.retail);
  }

  const raw = new Float64Array(g.edges.length);
  const N = g.nodes.length;
  const dist = new Float64Array(N), prev = new Int32Array(N), prevEdge = new Int32Array(N);
  for (const [src, wo] of supply) {
    dist.fill(Infinity); prev.fill(-1);
    dist[src] = 0;
    const heap = new Heap();
    heap.push(0, src);
    const order: number[] = [];
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      order.push(u);
      for (const { to, len, edge } of g.adj[u]) {
        const nd = d + len;
        if (nd < dist[to] && nd <= maxDist) { dist[to] = nd; prev[to] = u; prevEdge[to] = edge; heap.push(nd, to); }
      }
    }
    let total = 0;
    for (const u of order) { const wd = demand.get(u); if (wd && u !== src) total += wd * Math.exp(-dist[u] / beta); }
    if (total <= 0) continue;
    const carry = new Float64Array(N);
    for (const u of order) { const wd = demand.get(u); if (wd && u !== src) carry[u] = (wo * wd * Math.exp(-dist[u] / beta)) / total; }
    for (let i = order.length - 1; i > 0; i--) {
      const u = order[i];
      if (prev[u] >= 0 && carry[u]) { raw[prevEdge[u]] += carry[u]; carry[prev[u]] += carry[u]; }
    }
  }
  const max = Math.max(...raw, 1e-9);
  const edges: FlowEdge[] = g.edges.map((e, i) => ({ a: g.nodes[e.a], b: g.nodes[e.b], raw: raw[i], flow: raw[i] / max, kind: e.kind }));
  const byName = new Map<string, { flow: number; at: XY }>();
  g.edges.forEach((e, i) => {
    const name = e.name ?? 'unnamed way';
    const cur = byName.get(name);
    if (!cur || raw[i] > cur.flow) byName.set(name, { flow: raw[i], at: [(g.nodes[e.a][0] + g.nodes[e.b][0]) / 2, (g.nodes[e.a][1] + g.nodes[e.b][1]) / 2] });
  });
  const hotspots = [...byName].map(([name, v]) => ({ name, flow: v.flow / max, at: v.at })).sort((a, b) => b.flow - a.flow).slice(0, 10);
  return { edges, hotspots, origins: supply.size, destinations: demand.size };
}
