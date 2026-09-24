import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const unicodeText = '  नमस्ते दुनिया 🌿 — café\nhttps://example.com/?a=1&b=two  ';
const barcodeText = 'PRODUCT-0042 / 19.95';
const runtimeErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), 'uncaught application errors').toEqual([]);
});

async function showMoreOptions(page: Page) {
  const toggle = page.getByRole('button', { name: 'More options', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function downloadedPng(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
  const download = await pending;
  return {
    name: download.suggestedFilename(),
    mimeType: 'image/png',
    buffer: await readFile((await download.path())!),
  };
}

async function createCode(page: Page, text: string, type: 'qr' | 'barcode') {
  await page
    .getByRole('button', { name: type === 'qr' ? 'QR code' : 'Barcode', exact: true })
    .click();
  await page.getByLabel('Your content', { exact: true }).fill(text);
  await page
    .getByRole('button', {
      name: type === 'qr' ? 'Generate QR code' : 'Generate barcode',
      exact: true,
    })
    .click();
  await expect(page.locator('.content-copy p')).toHaveText(text);
  return downloadedPng(page);
}

async function inFreshContext(browser: Browser, url: string, check: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const sharedPage = await context.newPage();
    await sharedPage.goto(url);
    await check(sharedPage);
  } finally {
    await context.close();
  }
}

test('shares and reloads an exact Unicode QR with custom settings', async ({ page, browser }) => {
  await page.goto('/single');
  await page.getByLabel('Export size', { exact: true }).selectOption('1024');
  await showMoreOptions(page);
  await page.getByLabel('Error correction', { exact: true }).selectOption('H');
  await page.getByLabel('Your content', { exact: true }).fill(unicodeText);
  const draftUrl = page.url();
  await page.getByRole('button', { name: 'Generate QR code', exact: true }).click();
  await expect(page.locator('.content-copy p')).toHaveText(unicodeText);
  await expect.poll(() => page.url()).not.toBe(draftUrl);
  const source = await page
    .getByRole('img', { name: 'Generated QR code', exact: true })
    .getAttribute('src');
  const sharedUrl = page.url();
  expect(new URL(sharedUrl).pathname).toBe('/single');

  const assertRestored = async (target: Page) => {
    await expect(target.getByLabel('Your content', { exact: true })).toHaveValue(unicodeText);
    await expect(target.getByLabel('Export size', { exact: true })).toHaveValue('1024');
    await showMoreOptions(target);
    await expect(target.getByLabel('Error correction', { exact: true })).toHaveValue('H');
    await expect(
      target.getByRole('img', { name: 'Generated QR code', exact: true }),
    ).toHaveAttribute('src', source!);
  };
  await page.reload();
  await assertRestored(page);
  await inFreshContext(browser, sharedUrl, assertRestored);
});

test('preserves a barcode snapshot separately from ungenerated QR edits', async ({
  page,
  browser,
}) => {
  await page.goto('/single');
  await page.getByRole('button', { name: 'Barcode', exact: true }).click();
  await page.getByLabel('Export size', { exact: true }).selectOption('256');
  await showMoreOptions(page);
  await page.getByLabel('Show text below the barcode', { exact: true }).uncheck();
  await createCode(page, barcodeText, 'barcode');
  const source = await page
    .getByRole('img', { name: 'Generated barcode', exact: true })
    .getAttribute('src');
  const barcodeUrl = page.url();
  await inFreshContext(browser, barcodeUrl, async (sharedPage) => {
    await expect(sharedPage.getByLabel('Your content', { exact: true })).toHaveValue(barcodeText);
    await expect(sharedPage.getByRole('button', { name: 'Barcode', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(sharedPage.getByLabel('Export size', { exact: true })).toHaveValue('256');
    await showMoreOptions(sharedPage);
    await expect(
      sharedPage.getByLabel('Show text below the barcode', { exact: true }),
    ).not.toBeChecked();
    await expect(
      sharedPage.getByRole('img', { name: 'Generated barcode', exact: true }),
    ).toHaveAttribute('src', source!);
  });

  await page.getByRole('button', { name: 'QR code', exact: true }).click();
  await page.getByLabel('Your content', { exact: true }).fill('An ungenerated draft 🌿');
  await page.getByLabel('Export size', { exact: true }).selectOption('1024');
  await page.reload();
  await expect(page.getByLabel('Your content', { exact: true })).toHaveValue(
    'An ungenerated draft 🌿',
  );
  await expect(page.getByRole('button', { name: 'QR code', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Export size', { exact: true })).toHaveValue('1024');
  await expect(page.getByRole('img', { name: 'Generated barcode', exact: true })).toHaveAttribute(
    'src',
    source!,
  );
  await expect(page.locator('.content-copy p')).toHaveText(barcodeText);
  await page.getByRole('button', { name: 'Generate QR code', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Generated QR code', exact: true })).toBeVisible();
  await expect(page.locator('.content-copy p')).toHaveText('An ungenerated draft 🌿');
});

test('restores a batch collection and browser Back/Forward workspace state', async ({
  page,
  browser,
}) => {
  const list = JSON.stringify(['FIRST-001', 'नमस्ते 🌿', 42]);
  await page.goto('/single');
  await createCode(page, 'Saved single workspace', 'qr');
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Batch studio', exact: true })
    .click();
  await page.getByLabel('Your list', { exact: true }).fill(list);
  await page.getByLabel('Export size', { exact: true }).selectOption('256');
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.locator('.batch-item p')).toHaveText(['FIRST-001', 'नमस्ते 🌿', '42']);
  const sources = await page
    .locator('.batch-item img')
    .evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  const batchUrl = page.url();
  await inFreshContext(browser, batchUrl, async (sharedPage) => {
    await expect(sharedPage.getByLabel('Your list', { exact: true })).toHaveValue(list);
    await expect(sharedPage.getByLabel('Export size', { exact: true })).toHaveValue('256');
    await expect(sharedPage.locator('.batch-item p')).toHaveText(['FIRST-001', 'नमस्ते 🌿', '42']);
    expect(
      await sharedPage
        .locator('.batch-item img')
        .evaluateAll((images) => images.map((image) => image.getAttribute('src'))),
    ).toEqual(sources);
  });

  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Scan codes', exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/scan');
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Single code', exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/single');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/scan');
  await expect(page.getByLabel('Upload code image', { exact: true })).toBeAttached();
  await page.goBack();
  await expect(page.getByLabel('Your list', { exact: true })).toHaveValue(list);
  await expect(page.locator('.batch-item p')).toHaveText(['FIRST-001', 'नमस्ते 🌿', '42']);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/scan');
  await page.goBack();
  await expect(page.getByLabel('Your list', { exact: true })).toHaveValue(list);
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Single code', exact: true })
    .click();
  await expect(page.getByLabel('Your content', { exact: true })).toHaveValue(
    'Saved single workspace',
  );
  await expect(page.locator('.content-copy p')).toHaveText('Saved single workspace');
});

test('shares and reloads a large collection without exceeding request header limits', async ({
  page,
  browser,
}) => {
  const values = Array.from(
    { length: 100 },
    (_, index) => `ITEM-${String(index + 1).padStart(3, '0')}-${'Q'.repeat(191)}`,
  );
  await page.goto('/batch');
  await page.getByLabel('Your list', { exact: true }).fill(JSON.stringify(values));
  await page.getByRole('button', { name: 'Generate collection', exact: true }).click();
  await expect(page.locator('.batch-item p')).toHaveText(values);
  await expect.poll(() => new URL(page.url()).hash.length).toBeGreaterThan(6_000);
  const sharedUrl = page.url();
  expect(new URL(sharedUrl).search.length).toBeLessThan(6_000);
  await page.reload();
  await expect(page.locator('.batch-item p')).toHaveText(values);
  await inFreshContext(browser, sharedUrl, async (sharedPage) => {
    await expect(sharedPage.getByLabel('Your list', { exact: true })).toHaveValue(
      JSON.stringify(values),
    );
    await expect(sharedPage.locator('.batch-item p')).toHaveText(values);
  });
});

test('restores the last live code and configuration without restarting its timer', async ({
  page,
  browser,
}) => {
  await page.goto('/live');
  await page.getByRole('button', { name: 'Barcode', exact: true }).click();
  await page.getByLabel('Generate every', { exact: true }).fill('2');
  await page.getByLabel('Random text length', { exact: true }).fill('8');
  await page.getByLabel('Characters to use', { exact: true }).selectOption('numeric');
  await page.getByLabel('Prefix optional', { exact: true }).fill('SCAN-');
  const clockTime = new Date('2026-09-24T12:00:00Z');
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(page.locator('.content-copy p')).toHaveText(/^SCAN-\d{8}$/);
  const value = await page.locator('.content-copy p').innerText();
  const source = await page
    .getByRole('img', { name: 'Generated barcode', exact: true })
    .getAttribute('src');
  const sharedUrl = page.url();
  const assertRestored = async (target: Page) => {
    await expect(target.getByLabel('Generate every', { exact: true })).toHaveValue('2');
    await expect(target.getByLabel('Random text length', { exact: true })).toHaveValue('8');
    await expect(target.getByLabel('Characters to use', { exact: true })).toHaveValue('numeric');
    await expect(target.getByLabel('Prefix optional', { exact: true })).toHaveValue('SCAN-');
    await expect(
      target.getByRole('button', { name: 'Start generating', exact: true }),
    ).toBeVisible();
    await expect(target.getByRole('button', { name: 'Pause generation', exact: true })).toHaveCount(
      0,
    );
    await expect(target.locator('.content-copy p')).toHaveText(value);
    await expect(
      target.getByRole('img', { name: 'Generated barcode', exact: true }),
    ).toHaveAttribute('src', source!);
  };
  await page.reload();
  await assertRestored(page);
  await page.clock.runFor(5_000);
  await expect(page.locator('.content-copy p')).toHaveText(value);
  await inFreshContext(browser, sharedUrl, assertRestored);
});

test('scans uploaded QR and barcode images, shares results, and reuses decoded text', async ({
  page,
  browser,
  context,
}, testInfo) => {
  await page.goto('/single');
  const qrPng = await createCode(page, unicodeText, 'qr');
  const barcodePng = await createCode(page, barcodeText, 'barcode');
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Scan codes', exact: true })
    .click();
  await page.getByLabel('Upload code image', { exact: true }).setInputFiles(qrPng);
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.locator('.scanner-result-format strong')).toHaveText('QR CODE');

  const notification = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await notification.isVisible()) await notification.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('scanner-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, 'scanner horizontal overflow on mobile').toBeLessThanOrEqual(
    dimensions.viewport,
  );
  await page.screenshot({
    path: testInfo.outputPath('scanner-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy workspace link', exact: true }).click();
  const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(sharedUrl).toBe(page.url());
  await inFreshContext(browser, sharedUrl, async (sharedPage) => {
    await expect(sharedPage.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);
    await expect(sharedPage.locator('.scanner-result-format strong')).toHaveText('QR CODE');
    await expect(
      sharedPage.getByRole('button', { name: 'Start camera', exact: true }),
    ).toBeVisible();
  });
  await page.reload();
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);
  await page.getByRole('button', { name: 'Use in generator', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/single');
  await expect(page.getByLabel('Your content', { exact: true })).toHaveValue(unicodeText);
  await expect(page.locator('.content-copy p')).toHaveText(unicodeText);
  await expect(page.getByRole('img', { name: 'Generated QR code', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);

  await page.getByLabel('Upload code image', { exact: true }).setInputFiles(barcodePng);
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(barcodeText);
  await expect(page.locator('.scanner-result-format strong')).toHaveText('CODE 128');

  const blankPng = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 200, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Upload code image', { exact: true }).setInputFiles({
    name: 'blank-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from(blankPng, 'base64'),
  });
  await expect(page.getByRole('alert')).toContainText(/code/i);
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveCount(0);
  await page.getByLabel('Upload code image', { exact: true }).setInputFiles(qrPng);
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);
  await page.getByRole('button', { name: 'Clear result', exact: true }).click();
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveCount(0);
});

type MockCamera = {
  requests: number;
  streams: MediaStream[];
  imageSource: string;
};

// A synthetic canvas stream exercises the real video/canvas decoder and cleanup.
// It never accesses a physical camera or displays a browser permission prompt.
async function mockCamera(page: Page, imageSource = '') {
  await page.evaluate((initialImage) => {
    const state: MockCamera = { requests: 0, streams: [], imageSource: initialImage };
    (window as typeof window & { mockCamera: MockCamera }).mockCamera = state;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        state.requests += 1;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 640;
        const ctx = canvas.getContext('2d')!;
        const image = new Image();
        if (state.imageSource) {
          image.src = state.imageSource;
          await image.decode();
        }
        const draw = () => {
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, 640, 640);
          if (image.src) ctx.drawImage(image, 64, 64, 512, 512);
        };
        draw();
        const stream = canvas.captureStream(10);
        const timer = window.setInterval(draw, 100);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            window.clearInterval(timer);
            stop();
          };
        }
        state.streams.push(stream);
        return stream;
      },
    });
  }, imageSource);
}

