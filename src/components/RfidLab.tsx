import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Keyboard,
  LoaderCircle,
  PlugZap,
  Radio,
  Send,
  Square,
  Trash2,
  Unplug,
  Usb,
} from 'lucide-react';
import {
  bytesToHex,
  bytesToText,
  createByteFramer,
  encodeCommand,
  MAX_FRAME_BYTES,
} from '../lib/rfidData';
import type { RfidSettings } from '../lib/rfidData';
import { createHidReader, hidSupported } from '../lib/rfidHid';
import { createSerialReader, serialSupported } from '../lib/rfidSerial';
import type { SerialStatus } from '../lib/rfidSerial';
import { createMemorySession } from '../lib/rfidMemory';
import type { MemoryProfile, MemoryState } from '../lib/rfidMemory';
import RfidMemory from './RfidMemory';
import type { MemoryReports } from './RfidMemory';
import './RfidLab.css';

type Entry = {
  id: number;
  time: string;
  source: 'keyboard' | 'hid' | 'serial';
  direction: 'received' | 'sent';
  text: string;
  display: string;
  hex: string;
  bytes: number;
  reportId?: number;
};
type DeviceInfo = {
  name: string;
  vendorId?: number;
  productId?: number;
  outputReportIds?: number[];
  inputReportIds?: number[];
  supportsSignals?: boolean;
};
type LatestInput = {
  bytes: Uint8Array;
  total: number;
  source: 'hid' | 'serial';
  reportId?: number;
};
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export default function RfidLab({
  settings,
  onSettingsChange,
}: {
  settings: RfidSettings;
  onSettingsChange: (settings: RfidSettings) => void;
}) {
  const [status, setStatus] = useState<SerialStatus>('disconnected');
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [listening, setListening] = useState(false);
  const [focused, setFocused] = useState(false);
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [received, setReceived] = useState(0);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [sent, setSent] = useState(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [command, setCommand] = useState('');
  const [format, setFormat] = useState<'text' | 'hex'>('text');
  const [ending, setEnding] = useState<'none' | 'lf' | 'crlf'>('none');
  const [reportId, setReportId] = useState('0');
  const [sending, setSending] = useState(false);
  const [memoryState, setMemoryState] = useState<MemoryState>({ phase: 'idle', message: '' });
  const [latestInput, setLatestInput] = useState<LatestInput | null>(null);
  const [readerValue, setReaderValue] = useState<
    { bytes: Uint8Array; description: string } | undefined
  >();
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [dtr, setDtr] = useState('unchanged');
  const [rts, setRts] = useState('unchanged');
  const [applyingSignals, setApplyingSignals] = useState(false);
  const [copied, setCopied] = useState('');
  const [customBaud, setCustomBaud] = useState(!BAUD_RATES.includes(settings.baudRate));
  const mounted = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const readerInput = useRef<HTMLInputElement>(null);
  const keyboardToggle = useRef<HTMLButtonElement>(null);
  const inputValue = useRef('');
  const keyboardActive = useRef(false);
  const keyboardOverflow = useRef(false);
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framer = useRef(createByteFramer(settings.framing));
  const sequence = useRef(0);
  const operation = useRef(0);
  const hid = useRef<ReturnType<typeof createHidReader> | null>(null);
  const serial = useRef<ReturnType<typeof createSerialReader> | null>(null);
  const memorySession = useRef<ReturnType<typeof createMemorySession> | null>(null);
  const memoryTarget = useRef<MemoryReports & { transport: 'hid' | 'serial' }>({
    transport: 'serial',
    inputReportId: 0,
    outputReportId: 0,
  });
  const connectionStatus = useRef<SerialStatus>('disconnected');
  const memoryActive = ['reading', 'writing', 'verifying'].includes(memoryState.phase);
  const keyboard = settings.transport === 'hid' && settings.hidMode === 'keyboard';
  const busy = listening || status !== 'disconnected';
  const supported = settings.transport === 'serial' ? serialSupported() : hidSupported();

  function resetInput() {
    if (keyboardTimer.current) clearTimeout(keyboardTimer.current);
    keyboardTimer.current = null;
    inputValue.current = '';
    keyboardOverflow.current = false;
    if (mounted.current) setInput('');
  }
  function resetFraming() {
    if (serialTimer.current) clearTimeout(serialTimer.current);
    serialTimer.current = null;
    framer.current.reset();
    if (mounted.current) setPending(0);
  }
  function record(
    bytes: Uint8Array,
    source: Entry['source'],
    direction: Entry['direction'],
    id?: number,
  ) {
    if (!mounted.current) return;
    if (bytes.length > MAX_FRAME_BYTES) {
      setError('A frame exceeded 4,096 bytes and was discarded. Check the receive framing.');
      return;
    }
    const entry: Entry = {
      id: ++sequence.current,
      time: new Date().toISOString(),
      source,
      direction,
      text: new TextDecoder().decode(bytes),
      display: bytesToText(bytes),
      hex: bytesToHex(bytes),
      bytes: bytes.length,
      reportId: id,
    };
    setEntries((previous) => [entry, ...previous].slice(0, 100));
    if (direction === 'received') {
      setReceived((value) => value + 1);
      if (source !== 'keyboard')
        setReaderValue({
          bytes: bytes.slice(),
          description: source === 'hid' ? `HID input report ${id}` : 'Serial input frame',
        });
    } else setSent((value) => value + 1);
  }
  function observeInput(bytes: Uint8Array, source: 'hid' | 'serial', reportId?: number) {
    setWaitingForInput(false);
    setLatestInput({
      bytes: bytes.slice(0, MAX_FRAME_BYTES),
      total: bytes.length,
      source,
      reportId,
    });
  }
  function commitKeyboard() {
    if (
      !keyboardActive.current ||
      !mounted.current ||
      document.activeElement !== readerInput.current
    )
      return;
    if (inputValue.current && !keyboardOverflow.current) {
      const bytes = new TextEncoder().encode(inputValue.current);
      record(bytes, 'keyboard', 'received');
      setReceivedBytes((value) => value + bytes.length);
    }
    resetInput();
  }
  function stopKeyboard() {
    keyboardActive.current = false;
    resetInput();
    if (mounted.current) {
      setListening(false);
      setFocused(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    let memoryWasActive = false;
    const memory = createMemorySession({
      send: async (bytes) => {
        if (!mounted.current || connectionStatus.current !== 'connected')
          throw new Error('Connect a reader before accessing tag memory.');
        const token = operation.current;
        const target = { ...memoryTarget.current };
        if (target.transport === 'serial') await serial.current!.send(bytes);
        else await hid.current!.send(target.outputReportId, bytes);
        if (!mounted.current || token !== operation.current)
          throw new Error('The reader connection changed.');
        // Memory profiles can contain authentication bytes. Only the explicit
        // command preview shows them; do not copy requests into exported logs.
        setSent((value) => value + 1);
      },
      onState: (next) => {
        if (!mounted.current) return;
        const interrupted = next.phase === 'error' && memoryWasActive;
        memoryWasActive = ['reading', 'writing', 'verifying'].includes(next.phase);
        setMemoryState(
          interrupted
            ? { ...next, message: `${next.message} Reconnect the reader before another operation.` }
            : next,
        );
        if (interrupted) {
          // Generic protocols may have no transaction ID. Retire this connection
          // after an incomplete exchange so late bytes cannot satisfy a new one.
          void hid.current?.disconnect();
          void serial.current?.disconnect();
        }
      },
    });
    memorySession.current = memory;
    const onStatus = (next: SerialStatus) => {
      if (!mounted.current) return;
      connectionStatus.current = next;
      if (next !== 'connected') memory.cancel('The reader session ended.');
      setStatus(next);
      if (next === 'disconnected') {
        setDevice(null);
        setSending(false);
        setApplyingSignals(false);
        resetFraming();
        operation.current++;
      }
    };
    const onError = (message: string) => {
      if (mounted.current) setError(message);
    };
    const onInfo = (info: DeviceInfo) => {
      if (!mounted.current) return;
      setDevice(info);
      if (info.outputReportIds?.length) setReportId(String(info.outputReportIds[0]));
    };
    const hidReader = createHidReader({
      onStatus,
      onError,
      onInfo,
      onData: (bytes, id) => {
        if (!mounted.current) return;
        observeInput(bytes, 'hid', id);
        if (memoryTarget.current.transport === 'hid' && memoryTarget.current.inputReportId === id)
          memory.receive(bytes);
        setReceivedBytes((value) => value + bytes.length);
        record(bytes, 'hid', 'received', id);
      },
    });
    const serialReader = createSerialReader({
      onStatus,
      onError,
      onInfo,
      onReadError: (message) => {
        if (!mounted.current) return;
        resetFraming();
        memory.cancel('A serial read error interrupted the memory response.');
        setNotice(message);
      },
      onData: (bytes) => {
        if (!mounted.current) return;
        observeInput(bytes, 'serial');
        if (memoryTarget.current.transport === 'serial') memory.receive(bytes);
        setReceivedBytes((value) => value + bytes.length);
        for (const frame of framer.current.push(bytes)) record(frame, 'serial', 'received');
        setPending(framer.current.pendingBytes);
        if (framer.current.takeOverflow())
          setError('A frame exceeded 4,096 bytes and was discarded. Check the receive framing.');
        if (settingsRef.current.framing === 'idle' || settingsRef.current.framing === 'auto') {
          if (serialTimer.current) clearTimeout(serialTimer.current);
          serialTimer.current = setTimeout(() => {
            const frame = framer.current.flush();
            if (frame) record(frame, 'serial', 'received');
            if (mounted.current) setPending(0);
          }, settingsRef.current.idleMs);
        }
      },
    });
    hid.current = hidReader;
    serial.current = serialReader;
    const release = () => {
      operation.current++;
      memory.cancel('The reader session ended.');
      stopKeyboard();
      resetFraming();
      void hidReader.disconnect();
      void serialReader.disconnect();
    };
    const onHidden = () => {
      if (document.hidden) {
        release();
        setNotice(
          'Testing stopped while this tab was hidden. Reconnect or start a new keyboard test when ready.',
        );
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', release);
    return () => {
      mounted.current = false;
      release();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', release);
    };
  }, []);

  useEffect(() => {
    if (listening) readerInput.current?.focus();
  }, [listening]);
  useEffect(() => {
    setWaitingForInput(false);
    if (status !== 'connected' || latestInput) return;
    const timer = setTimeout(() => setWaitingForInput(true), 5000);
    return () => clearTimeout(timer);
  }, [status, latestInput]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  function update(patch: Partial<RfidSettings>) {
    if (busy) return;
    setError('');
    setNotice('');
    setDevice(null);
    setMemoryState({ phase: 'idle', message: '' });
    setLatestInput(null);
    setReaderValue(undefined);
    resetInput();
    resetFraming();
    onSettingsChange({ ...settings, ...patch });
  }
  function validSettings() {
    if (
      ((keyboard && (settings.terminator === 'idle' || settings.terminator === 'auto')) ||
        (settings.transport === 'serial' &&
          (settings.framing === 'idle' || settings.framing === 'auto'))) &&
      (!Number.isSafeInteger(settings.idleMs) || settings.idleMs < 50 || settings.idleMs > 2000)
    ) {
      setError('Set the idle gap between 50 and 2,000 milliseconds.');
      return false;
    }
    if (
      settings.transport === 'serial' &&
      (!Number.isSafeInteger(settings.baudRate) ||
        settings.baudRate < 50 ||
        settings.baudRate > 4000000)
    ) {
      setError('Set a whole-number baud rate between 50 and 4,000,000.');
      return false;
    }
    return true;
  }
  function connect() {
    if (busy || !validSettings()) return;
    setError('');
    setNotice('');
    setMemoryState({ phase: 'idle', message: '' });
    setLatestInput(null);
    setReaderValue(undefined);
    setDtr('unchanged');
    setRts('unchanged');
    resetFraming();
    framer.current = createByteFramer(settings.framing);
    operation.current++;
    if (settings.transport === 'serial') {
      const { baudRate, dataBits, stopBits, parity, flowControl } = settings;
      void serial.current?.connect({ baudRate, dataBits, stopBits, parity, flowControl });
    } else void hid.current?.connect();
  }
  async function disconnect() {
    operation.current++;
    memorySession.current?.cancel('The reader was disconnected.');
    resetFraming();
    await Promise.all([hid.current?.disconnect(), serial.current?.disconnect()]);
  }
  async function testKeyboardInput() {
    if (memorySession.current?.busy || sending || applyingSignals) return;
    await disconnect();
    if (!mounted.current || connectionStatus.current !== 'disconnected') return;
    const next: RfidSettings = {
      ...settingsRef.current,
      transport: 'hid',
      hidMode: 'keyboard',
      terminator: 'auto',
      idleMs: Math.max(50, Math.min(2000, settingsRef.current.idleMs || 150)),
    };
    settingsRef.current = next;
    onSettingsChange(next);
    setMemoryState({ phase: 'idle', message: '' });
    setLatestInput(null);
    setReaderValue(undefined);
    setError('');
    setNotice('Keyboard test started. Keep Reader input focused, then present a tag.');
    resetInput();
    keyboardActive.current = true;
    setListening(true);
  }
  async function applySignals() {
    if (status !== 'connected' || sending || applyingSignals || memorySession.current?.busy) return;
    const token = operation.current;
    setError('');
    setApplyingSignals(true);
    try {
      const signals: { dataTerminalReady?: boolean; requestToSend?: boolean } = {};
      if (dtr !== 'unchanged') signals.dataTerminalReady = dtr === 'high';
      if (rts !== 'unchanged' && settings.flowControl !== 'hardware')
        signals.requestToSend = rts === 'high';
      await serial.current!.setSignals(signals);
      if (mounted.current && token === operation.current)
        setNotice('Serial line signals applied. Present a tag to check input.');
    } catch (cause) {
      if (mounted.current && token === operation.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not apply the serial line signals.',
        );
    } finally {
      if (mounted.current && token === operation.current) setApplyingSignals(false);
    }
  }
  async function send() {
    if (sending || applyingSignals || memorySession.current?.busy || status !== 'connected') return;
    setError('');
    const token = operation.current;
    const source = settings.transport;
    try {
      const bytes = encodeCommand(command, format, source === 'hid' ? 'none' : ending);
      if (
        source === 'hid' &&
        (!/^\d+$/.test(reportId) || !device?.outputReportIds?.includes(Number(reportId)))
      ) {
        throw new Error('Choose an output report ID declared by this reader.');
      }
      setSending(true);
      if (source === 'hid') await hid.current!.send(Number(reportId), bytes);
      else await serial.current!.send(bytes);
      if (mounted.current && token === operation.current)
        record(bytes, source, 'sent', source === 'hid' ? Number(reportId) : undefined);
    } catch (cause) {
      if (mounted.current && token === operation.current)
        setError(cause instanceof Error ? cause.message : 'The command could not be sent.');
    } finally {
      if (mounted.current && token === operation.current) setSending(false);
    }
  }
  function readMemory(profile: MemoryProfile, reports: MemoryReports) {
    if (
      sending ||
      applyingSignals ||
      memorySession.current?.busy ||
      connectionStatus.current !== 'connected'
    )
      return;
    setError('');
    memoryTarget.current = { transport: settings.transport, ...reports };
    void memorySession.current?.read(profile);
  }
  function writeMemory(profile: MemoryProfile, bytes: Uint8Array, reports: MemoryReports) {
    if (
      sending ||
      applyingSignals ||
      memorySession.current?.busy ||
      connectionStatus.current !== 'connected'
    )
      return;
    setError('');
    memoryTarget.current = { transport: settings.transport, ...reports };
    void memorySession.current?.writeAndVerify(profile, bytes);
  }
  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) setCopied(key);
    } catch {
      if (mounted.current) setError('Clipboard access is unavailable. Select the text to copy it.');
    }
  }
  function clearLog() {
    resetFraming();
    resetInput();
    setEntries([]);
    setReceived(0);
    setReceivedBytes(0);
    setSent(0);
    setLatestInput(null);
    setReaderValue(undefined);
    setError('');
  }
  function exportLog() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'codeform-rfid-log.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const idleControl =
    (settings.transport === 'serial' &&
      (settings.framing === 'idle' || settings.framing === 'auto')) ||
    (keyboard && (settings.terminator === 'idle' || settings.terminator === 'auto'));
  const statusLabel = keyboard
    ? listening
      ? focused
        ? 'Listening'
        : 'Focus input to read'
      : 'Ready to test'
    : status === 'connected'
      ? 'Connected'
      : status === 'requesting'
        ? 'Choose a reader…'
        : status === 'connecting'
          ? 'Connecting…'
          : status === 'disconnecting'
            ? 'Disconnecting…'
            : 'Disconnected';

  return (
    <div className="rfid-workspace">
      <div className="rfid-grid">
        <section className="panel rfid-setup" aria-labelledby="rfid-reader-title">
          <div className="panel-heading">
            <div className="panel-title">
              <span className="step-number">01</span>
              <h2 id="rfid-reader-title">Reader setup</h2>
            </div>
            <Usb size={17} />
          </div>
          <div className="rfid-body">
            <div className="rfid-transport" aria-label="Connection type">
              <button
                aria-label="USB HID"
                aria-pressed={settings.transport === 'hid'}
                disabled={busy}
                className={settings.transport === 'hid' ? 'selected' : ''}
                onClick={() => update({ transport: 'hid' })}
              >
                <Keyboard size={18} />
                <span>
                  USB HID<small>Keyboard or raw reports</small>
                </span>
              </button>
              <button
                aria-label="USB serial"
                aria-pressed={settings.transport === 'serial'}
                disabled={busy}
                className={settings.transport === 'serial' ? 'selected' : ''}
                onClick={() => update({ transport: 'serial' })}
              >
                <Usb size={18} />
                <span>
                  USB serial<small>COM / serial port</small>
                </span>
              </button>
            </div>
            <fieldset disabled={busy} className="rfid-settings">
              <legend className="sr-only">Reader settings</legend>
              {settings.transport === 'hid' ? (
                <>
                  <label className="rfid-field">
                    Reader mode
                    <select
                      aria-label="Reader mode"
                      value={settings.hidMode}
                      onChange={(event) =>
                        update({ hidMode: event.target.value as RfidSettings['hidMode'] })
                      }
                    >
                      <option value="keyboard">Keyboard input (most USB readers)</option>
                      <option value="raw">Raw HID reports (WebHID)</option>
                    </select>
                  </label>
                  <p className="rfid-hint">
                    {keyboard
                      ? 'Use this for readers that type a tag into a text field. Plug in your reader, start the test, then tap a tag.'
                      : 'Select a reader with a vendor-specific HID interface. Standard keyboard readers use Keyboard input mode.'}
                  </p>
                  {keyboard && (
                    <label className="rfid-field">
                      End of scan
                      <select
                        aria-label="End of scan"
                        value={settings.terminator}
                        onChange={(event) =>
                          update({ terminator: event.target.value as RfidSettings['terminator'] })
                        }
                      >
                        <option value="auto">Automatic (Enter, Tab, or idle gap)</option>
                        <option value="enter">Enter key</option>
                        <option value="tab">Tab key</option>
                        <option value="idle">Idle gap (no suffix)</option>
                      </select>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div className="rfid-fields">
                    <label className="rfid-field">
                      Baud rate
                      <select
                        aria-label="Baud rate"
                        value={customBaud ? 'custom' : settings.baudRate}
                        onChange={(event) => {
                          setCustomBaud(event.target.value === 'custom');
                          if (event.target.value !== 'custom')
                            update({ baudRate: Number(event.target.value) });
                        }}
                      >
                        {BAUD_RATES.map((rate) => (
                          <option key={rate} value={rate}>
                            {rate.toLocaleString()}
                          </option>
                        ))}
                        <option value="custom">Custom…</option>
                      </select>
                    </label>
                    <label className="rfid-field">
                      Data bits
                      <select
                        aria-label="Data bits"
                        value={settings.dataBits}
                        onChange={(event) =>
                          update({ dataBits: Number(event.target.value) as 7 | 8 })
                        }
                      >
                        <option value="8">8 bits</option>
                        <option value="7">7 bits</option>
                      </select>
                    </label>
                    {customBaud && (
                      <label className="rfid-field rfid-wide">
                        Custom baud rate
                        <input
                          type="number"
                          min="50"
                          max="4000000"
                          value={settings.baudRate || ''}
                          onChange={(event) => update({ baudRate: Number(event.target.value) })}
                        />
                      </label>
                    )}
                    <label className="rfid-field">
                      Stop bits
                      <select
                        aria-label="Stop bits"
                        value={settings.stopBits}
                        onChange={(event) =>
                          update({ stopBits: Number(event.target.value) as 1 | 2 })
                        }
                      >
                        <option value="1">1 bit</option>
                        <option value="2">2 bits</option>
                      </select>
                    </label>
                    <label className="rfid-field">
                      Parity
                      <select
                        aria-label="Parity"
                        value={settings.parity}
                        onChange={(event) =>
                          update({ parity: event.target.value as RfidSettings['parity'] })
                        }
                      >
                        <option value="none">None</option>
                        <option value="even">Even</option>
                        <option value="odd">Odd</option>
                      </select>
                    </label>
                  </div>
                  <label className="rfid-field">
                    Flow control
                    <select
                      aria-label="Flow control"
                      value={settings.flowControl}
                      onChange={(event) =>
                        update({ flowControl: event.target.value as RfidSettings['flowControl'] })
                      }
                    >
                      <option value="none">None</option>
                      <option value="hardware">Hardware (RTS/CTS)</option>
                    </select>
                  </label>
                  <label className="rfid-field">
                    Receive framing
                    <select
                      aria-label="Receive framing"
                      value={settings.framing}
                      onChange={(event) =>
                        update({ framing: event.target.value as RfidSettings['framing'] })
                      }
                    >
                      <option value="auto">Automatic (line ending or idle gap)</option>
                      <option value="lines">Lines (CR / LF / CRLF)</option>
                      <option value="idle">Idle gap</option>
                      <option value="chunks">Raw chunks</option>
                    </select>
                  </label>
                  <p className="rfid-hint">
                    Match your reader’s serial settings. Raw chunks show bytes as received; a chunk
                    may contain part of a tag or several tags.
                  </p>
                </>
              )}
              {idleControl && (
                <label className="rfid-field">
                  Idle gap (ms)
                  <input
                    type="number"
                    min="50"
                    max="2000"
                    step="10"
                    value={settings.idleMs || ''}
                    onChange={(event) => update({ idleMs: Number(event.target.value) })}
                  />
                </label>
              )}
            </fieldset>
            <div
              className={`rfid-connection ${status === 'connected' || (listening && focused) ? 'is-connected' : ''}`}
              role="status"
            >
              <span className="rfid-status-dot" />
              <div>
                <strong>{statusLabel}</strong>
                {device && <small>{device.name}</small>}
              </div>
            </div>
            {keyboard ? (
              <>
                <button
                  ref={keyboardToggle}
                  className="primary-button rfid-connect"
                  onClick={() => {
                    if (listening) stopKeyboard();
                    else if (validSettings()) {
                      setError('');
                      setNotice('');
                      resetInput();
                      keyboardActive.current = true;
                      setListening(true);
                    }
                  }}
                >
                  {listening ? <Square size={15} /> : <Radio size={17} />}
                  {listening ? 'Stop keyboard test' : 'Start keyboard test'}
                </button>
                <label className="rfid-field rfid-reader-input">
                  Reader input
                  <input
                    ref={readerInput}
                    value={input}
                    disabled={!listening}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder={
                      listening
                        ? 'Tap a tag with this field focused…'
                        : 'Start the test to capture a tag'
                    }
                    onFocus={() => setFocused(true)}
                    onBlur={() => {
                      setFocused(false);
                      resetInput();
                    }}
                    onChange={(event) => {
                      if (!keyboardActive.current) return;
                      const value = event.target.value;
                      if (new TextEncoder().encode(value).length > MAX_FRAME_BYTES) {
                        keyboardOverflow.current = true;
                        inputValue.current = '';
                        setInput('');
                        setError(
                          'This scan exceeded 4,096 bytes and was discarded. Wait for its end-of-scan signal.',
                        );
                      } else if (!keyboardOverflow.current) {
                        inputValue.current = value;
                        setInput(value);
                      }
                      if (settings.terminator === 'idle' || settings.terminator === 'auto') {
                        if (keyboardTimer.current) clearTimeout(keyboardTimer.current);
                        keyboardTimer.current = setTimeout(commitKeyboard, settings.idleMs);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        stopKeyboard();
                        keyboardToggle.current?.focus();
                        return;
                      }
                      if (
                        ((settings.terminator === 'enter' || settings.terminator === 'auto') &&
                          event.key === 'Enter') ||
                        ((settings.terminator === 'tab' || settings.terminator === 'auto') &&
                          event.key === 'Tab' &&
                          !event.shiftKey &&
                          (inputValue.current.length > 0 || keyboardOverflow.current))
                      ) {
                        event.preventDefault();
                        commitKeyboard();
                      }
                    }}
                  />
                </label>
                {listening && !focused && (
                  <div className="rfid-support" role="status">
                    <p>
                      Capture is paused while Reader input is unfocused. Refocus it before scanning
                      a tag.
                    </p>
                    <button className="text-button" onClick={() => readerInput.current?.focus()}>
                      Focus reader input
                    </button>
                  </div>
                )}
                <p className="rfid-hint">
                  Capture runs only in this focused field. Keyboard readers cannot be identified or
                  distinguished from manual typing by the page. Press Escape to stop capture.
                </p>
              </>
            ) : (
              <>
                <button
                  className="primary-button rfid-connect"
                  disabled={status === 'disconnecting' || (!busy && !supported)}
                  onClick={() => {
                    if (busy) void disconnect();
                    else connect();
                  }}
                >
                  {status === 'requesting' ||
                  status === 'connecting' ||
                  status === 'disconnecting' ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : busy ? (
                    <Unplug size={17} />
                  ) : (
                    <PlugZap size={17} />
                  )}
                  {busy
                    ? 'Disconnect reader'
                    : settings.transport === 'serial'
                      ? 'Connect serial reader'
                      : 'Connect HID reader'}
                </button>
                {!supported && (
                  <p className="rfid-support">
                    {settings.transport === 'serial' ? 'Web Serial' : 'WebHID'} is unavailable in
                    this browser. Open this page in desktop Chrome over HTTPS or localhost. Keyboard
                    input mode is also available for keyboard readers.
                  </p>
                )}
                <p className="rfid-hint rfid-connect-hint">
                  Choose your reader in the browser’s device picker. Nothing is sent on connection.
                </p>
                {settings.transport === 'hid' && (
                  <div className="rfid-hid-help">
                    <p className="rfid-hint">
                      Some readers use raw HID for configuration and type tag values through their
                      keyboard interface.
                    </p>
                    <button
                      className="secondary-button"
                      disabled={
                        status === 'requesting' ||
                        status === 'connecting' ||
                        status === 'disconnecting' ||
                        sending ||
                        memoryActive
                      }
                      onClick={() => void testKeyboardInput()}
                    >
                      <Keyboard size={15} />
                      Test keyboard input
                    </button>
                  </div>
                )}
                {waitingForInput && (
                  <p className="rfid-support" role="status">
                    No input received yet.{' '}
                    {settings.transport === 'serial'
                      ? 'Check the selected port and the reader’s baud rate and flow control. Some readers also require line signals or a documented polling command.'
                      : 'Try Test keyboard input if scanning types text. A raw HID connection alone does not start reading tags; some devices need a documented command.'}
                  </p>
                )}
                {device?.inputReportIds && (
                  <p className="rfid-hint rfid-reports">
                    Input report IDs:{' '}
                    {device.inputReportIds.length
                      ? device.inputReportIds.join(', ')
                      : 'none declared'}
                    . Output report IDs:{' '}
                    {device.outputReportIds?.length
                      ? device.outputReportIds.join(', ')
                      : 'none declared'}
                    .
                  </p>
                )}
                {settings.transport === 'serial' &&
                  status === 'connected' &&
                  device?.supportsSignals && (
                    <details className="rfid-signals">
                      <summary>Serial line signals</summary>
                      <p className="rfid-hint">
                        Use these only when required by your reader. Changing DTR or RTS can change
                        its operating mode. The app leaves both unchanged on connection.
                      </p>
                      <div className="rfid-fields">
                        <label className="rfid-field">
                          DTR
                          <select
                            aria-label="DTR"
                            value={dtr}
                            onChange={(event) => setDtr(event.target.value)}
                            disabled={sending || memoryActive || applyingSignals}
                          >
                            <option value="unchanged">Leave unchanged</option>
                            <option value="high">High (assert)</option>
                            <option value="low">Low (deassert)</option>
                          </select>
                        </label>
                        <label className="rfid-field">
                          RTS
                          <select
                            aria-label="RTS"
                            value={rts}
                            onChange={(event) => setRts(event.target.value)}
                            disabled={
                              sending ||
                              memoryActive ||
                              applyingSignals ||
                              settings.flowControl === 'hardware'
                            }
                          >
                            <option value="unchanged">Leave unchanged</option>
                            <option value="high">High (assert)</option>
                            <option value="low">Low (deassert)</option>
                          </select>
                        </label>
                      </div>
                      {settings.flowControl === 'hardware' && (
                        <p className="rfid-hint">RTS is managed by hardware flow control.</p>
                      )}
                      <button
                        className="secondary-button"
                        onClick={() => void applySignals()}
                        disabled={
                          sending ||
                          memoryActive ||
                          applyingSignals ||
                          (dtr === 'unchanged' &&
                            (rts === 'unchanged' || settings.flowControl === 'hardware'))
                        }
                      >
                        {applyingSignals ? 'Applying…' : 'Apply line signals'}
                      </button>
                    </details>
                  )}
              </>
            )}
          </div>
        </section>

        <section className="panel rfid-console" aria-labelledby="rfid-console-title">
          <div className="panel-heading">
            <div className="panel-title">
              <span className="step-number">02</span>
              <h2 id="rfid-console-title">Reader activity</h2>
            </div>
            <span className="rfid-session-label">
              <span />
              THIS SESSION
            </span>
          </div>
          <div className="rfid-stats">
            <div className="rfid-stat">
              <span>RECEIVED</span>
              <strong>
                {received.toLocaleString()}
                <small>frames</small>
              </strong>
            </div>
            <div className="rfid-stat">
              <span>DATA IN</span>
              <strong>
                {receivedBytes.toLocaleString()}
                <small>bytes</small>
              </strong>
            </div>
            <div className="rfid-stat">
              <span>SENT</span>
              <strong>
                {sent.toLocaleString()}
                <small>commands</small>
              </strong>
            </div>
          </div>
          <div className="rfid-log-toolbar">
            <span>
              {entries.length
                ? `Latest ${entries.length} / 100 entries`
                : latestInput
                  ? 'Raw input received'
                  : 'Waiting for your first read'}
              {pending > 0 && (
                <small>
                  {pending} bytes waiting for{' '}
                  {settings.framing === 'idle' || settings.framing === 'auto'
                    ? 'idle gap or line ending'
                    : 'a line ending'}
                </small>
              )}
            </span>
            <div>
              <button
                title="Export log"
                aria-label="Export log"
                disabled={!entries.length}
                onClick={exportLog}
              >
                <Download size={15} />
              </button>
              <button
                title="Clear log"
                aria-label="Clear log"
                disabled={!entries.length && !pending && !receivedBytes}
                onClick={clearLog}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          {latestInput && (
            <details
              className="rfid-raw-input"
              open={entries.length === 0 ? true : undefined}
              data-testid="rfid-last-input"
            >
              <summary>
                Latest USB{' '}
                {latestInput.source === 'hid' ? `report ${latestInput.reportId}` : 'chunk'} ·{' '}
                {latestInput.total} bytes
              </summary>
              <pre>{bytesToText(latestInput.bytes) || '(empty report)'}</pre>
              <code>{bytesToHex(latestInput.bytes) || '—'}</code>
              <p>
                Raw bytes before framing or memory decoding.
                {latestInput.total > MAX_FRAME_BYTES &&
                  ' Preview limited to the first 4,096 bytes.'}
              </p>
            </details>
          )}
          <div
            className="rfid-log"
            data-testid="rfid-log"
            tabIndex={0}
            aria-label="Reader activity log"
          >
            {!entries.length ? (
              <div className="rfid-empty">
                <div className="rfid-empty-icon">
                  <Radio size={33} strokeWidth={1.3} />
                </div>
                <h3>
                  {latestInput
                    ? 'Input is reaching the app.'
                    : status === 'connected'
                      ? 'Reader connected. Ready for input.'
                      : 'A tap starts the conversation.'}
                </h3>
                <p>
                  {latestInput
                    ? 'Your raw bytes are visible above. Use Automatic receive framing for readers that do not send a line ending.'
                    : keyboard
                      ? 'Start a keyboard test, focus the reader input, and present a tag.'
                      : status === 'connected'
                        ? 'Present a tag. Readers that require polling need a documented command before they send data.'
                        : 'Connect your reader and present a tag. Readers that require polling need a command from their manual.'}
                </p>
                <span>TEXT · HEX · TIMESTAMP</span>
              </div>
            ) : (
              entries.map((entry) => (
                <article
                  className={`rfid-entry ${entry.direction}`}
                  key={entry.id}
                  data-testid="rfid-entry"
                >
                  <div className="rfid-entry-meta">
                    <span>
                      {entry.direction === 'received' ? (
                        <ArrowDownLeft size={13} />
                      ) : (
                        <ArrowUpRight size={13} />
                      )}
                      {entry.direction === 'received' ? 'Received' : 'Sent'} ·{' '}
                      {entry.source === 'keyboard'
                        ? 'Keyboard'
                        : entry.source === 'hid'
                          ? 'HID'
                          : 'Serial'}
                      {entry.reportId !== undefined && ` · Report ${entry.reportId}`}
                    </span>
                    <time dateTime={entry.time}>
                      {new Date(entry.time).toLocaleTimeString([], { hour12: false })}
                    </time>
                  </div>
                  <pre>{entry.display || '(empty report)'}</pre>
                  <div className="rfid-entry-hex">
                    <span>HEX</span>
                    <code>{entry.hex || '—'}</code>
                  </div>
                  <div className="rfid-entry-actions">
                    <small>{entry.bytes} bytes</small>
                    <button onClick={() => void copy(entry.text, `${entry.id}-text`)}>
                      {copied === `${entry.id}-text` ? <Check size={12} /> : <Copy size={12} />}Copy
                      text
                    </button>
                    <button onClick={() => void copy(entry.hex, `${entry.id}-hex`)}>
                      {copied === `${entry.id}-hex` ? <Check size={12} /> : <Copy size={12} />}Copy
                      hex
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="rfid-log-note">
            <Activity size={13} />
            <span>
              UTF-8 text and exact payload bytes. Line mode removes CR/LF separators. Raw data may
              need your reader’s protocol to identify a tag.
            </span>
          </div>
        </section>
      </div>

      {error && (
        <p className="rfid-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rfid-notice" role="status">
          {notice}
        </p>
      )}
      <RfidMemory
        keyboard={keyboard}
        transport={settings.transport}
        connected={status === 'connected'}
        unavailable={sending || applyingSignals}
        inputReportIds={device?.inputReportIds ?? []}
        outputReportIds={device?.outputReportIds ?? []}
        readerValue={readerValue}
        keyboardValue={
          entries.find((entry) => entry.source === 'keyboard' && entry.direction === 'received')
            ?.text
        }
        state={memoryState}
        onRead={readMemory}
        onWrite={writeMemory}
        onCancel={() =>
          memorySession.current?.cancel(
            'Operation canceled. A command already sent cannot be recalled.',
          )
        }
      />
      {!keyboard && (
        <section className="panel rfid-command" aria-labelledby="rfid-command-title">
          <div className="panel-heading">
            <div className="panel-title">
              <Send size={16} />
              <h2 id="rfid-command-title">Test command</h2>
            </div>
            <span className="panel-caption">Manual send only</span>
          </div>
          <div className="rfid-body">
            <p className="rfid-hint">
              Use a command and payload length from your reader’s manual. Commands and tag decoding
              differ between models; no polling or configuration commands run automatically.
            </p>
            <div className="rfid-command-grid">
              <label className="rfid-field">
                Command data
                <textarea
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder={
                    format === 'hex'
                      ? 'Hex bytes, e.g. 02 0A FF'
                      : 'Enter your reader’s documented command'
                  }
                  rows={3}
                  maxLength={MAX_FRAME_BYTES * 3}
                  disabled={sending || memoryActive || applyingSignals}
                />
              </label>
              <div className="rfid-fields">
                <label className="rfid-field">
                  Transmit format
                  <select
                    aria-label="Transmit format"
                    value={format}
                    onChange={(event) => setFormat(event.target.value as typeof format)}
                    disabled={sending || memoryActive || applyingSignals}
                  >
                    <option value="text">UTF-8 text</option>
                    <option value="hex">Hex bytes</option>
                  </select>
                </label>
                <label className="rfid-field">
                  Line ending
                  <select
                    aria-label="Line ending"
                    value={settings.transport === 'hid' ? 'none' : ending}
                    onChange={(event) => setEnding(event.target.value as typeof ending)}
                    disabled={sending || memoryActive || applyingSignals}
                  >
                    <option value="none">None</option>
                    {settings.transport === 'serial' && (
                      <>
                        <option value="lf">LF (\n)</option>
                        <option value="crlf">CRLF (\r\n)</option>
                      </>
                    )}
                  </select>
                </label>
                {settings.transport === 'hid' && (
                  <label className="rfid-field rfid-wide">
                    Output report ID
                    <input
                      type="number"
                      min="0"
                      max="255"
                      aria-label="Output report ID"
                      value={reportId}
                      onChange={(event) => setReportId(event.target.value)}
                      disabled={sending || memoryActive || applyingSignals}
                    />
                    <small>
                      {device
                        ? device.outputReportIds?.length
                          ? `Declared IDs: ${device.outputReportIds.join(', ')}`
                          : 'This reader declares no writable output reports.'
                        : 'Connect to discover writable report IDs.'}
                    </small>
                  </label>
                )}
              </div>
            </div>
            <div className="rfid-send-row">
              <span>
                A successful write confirms delivery to the browser’s USB API; check the log for a
                reader response.
              </span>
              <button
                className="primary-button"
                disabled={
                  status !== 'connected' ||
                  sending ||
                  memoryActive ||
                  applyingSignals ||
                  (settings.transport === 'hid' && !device?.outputReportIds?.length)
                }
                onClick={() => void send()}
              >
                {sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {sending ? 'Sending…' : 'Send command'}
              </button>
            </div>
          </div>
        </section>
      )}
      <p className="rfid-bottom-note">
        Reader settings travel with your link. Captured data, commands, and memory profiles stay in
        this session; export the activity log to keep a copy of received data.
      </p>
    </div>
  );
}
