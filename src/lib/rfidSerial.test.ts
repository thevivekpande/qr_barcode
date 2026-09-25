import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSerialReader, serialSupported } from './rfidSerial';
import type {
  SerialApi,
  SerialCallbacks,
  SerialDisconnectEvent,
  SerialOptions,
  SerialOutputSignals,
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
    fail: (error: unknown) => input.error(error),
    recover(error: Error) {
      const previous = input;
      const oldStream = port.readable;
      port.readable = new ReadableStream<Uint8Array>({
        start(controller) {
          input = controller;
        },
        cancel: cancelled,
      });
      previous.error(error);
      return { oldStream, replacement: port.readable };
    },
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
    expect(test.callbacks.onError).toHaveBeenCalledWith(expect.stringMatching(`Details: ${name}$`));
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
      supportsSignals: false,
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
      expect(test.callbacks.onError).toHaveBeenCalledWith(
        event === 'error'
          ? 'The serial connection was lost. Check the USB cable and reconnect the reader. Details: NetworkError: unplugged'
          : 'Serial input has ended. Reconnect the reader to continue.',
      );
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
    expect(vi.mocked(test.callbacks.onError).mock.calls[0][0]).not.toContain('Details:');
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(test.listeners.size).toBe(0);
  });

  it('cleans up an opening failure and allows a later explicit retry', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    vi.mocked(mock.port.open).mockRejectedValueOnce(new DOMException('busy', 'NetworkError'));
    await test.reader.connect(settings);
    expect(test.callbacks.onError).toHaveBeenCalledWith(
      'The serial reader is busy or unavailable. Close other apps using it, check the USB connection, and try again. Details: NetworkError: busy',
    );
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(test.listeners.size).toBe(0);
    expect(mock.port.close).not.toHaveBeenCalled();
    await test.reader.connect(settings);
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
    await test.reader.disconnect();
  });

  it.each(['ParityError', 'FramingError', 'BufferOverrunError', 'BreakError'])(
    'resumes incoming bytes on the replacement stream after %s',
    async (name) => {
      const mock = mockPort();
      const test = harness(mock.port);
      const interrupted = vi.fn();
      test.callbacks.onReadError = interrupted;
      await test.reader.connect(settings);
      const streams = mock.recover(new DOMException('recoverable', name));
      await vi.waitFor(() => expect(interrupted).toHaveBeenCalledOnce());
      expect(interrupted).toHaveBeenCalledWith(
        expect.stringContaining(`Details: ${name}: recoverable`),
      );
      expect(streams.oldStream?.locked).toBe(false);
      expect(streams.replacement.locked).toBe(true);
      expect(mock.port.close).not.toHaveBeenCalled();
      expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
      expect(test.callbacks.onError).not.toHaveBeenCalled();
      mock.enqueue(new Uint8Array([0, 0xff, 0x0d]));
      await vi.waitFor(() =>
        expect(test.callbacks.onData).toHaveBeenCalledWith(new Uint8Array([0, 0xff, 0x0d])),
      );
      expect(mock.port.open).toHaveBeenCalledOnce();
      expect(test.api.requestPort).toHaveBeenCalledOnce();
      expect(mock.sent).toEqual([]);
      await test.reader.disconnect();
    },
  );

  it('bounds repeated recovery failures and never retries the same errored stream', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    const interrupted = vi.fn();
    test.callbacks.onReadError = interrupted;
    await test.reader.connect(settings);
    for (let index = 0; index < 4; index++) {
      mock.recover(new DOMException('recoverable', 'FramingError'));
      if (index < 3) await vi.waitFor(() => expect(interrupted).toHaveBeenCalledTimes(index + 1));
    }
    await vi.waitFor(() =>
      expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected'),
    );
    expect(interrupted).toHaveBeenCalledTimes(3);
    expect(test.callbacks.onError).toHaveBeenLastCalledWith(
      expect.stringContaining('repeatedly failed'),
    );
    expect(test.callbacks.onError).toHaveBeenLastCalledWith(
      expect.stringContaining('Details: FramingError: recoverable'),
    );
    expect(mock.port.close).toHaveBeenCalledOnce();
    expect(mock.port.readable?.locked).toBe(false);
  });

  it('resets the consecutive recovery limit when real bytes arrive', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    const interrupted = vi.fn();
    test.callbacks.onReadError = interrupted;
    await test.reader.connect(settings);
    for (let index = 0; index < 5; index++) {
      mock.recover(new DOMException('recoverable', 'ParityError'));
      await vi.waitFor(() => expect(interrupted).toHaveBeenCalledTimes(index + 1));
      mock.enqueue(new Uint8Array([index]));
      await vi.waitFor(() => expect(test.callbacks.onData).toHaveBeenCalledTimes(index + 1));
    }
    expect(mock.port.close).not.toHaveBeenCalled();
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
    await test.reader.disconnect();
  });

  it('allows a recovery callback to cancel a protocol transaction and disconnect before new bytes arrive', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    test.callbacks.onReadError = () => {
      void test.reader.disconnect();
    };
    await test.reader.connect(settings);
    const streams = mock.recover(new DOMException('recoverable', 'FramingError'));
    await vi.waitFor(() => expect(mock.port.close).toHaveBeenCalledOnce());
    expect(streams.oldStream?.locked).toBe(false);
    expect(streams.replacement.locked).toBe(false);
    expect(test.callbacks.onData).not.toHaveBeenCalled();
    expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });
});

