import type { CodeSettings, CodeType } from './codes';
import { DEFAULT_RFID_SETTINGS } from './rfidData';
import type { RfidSettings } from './rfidData';

export type Mode = 'single' | 'live' | 'batch' | 'scan' | 'rfid';

export type CodeSnapshot = {
  text: string;
  type: CodeType;
  settings: CodeSettings;
};

export type BatchSnapshot = {
  texts: string[];
  type: CodeType;
  settings: CodeSettings;
};

export type WorkspaceState = {
  mode: Mode;
  codeType: CodeType;
  text: string;
  settings: CodeSettings;
  batchInput: string;
  frequency: string;
  length: string;
  prefix: string;
  charset: 'alphanumeric' | 'numeric' | 'alphabetic';
  advanced: boolean;
  single: CodeSnapshot | null;
  live: CodeSnapshot | null;
  batch: BatchSnapshot | null;
  scan: { text: string; format: string } | null;
  rfid: RfidSettings;
};

export const DEFAULT_SETTINGS: CodeSettings = {
  size: 512,
  foreground: '#26352B',
  background: '#FFFFFF',
  errorCorrection: 'M',
  showLabel: true,
};

export const DEFAULT_BATCH =
  '[\n  "PRODUCT-001",\n  "PRODUCT-002",\n  "PRODUCT-003",\n  "PRODUCT-004"\n]';

const DEFAULT_TEXT = 'https://example.com';
const MAX_JSON_LENGTH = 1_000_000;
const MAX_INLINE_URL_LENGTH = 6_000;
const SIZES = [256, 512, 1024];

