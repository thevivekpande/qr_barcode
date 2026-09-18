# Codeform

A private, browser-based QR code and barcode studio built with React, TypeScript, and Vite. Content and generated codes stay in browser memory; no account, backend, or external API is required. Fonts are bundled locally.

## Run locally

Requires Node.js 20 or later and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`).

## Workspaces

- **Single code:** Enter text or a URL, choose QR or CODE128 barcode, customize foreground/background colors and image size, and generate. Download PNG or SVG. QR error correction and barcode captions are configurable under More options.
- **Live generator:** Choose an interval of 0.5–3,600 seconds, 4–64 random characters, letters/numbers, and an optional prefix. Start and pause generation; editing settings requires pausing. Switching workspaces stops generation. The last six generated codes are available in recent creations.
- **Batch studio:** Paste a JSON array of strings/numbers or one value per line. Generate up to 100 codes, download individual SVGs, export a paginated A4 PDF, or use Print. Browser printing also supports “Save as PDF.”

Example batch:

```json
["PRODUCT-001", "PRODUCT-002", "PRODUCT-003"]
```

## Format and export details

- QR codes support Unicode text, up to 2,000 UTF-8 bytes; high error correction can reduce the available capacity.
- CODE128 supports 1–80 printable ASCII characters. Use QR for other characters.
- Blank content, invalid arrays, excessive batch sizes, and colors with insufficient contrast produce actionable errors.
- PNG export sizes are 256, 512, or 1024 pixels. Barcodes retain at least their native width so long values keep readable bars. SVGs scale without resolution loss.
- Each generated code retains its own appearance and export size, including when opened from recent creations.
- PDF export places six QR codes or four full-width barcodes on an A4 page, as space permits. Captions support Unicode and are shortened if necessary. Codes always contain the full text.
- Printed labels keep a quiet zone around each code. Print at actual size and scan a sample before a large print run.
- Generated codes and recent history last for the current page session. Reloading clears them. Live generation in background tabs may be throttled by the browser.

## Build and verify

```sh
npm run build
npm test
npm run test:e2e
```

The build is emitted to `dist/`, which can be served by any static web host. `npm run preview` serves it locally. Clipboard access requires HTTPS or localhost.

Unit tests cover batch parsing, QR/barcode validation, escaping, random character sets, and color contrast. Browser tests cover generation, scanning, downloads, timer behavior, printing, and the mobile layout; see `playwright.config.ts` for browser and server settings.

Browser tests use an installed Google Chrome and automatically start a local server on port 5174. To use Playwright’s bundled Chromium instead, remove `channel: 'chrome'` from the configuration and run `npx playwright install chromium`.

Core implementation: `src/lib/codes.ts`. Application UI: `src/App.tsx`. Responsive and print styling: `src/styles.css`.

# qr_barcode
