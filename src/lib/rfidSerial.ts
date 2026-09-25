export type SerialOptions = {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
};

export type SerialStatus =
  'disconnected' | 'requesting' | 'connecting' | 'connected' | 'disconnecting';

export type SerialCallbacks = {
  onStatus: (status: SerialStatus) => void;
  onData: (data: Uint8Array) => void;
  onInfo: (info: { name: string; vendorId?: number; productId?: number }) => void;
  onError: (message: string) => void;
};

/** Minimal Web Serial types keep the adapter independent of ambient browser typings. */
export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export type SerialDisconnectEvent = { target?: unknown; port?: SerialPortLike };
export interface SerialApi {
  requestPort(): Promise<SerialPortLike>;
  addEventListener(type: 'disconnect', listener: (event: SerialDisconnectEvent) => void): void;
  removeEventListener(type: 'disconnect', listener: (event: SerialDisconnectEvent) => void): void;
}

type Session = {
  cancelled: boolean;
  connected: boolean;
  opened: boolean;
  port: SerialPortLike | null;
  opening: Promise<void> | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  reading: Promise<void> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writes: Promise<void>;
  writeAbort: AbortController;
  closing: Promise<void> | null;
  unplug: ((event: SerialDisconnectEvent) => void) | null;
};

const WRITE_TIMEOUT_MS = 5000;

function browserSerial(): SerialApi | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const serial = (navigator as Navigator & { serial?: SerialApi }).serial;
  return serial && typeof serial.requestPort === 'function' ? serial : undefined;
}

export function serialSupported(): boolean {
  return !!browserSerial();
}

