import { describe, expect, it } from 'vitest';
import { decodeRfHidReport } from './rfidProtocol';

const hex = (value: string) =>
  Uint8Array.from(
    value
      .trim()
      .split(/\s+/)
      .map((byte) => parseInt(byte, 16)),
  );
const captured = hex(
  '19 52 46 02 00 00 80 00 10 50 0E 01 0C E2 80 11 70 40 00 02 1C 5B EE D1 5E B2',
);
const frame = (parameters: number[], type = 0x02, code = 0x80) => {
  const bytes = [
    0x52,
    0x46,
    type,
    0,
    0,
    code,
    parameters.length >> 8,
    parameters.length & 0xff,
    ...parameters,
  ];
  bytes.push(-bytes.reduce((sum, byte) => sum + byte, 0) & 0xff);
  return Uint8Array.from(bytes);
};
const singleTag = (epc: number[]) => [0x50, epc.length + 2, 0x01, epc.length, ...epc];
const wrap = (value: Uint8Array, length = 64) => {
  const report = new Uint8Array(Math.max(length, value.length + 1));
  report[0] = value.length;
  report.set(value, 1);
  return report;
};

describe('passive RF HID tag decoding', () => {
  it('decodes the captured count-prefixed 64-byte report without including framing or padding', () => {
    const report = new Uint8Array(64);
    report.set(captured);
    const before = report.slice();
    expect(decodeRfHidReport(report)).toEqual({ epcs: ['E28011704000021C5BEED15E'] });
    expect(report).toEqual(before);
    expect(decodeRfHidReport(captured)).toEqual({ epcs: ['E28011704000021C5BEED15E'] });
    expect(decodeRfHidReport(captured.subarray(1))).toEqual({ epcs: ['E28011704000021C5BEED15E'] });
  });

  it('decodes the vendor protocol example with RSSI and timestamp metadata', () => {
    const value = hex(
      '52 46 02 00 00 80 00 19 50 17 01 0C E2 00 00 17 02 17 01 99 23 90 21 7D 05 01 C3 06 04 3D 00 00 00 4C',
    );
    expect(decodeRfHidReport(value)).toEqual({ epcs: ['E2000017021701992390217D'] });
  });

  it('uses the documented additive checksum, not XOR even though both match the original capture', () => {
    const value = frame(singleTag([0x12, 0x34]));
    const xor = value.subarray(0, -1).reduce((result, byte) => result ^ byte, 0);
    expect(xor).not.toBe(value[value.length - 1]);
    expect(decodeRfHidReport(value)).toEqual({ epcs: ['1234'] });
    value[value.length - 1] = xor;
    expect(decodeRfHidReport(value)).toBeNull();
  });

  it('recognizes variable-length EPC fields by TLV type without requiring an E2 prefix', () => {
    expect(decodeRfHidReport(frame(singleTag([0, 0x0a, 0xff])))).toEqual({ epcs: ['000AFF'] });
    const epc = Array.from({ length: 40 }, (_, index) => index);
    expect(decodeRfHidReport(wrap(frame(singleTag(epc))))?.epcs[0]).toBe(
      epc.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(''),
    );
  });

  it('validates every container and returns multiple tags in their reported order', () => {
    const value = frame([
      0x07,
      1,
      0,
      ...singleTag([0xaa]),
      0x40,
      2,
      0xff,
      0xee,
      ...singleTag([0xbb, 0xcc]),
      ...singleTag([0xaa]),
    ]);
    expect(decodeRfHidReport(value)).toEqual({ epcs: ['AA', 'BBCC', 'AA'] });
  });

  it('reads a big-endian parameter length beyond one byte in a complete RF frame', () => {
    const parameters = Array.from({ length: 60 }, (_, index) => singleTag([index])).flat();
    const value = frame(parameters);
    expect(value[6]).toBe(1);
    expect(decodeRfHidReport(value)?.epcs).toHaveLength(60);
  });

  it('skips well-formed non-EPC metadata without mistaking TID or outer EPC fields for tag EPCs', () => {
    expect(decodeRfHidReport(frame([0x50, 8, 0x02, 3, 0xe2, 0x80, 0x11, 0x01, 1, 0xaa]))).toEqual({
      epcs: ['AA'],
    });
    expect(decodeRfHidReport(frame([0x50, 5, 0x02, 3, 0xe2, 0x80, 0x11]))).toBeNull();
    expect(decodeRfHidReport(frame([0x01, 3, 0xe2, 0x80, 0x11]))).toBeNull();
  });

  it.each([0, 1, 3, 255])('does not decode frame type %i as a notification', (type) => {
    expect(decodeRfHidReport(frame(singleTag([0xaa]), type))).toBeNull();
  });

  it.each([0x21, 0x40, 0x81, 0x82, 0x90])('does not decode unhandled frame code %i', (code) => {
    expect(decodeRfHidReport(frame(singleTag([0xaa]), 2, code))).toBeNull();
  });

  it('rejects checksum corruption, extra bare-frame bytes, and mismatched parameter length', () => {
    const valid = frame(singleTag([0x12, 0x34]));
    const corrupt = valid.slice();
    corrupt[corrupt.length - 2] ^= 1;
    expect(decodeRfHidReport(corrupt)).toBeNull();
    expect(decodeRfHidReport(Uint8Array.from([...valid, 0]))).toBeNull();
    const wrongLength = valid.slice();
    wrongLength[7]--;
    wrongLength[wrongLength.length - 1]++;
    expect(decodeRfHidReport(wrongLength)).toBeNull();
  });

  it('rejects short or long HID counts, nonzero padding, and concatenated frames', () => {
    const valid = frame(singleTag([0xaa]));
    for (const count of [0, 8, valid.length - 1, valid.length + 1, 255]) {
      const report = wrap(valid);
      report[0] = count;
      expect(decodeRfHidReport(report)).toBeNull();
    }
    const report = wrap(valid);
    report[63] = 1;
    expect(decodeRfHidReport(report)).toBeNull();
    expect(decodeRfHidReport(wrap(Uint8Array.from([...valid, ...valid])))).toBeNull();
  });

  it('does not scan arbitrary text or noise for an embedded frame', () => {
    const valid = frame(singleTag([0xaa]));
    expect(decodeRfHidReport(Uint8Array.from([0, 0, ...valid]))).toBeNull();
    expect(decodeRfHidReport(new TextEncoder().encode('E28011704000021C5BEED15E'))).toBeNull();
    expect(decodeRfHidReport(new Uint8Array(64))).toBeNull();
  });

  it('rejects every truncation of the captured frame and count wrapper', () => {
    for (let length = 0; length < captured.length; length++) {
      expect(decodeRfHidReport(captured.subarray(0, length))).toBeNull();
    }
    const bare = captured.subarray(1);
    for (let length = 0; length < bare.length; length++) {
      expect(decodeRfHidReport(bare.subarray(0, length))).toBeNull();
    }
  });

  it.each([
    [0x50],
    [0x50, 4, 0x01, 1, 0xaa],
    [0x50, 1, 0x01],
    [0x50, 3, 0x01, 2, 0xaa],
    [0x50, 4, 0x01, 1, 0xaa, 0x05],
    [0x50, 2, 0x01, 0],
    [0x50, 6, 0x01, 1, 0xaa, 0x01, 1, 0xbb],
    [...singleTag([0xaa]), 0x50, 2, 0x01, 1],
    [...singleTag([0xaa]), 0x50],
    [0x50, 5, 0x01, 1, 0xaa, 0x05, 0],
    [0x50, 6, 0x01, 1, 0xaa, 0x06, 1, 0],
    [0x07, 1, 0x20, ...singleTag([0xaa])],
    [0x07, 0, ...singleTag([0xaa])],
    [0x50, 6, 0x01, 1, 0xaa, 0x07, 1, 0x20],
  ])(
    'rejects malformed TLVs or error status, even with a valid frame checksum: %j',
    (...parameters) => {
      expect(decodeRfHidReport(frame(parameters))).toBeNull();
    },
  );

  it('returns null for valid notifications that contain no EPC value', () => {
    expect(decodeRfHidReport(frame([]))).toBeNull();
    expect(decodeRfHidReport(frame([0x50, 0]))).toBeNull();
    expect(decodeRfHidReport(frame([0x07, 1, 0]))).toBeNull();
  });
});
