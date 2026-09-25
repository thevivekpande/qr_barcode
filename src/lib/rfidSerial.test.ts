import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSerialReader, serialSupported } from './rfidSerial';
import type {
  SerialApi,
  SerialCallbacks,
  SerialDisconnectEvent,
  SerialOptions,
  SerialPortLike,
} from './rfidSerial';

const settings: SerialOptions = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockPort(
  options: { opening?: Promise<void>; write?: (chunk: Uint8Array) => Promise<void> } = {},
) {
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const sent: number[][] = [];
  const cancelled = vi.fn();
  const aborted = vi.fn();
  const port: SerialPortLike = {
    readable: null,
    writable: null,
    open: vi.fn(async () => {
      if (options.opening) await options.opening;
      port.readable = new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller;
        },
        cancel: cancelled,
      });
      port.writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          sent.push(Array.from(chunk));
          await options.write?.(chunk);
        },
        abort: aborted,
      });
    }),
    close: vi.fn(async () => {
      if (port.readable?.locked || port.writable?.locked)
        throw new Error('Port closed while streams are still locked');
    }),
    getInfo: vi.fn(() => ({ usbVendorId: 0x1234, usbProductId: 0xabcd })),
  };
  return {
    port,
    sent,
    cancelled,
    aborted,
    enqueue: (value: Uint8Array) => input.enqueue(value),
    end: () => input.close(),
    fail: (error: Error) => input.error(error),
  };
}

