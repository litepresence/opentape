// tooling/audit_symbols.mjs — symbol modal hints + exchange in the URL.
// Usage: node tooling/audit_symbols.mjs [baseUrl]
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const fails = [];
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) fails.push(n); };

await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.waitForTimeout(1200);

// URL carries the exchange
let search = await page.evaluate(() => location.search);
check('URL carries exchange', /[?&]exchange=binance(&|$)/.test(search), search);

// modal hints at available exchanges on focus
await page.click('#sym');
await page.waitForSelector('#sym-dialog[open]', { timeout: 8000 });
await page.click('#sym-ex-input');
await page.waitForTimeout(500);
const listed = await page.locator('#sym-ex-list button').count();
check('exchange hints on focus', listed > 3, `${listed} suggestions`);
const firstFew = await page.locator('#sym-ex-list button').allTextContents();
check('verified venues listed first', firstFew.some(t => t.includes('binance')), JSON.stringify(firstFew.slice(0, 4)));

// typing filters the exchange list
await page.fill('#sym-ex-input', 'coin');
await page.waitForTimeout(400);
const filtered = await page.locator('#sym-ex-list button').allTextContents();
check('typing filters exchanges', filtered.length > 0 && filtered.every(t => t.toLowerCase().includes('coin')),
  JSON.stringify(filtered.slice(0, 5)));

// pair hints come from the selected venue
await page.click('#sym-ex-list button');
await page.waitForFunction(() => /pairs/.test(document.querySelector('#sym-note')?.textContent || ''), null, { timeout: 30000 });
const note = await page.evaluate(() => document.querySelector('#sym-note').textContent);
check('pair list loads for venue', /\d+ pairs/.test(note), note);
await page.fill('#sym-pair-input', 'ETH');
await page.waitForTimeout(900);
const pairs = await page.locator('#sym-pair-list button').count();
check('pair hints while typing', pairs > 0, `${pairs} suggestions`);

// switching exchange updates the URL and the header
await page.click('#sym-pair-list button:has-text("ETH/USD")').catch(async () => {
  const alt = page.locator('#sym-pair-list button').first();
  if (await alt.count()) await alt.click();
});
await page.click('#sym-apply');
await page.waitForTimeout(4000);
search = await page.evaluate(() => location.search);
const ex = await page.evaluate(() => document.querySelector('#sym-ex')?.textContent);
check('URL still carries exchange after switch', /[?&]exchange=/.test(search), search);
check('header shows the routed venue', !!ex && ex.length > 1, ex);

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('symbols audit ok');
