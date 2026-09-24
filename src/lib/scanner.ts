import {
  BarcodeFormat,
  BinaryBitmap,
  ChecksumException,
  DecodeHintType,
  FormatException,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from '@zxing/library';

export type ScanResult = { text: string; format: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_DECODE_EDGE = 2400;
const reader = new MultiFormatReader();
const hints = new Map<DecodeHintType, unknown>();
hints.set(DecodeHintType.TRY_HARDER, true);
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC,
  BarcodeFormat.PDF_417,
]);
reader.setHints(hints);

/** Decode RGBA pixels without changing the encoded whitespace or Unicode text. */
export function decodeCodePixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ScanResult | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 6_000_000 ||
    pixels.length !== width * height * 4
  ) {
    throw new Error('This image cannot be scanned. Choose a smaller, valid image.');
  }
  const luminance = new Uint8ClampedArray(width * height);
  for (let index = 0; index < luminance.length; index++) {
    const offset = index * 4;
    const alpha = pixels[offset + 3] / 255;
    const value = (pixels[offset] + 2 * pixels[offset + 1] + pixels[offset + 2]) / 4;
    luminance[index] = Math.round(value * alpha + 255 * (1 - alpha));
  }
  const source = new RGBLuminanceSource(luminance, width, height);
  for (const candidate of [source, source.invert()]) {
    try {
      const decoded = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(candidate)));
      return { text: decoded.getText(), format: BarcodeFormat[decoded.getBarcodeFormat()] };
    } catch (error) {
      if (!(
        error instanceof NotFoundException ||
        error instanceof ChecksumException ||
        error instanceof FormatException
      ))
        throw error;
    } finally {
      reader.reset();
    }
  }
  return null;
}

export function decodeCodeFromCanvas(canvas: HTMLCanvasElement): ScanResult | null {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Your browser could not read this image. Try a different browser.');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return decodeCodePixels(image.data, image.width, image.height);
}

export function validateScanFile(file: File): void {
  const allowedMime = /^(image\/(png|jpeg|webp|svg\+xml))$/i;
  const allowedName = /\.(png|jpe?g|webp|svg)$/i;
  if (!(
    allowedMime.test(file.type) ||
    ((!file.type || file.type === 'application/octet-stream') && allowedName.test(file.name))
  )) {
    throw new Error('Choose a PNG, JPEG, WebP, or SVG image.');
  }
  if (!file.size) throw new Error('This image is empty. Choose another file.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 10 MB.');
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Scanning was cancelled.', 'AbortError');
}

async function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      image.src = '';
      reject(new DOMException('Scanning was cancelled.', 'AbortError'));
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(
        new Error(
          'This file could not be read as an image. Choose a valid PNG, JPEG, WebP, or SVG.',
        ),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

export async function decodeImageFile(file: File, signal?: AbortSignal): Promise<ScanResult> {
  validateScanFile(file);
  abortIfNeeded(signal);
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url, signal);
    abortIfNeeded(signal);
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS ||
      Math.max(image.naturalWidth, image.naturalHeight) > 16000
    ) {
      throw new Error(
        'This image is too large to scan. Resize it to less than 40 megapixels and try again.',
      );
    }
    const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    for (const rotated of [false, true]) {
      abortIfNeeded(signal);
      canvas.width = rotated ? height : width;
      canvas.height = rotated ? width : height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context)
        throw new Error('Your browser could not read this image. Try a different browser.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (rotated) {
        context.translate(height, 0);
        context.rotate(Math.PI / 2);
      }
      context.drawImage(image, 0, 0, width, height);
      const result = decodeCodeFromCanvas(canvas);
      if (result) return result;
      // Yield between orientations so a new file or navigation can cancel the operation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    abortIfNeeded(signal);
    throw new Error(
      'No readable QR code or barcode was found. Try a sharper image with the whole code and its surrounding border visible.',
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError')
    return 'Camera permission was denied. Allow camera access in your browser, or upload an image instead.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No camera was found. Connect a camera or upload an image instead.';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'Your camera is busy or unavailable. Close other apps using it, then try again.';
  if (name === 'OverconstrainedError')
    return 'This camera could not start with the requested settings. Try another camera or upload an image.';
  return 'The camera could not start. Check camera access in your browser, or upload an image instead.';
}
