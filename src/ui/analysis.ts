import { buildingFlood } from '../analysis/flood';
import { CRIME_LABELS, filterCrimes, kernelDensity, summariseCrimes } from '../analysis/crime';
import { findEntrances } from '../analysis/entrances';
import { londonToUtc, sunPosition } from '../analysis/sun';
import { cancelTasks, runTask } from '../analysis/tasks';
import { LAWSON_LABELS } from '../analysis/wind';
import { RAMPS, baseView, drawBuildings, drawEdges, drawOutline, drawPolygons, drawRaster, legendGradient } from '../analysis/render';
import { fetchCrimes, type Crime } from '../data/police';
import { fetchDefences } from '../data/defences';
import { fetchFloodZones } from '../data/floodzones';
import { rasterToAsc } from '../data/site';
import { fetchWindClimate } from '../data/weather';
import { toWGS } from '../geo/bng';
import { buildContext } from '../process/context';
import { rasterizePolygons } from '../process/geom';
import type { Raster, SiteData } from '../types';

export interface AnalysisHost {
  site(): SiteData | null;
  log(m: string): void;
  busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>;
  stage(msg: string): Promise<void>;
  selectTab(name: string): void;
  download(name: string, data: BlobPart | Blob, type?: string): void;
}

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($(id).value);
const LAWSON_COLOURS = ['#2e9b4e', '#9acd32', '#f1c40f', '#e67e22', '#c0392b'];

export interface AnalysisResult {
  name: string;
  canvas: HTMLCanvasElement;
  legend: string;
  summary: string;
  /** Raw data to download: an ASC grid or a CSV. */
  data?: { file: string; text: string };
}

