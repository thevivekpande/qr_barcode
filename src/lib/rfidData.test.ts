import { describe, expect, it } from 'vitest';
import { bytesToHex, bytesToText, createByteFramer, encodeCommand } from './rfidData';
const encode = (value: string) => new TextEncoder().encode(value);

describe('RFID stream framing', () => {
  it('automatically handles line-delimited reads and flushes suffixless reads at idle', () => {
    const framer = createByteFramer('auto');
    expect(framer.push(encode('LINE\r\nNO-SUFFIX')).map(bytesToText)).toEqual(['LINE']);
    expect(bytesToText(framer.flush()!)).toBe('NO-SUFFIX');
    expect(framer.push(encode('\nNEXT\n')).map(bytesToText)).toEqual(['NEXT']);
    expect(framer.flush()).toBeNull();
  });
  it('keeps explicit line framing pending until its terminator arrives', () => {
    const framer = createByteFramer('lines');
    expect(framer.push(encode('TAG'))).toEqual([]);
    expect(framer.pendingBytes).toBe(3);
    expect(framer.push(encode('\r\n')).map(bytesToText)).toEqual(['TAG']);
  });
  it('assembles multiple and split CR/LF frames without duplicates or trimming', () => {
    const framer = createByteFramer('lines');
    expect(framer.push(encode('  001'))).toEqual([]);
    expect(framer.push(encode('23  \r')).map(bytesToText)).toEqual(['  00123  ']);
    expect(framer.push(encode('\nNEXT\nTHIRD\r\n\n')).map(bytesToText)).toEqual(['NEXT', 'THIRD']);
    expect(framer.pendingBytes).toBe(0);
  });
  it('decodes multibyte text only after complete byte frames arrive', () => {
    const framer = createByteFramer('lines');
    const bytes = encode('नमस्ते 🌿\n');
    expect(framer.push(bytes.slice(0, 5))).toEqual([]);
    expect(framer.push(bytes.slice(5)).map(bytesToText)).toEqual(['नमस्ते 🌿']);
  });
  it('keeps idle and raw-chunk modes distinct from line delimiters', () => {
    const idle = createByteFramer('idle');
    expect(idle.push(encode('A\r\nB'))).toEqual([]);
    expect(bytesToHex(idle.flush()!)).toBe('41 0D 0A 42');
    expect(idle.flush()).toBeNull();
    const raw = createByteFramer('chunks');
    expect(raw.push(Uint8Array.from([0, 13, 10, 255])).map(bytesToHex)).toEqual(['00 0D 0A FF']);
  });
  it('discards overlong frames until a boundary, then resumes cleanly', () => {
    const framer = createByteFramer('lines', 3);
    expect(framer.push(encode('abcdef'))).toEqual([]);
    expect(framer.pendingBytes).toBe(0);
    expect(framer.takeOverflow()).toBe(true);
    expect(framer.takeOverflow()).toBe(false);
    expect(framer.push(encode('ghi\nOK\n')).map(bytesToText)).toEqual(['OK']);
  });
  it('clears partial frames on reset and never retains source buffers', () => {
    const framer = createByteFramer('idle');
    const bytes = encode('ONE');
    framer.push(bytes);
    bytes.fill(0);
    expect(bytesToText(framer.flush()!)).toBe('ONE');
    framer.push(encode('old'));
    framer.reset();
    expect(framer.flush()).toBeNull();
  });
});

describe('RFID diagnostic data', () => {
  it('shows control bytes visibly while keeping exact hex available', () => {
    const bytes = Uint8Array.from([0, 2, 27, 65, 255]);
    expect(bytesToHex(bytes)).toBe('00 02 1B 41 FF');
    expect(bytesToText(bytes)).toBe('\\x00\\x02\\x1BA�');
  });
  it('encodes exact text, hex, and explicitly selected line endings', () => {
    expect(bytesToText(encodeCommand(' TEST ', 'text', 'none'))).toBe(' TEST ');
    expect(bytesToHex(encodeCommand('02 0a ff', 'hex', 'none'))).toBe('02 0A FF');
    expect(bytesToHex(encodeCommand('A', 'text', 'crlf'))).toBe('41 0D 0A');
    expect(bytesToHex(encodeCommand('00', 'hex', 'lf'))).toBe('00 0A');
  });
  it.each(['0', 'ZZ', '0x02', '01-02', ''])('rejects ambiguous or malformed hex: %s', (value) => {
    expect(() => encodeCommand(value, 'hex', 'none')).toThrow('hexadecimal');
  });
  it('rejects oversized commands and includes line endings in the size limit', () => {
    expect(() => encodeCommand('a'.repeat(4096), 'text', 'lf')).toThrow('4,096');
    expect(() => encodeCommand('aa'.repeat(4097), 'hex', 'none')).toThrow('4,096');
    expect(() => encodeCommand('', 'text', 'none')).toThrow('documentation');
  });
});
