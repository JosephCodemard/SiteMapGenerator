import { getJson, DAY } from './cache';

/** Open-Meteo (no key, CORS open, non-commercial): hourly 10 m wind from the reanalysis archive. */
export interface WindRose {
  /** Sector centres in degrees (0 = from the north, clockwise). */
  sectors: number[];
  /** Share of hours the wind came from each sector (sums to 1). */
  frequency: number[];
  /** Mean speed (m/s) per sector. */
  meanSpeed: number[];
  /** Overall mean and 95th-percentile speed (m/s). */
  mean: number;
  p95: number;
  /** Prevailing direction (degrees, wind *from*). */
  prevailing: number;
  hours: number;
}

export function windRose(speeds: number[], dirs: number[], nSectors = 16): WindRose {
  const w = 360 / nSectors;
  const count = new Array(nSectors).fill(0), sum = new Array(nSectors).fill(0);
  const valid: number[] = [];
  speeds.forEach((v, i) => {
    const d = dirs[i];
    if (v == null || d == null || Number.isNaN(v) || Number.isNaN(d)) return;
    const k = Math.floor(((d + w / 2) % 360) / w);
    count[k]++; sum[k] += v; valid.push(v);
  });
  const total = valid.length || 1;
  const sorted = [...valid].sort((a, b) => a - b);
  const best = count.indexOf(Math.max(...count));
  return {
    sectors: count.map((_, k) => k * w), frequency: count.map((c) => c / total), meanSpeed: count.map((c, k) => (c ? sum[k] / c : 0)),
    mean: valid.reduce((a, b) => a + b, 0) / total, p95: sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0, prevailing: best * w, hours: valid.length,
  };
}

export function windUrl(lat: number, lon: number, days = 365, now = new Date()): string {
  const end = new Date(now.getTime() - 7 * DAY), start = new Date(end.getTime() - days * DAY);
  const f = (d: Date) => d.toISOString().slice(0, 10);
  return `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${f(start)}&end_date=${f(end)}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
}

export async function fetchWindClimate(lat: number, lon: number, days = 365): Promise<WindRose> {
  const j = await getJson<{ hourly: { wind_speed_10m: number[]; wind_direction_10m: number[] } }>(windUrl(lat, lon, days), 7 * DAY);
  return windRose(j.hourly.wind_speed_10m, j.hourly.wind_direction_10m);
}
