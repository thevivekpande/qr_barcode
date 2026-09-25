export type HidCallbacks = {
  onStatus: (
    status: 'disconnected' | 'requesting' | 'connecting' | 'connected' | 'disconnecting',
  ) => void;
  onData: (data: Uint8Array, reportId: number) => void;
  onInfo: (info: {
    name: string;
    vendorId?: number;
    productId?: number;
    inputReportIds: number[];
    outputReportIds: number[];
  }) => void;
  onError: (message: string) => void;
};

// WebHID is not included in the project's DOM typings. Keep only the API surface used here.
export type HidCollection = {
  usagePage?: number;
  usage?: number;
  inputReports?: ReadonlyArray<{ reportId: number }>;
  outputReports?: ReadonlyArray<{ reportId: number }>;
  children?: ReadonlyArray<HidCollection>;
};

export type RawHidDevice = {
  opened: boolean;
  productName?: string;
  vendorId?: number;
  productId?: number;
  collections: ReadonlyArray<HidCollection>;
  open: () => Promise<void>;
  close: () => Promise<void>;
  sendReport: (reportId: number, data: Uint8Array) => Promise<void>;
  addEventListener: (type: 'inputreport', listener: (event: HidInputReport) => void) => void;
  removeEventListener: (type: 'inputreport', listener: (event: HidInputReport) => void) => void;
};

export type HidInputReport = {
  device: RawHidDevice;
  data: DataView;
  reportId: number;
};

export type RawHidApi = {
  requestDevice: (options: { filters: Array<Record<string, number>> }) => Promise<RawHidDevice[]>;
  addEventListener: (
    type: 'disconnect',
    listener: (event: { device: RawHidDevice }) => void,
  ) => void;
  removeEventListener: (
    type: 'disconnect',
    listener: (event: { device: RawHidDevice }) => void,
  ) => void;
};

type Status = Parameters<HidCallbacks['onStatus']>[0];
type Session = {
  generation: number;
  device: RawHidDevice | null;
  opening: boolean;
  ownsDevice: boolean;
  outputIds: Set<number>;
  inputListener?: (event: HidInputReport) => void;
  disconnectListener?: (event: { device: RawHidDevice }) => void;
  closing?: Promise<void>;
};

function browserHid(): RawHidApi | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const hid = (navigator as Navigator & { hid?: RawHidApi }).hid;
  return hid && typeof hid.requestDevice === 'function' ? hid : undefined;
}

export function hidSupported(): boolean {
  return browserHid() !== undefined;
}

function validReportId(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function reportInfo(device: RawHidDevice) {
  const inputIds = new Set<number>();
  const outputIds = new Set<number>();
  const vendorInputIds = new Set<number>();
  const blockedOutputIds = new Set<number>();
  const blockedInputIds = new Set<number>();
  const pending = device.collections.map((collection) => ({
    collection,
    blocked: false,
    vendor: false,
  }));
  while (pending.length) {
    const { collection, blocked: inherited, vendor: inheritedVendor } = pending.pop()!;
    const usage = collection.usage ?? -1;
    // Match the standard protected input/output usages. The browser remains the authority
    // for additional device-specific restrictions; this adapter never bypasses them.
    // https://source.chromium.org/chromium/chromium/src/+/main:services/device/public/cpp/hid/hid_report_utils.cc
    const blocked =
      inherited ||
      collection.usagePage === 0x07 ||
      (collection.usagePage === 0x01 &&
        ([0x01, 0x02, 0x06, 0x07].includes(usage) ||
          (usage >= 0x80 && usage <= 0x8f) ||
          (usage >= 0xa0 && usage <= 0xb6)));
    const vendor = inheritedVendor || (collection.usagePage ?? 0) >= 0xff00;
    for (const report of collection.outputReports ?? []) {
      if (validReportId(report.reportId)) {
        (blocked ? blockedOutputIds : outputIds).add(report.reportId);
      }
    }
    for (const report of collection.inputReports ?? []) {
      if (validReportId(report.reportId)) {
        (blocked ? blockedInputIds : inputIds).add(report.reportId);
        if (!blocked && vendor) vendorInputIds.add(report.reportId);
      }
    }
    for (const child of collection.children ?? [])
      pending.push({ collection: child, blocked, vendor });
  }
  for (const reportId of blockedOutputIds) outputIds.delete(reportId);
  for (const reportId of blockedInputIds) {
    inputIds.delete(reportId);
    vendorInputIds.delete(reportId);
  }
  return { inputIds, outputIds, vendorInputIds, blockedInputIds };
}

function errorMessage(error: unknown, action: 'connect' | 'send' | 'close'): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (action === 'close') {
    return 'The HID connection could not be closed cleanly. Unplug the reader if it remains busy.';
  }
  if (name === 'NotFoundError' || name === 'AbortError') {
    return 'No HID reader was selected. Choose Connect when you are ready to select a device.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'HID access was denied or blocked. Use HTTPS or localhost, allow device access, and use keyboard mode for keyboard readers.';
  }
  if (name === 'InvalidStateError' || name === 'NetworkError' || name === 'NotReadableError') {
    return action === 'send'
      ? 'The HID report could not be sent. The reader may be disconnected or busy in another app.'
      : 'The HID reader could not be opened. It may be disconnected or busy in another app; close other reader software and try again.';
  }
  return action === 'send'
    ? 'The HID report could not be sent. Check the report ID, payload length, and reader connection.'
    : 'The HID reader could not be connected. Check its connection and try again.';
}