async function cameraTrackStates(page: Page) {
  return page.evaluate(() =>
    (window as typeof window & { mockCamera: MockCamera }).mockCamera.streams.flatMap((stream) =>
      stream.getTracks().map((track) => track.readyState),
    ),
  );
}

test('decodes a simulated camera frame and stops tracks on success, stop, and navigation', async ({
  page,
}) => {
  await page.goto('/single');
  const png = await createCode(page, unicodeText, 'qr');
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Scan codes', exact: true })
    .click();
  await mockCamera(page, `data:image/png;base64,${png.buffer.toString('base64')}`);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByLabel('Decoded text', { exact: true })).toHaveValue(unicodeText);
  await expect.poll(() => cameraTrackStates(page)).toEqual(['ended']);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear result', exact: true }).click();

  await mockCamera(page);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect.poll(() => cameraTrackStates(page)).toEqual(['live']);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await expect.poll(() => cameraTrackStates(page)).toEqual(['ended']);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect.poll(() => cameraTrackStates(page)).toEqual(['ended', 'live']);
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Batch studio', exact: true })
    .click();
  await expect.poll(() => cameraTrackStates(page)).toEqual(['ended', 'ended']);
});

test('handles denied camera permission without requesting a physical device', async ({ page }) => {
  await page.goto('/scan');
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('Permission denied in test', 'NotAllowedError');
      },
    });
  });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/permission|denied|allow/i);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toHaveCount(0);
});
