import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';

export type CodeType = 'qr' | 'barcode';
export type CodeSettings = {
  size: number;
  foreground: string;
  background: string;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  showLabel: boolean;
};
export type GeneratedCode = {
  id: string;
  text: string;
  type: CodeType;
  svg: string;
  dataUrl: string;
  createdAt: number;
  settings: CodeSettings;
};

const MAX_BATCH_SIZE = 100;
const MAX_QR_BYTES = 2000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function luminance(hex: string): number | null {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : hex.slice(1);
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function validateCodeColors(foreground: string, background: string): string | null {
  const dark = luminance(foreground);
  const light = luminance(background);
  if (dark === null || light === null)
    return 'Choose valid hex colors for your code and background.';
  if (dark >= light)
    return 'Choose a darker code color and a lighter background for reliable scanning.';
  if ((light + 0.05) / (dark + 0.05) < 3)
    return 'These colors are too similar. Increase the contrast for reliable scanning.';
  return null;
}

export async function generateCode(
  text: string,
  type: CodeType,
  settings: CodeSettings,
): Promise<GeneratedCode> {
  if (!text.trim()) throw new Error('Enter some text to generate a code.');
  const colorError = validateCodeColors(settings.foreground, settings.background);
  if (colorError) throw new Error(colorError);
  if (!Number.isFinite(settings.size) || settings.size < 64 || settings.size > 4096) {
    throw new Error('Choose an image size between 64 and 4096 pixels.');
  }
  let svg: string;
  if (type === 'qr') {
    if (new TextEncoder().encode(text).length > MAX_QR_BYTES) {
      throw new Error('This text is too long. QR codes support up to 2,000 UTF-8 bytes here.');
    }
    try {
      svg = await QRCode.toString(text, {
        type: 'svg',
        width: settings.size,
        margin: 4,
        color: { dark: settings.foreground, light: settings.background },
        errorCorrectionLevel: settings.errorCorrection,
      });
    } catch {
      throw new Error(
        'This text exceeds QR capacity at the selected error correction level. Shorten it or lower error correction.',
      );
    }
  } else {
    if (!/^[\x20-\x7E]+$/.test(text)) {
      throw new Error(
        'Code 128 barcodes support printable English letters, numbers, spaces, and symbols. Use a QR code for other characters.',
      );
    }
    if (text.length > 80)
      throw new Error('Keep barcode text to 80 characters or fewer for reliable scanning.');
    const node = document.createElementNS(SVG_NAMESPACE, 'svg');
    try {
      JsBarcode(node, text, {
        format: 'CODE128',
        width: 2,
        height: Math.max(90, Math.round(text.length * 2.75)),
        margin: 24,
        displayValue: settings.showLabel,
        font: 'monospace',
        fontSize: 18,
        textMargin: 8,
        lineColor: settings.foreground,
        background: settings.background,
      });
      svg = new XMLSerializer().serializeToString(node);
    } catch {
      throw new Error(
        'This text could not be encoded as a Code 128 barcode. Try a shorter value using printable English characters.',
      );
    }
  }
  return {
    id: crypto.randomUUID(),
    text,
    type,
    svg,
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    createdAt: Date.now(),
    settings: { ...settings },
  };
}

/** JSON string/number arrays or one value per line; blank lines are skipped. */
export function parseBatchInput(input: string): string[] {
  if (!input.trim()) throw new Error('Enter a JSON array or one value per line.');
  let values: string[];
  if (input.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error(
        'That JSON array is not valid. Use double quotes around text, for example ["Item 1", "Item 2"].',
      );
    }
    if (!Array.isArray(parsed)) throw new Error('Enter an array of text or numbers.');
    if (
      parsed.some(
        (item) => typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item)),
      )
    ) {
      throw new Error(
        'Each array item must be text or a finite number. Nested arrays, objects, and null are not supported.',
      );
    }
    values = parsed.map(String);
    if (values.some((value) => !value.trim()))
      throw new Error('Remove empty values from your array before generating.');
  } else {
    values = input.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  }
  if (!values.length) throw new Error('Add at least one value to generate your collection.');
  if (values.length > MAX_BATCH_SIZE)
    throw new Error(
      `A collection can contain up to ${MAX_BATCH_SIZE} values. Split your list into smaller batches.`,
    );
  return values;
}

export function randomText(
  length: number,
  charset: 'alphanumeric' | 'numeric' | 'alphabetic',
  prefix = '',
): string {
  if (!Number.isInteger(length) || length < 1 || length > 256)
    throw new Error('Choose a random text length between 1 and 256.');
  const alphabets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  };
  const alphabet = alphabets[charset];
  if (!alphabet) throw new Error('Choose a supported character set.');
  // Rejection sampling avoids giving the first characters a greater probability.
  const limit = 256 - (256 % alphabet.length);
  let value = '';
  while (value.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, (length - value.length) * 2)));
    for (const byte of bytes) {
      if (byte < limit) value += alphabet[byte % alphabet.length];
      if (value.length === length) break;
    }
  }
  return prefix + value;
}

async function svgImage(code: GeneratedCode): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('The code image could not be prepared. Please generate it again.'));
    image.src = code.dataUrl;
  });
}

