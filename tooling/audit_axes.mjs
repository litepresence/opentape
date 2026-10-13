// tooling/audit_axes.mjs — prove price/time axes behave like the original:
// drag rescales, wheel zooms that scale only, dblclick resets, plain click
// on the price axis still places an alert. Uses the ?debug state hook.
// Usage: node tooling/audit_axes.mjs [url]
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
const snap = () => page.evaluate(() => {
  const v = window.__tv.view.get();
  return { pmin: v.price.min, pmax: v.price.max, vfrom: v.visible.from, vto: v.visible.to, alerts: (v.alerts || []).length };
});
const fails = [];
const fitOf = () => page.evaluate(() => {
  const rows = window.__tv.rows(), v = window.__tv.view.get();
  const vis = rows.filter(r => r.t >= v.visible.from && r.t <= v.visible.to);
  let mn = Infinity, mx = -Infinity;
  for (const r of vis) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
  const pad = (mx - mn) * 0.08;
  return { min: Math.floor((mn - pad) / 1000) * 1000, max: Math.ceil((mx + pad) / 1000) * 1000, auto: v.priceAuto !== false };
});
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fails.push(name);
};
const pbox = await page.locator('#price-axis').boundingBox();
const tbox = await page.locator('#time-axis').boundingBox();
const px = pbox.x + pbox.width / 2, py = pbox.y + pbox.height / 2;

// 1. price drag rescales (drag down -> range shifts down)
const s0 = await snap();
await page.mouse.move(px, py); await page.mouse.down();
await page.mouse.move(px, py + 120, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
const s1 = await snap();
check('price drag rescales', s1.pmax < s0.pmax && s1.pmin < s0.pmin, `max ${s0.pmax}->${s1.pmax}`);
check('price drag keeps time', s1.vfrom === s0.vfrom && s1.vto === s0.vto);

// 2. wheel on price axis zooms price only
await page.mouse.move(px, py);
await page.mouse.wheel(0, -240); await page.waitForTimeout(300);
const s2 = await snap();
check('price wheel zooms price', (s2.pmax - s2.pmin) < (s1.pmax - s1.pmin));
check('price wheel keeps time', s2.vfrom === s1.vfrom && s2.vto === s1.vto);

// 3. plain click on price axis places an alert (no drag)
await page.mouse.click(px, py - 200); await page.waitForTimeout(300);
const s3 = await snap();
check('price click places alert', s3.alerts === s2.alerts + 1, `${s2.alerts}->${s3.alerts}`);

// 4. price dblclick autofits
await page.mouse.dblclick(px, py); await page.waitForTimeout(300);
const s4 = await snap();
check('price dblclick refits', s4.pmax !== s2.pmax || s4.pmin !== s2.pmin);

// 5. time drag pans
const tx = tbox.x + tbox.width / 2, ty = tbox.y + tbox.height / 2;
await page.mouse.move(tx, ty); await page.mouse.down();
await page.mouse.move(tx + 150, ty, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
const s5 = await snap();
check('time drag pans', s5.vfrom < s4.vfrom && s5.vto < s4.vto);
const fit5 = await fitOf();
check('time drag refits price', s5.pmin === fit5.min && s5.pmax === fit5.max, `fit ${fit5.min}-${fit5.max}`);

// 6. wheel on time axis zooms time only
await page.mouse.move(tx, ty);
await page.mouse.wheel(0, -240); await page.waitForTimeout(300);
const s6 = await snap();
check('time wheel zooms time', (s6.vto - s6.vfrom) < (s5.vto - s5.vfrom));
const fit6 = await fitOf();
check('time wheel refits price', s6.pmin === fit6.min && s6.pmax === fit6.max, `fit ${fit6.min}-${fit6.max}`);

// 7. time dblclick resets to full range
await page.mouse.dblclick(tx, ty); await page.waitForTimeout(300);
const s7 = await snap();
check('time dblclick resets', (s7.vto - s7.vfrom) > (s6.vto - s6.vfrom));

// 8. plot vertical drag pans price + switches auto off
const obox = await page.locator('#overlay').boundingBox();
const ox = obox.x + obox.width / 2, oy = obox.y + obox.height / 2;
await page.mouse.move(ox, oy); await page.mouse.down();
await page.mouse.move(ox + 10, oy + 120, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
const s8 = await snap();
const auto8 = await page.evaluate(() => window.__tv.view.get().priceAuto !== false);
check('plot vertical drag pans price', s8.pmax < s7.pmax, `max ${s7.pmax}->${s8.pmax}`);
check('plot vertical drag disables auto', auto8 === false);
check('axis tooltip shows auto-off', (await page.evaluate(() => document.querySelector('#price-axis').title)).includes('off'));
// 9. price dblclick re-enables auto + fits visible
await page.mouse.dblclick(px, py); await page.waitForTimeout(300);
const fit9 = await fitOf();
const s9 = await snap();
check('price dblclick re-enables auto', fit9.auto === true);
check('price dblclick fits visible', s9.pmin === fit9.min && s9.pmax === fit9.max, `fit ${fit9.min}-${fit9.max}`);
// 10. plot wheel zoom refits price to new window (auto on)
await page.mouse.move(ox, oy);
await page.mouse.wheel(0, -240); await page.waitForTimeout(300);
const fit10 = await fitOf();
const s10 = await snap();
check('plot wheel refits price', s10.pmin === fit10.min && s10.pmax === fit10.max, `fit ${fit10.min}-${fit10.max}`);
// 11. plot horizontal drag keeps auto on
await page.mouse.move(ox, oy); await page.mouse.down();
await page.mouse.move(ox + 150, oy + 1, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
check('horizontal plot drag keeps auto', (await page.evaluate(() => window.__tv.view.get().priceAuto !== false)) === true);

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('axes audit ok');