describe('serial error diagnostics', () => {
  it.each([
    [
      new DOMException('The operating system rejected this rate.', 'NotSupportedError'),
      'NotSupportedError: The operating system rejected this rate.',
    ],
    [
      Object.assign(new Error('Driver receive queue unavailable.'), { name: 'DriverError' }),
      'DriverError: Driver receive queue unavailable.',
    ],
    [{ message: 'Native backend failed.' }, 'Native backend failed.'],
    ['Native backend failed.', 'Native backend failed.'],
  ])(
    'preserves available connection error details without inventing a cause',
    async (cause, details) => {
      const mock = mockPort();
      const test = harness(mock.port);
      vi.mocked(mock.port.open).mockRejectedValueOnce(cause);
      await test.reader.connect(settings);
      expect(test.callbacks.onError).toHaveBeenCalledWith(
        expect.stringContaining(`Details: ${details}`),
      );
      expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
      expect(mock.sent).toEqual([]);
    },
  );

  it.each([undefined, null, {}, { name: '', message: '' }])(
    'omits diagnostic details when the connection failure supplies none (%j)',
    async (cause) => {
      const test = harness();
      vi.mocked(test.api.requestPort).mockRejectedValueOnce(cause);
      await test.reader.connect(settings);
      expect(test.callbacks.onError).toHaveBeenCalledWith(
        'The serial reader could not connect. Check its USB connection and serial settings, then try again.',
      );
      expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected');
    },
  );

  it('normalizes control characters, bounds details, and keeps markup as text without exposing a stack', async () => {
    const test = harness();
    const cause = Object.assign(
      new Error(`Driver\r\n\tfailed\u0000\u202E <device> ${'😕'.repeat(400)}`),
      { name: 'Custom\u001BError', stack: 'not part of diagnostics' },
    );
    vi.mocked(test.api.requestPort).mockRejectedValueOnce(cause);
    await test.reader.connect(settings);
    const message = vi.mocked(test.callbacks.onError).mock.calls[0][0];
    const details = message.split(' Details: ')[1];
    expect(details).toMatch(/^Custom Error: Driver failed <device> /u);
    expect(details).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(details)).toHaveLength(320);
    expect(details).toMatch(/😕…$/u);
    expect(message).not.toContain(cause.stack);
  });

  it('includes a native getReader failure while retaining the reconnect guidance', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    vi.mocked(mock.port.open).mockImplementationOnce(async () => {
      mock.port.readable = new ReadableStream<Uint8Array>();
      vi.spyOn(mock.port.readable, 'getReader').mockImplementation(() => {
        throw new TypeError('ReadableStream is already locked.');
      });
    });
    await test.reader.connect(settings);
    await vi.waitFor(() =>
      expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected'),
    );
    expect(test.callbacks.onError).toHaveBeenCalledWith(
      'The serial input is unavailable or already in use. Reconnect the reader and close other reader apps. Details: TypeError: ReadableStream is already locked.',
    );
  });

  it.each([
    [
      new DOMException('An operating system error occurred.', 'UnknownError'),
      ' Details: UnknownError: An operating system error occurred.',
    ],
    [
      Object.assign(new Error('Device input failed.'), { name: 'DriverReadError' }),
      ' Details: DriverReadError: Device input failed.',
    ],
    [undefined, ''],
  ])(
    'preserves actual read failure details without fabricating missing ones',
    async (cause, details) => {
      const mock = mockPort();
      const test = harness(mock.port);
      await test.reader.connect(settings);
      mock.fail(cause);
      await vi.waitFor(() =>
        expect(test.callbacks.onStatus).toHaveBeenLastCalledWith('disconnected'),
      );
      expect(test.callbacks.onError).toHaveBeenCalledWith(
        `Could not read from the serial device. Check its connection and serial settings, then reconnect.${details}`,
      );
      expect(mock.port.close).toHaveBeenCalledOnce();
      expect(mock.sent).toEqual([]);
    },
  );
});

