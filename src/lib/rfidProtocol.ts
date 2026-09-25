/**
 * Passive CPH-compatible RF tag notifications only. Protocol source: the vendor
 * `C#/doc/UHF communication protocol.doc` in the CPH SDK mirrored at
 * https://github.com/klks/CPH-F206_Reversing_Notes/tree/main/sdk
 * Sections: Frame format definition, Tags Uploaded, EPC, and Single Tag.
 * The one-byte HID count and zero padding are the observed transport wrapper;
 * they are not part of the RF protocol or the WebHID report ID.
 */
export function decodeRfHidReport(bytes: Uint8Array): { epcs: string[] } | null {
  let frame = bytes;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x46) {
    const count = bytes[0];
    if (count === undefined || count < 9 || count + 1 > bytes.length) return null;
    for (let index = count + 1; index < bytes.length; index++) {
      if (bytes[index] !== 0) return null;
    }
    frame = bytes.subarray(1, count + 1);
  }

  if (
    frame.length < 9 ||
    frame[0] !== 0x52 ||
    frame[1] !== 0x46 ||
    frame[2] !== 0x02 ||
    frame[5] !== 0x80
  )
    return null;

  const parameterLength = (frame[6] << 8) | frame[7];
  if (frame.length !== parameterLength + 9) return null;
  let checksum = 0;
  for (const byte of frame) checksum = (checksum + byte) & 0xff;
  if (checksum !== 0) return null;

  const epcs: string[] = [];
  const parameterEnd = frame.length - 1;
  for (let offset = 8; offset < parameterEnd;) {
    if (offset + 2 > parameterEnd) return null;
    const type = frame[offset];
    const length = frame[offset + 1];
    const start = offset + 2;
    const end = start + length;
    if (end > parameterEnd) return null;
    if (type === 0x07 && (length !== 1 || frame[start] !== 0)) return null;

    if (type === 0x50) {
      let epc: string | null = null;
      for (let nested = start; nested < end;) {
        if (nested + 2 > end) return null;
        const attribute = frame[nested];
        const valueLength = frame[nested + 1];
        const valueStart = nested + 2;
        const valueEnd = valueStart + valueLength;
        if (valueEnd > end) return null;
        if (attribute === 0x01) {
          // A single-tag container has one EPC; never guess at duplicate fields.
          if (valueLength === 0 || epc !== null) return null;
          epc = Array.from(frame.subarray(valueStart, valueEnd), (byte) =>
            byte.toString(16).padStart(2, '0').toUpperCase(),
          ).join('');
        } else if (
          (attribute === 0x05 && valueLength !== 1) ||
          (attribute === 0x06 && valueLength !== 4) ||
          (attribute === 0x07 && (valueLength !== 1 || frame[valueStart] !== 0))
        )
          return null;
        nested = valueEnd;
      }
      if (epc !== null) epcs.push(epc);
    }
    offset = end;
  }
  return epcs.length > 0 ? { epcs } : null;
}