/**
 * A raw-report transport only: no feature reports, polling, tag decoding, or automatic commands.
 * Call connect directly from a user gesture so the browser can show its device chooser.
 */
export function createHidReader(callbacks: HidCallbacks, api = browserHid()) {
  let generation = 0;
  let current: Session | null = null;
  let status: Status = 'disconnected';
  // Retain ownership while an old open/close settles so reconnect cannot race the same device.
  const owners = new WeakMap<RawHidDevice, Session>();

  const isCurrent = (session: Session) => current === session && generation === session.generation;
  const emitStatus = (next: Status) => {
    status = next;
    callbacks.onStatus(next);
  };

  function detach(session: Session) {
    if (session.device && session.inputListener) {
      session.device.removeEventListener('inputreport', session.inputListener);
      session.inputListener = undefined;
    }
    if (session.disconnectListener) {
      api?.removeEventListener('disconnect', session.disconnectListener);
      session.disconnectListener = undefined;
    }
  }

  function closeOwned(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    const device = session.device;
    if (!device || !session.ownsDevice) return Promise.resolve();
    session.closing = (async () => {
      try {
        if (device.opened) await device.close();
      } finally {
        if (owners.get(device) === session) owners.delete(device);
        session.ownsDevice = false;
      }
    })();
    return session.closing;
  }

  async function stop(session: Session, unplugged = false): Promise<void> {
    if (!isCurrent(session)) return;
    const stopGeneration = ++generation;
    current = null;
    detach(session);
    emitStatus('disconnecting');
    // A chooser cannot be programmatically dismissed, and open may still be pending.
    // Retire it immediately; connect's continuation will close a late successful open.
    if (!session.opening) {
      try {
        await closeOwned(session);
      } catch (error) {
        if (generation === stopGeneration && !unplugged)
          callbacks.onError(errorMessage(error, 'close'));
      }
    }
    if (generation === stopGeneration) emitStatus('disconnected');
  }

  async function connect(): Promise<void> {
    if (status !== 'disconnected' || current) return;
    if (!api) {
      callbacks.onError(
        'Raw USB HID is unavailable in this browser. Use a browser with WebHID support on HTTPS or localhost, or choose keyboard mode.',
      );
      emitStatus('disconnected');
      return;
    }
    const session: Session = {
      generation: ++generation,
      device: null,
      opening: false,
      ownsDevice: false,
      outputIds: new Set(),
    };
    current = session;
    emitStatus('requesting');
    try {
      if (!isCurrent(session)) return;
      // No await before requestDevice: the chooser must retain the caller's user activation.
      const devices = await api.requestDevice({ filters: [] });
      if (!isCurrent(session)) return;
      if (!devices.length) {
        callbacks.onError(
          'No HID reader was selected. Choose Connect when you are ready to select a device.',
        );
        await stop(session);
        return;
      }
      const interfaces = devices.map((device) => ({ device, info: reportInfo(device) }));
      // Composite readers can expose consumer-control interfaces before their data interface.
      // Prefer vendor input reports, then another input-capable interface, while retaining
      // output-only diagnostic support. Open one interface and send no automatic commands.
      const selected =
        interfaces.find(({ info }) => info.vendorInputIds.size && info.outputIds.size) ??
        interfaces.find(({ info }) => info.vendorInputIds.size) ??
        interfaces.find(({ info }) => info.inputIds.size && info.outputIds.size) ??
        interfaces.find(({ info }) => info.inputIds.size) ??
        interfaces.find(({ info }) => info.outputIds.size);
      if (!selected) {
        callbacks.onError(
          'This device exposes no accessible input or output reports for raw HID. If it sends tag text as keystrokes, choose keyboard mode. Protected keyboard, mouse, and system-control reports cannot be accessed here.',
        );
        await stop(session);
        return;
      }
      const { device, info } = selected;
      if (device.opened || owners.has(device)) {
        callbacks.onError(
          'This HID reader is already open or still disconnecting. Close other reader software, wait a moment, and connect again.',
        );
        await stop(session);
        return;
      }
      session.device = device;
      session.ownsDevice = true;
      owners.set(device, session);
      session.outputIds = info.outputIds;
      session.disconnectListener = (event) => {
        if (event.device !== device || !isCurrent(session)) return;
        callbacks.onError(
          'The HID reader was unplugged. Reconnect it and choose Connect to continue.',
        );
        void stop(session, true);
      };
      api.addEventListener('disconnect', session.disconnectListener);
      // Register before open: a device can deliver its first report as opening completes,
      // before the open promise continuation has announced the connected state.
      session.inputListener = (event) => {
        if (
          !isCurrent(session) ||
          (status !== 'connecting' && status !== 'connected') ||
          event.device !== device ||
          !validReportId(event.reportId) ||
          info.blockedInputIds.has(event.reportId)
        )
          return;
        // Respect DataView's subrange and detach the bytes from the browser's event buffer.
        const data = new Uint8Array(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength,
        );
        callbacks.onData(Uint8Array.from(data), event.reportId);
      };
      device.addEventListener('inputreport', session.inputListener);
      session.opening = true;
      emitStatus('connecting');
      if (!isCurrent(session)) {
        session.opening = false;
        await closeOwned(session);
        return;
      }
      try {
        await device.open();
      } finally {
        session.opening = false;
      }
      if (!isCurrent(session)) {
        await closeOwned(session);
        return;
      }
      callbacks.onInfo({
        name: device.productName || 'USB HID reader',
        vendorId: device.vendorId,
        productId: device.productId,
        inputReportIds: [...info.inputIds].sort((first, second) => first - second),
        outputReportIds: [...session.outputIds].sort((first, second) => first - second),
      });
      if (isCurrent(session)) emitStatus('connected');
    } catch (error) {
      if (isCurrent(session)) {
        callbacks.onError(errorMessage(error, 'connect'));
        await stop(session);
      } else {
        // Do not let a canceled open report errors into a newer connection's UI.
        detach(session);
        try {
          await closeOwned(session);
        } catch {
          /* Already canceled or unplugged. */
        }
      }
    }
  }

  async function disconnect(): Promise<void> {
    const session = current;
    if (session) await stop(session);
  }

  async function send(reportId: number, data: Uint8Array): Promise<void> {
    const session = current;
    const fail = (message: string): never => {
      callbacks.onError(message);
      throw new Error(message);
    };
    if (!session || status !== 'connected' || !session.device?.opened) {
      return fail('Connect a HID reader before sending an output report.');
    }
    if (!validReportId(reportId) || !session.outputIds.has(reportId)) {
      return fail(
        'Choose an output report ID declared by this reader. Keyboard and undeclared reports cannot be sent.',
      );
    }
    try {
      await session.device.sendReport(reportId, Uint8Array.from(data));
      if (!isCurrent(session))
        throw new Error('The HID connection changed before the output report completed.');
    } catch (error) {
      const message = isCurrent(session)
        ? errorMessage(error, 'send')
        : 'The HID connection changed before the output report completed.';
      if (isCurrent(session)) callbacks.onError(message);
      throw new Error(message);
    }
  }

  return { connect, disconnect, send };
}
