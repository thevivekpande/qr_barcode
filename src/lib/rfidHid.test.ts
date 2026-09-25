import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHidReader,
  hidSupported,
  type HidCallbacks,
  type HidCollection,
  type HidInputReport,
  type RawHidApi,
  type RawHidDevice,
} from './rfidHid';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const rawCollections: HidCollection[] = [
  {
    usagePage: 0xff00,
    usage: 1,
    inputReports: [{ reportId: 1 }],
    outputReports: [{ reportId: 2 }],
  },
];

function fakeDevice(collections = rawCollections) {
  const listeners = new Set<(event: HidInputReport) => void>();
  const device: RawHidDevice = {
    opened: false,
    productName: 'Test RFID reader',
    vendorId: 0x1234,
    productId: 0x5678,
    collections,
    open: vi.fn(async () => {
      device.opened = true;
    }),
    close: vi.fn(async () => {
      device.opened = false;
    }),
    sendReport: vi.fn(async () => {}),
    addEventListener: vi.fn((_type, listener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type, listener) => {
      listeners.delete(listener);
    }),
  };
  return {
    device,
    listeners,
    emit(data: DataView, reportId = 1) {
      for (const listener of listeners) listener({ device, data, reportId });
    },
  };
}

function fakeApi(device: RawHidDevice) {
  const listeners = new Set<(event: { device: RawHidDevice }) => void>();
  const api: RawHidApi = {
    requestDevice: vi.fn(async () => [device]),
    addEventListener: vi.fn((_type, listener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type, listener) => {
      listeners.delete(listener);
    }),
  };
  return {
    api,
    listeners,
    unplug(unplugged = device) {
      for (const listener of [...listeners]) listener({ device: unplugged });
    },
  };
}

function callbacks(): HidCallbacks {
  return { onStatus: vi.fn(), onData: vi.fn(), onInfo: vi.fn(), onError: vi.fn() };
}

function setup(collections = rawCollections) {
  const fake = fakeDevice(collections);
  const host = fakeApi(fake.device);
  const events = callbacks();
  const reader = createHidReader(events, host.api);
  return { ...fake, ...host, deviceListeners: fake.listeners, events, reader };
}

async function settle() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

afterEach(() => vi.unstubAllGlobals());

