// tooling/verify_studies.mjs — Task 9 verification: dialog lists grouped 85,
// filter works, overlay/bands/pane studies render, transform replaces candles.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('tooling/shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(process.argv[2] || 'http://localhost:8787/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 15000 });
// Open the indicators dialog; studies extension loads async via dynamic import.
await page.click('#ind-btn');
await page.waitForSelector('#ind-groups input[data-study]', { timeout: 10000 });
const boxes = await page.locator('#ind-groups input[data-study]').count();
const radios = await page.locator('#ind-groups input[data-transform]').count();
console.log(`studies dialog: ${boxes} checkboxes, ${radios} transform radios`);
if (boxes !== 82 || radios !== 3) throw new Error(`expected 82 checkboxes + 3 radios, got ${boxes} + ${radios}`);
// Filter narrows the list.
await page.fill('#ind-filter', 'rsi');
const visible = await page.locator('#ind-groups label[data-label]:visible').count();
console.log(`filter 'rsi' matches ${visible} labels`);
if (visible < 1) throw new Error('filter matched nothing');
await page.fill('#ind-filter', '');
// Enable one overlay + one bands + one pane study.
await page.check('input[data-study="sma"]');
await page.check('input[data-study="bbands"]');
await page.check('input[data-study="macd"]');
await page.waitForTimeout(500);
await page.screenshot({ path: 'tooling/shots/studies-dialog.png' });
await page.click('#ind-dialog button[value="close"]');
await page.waitForTimeout(500);
await page.screenshot({ path: 'tooling/shots/studies-1920.png' });
// Transform radio replaces the candle source.
await page.click('#ind-btn');
await page.waitForSelector('#ind-groups input[data-transform]');
await page.check('input[data-transform="heikinashi"]');
await page.waitForTimeout(500);
await page.click('#ind-dialog button[value="close"]');
await page.waitForTimeout(500);
await page.screenshot({ path: 'tooling/shots/studies-transform.png' });
if (errors.length) { console.error('PAGE ERRORS', errors); process.exit(1); }
console.log('verify_studies ok, no page errors');
await browser.close();
