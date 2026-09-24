import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Barcode,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  FileDown,
  Grid2X2,
  Layers,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  Printer,
  QrCode,
  Radio,
  RefreshCw,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { downloadCode, exportPdf, generateCode, parseBatchInput, randomText } from './lib/codes';
import type { CodeSettings, CodeType, GeneratedCode } from './lib/codes';
import type { ScanResult } from './lib/scanner';
import { buildWorkspaceUrl, readWorkspaceUrl, DEFAULT_BATCH } from './lib/urlState';
import type { Mode, WorkspaceState, CodeSnapshot } from './lib/urlState';

const Scanner = lazy(() => import('./components/Scanner'));

const snapshotOf = (code: GeneratedCode | null): CodeSnapshot | null =>
  code ? { text: code.text, type: code.type, settings: code.settings } : null;

const pages = {
  scan: {
    label: 'Scan codes',
    title: 'Every code has a story.',
    description: 'Scan a QR code or barcode and bring its text back into view.',
  },
  single: {
    label: 'Single code',
    title: 'A little code. A lot of possibility.',
    description: 'Turn your text into something scannable. Simple as that.',
  },
  live: {
    label: 'Live generator',
    title: 'Fresh codes. On your schedule.',
    description: 'Keep ideas moving with a new random code, every few seconds.',
  },
  batch: {
    label: 'Batch studio',
    title: 'One list. Endless connections.',
    description: 'Create a whole collection of codes, ready to share or print.',
  },
};
const friendlyError = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

