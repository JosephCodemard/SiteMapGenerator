// Map interaction test: draw two section cut lines with real mouse clicks, then click one to select it.
// Usage: npm run build && npx vite preview --port 4173 &  node tools/e2e/cut.mjs <out-dir> [url]
import { chromium } from 'playwright';
const out = process.argv[2] ?? '.';
const url = process.argv[3] ?? 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => document.getElementById('minE').value !== '', null, { timeout: 30000 });
await page.selectOption('#preset', '2');
await page.waitForTimeout(2500);
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
// Same path as a user: fetch a site (optional OSM file), press Preview with no cut line, then draw.
const osmFile = process.argv[4];
if (osmFile) {
  await page.setInputFiles('#osmFile', osmFile);
  await page.evaluate(() => document.getElementById('fetch').click());
  await page.waitForSelector('#summary table', { timeout: 300000 });
  await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 300000 });
}
await page.evaluate(() => document.getElementById('secPreview').click());
await page.waitForTimeout(300);
const log = () => page.evaluate(() => document.getElementById('log').textContent.trim().split('\n').slice(-2).join(' | '));
console.log('after preview:', await log());
await page.evaluate(() => document.querySelector('#tabs button[data-tab="map"]').click());
await page.waitForTimeout(500);
const box = await page.locator('#view-map').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
const draw = async (a, b) => {
  await page.evaluate(() => document.getElementById('drawCut').click());
  await page.mouse.click(...at(...a)); await page.waitForTimeout(150);
  await page.mouse.move(...at(b[0] - 0.05, b[1] - 0.05)); await page.mouse.move(...at(...b));
  await page.mouse.click(...at(...b)); await page.waitForTimeout(300);
};
await draw([0.3, 0.4], [0.6, 0.45]);
const n1 = await page.locator('#sectionList label').count();
await draw([0.35, 0.7], [0.65, 0.62]);
const n2 = await page.locator('#sectionList label').count();
// Click the first line (midpoint) to select it.
await page.mouse.click(...at(0.45, 0.425)); await page.waitForTimeout(300);
const checked = await page.evaluate(() => [...document.querySelectorAll('#sectionList input')].map((i) => i.checked));
await page.screenshot({ path: `${out}/cut-map.png` });
console.log('log:', await log());
console.log(JSON.stringify({ afterFirst: n1, afterSecond: n2, checked, errors }));
await browser.close();
if (n1 !== 1 || n2 !== 2 || !checked[0] || checked[1]) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
