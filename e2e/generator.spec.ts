import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';

const runtimeErrors = new WeakMap<Page, string[]>();

// Decode what the browser actually renders/downloads with an independent scanner.
async function decodeImage(page: Page, dataUrl: string, format: BarcodeFormat): Promise<string> {
  const pixels = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const luminance = Array.from({ length: canvas.width * canvas.height }, (_, index) => {
      const offset = index * 4;
      return Math.round((data[offset] + data[offset + 1] * 2 + data[offset + 2]) / 4);
    });
    return { width: canvas.width, height: canvas.height, luminance };
  }, dataUrl);
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [format]],
    [DecodeHintType.CHARACTER_SET, 'UTF-8'],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  return reader
    .decode(
      new BinaryBitmap(
        new HybridBinarizer(
          new RGBLuminanceSource(
            Uint8ClampedArray.from(pixels.luminance),
            pixels.width,
            pixels.height,
          ),
        ),
      ),
      hints,
    )
    .getText();
}

async function downloadFile(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  return { filename: download.suggestedFilename(), bytes: await readFile(filePath!) };
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'A little code. A lot of possibility.' }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: 'Generated QR code', exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), 'uncaught application errors').toEqual([]);
});

test('creates a Unicode QR and downloads a scannable PNG and SVG', async ({ page }, testInfo) => {
  const content = 'Hello दुनिया 🌿 — https://example.com/qr?item=42';
  await page.getByLabel('Your content', { exact: true }).fill(content);
  await page.getByLabel('Export size', { exact: true }).selectOption('1024');
  await page.getByRole('button', { name: 'Generate QR code', exact: true }).click();
  await expect(page.locator('.content-copy p')).toHaveText(content);

  const svg = await downloadFile(page, 'SVG');
  expect(svg.filename).toMatch(/^qr-.*\.svg$/);
  expect(svg.bytes.toString()).toContain('<svg');
  expect(
    await decodeImage(
      page,
      `data:image/svg+xml;base64,${svg.bytes.toString('base64')}`,
      BarcodeFormat.QR_CODE,
    ),
  ).toBe(content);

  const png = await downloadFile(page, 'Download PNG');
  expect(png.filename).toMatch(/^qr-.*\.png$/);
  expect(png.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.bytes.readUInt32BE(16)).toBe(1024);
  expect(png.bytes.readUInt32BE(20)).toBe(1024);
  expect(
    await decodeImage(
      page,
      `data:image/png;base64,${png.bytes.toString('base64')}`,
      BarcodeFormat.QR_CODE,
    ),
  ).toBe(content);

  await page.getByLabel('Export size', { exact: true }).selectOption('256');
  await page.getByLabel('Your content', { exact: true }).fill('A second, smaller code');
  await page.getByRole('button', { name: 'Generate QR code', exact: true }).click();
  await expect(page.locator('.content-copy p')).toHaveText('A second, smaller code');
  await page.locator('.recent-card').filter({ hasText: content }).click();
  await expect(page.getByLabel('Your content', { exact: true })).toHaveValue(content);
  await expect(page.getByLabel('Export size', { exact: true })).toHaveValue('1024');
  const restored = await downloadFile(page, 'Download PNG');
  expect(restored.bytes.readUInt32BE(16)).toBe(1024);
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('desktop-qr.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('creates a scannable Code 128 barcode and handles invalid text', async ({ page }) => {
  const content = 'PRODUCT-0042 / 19.95';
  await page.getByRole('button', { name: 'Barcode', exact: true }).click();
  await page.getByLabel('Your content', { exact: true }).fill(content);
  await page.getByRole('button', { name: 'Generate barcode', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Generated barcode', exact: true })).toBeVisible();
  const svg = await downloadFile(page, 'SVG');
  expect(svg.filename).toMatch(/^barcode-.*\.svg$/);
  expect(
    await decodeImage(
      page,
      `data:image/svg+xml;base64,${svg.bytes.toString('base64')}`,
      BarcodeFormat.CODE_128,
    ),
  ).toBe(content);
  const png = await downloadFile(page, 'Download PNG');
  expect(png.filename).toMatch(/^barcode-.*\.png$/);
  expect(
    await decodeImage(
      page,
      `data:image/png;base64,${png.bytes.toString('base64')}`,
      BarcodeFormat.CODE_128,
    ),
  ).toBe(content);

  await page.getByLabel('Your content', { exact: true }).fill('नमस्ते');
  await page.getByRole('button', { name: 'Generate barcode', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use a QR code');
  await expect(page.locator('.content-copy p')).toHaveText(content);
  await page.getByLabel('Your content', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Generate barcode', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter some text');
});

test('builds JSON and newline collections, exports PDF, and prepares a print sheet', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'Batch studio', exact: true }).click();
  const qrValues = ['Hello', 'नमस्ते 🌿', 42, 'LABEL-004', 'LABEL-005', 'LABEL-006', 'LABEL-007'];
  await page.getByLabel('Your list', { exact: true }).fill(JSON.stringify(qrValues));
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.locator('.batch-item')).toHaveCount(7);
  await expect(page.locator('.batch-item p')).toHaveText(qrValues.map(String));
  const pdf = await downloadFile(page, 'Download PDF');
  expect(pdf.filename).toMatch(/\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.bytes.toString('latin1')).toContain('%%EOF');
  expect(pdf.bytes.length).toBeGreaterThan(5_000);
  expect(pdf.bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
  await writeFile(testInfo.outputPath('collection.pdf'), pdf.bytes);

  await page.getByLabel('Your list', { exact: true }).fill('["broken",]');
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('JSON array is not valid');
  await expect(page.locator('.batch-item')).toHaveCount(7);

  await page.getByRole('button', { name: 'Barcode', exact: true }).click();
  await page
    .getByLabel('Your list', { exact: true })
    .fill('ITEM-001\n\nITEM-002\nITEM-003\nITEM-004\nITEM-005');
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.locator('.batch-item p')).toHaveText([
    'ITEM-001',
    'ITEM-002',
    'ITEM-003',
    'ITEM-004',
    'ITEM-005',
  ]);
  const barcodePdf = await downloadFile(page, 'Download PDF');
  expect(barcodePdf.bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
  await writeFile(testInfo.outputPath('barcodes.pdf'), barcodePdf.bytes);
  const itemDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download item 2 as SVG', exact: true }).click();
  const item = await itemDownload;
  const itemSvg = await readFile((await item.path())!);
  expect(
    await decodeImage(
      page,
      `data:image/svg+xml;base64,${itemSvg.toString('base64')}`,
      BarcodeFormat.CODE_128,
    ),
  ).toBe('ITEM-002');

  let printCalls = 0;
  await page.exposeFunction('recordPrint', () => {
    printCalls += 1;
  });
  await page.evaluate(() => {
    window.print = () => {
      void (window as unknown as { recordPrint(): Promise<void> }).recordPrint();
    };
  });
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  await expect.poll(() => printCalls).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('region', { name: 'Printable code collection' })).toBeVisible();
  await expect(page.locator('.print-code')).toHaveCount(5);
  await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeHidden();
  await expect(page.locator('.main-shell')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('print-barcodes.png'), fullPage: true });
});

