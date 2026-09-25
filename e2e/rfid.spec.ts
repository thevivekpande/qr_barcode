import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type HardwareOptions = {
  cancelHid?: boolean;
  cancelSerial?: boolean;
  unsupported?: boolean;
  deferHidWrites?: boolean;
};
type HardwareState = {
  hid: {
    requests: number;
    opens: number;
    closes: number;
    inputListeners: number;
    disconnectListeners: number;
    reports: { reportId: number; data: number[] }[];
    pendingWrites: (() => void)[];
    completedWrites: number;
    manager: EventTarget;
    device: EventTarget & { opened: boolean };
  };
  serial: {
    requests: number;
    opens: number;
    closes: number;
    readCancels: number;
    disconnectListeners: number;
    writes: number[][];
    openOptions: Record<string, unknown>[];
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    manager: EventTarget;
    port: EventTarget & {
      readable: ReadableStream<Uint8Array> | null;
      writable: WritableStream<Uint8Array> | null;
    };
  };
};

const runtimeErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), 'uncaught application errors').toEqual([]);
});

// Every hardware entry point is replaced before app code runs. These tests never
// open a native device chooser or access an attached RFID reader.
async function installHardware(page: Page, options: HardwareOptions = {}) {
  await page.addInitScript((behavior) => {
    const hid = {
      requests: 0,
      opens: 0,
      closes: 0,
      inputListeners: 0,
      disconnectListeners: 0,
      reports: [] as { reportId: number; data: number[] }[],
      pendingWrites: [] as (() => void)[],
      completedWrites: 0,
    };
    const serial = {
      requests: 0,
      opens: 0,
      closes: 0,
      readCancels: 0,
      disconnectListeners: 0,
      writes: [] as number[][],
      openOptions: [] as Record<string, unknown>[],
      controller: null as ReadableStreamDefaultController<Uint8Array> | null,
    };

    class TrackedEvents extends EventTarget {
      tracked = new Map<string, Set<EventListenerOrEventListenerObject>>();
      constructor(private update: (type: string, count: number) => void) {
        super();
      }
      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        opts?: boolean | AddEventListenerOptions,
      ) {
        if (listener) {
          const listeners = this.tracked.get(type) ?? new Set();
          listeners.add(listener);
          this.tracked.set(type, listeners);
          this.update(type, listeners.size);
        }
        super.addEventListener(type, listener, opts);
      }
      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        opts?: boolean | EventListenerOptions,
      ) {
        if (listener) this.tracked.get(type)?.delete(listener);
        this.update(type, this.tracked.get(type)?.size ?? 0);
        super.removeEventListener(type, listener, opts);
      }
    }

    class FakeHidDevice extends TrackedEvents {
      opened = false;
      productName = 'Mock RFID HID reader';
      vendorId = 0x1234;
      productId = 0x5678;
      collections = [
        {
          usagePage: 0xff00,
          usage: 1,
          inputReports: [{ reportId: 1 }],
          outputReports: [{ reportId: 2 }],
          featureReports: [],
          children: [],
        },
        {
          usagePage: 1,
          usage: 6,
          inputReports: [{ reportId: 9 }],
          outputReports: [],
          featureReports: [],
          children: [],
        },
      ];
      constructor() {
        super((type, count) => {
          if (type === 'inputreport') hid.inputListeners = count;
        });
      }
      async open() {
        hid.opens += 1;
        this.opened = true;
      }
      async close() {
        hid.closes += 1;
        this.opened = false;
      }
      async sendReport(reportId: number, data: BufferSource) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        hid.reports.push({ reportId, data: Array.from(bytes) });
        if (behavior.deferHidWrites)
          await new Promise<void>((resolve) => hid.pendingWrites.push(resolve));
        hid.completedWrites += 1;
      }
    }
    const device = new FakeHidDevice();
    const hidManager = Object.assign(
      new TrackedEvents((type, count) => {
        if (type === 'disconnect') hid.disconnectListeners = count;
      }),
      {
        async requestDevice() {
          hid.requests += 1;
          return behavior.cancelHid ? [] : [device];
        },
        async getDevices() {
          return [];
        },
      },
    );

    class FakeSerialPort extends EventTarget {
      readable: ReadableStream<Uint8Array> | null = null;
      writable: WritableStream<Uint8Array> | null = null;
      getInfo() {
        return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
      }
      async open(openOptions: Record<string, unknown>) {
        serial.opens += 1;
        serial.openOptions.push(openOptions);
        this.readable = new ReadableStream({
          start(controller) {
            serial.controller = controller;
          },
          cancel() {
            serial.readCancels += 1;
          },
        });
        this.writable = new WritableStream({
          write(chunk: Uint8Array) {
            serial.writes.push(Array.from(chunk));
          },
        });
      }
      async close() {
        if (this.readable?.locked || this.writable?.locked)
          throw new Error('Mock port closed while a stream lock was still held.');
        serial.closes += 1;
        serial.controller = null;
      }
    }
    const port = new FakeSerialPort();
    const serialManager = Object.assign(
      new TrackedEvents((type, count) => {
        if (type === 'disconnect') serial.disconnectListeners = count;
      }),
      {
        async requestPort() {
          serial.requests += 1;
          if (behavior.cancelSerial) throw new DOMException('No port selected', 'NotFoundError');
          return port;
        },
        async getPorts() {
          return [];
        },
      },
    );

    (window as typeof window & { rfidHardware: HardwareState }).rfidHardware = {
      hid: Object.assign(hid, { manager: hidManager, device }),
      serial: Object.assign(serial, { manager: serialManager, port }),
    };
    Object.defineProperty(navigator, 'hid', {
      configurable: true,
      value: behavior.unsupported ? undefined : hidManager,
    });
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: behavior.unsupported ? undefined : serialManager,
    });
  }, options);
}

