import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type HardwareOptions = {
  cancelHid?: boolean;
  cancelSerial?: boolean;
  unsupported?: boolean;
  deferHidWrites?: boolean;
  compositeHid?: boolean;
  serialOpenError?: { name: string; message: string };
  re40?: { mismatchReadback?: boolean; errorOnStart?: boolean };
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
    signals: Record<string, boolean>[];
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
      signals: [] as Record<string, boolean>[],
      openOptions: [] as Record<string, unknown>[],
      controller: null as ReadableStreamDefaultController<Uint8Array> | null,
    };
    const unhex = (value: string) =>
      Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
    const re40Parameters = new Map<number, Uint8Array>([
      [0x0401, unhex('0000020003020064012A1122334405010203040506070800C9')],
    ]);
    // Fake reader responses are assembled here, independently of the application codec.
    const re40Reply = (type: number, value: Uint8Array) => {
      const body = Uint8Array.of(
        type >> 8,
        type & 255,
        value.length >> 8,
        value.length & 255,
        ...value,
      );
      let crc = 0xffff;
      for (const byte of body) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
      }
      crc ^= 0xffff;
      serial.controller!.enqueue(Uint8Array.of(0xaa, 0xab, ...body, crc >> 8, crc & 255));
    };
    const answerRe40 = (request: Uint8Array) => {
      if (!behavior.re40) return;
      const command = (request[2] << 8) | request[3];
      const parameter = (request[6] << 8) | request[7];
      if (command === 0x0802) {
        const value =
          parameter === 1 ? Uint8Array.of(3, 0, 20, 0) : re40Parameters.get(parameter)!.slice();
        if (behavior.re40.mismatchReadback && parameter === 0x0201) value[0] ^= 1;
        re40Reply(0x0811, Uint8Array.of(request[6], request[7], ...value));
      } else if (command === 0x0801) re40Parameters.set(parameter, request.slice(8, -2));
      if (command === 0x0809) {
        if (behavior.re40.errorOnStart) {
          const reason = new Uint8Array(16);
          reason[15] = 32;
          re40Reply(0x0a91, reason);
        } else {
          // Captured physical RE422 response, split inside its final metadata field.
          serial.controller!.enqueue(
            unhex(
              'AAAB080800438DE28011704000021C5BEED15E89000000008E00008A000081000186CB8700028300000000321B5C148500000000321B5C148800018C34008B89',
            ),
          );
          serial.controller!.enqueue(unhex('D99000000000FF11E5BCF8'));
        }
        return; // The reader sends tag events without a START ACK.
      }
      re40Reply(0x0801, Uint8Array.of(command >> 8, command & 255, 0));
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
    const controlsInterface = Object.assign(new EventTarget(), {
      opened: false,
      productName: 'Mock composite controls interface',
      vendorId: 0x1234,
      productId: 0x5678,
      collections: [
        {
          usagePage: 0x0c,
          usage: 1,
          inputReports: [{ reportId: 4 }],
          outputReports: [],
          children: [],
        },
      ],
      async open() {
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
    });
    const hidManager = Object.assign(
      new TrackedEvents((type, count) => {
        if (type === 'disconnect') hid.disconnectListeners = count;
      }),
      {
        async requestDevice() {
          hid.requests += 1;
          return behavior.cancelHid
            ? []
            : behavior.compositeHid
              ? [controlsInterface, device]
              : [device];
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
      async setSignals(values: Record<string, boolean>) {
        serial.signals.push(values);
      }
      async open(openOptions: Record<string, unknown>) {
        serial.opens += 1;
        serial.openOptions.push(openOptions);
        if (behavior.serialOpenError)
          throw new DOMException(behavior.serialOpenError.message, behavior.serialOpenError.name);
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
            answerRe40(chunk);
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
        signals: hardware.serial.signals,
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
  await page.getByLabel('Receive framing', { exact: true }).selectOption('lines');
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

test('captures suffixless keyboard scans by default and keeps Enter and Tab scans distinct', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await expect(page.getByLabel('End of scan', { exact: true })).toHaveValue('auto');
  await expect(page.getByLabel('Idle gap (ms)', { exact: true })).toHaveValue('150');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  const reader = page.getByLabel('Reader input', { exact: true });
  const entries = page.getByTestId('rfid-entry').locator('pre');
  await expect(reader).toBeFocused();
  await page.keyboard.type('NO-SUFFIX-TAG');
  await page.clock.runFor(149);
  await expect(entries).toHaveCount(0);
  await page.clock.runFor(2);
  await expect(entries).toHaveText(['NO-SUFFIX-TAG']);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('NO-SUFFIX-TAG');
  await page.keyboard.type('ENTER-TAG');
  await page.keyboard.press('Enter');
  await page.keyboard.type('TAB-TAG');
  await page.keyboard.press('Tab');
  await page.clock.runFor(500);
  await expect(entries).toHaveText(['TAB-TAG', 'ENTER-TAG', 'NO-SUFFIX-TAG']);
  await expect(reader).toBeFocused();

  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.type('OUTSIDE-INPUT');
  await page.keyboard.press('Enter');
  await page.clock.runFor(200);
  await expect(entries).toHaveCount(3);
  await page.getByRole('button', { name: 'Focus reader input', exact: true }).click();
  await expect(reader).toBeFocused();
  await page.keyboard.type('REFOCUSED');
  await page.clock.runFor(151);
  await expect(entries).toHaveText(['REFOCUSED', 'TAB-TAG', 'ENTER-TAG', 'NO-SUFFIX-TAG']);
  expect((await state(page)).hid.requests).toBe(0);
  expect((await state(page)).serial.requests).toBe(0);
});

test('shows suffixless serial input with the default automatic framing', async ({ page }) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await expect(page.getByLabel('Receive framing', { exact: true })).toHaveValue('auto');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await emitSerial(page, [84, 65, 71, 45, 0xc3]);
  await page.clock.runFor(70);
  await emitSerial(page, [0xa9]);
  await page.clock.runFor(149);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  await page.clock.runFor(2);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['TAG-é']);
  await expect(page.getByTestId('rfid-entry').locator('code')).toHaveText(['54 41 47 2D C3 A9']);
  await emitSerial(page, Array.from(Buffer.from('CRLF-TAG\r\nTRAILING-TAG')));
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['CRLF-TAG', 'TAG-é']);
  await page.clock.runFor(151);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText([
    'TRAILING-TAG',
    'CRLF-TAG',
    'TAG-é',
  ]);
  expect((await state(page)).serial.writes).toEqual([]);
});

test('keeps raw serial bytes visible while strict line framing waits for a suffix', async ({
  page,
}, testInfo) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByLabel('Receive framing', { exact: true }).selectOption('lines');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await emitSerial(page, Array.from(Buffer.from('NO-SUFFIX-TAG')));
  const preview = page.getByTestId('rfid-last-input');
  await expect(preview).toContainText('NO-SUFFIX-TAG');
  await expect(preview).toContainText('4E 4F 2D 53 55 46 46 49 58 2D 54 41 47');
  await page.clock.runFor(1_000);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  await expect(page.getByText('13 bytes waiting for a line ending', { exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Reader activity', exact: true }).screenshot({
    path: testInfo.outputPath('serial-pending-visible.png'),
    animations: 'disabled',
  });
  await emitSerial(page, [10]);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['NO-SUFFIX-TAG']);
  await emitSerial(page, [0, 255, 65]);
  await expect(preview).toContainText('00 FF 41');
  await expect(page.getByTestId('rfid-entry')).toHaveCount(1);
  await page.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
});

test('switches a connected raw HID reader into focused keyboard capture', async ({ page }) => {
  await installHardware(page);
  await page.goto('/rfid');
  await chooseRawHid(page);
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.clock.runFor(5_001);
  await expect(
    page.getByRole('status').filter({ hasText: 'No input received yet.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Test keyboard input', exact: true }).click();
  await expect.poll(async () => (await state(page)).hid.opened).toBe(false);
  expect((await state(page)).hid).toMatchObject({
    closes: 1,
    inputListeners: 0,
    disconnectListeners: 0,
    reports: [],
  });
  await expect(page.getByLabel('Reader mode', { exact: true })).toHaveValue('keyboard');
  await expect(page.getByLabel('Reader input', { exact: true })).toBeFocused();
  await page.keyboard.type('KEYBOARD-READER');
  await page.clock.runFor(151);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('KEYBOARD-READER');
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['KEYBOARD-READER']);
  expect((await state(page)).hid.requests).toBe(1);
});

test('applies serial line signals only after an explicit request', async ({ page }) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  expect((await state(page)).serial.signals).toEqual([]);
  await page.getByText('Serial line signals', { exact: true }).click();
  await expect(page.getByLabel('DTR', { exact: true })).toHaveValue('unchanged');
  await expect(page.getByLabel('RTS', { exact: true })).toHaveValue('unchanged');
  await page.getByLabel('DTR', { exact: true }).selectOption('high');
  await page.getByLabel('RTS', { exact: true }).selectOption('low');
  expect((await state(page)).serial.signals).toEqual([]);
  await page.getByRole('button', { name: 'Apply line signals', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).serial.signals)
    .toEqual([{ dataTerminalReady: true, requestToSend: false }]);
  expect((await state(page)).serial.writes).toEqual([]);
});