function harness(port = mockPort().port) {
  const listeners = new Set<(event: SerialDisconnectEvent) => void>();
  const api: SerialApi = {
    requestPort: vi.fn(async () => port),
    addEventListener: vi.fn((_type, listener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type, listener) => {
      listeners.delete(listener);
    }),
  };
  const callbacks: SerialCallbacks = {
    onStatus: vi.fn(),
    onData: vi.fn(),
    onInfo: vi.fn(),
    onError: vi.fn(),
  };
  return {
    api,
    callbacks,
    listeners,
    reader: createSerialReader(callbacks, api),
    unplug: (selected: SerialPortLike) =>
      listeners.forEach((listener) => listener({ target: selected })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('serial support and explicit device selection', () => {
  it('does not access a device until connect is explicitly called', () => {
    const test = harness();
    expect(test.api.requestPort).not.toHaveBeenCalled();
    expect(test.api.addEventListener).not.toHaveBeenCalled();
    expect(test.callbacks.onStatus).not.toHaveBeenCalled();
  });

  it('detects browser support without assuming navigator.serial exists', () => {
    vi.stubGlobal('navigator', {});
    expect(serialSupported()).toBe(false);
    vi.stubGlobal('navigator', { serial: harness().api });
    expect(serialSupported()).toBe(true);
  });

  it('reports unavailable Web Serial and invalid settings without requesting access', async () => {
    vi.stubGlobal('navigator', {});
    const test = harness();
    await createSerialReader(test.callbacks).connect(settings);
    expect(test.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    await test.reader.connect({ ...settings, baudRate: 0 });
    expect(test.api.requestPort).not.toHaveBeenCalled();
    expect(test.callbacks.onError).toHaveBeenLastCalledWith(expect.stringContaining('baud rate'));
  });

  it.each([
    ['NotFoundError', 'selection was cancelled'],
    ['NotAllowedError', 'access was denied'],
    ['NetworkError', 'busy or unavailable'],
  ])('reports a friendly %s error and resets status', async (name, expected) => {
    const test = harness();
    vi.mocked(test.api.requestPort).mockRejectedValue(new DOMException('', name));
    await test.reader.connect(settings);
    expect(test.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('ignores a late cancelled chooser after a new connection starts', async () => {
    const oldPort = mockPort();
    const newPort = mockPort();
    const chooser = deferred<SerialPortLike>();
    const test = harness(newPort.port);
    vi.mocked(test.api.requestPort).mockImplementationOnce(() => chooser.promise);
    const first = test.reader.connect(settings);
    await test.reader.disconnect();
    await test.reader.connect(settings);
    chooser.resolve(oldPort.port);
    await first;
    expect(oldPort.port.open).not.toHaveBeenCalled();
    expect(oldPort.port.close).not.toHaveBeenCalled();
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
    expect(test.callbacks.onInfo).toHaveBeenCalledTimes(1);
    await test.reader.disconnect();
  });

  it('closes an opened port if disconnect happened while opening', async () => {
    const opening = deferred<void>();
    const mock = mockPort({ opening: opening.promise });
    const test = harness(mock.port);
    const connecting = test.reader.connect(settings);
    await vi.waitFor(() => expect(mock.port.open).toHaveBeenCalled());
    const disconnecting = test.reader.disconnect();
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnecting');
    opening.resolve();
    await Promise.all([connecting, disconnecting]);
    expect(mock.port.close).toHaveBeenCalledTimes(1);
    expect(test.callbacks.onInfo).not.toHaveBeenCalled();
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(test.listeners.size).toBe(0);
  });
});

describe('serial receive lifecycle', () => {
  it('receives exact independent byte chunks and closes only after releasing the read lock', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    await test.reader.connect(settings);
    expect(mock.port.open).toHaveBeenCalledWith(settings);
    expect(test.callbacks.onInfo).toHaveBeenCalledWith({
      name: 'USB serial reader (1234:ABCD)',
      vendorId: 0x1234,
      productId: 0xabcd,
    });
    expect(mock.port.readable?.locked).toBe(true);
    const first = new Uint8Array([0x00, 0xff, 0xe2]);
    const second = new Uint8Array([0x82, 0xac, 0x0d, 0x0a]);
    mock.enqueue(first);
    mock.enqueue(second);
    await vi.waitFor(() => expect(test.callbacks.onData).toHaveBeenCalledTimes(2));
    first.fill(0);
    expect(test.callbacks.onData).toHaveBeenNthCalledWith(1, new Uint8Array([0x00, 0xff, 0xe2]));
    expect(test.callbacks.onData).toHaveBeenNthCalledWith(2, second);
    expect(mock.sent).toEqual([]);
    await test.reader.disconnect();
    expect(mock.cancelled).toHaveBeenCalledTimes(1);
    expect(mock.port.readable?.locked).toBe(false);
    expect(mock.port.close).toHaveBeenCalledTimes(1);
    expect(test.callbacks.onError).not.toHaveBeenCalled();
  });

  it.each(['end', 'error'])(
    'closes the port and removes listeners when input reaches %s',
    async (event) => {
      const mock = mockPort();
      const test = harness(mock.port);
      await test.reader.connect(settings);
      if (event === 'end') mock.end();
      else mock.fail(new DOMException('unplugged', 'NetworkError'));
      await vi.waitFor(() =>
        expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected'),
      );
      expect(mock.port.close).toHaveBeenCalledTimes(1);
      expect(mock.port.readable?.locked).toBe(false);
      expect(test.listeners.size).toBe(0);
      expect(test.callbacks.onError).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores unrelated unplug events and cleans up the selected device on unplug', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    await test.reader.connect(settings);
    test.unplug(mockPort().port);
    expect(mock.port.close).not.toHaveBeenCalled();
    test.unplug(mock.port);
    await vi.waitFor(() => expect(mock.port.close).toHaveBeenCalledTimes(1));
    expect(test.callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining('selected serial reader was disconnected'),
    );
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(test.listeners.size).toBe(0);
  });

  it('cleans up an opening failure and allows a later explicit retry', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    vi.mocked(mock.port.open).mockRejectedValueOnce(new DOMException('busy', 'NetworkError'));
    await test.reader.connect(settings);
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(test.listeners.size).toBe(0);
    expect(mock.port.close).not.toHaveBeenCalled();
    await test.reader.connect(settings);
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
    await test.reader.disconnect();
  });
});

describe('explicit serial writes', () => {
  it('sends only requested bytes, copies them, and preserves concurrent command order', async () => {
    const gate = deferred<void>();
    const mock = mockPort({
      write: async (chunk) => {
        if (chunk[0] === 1) await gate.promise;
      },
    });
    const test = harness(mock.port);
    await test.reader.connect(settings);
    expect(mock.sent).toEqual([]);
    const data = new Uint8Array([1, 0, 255]);
    const first = test.reader.send(data);
    const second = test.reader.send(new Uint8Array([2, 13, 10]));
    data.fill(9);
    await vi.waitFor(() => expect(mock.sent).toHaveLength(1));
    gate.resolve();
    await Promise.all([first, second]);
    expect(mock.sent).toEqual([
      [1, 0, 255],
      [2, 13, 10],
    ]);
    expect(mock.port.writable?.locked).toBe(false);
    await test.reader.disconnect();
  });

  it('rejects sends before connection and never opens a chooser for send', async () => {
    const test = harness();
    await expect(test.reader.send(new Uint8Array([1]))).rejects.toThrow('Connect a serial reader');
    expect(test.api.requestPort).not.toHaveBeenCalled();
  });

  it('cancels a pending write and queued commands without waiting on a stalled device', async () => {
    const gate = deferred<void>();
    const mock = mockPort({ write: () => gate.promise });
    const test = harness(mock.port);
    await test.reader.connect(settings);
    const first = test.reader.send(new Uint8Array([1])).catch((error: Error) => error.message);
    const second = test.reader.send(new Uint8Array([2])).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(mock.sent).toHaveLength(1));
    await test.reader.disconnect();
    expect(await first).toContain('cancelled');
    expect(await second).toContain('cancelled');
    expect(mock.sent).toEqual([[1]]);
    expect(mock.port.writable?.locked).toBe(false);
    expect(mock.port.readable?.locked).toBe(false);
    expect(mock.port.close).toHaveBeenCalledTimes(1);
    gate.resolve();
  });

  it('bounds a stalled write to five seconds and disconnects safely', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const mock = mockPort({ write: () => gate.promise });
    const test = harness(mock.port);
    await test.reader.connect(settings);
    const outcome = test.reader.send(new Uint8Array([1])).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toContain('timed out after 5 seconds');
    await test.reader.disconnect();
    expect(mock.port.writable?.locked).toBe(false);
    expect(mock.port.close).toHaveBeenCalledTimes(1);
    gate.resolve();
  });
});
