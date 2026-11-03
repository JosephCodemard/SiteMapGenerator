import { fromArrayBuffer } from 'geotiff';
import type { BBox, Raster } from '../types';

const BASE = 'https://environment.data.gov.uk/spatialdata';

/** Environment Agency LIDAR Composite 1 m (Open Government Licence v3). */
export const LIDAR_LAYERS = {
  dtm: {
    url: `${BASE}/lidar-composite-digital-terrain-model-dtm-1m/wcs`,
    coverage: '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m',
  },
  dsm: {
    url: `${BASE}/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs`,
    coverage: 'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m',
  },
} as const;

export type LidarLayer = keyof typeof LIDAR_LAYERS;

const CHUNK = 1000; // metres per WCS request (1000x1000 px = 4 MB)
const CONCURRENCY = 4;

function coverageUrl(layer: LidarLayer, b: BBox): string {
  const { url, coverage } = LIDAR_LAYERS[layer];
  return `${url}?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${coverage}` +
    `&format=image/tiff&subset=E(${b.minE},${b.maxE})&subset=N(${b.minN},${b.maxN})`;
}

async function fetchWithRetry(url: string, signal?: AbortSignal, tries = 3): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('tiff')) throw new Error(`Unexpected response (${type}): ${(await res.text()).slice(0, 200)}`);
      return await res.arrayBuffer();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** t));
    }
  }
  throw lastErr;
}

/**
 * Fetch a LIDAR layer for an integer-metre bbox, in 1 km chunks, mosaicked into
 * one north-up 1 m raster. Missing data (water, gaps, outside coverage) is NaN.
 */
export async function fetchLidar(
  layer: LidarLayer,
  bbox: BBox,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Raster> {
  const width = bbox.maxE - bbox.minE;
  const height = bbox.maxN - bbox.minN;
  const data = new Float32Array(width * height).fill(NaN);

  const chunks: BBox[] = [];
  for (let e = bbox.minE; e < bbox.maxE; e += CHUNK) {
    for (let n = bbox.minN; n < bbox.maxN; n += CHUNK) {
      chunks.push({ minE: e, minN: n, maxE: Math.min(e + CHUNK, bbox.maxE), maxN: Math.min(n + CHUNK, bbox.maxN) });
    }
  }

  let done = 0;
  onProgress?.(0, chunks.length);
  const queue = [...chunks];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const buf = await fetchWithRetry(coverageUrl(layer, c), signal);
      const tiff = await fromArrayBuffer(buf);
      const img = await tiff.getImage();
      const [tMinE, , , tMaxN] = img.getBoundingBox();
      const w = img.getWidth(), h = img.getHeight();
      const nodata = img.getGDALNoData();
      const band = (await img.readRasters({ samples: [0] }))[0] as ArrayLike<number>;
      const offX = Math.round(tMinE - bbox.minE);
      const offY = Math.round(bbox.maxN - tMaxN);
      for (let y = 0; y < h; y++) {
        const ty = offY + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < w; x++) {
          const tx = offX + x;
          if (tx < 0 || tx >= width) continue;
          const v = band[y * w + x];
          data[ty * width + tx] = v === nodata || !Number.isFinite(v) || v < -1000 ? NaN : v;
        }
      }
      onProgress?.(++done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

  return { width, height, minE: bbox.minE, maxN: bbox.maxN, res: 1, data };
}
