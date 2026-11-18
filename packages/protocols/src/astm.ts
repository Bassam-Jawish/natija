/**
 * ASTM E1381 (low-level frames) and ASTM E1394 (records), the protocol family used by the
 * Roche cobas e 411 (verified from the manufacturer manual) and the Sysmex XN-L / XN
 * series (secondary sources). The link-layer state machine lives in astm-link.ts.
 *
 * Frame:   <STX> FN text <ETB|ETX> C1 C2 <CR> <LF>
 *   FN     frame number, '1'..'7' then '0', continuing across the records of a transmission
 *   C1 C2  checksum: sum of the bytes from FN through ETB/ETX inclusive, modulo 256, as two
 *          uppercase hex digits
 * A record starts in a new frame and ends with CR; a record longer than the frame limit is
 * split into intermediate frames (ETB) followed by one end frame (ETX).
 *
 * All functions here take "binary strings" (one char per byte, see bytes.ts).
 */
import { CH } from './bytes';

/**
 * Text characters per frame when we build frames. E1381 allows 240 text characters
 * (247 with STX, FN, ETX, C1, C2, CR, LF); Roche's e 411 manual counts the frame number
 * inside the 240, so we send at most 239 text characters: valid under both readings.
 */
export const ASTM_FRAME_TEXT_MAX = 239;
/** Receivers accept longer frames than they send (lenient), up to this many characters. */
export const ASTM_FRAME_RECEIVE_LIMIT = 64 * 1024;

/** Sum of the bytes FN..ETX/ETB modulo 256, two uppercase hex digits. */
export function astmChecksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum + (body.charCodeAt(i) & 0xff)) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

export type AstmFrame = {
  /** Frame number 0..7. */
  fn: number;
  /** Text between FN and ETB/ETX (a record or a piece of one, CR included). */
  text: string;
  /** true for an end frame (ETX), false for an intermediate frame (ETB). */
  final: boolean;
  checksum: string;
};

/** Build one frame. */
export function buildFrame(fn: number, text: string, final: boolean): string {
  const body = `${((fn % 8) + 8) % 8}${text}${final ? CH.ETX : CH.ETB}`;
  return `${CH.STX}${body}${astmChecksum(body)}${CH.CR}${CH.LF}`;
}

/** Split a message (records separated by CR) into its records, each keeping its CR. */
export function splitRecordsKeepCr(message: string): string[] {
  const out: string[] = [];
  for (const line of message.split(/\r\n|\r|\n/)) {
    if (line.length) out.push(`${line}${CH.CR}`);
  }
  return out;
}

/**
 * Turn a message into E1381 frames: each record starts a new frame, long records are split
 * with ETB, frame numbers run 1..7, 0, 1, ...
 */
export function frameMessage(message: string, opts: { maxText?: number; firstFn?: number } = {}): string[] {
  const max = Math.max(1, opts.maxText ?? ASTM_FRAME_TEXT_MAX);
  const frames: string[] = [];
  let fn = opts.firstFn ?? 1;
  for (const record of splitRecordsKeepCr(message)) {
    for (let i = 0; i < record.length; i += max) {
      const final = i + max >= record.length;
      frames.push(buildFrame(fn, record.slice(i, i + max), final));
      fn = (fn + 1) % 8;
    }
  }
  return frames;
}

export type FrameCheck = { ok: true; frame: AstmFrame } | { ok: false; error: string; fn: number | null };

/**
 * Validate and decode one complete frame (STX .. CR LF). A missing final LF is tolerated;
 * everything else (STX, frame number, terminator, checksum) must be right.
 */
