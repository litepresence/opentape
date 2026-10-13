// tooling/audit_markets.mjs — prove symbol/exchange/URL behavior:
// TV-style URL boots the right market, header tracks switches, ex-btn cycles
// venues, URL stays shareable. Uses the ?debug state hook.
// Usage: node tooling/audit_markets.mjs [baseUrl]
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', d => d.dismiss());
const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const fails = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fails.push(name);
};
const head = () => page.evaluate(() => ({
  icon: document.querySelector('#sym-icon')?.textContent,
  name: document.querySelector('#sym-name')?.textContent,
  tf: document.querySelector('#sym-tf')?.textContent,
  ex: document.querySelector('#sym-ex')?.textContent,
  symBtn: document.querySelector('#sym')?.textContent,
  exBtn: document.querySelector('#ex-btn')?.textContent,
  url: location.search,
}));

// 1. TV-style URL boots ETH on default routing
await page.goto(base + '/index.html?debug&symbol=ETH/USD&interval=1h', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 25000 });
await page.waitForTimeout(800);
let h = await head();
check('URL symbol boots ETH', h.name === 'Ethereum / U.S. Dollar' && h.icon === 'Ξ', JSON.stringify(h));
check('URL interval applied', h.url.includes('interval='));
check('header shows routed exchange', h.ex === 'Binance', h.ex);

// 2. no exchange button (single verified venue for one-click switching);
// switching lives in the symbol modal instead
h = await head();
check('no exchange button', await page.locator('#ex-btn').count() === 0);
check('header reports routed venue', h.ex === 'Binance', h.ex);

// 3. symbol modal: exchange + pair autosuggest, switch applies
await page.click('#sym');
await page.waitForSelector('#sym-dialog[open]', { timeout: 10000 });
check('symbol modal opens with two fields',
  (await page.locator('#sym-ex-input').count()) === 1 && (await page.locator('#sym-pair-input').count()) === 1);
await page.fill('#sym-ex-input', 'bin');
await page.waitForTimeout(400);
const exSug = await page.locator('#sym-ex-list button').count();
check('exchange autosuggest lists', exSug >= 1, `${exSug} suggestions`);
await page.click('#sym-ex-list button');
await page.waitForTimeout(300);
await page.fill('#sym-pair-input', 'ETH/USDT');
await page.waitForFunction(() => [...document.querySelectorAll('#sym-pair-list button')].some(b => b.textContent.trim() === 'ETH/USDT'), null, { timeout: 30000 });
await page.click('#sym-pair-list button:text-is("ETH/USDT")');
await page.click('#sym-apply');
await page.waitForTimeout(4000);
h = await head();
check('modal switch applies ETH/USDT pair', h.name === 'ETH / USDT' && h.symBtn === 'ETHUSDT', JSON.stringify({ name: h.name, btn: h.symBtn }));
check('modal switch URL tracks', h.url.includes('symbol='));
await page.keyboard.press('Escape');

// 3. plain load with cleared storage falls back to the BTC default header
await page.evaluate(() => localStorage.clear());
await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 25000 });
await page.waitForTimeout(800);
h = await head();
check('default header is Bitcoin', h.name === 'Bitcoin / U.S. Dollar' && h.icon === '₿');

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('markets audit ok');