test('receives reports from the vendor reader when a composite chooser returns controls first', async ({
  page,
}) => {
  await installHardware(page, { compositeHid: true });
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  expect((await state(page)).hid.opened).toBe(true);
  await emitHid(page, Array.from(Buffer.from('COMPOSITE-TAG')));
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['COMPOSITE-TAG']);
  await expect(page.getByTestId('rfid-last-input')).toContainText('COMPOSITE-TAG');
  await expect(page.getByRole('spinbutton', { name: 'Input report ID', exact: true })).toHaveValue(
    '1',
  );
  expect((await state(page)).hid.reports).toEqual([]);
});

// Model the browser lifecycle without changing tabs or requesting real devices.
async function changeVisibility(page: Page, hidden: boolean) {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: isHidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: isHidden ? 'hidden' : 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

for (const transport of ['hid', 'serial'] as const) {
  test(`keeps ${transport} receiving across visibility changes and releases it on pagehide`, async ({
    page,
  }) => {
    await installHardware(page);
    await page.goto('/rfid');
    if (transport === 'hid') await chooseRawHid(page);
    else await page.getByRole('button', { name: 'USB serial', exact: true }).click();
    const connect = page.getByRole('button', {
      name: transport === 'hid' ? 'Connect HID reader' : 'Connect serial reader',
      exact: true,
    });
    await connect.click();
    await expect(
      page.getByRole('button', { name: 'Disconnect reader', exact: true }),
    ).toBeVisible();
    const receive = async (text: string) => {
      if (transport === 'hid') await emitHid(page, Array.from(Buffer.from(text)));
      else await emitSerial(page, Array.from(Buffer.from(`${text}\n`)));
    };
    await receive('BEFORE-HIDE');
    await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['BEFORE-HIDE']);
    await changeVisibility(page, true);
    expect((await state(page))[transport]).toMatchObject({ requests: 1, opens: 1, closes: 0 });
    await receive('WHILE-HIDDEN');
    await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText([
      'WHILE-HIDDEN',
      'BEFORE-HIDE',
    ]);
    await changeVisibility(page, false);
    await receive('AFTER-RETURN');
    await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText([
      'AFTER-RETURN',
      'WHILE-HIDDEN',
      'BEFORE-HIDE',
    ]);
    expect((await state(page))[transport]).toMatchObject({ requests: 1, opens: 1, closes: 0 });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(async () => (await state(page))[transport].closes).toBe(1);
    await expect(connect).toBeEnabled();
    if (transport === 'hid') {
      expect((await state(page)).hid).toMatchObject({
        opened: false,
        inputListeners: 0,
        disconnectListeners: 0,
        reports: [],
      });
      await emitHid(page, Array.from(Buffer.from('AFTER-PAGE-EXIT')));
      await expect(page.getByTestId('rfid-entry')).toHaveCount(3);
    } else {
      expect((await state(page)).serial).toMatchObject({
        readLocked: false,
        writeLocked: false,
        disconnectListeners: 0,
        writes: [],
      });
    }
  });
}