function App() {
  const [initial] = useState(() => readWorkspaceUrl(new URL(window.location.href)));
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [codeType, setCodeType] = useState<CodeType>(initial.codeType);
  const [text, setText] = useState(initial.text);
  const [settings, setSettings] = useState<CodeSettings>(initial.settings);
  const [singleCode, setSingleCode] = useState<GeneratedCode | null>(null);
  const [liveCode, setLiveCode] = useState<GeneratedCode | null>(null);
  const [batchCodes, setBatchCodes] = useState<GeneratedCode[]>([]);
  const [batchInput, setBatchInput] = useState(initial.batchInput);
  const [recent, setRecent] = useState<GeneratedCode[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [advanced, setAdvanced] = useState(initial.advanced);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [length, setLength] = useState(initial.length);
  const [prefix, setPrefix] = useState(initial.prefix);
  const [charset, setCharset] = useState<'alphanumeric' | 'numeric' | 'alphabetic'>(
    initial.charset,
  );
  const [running, setRunning] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [nextAt, setNextAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [scanResult, setScanResult] = useState<ScanResult | null>(initial.scan);
  const [restoring, setRestoring] = useState(true);
  const [urlError, setUrlError] = useState('');
  const operation = useRef(0);
  const persistedMode = useRef(initial.mode);
  const guide = useRef<HTMLDialogElement>(null);
  const currentCode = mode === 'live' ? liveCode : singleCode;
  const timerPercent = running
    ? Math.max(0, Math.min(100, ((nextAt - now) / (Number(frequency) * 1000)) * 100))
    : 0;

  useEffect(() => {
    let disposed = false;
    const restore = async (state: WorkspaceState, initialLoad = false) => {
      const request = ++operation.current;
      setRestoring(true);
      setBusy(true);
      setRunning(false);
      persistedMode.current = state.mode;
      setMode(state.mode);
      setCodeType(state.codeType);
      setSettings(state.settings);
      setAdvanced(state.advanced);
      // A URL only describes its active workspace. Keep other local drafts on Back/Forward.
      if (initialLoad || state.mode === 'single') {
        setText(state.text);
        setSingleCode(null);
      }
      if (initialLoad || state.mode === 'batch') {
        setBatchInput(state.batchInput);
        setBatchCodes([]);
      }
      if (initialLoad || state.mode === 'live') {
        setFrequency(state.frequency);
        setLength(state.length);
        setPrefix(state.prefix);
        setCharset(state.charset);
        setLiveCode(null);
        setLiveCount(0);
      }
      if (initialLoad || state.mode === 'scan') setScanResult(state.scan);
      setError('');
      setNotice('');
      try {
        const restoreCode = (snapshot: CodeSnapshot | null) =>
          snapshot
            ? generateCode(snapshot.text, snapshot.type, snapshot.settings)
            : Promise.resolve(null);
        // Settle all work before applying the restored view; navigation can cancel it.
        const [single, live, batch] = await Promise.allSettled([
          restoreCode(initialLoad || state.mode === 'single' ? state.single : null),
          restoreCode(initialLoad || state.mode === 'live' ? state.live : null),
          (initialLoad || state.mode === 'batch') && state.batch
            ? Promise.all(
                state.batch.texts.map((value) =>
                  generateCode(value, state.batch!.type, state.batch!.settings),
                ),
              )
            : Promise.resolve([]),
        ]);
        if (disposed || request !== operation.current) return;
        if ((initialLoad || state.mode === 'single') && single.status === 'fulfilled')
          setSingleCode(single.value);
        if ((initialLoad || state.mode === 'live') && live.status === 'fulfilled')
          setLiveCode(live.value);
        if ((initialLoad || state.mode === 'batch') && batch.status === 'fulfilled')
          setBatchCodes(batch.value);
        const active = state.mode === 'live' ? live : state.mode === 'batch' ? batch : single;
        if (state.mode !== 'scan' && active.status === 'rejected')
          setError(friendlyError(active.reason));
      } finally {
        if (!disposed && request === operation.current) {
          setBusy(false);
          setRestoring(false);
        }
      }
    };
    void restore(initial, true);
    const onPopState = () => {
      void restore(readWorkspaceUrl(new URL(window.location.href)));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      disposed = true;
      operation.current++;
      window.removeEventListener('popstate', onPopState);
    };
  }, [initial]);

  function workspaceState(): WorkspaceState {
    return {
      mode,
      codeType,
      text,
      settings,
      batchInput,
      frequency,
      length,
      prefix,
      charset,
      advanced,
      single: snapshotOf(singleCode),
      live: snapshotOf(liveCode),
      batch: batchCodes.length
        ? {
            texts: batchCodes.map((code) => code.text),
            type: batchCodes[0].type,
            settings: batchCodes[0].settings,
          }
        : null,
      scan: scanResult,
    };
  }

  useEffect(() => {
    if (restoring) return;
    try {
      const next = buildWorkspaceUrl(workspaceState());
      if (window.location.pathname + window.location.search + window.location.hash !== next) {
        const method = persistedMode.current === mode ? 'replaceState' : 'pushState';
        window.history[method](null, '', next);
      }
      persistedMode.current = mode;
      setUrlError('');
    } catch {
      setUrlError(
        'This workspace could not be saved in the address bar. Try a smaller collection before sharing or reloading.',
      );
    }
  }, [
    mode,
    codeType,
    text,
    settings,
    batchInput,
    frequency,
    length,
    prefix,
    charset,
    advanced,
    singleCode,
    liveCode,
    batchCodes,
    scanResult,
    restoring,
  ]);

  async function copyWorkspaceLink() {
    try {
      const link = new URL(buildWorkspaceUrl(workspaceState()), window.location.origin).href;
      await navigator.clipboard.writeText(link);
      setNotice('Workspace link copied, including your content and settings.');
    } catch {
      setNotice('Could not copy the link. You can copy it from the address bar.');
    }
  }

  async function useScannedText(result: ScanResult) {
    const type: CodeType =
      result.format !== 'QR_CODE' && /^[\x20-\x7E]{1,80}$/.test(result.text) ? 'barcode' : 'qr';
    navigate('single');
    const request = ++operation.current;
    setText(result.text);
    setCodeType(type);
    setSingleCode(null);
    setBusy(true);
    try {
      const code = await generateCode(result.text, type, settings);
      if (request !== operation.current) return;
      setSingleCode(code);
      setRecent((items) => [code, ...items].slice(0, 6));
      setNotice('Decoded text opened in the generator.');
    } catch (err) {
      if (request === operation.current) setError(friendlyError(err));
    } finally {
      if (request === operation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const value = randomText(Number(length), charset, prefix);
        const code = await generateCode(value, codeType, settings);
        if (cancelled) return;
        setLiveCode(code);
        setLiveCount((count) => count + 1);
        setRecent((items) => [code, ...items].slice(0, 6));
        setNextAt(Date.now() + Number(frequency) * 1000);
        timer = setTimeout(tick, Number(frequency) * 1000);
      } catch (err) {
        if (!cancelled) {
          setError(friendlyError(err));
          setRunning(false);
        }
      }
    };
    void tick();
    const clock = setInterval(() => setNow(Date.now()), 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [running, frequency, length, charset, prefix, codeType, settings]);

  function navigate(next: Mode) {
    operation.current++;
    setBusy(false);
    setRestoring(false);
    setRunning(false);
    setMode(next);
    setError('');
  }

  function changeType(next: CodeType) {
    setCodeType(next);
    setError('');
  }

  async function createSingle() {
    const request = ++operation.current;
    setError('');
    setBusy(true);
    try {
      const code = await generateCode(text, codeType, settings);
      if (request !== operation.current) return;
      setSingleCode(code);
      setRecent((items) => [code, ...items].slice(0, 6));
      setNotice(`${codeType === 'qr' ? 'QR code' : 'Barcode'} generated. Ready to share!`);
    } catch (err) {
      if (request === operation.current) setError(friendlyError(err));
    } finally {
      if (request === operation.current) setBusy(false);
    }
  }

  async function createBatch() {
    const request = ++operation.current;
    setError('');
    setBusy(true);
    try {
      const entries = parseBatchInput(batchInput);
      const codes: GeneratedCode[] = [];
      for (let i = 0; i < entries.length; i++) {
        if (request !== operation.current) return;
        try {
          codes.push(await generateCode(entries[i], codeType, settings));
        } catch (err) {
          throw new Error(`Item ${i + 1}: ${friendlyError(err)}`);
        }
        if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (request !== operation.current) return;
      setBatchCodes(codes);
      setRecent((items) => [...codes.slice(-3).reverse(), ...items].slice(0, 6));
      setNotice(`${codes.length} codes generated. Your collection is ready.`);
    } catch (err) {
      if (request === operation.current) setError(friendlyError(err));
    } finally {
      if (request === operation.current) setBusy(false);
    }
  }

  function toggleLive() {
    if (running) {
      setRunning(false);
      return;
    }
    setError('');
    if (
      !Number.isFinite(Number(frequency)) ||
      Number(frequency) < 0.5 ||
      Number(frequency) > 3600
    ) {
      setError('Enter an interval between 0.5 and 3,600 seconds.');
      return;
    }
    if (!Number.isInteger(Number(length)) || Number(length) < 4 || Number(length) > 64) {
      setError('Choose a random text length between 4 and 64 characters.');
      return;
    }
    setRunning(true);
  }

  async function download(format: 'png' | 'svg', code = currentCode) {
    if (!code) return;
    setExporting(true);
    try {
      await downloadCode(code, format, code.settings.size);
      setNotice(`${format.toUpperCase()} downloaded. Make something great.`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setExporting(false);
    }
  }

  async function pdf(codes: GeneratedCode[]) {
    setExporting(true);
    setError('');
    try {
      await exportPdf(codes);
      setNotice('Your PDF is ready. Open it to print or share.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setExporting(false);
    }
  }

  async function copyValue() {
    if (!currentCode) return;
    try {
      await navigator.clipboard.writeText(currentCode.text);
      setNotice('Code content copied to clipboard.');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the text below the preview.');
    }
  }

  function printBatch() {
    setRunning(false);
    window.print();
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#workspace"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('workspace')?.focus();
          document.getElementById('workspace')?.scrollIntoView();
        }}
      >
        Skip to workspace
      </a>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('single')} aria-label="Codeform home">
          <span className="brand-mark">
            <QrCode size={24} strokeWidth={2.1} />
          </span>
          <span>
            codeform<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="sidebar-heading">YOUR WORKSPACE</div>
        <nav aria-label="Workspaces">
          <button
            className={`nav-item ${mode === 'single' ? 'active' : ''}`}
            onClick={() => navigate('single')}
            aria-current={mode === 'single' ? 'page' : undefined}
          >
            <QrCode size={19} />
            <span>Single code</span>
            {mode === 'single' && <span className="nav-dot" />}
          </button>
          <button
            className={`nav-item ${mode === 'live' ? 'active' : ''}`}
            onClick={() => navigate('live')}
            aria-current={mode === 'live' ? 'page' : undefined}
          >
            <Radio size={19} />
            <span>Live generator</span>
            <span className="nav-pill">AUTO</span>
          </button>
          <button
            className={`nav-item ${mode === 'batch' ? 'active' : ''}`}
            onClick={() => navigate('batch')}
            aria-current={mode === 'batch' ? 'page' : undefined}
          >
            <Layers size={19} />
            <span>Batch studio</span>
            {mode === 'batch' && <span className="nav-dot" />}
          </button>
          <button
            className={`nav-item ${mode === 'scan' ? 'active' : ''}`}
            onClick={() => navigate('scan')}
            aria-current={mode === 'scan' ? 'page' : undefined}
          >
            <ScanLine size={19} />
            <span>Scan codes</span>
            {mode === 'scan' && <span className="nav-dot" />}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div className="note-art" aria-hidden="true">
              <span className="art-tile">
                <QrCode size={39} strokeWidth={1.5} />
              </span>
              <span className="art-spark">✳</span>
              <span className="art-tile barcode-tile">
                <Barcode size={40} strokeWidth={1.2} />
              </span>
            </div>
            <h3>
              Little squares.
              <br />
              Bigger possibilities.
            </h3>
            <p>
              For your next big idea,
              <br />
              or your everyday essentials.
            </p>
            <span className="small-caps">
              MAKE IT SCANNABLE <ArrowUpRight size={13} />
            </span>
          </div>
          <button className="help-link" onClick={() => guide.current?.showModal()}>
            <CircleHelp size={18} /> A little guidance <ArrowUpRight size={15} />
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" /> All systems local <span>v1.0</span>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{pages[mode].label}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="workspace-link"
              onClick={copyWorkspaceLink}
              disabled={restoring}
              aria-label="Copy workspace link"
            >
              <Link2 size={14} /> Copy link
            </button>
            <span className="privacy-badge">
              <LockKeyhole size={13} /> Private by design
            </span>
          </div>
        </header>
        <main id="workspace" tabIndex={-1}>
          <section className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> SMALL TOOLS, BIG POSSIBILITIES
              </div>
              <h1>{pages[mode].title}</h1>
              <p>{pages[mode].description}</p>
            </div>
            <div className="heading-stamp" aria-hidden="true">
              <ScanLine size={32} strokeWidth={1.25} />
              <span>CREATE. SCAN. CONNECT.</span>
            </div>
          </section>

          {urlError && (
            <div className="error-message" role="alert">
              {urlError}
            </div>
          )}
          {mode === 'scan' ? (
            <Suspense
              fallback={
                <div className="panel scanner-loading" role="status">
                  <LoaderCircle size={20} className="spin" /> Loading scanner…
                </div>
              }
            >
              <Scanner result={scanResult} onResult={setScanResult} onUseText={useScannedText} />
            </Suspense>
          ) : (
            <>
              <div className="workspace-grid">
                <section className="editor-card panel" aria-labelledby="editor-title">
                  <div className="panel-heading">
                    <div className="panel-title">
                      <span className="step-number">01</span>
                      <h2 id="editor-title">
                        {mode === 'single'
                          ? 'Make it yours'
                          : mode === 'live'
                            ? 'Set your rhythm'
                            : 'Build your collection'}
                      </h2>
                    </div>
                    <span className="panel-caption">
                      {mode === 'single'
                        ? 'A few details. One great code.'
                        : mode === 'live'
                          ? 'Set it up. Let it flow.'
                          : 'More codes. Less work.'}
                    </span>
                  </div>
                  <div className="editor-body">
                    <fieldset className="type-fieldset" disabled={running || busy}>
                      <legend className="field-label">Code type</legend>
                      <div className="type-switch">
                        <button
                          type="button"
                          className={codeType === 'qr' ? 'selected' : ''}
                          aria-pressed={codeType === 'qr'}
                          onClick={() => changeType('qr')}
                        >
                          <QrCode size={20} /> QR code {codeType === 'qr' && <Check size={15} />}
                        </button>
                        <button
                          type="button"
                          className={codeType === 'barcode' ? 'selected' : ''}
                          aria-pressed={codeType === 'barcode'}
                          onClick={() => changeType('barcode')}
                        >
                          <Barcode size={21} /> Barcode{' '}
                          {codeType === 'barcode' && <Check size={15} />}
                        </button>
                      </div>
                    </fieldset>

                    {mode === 'single' && (
                      <div className="content-field">
                        <div className="label-row">
                          <label className="field-label" htmlFor="single-text">
                            Your content
                          </label>
                          <span>{codeType === 'qr' ? 'TEXT OR LINK' : 'CODE 128'}</span>
                        </div>
                        <textarea
                          id="single-text"
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          placeholder={
                            codeType === 'qr'
                              ? 'A website, a message, a little something…'
                              : 'e.g. PRODUCT-001'
                          }
                          rows={4}
                          spellCheck={false}
                        />
                        <div className="field-hint">
                          <span>
                            {codeType === 'qr'
                              ? 'Any text, URL, or idea you want to share.'
                              : 'Letters, numbers, and ASCII symbols. Up to 80 characters.'}
                          </span>
                          <span>{text.length} characters</span>
                        </div>
                      </div>
                    )}

                    {mode === 'live' && (
                      <fieldset className="live-fields" disabled={running}>
                        <div className="two-fields">
                          <div>
                            <label className="field-label" htmlFor="frequency">
                              Generate every
                            </label>
                            <div className="input-suffix">
                              <input
                                id="frequency"
                                type="number"
                                min="0.5"
                                max="3600"
                                step="0.5"
                                value={frequency}
                                onChange={(e) => setFrequency(e.target.value)}
                              />
                              <span>seconds</span>
                            </div>
                          </div>
                          <div>
                            <label className="field-label" htmlFor="random-length">
                              Random text length
                            </label>
                            <div className="input-suffix">
                              <input
                                id="random-length"
                                type="number"
                                min="4"
                                max="64"
                                value={length}
                                onChange={(e) => setLength(e.target.value)}
                              />
                              <span>characters</span>
                            </div>
                          </div>
                        </div>
                        <div className="two-fields">
                          <div>
                            <label className="field-label" htmlFor="charset">
                              Characters to use
                            </label>
                            <div className="select-wrap">
                              <select
                                id="charset"
                                value={charset}
                                onChange={(e) => setCharset(e.target.value as typeof charset)}
                              >
                                <option value="alphanumeric">Letters & numbers</option>
                                <option value="numeric">Numbers only</option>
                                <option value="alphabetic">Letters only</option>
                              </select>
                              <ChevronDown size={15} />
                            </div>
                          </div>
                          <div>
                            <label className="field-label" htmlFor="prefix">
                              Prefix <span className="optional">optional</span>
                            </label>
                            <input
                              id="prefix"
                              placeholder="e.g. ITEM-"
                              maxLength={16}
                              value={prefix}
                              onChange={(e) => setPrefix(e.target.value)}
                            />
                          </div>
                        </div>
                        <p className="field-hint">
                          A fresh, random value on every cycle. Pause anytime.
                        </p>
                      </fieldset>
                    )}

                    {mode === 'batch' && (
                      <div className="content-field">
                        <div className="label-row">
                          <label className="field-label" htmlFor="batch-input">
                            Your list
                          </label>
                          <button
                            className="text-button"
                            onClick={() => setBatchInput(DEFAULT_BATCH)}
                          >
                            Use example <ArrowUpRight size={12} />
                          </button>
                        </div>
                        <textarea
                          id="batch-input"
                          className="batch-textarea"
                          value={batchInput}
                          onChange={(e) => setBatchInput(e.target.value)}
                          placeholder={'["Hello", "World", "PRODUCT-001"]'}
                          rows={6}
                          spellCheck={false}
                        />
                        <div className="field-hint">
                          <span>A JSON array, or one value per line.</span>
                          <span>Up to 100 codes</span>
                        </div>
                      </div>
                    )}

                    <div className="customize-divider">
                      <span>THE FINISHING TOUCHES</span>
                    </div>
                    <fieldset className="appearance-fields" disabled={running || busy}>
                      <div className="appearance-row">
                        <div className="color-setting">
                          <label className="field-label" htmlFor="foreground">
                            Code color
                          </label>
                          <div className="color-input">
                            <input
                              id="foreground"
                              type="color"
                              value={settings.foreground}
                              onChange={(e) =>
                                setSettings((s) => ({ ...s, foreground: e.target.value }))
                              }
                            />
                            <span>{settings.foreground.toUpperCase()}</span>
                          </div>
                        </div>
                        <div className="color-setting">
                          <label className="field-label" htmlFor="background">
                            Background
                          </label>
                          <div className="color-input">
                            <input
                              id="background"
                              type="color"
                              value={settings.background}
                              onChange={(e) =>
                                setSettings((s) => ({ ...s, background: e.target.value }))
                              }
                            />
                            <span>{settings.background.toUpperCase()}</span>
                          </div>
                        </div>
                        <div className="size-setting">
                          <label className="field-label" htmlFor="size">
                            Export size
                          </label>
                          <div className="select-wrap">
                            <select
                              id="size"
                              value={settings.size}
                              onChange={(e) =>
                                setSettings((s) => ({ ...s, size: Number(e.target.value) }))
                              }
                            >
                              <option value={256}>256 px</option>
                              <option value={512}>512 px</option>
                              <option value={1024}>1024 px</option>
                            </select>
                            <ChevronDown size={14} />
                          </div>
                        </div>
                      </div>
                      <button
                        className="advanced-toggle"
                        type="button"
                        aria-expanded={advanced}
                        onClick={() => setAdvanced((value) => !value)}
                      >
                        <Settings2 size={15} />
                        <span>More options</span>
                        <ChevronDown size={14} className={advanced ? 'rotated' : ''} />
                      </button>
                      {advanced && (
                        <div className="advanced-content">
                          {codeType === 'qr' ? (
                            <>
                              <label className="field-label" htmlFor="error-correction">
                                Error correction
                              </label>
                              <div className="select-wrap">
                                <select
                                  id="error-correction"
                                  value={settings.errorCorrection}
                                  onChange={(e) =>
                                    setSettings((s) => ({
                                      ...s,
                                      errorCorrection: e.target
                                        .value as CodeSettings['errorCorrection'],
                                    }))
                                  }
                                >
                                  <option value="L">Low · recovers up to 7%</option>
                                  <option value="M">Medium · recovers up to 15%</option>
                                  <option value="Q">Quartile · recovers up to 25%</option>
                                  <option value="H">High · recovers up to 30%</option>
                                </select>
                                <ChevronDown size={14} />
                              </div>
                              <p className="field-hint">
                                Higher correction keeps a damaged or smudged code readable.
                              </p>
                            </>
                          ) : (
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={settings.showLabel}
                                onChange={(e) =>
                                  setSettings((s) => ({ ...s, showLabel: e.target.checked }))
                                }
                              />{' '}
                              Show text below the barcode
                            </label>
                          )}
                        </div>
                      )}
                    </fieldset>

                    {error && (
                      <div className="error-message" role="alert">
                        <CircleHelp size={16} />
                        <span>{error}</span>
                        <button aria-label="Dismiss error" onClick={() => setError('')}>
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    <button
                      className={`primary-button generate-button ${running ? 'pause-button' : ''}`}
                      disabled={busy}
                      onClick={
                        mode === 'single'
                          ? createSingle
                          : mode === 'batch'
                            ? createBatch
                            : toggleLive
                      }
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : mode === 'live' ? (
                        running ? (
                          <Pause size={17} />
                        ) : (
                          <Play size={17} />
                        )
                      ) : (
                        <WandSparkles size={18} />
                      )}
                      <span>
                        {busy
                          ? 'Making your codes…'
                          : mode === 'single'
                            ? `Generate ${codeType === 'qr' ? 'QR code' : 'barcode'}`
                            : mode === 'batch'
                              ? 'Generate collection'
                              : running
                                ? 'Pause generation'
                                : 'Start generating'}
                      </span>
                      {!busy && !running && <ArrowRight size={18} />}
                    </button>
                    <p className="under-button">
                      <ShieldCheck size={13} /> Free to create. Yours to keep.
                    </p>
                  </div>
                </section>

                <section className="preview-card panel" aria-labelledby="preview-title">
                  <div className="panel-heading">
                    <div className="panel-title">
                      <span className="step-number">02</span>
                      <h2 id="preview-title">
                        {mode === 'batch' ? 'The collection' : 'The magic, made visible'}
                      </h2>
                    </div>
                    <span className={`preview-tag ${running ? 'is-live' : ''}`}>
                      <span />
                      {mode === 'batch'
                        ? `${batchCodes.length} CODES`
                        : running
                          ? 'LIVE'
                          : 'PREVIEW'}
                    </span>
                  </div>
                  {mode === 'batch' ? (
                    <div className="batch-preview">
                      <div className={`batch-grid ${batchCodes.length ? '' : 'empty-grid'}`}>
                        {batchCodes.length ? (
                          batchCodes.map((code, index) => (
                            <article className="batch-item" key={code.id}>
                              <span className="batch-index">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <img
                                src={code.dataUrl}
                                alt={`${code.type === 'qr' ? 'QR code' : 'Barcode'} for ${code.text}`}
                              />
                              <p title={code.text}>{code.text}</p>
                              <button
                                onClick={() => download('svg', code)}
                                aria-label={`Download item ${index + 1} as SVG`}
                              >
                                <ArrowDownToLine size={13} />
                              </button>
                            </article>
                          ))
                        ) : (
                          <div className="empty-state">
                            <span className="empty-icon">
                              <Layers size={32} />
                            </span>
                            <h3>Your collection starts here.</h3>
                            <p>
                              Add a list and generate your codes.
                              <br />
                              We’ll take care of the little squares.
                            </p>
                            <span className="empty-format">
                              JSON ARRAY <Plus size={11} /> QR OR BARCODE
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="batch-export">
                        <p>
                          <span className="status-dot" />
                          {batchCodes.length
                            ? `${batchCodes.length} codes · ready for the real world`
                            : 'Made for labels, lists, and big ideas'}
                        </p>
                        <div className="download-buttons">
                          <button
                            className="primary-button"
                            disabled={!batchCodes.length || exporting}
                            onClick={() => pdf(batchCodes)}
                          >
                            {exporting ? (
                              <LoaderCircle size={16} className="spin" />
                            ) : (
                              <FileDown size={16} />
                            )}{' '}
                            Download PDF
                          </button>
                          <button
                            className="secondary-button"
                            disabled={!batchCodes.length || exporting}
                            onClick={printBatch}
                          >
                            <Printer size={16} /> Print
                          </button>
                        </div>
                        <span className="export-note">
                          A4 layout · captions included · ready to print
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="preview-body">
                      <div
                        className={`code-stage ${currentCode?.type === 'barcode' ? 'barcode-stage' : ''}`}
                      >
                        <span className="stage-corner top-left" />
                        <span className="stage-corner top-right" />
                        <span className="stage-corner bottom-left" />
                        <span className="stage-corner bottom-right" />
                        {currentCode ? (
                          <div className="code-paper" key={currentCode.id}>
                            <img
                              src={currentCode.dataUrl}
                              alt={`Generated ${currentCode.type === 'qr' ? 'QR code' : 'barcode'}`}
                            />
                          </div>
                        ) : (
                          <div className="empty-state">
                            <Radio size={37} strokeWidth={1.1} />
                            <h3>Ready when you are.</h3>
                            <p>
                              Start the generator to see
                              <br />
                              your first code appear.
                            </p>
                          </div>
                        )}
                        <span className="stage-label">
                          {currentCode
                            ? currentCode.type === 'qr'
                              ? 'A SMALL SQUARE. A NEW CONNECTION.'
                              : 'GOOD THINGS, BETWEEN THE LINES.'
                            : 'LET’S MAKE SOMETHING.'}
                        </span>
                      </div>
                      <div className="preview-meta">
                        {currentCode ? (
                          <>
                            <span className="scan-ready">
                              <span className="status-dot" />
                              {running ? `Code ${liveCount} · generating` : 'Ready to scan'}
                            </span>
                            <div className="content-copy">
                              <p title={currentCode.text}>{currentCode.text}</p>
                              <button onClick={copyValue} aria-label="Copy code content">
                                <Copy size={13} />
                              </button>
                            </div>
                          </>
                        ) : (
                          <span className="scan-ready">Your next code is just a click away.</span>
                        )}
                      </div>
                      {mode === 'live' && (
                        <div className="live-progress">
                          <div>
                            <span>
                              {running
                                ? 'Next code in'
                                : liveCount
                                  ? 'Generation paused'
                                  : 'Your interval'}
                            </span>
                            <strong>
                              {running
                                ? `${Math.max(0, (nextAt - now) / 1000).toFixed(1)}s`
                                : `${frequency || '0'}s`}
                            </strong>
                          </div>
                          <div className="progress-track">
                            <div style={{ width: `${timerPercent}%` }} />
                          </div>
                          <p>
                            {liveCount} generated this session <span>Last 6 kept below</span>
                          </p>
                        </div>
                      )}
                      <div className="download-buttons">
                        <button
                          className="primary-button"
                          onClick={() => download('png')}
                          disabled={!currentCode || exporting}
                        >
                          {exporting ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <ArrowDownToLine size={16} />
                          )}{' '}
                          Download PNG
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => download('svg')}
                          disabled={!currentCode || exporting}
                        >
                          <ArrowDownToLine size={16} /> SVG
                        </button>
                      </div>
                      <p className="export-note">
                        {currentCode?.type === 'barcode'
                          ? 'CODE 128'
                          : `${currentCode?.settings.size ?? 512} × ${currentCode?.settings.size ?? 512} px`}
                        <span>·</span> High quality, no watermark
                      </p>
                    </div>
                  )}
                </section>
              </div>

              <section className="tip-banner">
                <span className="tip-icon">
                  <Sparkles size={19} />
                </span>
                <p>
                  <strong>
                    {mode === 'single'
                      ? 'One code, a thousand uses.'
                      : mode === 'live'
                        ? 'Put your workflow on repeat.'
                        : 'From a list to a label sheet.'}
                  </strong>{' '}
                  {mode === 'single'
                    ? 'Business cards, packaging, a note worth sharing. What will you make?'
                    : mode === 'live'
                      ? 'Perfect for test data, changing displays, and fresh ideas on demand.'
                      : 'Generate your collection, download a PDF, and bring your codes into the world.'}
                </p>
                <button
                  onClick={() =>
                    mode === 'batch' ? guide.current?.showModal() : navigate('batch')
                  }
                >
                  {mode === 'batch' ? 'Print tips' : 'Try batch studio'}
                  <ArrowUpRight size={15} />
                </button>
              </section>
            </>
          )}
          <section className="recent-section" aria-labelledby="recent-title">
            <div className="recent-heading">
              <div>
                <h2 id="recent-title">Fresh from your studio</h2>
                <span>This session, just for you.</span>
              </div>
              {recent.length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    setRecent([]);
                    setNotice('Recent creations cleared.');
                  }}
                >
                  Clear recent <X size={12} />
                </button>
              )}
            </div>
            {recent.length > 0 ? (
              <div className="recent-grid">
                {recent.map((code) => (
                  <button
                    className="recent-card"
                    key={code.id}
                    onClick={() => {
                      setSingleCode(code);
                      setText(code.text);
                      setCodeType(code.type);
                      setSettings({ ...code.settings });
                      navigate('single');
                      setNotice('Opened your recent code.');
                    }}
                  >
                    <span className="recent-code-image">
                      <img src={code.dataUrl} alt="" />
                    </span>
                    <span className="recent-card-info">
                      <strong>{code.text}</strong>
                      <span>
                        {code.type === 'qr' ? 'QR CODE' : 'BARCODE'} <span>·</span>{' '}
                        {new Date(code.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="recent-empty">
                <span>
                  <Grid2X2 size={18} /> A blank canvas, for now.
                </span>
                <p>Your recent creations will feel right at home here.</p>
                <span className="recent-empty-end">
                  GO MAKE SOMETHING <ArrowUpRight size={13} />
                </span>
              </div>
            )}
          </section>
          <footer className="page-footer">
            <span>
              <LockKeyhole size={12} /> Codes are processed locally. Shared links include your
              content.
            </span>
            <span>
              LESS FRICTION. MORE CONNECTION.<span className="footer-spark">✳</span>
            </span>
          </footer>
        </main>
      </div>

      {notice && (
        <div className="toast" role="status">
          <span>
            <Check size={14} />
          </span>
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <dialog
        ref={guide}
        aria-labelledby="guide-title"
        className="guide-dialog"
        onClick={(e) => {
          if (e.target === guide.current) guide.current?.close();
        }}
      >
        <button
          className="dialog-close"
          aria-label="Close guide"
          onClick={() => guide.current?.close()}
        >
          <X size={20} />
        </button>
        <div className="guide-logo">
          <QrCode size={27} />
        </div>
        <div className="eyebrow">A LITTLE GUIDANCE</div>
        <h2 id="guide-title">Make a connection.</h2>
        <p>Everything you need to go from an idea to a scannable code.</p>
        <div className="guide-item">
          <QrCode size={21} />
          <div>
            <h3>One code, made yours</h3>
            <p>
              Enter text or a link, choose your colors, then generate. QR codes support Unicode;
              CODE128 barcodes support up to 80 printable ASCII characters.
            </p>
          </div>
        </div>
        <div className="guide-item">
          <RefreshCw size={21} />
          <div>
            <h3>A fresh code, on repeat</h3>
            <p>
              Choose a 0.5–3,600 second interval and start the live generator. Pause to edit
              settings. Switching workspaces stops the timer. Background tabs may run more slowly.
            </p>
          </div>
        </div>
        <div className="guide-item">
          <Layers size={21} />
          <div>
            <h3>A whole collection</h3>
            <p>
              Paste a JSON array of strings or numbers, or put one value on each line. Generate up
              to 100 codes, then download a PDF or print. Choose “Save as PDF” in the print dialog
              to save a copy.
            </p>
          </div>
        </div>
        <div className="guide-item">
          <ScanLine size={21} />
          <div>
            <h3>Get the text back</h3>
            <p>
              Open Scan codes to read a QR code or barcode from an image or your camera. Copy its
              text, or open it in the generator. The camera stops when you leave the scanner.
            </p>
          </div>
        </div>
        <div className="guide-item">
          <Link2 size={21} />
          <div>
            <h3>Pick up where you left off</h3>
            <p>
              The address bar keeps this workspace’s content, settings, and last generated code.
              Reload or copy the workspace link to reopen it. Links include your text; camera access
              and live generation never restart automatically.
            </p>
          </div>
        </div>
        <div className="guide-tip">
          <Zap size={17} />
          <p>
            Keep codes dark and backgrounds light. Print at actual size, preserve the white margins,
            and always test with a scanner before a large print run.
          </p>
        </div>
        <button className="primary-button" onClick={() => guide.current?.close()}>
          Let’s make something <ArrowRight size={16} />
        </button>
      </dialog>
      <section className="print-sheet" aria-label="Printable code collection">
        <header>
          <h1>Codeform collection</h1>
          <p>
            {batchCodes.length} codes · {new Date().toLocaleDateString()}
          </p>
        </header>
        <div className="print-grid">
          {batchCodes.map((code, index) => (
            <article key={code.id} className={`print-code print-${code.type}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <img src={code.dataUrl} alt={`${code.type} for ${code.text}`} />
              <p>{code.text}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default App;
