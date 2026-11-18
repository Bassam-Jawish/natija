/**
 * Byte-level helpers shared by the link layers.
 *
 * The ASTM and MLLP state machines work on "binary strings": every character holds one
 * byte (0-255), exactly like Node's 'latin1' encoding. Checksums and framing therefore see
 * the real bytes, and text is decoded with the instrument's encoding only once a whole
 * message has arrived (so a UTF-8 character split across two frames survives).
 */

/** Control characters used by ASTM E1381 and HL7 MLLP framing. */
export const C = {
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  NAK: 0x15,
  ETB: 0x17,
  FS: 0x1c,
} as const;

export const CH = {
  STX: '\x02',
  ETX: '\x03',
  EOT: '\x04',
  ENQ: '\x05',
  ACK: '\x06',
  LF: '\n',
  VT: '\x0b',
  FF: '\x0c',
  CR: '\r',
  NAK: '\x15',
  ETB: '\x17',
  FS: '\x1c',
} as const;

export type TextEncoding = 'latin1' | 'utf8';

const NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x02: 'STX',
  0x03: 'ETX',
  0x04: 'EOT',
  0x05: 'ENQ',
  0x06: 'ACK',
  0x09: 'TAB',
  0x0a: 'LF',
  0x0b: 'VT',
  0x0c: 'FF',
  0x0d: 'CR',
  0x15: 'NAK',
  0x17: 'ETB',
  0x1c: 'FS',
};

/** Name of a single control byte, e.g. "ACK". */
export function controlName(byte: number): string {
  return NAMES[byte] ?? `0x${byte.toString(16).padStart(2, '0')}`;
}

/** Render text or bytes for logs: control characters become <STX>, <CR>, <ACK>, ... */
export function printable(input: string | Uint8Array): string {
  const s = typeof input === 'string' ? input : Buffer.from(input).toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? `<${controlName(code)}>` : s[i];
  }
  return out;
}

/** Text → binary string (one char per byte) in the given encoding. */
export function encodeText(text: string, encoding: TextEncoding = 'latin1'): string {
  if (encoding === 'latin1') {
    // Characters outside latin1 cannot be represented on an 8-bit ASTM line.
    return text.replace(/[^\x00-\xff]/g, '?');
  }
  return Buffer.from(text, 'utf8').toString('latin1');
}

/** Binary string → text in the given encoding. */
export function decodeText(binary: string, encoding: TextEncoding = 'latin1'): string {
  if (encoding === 'latin1') return binary;
  return Buffer.from(binary, 'latin1').toString('utf8');
}

/** Bytes for a binary string. */
export function binaryToBytes(binary: string): Uint8Array {
  return Buffer.from(binary, 'latin1');
}

/** Binary string for bytes (or a string that is already binary). */
export function bytesToBinary(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
}

/** Injectable timers so state machines can run with fake clocks in tests. */
export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const realTimers: Timers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    // Never keep a process alive only for a protocol timeout.
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** One line of a wire trace: what went over the link, in which direction, and why. */
export type WireTrace = {
  /** Milliseconds since the session was created. */
  t: number;
  /** tx = this side wrote it, rx = this side read it, note = protocol decision. */
  dir: 'tx' | 'rx' | 'note';
  kind: 'control' | 'frame' | 'message' | 'text' | 'info' | 'error';
  /** Printable form (<STX>1H|\^&...<CR><ETX>3F<CR><LF>) or a human sentence for notes. */
  text: string;
  /** For frames: checksum verified (rx) or deliberately corrupted (tx). */
  ok?: boolean;
};
