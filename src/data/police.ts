import { getJson, DAY } from './cache';
import { toBNG, toWGS } from '../geo/bng';
import { pointInShape } from '../process/shape';
import type { BBox, Ring, XY } from '../types';

/**
 * data.police.uk street-level crime. No key, CORS open. Locations are anonymised to the nearest street "anchor"
 * point, so counts show *where reports are attributed*, not exact incident positions or rates.
 */
const API = 'https://data.police.uk/api';

export interface Crime {
  category: string;
  month: string;
  street: string;
  outcome: string | null;
  p: XY;
}

/** `poly=lat,lng:lat,lng…` (the API accepts long polygons but we keep it short). */
export function policePoly(outline: Ring, maxVertices = 20): string {
  let pts = outline;
  if (pts.length > maxVertices) {
    // Too detailed: fall back to the bounding box.
    const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const [a, b, c, d] = [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)];
    pts = [[a, b], [c, b], [c, d], [a, d]];
  }
  return pts.map(([e, n]) => { const [lon, lat] = toWGS(e, n); return `${lat.toFixed(5)},${lon.toFixed(5)}`; }).join(':');
}

export const crimeUrl = (outline: Ring, month: string) => `${API}/crimes-street/all-crime?poly=${policePoly(outline)}&date=${month}`;

interface Raw {
  category: string;
  month: string;
  location: { latitude: string; longitude: string; street: { name: string } };
  outcome_status: { category: string } | null;
}

export function parseCrimes(raw: Raw[]): Crime[] {
  return raw.map((c) => ({
    category: c.category, month: c.month, street: c.location.street.name.replace(/^On or near /, ''),
    outcome: c.outcome_status?.category ?? null, p: toBNG(parseFloat(c.location.longitude), parseFloat(c.location.latitude)),
  }));
}

/** The `n` months ending at `latest` (YYYY-MM), newest first. */
export function monthsBack(latest: string, n: number): string[] {
  let [y, m] = latest.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (--m === 0) { m = 12; y--; } }
  return out;
}

export async function latestMonth(): Promise<string> {
  const dates = await getJson<{ date: string }[]>(`${API}/crimes-street-dates`, DAY);
  return dates[0].date;
}

/**
 * Fetch `months` months of crime for the outline (one request per month, spaced out for the 15 req/s limit).
 * A month that fails twice (the API sometimes rate-limits without CORS headers) is skipped and reported through
 * `onWarn`; the run only fails if every month does.
 */
export async function fetchCrimes(
  outline: Ring, bbox: BBox, months = 6, onProgress?: (done: number, total: number) => void, onWarn?: (msg: string) => void,
  timing = { retry: 1500, spacing: 150 },
): Promise<Crime[]> {
  const list = monthsBack(await latestMonth(), months);
  const out: Crime[] = [];
  const failed: string[] = [];
  for (let i = 0; i < list.length; i++) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        out.push(...parseCrimes(await getJson<Raw[]>(crimeUrl(outline, list[i]), DAY * 7)));
        ok = true;
      } catch {
        await new Promise((r) => setTimeout(r, attempt ? 0 : timing.retry));
      }
    }
    if (!ok) failed.push(list[i]);
    onProgress?.(i + 1, list.length);
    await new Promise((r) => setTimeout(r, timing.spacing));
  }
  if (failed.length === list.length) throw new Error('data.police.uk did not respond (try again in a minute)');
  if (failed.length) onWarn?.(`Police data: skipped ${failed.join(', ')} (no response).`);
  // The API returns the polygon's area; keep only points inside the real outline / box.
  return out.filter((c) => (outline.length > 4 ? pointInShape(c.p, outline) : c.p[0] >= bbox.minE && c.p[0] <= bbox.maxE && c.p[1] >= bbox.minN && c.p[1] <= bbox.maxN));
}