describe('WebHID availability and permission', () => {
  it('detects the browser API without requiring browser globals in tests or SSR', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(hidSupported()).toBe(false);
    const events = callbacks();
    await createHidReader(events).connect();
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    const { api } = fakeApi(fakeDevice().device);
    vi.stubGlobal('navigator', { hid: api });
    expect(hidSupported()).toBe(true);
    await createHidReader(callbacks()).connect();
    expect(api.requestDevice).toHaveBeenCalledWith({ filters: [] });
  });

  it('requests a device immediately and opens only after explicit selection', async () => {
    const { reader, api, device, events } = setup();
    const chooser = deferred<RawHidDevice[]>();
    vi.mocked(api.requestDevice).mockReturnValue(chooser.promise);
    const connection = reader.connect();
    expect(api.requestDevice).toHaveBeenCalledOnce();
    expect(api.requestDevice).toHaveBeenCalledWith({ filters: [] });
    expect(device.open).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith('requesting');
    chooser.resolve([device]);
    await connection;
    expect(events.onStatus).toHaveBeenNthCalledWith(2, 'connecting');
    expect(events.onStatus).toHaveBeenLastCalledWith('connected');
    expect(device.sendReport).not.toHaveBeenCalled();
    await reader.disconnect();
  });

  it('handles a canceled chooser without opening a device or leaving listeners', async () => {
    const { reader, api, device, events, listeners } = setup();
    vi.mocked(api.requestDevice).mockResolvedValue([]);
    await reader.connect();
    expect(events.onError).toHaveBeenCalledWith(
      expect.stringContaining('No HID reader was selected'),
    );
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(device.open).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it.each([
    ['NotFoundError', 'No HID reader was selected'],
    ['AbortError', 'No HID reader was selected'],
    ['NotAllowedError', 'denied or blocked'],
    ['SecurityError', 'denied or blocked'],
  ])('explains chooser failure %s', async (name, message) => {
    const { reader, api, events } = setup();
    vi.mocked(api.requestDevice).mockRejectedValue(new DOMException('', name));
    await expect(reader.connect()).resolves.toBeUndefined();
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it.each(['NotReadableError', 'NetworkError', 'InvalidStateError'])(
    'explains a busy or unavailable device: %s',
    async (name) => {
      const { reader, device, events, listeners } = setup();
      vi.mocked(device.open).mockRejectedValue(new DOMException('', name));
      await reader.connect();
      expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('busy'));
      expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
      expect(listeners.size).toBe(0);
    },
  );

  it('does not claim or close a device already opened outside this adapter', async () => {
    const { reader, device, events } = setup();
    device.opened = true;
    await reader.connect();
    await reader.disconnect();
    expect(device.open).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('already open'));
    expect(device.opened).toBe(true);
  });
});

describe('raw input and declared output reports', () => {
  it('preserves input bytes, DataView offsets, and report IDs without retaining the source buffer', async () => {
    const { reader, emit, events } = setup();
    await reader.connect();
    const source = new Uint8Array([99, 0x00, 0xff, 0x80, 0x0d, 88]);
    emit(new DataView(source.buffer, 1, 4), 7);
    expect(events.onData).toHaveBeenCalledWith(new Uint8Array([0, 255, 128, 13]), 7);
    source.fill(0);
    const received = vi.mocked(events.onData).mock.calls[0][0];
    expect([...received]).toEqual([0, 255, 128, 13]);
    await reader.disconnect();
  });

  it('finds nested output IDs, including zero, without exposing protected keyboard reports', async () => {
    const { reader, events, emit, device } = setup([
      {
        usagePage: 0xff00,
        outputReports: [{ reportId: 3 }, { reportId: 0 }, { reportId: 256 }],
        children: [{ outputReports: [{ reportId: 2 }, { reportId: 3 }, { reportId: -1 }] }],
      },
      {
        usagePage: 0x01,
        usage: 0x06,
        inputReports: [{ reportId: 9 }],
        outputReports: [{ reportId: 3 }],
        children: [{ outputReports: [{ reportId: 8 }], inputReports: [{ reportId: 10 }] }],
      },
    ]);
    await reader.connect();
    expect(events.onInfo).toHaveBeenCalledWith({
      name: 'Test RFID reader',
      vendorId: 0x1234,
      productId: 0x5678,
      outputReportIds: [0, 2],
    });
    emit(new DataView(new Uint8Array([65]).buffer), 9);
    emit(new DataView(new Uint8Array([66]).buffer), 10);
    expect(events.onData).not.toHaveBeenCalled();
    await expect(reader.send(3, new Uint8Array([1]))).rejects.toThrow('declared');
    await reader.send(0, new Uint8Array([4]));
    expect(device.sendReport).toHaveBeenCalledWith(0, new Uint8Array([4]));
    await reader.disconnect();
  });

  it('routes a keyboard-only device back to keyboard mode without opening it', async () => {
    const { reader, device, events } = setup([
      {
        usagePage: 0x01,
        usage: 0x06,
        inputReports: [{ reportId: 1 }],
        outputReports: [{ reportId: 2 }],
      },
    ]);
    await reader.connect();
    expect(device.open).not.toHaveBeenCalled();
    expect(events.onInfo).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('keyboard mode'));
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('selects an accessible raw interface when the chosen device returns multiple interfaces', async () => {
    const { reader, api, device } = setup();
    const keyboard = fakeDevice([{ usagePage: 0x07, inputReports: [{ reportId: 1 }] }]).device;
    vi.mocked(api.requestDevice).mockResolvedValue([keyboard, device]);
    await reader.connect();
    expect(keyboard.open).not.toHaveBeenCalled();
    expect(device.open).toHaveBeenCalledOnce();
    await reader.disconnect();
  });

  it('sends only manually requested declared reports, with an independent exact payload', async () => {
    const { reader, device } = setup();
    await reader.connect();
    expect(device.sendReport).not.toHaveBeenCalled();
    const payload = new Uint8Array([99, 0, 255, 12, 88]);
    await reader.send(2, payload.subarray(1, 4));
    expect(device.sendReport).toHaveBeenCalledWith(2, new Uint8Array([0, 255, 12]));
    payload.fill(0);
    expect([...vi.mocked(device.sendReport).mock.calls[0][1]]).toEqual([0, 255, 12]);
    await reader.disconnect();
  });

  it.each([-1, 1, 2.5, 256, NaN])(
    'refuses undeclared or invalid output report ID %s',
    async (id) => {
      const { reader, device } = setup();
      await reader.connect();
      await expect(reader.send(id, new Uint8Array([1]))).rejects.toThrow('declared');
      expect(device.sendReport).not.toHaveBeenCalled();
      await reader.disconnect();
    },
  );

  it('refuses output when disconnected or when the device declares no output reports', async () => {
    const { reader, device } = setup([{ usagePage: 0xff00, inputReports: [{ reportId: 1 }] }]);
    await expect(reader.send(0, new Uint8Array())).rejects.toThrow('Connect a HID reader');
    await reader.connect();
    await expect(reader.send(0, new Uint8Array())).rejects.toThrow('declared');
    expect(device.sendReport).not.toHaveBeenCalled();
    await reader.disconnect();
  });

  it('reports failed output without claiming it was sent or abandoning the input listener', async () => {
    const { reader, device, events, emit } = setup();
    await reader.connect();
    vi.mocked(device.sendReport).mockRejectedValue(new DOMException('', 'NetworkError'));
    await expect(reader.send(2, new Uint8Array([1]))).rejects.toThrow('could not be sent');
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('could not be sent'));
    emit(new DataView(new Uint8Array([42]).buffer));
    expect(events.onData).toHaveBeenCalledOnce();
    await reader.disconnect();
  });
});

describe('connection cancellation and cleanup', () => {
  it('detaches listeners and closes once on an explicit stop, ignoring already queued events', async () => {
    const { reader, device, events, listeners, deviceListeners } = setup();
    await reader.connect();
    const queuedListener = [...deviceListeners][0];
    await reader.disconnect();
    await reader.disconnect();
    queuedListener({ device, reportId: 1, data: new DataView(new Uint8Array([1]).buffer) });
    expect(device.close).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(deviceListeners.size).toBe(0);
    expect(events.onData).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('ignores other devices being unplugged, and cleans up when its own device is unplugged', async () => {
    const { reader, device, events, unplug, listeners, deviceListeners } = setup();
    await reader.connect();
    unplug(fakeDevice().device);
    expect(events.onStatus).toHaveBeenLastCalledWith('connected');
    unplug();
    await settle();
    expect(device.close).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(deviceListeners.size).toBe(0);
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('ignores a chooser selection that arrives after stop without opening or closing that device', async () => {
    const { reader, api, device, events } = setup();
    const chooser = deferred<RawHidDevice[]>();
    vi.mocked(api.requestDevice).mockReturnValue(chooser.promise);
    const pending = reader.connect();
    await reader.disconnect();
    chooser.resolve([device]);
    await pending;
    expect(device.open).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
    expect(events.onInfo).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('closes a late successful open after stop without announcing a connection', async () => {
    const { reader, device, events, listeners, deviceListeners } = setup();
    const opened = deferred<void>();
    vi.mocked(device.open).mockImplementation(async () => {
      await opened.promise;
      device.opened = true;
    });
    const pending = reader.connect();
    await settle();
    expect(events.onStatus).toHaveBeenLastCalledWith('connecting');
    await reader.disconnect();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    opened.resolve();
    await pending;
    expect(device.close).toHaveBeenCalledOnce();
    expect(events.onInfo).not.toHaveBeenCalled();
    expect(deviceListeners.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('does not open the device when the connection callback immediately requests a stop', async () => {
    const { reader, device, events, listeners } = setup();
    vi.mocked(events.onStatus).mockImplementation((status) => {
      if (status === 'connecting') void reader.disconnect();
    });
    await reader.connect();
    expect(device.open).not.toHaveBeenCalled();
    expect(device.close).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(listeners.size).toBe(0);
  });

  it('cleans up an unplug while open is still pending', async () => {
    const { reader, device, events, unplug, listeners } = setup();
    const opened = deferred<void>();
    vi.mocked(device.open).mockImplementation(async () => {
      await opened.promise;
      device.opened = true;
    });
    const pending = reader.connect();
    await settle();
    unplug();
    opened.resolve();
    await pending;
    expect(device.close).toHaveBeenCalledOnce();
    expect(events.onInfo).not.toHaveBeenCalled();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(listeners.size).toBe(0);
  });

  it('keeps a newer connection intact when a canceled old open finishes', async () => {
    const { reader, api, device, events } = setup();
    const opened = deferred<void>();
    vi.mocked(device.open).mockImplementation(async () => {
      await opened.promise;
      device.opened = true;
    });
    const first = reader.connect();
    await settle();
    await reader.disconnect();
    const next = fakeDevice();
    vi.mocked(api.requestDevice).mockResolvedValue([next.device]);
    await reader.connect();
    opened.resolve();
    await first;
    expect(device.close).toHaveBeenCalledOnce();
    expect(next.device.close).not.toHaveBeenCalled();
    expect(next.device.opened).toBe(true);
    expect(events.onStatus).toHaveBeenLastCalledWith('connected');
    expect(events.onInfo).toHaveBeenCalledOnce();
    next.emit(new DataView(new Uint8Array([55]).buffer));
    expect(events.onData).toHaveBeenCalledWith(new Uint8Array([55]), 1);
    await reader.disconnect();
  });

  it('does not reopen the same device until its canceled open has settled', async () => {
    const { reader, device, events } = setup();
    const opened = deferred<void>();
    vi.mocked(device.open).mockImplementation(async () => {
      await opened.promise;
      device.opened = true;
    });
    const first = reader.connect();
    await settle();
    await reader.disconnect();
    await reader.connect();
    expect(device.open).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining('still disconnecting'));
    opened.resolve();
    await first;
    expect(device.close).toHaveBeenCalledOnce();
  });

  it('does not emit a stale error when an old chooser or open rejects after cancellation', async () => {
    for (const stage of ['chooser', 'open'] as const) {
      const { reader, api, device, events } = setup();
      const operation = deferred<never>();
      if (stage === 'chooser') vi.mocked(api.requestDevice).mockReturnValue(operation.promise);
      else vi.mocked(device.open).mockReturnValue(operation.promise);
      const pending = reader.connect();
      await settle();
      await reader.disconnect();
      operation.reject(new DOMException('', 'NotAllowedError'));
      await pending;
      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    }
  });

  it('prevents duplicate chooser requests and supports reconnect after a completed stop', async () => {
    const { reader, api, device } = setup();
    const chooser = deferred<RawHidDevice[]>();
    vi.mocked(api.requestDevice).mockReturnValueOnce(chooser.promise);
    const first = reader.connect();
    await reader.connect();
    expect(api.requestDevice).toHaveBeenCalledOnce();
    chooser.resolve([device]);
    await first;
    await reader.connect();
    expect(api.requestDevice).toHaveBeenCalledOnce();
    await reader.disconnect();
    await reader.connect();
    expect(api.requestDevice).toHaveBeenCalledTimes(2);
    expect(device.open).toHaveBeenCalledTimes(2);
    await reader.disconnect();
  });

  it('stays disconnecting until close finishes and does not reopen during close', async () => {
    const { reader, api, device, events } = setup();
    const closed = deferred<void>();
    await reader.connect();
    vi.mocked(device.close).mockImplementation(async () => {
      await closed.promise;
      device.opened = false;
    });
    const stopped = reader.disconnect();
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnecting');
    await reader.connect();
    expect(api.requestDevice).toHaveBeenCalledOnce();
    closed.resolve();
    await stopped;
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('reports a failed close but removes listeners and permits a later recovery attempt', async () => {
    const { reader, device, events, listeners, deviceListeners } = setup();
    await reader.connect();
    vi.mocked(device.close).mockRejectedValue(new DOMException('', 'NetworkError'));
    await reader.disconnect();
    expect(events.onError).toHaveBeenCalledWith(
      expect.stringContaining('could not be closed cleanly'),
    );
    expect(events.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(deviceListeners.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('suppresses stale output errors after disconnect, but rejects the send promise', async () => {
    const { reader, device, events } = setup();
    const sent = deferred<void>();
    await reader.connect();
    vi.mocked(device.sendReport).mockReturnValue(sent.promise);
    const output = reader.send(2, new Uint8Array([1]));
    const rejected = expect(output).rejects.toThrow('connection changed');
    await reader.disconnect();
    sent.reject(new DOMException('', 'NetworkError'));
    await rejected;
    expect(events.onError).not.toHaveBeenCalled();
  });
});