describe('explicit serial line controls', () => {
  it('advertises capability without changing line levels at connect and applies only explicit selected levels', async () => {
    const mock = mockPort();
    mock.port.setSignals = vi.fn(async () => {});
    const test = harness(mock.port);
    await test.reader.connect(settings);
    expect(test.callbacks.onInfo).toHaveBeenCalledWith(
      expect.objectContaining({ supportsSignals: true }),
    );
    expect(mock.port.setSignals).not.toHaveBeenCalled();
    await test.reader.setSignals({ dataTerminalReady: false });
    expect(mock.port.setSignals).toHaveBeenCalledExactlyOnceWith({ dataTerminalReady: false });
    await test.reader.setSignals({ requestToSend: true });
    expect(mock.port.setSignals).toHaveBeenLastCalledWith({ requestToSend: true });
    expect(mock.sent).toEqual([]);
    await test.reader.disconnect();
  });

  it('rejects unsupported, disconnected, empty, unknown, or non-boolean controls', async () => {
    const mock = mockPort();
    const test = harness(mock.port);
    await expect(test.reader.setSignals({ dataTerminalReady: true })).rejects.toThrow(
      'Connect a serial reader',
    );
    await test.reader.connect(settings);
    await expect(test.reader.setSignals({ dataTerminalReady: true })).rejects.toThrow(
      'does not support',
    );
    mock.port.setSignals = vi.fn(async () => {});
    await expect(test.reader.setSignals({})).rejects.toThrow('Choose a DTR or RTS');
    await expect(test.reader.setSignals({ dataTerminalReady: undefined })).rejects.toThrow(
      'Choose a DTR or RTS',
    );
    await expect(test.reader.setSignals({ break: true } as SerialOutputSignals)).rejects.toThrow(
      'only DTR and RTS',
    );
    await expect(
      test.reader.setSignals({ dataTerminalReady: 'yes' } as unknown as SerialOutputSignals),
    ).rejects.toThrow('High, Low');
    expect(mock.port.setSignals).not.toHaveBeenCalled();
    await test.reader.disconnect();
  });

  it('prevents changing RTS under hardware flow control but permits explicit DTR', async () => {
    const mock = mockPort();
    mock.port.setSignals = vi.fn(async () => {});
    const test = harness(mock.port);
    await test.reader.connect({ ...settings, flowControl: 'hardware' });
    await expect(test.reader.setSignals({ requestToSend: true })).rejects.toThrow(
      'managed by hardware flow control',
    );
    await test.reader.setSignals({ dataTerminalReady: true });
    expect(mock.port.setSignals).toHaveBeenCalledExactlyOnceWith({ dataTerminalReady: true });
    await test.reader.disconnect();
  });

  it('serializes explicit line changes after writes and snapshots selected levels', async () => {
    const pending = deferred<void>();
    const mock = mockPort({ write: () => pending.promise });
    mock.port.setSignals = vi.fn(async () => {});
    const test = harness(mock.port);
    await test.reader.connect(settings);
    const write = test.reader.send(new Uint8Array([1]));
    const levels = { dataTerminalReady: true };
    const applying = test.reader.setSignals(levels);
    levels.dataTerminalReady = false;
    await vi.waitFor(() => expect(mock.sent).toHaveLength(1));
    expect(mock.port.setSignals).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([write, applying]);
    expect(mock.port.setSignals).toHaveBeenCalledExactlyOnceWith({ dataTerminalReady: true });
    await test.reader.disconnect();
  });

  it('cancels queued line changes without applying them after disconnect', async () => {
    const pending = deferred<void>();
    const mock = mockPort({ write: () => pending.promise });
    mock.port.setSignals = vi.fn(async () => {});
    const test = harness(mock.port);
    await test.reader.connect(settings);
    const write = test.reader.send(new Uint8Array([1])).catch(() => {});
    const outcome = test.reader
      .setSignals({ dataTerminalReady: true })
      .catch((error: Error) => error.message);
    await vi.waitFor(() => expect(mock.sent).toHaveLength(1));
    await test.reader.disconnect();
    await write;
    expect(await outcome).toContain('cancelled');
    expect(mock.port.setSignals).not.toHaveBeenCalled();
    pending.resolve();
  });

  it('bounds a stalled signal change and disconnects without stale continuation', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const mock = mockPort();
    mock.port.setSignals = vi.fn(() => pending.promise);
    const test = harness(mock.port);
    await test.reader.connect(settings);
    const outcome = test.reader
      .setSignals({ requestToSend: false })
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toContain('timed out after 5 seconds');
    await test.reader.disconnect();
    expect(mock.port.close).toHaveBeenCalledOnce();
    const statusCount = vi.mocked(test.callbacks.onStatus).mock.calls.length;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.callbacks.onStatus).toHaveBeenCalledTimes(statusCount);
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
