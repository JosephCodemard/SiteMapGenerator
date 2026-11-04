/**
 * Sun position (NOAA / Meeus low-precision algorithm, good to about 0.01 degrees for 1950-2050).
 * Azimuth is degrees clockwise from north; altitude is degrees above the horizon (no refraction).
 */
export interface Sun {
  azimuth: number;
  altitude: number;
}

const rad = Math.PI / 180;

export function sunPosition(date: Date, lat: number, lon: number): Sun {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const trueLon = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolar = (minutes + eqTime + 4 * lon) % 1440;
  const ha = (trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const altitude = 90 - zenith / rad;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 180;
  return { azimuth: ((az % 360) + 360) % 360, altitude };
}

/** Sunrise and sunset (UTC `Date`s) on the UTC day of `day`, or null in polar day/night. Found by bisection. */
export function sunTimes(day: Date, lat: number, lon: number): { rise: Date; set: Date; noon: Date } | null {
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const alt = (t: number) => sunPosition(new Date(t), lat, lon).altitude;
  // Solar noon: maximum altitude, found by scanning then refining.
  let best = start, bestAlt = -90;
  for (let m = 0; m < 1440; m += 10) { const a = alt(start + m * 60000); if (a > bestAlt) { bestAlt = a; best = start + m * 60000; } }
  if (bestAlt <= -0.833) return null;
  const cross = (lo: number, hi: number) => {
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((alt(mid) > -0.833) === (alt(hi) > -0.833)) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  };
  const prev = best - 12 * 3600000, next = best + 12 * 3600000;
  if (alt(prev) > -0.833 || alt(next) > -0.833) return null; // polar day
  return { rise: new Date(cross(prev, best)), set: new Date(cross(best, next)), noon: new Date(best) };
}

/** Direction *towards* the sun as a unit vector (east, north) on the ground plus tan(altitude). */
export function sunVector(s: Sun): { dx: number; dy: number; tanAlt: number } {
  return { dx: Math.sin(s.azimuth * rad), dy: Math.cos(s.azimuth * rad), tanAlt: Math.tan(s.altitude * rad) };
}

/** Convert a UK wall-clock date/time ("2026-06-21", "12:00") to a UTC Date, honouring BST. */
export function londonToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (shown - guess));
}