export function parseFrame(raw: string): FrameCheck {
  if (raw.charCodeAt(0) !== 0x02) return { ok: false, error: 'frame does not start with STX', fn: null };
  let end = raw.length;
  if (raw[end - 1] === CH.LF) end--;
  if (raw[end - 1] !== CH.CR) return { ok: false, error: 'frame does not end with CR LF', fn: null };
  end--;
  if (end < 5) return { ok: false, error: 'frame too short', fn: null };
  const checksum = raw.slice(end - 2, end);
  const terminator = raw[end - 3];
  if (terminator !== CH.ETX && terminator !== CH.ETB) return { ok: false, error: 'missing ETX/ETB', fn: null };
  const fnChar = raw[1]!;
  if (!/^[0-7]$/.test(fnChar)) return { ok: false, error: `invalid frame number "${fnChar}"`, fn: null };
  const fn = Number(fnChar);
  const body = raw.slice(1, end - 2);
  const expected = astmChecksum(body);
  if (checksum.toUpperCase() !== expected) {
    return { ok: false, error: `checksum mismatch: received ${checksum}, computed ${expected}`, fn };
  }
  return { ok: true, frame: { fn, text: raw.slice(2, end - 3), final: terminator === CH.ETX, checksum: expected } };
}

/* ------------------------------------------------------------------ E1394 records */

export type AstmDelimiters = { field: string; repeat: string; component: string; escape: string };

export const DEFAULT_ASTM_DELIMITERS: AstmDelimiters = { field: '|', repeat: '\\', component: '^', escape: '&' };

/** Record type IDs defined by E1394 (S = scientific; M = manufacturer information). */
export const ASTM_RECORD_TYPES = ['H', 'P', 'O', 'R', 'C', 'Q', 'M', 'S', 'L'] as const;

export type AstmRecord = {
  /** Record type ID (field 1): H, P, O, R, C, Q, M, S or L. */
  type: string;
  /** Raw (still escaped) fields; index = field number - 1, so fields[0] is the type. */
  fields: string[];
};

export type AstmMessage = { delimiters: AstmDelimiters; records: AstmRecord[] };

export class AstmParseError extends Error {}

/** Delimiters from a header record: "H|\^&" → field '|', repeat '\', component '^', escape '&'. */
export function delimitersFromHeader(header: string): AstmDelimiters {
  if (header[0] !== 'H' || header.length < 5) throw new AstmParseError('header record must start with H and the four delimiters');
  const d = { field: header[1]!, repeat: header[2]!, component: header[3]!, escape: header[4]! };
  const set = new Set([d.field, d.repeat, d.component, d.escape]);
  if (set.size !== 4 || /[A-Za-z0-9\r\n]/.test([...set].join(''))) {
    throw new AstmParseError(`invalid delimiter definition "${header.slice(1, 5)}"`);
  }
  return d;
}

/**
 * Parse E1394 text (records separated by CR; LF and CR LF are tolerated). Delimiters come
 * from the first H record; text without a header uses the defaults.
 */
export function parseAstm(text: string): AstmMessage {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) throw new AstmParseError('empty message');
  const header = lines.find((l) => l[0] === 'H');
  const delimiters = header ? delimitersFromHeader(header) : DEFAULT_ASTM_DELIMITERS;
  const records = lines.map((line) => {
    const fields = line.split(delimiters.field);
    const type = (fields[0] ?? '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(type)) throw new AstmParseError(`invalid record type "${fields[0]}"`);
    fields[0] = type;
    return { type, fields };
  });
  return { delimiters, records };
}

