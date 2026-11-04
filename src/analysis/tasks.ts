import { bathtubFlood, pondingDepth, type FloodOptions } from './flood';
import { shadowMask, sunHours } from './shadow';
import { windField, type WindOptions } from './wind';
import { footfall, type FootfallWeights } from './footfall';
import type { Entrance } from './entrances';
import type { Building, LineFeature, PointFeature, Raster } from '../types';

/** Heavy analyses as plain functions of structured-clonable arguments, so they can run in a Worker. */
export type Progress = (fraction: number) => void;

export const tasks = {
  sunHours: (a: { dsm: Raster; day: string; lat: number; lon: number; step: number }, progress?: Progress) =>
    sunHours(a.dsm, new Date(`${a.day}T00:00:00Z`), a.lat, a.lon, a.step, progress),
  shadowAt: (a: { dsm: Raster; azimuth: number; altitude: number }) => ({ mask: shadowMask(a.dsm, { azimuth: a.azimuth, altitude: a.altitude }), raster: a.dsm }),
  flood: (a: { dtm: Raster } & FloodOptions) => bathtubFlood(a.dtm, a),
  ponding: (a: { dtm: Raster }) => pondingDepth(a.dtm),
  wind: (a: { dsm: Raster; dtm: Raster } & WindOptions) => windField(a.dsm, a.dtm, a),
  footfall: (a: { buildings: Building[]; entrances: Entrance[]; points: PointFeature[]; lines: LineFeature[]; weights: FootfallWeights }) =>
    footfall(a.buildings, a.entrances, a.points, a.lines, a.weights),
};

export type TaskName = keyof typeof tasks;
type Args<K extends TaskName> = Parameters<(typeof tasks)[K]>[0];
type Out<K extends TaskName> = ReturnType<(typeof tasks)[K]>;

let worker: Worker | null = null;
let seq = 0;

/** Stop whatever the worker is doing (it restarts on the next call). */
export function cancelTasks() {
  worker?.terminate();
  worker = null;
}

/** Run a task in a Web Worker when available (so the UI stays responsive), else inline (tests, old browsers). */
export function runTask<K extends TaskName>(name: K, args: Args<K>, onProgress?: Progress): Promise<Out<K>> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve((tasks[name] as (a: Args<K>, p?: Progress) => Out<K>)(args, onProgress));
  }
  worker ??= new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  const w = worker, id = ++seq;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) { onProgress?.(e.data.progress); return; }
      w.removeEventListener('message', onMessage);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', (e) => reject(new Error(e.message)), { once: true });
    w.postMessage({ id, name, args });
  });
}
