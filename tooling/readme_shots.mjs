// tooling/readme_shots.mjs — capture README showcase screenshots against a
// static server. Uses the ?debug state hook to set study instances directly.
// Usage: node tooling/readme_shots.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
mkdirSync('tooling/shots/readme', { recursive: true });

await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 20000 });
await page.waitForTimeout(1200);

const setStudies = (list) => page.evaluate((l) => {
  window.__tv.view.set({ studies: l.map((s, i) => ({ uid: 'shot' + i, ...s })) });
}, list);
const shot = (name) => page.screenshot({ path: `tooling/shots/readme/${name}.png` });

// 1. default dark terminal, clean
await shot('readme-dark');
// 2. SMA mesh: three instances, distinct periods
await setStudies([
  { id: 'sma', params: { period: 10 }, color: '#2962FF', visible: true },
  { id: 'sma', params: { period: 20 }, color: '#FF6D00', visible: true },
  { id: 'sma', params: { period: 50 }, color: '#9C27B0', visible: true },
]);
await page.waitForTimeout(600);
await shot('readme-mesh');
// 3. Bollinger Bands
await setStudies([{ id: 'bbands', params: { period: 20, stddev: 2 }, color: null, visible: true }]);
await page.waitForTimeout(600);
await shot('readme-bbands');
// 4. MACD + RSI shared pane
await setStudies([
  { id: 'macd', params: { short: 12, long: 26, signal: 9 }, color: null, visible: true },
  { id: 'rsi', params: { period: 14 }, color: null, visible: true },
]);
await page.waitForTimeout(600);
await shot('readme-macd-rsi');
// 5. Ichimoku cloud
await setStudies([{ id: 'ichimoku', params: { tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 }, color: null, visible: true }]);
await page.waitForTimeout(600);
await shot('readme-ichimoku');
// 6. Heikin-Ashi transform (replaces candles)
await setStudies([{ id: 'heikinashi', params: {}, color: null, visible: true }]);
await page.waitForTimeout(600);
await shot('readme-heikin');
// 7. indicators modal with active instances
await setStudies([
  { id: 'sma', params: { period: 20 }, color: null, visible: true },
  { id: 'rsi', params: { period: 14 }, color: null, visible: true },
]);
await page.click('#ind-btn');
await page.waitForSelector('#ind-active-list .ind-card', { timeout: 10000 });
await page.waitForTimeout(400);
await shot('readme-modal');
await page.keyboard.press('Escape');
// 8. light theme for contrast
await page.evaluate(() => window.__tv.view.toggleTheme());
await page.waitForTimeout(600);
await shot('readme-light');

console.log('ERRORS:', JSON.stringify(errors));
await browser.close();
if (errors.length) process.exit(1);
console.log('readme shots ok');
