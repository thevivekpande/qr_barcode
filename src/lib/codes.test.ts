// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateCode,
  parseBatchInput,
  randomText,
  validateCodeColors,
  type CodeSettings,
} from './codes';

const settings: CodeSettings = {
  size: 512,
  foreground: '#141b2b',
  background: '#ffffff',
  errorCorrection: 'M',
  showLabel: true,
};

describe('batch input', () => {
  it('accepts JSON text and numbers, retaining whitespace, punctuation, and Unicode', () => {
    expect(parseBatchInput('["  hello  ",42," नमस्ते ","a,b"]')).toEqual([
      '  hello  ',
      '42',
      ' नमस्ते ',
      'a,b',
    ]);
  });
  it('accepts pasted lines with Windows or Mac newlines and ignores blank lines', () => {
    expect(parseBatchInput(' first \r\n\nsecond\rthird\n  ')).toEqual([
      ' first ',
      'second',
      'third',
    ]);
  });
  it.each(['["broken"', '[{}]', '[null]', '[["nested"]]', '[true]', '[" "]', '[1e999]', '[]', ' '])(
    'rejects invalid or empty collections: %s',
    (input) => {
      expect(() => parseBatchInput(input)).toThrow();
    },
  );
  it('allows 100 entries and rejects larger collections', () => {
    expect(
      parseBatchInput(JSON.stringify(Array.from({ length: 100 }, (_, index) => index))),
    ).toHaveLength(100);
    expect(() => parseBatchInput(Array(101).fill('entry').join('\n'))).toThrow('100');
  });
});

describe('code generation', () => {
  beforeAll(() => {
    // jsdom has no canvas renderer; JsBarcode only needs text measurement for SVG labels.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as CanvasRenderingContext2D);
  });
  afterAll(() => vi.restoreAllMocks());

  it('generates an SVG QR code containing the unmodified Unicode payload', async () => {
    const text = '  नमस्ते 🌍 https://example.com/?x=1&y=2  ';
    const code = await generateCode(text, 'qr', settings);
    expect(code.text).toBe(text);
    expect(code.type).toBe('qr');
    expect(code.svg).toContain('<svg');
    expect(code.svg).toContain('width="512"');
    expect(code.dataUrl).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code.svg)}`);
    expect(code.id).toBeTruthy();
  });
  it('generates Code 128 and escapes special characters in its label', async () => {
    const code = await generateCode('ORDER<&>"123', 'barcode', settings);
    expect(code.svg).toContain('<rect');
    expect(code.svg).toContain('ORDER&lt;&amp;&gt;');
    expect(code.svg).not.toContain('ORDER<&>');
  });
  it('retains its own export settings after controls change', async () => {
    const controls = { ...settings, size: 256 };
    const code = await generateCode('keep my size', 'qr', controls);
    controls.size = 1024;
    controls.foreground = '#000000';
    expect(code.settings.size).toBe(256);
    expect(code.settings.foreground).toBe(settings.foreground);
  });
  it('can hide barcode captions', async () => {
    const code = await generateCode('123456', 'barcode', { ...settings, showLabel: false });
    expect(code.svg).not.toContain('<text');
  });
  it('rejects non-ASCII and control characters for Code 128', async () => {
    await expect(generateCode('hello 🌍', 'barcode', settings)).rejects.toThrow('printable');
    await expect(generateCode('a\nb', 'barcode', settings)).rejects.toThrow('printable');
  });
  it('enforces barcode and UTF-8 QR size limits', async () => {
    await expect(generateCode('a'.repeat(81), 'barcode', settings)).rejects.toThrow('80');
    await expect(generateCode('🌍'.repeat(501), 'qr', settings)).rejects.toThrow('2,000');
  });
  it('reports QR library capacity errors with actionable guidance', async () => {
    await expect(
      generateCode('a'.repeat(2000), 'qr', { ...settings, errorCorrection: 'H' }),
    ).rejects.toThrow('lower error correction');
  });
  it('rejects blank values and unusable image sizes', async () => {
    await expect(generateCode(' \n ', 'qr', settings)).rejects.toThrow('Enter some text');
    await expect(generateCode('hello', 'qr', { ...settings, size: Number.NaN })).rejects.toThrow(
      'image size',
    );
  });
});

describe('random values', () => {
  it('uses the requested alphabet and preserves the prefix', () => {
    expect(randomText(24, 'numeric', 'ITEM-')).toMatch(/^ITEM-\d{24}$/);
    expect(randomText(50, 'alphabetic')).toMatch(/^[A-Za-z]{50}$/);
    expect(randomText(256, 'alphanumeric')).toMatch(/^[A-Za-z0-9]{256}$/);
  });
  it.each([0, -1, 257, 1.5, Number.NaN])('rejects invalid lengths: %s', (length) => {
    expect(() => randomText(length, 'numeric')).toThrow('between 1 and 256');
  });
});

describe('scannable colors', () => {
  it('accepts dark codes on light backgrounds with three- or six-digit hex', () => {
    expect(validateCodeColors('#000', '#fff')).toBeNull();
    expect(validateCodeColors('#162038', '#fafafa')).toBeNull();
  });
  it('rejects malformed, inverted, and low-contrast colors', () => {
    expect(validateCodeColors('black', '#fff')).toContain('valid hex');
    expect(validateCodeColors('#fff', '#000')).toContain('darker');
    expect(validateCodeColors('#cccccc', '#ffffff')).toContain('contrast');
  });
});
