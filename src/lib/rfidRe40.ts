/**
 * RE40 binary protocol, revision 0x0800.
 *
 * Wire layout and constants were checked against the manufacturer's public
 * SDK (https://www.jnxrfid.com/assets/files/SDK.zip), Linux Java rfid.jar:
 * NGEApi.WriteCmd/computeCRC/Nge_GetCMD/checkACK/formatPayloadToParam,
 * QueuingPackets.QueueReturnPackets, Packets, Params and RespPackets.
 * This module only constructs/decodes bytes: importing it never opens a device
 * or executes the SDK's Connect method (which resets reader configuration).
 */

export type Re40Packet = { type: number; payload: Uint8Array };
export type Re40Firmware = {
  major: number;
  minor: number;
  build: number;
  flag: number;
  version: string;
};
export type Re40Ack = { command: number; status: number };
export type Re40Tag = {
  epc: string;
  antenna?: number;
  rssi?: number;
  channel?: number;
  seenCount?: number;
};
export type Re40StopReason = { flags: number; message: string; error: boolean };

export const RE40 = {
  revision: 0x0800,
  maxPayloadBytes: 4096,
  command: { set: 0x0801, get: 0x0802, stop: 0x0808, start: 0x0809 },
  response: { ack: 0x0801, get: 0x0811, stopSummary: 0x0a91 },
  parameter: { firmware: 0x0001, stopCondition: 0x0005, inventory1: 0x0201, olio1: 0x0401 },
} as const;