test('keeps keyboard capture armed across visibility changes and discards a partial scan', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  const reader = page.getByLabel('Reader input', { exact: true });
  await page.getByRole('button', { name: 'Start keyboard test', exact: true }).click();
  await expect(reader).toBeFocused();
  await page.keyboard.type('PARTIAL');
  await changeVisibility(page, true);
  await expect(page.getByRole('button', { name: 'Stop keyboard test', exact: true })).toBeVisible();
  await expect(reader).toHaveValue('');
  await page.keyboard.type('IGNORED-WHILE-HIDDEN');
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await changeVisibility(page, false);
  await expect(reader).toBeEnabled();
  await page.getByRole('button', { name: 'Focus reader input', exact: true }).click();
  await expect(reader).toBeFocused();
  await page.keyboard.type('FRESH-AFTER-RETURN');
  await page.clock.runFor(151);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['FRESH-AFTER-RETURN']);
  await expect(page.getByTestId('rfid-memory-value')).toHaveText('FRESH-AFTER-RETURN');
  await page.keyboard.type('PARTIAL-BEFORE-WINDOW-BLUR');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new Event('blur'));
  });
  await expect(reader).toHaveValue('');
  await page.keyboard.type('IGNORED-WHILE-UNFOCUSED');
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('button', { name: 'Focus reader input', exact: true }).click();
  await expect(reader).toBeFocused();
  await page.keyboard.type('FRESH-AFTER-WINDOW-FOCUS');
  await page.clock.runFor(151);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText([
    'FRESH-AFTER-WINDOW-FOCUS',
    'FRESH-AFTER-RETURN',
  ]);
  await reader.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Start keyboard test', exact: true }),
  ).toBeFocused();
  await expect(reader).toBeDisabled();
  expect((await state(page)).hid.requests).toBe(0);
  expect((await state(page)).serial.requests).toBe(0);
});

