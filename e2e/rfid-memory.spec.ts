import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Write = { transport: 'serial' | 'hid'; bytes: number[]; reportId?: number };
type MemoryHardware = {
  writes: Write[];
  requests: number;
  closes: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  serial: EventTarget;
  port: object;
  hid: EventTarget;
  device: EventTarget;
};

test.use({ reducedMotion: 'reduce' });
const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const captured: string[] = [];
  errors.set(page, captured);
  page.on('pageerror', (error) => captured.push(error.message));
  // Synthetic protocol and devices only. No device chooser or physical reader is used.
  await page.addInitScript(() => {
    const hardware = {
      writes: [] as Write[],
      requests: 0,
      closes: 0,
      controller: null as ReadableStreamDefaultController<Uint8Array> | null,
    };
    const serial = new EventTarget();
    const port = {
      readable: null as ReadableStream<Uint8Array> | null,
      writable: null as WritableStream<Uint8Array> | null,
      getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678 }),
      async open() {
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            hardware.controller = controller;
          },
          cancel() {
            hardware.controller = null;
          },
        });
        this.writable = new WritableStream<Uint8Array>({
          write(bytes) {
            hardware.writes.push({ transport: 'serial', bytes: Array.from(bytes) });
          },
        });
      },
      async close() {
        if (this.readable?.locked || this.writable?.locked)
          throw new Error('Serial stream lock leaked.');
        hardware.closes += 1;
      },
    };
    Object.assign(serial, {
      async requestPort() {
        hardware.requests += 1;
        return port;
      },
      async getPorts() {
        return [];
      },
    });
    const hid = new EventTarget();
    const device = Object.assign(new EventTarget(), {
      opened: false,
      productName: 'Synthetic tag memory reader',
      vendorId: 0x1234,
      productId: 0x5678,
      collections: [
        {
          usagePage: 0xff00,
          usage: 1,
          inputReports: [{ reportId: 1 }, { reportId: 3 }],
          outputReports: [{ reportId: 2 }],
          children: [],
        },
      ],
      async open() {
        this.opened = true;
      },
      async close() {
        this.opened = false;
        hardware.closes += 1;
      },
      async sendReport(reportId: number, bytes: Uint8Array) {
        hardware.writes.push({ transport: 'hid', reportId, bytes: Array.from(bytes) });
      },
    });
    Object.assign(hid, {
      async requestDevice() {
        hardware.requests += 1;
        return [device];
      },
      async getDevices() {
        return [];
      },
    });
    Object.defineProperty(navigator, 'serial', { configurable: true, value: serial });
    Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
    (window as typeof window & { memoryHardware: MemoryHardware }).memoryHardware = Object.assign(
      hardware,
      { serial, port, hid, device },
    );
  });
  await page.goto('/rfid');
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'uncaught browser errors').toEqual([]);
});

async function writes(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { memoryHardware: MemoryHardware }).memoryHardware.writes,
  );
}

async function receive(page: Page, bytes: number[], reportId?: number) {
  await page.evaluate(
    ({ payload, id }) => {
      const hardware = (window as typeof window & { memoryHardware: MemoryHardware })
        .memoryHardware;
      if (id === undefined) hardware.controller!.enqueue(new Uint8Array(payload));
      else {
        const bytes = new Uint8Array(payload);
        hardware.device.dispatchEvent(
          Object.assign(new Event('inputreport'), {
            device: hardware.device,
            reportId: id,
            data: new DataView(bytes.buffer),
          }),
        );
      }
    },
    { payload: bytes, id: reportId },
  );
}

async function connect(page: Page, transport: 'serial' | 'hid' = 'serial') {
  await page
    .getByRole('button', { name: transport === 'serial' ? 'USB serial' : 'USB HID', exact: true })
    .click();
  if (transport === 'hid')
    await page.getByLabel('Reader mode', { exact: true }).selectOption('raw');
  await page
    .getByRole('button', {
      name: transport === 'serial' ? 'Connect serial reader' : 'Connect HID reader',
      exact: true,
    })
    .click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
}

async function configure(page: Page, transport: 'serial' | 'hid' = 'serial') {
  const read = page.getByRole('textbox', { name: 'Read command (hex)', exact: true });
  if (!(await read.isVisible())) await page.getByText('Protocol settings', { exact: true }).click();
  await read.fill('AA 01');
  await page
    .getByRole('textbox', { name: 'Write command template (hex)', exact: true })
    .fill('AA 02 {value}');
  await page
    .getByRole('textbox', { name: 'Read response prefix (hex)', exact: true })
    .fill('BB 01');
  await page.getByRole('spinbutton', { name: 'Value length (bytes)', exact: true }).fill('4');
  await page
    .getByRole('textbox', { name: 'Write acknowledgment (hex)', exact: true })
    .fill('BB 02');
  await page.getByRole('spinbutton', { name: 'Response timeout (ms)', exact: true }).fill('2000');
  if (transport === 'hid') {
    await page.getByRole('spinbutton', { name: 'Input report ID', exact: true }).fill('1');
    await page.getByRole('spinbutton', { name: 'Memory output report ID', exact: true }).fill('2');
  }
}

