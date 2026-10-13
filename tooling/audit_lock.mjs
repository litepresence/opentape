// tooling/audit_lock.mjs — a locked terminal must never be a silent trap:
// the state is visible, and the refusal offers a way out.
// Usage: node tooling/audit_lock.mjs [baseUrl]
import { chromium } from 'playwright';
import { pickTool, openMenu, clickGlyph } from './rail_helpers.mjs';

const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
const fails = [];
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) fails.push(n); };

await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);

// lock on
await clickGlyph(page, 'lock');
await page.waitForTimeout(400);
check('lock state is on', await page.evaluate(() => window.__tv.view.get().locked === true));
check('lock button reads engaged', await page.locator('#rail .rail-btn[data-group-id="lock"].engaged').count() === 1);
check('header badge visible', await page.locator('#locked-badge').count() === 1,
  await page.evaluate(() => document.querySelector('#locked-badge')?.textContent || ''));

// a shape tool refuses with an actionable toast
await openMenu(page, 'shapes');
await page.waitForTimeout(250);
await page.click('#tool-menu button[data-item="rect"]');
const box = await page.locator('#overlay').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.click(cx - 120, cy - 80); await page.waitForTimeout(200);
await page.mouse.click(cx + 120, cy + 80); await page.waitForTimeout(400);
check('placement refused while locked', await page.evaluate(() => (window.__tv.view.get().drawings || []).length) === 0);
const toastBtn = await page.locator('#toast button').count();
check('refusal offers Unlock', toastBtn === 1, await page.evaluate(() => document.querySelector('#toast')?.textContent || ''));

// the toast action unlocks, and drawing then works
await page.click('#toast button');
await page.waitForTimeout(400);
check('toast action unlocks', await page.evaluate(() => window.__tv.view.get().locked === false));
check('badge removed', await page.locator('#locked-badge').count() === 0);
await page.mouse.click(cx - 120, cy - 80); await page.waitForTimeout(200);
await page.mouse.click(cx + 120, cy + 80); await page.waitForTimeout(400);
check('shape places after unlocking', await page.evaluate(() => (window.__tv.view.get().drawings || []).length) === 1);

// the badge itself unlocks on a reload with lock persisted
await clickGlyph(page, 'lock');
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);
check('locked state survives reload visibly', await page.locator('#locked-badge').count() === 1);
await page.click('#locked-badge');
await page.waitForTimeout(300);
check('badge click unlocks', await page.evaluate(() => window.__tv.view.get().locked === false));

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('lock audit ok');

