// tooling/audit_data_state.mjs — prove the terminal shows real data only:
// live rows render, and a blocked CDN surfaces an error + retry (never fake
// candles). Usage: node tooling/audit_data_state.mjs [baseUrl]
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const fails = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fails.push(name);
};

// 1. live: rows paint and the overlay is gone
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const el = document.querySelector('#data-status');
    return { rows: window.__tv.rows().length, status: el ? el.style.display : 'missing', ohlc: document.querySelector('#ohlc')?.textContent || '' };
  });
  check('live rows loaded', info.rows > 50, `${info.rows} rows`);
  check('status overlay hidden on success', info.status === 'none', info.status);
  check('OHLC header populated', /^O \d/.test(info.ohlc), info.ohlc.slice(0, 30));
  check('no page errors', errors.length === 0);
  await browser.close();
}

// 2. blocked CDN: error state + retry button, chart stays empty (no fake bars)
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.route('**/ccxt.browser.js', r => r.abort());
  await page.goto(base + '/index.html?debug', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#data-status.error', { timeout: 30000 });
  const err = await page.evaluate(() => ({
    text: document.querySelector('#data-status')?.textContent || '',
    retry: !!document.querySelector('#data-status [data-retry]'),
    rows: window.__tv ? window.__tv.rows().length : -1,
  }));
  check('error state shown when CDN blocked', err.text.includes('No market data'), err.text.slice(0, 60));
  check('retry offered', err.retry);
  check('no fake candles painted', err.rows === 0, `${err.rows} rows`);
  await page.screenshot({ path: 'tooling/shots/error-state.png' });
  await browser.close();
}

if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('data-state audit ok');