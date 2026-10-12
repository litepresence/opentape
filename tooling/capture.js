import { chromium } from 'playwright';

export async function captureClone(url, outPath, viewport = { width: 1920, height: 1080 }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => page.goto(url, { timeout: 30000 }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: outPath, fullPage: false });
  await browser.close();
  return outPath;
}

// CLI: node tooling/capture.js <url> <out.png> [width] [height]
const [url, out, w, h] = process.argv.slice(2);
if (url && out) {
  await captureClone(url, out, { width: Number(w) || 1920, height: Number(h) || 1080 });
  console.log('saved', out);
}
