# Codeform

A browser-based QR code, barcode, and RFID reader studio built with React, TypeScript, and Vite. Generation, image/camera decoding, and reader diagnostics run locally; no account, backend, or external decoding API is required. The active workspace is stored in the URL so it can be reloaded or shared. Fonts are bundled locally.

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
- **RFID lab:** Connect and test a USB reader using keyboard input, raw HID reports, or a serial port. Inspect received text and hex, export the session log, send a documented test command, or configure generic memory read/write commands for a compatible reader. Reader connections and writes always require an explicit action.

Example batch:

```json
["PRODUCT-001", "PRODUCT-002", "PRODUCT-003"]
```

## RFID reader setup

Open `/rfid` and select the interface your reader exposes. A USB connector alone does not identify the protocol; check the reader's manual and operating mode.

| Mode                  | Compatible reader                               | Setup and browser requirements                                                                                                                                                  |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USB HID · Keyboard    | A reader that types a tag value like a keyboard | Start capture and keep the capture field focused. Automatic mode accepts Enter, Tab, or an idle gap. Uses ordinary keyboard events and does not open a USB permission chooser.  |
| USB HID · Raw reports | A reader exposing accessible HID input reports  | Use a desktop browser with WebHID, such as Chrome, on HTTPS or localhost. Select the reader in the permission chooser. Reports retain their report IDs and bytes.               |
| USB serial            | A reader exposing a serial/virtual COM port     | Use a desktop browser with Web Serial, such as Chrome, on HTTPS or localhost. Select the port and match the reader's baud rate, data bits, stop bits, parity, and flow control. |

