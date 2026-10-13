// tooling/verify_studies.mjs — study modal verification: browse lists all 85,
// filter works, Add creates instances (overlay/bands/pane render), transform
// replaces the candle source. Serve repo root statically; no proxy exists.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('tooling/shots', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(process.argv[2] || 'http://localhost:8787/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 15000 });
  // Open the modal; browse lists every study with an Add button.
  await page.click('#ind-btn');
  await page.waitForSelector('#ind-dialog button[data-add]', { timeout: 10000 });
  const adds = await page.locator('#ind-dialog button[data-add]').count();
  console.log(`modal browse: ${adds} Add buttons`);
  if (adds !== 85) throw new Error(`expected 85 Add buttons, got ${adds}`);
  // Filter narrows the list.
  await page.fill('#ind-filter', 'rsi');
  const visible = await page.locator('#ind-dialog [data-study-row]:visible, #ind-dialog [data-label]:visible').count();
  console.log(`filter 'rsi' matches ${visible} rows`);
  if (visible < 1) throw new Error('filter matched nothing');
  await page.fill('#ind-filter', '');
  // Add one overlay + one bands + one pane study; assert 3 active cards.
  await page.click('#ind-dialog [data-study-row="sma"] button[data-add], #ind-dialog button[data-add="sma"]');
  await page.click('#ind-dialog [data-study-row="bbands"] button[data-add], #ind-dialog button[data-add="bbands"]');
  await page.click('#ind-dialog [data-study-row="macd"] button[data-add], #ind-dialog button[data-add="macd"]');
  await page.waitForTimeout(500);
  const cards = await page.locator('#ind-active-list .ind-card').count();
  console.log(`active cards: ${cards}`);
  if (cards !== 3) throw new Error(`expected 3 active cards, got ${cards}`);
  await page.screenshot({ path: 'tooling/shots/studies-dialog.png' });
  await page.click('#ind-dialog button[value="close"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tooling/shots/studies-1920.png' });
  // Transform replaces the candle source.
  await page.click('#ind-btn');
  await page.waitForSelector('#ind-dialog button[data-add]');
  const heiki = await page.locator('#ind-dialog button[data-add="heikinashi"]').count();
  if (heiki) await page.click('#ind-dialog button[data-add="heikinashi"]');
  else {
    const t = await page.locator('#ind-dialog input[data-transform-active]').count();
    if (!t) throw new Error('no transform control found');
    await page.check('#ind-dialog input[data-transform-active]');
  }
  await page.waitForTimeout(500);
  await page.click('#ind-dialog button[value="close"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tooling/shots/studies-transform.png' });
  if (errors.length) { console.error('PAGE ERRORS', errors); process.exit(1); }
  console.log('verify_studies ok, no page errors');
} finally {
  await browser.close();
}