function word(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} must be an unsigned 16-bit integer.`);
  }
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** CRC-16: polynomial 0x1021, initial 0xffff, final xor 0xffff, MSB first. */
export function re40Crc(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  }
  return crc ^ 0xffff;
}

/** AA AB | type (BE16) | payload length (BE16) | payload | CRC (BE16). */
export function encodeRe40Packet(type: number, payload = new Uint8Array()): Uint8Array {
  word(type, 'Packet type');
  if (!(payload instanceof Uint8Array) || payload.length > RE40.maxPayloadBytes) {
    throw new Error('An RE40 packet can contain at most 4,096 payload bytes.');
  }
  const frame = new Uint8Array(payload.length + 8);
  frame.set([0xaa, 0xab, type >>> 8, type & 0xff, payload.length >>> 8, payload.length & 0xff]);
  frame.set(payload, 6);
  const crc = re40Crc(frame.subarray(2, frame.length - 2));
  frame[frame.length - 2] = crc >>> 8;
  frame[frame.length - 1] = crc & 0xff;
  return frame;
}

/** Retains at most one bounded frame, including across arbitrary serial chunks. */
export function createRe40Decoder() {
  const buffer = new Uint8Array(RE40.maxPayloadBytes + 8);
  let length = 0;
  let checksumErrors = 0;

  function drop(count: number) {
    buffer.copyWithin(0, count, length);
    length -= count;
  }

  return {
    get bufferedBytes() {
      return length;
    },
    get checksumErrors() {
      return checksumErrors;
    },
    reset() {
      length = 0;
      checksumErrors = 0;
    },
    push(bytes: Uint8Array): Re40Packet[] {
      const packets: Re40Packet[] = [];
      for (const byte of bytes) {
        buffer[length++] = byte;
        while (length) {
          if (buffer[0] !== 0xaa || (length > 1 && buffer[1] !== 0xab)) {
            drop(1);
            continue;
          }
          if (length < 6) break;
          const payloadLength = readWord(buffer, 4);
          if (payloadLength > RE40.maxPayloadBytes) {
            drop(1);
            continue;
          }
          const frameLength = payloadLength + 8;
          if (length < frameLength) break;
          const expected = readWord(buffer, frameLength - 2);
          if (re40Crc(buffer.subarray(2, frameLength - 2)) !== expected) {
            checksumErrors++;
            // Search the rejected candidate for another SOF; payload bytes may
            // contain AA AB, so never resynchronize inside a valid frame.
            drop(1);
            continue;
          }
          packets.push({ type: readWord(buffer, 2), payload: buffer.slice(6, frameLength - 2) });
          drop(frameLength);
        }
      }
      return packets;
    },
  };
}

export function buildRe40GetParameter(parameter: number): Uint8Array {
  word(parameter, 'Parameter');
  return encodeRe40Packet(RE40.command.get, Uint8Array.of(parameter >>> 8, parameter & 0xff));
}

/** Read-only firmware identification. Does not reset/configure/start the reader. */
export function buildRe40IdentifyCommand(): Uint8Array {
  return buildRe40GetParameter(RE40.parameter.firmware);
}

/** Returns a copy only when both the reply type and requested parameter match. */
export function decodeRe40Parameter(packet: Re40Packet, parameter: number): Uint8Array | null {
  if (
    packet.type !== RE40.response.get ||
    packet.payload.length < 2 ||
    readWord(packet.payload, 0) !== parameter
  )
    return null;
  return packet.payload.slice(2);
}

export function decodeRe40Firmware(packet: Re40Packet): Re40Firmware | null {
  const value = decodeRe40Parameter(packet, RE40.parameter.firmware);
  if (!value || value.length !== 4) return null;
  const [major, minor, build, flag] = value;
  return { major, minor, build, flag, version: `${major}.${minor}.${build}.${flag}` };
}

/** A successful ACK alone does not contain a parameter value or firmware. */
export function decodeRe40Ack(packet: Re40Packet): Re40Ack | null {
  if (packet.type !== RE40.response.ack || packet.payload.length !== 3) return null;
  return { command: readWord(packet.payload, 0), status: packet.payload[2] };
}

/** These commands act on the current configuration; they do not set power/region. */
export function buildRe40StartCommand(): Uint8Array {
  return encodeRe40Packet(RE40.command.start);
}

export function buildRe40StopCommand(): Uint8Array {
  return encodeRe40Packet(RE40.command.stop);
}

/**
 * Configure one finite C1G2 inventory without changing existing RF settings.
 * The caller must STOP successfully, GET parameter 0x0401, then pass its 25-byte
 * value (excluding the parameter ID). Each returned SET needs its own ACK.
 * START is deliberately separate; this never stores settings to NVM or invokes
 * tag access, resets, regional configuration, or a guessed power/link profile.
 *
 * SDK references: NGEApi.DisableInvHandler/DisableAccessParams,
 * formatParamToPayload; NGEAdapter.UpdateRadioStartTrigger/UpdateReportTrigger
 * and SetInventoryParams defaults. These are temporary inventory settings.
 */
export function buildRe40InventoryCommands(olioValue: Uint8Array, durationMs = 5000): Uint8Array[] {
  if (
    !(olioValue instanceof Uint8Array) ||
    olioValue.length !== 25 ||
    olioValue[0] > 1 ||
    readWord(olioValue, 1) === 0 ||
    readWord(olioValue, 3) === 0
  ) {
    throw new Error(
      'The reader did not return a usable OLIO 1 antenna configuration. No RF settings were guessed.',
    );
  }
  if (!Number.isInteger(durationMs) || durationMs < 500 || durationMs > 10000) {
    throw new Error('Set an RE40 inventory duration from 500 to 10,000 milliseconds.');
  }

  const olio = new Uint8Array(27);
  olio.set([0x04, 0x01]);
  olio.set(olioValue, 2);
  olio[2] = 1; // Enable OLIO 1, preserving antennas, dwell, power and link profile.
  olio.fill(0, 12, 16); // No select operations.
  olio[16] = 1; // Use the configured inventory slot.
  olio.fill(0, 17, 25); // No tag access operations.

  const stop = new Uint8Array(15);
  stop.set([0x00, 0x05]);
  new DataView(stop.buffer).setUint32(2, durationMs, false);
  // The remaining fields are loop/tag limits, GPIO mask and GPIO hold times.
  const payloads = [
    Uint8Array.of(0x10, 0xeb, 0), // Disable automatic restart.
    Uint8Array.of(0xd0, 0x03, 0, 0, 0, 0, 0), // Immediate start, not GPIO gated.
    Uint8Array.of(0x10, 0xff, 0, 0, 0, 0, 0, 0), // Disable periodic report filter.
    Uint8Array.of(0x10, 0xfd, 0, 0, 0), // Disable the previous RSSI report filter.
    Uint8Array.of(0x02, 0x00, 0, 0), // Disable all inventory handlers first.
    Uint8Array.of(0x03, 0x00, 0, 0, 0, 0, 0), // Disable all access handlers.
    Uint8Array.of(0x02, 0x01, 1, 1, 1, 0, 2, 12), // SDK default C1G2 inventory.
    olio,
    Uint8Array.of(0x00, 0x04, 1, 0, 8), // Complete tag reports.
    Uint8Array.of(0x00, 0x04, 1, 2, 0x91), // Overall stop summary (packet 657).
    stop,
  ];
  return payloads.map((payload) => encodeRe40Packet(RE40.command.set, payload));
}

const metadataWidths: Readonly<Record<number, number>> = {
  0x81: 2,
  0x83: 8,
  0x85: 8,
  0x86: 1,
  0x87: 2,
  0x88: 2,
  0x89: 4,
  0x8a: 2,
  0x8b: 2,
  0x8c: 2,
  0x8e: 2,
  0x90: 4,
  0x93: 2,
  0x94: 2,
  0xff: 2,
};

/** Decode byte-aligned EPC reports; never interpret an EPC as a universal UID. */
export function decodeRe40Tag(packet: Re40Packet): Re40Tag | null {
  if (![0x0805, 0x0806, 0x0807, 0x0808].includes(packet.type)) return null;
  const payload = packet.payload;
  let start: number;
  let size: number;
  if (payload[0] === 0x8d) {
    start = 1;
    size = 12;
  } else if (payload.length >= 6 && payload[1] === 0xf1) {
    start = 6;
    size = readWord(payload, 2);
    // A non-byte-aligned EPC needs a separate bit-string representation.
    if (readWord(payload, 4) !== size * 8) return null;
  } else {
    return null;
  }
  if (!size || size > 512 || start + size > payload.length) return null;
  const tag: Re40Tag = {
    epc: Array.from(payload.subarray(start, start + size), (byte) =>
      byte.toString(16).padStart(2, '0'),
    )
      .join('')
      .toUpperCase(),
  };
  let offset = start + size;
  while (offset < payload.length) {
    const type = payload[offset++];
    let width = metadataWidths[type];
    if (type === 0x03) {
      if (offset + 2 > payload.length) return null;
      width = payload[offset + 1] === 0x12 ? 4 : 2;
    }
    // Unknown fields cannot safely be skipped: their size is not documented by
    // the SDK. Reject the report rather than mislabel trailing bytes as EPCs.
    if (width === undefined || offset + width > payload.length) return null;
    if (type === 0x81) tag.antenna = readWord(payload, offset);
    if (type === 0x86) tag.rssi = payload[offset] > 127 ? payload[offset] - 256 : payload[offset];
    if (type === 0x87) tag.channel = readWord(payload, offset);
    if (type === 0x88) tag.seenCount = readWord(payload, offset);
    offset += width;
  }
  return tag;
}

/** Per-round INV_END is not the end of the whole inventory operation. */
export function decodeRe40StopReason(packet: Re40Packet): Re40StopReason | null {
  if (packet.type !== RE40.response.stopSummary || packet.payload.length < 16) return null;
  const flags = packet.payload[15];
  const reasons: string[] = [];
  if (flags & 1) reasons.push('stop command');
  if (flags & 2) reasons.push('loop limit');
  if (flags & 4) reasons.push('duration limit');
  if (flags & 8) reasons.push('tag limit');
  if (flags & 16) reasons.push('GPIO condition');
  if (flags & 32) reasons.push('reader error');
  if (flags & 0xc0) reasons.push(`status 0x${flags.toString(16).padStart(2, '0').toUpperCase()}`);
  return {
    flags,
    message: reasons.length ? `Inventory stopped: ${reasons.join(', ')}.` : 'Inventory stopped.',
    error: Boolean(flags & 32),
  };
}