async function writeValue(page: Page, text: string, format: 'text' | 'hex' = 'text') {
  await page.getByRole('combobox', { name: 'Value format', exact: true }).selectOption(format);
  await page.getByRole('textbox', { name: 'Value to write', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Write and verify', exact: true }).click();
}

test('shows the last keyboard capture without offering unsupported tag-memory writes', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: 'Tag memory', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await page.getByLabel('Reader input', { exact: true }).fill('LAST-TAG-42');
  await page.getByLabel('Reader input', { exact: true }).press('Enter');
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('LAST-TAG-42');
  await expect(page.getByRole('button', { name: 'Read value', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write and verify', exact: true })).toHaveCount(0);
  expect(await writes(page)).toEqual([]);
});

test('reads split serial responses and verifies an explicitly written binary value', async ({
  page,
}, testInfo) => {
  await connect(page);
  await configure(page);
  expect(await writes(page)).toEqual([]);
  await page.getByRole('button', { name: 'Read value', exact: true }).click();
  await expect.poll(() => writes(page)).toEqual([{ transport: 'serial', bytes: [0xaa, 1] }]);
  await expect(page.getByRole('button', { name: 'Send command', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('textbox', { name: 'Read command (hex)', exact: true }),
  ).toBeDisabled();
  await receive(page, [0xbb]);
  await receive(page, [1, 65]);
  await receive(page, [66, 67, 68]);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('ABCD');
  await expect(page.getByTestId('rfid-memory-hex')).toHaveText('41 42 43 44');

  await writeValue(page, '00 7F A5 FF', 'hex');
  await expect
    .poll(async () => (await writes(page)).map((write) => write.bytes))
    .toEqual([
      [0xaa, 1],
      [0xaa, 2, 0, 0x7f, 0xa5, 0xff],
    ]);
  await receive(page, [0xbb]);
  await receive(page, [2]);
  await expect
    .poll(async () => (await writes(page)).map((write) => write.bytes))
    .toEqual([
      [0xaa, 1],
      [0xaa, 2, 0, 0x7f, 0xa5, 0xff],
      [0xaa, 1],
    ]);
  await receive(page, [0xbb, 1, 0, 0x7f]);
  await receive(page, [0xa5, 0xff]);
  await expect(page.getByText('Read-back matches', { exact: true })).toBeVisible();
  await expect(page.getByTestId('rfid-memory-hex')).toHaveText('00 7F A5 FF');
  await expect(page.getByRole('button', { name: 'Send command', exact: true })).toBeEnabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('memory-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({
    path: testInfo.outputPath('memory-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('reports mismatched read-back and timed-out writes as unverified', async ({ page }) => {
  await connect(page);
  await configure(page);
  await writeValue(page, 'GOOD');
  await expect.poll(async () => (await writes(page)).length).toBe(1);
  await receive(page, [0xbb, 2]);
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  await receive(page, [0xbb, 1, ...Array.from(Buffer.from('DIFF'))]);
  await expect(page.getByRole('alert')).toContainText(/match|mismatch/i);
  await expect(page.getByRole('alert')).toContainText(/unverified/i);
  await expect(page.getByText('Read-back matches', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('DIFF');

  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Response timeout (ms)', exact: true }).fill('500');
  await writeValue(page, 'GOOD');
  await expect.poll(async () => (await writes(page)).length).toBe(3);
  await expect(page.getByRole('alert')).toContainText(/timed out|timeout/i);
  await expect(page.getByRole('alert')).toContainText(/unverified/i);
  await expect(page.getByText('Read-back matches', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  expect(await writes(page)).toHaveLength(3);
});

for (const stop of ['cancel', 'unplug', 'navigate'] as const) {
  test(`does not continue a write after ${stop}`, async ({ page }) => {
    const transport = stop === 'cancel' ? 'hid' : 'serial';
    await connect(page, transport);
    await configure(page, transport);
    const clockTime = new Date('2026-09-25T12:00:00Z');
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await writeValue(page, 'STOP');
    await expect.poll(async () => (await writes(page)).length).toBe(1);
    if (stop === 'cancel') {
      await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      await receive(page, [0xbb, 2, 0xbb, 1, 83, 84, 79, 80], 1);
      await expect(
        page.getByRole('button', { name: 'Connect HID reader', exact: true }),
      ).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Read value', exact: true })).toBeDisabled();
    } else if (stop === 'unplug') {
      await page.evaluate(() => {
        const hardware = (window as typeof window & { memoryHardware: MemoryHardware })
          .memoryHardware;
        hardware.serial.dispatchEvent(
          Object.assign(new Event('disconnect'), { port: hardware.port }),
        );
      });
      await expect(
        page.getByRole('button', { name: 'Connect serial reader', exact: true }),
      ).toBeEnabled();
    } else {
      await page
        .getByRole('navigation', { name: 'Workspaces' })
        .getByRole('button', { name: 'Single code', exact: true })
        .click();
      await expect(page.getByLabel('Your content', { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Cancel operation', exact: true })).toHaveCount(
      0,
    );
    await page.clock.runFor(1_000);
    expect(await writes(page)).toEqual([
      {
        transport,
        ...(transport === 'hid' ? { reportId: 2 } : {}),
        bytes: [0xaa, 2, 83, 84, 79, 80],
      },
    ]);
    await expect(page.getByText('Read-back matches', { exact: true })).toHaveCount(0);
  });
}

test('uses the configured HID report IDs for memory reads and verification', async ({ page }) => {
  await connect(page, 'hid');
  await configure(page, 'hid');
  await page.getByRole('button', { name: 'Read value', exact: true }).click();
  await expect
    .poll(() => writes(page))
    .toEqual([{ transport: 'hid', reportId: 2, bytes: [0xaa, 1] }]);
  await receive(page, [0xbb, 1, 69, 86, 73, 76], 3);
  expect(await page.getByTestId('rfid-memory-value').allTextContents()).not.toContain('EVIL');
  await receive(page, [0xbb, 1, 65, 66, 67, 68], 1);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('ABCD');
  await writeValue(page, 'WXYZ');
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  await receive(page, [0xbb, 2], 3);
  expect(await writes(page)).toHaveLength(2);
  await receive(page, [0xbb, 2], 1);
  await expect.poll(async () => (await writes(page)).length).toBe(3);
  await receive(page, [0xbb, 1, 87, 88, 89, 90], 1);
  await expect(page.getByText('Read-back matches', { exact: true })).toBeVisible();
  expect(await writes(page)).toEqual([
    { transport: 'hid', reportId: 2, bytes: [0xaa, 1] },
    { transport: 'hid', reportId: 2, bytes: [0xaa, 2, 87, 88, 89, 90] },
    { transport: 'hid', reportId: 2, bytes: [0xaa, 1] },
  ]);
});

test('defaults HID memory reads to a declared input report and permits an explicit override', async ({
  page,
}) => {
  await connect(page, 'hid');
  const inputReport = page.getByRole('spinbutton', { name: 'Input report ID', exact: true });
  await expect(inputReport).toHaveValue('1');
  await expect(
    page.getByRole('spinbutton', { name: 'Memory output report ID', exact: true }),
  ).toHaveValue('2');
  // Configure the protocol without calling the HID helper that overrides report IDs.
  await configure(page);
  await page.getByRole('button', { name: 'Read value', exact: true }).click();
  await expect
    .poll(() => writes(page))
    .toEqual([{ transport: 'hid', reportId: 2, bytes: [0xaa, 1] }]);
  await receive(page, [0xbb, 1, 65, 66, 67, 68], 1);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('ABCD');
  await expect(page.getByTestId('rfid-last-input')).toContainText('BB 01 41 42 43 44');

  await inputReport.fill('3');
  await page.getByRole('button', { name: 'Read value', exact: true }).click();
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  await receive(page, [0xbb, 1, 87, 88, 89, 90], 3);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('WXYZ');
  await expect(inputReport).toHaveValue('3');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rejects incomplete profiles and wrong value lengths and keeps memory state out of URLs', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: 'Read value', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await writes(page)).toEqual([]);
  await configure(page);
  await page
    .getByRole('textbox', { name: 'Write command template (hex)', exact: true })
    .fill('AA 02');
  await writeValue(page, 'ABCD');
  await expect(page.getByRole('alert')).toContainText(/\{value\}|template/i);
  expect(await writes(page)).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Write command template (hex)', exact: true })
    .fill('AA 02 {value}');
  await writeValue(page, '€€'); // Two characters, but six UTF-8 bytes: four bytes are required.
  await expect(page.getByRole('alert')).toContainText(/4|length|bytes/i);
  expect(await writes(page)).toEqual([]);

  await page.getByRole('textbox', { name: 'Value to write', exact: true }).fill('PRIVATE-VALUE');
  const sharedUrl = page.url();
  expect(decodeURIComponent(sharedUrl)).not.toMatch(/PRIVATE|AA 01|AA 02|BB 01|BB 02/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Read command (hex)', exact: true })).toHaveValue(
    '',
  );
  await expect(
    page.getByRole('textbox', { name: 'Write command template (hex)', exact: true }),
  ).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Value to write', exact: true })).toHaveValue('');
  expect(await writes(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as typeof window & { memoryHardware: MemoryHardware }).memoryHardware.requests,
    ),
  ).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
});