async function state(page: Page) {
  return page.evaluate(() => {
    const hardware = (window as typeof window & { rfidHardware: HardwareState }).rfidHardware;
    return {
      hid: {
        requests: hardware.hid.requests,
        opens: hardware.hid.opens,
        closes: hardware.hid.closes,
        opened: hardware.hid.device.opened,
        reports: hardware.hid.reports,
        completedWrites: hardware.hid.completedWrites,
        inputListeners: hardware.hid.inputListeners,
        disconnectListeners: hardware.hid.disconnectListeners,
      },
      serial: {
        requests: hardware.serial.requests,
        opens: hardware.serial.opens,
        closes: hardware.serial.closes,
        readCancels: hardware.serial.readCancels,
        writes: hardware.serial.writes,
        openOptions: hardware.serial.openOptions,
        disconnectListeners: hardware.serial.disconnectListeners,
        readLocked: hardware.serial.port.readable?.locked ?? false,
        writeLocked: hardware.serial.port.writable?.locked ?? false,
      },
    };
  });
}

async function emitHid(page: Page, bytes: number[], reportId = 1) {
  await page.evaluate(
    ({ payload, id }) => {
      const hardware = (window as typeof window & { rfidHardware: HardwareState }).rfidHardware;
      const padded = new Uint8Array([0xee, ...payload, 0xff]);
      const event = new Event('inputreport');
      Object.assign(event, {
        device: hardware.hid.device,
        reportId: id,
        data: new DataView(padded.buffer, 1, payload.length),
      });
      hardware.hid.device.dispatchEvent(event);
    },
    { payload: bytes, id: reportId },
  );
}

async function emitSerial(page: Page, bytes: number[]) {
  await page.evaluate((payload) => {
    const hardware = (window as typeof window & { rfidHardware: HardwareState }).rfidHardware;
    hardware.serial.controller!.enqueue(new Uint8Array(payload));
  }, bytes);
}

async function chooseRawHid(page: Page) {
  await page.getByRole('button', { name: 'USB HID', exact: true }).click();
  await page.getByLabel('Reader mode', { exact: true }).selectOption('raw');
}

test('captures keyboard Enter, Tab, and idle scans only in the focused reader input', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('End of scan', { exact: true }).selectOption('idle');
  await page.getByLabel('Idle gap (ms)', { exact: true }).fill('0');
  await page.getByLabel('End of scan', { exact: true }).selectOption('enter');
  const clockTime = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);
  const reader = page.getByLabel('Reader input', { exact: true });
  const entries = page.getByTestId('rfid-entry');
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await reader.fill('TAG-ENTER');
  await reader.press('Enter');
  await expect(entries.locator('pre')).toHaveText(['TAG-ENTER']);
  await expect(reader).toHaveValue('');
  await page.getByRole('button', { name: 'Stop keyboard test', exact: true }).click();

  await page.getByLabel('End of scan', { exact: true }).selectOption('tab');
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await reader.fill('TAG-TAB');
  await reader.press('Tab');
  await expect(entries.locator('pre')).toHaveText(['TAG-TAB', 'TAG-ENTER']);
  await reader.press('Tab');
  await expect(reader).not.toBeFocused();
  await reader.click();
  await reader.press('Shift+Tab');
  await expect(reader).not.toBeFocused();
  await reader.click();
  await reader.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Start keyboard test', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(reader).not.toBeFocused();
  await page.keyboard.type('OUTSIDE-INPUT');
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  await expect(entries).toHaveCount(2);
  await page.getByRole('button', { name: 'Stop keyboard test', exact: true }).click();

  await page.getByLabel('End of scan', { exact: true }).selectOption('idle');
  await page.getByLabel('Idle gap (ms)', { exact: true }).fill('150');
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await reader.fill('TAG-IDLE');
  await page.clock.runFor(149);
  await expect(entries).toHaveCount(2);
  await page.clock.runFor(2);
  await expect(entries.locator('pre')).toHaveText(['TAG-IDLE', 'TAG-TAB', 'TAG-ENTER']);
  await reader.fill('BLURRED-PENDING');
  await page.getByRole('heading', { level: 1 }).click();
  await page.clock.runFor(200);
  await expect(entries).toHaveCount(3);
  await reader.fill('UNFINISHED');
  await page.getByRole('button', { name: 'Stop keyboard test', exact: true }).click();
  await page.clock.runFor(500);
  await expect(entries).toHaveCount(3);
  await page.getByRole('button', { name: 'Clear log', exact: true }).click();
  await expect(entries).toHaveCount(0);
  expect((await state(page)).hid.requests).toBe(0);
  expect((await state(page)).serial.requests).toBe(0);
});