async function rasterize(code: GeneratedCode, size: number): Promise<HTMLCanvasElement> {
  const image = await svgImage(code);
  const canvas = document.createElement('canvas');
  const ratio = image.naturalHeight / image.naturalWidth;
  canvas.width = Math.max(1, Math.round(size), code.type === 'barcode' ? image.naturalWidth : 0);
  canvas.height = Math.max(1, Math.round(canvas.width * ratio));
  const context = canvas.getContext('2d');
  if (!context)
    throw new Error('Your browser could not prepare this image. Try downloading the SVG instead.');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadCode(
  code: GeneratedCode,
  format: 'svg' | 'png',
  size: number,
): Promise<void> {
  const filename = `${code.type}-${code.id.slice(0, 8)}.${format}`;
  if (format === 'svg') {
    saveBlob(new Blob([code.svg], { type: 'image/svg+xml;charset=utf-8' }), filename);
    return;
  }
  if (!Number.isFinite(size) || size < 64 || size > 4096)
    throw new Error('Choose an image size between 64 and 4096 pixels.');
  const canvas = await rasterize(code, size);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) =>
        result
          ? resolve(result)
          : reject(new Error('The PNG could not be created. Try downloading the SVG instead.')),
      'image/png',
    );
  });
  saveBlob(blob, filename);
}

/** Browser-rendered captions retain Unicode without bundling a restricted PDF font. */
function captionImage(text: string, width: number): { dataUrl: string; height: number } {
  const scale = 6;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare PDF labels.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#334155';
  context.font = '22px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const lines: string[] = [];
  let line = '';
  const characters = Array.from(text.replace(/\r\n|\r|\n/g, ' ↵ '));
  for (let index = 0; index < characters.length; index++) {
    const candidate = line + characters[index];
    if (context.measureText(candidate).width > canvas.width - 24 && line) {
      lines.push(line);
      line = characters[index];
      if (lines.length === 2) {
        let last = '';
        for (let remainder = index; remainder < characters.length; remainder++) {
          if (context.measureText(last + characters[remainder] + '…').width > canvas.width - 24)
            break;
          last += characters[remainder];
        }
        lines.push(last + '…');
        line = '';
        break;
      }
    } else line = candidate;
  }
  if (line) lines.push(line);
  lines.forEach((value, index) => context.fillText(value, canvas.width / 2, 5 + index * 29));
  return { dataUrl: canvas.toDataURL('image/png'), height: canvas.height / scale };
}

export async function exportPdf(codes: GeneratedCode[]): Promise<void> {
  if (!codes.length) throw new Error('Generate at least one code before exporting a PDF.');
  if (codes.length > MAX_BATCH_SIZE) throw new Error('Export up to 100 codes in one PDF.');
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const margin = 12;
  const contentWidth = 186;
  const columnGap = 8;
  const columnWidth = (contentWidth - columnGap) / 2;
  const bottom = 276;
  let y = 30;
  let page = 1;
  const addHeader = () => {
    pdf.setTextColor(15, 23, 42);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(17);
    pdf.text('QR & Barcode collection', margin, 16);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(
      `${codes.length} code${codes.length === 1 ? '' : 's'}  |  ${new Date().toLocaleDateString('en-GB')}`,
      margin,
      22,
    );
  };
  const addFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Page ${page}`, 198, 286, { align: 'right' });
  };
  addHeader();
  for (let index = 0; index < codes.length;) {
    const isQr = codes[index].type === 'qr';
    const row = [codes[index]];
    if (isQr && codes[index + 1]?.type === 'qr') row.push(codes[index + 1]);
    const rowHeight = isQr ? 80 : 60;
    if (y + rowHeight > bottom) {
      addFooter();
      pdf.addPage();
      page++;
      y = 30;
      addHeader();
    }
    for (let column = 0; column < row.length; column++) {
      const code = row[column];
      const cardWidth = isQr ? columnWidth : contentWidth;
      const x = margin + column * (columnWidth + columnGap);
      pdf.setDrawColor(226, 232, 240);
      pdf.roundedRect(x, y, cardWidth, rowHeight - 4, 2, 2, 'S');
      // Large raster sources preserve crisp modules and barcode quiet zones in print.
      const canvas = await rasterize(code, isQr ? 1200 : 2400);
      const imageBoxWidth = cardWidth - 8;
      const imageBoxHeight = isQr ? 56 : 35;
      const ratio = canvas.height / canvas.width;
      const imageWidth = Math.min(imageBoxWidth, imageBoxHeight / ratio);
      const imageHeight = imageWidth * ratio;
      pdf.addImage(
        canvas.toDataURL('image/png'),
        'PNG',
        x + (cardWidth - imageWidth) / 2,
        y + 3 + (imageBoxHeight - imageHeight) / 2,
        imageWidth,
        imageHeight,
        `code-${index + column}`,
        'FAST',
      );
      const caption = captionImage(`${index + column + 1}. ${code.text}`, cardWidth - 6);
      pdf.addImage(
        caption.dataUrl,
        'PNG',
        x + 3,
        y + imageBoxHeight + 3,
        cardWidth - 6,
        caption.height,
        `label-${index + column}`,
        'FAST',
      );
    }
    y += rowHeight;
    index += row.length;
  }
  addFooter();
  pdf.save(`code-collection-${new Date().toISOString().slice(0, 10)}.pdf`);
}