/** Undo E1394 escape sequences: &F& &S& &R& &E& and &Xhh..& (hex). Unknown ones stay as-is. */
export function astmUnescape(value: string, d: AstmDelimiters = DEFAULT_ASTM_DELIMITERS): string {
  if (!value.includes(d.escape)) return value;
  const e = d.escape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${e}([FSRE]|X[0-9A-Fa-f]+)${e}`, 'g');
  return value.replace(re, (whole, code: string) => {
    switch (code) {
      case 'F':
        return d.field;
      case 'S':
        return d.component;
      case 'R':
        return d.repeat;
      case 'E':
        return d.escape;
      default: {
        const hex = code.slice(1);
        if (hex.length % 2) return whole;
        let out = '';
        for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        return out;
      }
    }
  });
}

/** Escape delimiters inside a data value. */
export function astmEscape(value: string, d: AstmDelimiters = DEFAULT_ASTM_DELIMITERS): string {
  let out = '';
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.repeat) out += `${d.escape}R${d.escape}`;
    else if (ch === '\r' || ch === '\n') out += ' ';
    else out += ch;
  }
  return out;
}

/** Raw text of field `n` (1-based, E1394 numbering). */
export function astmRaw(rec: AstmRecord, n: number): string {
  return rec.fields[n - 1] ?? '';
}

/** Decoded repeats → components of field `n`. The H record's delimiter field is returned whole. */
export function astmRepeats(rec: AstmRecord, n: number, d: AstmDelimiters): string[][] {
  const raw = astmRaw(rec, n);
  if (rec.type === 'H' && n === 2) return [[raw]];
  if (raw === '') return [];
  return raw.split(d.repeat).map((rep) => rep.split(d.component).map((c) => astmUnescape(c, d)));
}

/** One decoded value: field n, component c, repeat r (all 1-based). */
export function astmGet(rec: AstmRecord, n: number, d: AstmDelimiters, component = 1, repeat = 1): string {
  return astmRepeats(rec, n, d)[repeat - 1]?.[component - 1] ?? '';
}

/**
 * A field value for the builder: a plain value, components (string[]) or repeats of
 * components (string[][]). Values are escaped; null/undefined become empty fields.
 */
export type AstmFieldInput = string | number | null | undefined | Array<string | number | null | undefined> | Array<Array<string | number | null | undefined>>;

function encodeField(v: AstmFieldInput, d: AstmDelimiters): string {
  if (v === null || v === undefined) return '';
  if (!Array.isArray(v)) return astmEscape(String(v), d);
  const isRepeats = v.some((x) => Array.isArray(x));
  if (isRepeats) {
    return (v as Array<Array<string | number | null | undefined>>)
      .map((rep) => (Array.isArray(rep) ? rep : [rep]).map((c) => astmEscape(c === null || c === undefined ? '' : String(c), d)).join(d.component))
      .join(d.repeat);
  }
  return (v as Array<string | number | null | undefined>).map((c) => astmEscape(c === null || c === undefined ? '' : String(c), d)).join(d.component);
}

/**
 * Build one record. `fields` is keyed by E1394 field number (2 = sequence number, ...);
 * the H record's delimiter definition (field 2) is written automatically. Trailing empty
 * fields are dropped, as E1394 allows.
 */
export function astmRecord(type: string, fields: Record<number, AstmFieldInput>, d: AstmDelimiters = DEFAULT_ASTM_DELIMITERS): string {
  const numbers = Object.keys(fields).map(Number);
  const last = Math.max(type === 'H' ? 2 : 1, ...numbers.filter((n) => Number.isInteger(n) && n >= 2));
  const out: string[] = [type];
  for (let n = 2; n <= last; n++) {
    if (type === 'H' && n === 2) out.push(`${d.repeat}${d.component}${d.escape}`);
    else out.push(encodeField(fields[n], d));
  }
  while (out.length > 1 && out[out.length - 1] === '' && !(type === 'H' && out.length === 2)) out.pop();
  return out.join(d.field);
}

/** Join records into message text (each record ends with CR). */
export function buildAstm(records: string[]): string {
  return records.map((r) => `${r}\r`).join('');
}

/**
 * Split a transmission (everything between ENQ and EOT) into messages: each starts at an
 * H record and ends at its L record.
 */
export function splitAstmMessages(text: string): string[] {
  const out: string[][] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    if (line[0] === 'H' || !out.length) out.push([]);
    out[out.length - 1]!.push(line);
  }
  return out.map((lines) => buildAstm(lines));
}

/** True when the message ends with its terminator (L) record, i.e. the sender finished it. */
export function astmHasTerminator(message: string): boolean {
  const lines = message.split(/\r\n|\r|\n/).filter((l) => l.trim());
  return lines.length > 0 && lines[lines.length - 1]![0] === 'L';
}

/** Text of a message with every record shown as `{type, fields: [{ref: 'R.4', value}]}` (non-empty fields only). */
export function astmRecordView(msg: AstmMessage): Array<{ type: string; fields: Array<{ ref: string; value: string }> }> {
  return msg.records.map((r) => ({
    type: r.type,
    fields: r.fields
      .map((value, i) => ({ ref: `${r.type}.${i + 1}`, value }))
      .filter((f, i) => i > 0 && f.value !== ''),
  }));
}
