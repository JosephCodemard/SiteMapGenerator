// End-to-end smoke test: loads the app, fetches a Bath preset from the live services,
// rebuilds the model at each building LOD, screenshots map / 3D / drawing, and downloads every export.
// Usage (Playwright must be resolvable from this file's directory):
//   npm i --no-save playwright && npx playwright install chromium
//   npm run dev   # in another terminal
//   node tools/e2e/drive.mjs <out-dir> [url] [preset-index] [osm-json-file]
import { chromium } from 'playwright';
const out = process.argv[2];
const url = process.argv[3] ?? 'http://localhost:5173/';
const presetIdx = process.argv[4] ?? '2'; // 0 Abbey, 1 Royal Crescent, 2 Pulteney Bridge, 3 Spa station, 4 Central Bath
const osmFile = process.argv[5];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => document.getElementById('minE').value !== '', null, { timeout: 30000 });
await page.selectOption('#preset', presetIdx);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/1-map.png` });
console.log('bbox', await page.evaluate(() => ['minE', 'minN', 'maxE', 'maxN'].map((k) => document.getElementById(k).value).join(' ')));
if (osmFile) await page.setInputFiles('#osmFile', osmFile);
if (process.env.SHAPE === 'hexagon') {
  // Same handler the map's hexagon tool calls.
  await page.evaluate(() => { const [x0, y0, x1, y1] = ['minE', 'minN', 'maxE', 'maxN'].map((k) => +document.getElementById(k).value); const c = [(x0 + x1) / 2, (y0 + y1) / 2], r = 190; window.setShape(Array.from({ length: 6 }, (_, i) => [c[0] + r * Math.cos(i * Math.PI / 3), c[1] + r * Math.sin(i * Math.PI / 3)])); });
  console.log('shape', await page.textContent('#areaInfo'));
}

await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
const idle = () => page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 600000 });
const t0 = Date.now();
await page.click('#fetch');
try { await page.waitForSelector('#summary table', { timeout: 420000 }); }
catch (e) { console.log('TIMEOUT. app log:\n' + await page.textContent('#log') + '\nconsole:\n' + errors.join('\n')); process.exit(1); }
await idle();
console.log('fetch+model s', (Date.now() - t0) / 1000);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/2-model-lod1.png` });

await page.selectOption('#terrainStep', '-1'); // adaptive terrain
for (const lod of ['lod15', 'lod2fit', 'lod2']) {
  const t = Date.now();
  await page.selectOption('#lod', lod);
  await page.click('#rebuild');
  await page.waitForTimeout(300);
  await idle();
  console.log(`rebuild ${lod} s`, (Date.now() - t) / 1000);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/2-model-${lod}.png` });
}
// Back to pitched roofs for the exports.
await page.selectOption('#lod', 'lod15');
await page.click('#rebuild');
await idle();

await page.click('#previewDrawing');
await page.waitForFunction(() => document.getElementById('busy').hidden && document.querySelector('#view-drawing svg'), null, { timeout: 120000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/3-drawing.png` });

const exports = ['exportObj', 'exportStl', 'exportDxf3d', 'exportSvg', 'exportPng', 'exportDxf', 'exportLaser', 'exportData'];
for (const id of exports) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click(`#${id}`)]);
  const p = `${out}/${dl.suggestedFilename()}`;
  await dl.saveAs(p);
  console.log('download', id, dl.suggestedFilename());
  await idle();
}
// Analyses (flood and crime use the live EA / police services).
for (const [type, setup] of [['shadow', null], ['wind', null], ['flood', null], ['crime', null], ['footfall', null]]) {
  await page.selectOption('#anType', type);
  if (type === 'shadow') await page.selectOption('#anStep', '60');
  const t = Date.now();
  await page.click('#anRun');
  await page.waitForTimeout(300);
  await idle();
  await page.waitForTimeout(800);
  console.log('analysis', type, ((Date.now() - t) / 1000).toFixed(1) + 's:', (await page.textContent('#anSummary')).slice(0, 230));
  await page.screenshot({ path: `${out}/4-analysis-${type}.png` });
}
const [adl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#anData')]);
await adl.saveAs(`${out}/${adl.suggestedFilename()}`);
console.log('download analysis data', adl.suggestedFilename());
// OBJ as a single combined file as well.
await page.selectOption('#structure', 'combined');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#exportObj')]);
await dl.saveAs(`${out}/combined_${dl.suggestedFilename()}`);
console.log('--- app log\n' + await page.textContent('#log'));
console.log('--- summary\n' + (await page.innerText('#summary')));
console.log('--- legend\n' + (await page.innerText('#legend')));
console.log('--- console\n' + errors.join('\n'));
await browser.close();
