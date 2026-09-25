import { describe, expect, it } from 'vitest';
import {
  RE40,
  buildRe40GetParameter,
  buildRe40IdentifyCommand,
  buildRe40InventoryCommands,
  buildRe40StartCommand,
  buildRe40StopCommand,
  createRe40Decoder,
  decodeRe40Ack,
  decodeRe40Firmware,
  decodeRe40Parameter,
  decodeRe40StopReason,
  decodeRe40Tag,
  encodeRe40Packet,
  re40Crc,
} from './rfidRe40';

const hex = (value: string) =>
  Uint8Array.from(value.replace(/\s/g, '').match(/../g) ?? [], (byte) => parseInt(byte, 16));
// Golden frames computed independently with Python binascii.crc_hqx(init=FFFF)
// and final xor FFFF, after checking its table against all 256 SDK table entries.
const identify = hex('AA AB 08 02 00 02 00 01 C6 6F');
const firmware = hex('AA AB 08 11 00 06 00 01 01 02 03 00 AA A3');
const ack = hex('AA AB 08 01 00 03 08 02 00 8C 23');
const concat = (...parts: Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

describe('RE40 packet encoding', () => {
  it('matches the independently computed firmware GET command without any setup commands', () => {
    expect(buildRe40IdentifyCommand()).toEqual(identify);
    expect(buildRe40GetParameter(1)).toEqual(identify);
    expect(buildRe40StartCommand()).toEqual(hex('AA AB 08 09 00 00 60 6D'));
    expect(buildRe40StopCommand()).toEqual(hex('AA AB 08 08 00 00 57 5D'));
  });

  it('uses CRC16 GENIBUS, excluding the two start bytes', () => {
    expect(re40Crc(new TextEncoder().encode('123456789'))).toBe(0xd64e);
    expect(re40Crc(identify.subarray(2, -2))).toBe(0xc66f);
    expect(encodeRe40Packet(0x0811, hex('00 01 01 02 03 00'))).toEqual(firmware);
  });

  it('validates frame and parameter limits and retains ownership of output', () => {
    for (const invalid of [-1, 65536, 1.2, NaN, Infinity]) {
      expect(() => encodeRe40Packet(invalid)).toThrow('16-bit');
      expect(() => buildRe40GetParameter(invalid)).toThrow('16-bit');
    }
    expect(() => encodeRe40Packet(1, new Uint8Array(4097))).toThrow('4,096');
    const payload = hex('00 01');
    const frame = encodeRe40Packet(0x0802, payload);
    payload.fill(255);
    expect(frame).toEqual(identify);
  });
});

describe('RE40 serial stream decoder', () => {
  it('decodes firmware and ACK at every chunk boundary', () => {
    const stream = concat(firmware, ack);
    for (let split = 0; split <= stream.length; split++) {
      const decoder = createRe40Decoder();
      const packets = [
        ...decoder.push(stream.subarray(0, split)),
        ...decoder.push(stream.subarray(split)),
      ];
      expect(packets).toEqual([
        { type: 0x0811, payload: hex('00 01 01 02 03 00') },
        { type: 0x0801, payload: hex('08 02 00') },
      ]);
      expect(decoder.bufferedBytes).toBe(0);
    }
  });

  it('handles one-byte chunks, noise and overlapping SOF bytes', () => {
    const decoder = createRe40Decoder();
    const packets = Array.from(concat(hex('00 ff aa aa 01 aa'), firmware)).flatMap((byte) =>
      decoder.push(Uint8Array.of(byte)),
    );
    expect(packets).toEqual([{ type: 0x0811, payload: hex('00 01 01 02 03 00') }]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('rejects invalid CRC without consuming a later valid packet', () => {
    const decoder = createRe40Decoder();
    const corrupted = firmware.slice();
    corrupted[8] ^= 1;
    expect(decoder.push(concat(corrupted, ack))).toEqual([
      { type: 0x0801, payload: hex('08 02 00') },
    ]);
    expect(decoder.checksumErrors).toBe(1);
  });

  it('resynchronizes inside a rejected frame but preserves SOF inside valid payloads', () => {
    const nested = encodeRe40Packet(0x087f, firmware);
    const valid = createRe40Decoder().push(nested);
    expect(valid).toEqual([{ type: 0x087f, payload: firmware }]);
    nested[nested.length - 1] ^= 1;
    expect(createRe40Decoder().push(nested)).toEqual([
      { type: 0x0811, payload: hex('00 01 01 02 03 00') },
    ]);
  });

  it('rejects oversized length immediately and bounds retained data even with hostile noise', () => {
    const decoder = createRe40Decoder();
    expect(decoder.push(concat(hex('aa ab 08 11 ff ff'), firmware))).toHaveLength(1);
    expect(decoder.push(new Uint8Array(100_000).fill(0xaa))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(1);
    decoder.reset();
    const maximum = encodeRe40Packet(0x0806, new Uint8Array(RE40.maxPayloadBytes).fill(0xaa));
    expect(decoder.push(maximum.subarray(0, -1))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(4103);
    expect(decoder.push(maximum.subarray(-1))[0].payload).toHaveLength(4096);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('owns returned bytes and clears partial state on reset', () => {
    const decoder = createRe40Decoder();
    const input = firmware.slice();
    const result = decoder.push(input)[0];
    input.fill(0);
    decoder.push(ack);
    expect(result.payload).toEqual(hex('00 01 01 02 03 00'));
    decoder.push(firmware.subarray(0, 6));
    decoder.reset();
    expect(decoder.push(firmware.subarray(6))).toEqual([]);
    expect(decoder.checksumErrors).toBe(0);
    expect(decoder.push(firmware)).toHaveLength(1);
  });
});

describe('RE40 response correlation and validation', () => {
  it('decodes firmware separately from its matching command ACK', () => {
    const [versionPacket, ackPacket] = createRe40Decoder().push(concat(firmware, ack));
    expect(decodeRe40Firmware(versionPacket)).toEqual({
      major: 1,
      minor: 2,
      build: 3,
      flag: 0,
      version: '1.2.3.0',
    });
    expect(decodeRe40Ack(ackPacket)).toEqual({ command: 0x0802, status: 0 });
    expect(decodeRe40Firmware(ackPacket)).toBeNull();
    expect(decodeRe40Ack(versionPacket)).toBeNull();
    expect(decodeRe40Parameter(versionPacket, 2)).toBeNull();
    // Actual RE422 / CP2102 response captured with the read-only GET on 2026-09-25.
    const actual = createRe40Decoder().push(hex('AAAB08110006000103001400B34F'))[0];
    expect(decodeRe40Firmware(actual)?.version).toBe('3.0.20.0');
  });

  it('preserves error ACK status and rejects malformed or unrelated replies', () => {
    expect(decodeRe40Ack({ type: 0x0801, payload: hex('08 02 81') })).toEqual({
      command: 0x0802,
      status: 129,
    });
    for (const payload of ['08 02', '08 02 00 ff', '']) {
      expect(decodeRe40Ack({ type: 0x0801, payload: hex(payload) })).toBeNull();
    }
    for (const payload of [
      '00 01',
      '00 01 01 02 03',
      '00 02 01 02 03 00',
      '00',
      '00 01 01 02 03 00 ff',
    ]) {
      expect(decodeRe40Firmware({ type: 0x0811, payload: hex(payload) })).toBeNull();
    }
    expect(decodeRe40Firmware({ type: 0x0801, payload: hex('00 01 01 02 03 00') })).toBeNull();
    expect(decodeRe40Firmware({ type: 0x0811, payload: hex('00 01 ff 80 fe 7f') })?.version).toBe(
      '255.128.254.127',
    );
  });
});

describe('RE40 finite inventory configuration', () => {
  const original = hex('00 0002 0003 02 0064 012A 11223344 05 0102030405060708 00C9');

  it('matches SDK command shapes and independent checksums, without START or NVM writes', () => {
    const commands = buildRe40InventoryCommands(original);
    expect(commands).toEqual([
      hex('AAAB0801000310EB00CCCB'),
      hex('AAAB08010007D0030000000000AEAD'),
      hex('AAAB0801000810FF00000000000009DD'),
      hex('AAAB0801000510FD0000006831'),
      hex('AAAB08010004020000000C14'),
      hex('AAAB0801000703000000000000F9A1'),
      hex('AAAB08010008020101010100020C9874'),
      hex('AAAB0801001B04010100020003020064012A0000000001000000000000000000C92DEC'),
      hex('AAAB080100050004010008B669'),
      hex('AAAB080100050004010291C29B'),
      hex('AAAB0801000F00050000138800000000000000000050F7'),
    ]);
  });

  it('preserves every RF byte while removing select/access operations and retaining input ownership', () => {
    const initial = original.slice();
    const commands = buildRe40InventoryCommands(initial, 1234);
    const packets = createRe40Decoder().push(concat(...commands));
    const olio = packets.find((packet) => packet.payload[0] === 4)!.payload.slice(2);
    expect(olio.subarray(1, 10)).toEqual(initial.subarray(1, 10));
    expect(olio.subarray(23, 25)).toEqual(initial.subarray(23, 25));
    expect(olio[0]).toBe(1);
    expect(olio[14]).toBe(1);
    expect(olio.subarray(10, 14)).toEqual(new Uint8Array(4));
    expect(olio.subarray(15, 23)).toEqual(new Uint8Array(8));
    expect(initial).toEqual(original);
    const stop = packets.at(-1)!.payload;
    expect(stop).toEqual(hex('0005 000004D2 0000 0000 00 0000 0000'));
    initial.fill(0);
    expect(olio.subarray(1, 10)).toEqual(original.subarray(1, 10));
  });

  it('refuses missing or malformed reader configuration and invalid durations', () => {
    for (const value of [new Uint8Array(), new Uint8Array(25), new Uint8Array(26)]) {
      expect(() => buildRe40InventoryCommands(value)).toThrow('No RF settings were guessed');
    }
    const invalidEnabled = original.slice();
    invalidEnabled[0] = 2;
    expect(() => buildRe40InventoryCommands(invalidEnabled)).toThrow('configuration');
    for (const duration of [0, 499, 10001, NaN, 1000.5, Infinity]) {
      expect(() => buildRe40InventoryCommands(original, duration)).toThrow('duration');
    }
    // The SDK does not establish that zero power or LP index is invalid.
    const zeroSettings = original.slice();
    zeroSettings.fill(0, 8, 10);
    zeroSettings.fill(0, 23, 25);
    expect(buildRe40InventoryCommands(zeroSettings)).toHaveLength(11);
  });
});

describe('RE40 tag reports and stop summary', () => {
  const epc = hex('E2 80 11 60 60 00 02 05 1A 2B 3C 4D');
  const basic = concat(hex('8D'), epc);

  it('decodes an actual RE422 complete tag report split across serial chunks', () => {
    // Captured during the physical five-second inventory on 2026-09-25.
    // The serial read split the tag CRC metadata between 89 and D9.
    const first = hex(
      'AAAB080800438DE28011704000021C5BEED15E89000000008E00008A000081000186CB8700028300000000321B5C148500000000321B5C148800018C34008B89',
    );
    const second = hex('D99000000000FF11E5BCF8');
    const decoder = createRe40Decoder();
    expect(decoder.push(first)).toEqual([]);
    const packets = decoder.push(second);
    expect(packets).toHaveLength(1);
    expect(packets[0].type).toBe(0x0808);
    expect(packets[0].payload).toHaveLength(67);
    expect(decodeRe40Tag(packets[0])).toEqual({
      epc: 'E28011704000021C5BEED15E',
      antenna: 1,
      rssi: -53,
      channel: 2,
      seenCount: 1,
    });
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.checksumErrors).toBe(0);
  });

  it('decodes a checksum-validated EPC and signed RSSI without treating it as text', () => {
    const frame = hex('AAAB080800188DE2801160600002051A2B3C4D81000186D08700028800039637');
    expect(decodeRe40Tag(createRe40Decoder().push(frame)[0])).toEqual({
      epc: 'E2801160600002051A2B3C4D',
      antenna: 1,
      rssi: -48,
      channel: 2,
      seenCount: 3,
    });
    for (const type of [0x0805, 0x0806, 0x0807, 0x0808]) {
      expect(decodeRe40Tag({ type, payload: basic })).toEqual({ epc: 'E2801160600002051A2B3C4D' });
    }
  });

  it('decodes variable-length byte-aligned EPCs using the documented F1 length fields', () => {
    expect(decodeRe40Tag({ type: 0x0808, payload: hex('00 F1 0004 0020 DEADBEEF 86FF') })).toEqual({
      epc: 'DEADBEEF',
      rssi: -1,
    });
    for (const value of [
      '00F10004001FDEADBEEF',
      '00F100050020DEADBEEF',
      '00F100000000',
      '00F100040020DEAD',
    ]) {
      expect(decodeRe40Tag({ type: 0x0808, payload: hex(value) })).toBeNull();
    }
  });

  it('rejects wrong packet types and truncated, unknown, or malformed metadata', () => {
    expect(decodeRe40Tag({ type: 0x0801, payload: basic })).toBeNull();
    for (const payload of [
      new Uint8Array(),
      hex('8D'),
      basic.subarray(0, -1),
      concat(basic, hex('81 00')),
      concat(basic, hex('86')),
      concat(basic, hex('7F 00')),
      concat(basic, hex('03 00 12 00')),
    ]) {
      expect(decodeRe40Tag({ type: 0x0808, payload })).toBeNull();
    }
    expect(
      decodeRe40Tag({ type: 0x0808, payload: concat(basic, hex('03 00 12 00 01 86 7F')) })?.rssi,
    ).toBe(127);
    expect(
      decodeRe40Tag({ type: 0x0808, payload: concat(basic, hex('03 00 11 86 80')) })?.rssi,
    ).toBe(-128);
  });

  it('bounds and skips recognized metadata correctly', () => {
    const fields = hex(
      '83 0000000000000000 85 0000000000000000 89 00000000 8A0000 8B0000 8C0000 8E0000 9000000000 930000 940000 FF0000 810003',
    );
    expect(decodeRe40Tag({ type: 0x0808, payload: concat(basic, fields) })?.antenna).toBe(3);
  });

  it('recognizes operation stop rather than a single inventory-round end', () => {
    const frame = hex('AAAB0A91001000000000000000000000000000000004FD96');
    expect(decodeRe40StopReason(createRe40Decoder().push(frame)[0])).toEqual({
      flags: 4,
      message: 'Inventory stopped: duration limit.',
      error: false,
    });
    expect(decodeRe40StopReason({ type: 0x0b0a, payload: new Uint8Array(16) })).toBeNull();
    expect(decodeRe40StopReason({ type: 0x0a91, payload: new Uint8Array(15) })).toBeNull();
    const failed = new Uint8Array(16);
    failed[15] = 32;
    expect(decodeRe40StopReason({ type: 0x0a91, payload: failed })?.error).toBe(true);
  });
});