test('honors live intervals, pause, and navigation cancellation', async ({ page }) => {
  await page.getByRole('button', { name: 'Live generator AUTO', exact: true }).click();
  await page.getByLabel('Generate every', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('interval between 0.5');
  await page.getByLabel('Generate every', { exact: true }).fill('0.5');
  await page.getByLabel('Random text length', { exact: true }).fill('6');
  await page.getByLabel('Characters to use', { exact: true }).selectOption('numeric');
  await page.getByLabel('Prefix optional', { exact: true }).fill('ITEM-');
  await page.getByRole('button', { name: 'Barcode', exact: true }).click();
  const clockTime = new Date('2026-01-01T12:00:00Z');
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(page.locator('.content-copy p')).toHaveText(/^ITEM-\d{6}$/);
  await expect(page.getByLabel('Generate every', { exact: true })).toBeDisabled();
  const first = await page.locator('.content-copy p').innerText();
  await page.clock.runFor(300);
  await expect(page.locator('.content-copy p')).toHaveText(first);
  await page.clock.runFor(250);
  await expect(page.locator('.content-copy p')).not.toHaveText(first);
  await page.getByRole('button', { name: 'Pause generation', exact: true }).click();
  const paused = await page.locator('.content-copy p').innerText();
  await page.clock.runFor(2_000);
  await expect(page.locator('.content-copy p')).toHaveText(paused);
  await expect(page.getByLabel('Generate every', { exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause generation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Single code', exact: true }).click();
  await page.clock.runFor(2_000);
  await page.getByRole('button', { name: 'Live generator AUTO', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start generating', exact: true })).toBeVisible();
  await expect(page.getByText('Generation paused', { exact: true })).toBeVisible();
  const stopped = await page.locator('.content-copy p').innerText();
  await page.clock.runFor(2_000);
  await expect(page.locator('.content-copy p')).toHaveText(stopped);
});

test('remains usable without horizontal overflow on a narrow phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const workspace of ['Single code', 'Live generator', 'Batch studio']) {
    await page
      .getByRole('navigation', { name: 'Workspaces' })
      .getByRole('button', { name: workspace, exact: true })
      .click();
    await expect(page.locator('.editor-card')).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, `${workspace} horizontal overflow`).toBeLessThanOrEqual(
      dimensions.viewport,
    );
  }
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.locator('.batch-item')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('mobile-batch.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
