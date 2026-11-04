import type { Crime } from '../data/police';
import type { Raster, XY } from '../types';

/** Gaussian kernel-density of points over a raster (counts per hectare-equivalent: unit mass per point). */
export function kernelDensity(points: { p: XY; w?: number }[], like: Pick<Raster, 'minE' | 'maxN' | 'width' | 'height' | 'res'>, bandwidth = 40): Float32Array {
  const { width: w, height: h, minE, maxN, res } = like;
  const out = new Float32Array(w * h);
  const reach = Math.ceil((3 * bandwidth) / res);
  const norm = 1 / (2 * Math.PI * bandwidth * bandwidth);
  for (const { p, w: wt = 1 } of points) {
    const ci = Math.floor((p[0] - minE) / res), cj = Math.floor((maxN - p[1]) / res);
    for (let j = Math.max(0, cj - reach); j <= Math.min(h - 1, cj + reach); j++) {
      const n = maxN - (j + 0.5) * res;
      for (let i = Math.max(0, ci - reach); i <= Math.min(w - 1, ci + reach); i++) {
        const e = minE + (i + 0.5) * res;
        out[j * w + i] += wt * norm * Math.exp(-((e - p[0]) ** 2 + (n - p[1]) ** 2) / (2 * bandwidth * bandwidth));
      }
    }
  }
  return out;
}

export interface CrimeSummary {
  total: number;
  byCategory: [string, number][];
  byMonth: [string, number][];
  byStreet: [string, number][];
}

export const CRIME_LABELS: Record<string, string> = {
  'anti-social-behaviour': 'Anti-social behaviour', 'bicycle-theft': 'Bicycle theft', burglary: 'Burglary', 'criminal-damage-arson': 'Criminal damage & arson',
  drugs: 'Drugs', 'other-theft': 'Other theft', 'possession-of-weapons': 'Weapons possession', 'public-order': 'Public order', robbery: 'Robbery',
  shoplifting: 'Shoplifting', 'theft-from-the-person': 'Theft from the person', 'vehicle-crime': 'Vehicle crime', 'violent-crime': 'Violence & sexual offences',
  'other-crime': 'Other crime',
};

const tally = (items: string[]): [string, number][] => {
  const m = new Map<string, number>();
  for (const k of items) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

export function summariseCrimes(crimes: Crime[]): CrimeSummary {
  return {
    total: crimes.length,
    byCategory: tally(crimes.map((c) => c.category)),
    byMonth: tally(crimes.map((c) => c.month)).sort((a, b) => a[0].localeCompare(b[0])),
    byStreet: tally(crimes.map((c) => c.street)).slice(0, 10),
  };
}

export const filterCrimes = (crimes: Crime[], category: string) => (category === 'all' ? crimes : crimes.filter((c) => c.category === category));
