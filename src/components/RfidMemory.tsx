import { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, Copy, FilePenLine, LoaderCircle, Square } from 'lucide-react';
import { bytesToHex, bytesToText } from '../lib/rfidData';
import { buildReadCommand, buildWriteCommand, encodeMemoryValue } from '../lib/rfidMemory';
import type { MemoryProfile, MemoryState } from '../lib/rfidMemory';
import './RfidMemory.css';

export type MemoryReports = { inputReportId: number; outputReportId: number };
type Props = {
  keyboard: boolean;
  transport: 'hid' | 'serial';
  connected: boolean;
  unavailable: boolean;
  inputReportIds: number[];
  outputReportIds: number[];
  readerValue?: { bytes: Uint8Array; description: string };
  keyboardValue?: string;
  state: MemoryState;
  onRead: (profile: MemoryProfile, reports: MemoryReports) => void;
  onWrite: (profile: MemoryProfile, bytes: Uint8Array, reports: MemoryReports) => void;
  onCancel: () => void;
};

const INITIAL_PROFILE: MemoryProfile = {
  readCommand: '',
  writeTemplate: '',
  readPrefix: '',
  valueBytes: 4,
  writeAck: '',
  timeoutMs: 3000,
};

export default function RfidMemory({
  keyboard,
  transport,
  connected,
  unavailable,
  inputReportIds,
  outputReportIds,
  readerValue,
  keyboardValue,
  state,
  onRead,
  onWrite,
  onCancel,
}: Props) {
  const [profile, setProfile] = useState<MemoryProfile>({ ...INITIAL_PROFILE });
  const [value, setValue] = useState('');
  const [format, setFormat] = useState<'text' | 'hex'>('text');
  const [inputReport, setInputReport] = useState('');
  const [outputReport, setOutputReport] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const active = ['reading', 'writing', 'verifying'].includes(state.phase);
  const disabled = active || unavailable;
  const selectedOutput = outputReport || String(outputReportIds[0] ?? 0);
  const selectedInput = inputReport || (inputReportIds.length ? String(inputReportIds[0]) : '');
  const copySource = keyboard ? keyboardValue : (state.value ?? readerValue?.bytes);
  useEffect(() => {
    setCopied(false);
  }, [copySource]);
  const bytes = keyboard
    ? keyboardValue === undefined
      ? undefined
      : new TextEncoder().encode(keyboardValue)
    : (state.value ?? readerValue?.bytes);

  function edit(patch: Partial<MemoryProfile>) {
    setProfile((previous) => ({ ...previous, ...patch }));
    setError('');
  }
  function reports(): MemoryReports {
    if (transport === 'serial') return { inputReportId: 0, outputReportId: 0 };
    if (!/^\d+$/.test(selectedInput) || Number(selectedInput) < 0 || Number(selectedInput) > 255)
      throw new Error('Set the input report ID to a whole number from 0 to 255.');
    if (!/^\d+$/.test(selectedOutput) || !outputReportIds.includes(Number(selectedOutput)))
      throw new Error('Choose a memory output report ID declared by this HID reader.');
    return { inputReportId: Number(selectedInput), outputReportId: Number(selectedOutput) };
  }
  function run(write: boolean) {
    if (!connected || disabled) return;
    setError('');
    try {
      const ids = reports();
      if (write) {
        const data = encodeMemoryValue(value, format, profile.valueBytes);
        buildWriteCommand(profile, data);
        onWrite({ ...profile }, data, ids);
      } else {
        buildReadCommand(profile);
        onRead({ ...profile }, ids);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the protocol settings.');
    }
  }
  let readPreview = '';
  let writePreview = '';
  try {
    readPreview = bytesToHex(buildReadCommand(profile));
  } catch {
    /* Shown after the profile is complete. */
  }
  try {
    writePreview = bytesToHex(
      buildWriteCommand(profile, encodeMemoryValue(value, format, profile.valueBytes)),
    );
  } catch {
    /* Never guess bytes for an incomplete command. */
  }
  const title =
    state.phase === 'verified'
      ? 'Read-back matches'
      : state.phase === 'read'
        ? 'Value received'
        : state.phase === 'reading'
          ? 'Reading value…'
          : state.phase === 'writing'
            ? 'Sending write command…'
            : state.phase === 'verifying'
              ? 'Checking read-back…'
              : state.phase === 'error'
                ? 'Operation not confirmed'
                : 'Ready when your reader is';

  return (
    <section className="panel rfid-memory" aria-labelledby="rfid-memory-title">
      <div className="panel-heading">
        <div className="panel-title">
          <FilePenLine size={17} />
          <h2 id="rfid-memory-title">Tag memory</h2>
        </div>
        <span className="panel-caption">
          {keyboard ? 'Keyboard input · read only' : 'Read · write · compare'}
        </span>
      </div>
      <div className="rfid-body">
        {keyboard ? (
          <p className="rfid-hint">
            Start a keyboard test above to read the value your reader types. Keyboard input cannot
            send memory commands. Use USB serial or Raw HID reports with a writable reader to write
            a value.
          </p>
        ) : (
          <>
            <p className="rfid-hint">
              Configure the commands your reader uses to access a value. Include the intended tag
              and memory location in those commands. This generic panel matches a fixed response
              prefix and a fixed number of value bytes.
            </p>
            <details className="rfid-protocol" open>
              <summary>
                Protocol settings
                <span>USB {transport === 'serial' ? 'serial' : 'HID'} · custom commands</span>
              </summary>
              <fieldset disabled={disabled}>
                <div className="rfid-memory-fields">
                  <label className="rfid-field">
                    Read command (hex)
                    <textarea
                      aria-label="Read command (hex)"
                      rows={2}
                      value={profile.readCommand}
                      onChange={(event) => edit({ readCommand: event.target.value })}
                      placeholder="Full documented read command, in hex"
                    />
                  </label>
                  <label className="rfid-field">
                    Write command template (hex)
                    <textarea
                      aria-label="Write command template (hex)"
                      rows={2}
                      value={profile.writeTemplate}
                      onChange={(event) => edit({ writeTemplate: event.target.value })}
                      placeholder="Documented command with {value} at its payload position"
                    />
                    <small>
                      Use {'{value}'} exactly once. It is replaced with the exact bytes entered
                      below.
                    </small>
                  </label>
                  <label className="rfid-field">
                    Read response prefix (hex)
                    <input
                      aria-label="Read response prefix (hex)"
                      value={profile.readPrefix}
                      onChange={(event) => edit({ readPrefix: event.target.value })}
                      placeholder="Bytes immediately before the value"
                      autoComplete="off"
                    />
                  </label>
                  <label className="rfid-field">
                    Value length (bytes)
                    <input
                      aria-label="Value length (bytes)"
                      type="number"
                      min="1"
                      max="256"
                      value={profile.valueBytes || ''}
                      onChange={(event) => edit({ valueBytes: Number(event.target.value) })}
                    />
                  </label>
                  <label className="rfid-field">
                    Write acknowledgment (hex)
                    <input
                      aria-label="Write acknowledgment (hex)"
                      value={profile.writeAck}
                      onChange={(event) => edit({ writeAck: event.target.value })}
                      placeholder="Documented acknowledgment bytes"
                      autoComplete="off"
                    />
                  </label>
                  <label className="rfid-field">
                    Response timeout (ms)
                    <input
                      aria-label="Response timeout (ms)"
                      type="number"
                      min="500"
                      max="10000"
                      step="100"
                      value={profile.timeoutMs || ''}
                      onChange={(event) => edit({ timeoutMs: Number(event.target.value) })}
                    />
                  </label>
                  {transport === 'hid' && (
                    <>
                      <label className="rfid-field">
                        Input report ID
                        <input
                          aria-label="Input report ID"
                          type="number"
                          min="0"
                          max="255"
                          value={selectedInput}
                          onChange={(event) => {
                            setInputReport(event.target.value);
                            setError('');
                          }}
                        />
                        <small>
                          {inputReportIds.length
                            ? `Declared input IDs: ${inputReportIds.join(', ')}. Defaults to the first declared ID.`
                            : 'Connect to discover input report IDs.'}{' '}
                          Only responses from this report are matched.
                        </small>
                      </label>
                      <label className="rfid-field">
                        Memory output report ID
                        <input
                          aria-label="Memory output report ID"
                          type="number"
                          min="0"
                          max="255"
                          value={selectedOutput}
                          onChange={(event) => {
                            setOutputReport(event.target.value);
                            setError('');
                          }}
                        />
                        <small>
                          {outputReportIds.length
                            ? `Declared IDs: ${outputReportIds.join(', ')}`
                            : 'Connect to discover output report IDs.'}
                        </small>
                      </label>
                    </>
                  )}
                </div>
                <p className="rfid-memory-protocol-note">
                  Commands are sent as exact bytes, with no automatic line endings or HID padding.
                  Authentication, checksums, variable-length responses, and tag selection are
                  protocol-specific; this panel does not calculate them or change a factory UID.
                  Memory matching uses raw bytes, independently of the activity log’s receive
                  framing.
                </p>
              </fieldset>
            </details>
            <div className="rfid-memory-editor">
              <label className="rfid-field">
                Value to write
                <textarea
                  aria-label="Value to write"
                  rows={3}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError('');
                  }}
                  disabled={disabled}
                  placeholder={
                    format === 'text'
                      ? 'Enter a value that fits the configured byte length'
                      : 'Enter complete hex bytes'
                  }
                />
              </label>
              <div className="rfid-memory-write-options">
                <label className="rfid-field">
                  Value format
                  <select
                    aria-label="Value format"
                    value={format}
                    onChange={(event) => {
                      setFormat(event.target.value as typeof format);
                      setError('');
                    }}
                    disabled={disabled}
                  >
                    <option value="text">UTF-8 text</option>
                    <option value="hex">Hex bytes</option>
                  </select>
                </label>
                <p className="rfid-hint">
                  Exactly {profile.valueBytes || '…'} bytes. Text is encoded as UTF-8; values are
                  never padded or shortened.
                </p>
              </div>
            </div>
            <div className="rfid-memory-preview">
              <div>
                <span>READ COMMAND</span>
                <code>{readPreview || 'Complete the read settings to preview bytes.'}</code>
              </div>
              <div>
                <span>WRITE COMMAND</span>
                <code>
                  {writePreview || 'Complete the write settings and value to preview bytes.'}
                </code>
              </div>
            </div>
            <div className="rfid-memory-actions">
              <p>
                Write sends once, waits for the configured acknowledgment, then reads back to
                compare. A matching response is only as reliable as the protocol settings.
              </p>
              <div>
                <button
                  className="secondary-button"
                  disabled={!connected || disabled}
                  onClick={() => run(false)}
                >
                  <ArrowDownToLine size={15} />
                  Read value
                </button>
                <button
                  className="primary-button"
                  disabled={!connected || disabled}
                  onClick={() => run(true)}
                >
                  <FilePenLine size={15} />
                  Write and verify
                </button>
                {active && (
                  <button className="secondary-button" onClick={onCancel}>
                    <Square size={14} />
                    Cancel operation
                  </button>
                )}
              </div>
            </div>
            {!connected && (
              <p className="rfid-hint rfid-memory-connect">
                Connect a reader above to read or write a value.
              </p>
            )}
            {state.phase !== 'idle' && (
              <div
                className={`rfid-memory-status is-${state.phase}`}
                role={state.phase === 'error' ? 'alert' : 'status'}
              >
                {active ? (
                  <LoaderCircle className="spin" size={17} />
                ) : state.phase === 'verified' ? (
                  <Check size={17} />
                ) : (
                  <ArrowDownToLine size={17} />
                )}
                <div>
                  {!active && <small className="rfid-memory-last-operation">Last operation</small>}
                  <strong>{title}</strong>
                  <p>{state.message}</p>
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="rfid-alert" role="alert">
            {error}
          </p>
        )}
        {bytes !== undefined ? (
          <div className="rfid-memory-result">
            <div className="rfid-memory-result-title">
              <span>
                {keyboard
                  ? 'LAST CAPTURED VALUE'
                  : state.value
                    ? 'LAST RETURNED VALUE'
                    : 'LATEST READER INPUT'}
              </span>
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(new TextDecoder().decode(bytes));
                    setCopied(true);
                  } catch {
                    setError('Clipboard access is unavailable. Select the value to copy it.');
                  }
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? 'Copied' : 'Copy value'}
              </button>
            </div>
            <pre data-testid="rfid-memory-value">{bytesToText(bytes)}</pre>
            <code data-testid="rfid-memory-hex">{bytesToHex(bytes)}</code>
            {!keyboard && !state.value && readerValue && (
              <p className="rfid-hint">
                {readerValue.description}. This is received reader data; it has not been decoded as
                a memory response.
              </p>
            )}
            {!keyboard && state.value && (
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => {
                  setFormat('hex');
                  setValue(bytesToHex(bytes));
                  setError('');
                }}
              >
                Use these bytes in the write editor
              </button>
            )}
          </div>
        ) : (
          <div className="rfid-memory-empty">
            {keyboard
              ? 'Your next captured tag value will appear here.'
              : 'Read a value to see its text and exact bytes here.'}
          </div>
        )}
        <p className="rfid-memory-local">
          Protocol settings and value drafts stay in this workspace session. Shared links contain
          only the reader connection settings.
        </p>
      </div>
    </section>
  );
}
