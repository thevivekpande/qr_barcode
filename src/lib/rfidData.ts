export type RfidSettings = {
  transport: 'hid' | 'serial';
  hidMode: 'keyboard' | 'raw';
  terminator: 'enter' | 'tab' | 'idle';
  idleMs: number;
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
  framing: 'lines' | 'idle' | 'chunks';
};

export const DEFAULT_RFID_SETTINGS: RfidSettings = {
  transport: 'hid',
  hidMode: 'keyboard',
  terminator: 'enter',
  idleMs: 150,
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  framing: 'lines',
};

export const MAX_FRAME_BYTES = 4096;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function bytesToText(bytes: Uint8Array): string {
  // Make control bytes visible instead of interpreting terminal escape sequences.
  return new TextDecoder()
    .decode(bytes)
    .replace(
      /[\x00-\x08\x0B-\x1F\x7F]/g,
      (value) => `\\x${value.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`,
    );
}

export function encodeCommand(
  value: string,
  format: 'text' | 'hex',
  ending: 'none' | 'lf' | 'crlf',
): Uint8Array {
  let bytes: Uint8Array;
  if (format === 'hex') {
    const hex = value.replace(/\s/g, '');
    if (!hex || !/^[\da-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      throw new Error('Enter complete hexadecimal bytes, for example 02 0A FF.');
    }
    if (hex.length / 2 > MAX_FRAME_BYTES)
      throw new Error('Keep test commands to 4,096 bytes or fewer.');
    bytes = Uint8Array.from(hex.match(/.{2}/g)!, (pair) => parseInt(pair, 16));
  } else {
    if (!value.length) throw new Error('Enter a command from your reader’s documentation.');
    bytes = new TextEncoder().encode(value);
  }
  const suffix = ending === 'crlf' ? [13, 10] : ending === 'lf' ? [10] : [];
  if (bytes.length + suffix.length > MAX_FRAME_BYTES)
    throw new Error('Keep test commands to 4,096 bytes or fewer.');
  return Uint8Array.from([...bytes, ...suffix]);
}

/** Frames raw bytes before decoding, preserving split UTF-8 sequences and CRLF boundaries. */
export function createByteFramer(mode: RfidSettings['framing'], limit = MAX_FRAME_BYTES) {
  let pending: number[] = [];
  let afterCR = false;
  let discarding = false;
  let overflow = false;
  return {
    push(bytes: Uint8Array): Uint8Array[] {
      if (mode === 'chunks') {
        if (bytes.length > limit) {
          overflow = true;
          return [];
        }
        return bytes.length ? [bytes.slice()] : [];
      }
      const frames: Uint8Array[] = [];
      for (const byte of bytes) {
        if (mode === 'lines' && (byte === 10 || byte === 13)) {
          if (!(byte === 10 && afterCR) && !discarding && pending.length)
            frames.push(Uint8Array.from(pending));
          pending = [];
          discarding = false;
          afterCR = byte === 13;
          continue;
        }
        afterCR = false;
        if (discarding) continue;
        if (pending.length >= limit) {
          pending = [];
          discarding = true;
          overflow = true;
          continue;
        }
        pending.push(byte);
      }
      return frames;
    },
    flush(): Uint8Array | null {
      const frame = !discarding && pending.length ? Uint8Array.from(pending) : null;
      pending = [];
      discarding = false;
      afterCR = false;
      return frame;
    },
    reset() {
      pending = [];
      afterCR = false;
      discarding = false;
      overflow = false;
    },
    takeOverflow() {
      const occurred = overflow;
      overflow = false;
      return occurred;
    },
    get pendingBytes() {
      return pending.length;
    },
  };
}