test('reads HID report bytes and sends only explicit commands with a declared report ID', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  expect((await state(page)).hid.reports).toEqual([]);
  await emitHid(page, Array.from(Buffer.from('TAG-HID')));
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['TAG-HID']);
  await expect(page.getByTestId('rfid-entry').locator('code')).toHaveText(['54 41 47 2D 48 49 44']);
  await emitHid(page, [0, 255, 65]);
  await expect(page.getByTestId('rfid-entry').locator('code')).toHaveText([
    '00 FF 41',
    '54 41 47 2D 48 49 44',
  ]);
  await emitHid(page, [65, 66], 9);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(2);

  await page.getByLabel('Transmit format', { exact: true }).selectOption('hex');
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('01 A0 FF');
  await page.getByLabel('Line ending', { exact: true }).selectOption('none');
  await page.getByLabel('Output report ID', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).hid.reports)
    .toEqual([{ reportId: 2, data: [1, 160, 255] }]);
  await page.getByLabel('Output report ID', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/report/i);
  expect((await state(page)).hid.reports).toHaveLength(1);
  await page.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  await expect.poll(async () => (await state(page)).hid.opened).toBe(false);
  expect((await state(page)).hid).toMatchObject({
    closes: 1,
    inputListeners: 0,
    disconnectListeners: 0,
  });
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Scan codes', exact: true })
    .click();
  await expect.poll(async () => (await state(page)).hid.opened).toBe(false);
  expect((await state(page)).hid).toMatchObject({
    closes: 2,
    inputListeners: 0,
    disconnectListeners: 0,
  });
});

test('keeps a new HID command busy when a disconnected session completes an older send', async ({
  page,
}) => {
  await installHardware(page, { deferHidWrites: true });
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.getByLabel('Output report ID', { exact: true }).fill('2');
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('OLD');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('NEW');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect.poll(async () => (await state(page)).hid.reports.length).toBe(2);
  await page.evaluate(async () => {
    (
      window as typeof window & { rfidHardware: HardwareState }
    ).rfidHardware.hid.pendingWrites.shift()!();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect((await state(page)).hid.completedWrites).toBe(1);
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Command data', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (
      window as typeof window & { rfidHardware: HardwareState }
    ).rfidHardware.hid.pendingWrites.shift()!();
  });
  await expect(page.getByRole('button', { name: 'Send command', exact: true })).toBeEnabled();
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['NEW']);
});