function validateOptions(options: SerialOptions) {
  if (!Number.isSafeInteger(options.baudRate) || options.baudRate < 1) {
    throw new Error('Enter a positive whole-number baud rate from your reader’s documentation.');
  }
  if (
    ![7, 8].includes(options.dataBits) ||
    ![1, 2].includes(options.stopBits) ||
    !['none', 'even', 'odd'].includes(options.parity) ||
    !['none', 'hardware'].includes(options.flowControl)
  ) {
    throw new Error('Choose valid data bits, stop bits, parity, and flow control settings.');
  }
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

function connectionError(error: unknown, selecting: boolean): string {
  const name = errorName(error);
  if (name === 'NotFoundError' || name === 'AbortError')
    return selecting
      ? 'Device selection was cancelled. Choose a serial reader when you are ready.'
      : 'The serial connection was cancelled. Reconnect the reader to try again.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Serial access was denied. Allow access in your browser and use HTTPS or localhost.';
  if (name === 'NetworkError' || name === 'InvalidStateError')
    return 'The serial reader is busy or unavailable. Close other apps using it, check the USB connection, and try again.';
  if (name === 'NotSupportedError' || name === 'TypeError')
    return 'The reader could not open with these serial settings. Check the baud rate and connection settings in its documentation.';
  return 'The serial reader could not connect. Check its USB connection and serial settings, then try again.';
}

function boundedWrite(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const complete = (action: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = () =>
      complete(() => reject(new DOMException('Serial send cancelled.', 'AbortError')));
    const timer = setTimeout(
      () => complete(() => reject(new DOMException('Serial send timed out.', 'TimeoutError'))),
      WRITE_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      () => complete(resolve),
      (error: unknown) => complete(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}

/** No chooser, connection, command, or automatic reconnection runs until explicitly requested. */
export function createSerialReader(callbacks: SerialCallbacks, serial = browserSerial()) {
  let current: Session | null = null;
  const active = (session: Session) => current === session && !session.cancelled;

  function closeSession(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    session.closing = Promise.resolve().then(async () => {
      if (session.opening) await session.opening.catch(() => {});
      if (session.reading) await session.reading.catch(() => {});
      await session.writes.catch(() => {});
      if (session.opened && session.port) {
        try {
          await session.port.close();
        } catch (error) {
          // An unplugged port may already be closed by the browser.
          if (
            current === session &&
            !['InvalidStateError', 'NetworkError'].includes(errorName(error))
          ) {
            callbacks.onError(
              'The serial reader could not close cleanly. Unplug it before connecting again.',
            );
          }
        }
        session.opened = false;
      }
      if (current === session) {
        current = null;
        callbacks.onStatus('disconnected');
      }
    });
    session.cancelled = true;
    session.connected = false;
    if (session.unplug) serial?.removeEventListener('disconnect', session.unplug);
    session.unplug = null;
    if (current === session) callbacks.onStatus('disconnecting');
    session.writeAbort.abort();
    // Cancelling a reader resolves pending read() calls, which release the read lock.
    if (session.reader) {
      void session.reader.cancel().catch(() => {});
      if (!session.reading) {
        session.reader.releaseLock();
        session.reader = null;
      }
    }
    // Abort can itself await a stalled device write; the bounded send releases its lock.
    if (session.writer) void session.writer.abort().catch(() => {});
    return session.closing;
  }

  async function readLoop(session: Session) {
    const reader = session.reader;
    if (!reader) return;
    try {
      while (active(session)) {
        const { value, done } = await reader.read();
        if (!active(session)) break;
        if (done) {
          callbacks.onError('Serial input has ended. Reconnect the reader to continue.');
          break;
        }
        if (value?.byteLength) callbacks.onData(value.slice());
      }
    } catch (error) {
      if (active(session)) {
        callbacks.onError(
          errorName(error) === 'NetworkError'
            ? 'The serial connection was lost. Check the USB cable and reconnect the reader.'
            : 'Could not read from the serial device. Check its connection and serial settings, then reconnect.',
        );
      }
    } finally {
      reader.releaseLock();
      session.reader = null;
    }
  }

  async function connect(options: SerialOptions): Promise<void> {
    if (!serial) {
      callbacks.onError(
        'Web Serial is unavailable in this browser. Use a supported desktop browser such as Chrome or Edge over HTTPS or localhost.',
      );
      callbacks.onStatus('disconnected');
      return;
    }
    if (current) {
      callbacks.onError(
        current.cancelled
          ? 'Wait for the serial reader to finish disconnecting before connecting again.'
          : 'Disconnect the current serial reader before choosing another device.',
      );
      return;
    }
    try {
      validateOptions(options);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : 'Choose valid serial settings.');
      callbacks.onStatus('disconnected');
      return;
    }
    const selectedOptions = { ...options };
    const session: Session = {
      cancelled: false,
      connected: false,
      opened: false,
      port: null,
      opening: null,
      reader: null,
      reading: null,
      writer: null,
      writes: Promise.resolve(),
      writeAbort: new AbortController(),
      closing: null,
      unplug: null,
    };
    current = session;
    callbacks.onStatus('requesting');
    if (!active(session)) return;
    let selecting = true;
    try {
      // Invoke requestPort before awaiting anything so the caller's user gesture is retained.
      const port = await serial.requestPort();
      if (!active(session)) return;
      selecting = false;
      session.port = port;
      callbacks.onStatus('connecting');
      if (!active(session)) return;
      session.unplug = (event) => {
        if (!active(session) || (event.port ?? event.target) !== port) return;
        callbacks.onError(
          'The selected serial reader was disconnected. Reconnect its USB cable to try again.',
        );
        void closeSession(session);
      };
      serial.addEventListener('disconnect', session.unplug);
      // Store the opening task before it starts, so cancellation always waits for ownership.
      session.opening = Promise.resolve().then(async () => {
        if (session.cancelled) return;
        await port.open(selectedOptions);
        session.opened = true;
      });
      await session.opening;
      if (!active(session)) {
        await closeSession(session);
        return;
      }
      if (!port.readable) throw new Error('No serial input stream is available.');
      session.reader = port.readable.getReader();
      session.connected = true;
      const info = port.getInfo();
      const vendor = info.usbVendorId?.toString(16).padStart(4, '0').toUpperCase();
      const product = info.usbProductId?.toString(16).padStart(4, '0').toUpperCase();
      callbacks.onInfo({
        name: vendor
          ? `USB serial reader (${vendor}${product ? `:${product}` : ''})`
          : 'Serial reader',
        vendorId: info.usbVendorId,
        productId: info.usbProductId,
      });
      session.reading = readLoop(session);
      void session.reading.then(() => {
        if (active(session)) void closeSession(session);
      });
      if (active(session)) callbacks.onStatus('connected');
    } catch (error) {
      if (active(session)) callbacks.onError(connectionError(error, selecting));
      await closeSession(session);
    }
  }

  async function disconnect(): Promise<void> {
    if (current) await closeSession(current);
  }

  function send(data: Uint8Array): Promise<void> {
    const session = current;
    if (!session || !active(session) || !session.connected)
      return Promise.reject(new Error('Connect a serial reader before sending data.'));
    if (!(data instanceof Uint8Array) || !data.byteLength)
      return Promise.reject(new Error('Enter at least one byte to send.'));
    if (data.byteLength > 65_536)
      return Promise.reject(new Error('Send up to 65,536 bytes at a time.'));
    const bytes = data.slice();
    const task = session.writes.then(async () => {
      if (!active(session) || !session.connected)
        throw new Error('Sending was cancelled because the serial reader disconnected.');
      const writable = session.port?.writable;
      if (!writable) throw new Error('This serial reader has no writable connection.');
      let writer: WritableStreamDefaultWriter<Uint8Array>;
      try {
        writer = writable.getWriter();
      } catch {
        throw new Error(
          'The serial writer is busy. Wait for the current command to finish and try again.',
        );
      }
      session.writer = writer;
      try {
        await boundedWrite(writer.write(bytes), session.writeAbort.signal);
      } catch (error) {
        const cancelled = session.cancelled;
        if (active(session)) void closeSession(session);
        if (cancelled)
          throw new Error('Sending was cancelled because the serial reader disconnected.');
        if (errorName(error) === 'TimeoutError')
          throw new Error(
            'Sending timed out after 5 seconds. The reader was disconnected; check its connection and flow control settings.',
          );
        throw new Error(
          'Data could not be sent. Check the USB connection and reconnect the serial reader.',
        );
      } finally {
        writer.releaseLock();
        if (session.writer === writer) session.writer = null;
      }
    });
    // Preserve call order without allowing a failed command to reject the internal queue.
    session.writes = task.catch(() => {});
    return task;
  }

  return { connect, disconnect, send };
}
