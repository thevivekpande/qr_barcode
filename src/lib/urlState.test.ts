import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceUrl,
  createDefaultState,
  DEFAULT_BATCH,
  DEFAULT_SETTINGS,
  readWorkspaceUrl,
  type CodeSnapshot,
  type WorkspaceState,
} from './urlState';

const base = 'https://codeform.example';
const read = (path: string) => readWorkspaceUrl(new URL(path, base));
const roundTrip = (state: WorkspaceState) => read(buildWorkspaceUrl(state));

describe('workspace URLs', () => {
  it('restores only RFID configuration without reconnecting or serializing reader data', () => {
    const state = createDefaultState();
    state.mode = 'rfid';
    state.rfid = {
      transport: 'serial',
      hidMode: 'raw',
      terminator: 'idle',
      idleMs: 250,
      baudRate: 115200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
      framing: 'chunks',
    };
    expect(roundTrip(state)).toEqual(state);
    state.scan = { text: 'private scan', format: 'QR_CODE' };
    state.text = 'private draft';
    expect(buildWorkspaceUrl(state)).not.toContain('private');
    expect(read('/rfid?reader=serial&connected=true&command=erase&tag=12345').rfid.transport).toBe(
      'serial',
    );
    expect(buildWorkspaceUrl(read('/rfid?tag=12345&connected=true'))).toBe('/rfid');
  });
  it('rejects invalid RFID options from shared links', () => {
    const state = read(
      '/rfid?reader=bad&hidMode=bad&idleMs=1&baud=Infinity&dataBits=9&stopBits=5&parity=bad&flow=bad&framing=bad',
    );
    expect(state.rfid).toEqual(createDefaultState().rfid);
  });
  it('opens the example QR on the root, single route, and unknown routes', () => {
    for (const path of ['/', '/single', '/single/', '/default', '/unknown/route']) {
      const state = read(path);
      expect(state.mode).toBe('single');
      expect(state.single).toEqual({
        text: 'https://example.com',
        type: 'qr',
        settings: DEFAULT_SETTINGS,
      });
    }
    expect(buildWorkspaceUrl(createDefaultState())).toBe('/single');
  });

  it('gives every new workspace independent settings and snapshots', () => {
    const first = createDefaultState();
    const second = createDefaultState();
    first.settings.size = 1024;
    first.single!.settings.foreground = '#000000';
    expect(second.settings).toEqual(DEFAULT_SETTINGS);
    expect(second.single!.settings).toEqual(DEFAULT_SETTINGS);
    expect(first.single!.settings.size).toBe(512);
  });

  it('infers a preview from a manually written link and its shared controls', () => {
    const state = read(
      '/single?text=PRODUCT-001&type=barcode&size=1024&fg=123456&bg=%23fffABC&ec=H&label=0&advanced=1',
    );
    expect(state).toMatchObject({
      codeType: 'barcode',
      text: 'PRODUCT-001',
      advanced: true,
      settings: {
        size: 1024,
        foreground: '#123456',
        background: '#fffABC',
        errorCorrection: 'H',
        showLabel: false,
      },
    });
    expect(state.single).toEqual({
      text: state.text,
      type: state.codeType,
      settings: state.settings,
    });
  });

  it('preserves edited drafts separately from the code still visible in the preview', () => {
    const state = createDefaultState();
    state.text = '  नया draft 🌍\nhttps://example.com/?a=1&b=two+three#four%20  ';
    state.codeType = 'barcode';
    state.settings = {
      size: 1024,
      foreground: '#102030',
      background: '#f0f0f0',
      errorCorrection: 'H',
      showLabel: false,
    };
    state.advanced = true;
    state.single = {
      text: '  ORIGINAL + & # % ? = \n नमस्ते 🌍  ',
      type: 'qr',
      settings: { ...DEFAULT_SETTINGS, size: 256 },
    };
    expect(roundTrip(state)).toEqual(state);
    expect(new URL(buildWorkspaceUrl(state), base).searchParams.get('preview')).toBeTruthy();
  });

  it('represents an intentionally absent preview without recreating the default code', () => {
    const state = createDefaultState();
    state.text = '';
    state.single = null;
    expect(buildWorkspaceUrl(state)).toContain('preview=none');
    expect(roundTrip(state)).toEqual(state);
    expect(read('/single?preview=none').single).toBeNull();
  });

  it('preserves empty and oversized drafts for the generator to validate without truncation', () => {
    const empty = read('/single?text=');
    expect(empty.text).toBe('');
    expect(empty.single?.text).toBe('');
    const state = createDefaultState();
    state.text = `  ${'🌍<&+?#\n'.repeat(1000)}  `;
    state.single = null;
    expect(roundTrip(state).text).toBe(state.text);
    const direct = new URL('/single', base);
    direct.searchParams.set('text', state.text);
    expect(readWorkspaceUrl(direct).single?.text).toBe(state.text);
  });

  it('restores a paused live value alongside changed random-generation controls', () => {
    const state = createDefaultState();
    state.mode = 'live';
    state.frequency = '0.50';
    state.length = '064';
    state.charset = 'numeric';
    state.prefix = '  ID+&#%?=  ';
    state.live = {
      text: 'PRIOR-value-abc123',
      type: 'barcode',
      settings: { ...DEFAULT_SETTINGS, size: 256, showLabel: false },
    };
    expect(roundTrip(state)).toEqual(state);
    expect(read('/live').live).toBeNull();
  });

  it('keeps the generated batch when the list draft has since been edited or broken', () => {
    const state = createDefaultState();
    state.mode = 'batch';
    state.batchInput = '[\n  "unfinished draft & + # नमस्ते\n';
    state.batch = {
      texts: ['  First  ', 'One\nTwo', '商品 🌍', 'https://example.com/?a=1&b=2#test'],
      type: 'qr',
      settings: { ...DEFAULT_SETTINGS, errorCorrection: 'Q', size: 1024 },
    };
    expect(roundTrip(state)).toEqual(state);
    state.batch = null;
    expect(roundTrip(state).batch).toBeNull();
    expect(read('/batch').batchInput).toBe(DEFAULT_BATCH);
  });

  it('restores a scan result without interpreting its payload as a URL', () => {
    const state = createDefaultState();
    state.mode = 'scan';
    state.scan = { text: '  javascript:alert("<&+?=# नमस्ते 🌍")\n  ', format: 'QR_CODE' };
    expect(roundTrip(state)).toEqual(state);
    state.scan = null;
    expect(roundTrip(state).scan).toBeNull();
  });

  it('includes only shared controls and the active mode in a shareable URL', () => {
    const state = createDefaultState();
    state.mode = 'live';
    state.text = 'private inactive single draft';
    state.batchInput = 'private inactive batch draft';
    state.scan = { text: 'private inactive scan', format: 'CODE_128' };
    state.single = { ...state.single!, text: 'private inactive snapshot' };
    state.codeType = 'barcode';
    state.frequency = '2';
    const relativeUrl = buildWorkspaceUrl(state);
    expect(relativeUrl.startsWith('/live?')).toBe(true);
    expect(relativeUrl).not.toContain('private');
    const restored = read(relativeUrl);
    expect(restored.codeType).toBe('barcode');
    expect(restored.frequency).toBe('2');
    expect(restored.text).toBe('https://example.com');
    expect(restored.batchInput).toBe(DEFAULT_BATCH);
    expect(restored.scan).toBeNull();
  });

  it('keeps ordinary links readable and moves only oversized state to the fragment', () => {
    const state = createDefaultState();
    state.text = 'hello';
    state.single = { text: state.text, type: 'qr', settings: { ...DEFAULT_SETTINGS } };
    expect(buildWorkspaceUrl(state)).toBe('/single?text=hello');
    state.text = 'A'.repeat(5_987);
    state.single.text = state.text;
    const maximumInline = buildWorkspaceUrl(state);
    expect(maximumInline).toHaveLength(6_000);
    expect(new URL(maximumInline, base).hash).toBe('');
    state.text += 'A';
    state.single.text = state.text;
    const fragmentUrl = new URL(buildWorkspaceUrl(state), base);
    expect(fragmentUrl.pathname + fragmentUrl.search).toBe('/single?state=fragment');
    expect(fragmentUrl.hash).toMatch(/^#state=text=/);
    expect(readWorkspaceUrl(fragmentUrl)).toEqual(state);
  });

  it('round-trips a large valid batch and edited draft through a short HTTP request target', () => {
    const state = createDefaultState();
    state.mode = 'batch';
    state.settings = { ...DEFAULT_SETTINGS, size: 1024, errorCorrection: 'L' };
    const texts = Array.from(
      { length: 100 },
      (_, index) => ` ${index} नमस्ते 🌍 & + # % ? = ${'A'.repeat(1_900)} `,
    );
    expect(texts.every((text) => new TextEncoder().encode(text).length <= 2_000)).toBe(true);
    state.batchInput = `${JSON.stringify([...texts, 'ungenerated draft'])}\n`;
    state.batch = { texts, type: 'qr', settings: { ...DEFAULT_SETTINGS, errorCorrection: 'L' } };
    const url = new URL(buildWorkspaceUrl(state), base);
    expect(url.pathname + url.search).toBe('/batch?state=fragment');
    expect(url.hash.length).toBeGreaterThan(400_000);
    expect(readWorkspaceUrl(url)).toEqual(state);
  });
});

describe('untrusted workspace URLs', () => {
  it('rejects invalid shared control values while retaining valid ones', () => {
    const state = read(
      '/single?type=ean13&size=4096&fg=red&bg=%23fff&ec=Z&label=maybe&advanced=maybe&text=hello',
    );
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.codeType).toBe('qr');
    expect(state.advanced).toBe(false);
    expect(state.single?.text).toBe('hello');
    expect(read('/single?size=256&label=false&advanced=true').settings.size).toBe(256);
    expect(read('/single?label=false').settings.showLabel).toBe(false);
    expect(read('/single?advanced=true').advanced).toBe(true);
  });

  it.each(['', '0', '-1', '0.49', '3601', 'Infinity', 'NaN', 'not a number'])(
    'rejects an invalid live interval: %s',
    (frequency) => {
      const url = new URL('/live', base);
      url.searchParams.set('frequency', frequency);
      expect(readWorkspaceUrl(url).frequency).toBe('3');
    },
  );

  it.each(['', '0', '3', '65', '4.5', 'Infinity', 'NaN'])(
    'rejects an invalid random length: %s',
    (length) => {
      const url = new URL('/live', base);
      url.searchParams.set('length', length);
      expect(readWorkspaceUrl(url).length).toBe('12');
    },
  );

  it('accepts live bounds and falls back from an unknown alphabet', () => {
    expect(read('/live?frequency=0.5&length=4').frequency).toBe('0.5');
    expect(read('/live?frequency=3600&length=64').length).toBe('64');
    expect(read('/live?charset=emoji').charset).toBe('alphanumeric');
  });

  it.each(['{broken', 'null', '[]', '42', '{}', '{"text":"hello"}', 'none'])(
    'discards malformed snapshots instead of inventing a different preview: %s',
    (preview) => {
      const url = new URL('/single?text=edited', base);
      url.searchParams.set('preview', preview);
      expect(readWorkspaceUrl(url).single).toBeNull();
      expect(readWorkspaceUrl(url).text).toBe('edited');
    },
  );

  it('validates every snapshot setting and its code type', () => {
    const snapshot: CodeSnapshot = {
      text: 'old result',
      type: 'qr',
      settings: { ...DEFAULT_SETTINGS },
    };
    const invalid = [
      { ...snapshot, type: 'unknown' },
      { ...snapshot, text: ['nested'] },
      { ...snapshot, settings: null },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, size: '512' } },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, size: 64 } },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, foreground: '#fff' } },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, background: 'red' } },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, errorCorrection: 'BAD' } },
      { ...snapshot, settings: { ...DEFAULT_SETTINGS, showLabel: 'true' } },
    ];
    for (const value of invalid) {
      const url = new URL('/single', base);
      url.searchParams.set('preview', JSON.stringify(value));
      expect(readWorkspaceUrl(url).single).toBeNull();
    }
  });

  it('rejects nested, empty, and excessive generated batches', () => {
    for (const texts of [[], ['okay', {}], [['nested']], Array(101).fill('too many')]) {
      const url = new URL('/batch', base);
      url.searchParams.set(
        'preview',
        JSON.stringify({ texts, type: 'qr', settings: DEFAULT_SETTINGS }),
      );
      expect(readWorkspaceUrl(url).batch).toBeNull();
    }
    const state = createDefaultState();
    state.mode = 'batch';
    state.batch = {
      texts: Array.from({ length: 100 }, (_, index) => `${index}: ${'A'.repeat(2000)}`),
      type: 'qr',
      settings: { ...DEFAULT_SETTINGS },
    };
    expect(roundTrip(state).batch).toEqual(state.batch);
  });

  it('ignores oversized JSON snapshots and preserves the draft', () => {
    const url = new URL('/single?text=safe', base);
    url.searchParams.set(
      'preview',
      JSON.stringify({
        text: 'A'.repeat(1_000_000),
        type: 'qr',
        settings: DEFAULT_SETTINGS,
      }),
    );
    const state = readWorkspaceUrl(url);
    expect(state.single).toBeNull();
    expect(state.text).toBe('safe');
  });

  it('ignores malformed scan results and irrelevant parameters', () => {
    for (const value of ['broken', '{}', '{"text":42,"format":"QR_CODE"}', '{"text":"hi"}']) {
      const url = new URL('/scan?text=inactive&input=inactive&frequency=0.5', base);
      url.searchParams.set('result', value);
      const state = readWorkspaceUrl(url);
      expect(state.scan).toBeNull();
      expect(state.text).toBe('https://example.com');
      expect(state.batchInput).toBe(DEFAULT_BATCH);
      expect(state.frequency).toBe('3');
    }
  });

  it('uses safe defaults when a fragment link is missing its state or has the wrong format', () => {
    for (const path of [
      '/single?state=fragment&type=barcode&text=ignored',
      '/single?state=fragment#unrelated',
      '/single?state=fragment#state=',
      '/single?state=fragment#state=malformed',
    ]) {
      expect(read(path)).toEqual(createDefaultState());
    }
    expect(read('/batch?state=fragment#broken').mode).toBe('batch');
    expect(read('/batch?state=fragment#broken').batchInput).toBe(DEFAULT_BATCH);
  });

  it('applies the same validation to fragment controls and snapshots as query links', () => {
    const state = read(
      '/single?state=fragment#state=text=hello&type=ean13&size=4096&fg=red&ec=Z&preview=%7Bbroken',
    );
    expect(state.text).toBe('hello');
    expect(state.codeType).toBe('qr');
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.single).toBeNull();
    // Without the marker, ordinary page anchors do not override query state.
    expect(read('/single?text=query#state=text=fragment').text).toBe('query');
  });
});