const csv = (head: string[], rows: (string | number)[][]) =>
  [head.join(','), ...rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';
const bar = (name: keyof typeof RAMPS, lo: string, hi: string) =>
  `<div class="bar" style="background:${legendGradient(RAMPS[name])}"></div><div class="ticks"><span>${lo}</span><span>${hi}</span></div>`;
const asc = (r: Raster, values: Float32Array) => rasterToAsc({ ...r, data: values });
const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export function initAnalysis(host: AnalysisHost) {
  let last: AnalysisResult | null = null;
  let crimes: Crime[] = [];
  let crimeKey = '';

  const show = (res: AnalysisResult) => {
    last = res;
    const view = $('view-analysis');
    view.querySelector('canvas')?.remove();
    view.querySelector('.empty')?.remove();
    view.insertBefore(res.canvas, $('anLegend'));
    $('anLegend').innerHTML = res.legend;
    $('anLegend').hidden = false;
    $('anSummary').innerHTML = res.summary;
    host.selectTab('analysis');
  };

  const centre = (s: SiteData) => {
    const [lon, lat] = toWGS((s.bbox.minE + s.bbox.maxE) / 2, (s.bbox.minN + s.bbox.maxN) / 2);
    return { lat, lon };
  };

  async function shadow(site: SiteData): Promise<AnalysisResult> {
    if (!site.dsm) throw new Error('Shadows need the LIDAR surface (DSM): tick it in step 2 and fetch again.');
    const { lat, lon } = centre(site);
    const v = baseView(site);
    if ($<HTMLSelectElement>('anShadowMode').value === 'at') {
      const sun = sunPosition(londonToUtc($('anDate').value, $('anTime').value), lat, lon);
      const { mask, raster } = await runTask('shadowAt', { dsm: site.dsm, azimuth: sun.azimuth, altitude: sun.altitude });
      drawRaster(v, raster, (k) => (mask[k] ? 1 : NaN), [[0, [20, 30, 80]], [1, [20, 30, 80]]], 0.55);
      drawBuildings(v, site, 'rgba(240,240,240,0.9)');
      const shaded = mask.reduce((a, b) => a + b, 0) / mask.length;
      return {
        name: `shadow_${$('anDate').value}_${$('anTime').value.replace(':', '')}`, canvas: v.canvas,
        legend: `<b>Shadow</b> · sun azimuth ${sun.azimuth.toFixed(0)}°, altitude ${sun.altitude.toFixed(1)}°`,
        summary: sun.altitude <= 0 ? 'The sun is below the horizon at this time.' : `${(shaded * 100).toFixed(0)} % of the site is in shadow at ${$('anTime').value} (UK time) on ${$('anDate').value}.`,
        data: { file: 'shadow.asc', text: asc(raster, Float32Array.from(mask)) },
      };
    }
    const r = await runTask('sunHours', { dsm: site.dsm, day: $('anDate').value, lat, lon, step: num('anStep') }, (f) => void host.stage(`Sun hours… ${Math.round(f * 100)} %`));
    drawRaster(v, r.raster, (k) => (r.daylight ? r.hours[k] / r.daylight : NaN), RAMPS.sun, 0.8);
    drawBuildings(v, site, 'rgba(255,255,255,0)');
    const ok = r.hours.reduce((a, h) => a + (h >= 2 ? 1 : 0), 0) / r.hours.length;
    const mean = r.hours.reduce((a, b) => a + b, 0) / r.hours.length;
    return {
      name: `sun-hours_${$('anDate').value}`, canvas: v.canvas, legend: `<b>Hours of direct sun</b> (${$('anDate').value})${bar('sun', '0 h', `${r.daylight.toFixed(1)} h`)}`,
      summary: `Daylight ${r.daylight.toFixed(1)} h · mean ${mean.toFixed(1)} h of sun per cell · ${(ok * 100).toFixed(0)} % of the site gets ≥ 2 h (BRE 209 looks for ≥ 50 % of amenity space on 21 March).`,
      data: { file: 'sun_hours.asc', text: asc(r.raster, r.hours) },
    };
  }

  async function wind(site: SiteData): Promise<AnalysisResult> {
    if (!site.dsm) throw new Error('Wind needs the LIDAR surface (DSM).');
    const dir = num('anWindDir'), speed = num('anWindSpeed');
    const r = await runTask('wind', { dsm: site.dsm, dtm: site.dtm, from: dir, speed });
    const v = baseView(site);
    const classRamp = LAWSON_COLOURS.map((c, i) => [i / 4, rgb(c)] as [number, [number, number, number]]);
    drawRaster(v, r.raster, (k) => (r.ratio[k] ? r.classes[k] / 4 : NaN), classRamp, 0.8);
    drawBuildings(v, site, 'rgba(60,60,60,0.8)');
    const th = (dir * Math.PI) / 180, cx = 70, cy = 70;
    v.ctx.strokeStyle = '#111'; v.ctx.lineWidth = 4; v.ctx.beginPath();
    v.ctx.moveTo(cx + Math.sin(th) * 40, cy - Math.cos(th) * 40); v.ctx.lineTo(cx - Math.sin(th) * 40, cy + Math.cos(th) * 40); v.ctx.stroke();
    v.ctx.fillStyle = '#111'; v.ctx.font = 'bold 16px sans-serif'; v.ctx.fillText(`wind from ${dir}°, ${speed} m/s`, 12, 20);
    return {
      name: `wind_${dir}deg_${speed}ms`, canvas: v.canvas,
      legend: `<b>Pedestrian comfort (Lawson-style, screening)</b><br>${LAWSON_LABELS.map((l, i) => `<span class="cls"><i style="background:${LAWSON_COLOURS[i]}"></i>${l}</span>`).join('')}`,
      summary: `Open-ground shares: ${r.share.map((s, i) => `${LAWSON_LABELS[i].split(' (')[0]} ${(s * 100).toFixed(0)} %`).join(' · ')}. Indicative screening model, not CFD.`,
      data: { file: 'wind_speed.asc', text: asc(r.raster, r.speed) },
    };
  }

  async function flood(site: SiteData): Promise<AnalysisResult> {
    const ctx = buildContext(site);
    const v = baseView(site);
    let zonesNote = '';
    let defLines: [number, number][][] = [];
    if ($('anZones').checked) {
      try {
        const [zones, defs] = await Promise.all([fetchFloodZones(site.bbox), fetchDefences(site.bbox)]);
        drawPolygons(v, zones.filter((z) => z.zone === 'FZ2').flatMap((z) => z.polygons), 'rgba(150,190,255,0.30)', 'rgba(90,140,230,0.7)');
        drawPolygons(v, zones.filter((z) => z.zone === 'FZ3').flatMap((z) => z.polygons), 'rgba(60,110,220,0.35)', 'rgba(30,70,190,0.9)');
        defLines = defs.flatMap((d) => d.lines);
        zonesNote = ` EA Flood Zone 2/3 outlines shown (${zones.length} areas, ${defs.length} defences).`;
      } catch (e) { zonesNote = ` (EA layers unavailable: ${e instanceof Error ? e.message : e})`; }
    }
    if ($<HTMLSelectElement>('anFloodMode').value === 'rain') {
      const p = await runTask('ponding', { dtm: site.dtm });
      drawRaster(v, p.raster, (k) => (p.depth[k] > 0 ? Math.min(1, p.depth[k] / 1.5) : NaN), RAMPS.depth, 0.85);
      drawBuildings(v, site, 'rgba(70,70,70,0.55)');
      return {
        name: 'ponding', canvas: v.canvas, legend: `<b>Surface-water ponding depth</b>${bar('depth', '0', '≥ 1.5 m')}`,
        summary: `${p.area.toFixed(0)} m² of low spots collect water, up to ${p.maxDepth.toFixed(2)} m deep (${p.volume.toFixed(0)} m³). Closed depressions in the 1 m LIDAR ground only; drains and sewers are ignored.${zonesNote}`,
        data: { file: 'ponding_depth.asc', text: asc(p.raster, p.depth) },
      };
    }
    const sources = ctx.water.length ? rasterizePolygons(ctx.water, site.dtm) : new Uint8Array(site.dtm.data.length);
    let level = $('anFloodLevel').value === '' ? NaN : num('anFloodLevel');
    let note = '';
    if (ctx.water.length) {
      const wet = [...site.dtm.data].filter((_, k) => sources[k]).sort((a, b) => a - b);
      if (Number.isNaN(level)) { level = wet[Math.floor(wet.length / 2)] + 1.5; $('anFloodLevel').value = level.toFixed(1); note = ' Level defaulted to the river level + 1.5 m.'; }
    } else {
      let lo = 0;
      for (let k = 1; k < site.dtm.data.length; k++) if (site.dtm.data[k] < site.dtm.data[lo]) lo = k;
      sources[lo] = 1;
      if (Number.isNaN(level)) { level = site.dtm.data[lo] + 1; $('anFloodLevel').value = level.toFixed(1); }
      note = ' No water on site: flooding starts from the lowest point.';
    }
    const f = await runTask('flood', { dtm: site.dtm, level, sources, defences: defLines.length && num('anDefence') > 0 ? { lines: defLines, height: num('anDefence') } : undefined });
    drawRaster(v, f.raster, (k) => (f.depth[k] > 0 ? Math.min(1, f.depth[k] / 3) : NaN), RAMPS.depth, 0.85);
    drawBuildings(v, site, 'rgba(70,70,70,0.55)');
    const bf = buildingFlood(site.buildings, f);
    return {
      name: `flood_${level.toFixed(1)}m`, canvas: v.canvas, legend: `<b>Flood depth at ${level.toFixed(1)} m ODN</b>${bar('depth', '0', '≥ 3 m')}`,
      summary: `${f.area.toFixed(0)} m² flooded, max depth ${f.maxDepth.toFixed(2)} m, ${bf.length} of ${site.buildings.length} buildings affected (deepest ${Math.max(0, ...bf.map((b) => b.depth)).toFixed(2)} m).${note}${zonesNote} Indicative extent only.`,
      data: { file: 'flood_depth.asc', text: asc(f.raster, f.depth) },
    };
  }

  async function crime(site: SiteData): Promise<AnalysisResult> {
    const b = site.bbox;
    const outline = site.shape ?? [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN]] as [number, number][];
    const key = `${b.minE},${b.minN},${b.maxE},${b.maxN},${num('anMonths')}`;
    if (key !== crimeKey) {
      crimes = await fetchCrimes(outline, b, num('anMonths'), (d, t) => void host.stage(`Police data… ${d}/${t} months`), host.log);
      crimeKey = key;
      const sel = $<HTMLSelectElement>('anCrimeCat');
      sel.length = 1;
      for (const [c] of summariseCrimes(crimes).byCategory) sel.add(new Option(CRIME_LABELS[c] ?? c, c));
    }
    const list = filterCrimes(crimes, $<HTMLSelectElement>('anCrimeCat').value);
    const cell = Math.max(2, Math.round((b.maxE - b.minE) / 250));
    const like = { minE: b.minE, maxN: b.maxN, res: cell, width: Math.ceil((b.maxE - b.minE) / cell), height: Math.ceil((b.maxN - b.minN) / cell) };
    const kde = kernelDensity(list.map((c) => ({ p: c.p })), like, 35);
    const max = Math.max(...kde, 1e-12);
    const v = baseView(site);
    drawRaster(v, { ...like, data: kde }, (k) => (kde[k] > max * 0.05 ? kde[k] / max : NaN), RAMPS.heat, 0.7);
    drawBuildings(v, site, 'rgba(70,70,70,0.4)');
    v.ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (const c of list) { const [x, y] = v.px(c.p[0], c.p[1]); v.ctx.beginPath(); v.ctx.arc(x, y, 2, 0, 7); v.ctx.fill(); }
    const s = summariseCrimes(list);
    return {
      name: 'crime', canvas: v.canvas, legend: `<b>Crime density</b> (${s.total} reports)${bar('heat', 'low', 'high')}`,
      summary: `${s.total} reports in ${num('anMonths')} months. Top: ${s.byCategory.slice(0, 3).map(([c, n]) => `${CRIME_LABELS[c] ?? c} ${n}`).join(', ') || '–'}. Busiest streets: ${s.byStreet.slice(0, 3).map(([c, n]) => `${c} (${n})`).join(', ') || '–'}. Locations are anonymised to street points; counts are not rates.`,
      data: { file: 'crimes.csv', text: csv(['category', 'month', 'street', 'outcome', 'easting', 'northing'], list.map((c) => [c.category, c.month, c.street, c.outcome ?? '', c.p[0].toFixed(1), c.p[1].toFixed(1)])) },
    };
  }

  async function footfallRun(site: SiteData): Promise<AnalysisResult> {
    const entrances = findEntrances(site.buildings, site.points, site.lines);
    const r = await runTask('footfall', {
      buildings: site.buildings, entrances, points: site.points, lines: site.lines,
      weights: { residential: num('anWRes'), retail: num('anWRet'), transit: num('anWTra') },
    });
    const v = baseView(site);
    drawBuildings(v, site, 'rgba(70,70,70,0.35)');
    drawEdges(v, r.edges, RAMPS.heat);
    v.ctx.fillStyle = '#0a7'; v.ctx.strokeStyle = '#0a7'; v.ctx.lineWidth = 1.5;
    for (const e of entrances) { const [x, y] = v.px(e.p[0], e.p[1]); v.ctx.beginPath(); v.ctx.arc(x, y, e.source === 'osm' ? 4 : 2.5, 0, 7); e.source === 'osm' ? v.ctx.fill() : v.ctx.stroke(); }
    const osmN = entrances.filter((e) => e.source === 'osm').length;
    return {
      name: 'footfall', canvas: v.canvas, legend: `<b>Relative pedestrian activity</b>${bar('heat', 'quiet', 'busiest')}<br>Entrances: ● mapped in OSM, ○ inferred`,
      summary: `${entrances.length} entrances (${osmN} from OSM, ${entrances.length - osmN} inferred), ${r.destinations} destinations. Busiest: ${r.hotspots.slice(0, 3).map((h) => h.name).join(', ') || '–'}. A model of likely activity, not counted footfall.`,
      data: { file: 'footfall_edges.csv', text: csv(['easting_a', 'northing_a', 'easting_b', 'northing_b', 'kind', 'relative_flow'], r.edges.filter((e) => e.flow > 0).map((e) => [e.a[0].toFixed(1), e.a[1].toFixed(1), e.b[0].toFixed(1), e.b[1].toFixed(1), e.kind, e.flow.toFixed(4)])) },
    };
  }

  /** A3 sheet: 21 Mar / 21 Jun / 21 Dec at 09:00, 12:00 and 15:00 (UK time), one tile each. */
  async function studySheet(site: SiteData) {
    if (!site.dsm) throw new Error('Shadows need the LIDAR surface (DSM).');
    const { lat, lon } = centre(site);
    const dates = ['2026-03-21', '2026-06-21', '2026-12-21'], times = ['09:00', '12:00', '15:00'];
    const tile = 700, gap = 20, head = 150, W = 3 * tile + 4 * gap, aspect = (site.bbox.maxN - site.bbox.minN) / (site.bbox.maxE - site.bbox.minE);
    const th = Math.round(tile * aspect), H = head + 3 * (th + 60) + gap;
    const sheet = document.createElement('canvas');
    sheet.width = W; sheet.height = H;
    const g = sheet.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#000'; g.font = 'bold 54px sans-serif'; g.fillText('Shadow study', gap, 70);
    g.font = '28px sans-serif'; g.fillText(`BNG E ${site.bbox.minE}–${site.bbox.maxE}, N ${site.bbox.minN}–${site.bbox.maxN} · UK clock time · sun from NOAA algorithm, shadows from the 1 m LIDAR surface (buildings, trees, terrain)`, gap, 115);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        await host.stage(`Shadow study ${r * 3 + c + 1}/9`);
        const sun = sunPosition(londonToUtc(dates[c], times[r]), lat, lon);
        const v = baseView(site, tile);
        const { mask, raster } = await runTask('shadowAt', { dsm: site.dsm, azimuth: sun.azimuth, altitude: sun.altitude });
        drawRaster(v, raster, (k) => (mask[k] ? 1 : NaN), [[0, [20, 30, 80]], [1, [20, 30, 80]]], 0.55);
        drawBuildings(v, site, 'rgba(245,245,245,0.9)');
        const x = gap + c * (tile + gap), y = head + r * (th + 60);
        g.drawImage(v.canvas, x, y, tile, th);
        g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(x, y, tile, th);
        g.fillStyle = '#000'; g.font = 'bold 28px sans-serif';
        g.fillText(`${new Date(`${dates[c]}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} · ${times[r]}`, x, y + th + 34);
        g.font = '22px sans-serif'; g.fillText(sun.altitude > 0 ? `sun ${sun.azimuth.toFixed(0)}° az, ${sun.altitude.toFixed(0)}° alt` : 'sun below horizon', x + tile - 280, y + th + 34);
      }
    }
    return sheet;
  }

  const types: Record<string, (s: SiteData) => Promise<AnalysisResult>> = { shadow, wind, flood, crime, footfall: footfallRun };
  const sync = () => document.querySelectorAll<HTMLElement>('[data-an]').forEach((el) => (el.hidden = el.dataset.an !== $<HTMLSelectElement>('anType').value));
  $('anType').onchange = sync;
  sync();
  document.querySelectorAll<HTMLElement>('[data-date]').forEach((b) => (b.onclick = () => { $('anDate').value = b.dataset.date!; }));
  $('anRun').onclick = async () => {
    const site = host.site();
    if (!site) return;
    const kind = $<HTMLSelectElement>('anType').value;
    const res = await host.busy(`Analysing (${kind})`, async () => {
      const out = await types[kind](site);
      if (site.shape) {
        const scale = out.canvas.width / (site.bbox.maxE - site.bbox.minE);
        drawOutline({ canvas: out.canvas, ctx: out.canvas.getContext('2d')!, scale, px: (e, n) => [(e - site.bbox.minE) * scale, (site.bbox.maxN - n) * scale] }, site.shape);
      }
      return out;
    });
    if (res) show(res);
  };
  $('anStudy').onclick = async () => {
    const site = host.site();
    if (!site) return;
    const sheet = await host.busy('Shadow study sheet', () => studySheet(site));
    if (!sheet) return;
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'mm', format: [420, 297 * (sheet.height / sheet.width) * (420 / 297)], orientation: 'landscape' });
    const hMm = 420 * (sheet.height / sheet.width);
    pdf.deletePage(1);
    pdf.addPage([420, hMm], 'landscape');
    pdf.addImage(sheet.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 420, hMm);
    host.download('shadow_study.pdf', pdf.output('blob'), 'application/pdf');
    show({ name: 'shadow_study', canvas: sheet, legend: '<b>Shadow study</b> · 21 Mar / Jun / Dec at 09:00, 12:00, 15:00', summary: 'Shadow study sheet saved as PDF.' });
  };
  $('anCancel').onclick = () => { cancelTasks(); host.log('Analysis cancelled.'); };
  $('anPng').onclick = () => {
    if (!last) return host.log('Run an analysis first.');
    last.canvas.toBlob((b) => b && host.download(`${last!.name}.png`, b), 'image/png');
  };
  $('anData').onclick = () => {
    if (!last?.data) return host.log('Run an analysis first.');
    host.download(last.data.file, last.data.text, 'text/plain');
  };
  $('anWindClimate').onclick = async () => {
    const site = host.site();
    if (!site) return;
    await host.busy('Fetching local wind climate', async () => {
      const { lat, lon } = centre(site);
      const w = await fetchWindClimate(lat, lon);
      $('anWindDir').value = String(Math.round(w.prevailing));
      $('anWindSpeed').value = w.p95.toFixed(1);
      host.log(`Wind climate (last year, ${w.hours} h): prevailing from ${w.prevailing}°, mean ${w.mean.toFixed(1)} m/s, 95th percentile ${w.p95.toFixed(1)} m/s. Direction and speed set to the prevailing wind and the 95th-percentile speed.`);
    });
  };
}
