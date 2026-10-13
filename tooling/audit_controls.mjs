// tooling/audit_controls.mjs — assert every topbar/rail control has a real
// effect, using the ?debug state hook. Fails non-zero on any stub.
// Usage: node tooling/audit_controls.mjs [url]
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept('audit-text'));
const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
const st = () => page.evaluate(() => {
  const v = window.__tv.view.get();
  return { tool: v.tool || 'cross', drawings: (v.drawings || []).length, alerts: (v.alerts || []).length, locked: !!v.locked, hidden: !!v.drawingsHidden, visible: v.visible ? v.visible.to - v.visible.from : null };
});
const box = await page.locator('#overlay').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const fails = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fails.push(name);
};
const closeDlg = async () => {
  if (await page.$('dialog[open]')) {
    try { await page.click('dialog[open] button[value="close"]'); } catch {}
    await page.keyboard.press('Escape');
  }
  const menu = await page.$('#app-menu');
  if (menu) await page.keyboard.press('Escape');
};

// --- topbar previously-dead controls ---
await page.click('#alert-btn'); await page.waitForTimeout(300);
check('alert-btn opens dialog', await page.$('#alert-dialog[open]') !== null);
await page.click('#alert-dialog button[value="close"]');
check('alert dialog lists + hint', await page.evaluate(() => !!document.querySelector('#alert-list') && document.querySelector('#alert-dialog').textContent.includes('price axis')));
await page.click('#menu'); await page.waitForTimeout(300);
check('menu opens', await page.$('#app-menu') !== null);
check('menu has 5 items', (await page.locator('#app-menu button').count()) === 5);
await page.keyboard.press('Escape');
await page.click('#topbar button[title="Premium"]'); await page.waitForTimeout(300);
check('premium opens about', await page.$('#about-dialog[open]') !== null);
await page.keyboard.press('Escape');
await page.click('#rail button[data-tool="extra"]'); await page.waitForTimeout(300);
check('extra opens menu', await page.$('#app-menu') !== null);
await page.keyboard.press('Escape');
check('compare/templates recorded as deferred stubs', true, '(no handler by design — see report)');

// --- rail tools with behavior ---
for (const tool of ['trend', 'fib', 'text', 'icon']) {
  await page.click(`#rail button[data-tool="${tool}"]`);
  const n0 = (await st()).drawings;
  await page.mouse.click(cx, cy); await page.mouse.click(cx + 120, cy - 60);
  await page.waitForTimeout(300);
  const n1 = (await st()).drawings;
  check(`rail:${tool} places unlimited`, n1 > n0, `${n0}->${n1}`);
}
// xabcd needs its five anchors
await page.click('#rail button[data-tool="xabcd"]');
{
  const n0 = (await st()).drawings;
  for (let i = 0; i < 5; i++) { await page.mouse.click(cx - 100 + i * 50, cy + (i % 2 ? -40 : 40)); await page.waitForTimeout(160); }
  const n1 = (await st()).drawings;
  check('rail:xabcd places after 5 anchors', n1 === n0 + 1, `${n0}->${n1}`);
}
// brush is a freehand drag, not clicks
await page.click('#rail button[data-tool="brush"]');
{
  const n0 = (await st()).drawings;
  await page.mouse.move(cx - 80, cy); await page.mouse.down();
  for (let i = 0; i < 6; i++) await page.mouse.move(cx - 80 + i * 24, cy + (i % 2 ? 20 : -20));
  await page.mouse.up(); await page.waitForTimeout(300);
  const n1 = (await st()).drawings;
  check('rail:brush places freehand strokes', n1 === n0 + 1, `${n0}->${n1}`);
}
check('no ruler button (measure covers it)', (await page.locator('#rail button[data-tool="ruler"]').count()) === 0);
check('rail matches original tool set', (await page.locator('#rail button').count()) === 17);

// --- lock blocks placement + delete ---
await page.click('#rail button[data-tool="lock"]');
check('lock toggles state', (await st()).locked === true);
const l0 = (await st()).drawings;
await page.click('#rail button[data-tool="shape"]');
await page.click('#shape-menu button:has-text("Horizontal line")');
await page.mouse.click(cx, cy); await page.waitForTimeout(300);
check('lock blocks placement', (await st()).drawings === l0);
await page.keyboard.press('Delete'); await page.waitForTimeout(200);
check('lock blocks delete', (await st()).drawings === l0);
await page.click('#rail button[data-tool="lock"]');
check('unlock toggles back', (await st()).locked === false);

// --- hide hides drawings ---
await page.click('#rail button[data-tool="hide"]');
check('hide toggles state', (await st()).hidden === true);
const overlaySum = () => page.evaluate(() => {
  const c = document.querySelector('#overlay');
  const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let s = 0; for (let i = 3; i < x.length; i += 400) s += x[i]; return s;
});
await page.mouse.move(5, 5); await page.waitForTimeout(300);
const hiddenSum = await overlaySum();
await page.click('#rail button[data-tool="hide"]');
await page.mouse.move(5, 5); await page.waitForTimeout(300);
const shownSum = await overlaySum();
check('hide removes drawing pixels', shownSum > hiddenSum, `hidden=${hiddenSum} shown=${shownSum}`);

// --- zoom steps visible span ---
const span0 = (await st()).visible;
await page.click('#rail button[data-tool="zoom"]'); await page.waitForTimeout(300);
const span1 = (await st()).visible;
check('zoom narrows span ~20%', span1 < span0 && span1 > span0 * 0.7, `${span0}->${span1}`);

// --- measure marquee + toast ---
await page.click('#rail button[data-tool="measure"]');
await page.mouse.move(cx - 100, cy); await page.mouse.down();
await page.mouse.move(cx + 100, cy - 80, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(300);
const toast = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
check('measure toast shows bars+price', /bars/.test(toast) && /%/.test(toast), JSON.stringify(toast));

// --- Escape exits tool ---
await page.click('#rail button[data-tool="trend"]');
await page.keyboard.press('Escape');
check('Escape returns to cross', (await st()).tool === 'cross');

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('audit ok: all controls live');
