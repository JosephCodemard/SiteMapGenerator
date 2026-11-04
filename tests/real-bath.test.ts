// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { dataDir, loadSite } from './helpers/bath';
import { buildContext } from '../src/process/context';
import { fitRoofParts } from '../src/process/roofparts';

/**
 * Optional, on real Bath data: `BATH_DATA=<dir> npx vitest run tests/real-bath.test.ts`, where <dir> holds
 * rc_dsm.tif, rc_dtm.tif (EA WCS, E 374500-374900, N 165150-165500) and a cached rc_osm.json (fetched on first run).
 */
describe.skipIf(!dataDir)('Royal Crescent / Circus (real LIDAR + OSM)', () => {
  it('fits every building, finds mansards, keeps meshes non-empty, and builds pavements and earthworks', async () => {
    const site = await loadSite('rc', { minE: 374500, maxE: 374900, minN: 165150, maxN: 165500 });
    const types: Record<string, number> = {};
    let total = 0;
    for (const b of site.buildings) {
      const ps = fitRoofParts(b, site.dsm, site.dtm, site.origin, undefined, true);
      for (const p of ps ?? []) { const k = p.fit.kind ?? p.fit.type; types[k] = (types[k] ?? 0) + 1; total++; expect(p.mesh.indices.length).toBeGreaterThan(0); }
    }
    console.log('RC roof parts', total, JSON.stringify(types));
    expect(types.mansard).toBeGreaterThan(0);
    // Georgian terraces are not industrial: industrial shapes must stay rare here.
    expect(((types.sawtooth ?? 0) + (types.barrel ?? 0) + (types['multi-gable'] ?? 0)) / total).toBeLessThan(0.03);
    const ctx = buildContext(site);
    expect(ctx.pavements.length).toBeGreaterThan(0);
    expect(ctx.earthworks.areas.length).toBeGreaterThan(0);
  }, 120000);
});