export function createDefaultState(): WorkspaceState {
  return {
    mode: 'single',
    codeType: 'qr',
    text: DEFAULT_TEXT,
    settings: { ...DEFAULT_SETTINGS },
    batchInput: DEFAULT_BATCH,
    frequency: '3',
    length: '12',
    prefix: '',
    charset: 'alphanumeric',
    advanced: false,
    single: { text: DEFAULT_TEXT, type: 'qr', settings: { ...DEFAULT_SETTINGS } },
    live: null,
    batch: null,
    scan: null,
    rfid: { ...DEFAULT_RFID_SETTINGS },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCodeType(value: unknown): value is CodeType {
  return value === 'qr' || value === 'barcode';
}

function isErrorCorrection(value: unknown): value is CodeSettings['errorCorrection'] {
  return value === 'L' || value === 'M' || value === 'Q' || value === 'H';
}

function isCharset(value: unknown): value is WorkspaceState['charset'] {
  return value === 'alphanumeric' || value === 'numeric' || value === 'alphabetic';
}

function readColor(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#?[\da-f]{6}$/i.test(value)) return null;
  return value.startsWith('#') ? value : `#${value}`;
}

function readBoolean(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

function readNumberDraft(
  value: string | null,
  fallback: string,
  minimum: number,
  maximum: number,
  integer = false,
): string {
  if (value === null || !value.trim()) return fallback;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < minimum ||
    number > maximum ||
    (integer && !Number.isInteger(number))
  ) {
    return fallback;
  }
  return value;
}

function readSettings(value: unknown): CodeSettings | null {
  if (!isRecord(value)) return null;
  const foreground = readColor(value.foreground);
  const background = readColor(value.background);
  if (
    typeof value.size !== 'number' ||
    !SIZES.includes(value.size) ||
    foreground === null ||
    background === null ||
    !isErrorCorrection(value.errorCorrection) ||
    typeof value.showLabel !== 'boolean'
  ) {
    return null;
  }
  return {
    size: value.size,
    foreground,
    background,
    errorCorrection: value.errorCorrection,
    showLabel: value.showLabel,
  };
}

function readJson(value: string | null): unknown {
  if (value === null || value === 'none' || value.length > MAX_JSON_LENGTH) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readCodeSnapshot(value: unknown): CodeSnapshot | null {
  if (!isRecord(value) || typeof value.text !== 'string' || !isCodeType(value.type)) return null;
  const settings = readSettings(value.settings);
  if (!settings) return null;
  return { text: value.text, type: value.type, settings };
}

function readBatchSnapshot(value: unknown): BatchSnapshot | null {
  if (
    !isRecord(value) ||
    !isCodeType(value.type) ||
    !Array.isArray(value.texts) ||
    value.texts.length === 0 ||
    value.texts.length > 100 ||
    !value.texts.every((text): text is string => typeof text === 'string')
  ) {
    return null;
  }
  const settings = readSettings(value.settings);
  if (!settings) return null;
  return { texts: [...value.texts], type: value.type, settings };
}

/** Only the active workspace is restored; live generation never starts from a URL. */
export function readWorkspaceUrl(url: URL): WorkspaceState {
  const state = createDefaultState();
  const path = url.pathname.replace(/\/$/, '');
  state.mode =
    path === '/rfid'
      ? 'rfid'
      : path === '/live'
        ? 'live'
        : path === '/batch'
          ? 'batch'
          : path === '/scan'
            ? 'scan'
            : 'single';
  // Large drafts and collections live in the fragment, which is not sent in HTTP requests.
  // An incomplete fragment link must not accidentally restore unrelated query parameters.
  const query =
    url.searchParams.get('state') === 'fragment'
      ? new URLSearchParams(url.hash.startsWith('#state=') ? url.hash.slice(7) : '')
      : url.searchParams;
  const type = query.get('type');
  if (isCodeType(type)) state.codeType = type;
  const size = Number(query.get('size'));
  if (SIZES.includes(size)) state.settings.size = size;
  state.settings.foreground = readColor(query.get('fg')) ?? state.settings.foreground;
  state.settings.background = readColor(query.get('bg')) ?? state.settings.background;
  const correction = query.get('ec');
  if (isErrorCorrection(correction)) state.settings.errorCorrection = correction;
  state.settings.showLabel = readBoolean(query.get('label'), state.settings.showLabel);
  state.advanced = readBoolean(query.get('advanced'), state.advanced);

  if (state.mode === 'single') {
    state.text = query.get('text') ?? state.text;
    state.single = query.has('preview')
      ? readCodeSnapshot(readJson(query.get('preview')))
      : { text: state.text, type: state.codeType, settings: { ...state.settings } };
  } else if (state.mode === 'live') {
    state.frequency = readNumberDraft(query.get('frequency'), state.frequency, 0.5, 3600);
    state.length = readNumberDraft(query.get('length'), state.length, 4, 64, true);
    state.prefix = query.get('prefix') ?? state.prefix;
    const charset = query.get('charset');
    if (isCharset(charset)) state.charset = charset;
    state.live = readCodeSnapshot(readJson(query.get('preview')));
  } else if (state.mode === 'batch') {
    state.batchInput = query.get('input') ?? state.batchInput;
    state.batch = readBatchSnapshot(readJson(query.get('preview')));
  } else if (state.mode === 'scan') {
    const result = readJson(query.get('result'));
    if (isRecord(result) && typeof result.text === 'string' && typeof result.format === 'string') {
      state.scan = { text: result.text, format: result.format };
    }
  } else if (state.mode === 'rfid') {
    const r = state.rfid;
    if (query.get('reader') === 'serial') r.transport = 'serial';
    if (query.get('hidMode') === 'raw') r.hidMode = 'raw';
    const terminator = query.get('terminator');
    if (
      terminator === 'auto' ||
      terminator === 'enter' ||
      terminator === 'tab' ||
      terminator === 'idle'
    )
      r.terminator = terminator;
    r.idleMs = Number(readNumberDraft(query.get('idleMs'), String(r.idleMs), 50, 2000, true));
    r.baudRate = Number(
      readNumberDraft(query.get('baud'), String(r.baudRate), 50, 4_000_000, true),
    );
    if (query.get('dataBits') === '7') r.dataBits = 7;
    if (query.get('stopBits') === '2') r.stopBits = 2;
    const parity = query.get('parity');
    if (parity === 'even' || parity === 'odd') r.parity = parity;
    if (query.get('flow') === 'hardware') r.flowControl = 'hardware';
    const framing = query.get('framing');
    if (framing === 'auto' || framing === 'lines' || framing === 'idle' || framing === 'chunks')
      r.framing = framing;
  }
  return state;
}

function sameSettings(first: CodeSettings, second: CodeSettings): boolean {
  return (
    first.size === second.size &&
    first.foreground === second.foreground &&
    first.background === second.background &&
    first.errorCorrection === second.errorCorrection &&
    first.showLabel === second.showLabel
  );
}

/** Returns a relative URL and deliberately excludes inactive workspace drafts. */
export function buildWorkspaceUrl(state: WorkspaceState): string {
  const query = new URLSearchParams();
  if (state.mode === 'rfid') {
    const keys: [keyof RfidSettings, string][] = [
      ['transport', 'reader'],
      ['hidMode', 'hidMode'],
      ['terminator', 'terminator'],
      ['idleMs', 'idleMs'],
      ['baudRate', 'baud'],
      ['dataBits', 'dataBits'],
      ['stopBits', 'stopBits'],
      ['parity', 'parity'],
      ['flowControl', 'flow'],
      ['framing', 'framing'],
    ];
    for (const [key, parameter] of keys) {
      if (state.rfid[key] !== DEFAULT_RFID_SETTINGS[key])
        query.set(parameter, String(state.rfid[key]));
    }
    return `/rfid${query.size ? `?${query.toString()}` : ''}`;
  }
  if (state.codeType !== 'qr') query.set('type', state.codeType);
  if (state.settings.size !== DEFAULT_SETTINGS.size) query.set('size', String(state.settings.size));
  if (state.settings.foreground !== DEFAULT_SETTINGS.foreground) {
    query.set('fg', state.settings.foreground.replace(/^#/, ''));
  }
  if (state.settings.background !== DEFAULT_SETTINGS.background) {
    query.set('bg', state.settings.background.replace(/^#/, ''));
  }
  if (state.settings.errorCorrection !== DEFAULT_SETTINGS.errorCorrection) {
    query.set('ec', state.settings.errorCorrection);
  }
  if (!state.settings.showLabel) query.set('label', '0');
  if (state.advanced) query.set('advanced', '1');

  if (state.mode === 'single') {
    if (state.text !== DEFAULT_TEXT) query.set('text', state.text);
    if (state.single === null) query.set('preview', 'none');
    else if (
      state.single.text !== state.text ||
      state.single.type !== state.codeType ||
      !sameSettings(state.single.settings, state.settings)
    ) {
      query.set('preview', JSON.stringify(state.single));
    }
  } else if (state.mode === 'live') {
    if (state.frequency !== '3') query.set('frequency', state.frequency);
    if (state.length !== '12') query.set('length', state.length);
    if (state.prefix) query.set('prefix', state.prefix);
    if (state.charset !== 'alphanumeric') query.set('charset', state.charset);
    query.set('preview', state.live === null ? 'none' : JSON.stringify(state.live));
  } else if (state.mode === 'batch') {
    if (state.batchInput !== DEFAULT_BATCH) query.set('input', state.batchInput);
    query.set('preview', state.batch === null ? 'none' : JSON.stringify(state.batch));
  } else {
    query.set('result', state.scan === null ? 'none' : JSON.stringify(state.scan));
  }

  const search = query.toString();
  const inline = `/${state.mode}${search ? `?${search}` : ''}`;
  return inline.length > MAX_INLINE_URL_LENGTH
    ? `/${state.mode}?state=fragment#state=${search}`
    : inline;
}
