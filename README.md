# Codeform

A browser-based QR code and barcode studio built with React, TypeScript, and Vite. Generation and image/camera decoding run locally; no account, backend, or external decoding API is required. The active workspace is stored in the URL so it can be reloaded or shared. Fonts are bundled locally.

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
- **Scan codes:** Upload or drop a PNG, JPEG, WebP, or SVG image (up to 10 MB), or select Start camera. Read QR codes, CODE128, and other common barcode formats. Copy the exact decoded text or send it to the generator. Camera frames and image files stay on your device. Camera access requires HTTPS or localhost and browser permission; it stops on a successful scan, when stopped manually, when the tab is hidden, or when you leave the scanner.

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
- Recent history lasts for the current page session. Reloading restores the active workspace’s last generated code or collection from the URL. Live generation in background tabs may be throttled by the browser.

## Reloading and sharing a workspace

Each workspace has a path: `/single`, `/live`, `/batch`, or `/scan`. Query parameters keep its content, controls, and last generated preview. For example, `/single?type=barcode&text=PRODUCT-001&size=1024` opens a barcode ready to download. When an encoded URL exceeds 6,000 characters, its state moves into the URL fragment (`#state=…`) so large batches can reload without exceeding the server’s request-header limit.

- The address bar updates as you edit. Select **Copy link** to share or bookmark the current workspace.
- Edited inputs and the last generated code are stored separately, so reloading an unfinished edit preserves the same preview. Batch collections and decoded scan results are restored too.
- Browser Back and Forward restore workspaces. Live timers and cameras always require an explicit start after reloading.
- Only the active workspace is included in a link. Recent history, uploaded image files, camera frames, and session counters are not included.
- Links contain the active workspace’s text and settings. They can be seen by anyone you share the link with and appear in browser history. Query parameters are sent to your host when opening the URL; fragment contents are processed only in the browser. Extremely large links may still exceed a browser or messaging service’s limits; PDF/SVG downloads remain available for those collections.

## Build and verify

```sh
npm run build
npm test
npm run test:e2e
```

The build is emitted to `dist/`. Configure your static host to serve `index.html` for `/single`, `/live`, `/batch`, and `/scan`, preserving the query string, so direct links and reloads work. Vite’s development and preview servers provide this fallback automatically. `npm run preview` serves the production build locally. Clipboard and camera access require HTTPS or localhost.

Unit tests cover batch parsing, QR/barcode generation and decoding, image validation, URL state round trips, escaping, randomness, and color contrast. Browser tests cover generation, image scanning, simulated camera decoding and resource cleanup, share links and reloads, downloads, timers, printing, and mobile layout; see `playwright.config.ts` for browser and server settings.

Browser tests use an installed Google Chrome and automatically start a local server on port 5174. To use Playwright’s bundled Chromium instead, remove `channel: 'chrome'` from the configuration and run `npx playwright install chromium`.

Core implementation: `src/lib/codes.ts`. Application UI: `src/App.tsx`. Responsive and print styling: `src/styles.css`.

# qr_barcode