test('frames serial UTF-8 across split CRLF and releases reader and writer locks', async ({
  page,
}, testInfo) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByLabel('Baud rate', { exact: true }).selectOption('57600');
  await page.getByLabel('Data bits', { exact: true }).selectOption('7');
  await page.getByLabel('Stop bits', { exact: true }).selectOption('2');
  await page.getByLabel('Parity', { exact: true }).selectOption('even');
  await page.getByLabel('Flow control', { exact: true }).selectOption('hardware');
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  expect((await state(page)).serial.openOptions).toEqual([
    { baudRate: 57600, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'hardware' },
  ]);
  expect((await state(page)).serial.writes).toEqual([]);
  await emitSerial(page, [84, 65, 71, 45, 0xc3]);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  await emitSerial(page, [0xa9, 13]);
  await emitSerial(page, [10, ...Array.from(Buffer.from('SECOND')), 13]);
  await emitSerial(page, [10]);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['SECOND', 'TAG-é']);

  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('PING');
  await page.getByLabel('Line ending', { exact: true }).selectOption('crlf');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).serial.writes)
    .toEqual([[80, 73, 78, 71, 13, 10]]);
  await page.getByLabel('Transmit format', { exact: true }).selectOption('hex');
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('00 A5 FF 10');
  await page.getByLabel('Line ending', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).serial.writes)
    .toEqual([
      [80, 73, 78, 71, 13, 10],
      [0, 165, 255, 16],
    ]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('rfid-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, 'RFID workspace horizontal overflow on mobile').toBeLessThanOrEqual(
    dimensions.viewport,
  );
  await page.screenshot({
    path: testInfo.outputPath('rfid-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('GG');
  await page.getByRole('button', { name: 'Send command', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/hex/i);
  expect((await state(page)).serial.writes).toHaveLength(2);
  await page.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
  expect((await state(page)).serial).toMatchObject({
    readLocked: false,
    writeLocked: false,
    disconnectListeners: 0,
  });
  expect((await state(page)).serial.readCancels).toBeGreaterThan(0);
  await page.getByLabel('Receive framing', { exact: true }).selectOption('chunks');
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await emitSerial(page, [0, 255, 65]);
  await expect(page.getByTestId('rfid-entry').locator('code').first()).toHaveText('00 FF 41');
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Single code', exact: true })
    .click();
  await expect.poll(async () => (await state(page)).serial.closes).toBe(2);
  expect((await state(page)).serial).toMatchObject({
    readLocked: false,
    writeLocked: false,
    disconnectListeners: 0,
  });
});

test('cleans up HID and serial sessions when the selected device is unplugged', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const hardware = (window as typeof window & { rfidHardware: HardwareState }).rfidHardware;
    hardware.hid.manager.dispatchEvent(
      Object.assign(new Event('disconnect'), { device: hardware.hid.device }),
    );
  });
  await expect(page.getByRole('button', { name: 'Connect HID reader', exact: true })).toBeEnabled();
  await expect.poll(async () => (await state(page)).hid.opened).toBe(false);
  expect((await state(page)).hid.inputListeners).toBe(0);
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const hardware = (window as typeof window & { rfidHardware: HardwareState }).rfidHardware;
    hardware.serial.manager.dispatchEvent(
      Object.assign(new Event('disconnect'), { port: hardware.serial.port }),
    );
  });
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
  expect((await state(page)).serial).toMatchObject({
    readLocked: false,
    writeLocked: false,
    disconnectListeners: 0,
  });
});

test('returns to a disconnected state when a device chooser is canceled', async ({ page }) => {
  await installHardware(page, { cancelHid: true, cancelSerial: true });
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect HID reader', exact: true })).toBeEnabled();
  expect((await state(page)).hid).toMatchObject({ requests: 1, opens: 0, opened: false });
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  expect((await state(page)).serial).toMatchObject({ requests: 1, opens: 0 });
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toHaveCount(0);
});

test('explains unavailable browser APIs while keyboard mode remains usable', async ({ page }) => {
  await installHardware(page, { unsupported: true });
  await page.goto('/rfid');
  await expect(
    page.getByRole('button', { name: 'Start keyboard test', exact: true }),
  ).toBeEnabled();
  await chooseRawHid(page);
  await expect(
    page.getByRole('button', { name: 'Connect HID reader', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      /WebHID.*(unavailable|not supported|supported)|(?:unavailable|not supported).*WebHID/i,
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      /Web Serial.*(unavailable|not supported|supported)|(?:unavailable|not supported).*Web Serial/i,
    ),
  ).toBeVisible();
});

test('shares RFID settings without persisting commands, received data, or device connections', async ({
  page,
  browser,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByLabel('Baud rate', { exact: true }).selectOption('115200');
  await page.getByLabel('Parity', { exact: true }).selectOption('odd');
  await page.getByLabel('Receive framing', { exact: true }).selectOption('chunks');
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await emitSerial(page, Array.from(Buffer.from('PRIVATE-TAG-123')));
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['PRIVATE-TAG-123']);
  await page.getByRole('textbox', { name: 'Command data', exact: true }).fill('PRIVATE-COMMAND');
  const sharedUrl = page.url();
  expect(sharedUrl).not.toContain('PRIVATE');
  const assertSettings = async (target: Page) => {
    await expect(target.getByLabel('Baud rate', { exact: true })).toHaveValue('115200');
    await expect(target.getByLabel('Parity', { exact: true })).toHaveValue('odd');
    await expect(target.getByLabel('Receive framing', { exact: true })).toHaveValue('chunks');
    await expect(target.getByRole('textbox', { name: 'Command data', exact: true })).toHaveValue(
      '',
    );
    await expect(target.getByTestId('rfid-entry')).toHaveCount(0);
    await expect(
      target.getByRole('button', { name: 'Connect serial reader', exact: true }),
    ).toBeEnabled();
    expect((await state(target)).serial.requests).toBe(0);
  };
  await page.reload();
  await assertSettings(page);
  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage();
    await installHardware(freshPage);
    await freshPage.goto(sharedUrl);
    await assertSettings(freshPage);
  } finally {
    await freshContext.close();
  }
});