test('separates serial scans by elapsed idle time when a background timer is delayed', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  await page.evaluate(() => {
    const clock = { now: 0 };
    (window as typeof window & { framingClock: { now: number } }).framingClock = clock;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now });
  });
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await emitSerial(page, Array.from(Buffer.from('FIRST')));
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  // Wall time advances between USB chunks while the throttled timeout has not run.
  await page.evaluate(() => {
    (window as typeof window & { framingClock: { now: number } }).framingClock.now = 151;
  });
  await emitSerial(page, Array.from(Buffer.from('SECOND')));
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['FIRST']);
  await page.clock.runFor(151);
  await expect(page.getByTestId('rfid-entry').locator('pre')).toHaveText(['SECOND', 'FIRST']);
  expect((await state(page)).serial.writes).toEqual([]);
});

test('decodes the reported RF inventory EPC while preserving raw bytes and rejecting a bad checksum', async ({
  page,
  context,
}, testInfo) => {
  await installHardware(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/rfid');
  await chooseRawHid(page);
  await page.getByRole('button', { name: 'Connect HID reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  // Exact user report: the declared RF packet followed by zero padding to 64 bytes.
  const packet = Array.from(
    Buffer.from('195246020000800010500E010CE28011704000021C5BEED15EB2', 'hex'),
  );
  const report = [...packet, ...Array<number>(64 - packet.length).fill(0)];
  const hex = (bytes: number[]) =>
    Buffer.from(bytes).toString('hex').toUpperCase().match(/../g)!.join(' ');
  const epc = 'E28011704000021C5BEED15E';
  await emitHid(page, report);
  const decoded = page.getByTestId('rfid-decoded-input');
  await expect(decoded).toBeVisible();
  await expect(page.getByTestId('rfid-decoded-epc')).toHaveText(epc);
  await expect(page.getByTestId('rfid-entry').locator('code')).toHaveText([hex(report)]);
  await expect(page.getByTestId('rfid-memory-hex')).toHaveText(hex(report));
  await expect(page.getByText('Read-back matches', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy EPC 1', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(epc);
  expect((await state(page)).hid.reports).toEqual([]);
  await decoded.screenshot({
    path: testInfo.outputPath('decoded-epc-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await decoded.screenshot({
    path: testInfo.outputPath('decoded-epc-mobile.png'),
    animations: 'disabled',
  });

  const damaged = [...report];
  damaged[packet.length - 1] ^= 1;
  await emitHid(page, damaged);
  await expect(decoded).toHaveCount(0);
  await expect(page.getByTestId('rfid-entry').locator('code').first()).toHaveText(hex(damaged));
  await expect(page.getByTestId('rfid-memory-hex')).toHaveText(hex(damaged));
  await emitHid(page, report);
  await expect(page.getByTestId('rfid-decoded-epc')).toHaveText(epc);
  await page.getByRole('button', { name: 'Clear log', exact: true }).click();
  await expect(decoded).toHaveCount(0);
  await expect(page.getByTestId('rfid-last-input')).toHaveCount(0);
  await expect(page.getByTestId('rfid-entry')).toHaveCount(0);
  await expect(page.getByTestId('rfid-memory-hex')).toHaveCount(0);
  expect((await state(page)).hid.reports).toEqual([]);
});

test('shows the native serial open error and returns to a disconnected state', async ({ page }) => {
  await installHardware(page, {
    serialOpenError: { name: 'NetworkError', message: 'Failed to open serial port.' },
  });
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('NetworkError: Failed to open serial port.');
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toHaveCount(0);
  expect((await state(page)).serial).toMatchObject({
    requests: 1,
    opens: 1,
    writes: [],
    readLocked: false,
    writeLocked: false,
    disconnectListeners: 0,
  });
});

test('applies and restores the RE422 serial preset without sending commands or reconnecting', async ({
  page,
}) => {
  await installHardware(page);
  await page.goto('/rfid');
  await page.getByRole('button', { name: 'USB serial', exact: true }).click();
  const model = page.getByLabel('Serial reader model', { exact: true });
  await expect(model).toHaveValue('generic');
  await page.getByLabel('Baud rate', { exact: true }).selectOption('57600');
  await page.getByLabel('Data bits', { exact: true }).selectOption('7');
  await page.getByLabel('Stop bits', { exact: true }).selectOption('2');
  await page.getByLabel('Parity', { exact: true }).selectOption('odd');
  await page.getByLabel('Flow control', { exact: true }).selectOption('hardware');
  await page.getByLabel('Receive framing', { exact: true }).selectOption('lines');
  await model.selectOption({ label: 'RE422 / RE40 (binary)' });
  const assertPreset = async () => {
    await expect(model).toHaveValue('re422');
    await expect(page.getByLabel('Baud rate', { exact: true })).toHaveValue('921600');
    await expect(page.getByLabel('Data bits', { exact: true })).toHaveValue('8');
    await expect(page.getByLabel('Stop bits', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Parity', { exact: true })).toHaveValue('none');
    await expect(page.getByLabel('Flow control', { exact: true })).toHaveValue('none');
    await expect(page.getByLabel('Receive framing', { exact: true })).toHaveValue('chunks');
  };
  await assertPreset();
  expect(new URL(page.url()).searchParams.get('model')).toBe('re422');
  expect((await state(page)).serial).toMatchObject({ requests: 0, writes: [], signals: [] });
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.clock.runFor(10_000);
  expect((await state(page)).serial).toMatchObject({
    requests: 1,
    opens: 1,
    openOptions: [
      { baudRate: 921600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    ],
    writes: [],
    signals: [],
  });
  await page.clock.resume();
  await page.reload();
  await assertPreset();
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  expect((await state(page)).serial).toMatchObject({
    requests: 0,
    opens: 0,
    writes: [],
    signals: [],
  });
  await page.getByLabel('Baud rate', { exact: true }).selectOption('9600');
  await page.getByLabel('Receive framing', { exact: true }).selectOption('auto');
  await page.reload();
  await expect(model).toHaveValue('re422');
  await expect(page.getByLabel('Baud rate', { exact: true })).toHaveValue('9600');
  await expect(page.getByLabel('Receive framing', { exact: true })).toHaveValue('auto');
  expect((await state(page)).serial).toMatchObject({ requests: 0, opens: 0, writes: [] });
});

const re40IdentifyBytes = Array.from(Buffer.from('AAAB080200020001C66F', 'hex'));
const re40FirmwareBytes = Array.from(Buffer.from('AAAB08110006000101020300AAA3', 'hex'));
const re40AckBytes = Array.from(Buffer.from('AAAB080100030802008C23', 'hex'));

for (const replyOrder of ['firmware-first', 'ack-first'] as const) {
  test(`identifies RE422 only after an explicit query and both replies: ${replyOrder}`, async ({
    page,
  }) => {
    await installHardware(page);
    await page.goto('/rfid?reader=serial&model=re422');
    const time = new Date('2026-09-25T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1_000));
    await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Disconnect reader', exact: true }),
    ).toBeVisible();
    expect((await state(page)).serial.writes).toEqual([]);
    await page.getByRole('button', { name: 'Identify reader', exact: true }).click();
    await expect.poll(async () => (await state(page)).serial.writes).toEqual([re40IdentifyBytes]);
    const first = replyOrder === 'firmware-first' ? re40FirmwareBytes : re40AckBytes;
    const second = replyOrder === 'firmware-first' ? re40AckBytes : re40FirmwareBytes;
    await emitSerial(page, first.slice(0, 4));
    await emitSerial(page, first.slice(4));
    await expect(page.getByRole('button', { name: 'Identifying…', exact: true })).toBeDisabled();
    await expect(page.getByTestId('rfid-re40-status')).not.toContainText('identified');
    await emitSerial(page, second.slice(0, second.length - 1));
    await expect(page.getByTestId('rfid-re40-status')).not.toContainText('identified');
    await emitSerial(page, second.slice(second.length - 1));
    await expect(page.getByTestId('rfid-re40-status')).toContainText('Firmware 1.2.3.0');
    await expect(page.getByRole('button', { name: 'Identify reader', exact: true })).toBeEnabled();
    await page.clock.runFor(10_000);
    expect((await state(page)).serial.writes).toEqual([re40IdentifyBytes]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('retires an RE422 connection when the firmware response is corrupt', async ({ page }) => {
  await installHardware(page);
  await page.goto('/rfid?reader=serial&model=re422');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Identify reader', exact: true }).click();
  await expect.poll(async () => (await state(page)).serial.writes).toEqual([re40IdentifyBytes]);
  const damaged = [...re40FirmwareBytes];
  damaged[damaged.length - 1] ^= 1;
  await emitSerial(page, damaged);
  await emitSerial(page, re40AckBytes);
  await expect(page.getByTestId('rfid-re40-status')).not.toContainText('identified');
  await page.clock.runFor(3_001);
  await expect(page.getByRole('alert')).toContainText(/3 seconds|timed out|timeout/i);
  await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Connect serial reader', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Identify reader', exact: true })).toBeDisabled();
  expect((await state(page)).serial).toMatchObject({
    writes: [re40IdentifyBytes],
    readLocked: false,
    writeLocked: false,
    disconnectListeners: 0,
  });
});

async function identifyMockRe40(page: Page, behavior: NonNullable<HardwareOptions['re40']> = {}) {
  await installHardware(page, { re40: behavior });
  await page.goto('/rfid?reader=serial&model=re422');
  const time = new Date('2026-09-25T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1_000));
  await page.getByRole('button', { name: 'Connect serial reader', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect reader', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Read tags for 5 seconds', exact: true }),
  ).toBeDisabled();
  expect((await state(page)).serial.writes).toEqual([]);
  await page.getByRole('button', { name: 'Identify reader', exact: true }).click();
  await expect(page.getByTestId('rfid-re40-status')).toContainText('Firmware 3.0.20.0');
}

test('runs finite RE422 inventory with verified configuration and the captured split tag report', async ({
  page,
}, testInfo) => {
  await identifyMockRe40(page);
  expect((await state(page)).serial.writes).toEqual([re40IdentifyBytes]);
  await page.getByRole('button', { name: 'Read tags for 5 seconds', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop inventory', exact: true })).toBeEnabled();
  await expect(page.getByTestId('rfid-re40-tags').locator('code')).toHaveText([
    'E28011704000021C5BEED15E',
  ]);
  const expectedCommands = [
    'AAAB080200020001C66F', // Identify only on the explicit click.
    'AAAB08080000575D',
    'AAAB0802000204010AAB', // Stop, then read existing RF settings.
    'AAAB0801000310EB00CCCB',
    'AAAB08010007D0030000000000AEAD',
    'AAAB0801000810FF00000000000009DD',
    'AAAB0801000510FD0000006831',
    'AAAB08010004020000000C14',
    'AAAB0801000703000000000000F9A1',
    'AAAB08010008020101010100020C9874',
    'AAAB0801001B04010100020003020064012A0000000001000000000000000000C92DEC',
    'AAAB080100050004010008B669',
    'AAAB080100050004010291C29B',
    'AAAB0801000F00050000138800000000000000000050F7',
    'AAAB080200020201A00D',
    'AAAB0802000204010AAB',
    'AAAB08020002000586EB', // Read-back verification.
    'AAAB08090000606D', // START has no ACK in this reader fixture.
  ];
  const commandHex = async () =>
    (await state(page)).serial.writes.map((value) =>
      Buffer.from(value).toString('hex').toUpperCase(),
    );
  expect(await commandHex()).toEqual(expectedCommands);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { level: 1 }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('re422-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await emitSerial(
    page,
    Array.from(Buffer.from('AAAB0A91001000000000000000000000000000000004FD96', 'hex')),
  );
  await expect(page.getByTestId('rfid-re40-status')).toContainText('duration limit');
  await expect(page.getByTestId('rfid-re40-status')).toContainText('1 tag report');
  await expect(
    page.getByRole('button', { name: 'Read tags for 5 seconds', exact: true }),
  ).toBeEnabled();
  await page.clock.runFor(6_000);
  expect(await commandHex()).toEqual(expectedCommands);
  await page.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
  await page.clock.runFor(10_000);
  expect(await commandHex()).toEqual(expectedCommands);
  expect((await state(page)).serial).toMatchObject({ readLocked: false, writeLocked: false });
});

for (const failure of ['readback mismatch', 'reader error'] as const) {
  test(`stops RE422 inventory preparation or reading on ${failure}`, async ({ page }) => {
    await identifyMockRe40(page, {
      mismatchReadback: failure === 'readback mismatch',
      errorOnStart: failure === 'reader error',
    });
    await page.getByRole('button', { name: 'Read tags for 5 seconds', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      failure === 'readback mismatch' ? 'did not confirm' : 'reader error',
    );
    await expect.poll(async () => (await state(page)).serial.closes).toBe(1);
    await expect(page.getByTestId('rfid-re40-tags')).toHaveCount(0);
    const sent = (await state(page)).serial.writes;
    expect(sent.filter((value) => value[2] === 0x08 && value[3] === 0x09)).toHaveLength(
      failure === 'readback mismatch' ? 0 : 1,
    );
    await page.clock.runFor(10_000);
    expect((await state(page)).serial.writes).toEqual(sent);
    await expect(
      page.getByRole('button', { name: 'Connect serial reader', exact: true }),
    ).toBeEnabled();
    expect((await state(page)).serial).toMatchObject({ readLocked: false, writeLocked: false });
  });
}
