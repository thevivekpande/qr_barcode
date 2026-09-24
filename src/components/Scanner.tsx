import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Camera,
  Check,
  Copy,
  ImagePlus,
  LoaderCircle,
  ScanLine,
  ShieldCheck,
  Square,
  Upload,
  X,
} from 'lucide-react';
import {
  cameraErrorMessage,
  decodeCodeFromCanvas,
  decodeImageFile,
  validateScanFile,
} from '../lib/scanner';
import type { ScanResult } from '../lib/scanner';
import './Scanner.css';

type ScannerProps = {
  result: ScanResult | null;
  onResult: (result: ScanResult | null) => void;
  onUseText: (result: ScanResult) => void;
};

export default function Scanner({ result, onResult, onUseText }: ScannerProps) {
  const [camera, setCamera] = useState<'off' | 'requesting' | 'active'>('off');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [imagePreview, setImagePreview] = useState('');
  const [imageName, setImageName] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef(0);
  const frameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const releaseResources = useCallback(() => {
    request.current++;
    imageAbort.current?.abort();
    imageAbort.current = null;
    if (frameTimer.current !== null) clearTimeout(frameTimer.current);
    frameTimer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const handleVisibility = () => {
      if (document.hidden) {
        const hadCamera = !!stream.current;
        releaseResources();
        setCamera('off');
        setReading(false);
        if (hadCamera)
          setStatus('Camera stopped while this tab was hidden. Start it again when you are ready.');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      mounted.current = false;
      releaseResources();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [releaseResources]);

  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    },
    [imagePreview],
  );
  useEffect(() => {
    setCopied(false);
  }, [result]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const isCurrent = (token: number) => mounted.current && token === request.current;

  async function readFile(file: File) {
    releaseResources();
    setCamera('off');
    setReading(false);
    setError('');
    setStatus('');
    setDragging(false);
    const token = request.current;
    try {
      validateScanFile(file);
      const controller = new AbortController();
      imageAbort.current = controller;
      setImagePreview(URL.createObjectURL(file));
      setImageName(file.name);
      setReading(true);
      onResultRef.current(null);
      const decoded = await decodeImageFile(file, controller.signal);
      if (!isCurrent(token)) return;
      onResultRef.current(decoded);
      setStatus('Code found. Your decoded text is ready.');
    } catch (cause) {
      if (isCurrent(token) && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'This image could not be scanned. Try another image.',
        );
      }
    } finally {
      if (isCurrent(token)) {
        setReading(false);
        imageAbort.current = null;
      }
    }
  }

  function stopCamera() {
    releaseResources();
    setCamera('off');
    setReading(false);
    setStatus('Camera stopped.');
  }

  async function startCamera() {
    releaseResources();
    setError('');
    setStatus('');
    setImagePreview('');
    setImageName('');
    setReading(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'Camera access is unavailable here. Use HTTPS or localhost, or upload an image instead.',
      );
      return;
    }
    const token = request.current;
    setCamera('requesting');
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!isCurrent(token) || document.hidden) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = acquired;
      const element = video.current;
      if (!element) {
        releaseResources();
        return;
      }
      for (const track of acquired.getVideoTracks()) {
        track.addEventListener(
          'ended',
          () => {
            if (!isCurrent(token)) return;
            releaseResources();
            setCamera('off');
            setError('Camera access ended. Start the camera again or upload an image.');
          },
          { once: true },
        );
      }
      element.srcObject = acquired;
      await element.play();
      if (!isCurrent(token)) return;
      setCamera('active');
      onResultRef.current(null);
      setStatus('Looking for a code. Hold it steady inside the camera view.');
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('CanvasUnavailable');
      let rotateFrame = false;
      const scan = () => {
        if (!isCurrent(token)) return;
        try {
          if (element.readyState >= 2 && element.videoWidth && element.videoHeight) {
            const scale = Math.min(1, 1280 / Math.max(element.videoWidth, element.videoHeight));
            const width = Math.round(element.videoWidth * scale);
            const height = Math.round(element.videoHeight * scale);
            // Alternating orientation also reads barcodes held vertically.
            canvas.width = rotateFrame ? height : width;
            canvas.height = rotateFrame ? width : height;
            if (rotateFrame) {
              context.translate(height, 0);
              context.rotate(Math.PI / 2);
            }
            context.drawImage(element, 0, 0, width, height);
            rotateFrame = !rotateFrame;
            const decoded = decodeCodeFromCanvas(canvas);
            if (decoded) {
              releaseResources();
              setCamera('off');
              onResultRef.current(decoded);
              setStatus('Code found. Camera stopped automatically.');
              return;
            }
          }
          frameTimer.current = setTimeout(scan, 250);
        } catch {
          if (!isCurrent(token)) return;
          releaseResources();
          setCamera('off');
          setError(
            'The camera image could not be read. Try restarting the camera or upload an image.',
          );
        }
      };
      frameTimer.current = setTimeout(scan, 100);
    } catch (cause) {
      if (!isCurrent(token)) return;
      releaseResources();
      setCamera('off');
      setError(cameraErrorMessage(cause));
    }
  }

  function clear() {
    releaseResources();
    setCamera('off');
    setReading(false);
    setImagePreview('');
    setImageName('');
    setError('');
    setStatus('Scanner cleared. Ready for another code.');
    setCopied(false);
    if (fileInput.current) fileInput.current.value = '';
    onResultRef.current(null);
  }

  async function copyText() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
    } catch {
      setError('Clipboard access is unavailable. Select the decoded text and copy it manually.');
    }
  }

  return (
    <div className="scanner-workspace">
      <div className="scanner-grid">
        <section className="panel scanner-input" aria-labelledby="scanner-source-title">
          <div className="panel-heading">
            <div className="panel-title">
              <span className="step-number">01</span>
              <h2 id="scanner-source-title">Bring your code</h2>
            </div>
            <span className="panel-caption">QR + barcodes</span>
          </div>
          <div className="scanner-panel-body">
            <label
              htmlFor="scanner-image"
              className={`scanner-upload${dragging ? ' is-dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void readFile(file);
                else setDragging(false);
              }}
            >
              <input
                ref={fileInput}
                id="scanner-image"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
                aria-label="Upload code image"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void readFile(file);
                  event.currentTarget.value = '';
                }}
              />
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Selected code to scan"
                  className="scanner-upload-preview"
                />
              ) : (
                <span className="scanner-upload-icon">
                  <ImagePlus size={26} strokeWidth={1.4} />
                </span>
              )}
              <strong>
                {reading
                  ? 'Reading your image…'
                  : imagePreview
                    ? 'Choose another image'
                    : 'Drop a code image here'}
              </strong>
              <span className="scanner-upload-action">
                {reading ? (
                  <LoaderCircle size={14} className="scanner-spin" />
                ) : (
                  <Upload size={13} />
                )}{' '}
                {reading ? 'Decoding on your device' : 'or click to browse'}
              </span>
              <small>PNG, JPEG, WebP or SVG · up to 10 MB</small>
            </label>
            {imageName && (
              <p className="scanner-filename" title={imageName}>
                {imageName}
              </p>
            )}
            <div className="scanner-divider">
              <span>OR USE YOUR CAMERA</span>
            </div>
            <div className={`scanner-camera-view${camera === 'off' ? ' is-off' : ''}`}>
              <video ref={video} muted playsInline autoPlay aria-label="Camera scanning preview" />
              {camera !== 'off' && (
                <>
                  <span className="scanner-camera-corners" aria-hidden="true" />
                  <span className="scanner-camera-label">
                    {camera === 'requesting'
                      ? 'Waiting for camera access…'
                      : 'Position one code in the frame'}
                  </span>
                </>
              )}
            </div>
            {camera === 'off' ? (
              <button
                type="button"
                className="secondary-button scanner-camera-button"
                onClick={() => void startCamera()}
                disabled={reading}
              >
                <Camera size={17} />
                Start camera
              </button>
            ) : (
              <button
                type="button"
                className="primary-button scanner-camera-button"
                onClick={stopCamera}
              >
                <Square size={14} />
                Stop camera
              </button>
            )}
            <p className="scanner-camera-hint">
              {camera === 'requesting'
                ? 'Allow camera access in your browser to begin. You can cancel at any time.'
                : 'Point your camera at a code. Scanning stops as soon as it is found.'}
            </p>
            <p className="scanner-privacy">
              <ShieldCheck size={14} />
              Images and camera frames stay on your device.
            </p>
          </div>
        </section>

        <section className="panel scanner-output" aria-labelledby="scanner-result-title">
          <div className="panel-heading">
            <div className="panel-title">
              <span className="step-number">02</span>
              <h2 id="scanner-result-title">Behind the code</h2>
            </div>
            <span className={`scanner-result-badge${result ? ' is-ready' : ''}`}>
              {result ? <Check size={11} /> : <ScanLine size={11} />}
              {result ? 'CODE FOUND' : 'READY TO SCAN'}
            </span>
          </div>
          {result ? (
            <div className="scanner-panel-body scanner-result-body">
              <div className="scanner-result-format">
                <span>DETECTED FORMAT</span>
                <strong>{result.format.replaceAll('_', ' ')}</strong>
              </div>
              <label className="field-label" htmlFor="scanner-decoded-text">
                Decoded text
              </label>
              <textarea
                id="scanner-decoded-text"
                className="scanner-decoded-text"
                readOnly
                value={result.text}
                spellCheck={false}
                rows={8}
              />
              <p className="scanner-result-hint">
                Your text is shown exactly as encoded, including spaces and line breaks.
              </p>
              <div className="scanner-result-actions">
                <button type="button" className="secondary-button" onClick={() => void copyText()}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? 'Copied!' : 'Copy text'}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    releaseResources();
                    onUseText(result);
                  }}
                >
                  Use in generator
                  <ArrowRight size={15} />
                </button>
              </div>
              <button type="button" className="scanner-clear" onClick={clear}>
                <X size={13} />
                Clear result
              </button>
            </div>
          ) : (
            <div className="scanner-empty">
              <div className="scanner-empty-art" aria-hidden="true">
                <ScanLine size={70} strokeWidth={0.8} />
                <span />
              </div>
              <h3>A code has something to say.</h3>
              <p>
                Upload an image or start your camera.
                <br />
                The decoded text will appear here.
              </p>
              <div className="scanner-formats">
                <span>QR</span>
                <span>CODE 128</span>
                <span>EAN / UPC</span>
                <span>+ MORE</span>
              </div>
            </div>
          )}
        </section>
      </div>
      {error && (
        <div className="scanner-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss scanner error">
            <X size={15} />
          </button>
        </div>
      )}
      <p className="scanner-status" role="status" aria-live="polite">
        {status}
      </p>
      {!result && (imagePreview || reading || camera !== 'off') && (
        <button type="button" className="scanner-clear scanner-reset" onClick={clear}>
          <X size={13} />
          Reset scanner
        </button>
      )}
    </div>
  );
}
