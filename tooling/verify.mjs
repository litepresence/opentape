import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('tooling/shots', { recursive: true });
// Evidence envelope (REA-inspired): every verification states its own
// coverage AND its limitations. --json prints the envelope for ledgers.
const asJson = process.argv.includes('--json');
const target = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || 'http://localhost:8787/';
const started = Date.now();
const browser = await chromium.launch();
const evidence = {
  tool: 'tooling/verify.mjs',
  target, viewport: { width: 1920, height: 1080 },
  checks: ['page loads without pageerror/console.error', '1920px screenshot captured'],
  limitations: [
    'Does not assert candle correctness — only absence of runtime errors.',
    'No pixel-diff vs reference (see tooling/pixel_diff.py for measurement).',
    'Single viewport (1920x1080); responsive breakpoints unverified.',
    'Requires live exchange data — a PASS with an error overlay would still be a pass.',
  ],
  confidence: 'observed',
};
try {
  const page = await browser.newPage({ viewport: evidence.viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(target, { waitUntil: 'networkidle' });
  // Wait for real bars (or the honest error state) before capturing.
  await page.waitForFunction(
    () => {
      const st = document.querySelector('#data-status');
      if (st && st.classList.contains('error')) return true;
      return /^O \d/.test(document.querySelector('#ohlc')?.textContent || '');
    },
    null,
    { timeout: 30000 },
  ).catch(() => {});
  await page.waitForTimeout(800);
  const status = await page.evaluate(() => document.querySelector('#data-status')?.className || 'ok');
  await page.screenshot({ path: 'tooling/shots/final-1920.png' });
  evidence.data_status = status;
  evidence.errors = errors;
  evidence.screenshot = 'tooling/shots/final-1920.png';
  evidence.duration_ms = Date.now() - started;
  if (errors.length) {
    evidence.verdict = 'FAIL';
    if (asJson) console.log(JSON.stringify(evidence, null, 1));
    else console.error('PAGE ERRORS', errors);
    process.exit(1);
  }
  evidence.verdict = 'PASS';
  if (asJson) console.log(JSON.stringify(evidence, null, 1));
  else console.log('verify ok, no page errors');
} finally {
  await browser.close();
}