Chrome protects standard keyboard, mouse, and system-control HID collections. A composite reader may expose both a keyboard interface and a vendor HID interface: its tag values can arrive as keystrokes even while raw HID is connected. **Test keyboard input** closes the raw connection, switches to automatic keyboard capture, and focuses the input field. Some vendor HID reports are also unavailable because of browser or operating-system restrictions. See the official [WebHID documentation](https://developer.chrome.com/docs/capabilities/hid) for device selection, reports, and protected collections. The [Web Serial documentation](https://developer.chrome.com/docs/capabilities/serial) explains port permissions, connection settings, streams, and platform support. The app checks API availability and shows an explanation when a transport is unsupported.

Keyboard capture defaults to **Automatic**, which finishes a read on Enter, Tab, or a **150 ms idle gap**, configurable from 50–2,000 ms. Strict Enter-only, Tab-only, and idle-only modes remain available. Capture pauses and discards partial input when the field or browser loses focus, or the tab becomes hidden. The test stays started: return to the tab and focus **Reader input** to continue. Escape stops it. Ordinary typing in the focused capture field is indistinguishable from a keyboard reader. This mode cannot enumerate the reader, identify its USB vendor, or send device commands.

Generic serial defaults are **9600 baud, 8 data bits, 1 stop bit, no parity, and no flow control**. **Automatic** receive framing finishes on CR, LF, CRLF, or a **150 ms idle gap**. Choose strict line framing when each message requires a line ending, idle-only framing for gap-separated messages, or raw chunks to inspect stream deliveries directly. Framing joins split UTF-8 sequences before decoding and removes line delimiters in line/automatic modes. A stream chunk is a transport delivery, not necessarily one tag or one protocol message.

Recoverable serial stream errors discard the partial frame and resume from the replacement stream; the activity notice identifies possible data loss. An interrupted memory exchange is canceled and disconnected rather than combining bytes across that error. Repeated errors without received data end the connection. Where the browser supports serial line signals, **DTR** and **RTS** start at **Leave unchanged** and are applied only through **Apply line signals**. The app makes no automatic signal changes on connection. With hardware flow control, RTS is managed by the driver and cannot be overridden in the panel.

For composite HID devices, the app prefers an accessible vendor input interface, with input/output support preferred, instead of an earlier keyboard or consumer-control interface. It registers the input listener before opening so early reports are retained. Declared input and output report IDs are displayed; memory response matching defaults to the first declared input ID. An interface opening successfully establishes a transport connection, not a working tag protocol.

**Latest USB report/chunk** shows the most recent incoming bytes before framing or memory decoding, with a preview of up to 4,096 bytes. This helps distinguish missing input from data waiting for a delimiter. If no input arrives after connection, the page suggests checking the serial settings, documented commands, or keyboard mode for a composite HID reader. A reader may require a documented polling command before sending data.

Raw HID inventory notifications matching the **RF protocol** show a separate **Decoded tag EPC** with a copy button. The decoder checks the frame length, notification type/code, additive checksum, and nested tag lengths before extracting an EPC. It accepts complete RF frames and the observed 64-byte HID report format with a leading payload length and zero padding. The supplied report beginning `19 52 46 02` decodes to `E28011704000021C5BEED15E`. This is an inventory identifier; it does not fill a memory response or write command. The frame and EPC definitions come from `C#/doc/UHF communication protocol.doc` in the [vendor CPH SDK archive (mirror)](https://github.com/klks/CPH-F206_Reversing_Notes/blob/main/sdk/CPH-%E5%BC%80%E5%8F%91%E5%8C%85%E8%B5%84%E6%96%99%202025.7.10.zip), sections “Frame format definition”, “Tags Uploaded”, and “Single Tag”. A matching frame identifies a compatible protocol, not the exact reader model.

All received bytes remain available as raw text/hex, including unrecognized or invalid packets. Binary RFID frames can contain bytes that are not valid UTF-8; the text preview can therefore contain replacement characters, while hex preserves every byte. Other tag formats, startup commands, and serial settings require the manufacturer's protocol documentation. Readers requiring a vendor SDK, smart-card/PC/SC integration, or an unavailable browser interface are not directly supported by this lab.

For serial troubleshooting, first check that the page shows **Connected**, then watch **DATA IN** while presenting a tag. A disconnected port cannot receive data, and zero incoming bytes cannot be fixed by changing the display decoder. Use the reader's documented serial settings and close other tabs/apps using the same port. Connection and receive errors include the browser's underlying error name/message when available. Chrome's `chrome://device-log` also provides Serial events for diagnosis; see [Chrome's serial developer tips](https://developer.chrome.com/docs/capabilities/serial#dev-tips).

Test commands are sent only when you explicitly choose Send command. Enter UTF-8 text or complete hexadecimal bytes, such as `02 0A FF`; serial commands can optionally append LF or CRLF. Raw HID requires an output report ID declared by the device and sends the entered bytes without appending a line ending; feature reports are not implemented. Command payloads and received frames are capped at **4,096 bytes**; oversized frames are discarded rather than silently truncated. Serial sends time out after five seconds and disconnect the stalled connection. Connecting alone sends no polling, initialization, or tag commands.

The session log keeps the **newest 100 received or diagnostic-command entries** in memory, with timestamps, transport, direction, decoded text, display text, exact hex, byte count, and HID report ID where applicable. **Export log** downloads those retained entries as `codeform-rfid-log.json`. Counters cover the session since the last clear, including entries that have rolled out of the log. Memory command requests count toward sent commands but are excluded from the log because their configured bytes may include authentication data; received memory responses still appear in reader activity. **Clear log** removes entries, counters, and partial input. Leaving or reloading the lab discards its log and command draft; exporting is the way to retain a session. RFID URLs save configuration only.

Switching tabs or applications keeps raw HID and serial connections open, so received bytes and in-progress memory responses can still arrive. Background browser scheduling can delay idle framing and timeouts; use the reader's documented delimiters when available. Leaving the RFID workspace, reloading/closing the page, or choosing Disconnect releases the selected connection. Unplugging a reader ends that connection; reconnecting requires a new explicit action. A late device selection after cancellation is ignored, and a connection that finishes opening after cancellation is closed.

### RE422 / RE40 serial reader

Open `/rfid?reader=serial&model=re422`, or select **USB serial → Serial reader model → RE422 / RE40 (binary)**. This applies **921600 baud, 8 data bits, 1 stop bit, no parity, no flow control**, and raw chunk display. A reader configured with a different baud rate can still be adjusted. This profile supports RE40 binary mode, not RCI mode.

1. Choose **Connect serial reader** and select the RE422 serial port (the tested unit appears as CP2102 / USB `10C4:EA60`). Close other apps or tabs holding that port first.
2. Choose **Identify reader**. A valid firmware response and successful acknowledgment establish that the reader is responding; opening a port alone sends no commands.
3. Put a compatible UHF tag on the reader and choose **Read tags for 5 seconds**. Decoded EPCs appear above the activity log with copy controls. **Stop inventory** ends a scan early.

RE422 does not necessarily stream tags when a port opens. The previous generic settings (9600 baud and, in the reported session, two stop bits) plus passive listening could leave **DATA IN** at zero. The supported flow uses the reader's binary inventory commands from the [manufacturer's RE40 SDK](https://www.jnxrfid.com/assets/files/SDK.zip). See the [JRE422 product page](https://www.jnxrfid.com/readers/jre422.html) and [Zebra RE40 guide](https://www.zebra.com/content/dam/zebra_new_ia/en-us/manuals/oem/re40dkre-ug-en.pdf) for the underlying module.

Each scan stops existing operations, reads the current antenna configuration, disables tag-access operations, and configures C1G2 inventory and immediate reports. It preserves antenna, transmit power, link profile, and region settings. The app reads back the inventory operation, antenna binding, and five-second stop setting before starting. Automatic restart and GPIO start are disabled; a firmware duration limit bounds the scan even if the page closes. These are volatile operation settings: the app does not reset the reader or save configuration to nonvolatile memory. Start acknowledgments are optional, matching the SDK; tag packets and stop summaries report actual reader activity. Failed or incomplete exchanges close the connection before retrying.

This profile reads **EPC identifiers**, not arbitrary tag memory, and provides no built-in RE422 tag writing. Generic serial mode retains the manual command and fixed-response memory tools for separately documented protocols. No tag-write, lock, kill, or region-change commands are part of RE422 identification or scanning.

Physical verification on the attached RE422/CP2102 at 921600/8N1 identified firmware **3.0.20.0** and returned **1,228 tag reports / two unique EPCs in a five-second scan**, including `E28011704000021C5BEED15E` from the working HID test. The same app protocol/session code was bundled into a local serial diagnostic for that check; the port was closed afterward. Browser tests separately mock Web Serial. This verifies this reader/firmware, not every device sold under a similar model name.

## RFID value read/write

Keyboard mode displays the last captured value and remains read-only. For USB serial or raw HID, the memory panel displays passive input as **Latest reader input**, explicitly separate from a decoded memory response. A completed memory read or verification retains its **Last returned value** and last-operation result. The panel also supports a configurable command exchange for readers with a fixed response prefix and a fixed-width value. It does not assume a reader model or supply guessed read/write commands.

Use your reader's documentation to configure these fields:

| Field                  | Meaning                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Read command           | Complete command bytes in hexadecimal. Include the reader's target selection, memory address, and any required fixed framing. |
| Write command template | Hexadecimal command bytes with exactly one `{value}` placeholder. The encoded value replaces that placeholder.                |
| Read response prefix   | The hexadecimal bytes immediately preceding the returned value.                                                               |
| Value width            | The exact number of value bytes to read or write, from **1–256**.                                                             |
| Write acknowledgement  | The exact hexadecimal ACK byte sequence expected from the reader after a write command.                                       |
| Response timeout       | **500–10,000 ms** to wait for a configured response.                                                                          |
| HID report IDs         | For raw HID, select the input report ID carrying responses and an output report ID declared by the reader for commands.       |

Enter the value as UTF-8 text or hexadecimal bytes. Its encoded length must match the configured width exactly: the app does not add padding or truncate it. A character can occupy more than one UTF-8 byte. Memory commands use the configured bytes directly, without automatic HID padding; the separate diagnostic command's optional serial line ending does not modify them. Memory matching receives raw bytes independently of the activity log's framing setting.

**Read value** sends the configured read command and extracts the configured number of bytes after the response prefix. **Write and verify** sends the write command, waits for the configured acknowledgement, then sends a fresh read command and compares the returned bytes with the requested value. The positive result is **Read-back matches**. A transport write or acknowledgement alone is not reported as a successful tag write. Timeouts, mismatches, and canceled operations disconnect the reader before another attempt; they do not trigger automatic write retries.

This matcher is intended for simple, documented exchanges. It does not calculate command checksums, perform authentication handshakes, interpret dynamic lengths, or parse device-specific read-error responses. Protocols needing those operations require a device adapter. For example, the [NXP PN532 host protocol](https://www.nxp.com/docs/en/user-guide/141520.pdf) uses length and data checksums and distinguishes an ACK from the later command response. Supply complete commands appropriate to the selected tag and memory location; a matching byte sequence cannot independently establish that target selection or access permissions were correct.

Writing applies to memory supported by both the reader and tag, not universal UID editing. For example, [NXP NTAG213/215/216](https://www.nxp.com/products/NTAG213_215_216) has a manufacturer-programmed UID alongside separate writable user memory and configurable access protection.

Memory command configuration, HID report selections, DTR/RTS selections, value drafts, and read-back results stay in the current lab session. They are not stored in the URL or browser storage. Leaving or reloading the lab clears them. Only the connection settings described below travel with a shared RFID link; exported activity logs can contain bytes sent and received during the session.

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

Each workspace has a path: `/single`, `/live`, `/batch`, `/scan`, or `/rfid`. Query parameters keep its content, controls, and last generated preview. For example, `/single?type=barcode&text=PRODUCT-001&size=1024` opens a barcode ready to download. When an encoded URL exceeds 6,000 characters, its state moves into the URL fragment (`#state=…`) so large batches can reload without exceeding the server's request-header limit.

- The address bar updates as you edit. Select **Copy link** to share or bookmark the current workspace.
- Edited inputs and the last generated code are stored separately, so reloading an unfinished edit preserves the same preview. Batch collections and decoded scan results are restored too.
- Browser Back and Forward restore workspaces. Live timers, cameras, keyboard capture, and USB connections always require an explicit start after reloading.
- RFID links contain **connection settings only**: transport, HID mode, serial reader profile, terminator, idle interval, serial options, and framing. For example, `/rfid?reader=serial&model=re422` restores the RE422 preset, and `/rfid?reader=serial&baud=115200` restores generic serial configuration. Received data, logs, command drafts, memory command configuration, value drafts, read-back results, device identities, permissions, and active connections are never encoded in an RFID link.
- Only the active workspace is included in a link. Recent history, uploaded image files, camera frames, and session counters are not included.
- Links contain the active workspace’s text and settings. They can be seen by anyone you share the link with and appear in browser history. Query parameters are sent to your host when opening the URL; fragment contents are processed only in the browser. Extremely large links may still exceed a browser or messaging service’s limits; PDF/SVG downloads remain available for those collections.

## Build and verify

```sh
npm run build
npm test
npm run test:e2e
```

The build is emitted to `dist/`. The included `vercel.json` sets the Vite build command/output and rewrites application routes to `index.html`, so direct links and reloads work on Vercel while preserving the browser URL and its state. Deploy from the repository root; commit and push changes to this configuration to trigger a new deployment in a Git-connected Vercel project. Existing deployments must be redeployed before a routing fix takes effect.

For other static hosts, configure the same `index.html` fallback for `/single`, `/live`, `/batch`, `/scan`, and `/rfid`, preserving the query string. Vite's development and preview servers provide this fallback automatically. `npm run preview` serves the production build locally. Clipboard, camera, WebHID, and Web Serial access require HTTPS or localhost.

Unit tests cover batch parsing, QR/barcode generation and decoding, image validation, URL state round trips, escaping, randomness, and color contrast. RFID tests cover automatic and strict framing across CRLF and UTF-8 boundaries, text/hex commands, size caps, protected HID reports, composite interface selection, early input reports, and mocked serial/HID resource lifecycles. Serial tests exercise permission cancellation, late opening, unplugging, pending reads and writes, recoverable receive errors, explicit line signals, ordered commands, and write timeouts. Browser tests cover generation, image scanning, simulated camera decoding and resource cleanup, share links and reloads, downloads, timers, printing, and mobile layout; see `playwright.config.ts` for browser and server settings.

RFID browser tests simulate keyboard input and browser device APIs; they do not prove compatibility with a physical reader. For hardware verification, use a known tag, confirm the selected mode and documented connection settings, compare the received text/hex to the vendor protocol, then verify disconnect and reconnect. Test any manual command against the reader's documented report ID and payload format.

Browser tests use an installed Google Chrome and automatically start a local server on port 5174. To use Playwright’s bundled Chromium instead, remove `channel: 'chrome'` from the configuration and run `npx playwright install chromium`.

Core generation: `src/lib/codes.ts`. Scanner: `src/components/Scanner.tsx`. RFID UI and transports: `src/components/RfidLab.tsx`, `src/lib/rfidData.ts`, `src/lib/rfidHid.ts`, and `src/lib/rfidSerial.ts`. Memory commands and matching: `src/components/RfidMemory.tsx` and `src/lib/rfidMemory.ts`. Routing/state: `src/lib/urlState.ts`. Application UI and shared styling: `src/App.tsx` and `src/styles.css`.

RE40 binary framing, verified command builders, and EPC decoding: `src/lib/rfidRe40.ts`. RE422 identification, finite inventory, response matching, and cancellation: `src/lib/rfidRe40Session.ts`. Tests include captured hardware firmware/tag frames, split packets, invalid CRCs, command sequencing, timeouts, and URL preset restoration.
