import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1040 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:5174');
await page.getByRole('img', { name: 'Generated QR code', exact: true }).waitFor();
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
console.log(
  JSON.stringify({
    errors,
    overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
  }),
);
await browser.close();
