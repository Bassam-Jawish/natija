/**
 * HL7 v2 over MLLP: framing, parsing, building and acknowledgements.
 *
 * Used by the Roche cobas pure (HL7 v2.5, IHE LAW message set, UTF-8; verified from the
 * manufacturer manual) and the Mindray BS-430 (HL7 v2.3.1; secondary sources).
 *
 * MLLP frame: <VT> message <FS><CR>. Segments end with CR. Delimiters come from MSH:
 * MSH-1 is the field separator (the 4th character), MSH-2 the encoding characters
 * (component ^, repetition ~, escape \, subcomponent &; v2.7 adds truncation #).
 */
import { CH, decodeText, encodeText, type TextEncoding } from './bytes';
import { compactTimestamp } from './time';

/* ------------------------------------------------------------------ MLLP */

/** Wrap a message for MLLP and return the bytes. */
export function mllpFrame(message: string, encoding: TextEncoding = 'utf8'): Uint8Array {
  return Buffer.from(`${CH.VT}${encodeText(message, encoding)}${CH.FS}${CH.CR}`, 'latin1');
}

/**
 * Streaming MLLP decoder. Feed chunks as they arrive (a frame may be split anywhere, even
 * between FS and CR); push() returns every message completed by that chunk.
 */
export class MllpDecoder {
  private buf = '';
  private inFrame = false;

  constructor(
    private readonly opts: { encoding?: TextEncoding; maxBytes?: number; onJunk?: (description: string) => void } = {},
  ) {}

  push(chunk: Uint8Array | string): string[] {
    this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1');
    const out: string[] = [];
    for (;;) {
      if (!this.inFrame) {
        const start = this.buf.indexOf(CH.VT);
        if (start < 0) {
          if (this.buf.trim().length) this.opts.onJunk?.(`ignored ${this.buf.length} byte(s) outside an MLLP frame`);
          this.buf = '';
          return out;
        }
        if (start > 0 && this.buf.slice(0, start).trim().length) this.opts.onJunk?.(`ignored ${start} byte(s) before <VT>`);
        this.buf = this.buf.slice(start + 1);
        this.inFrame = true;
      }
      const end = this.buf.indexOf(CH.FS);
      const restart = this.buf.indexOf(CH.VT);
      if (restart >= 0 && (end < 0 || restart < end)) {
        this.opts.onJunk?.('MLLP frame restarted before <FS>; partial message discarded');
        this.buf = this.buf.slice(restart + 1);
        continue;
      }
      if (end < 0) {
        if (this.buf.length > (this.opts.maxBytes ?? 4 * 1024 * 1024)) {
          this.opts.onJunk?.('MLLP frame too large; discarded');
          this.buf = '';
          this.inFrame = false;
        }
        return out;
      }
      if (end + 1 >= this.buf.length) return out; // wait: the CR after FS may be in the next chunk
      const body = this.buf.slice(0, end);
      this.buf = this.buf.slice(this.buf[end + 1] === CH.CR ? end + 2 : end + 1);
      this.inFrame = false;
      out.push(decodeText(body, this.opts.encoding ?? 'utf8'));
    }
  }

  /** Text of a frame that started but has not ended yet, or null. */
  pending(): string | null {
    return this.inFrame && this.buf.length ? decodeText(this.buf, this.opts.encoding ?? 'utf8') : null;
  }

  reset(): void {
    this.buf = '';
    this.inFrame = false;
  }
}

/* ------------------------------------------------------------------ parsing */

export type Hl7Delimiters = { field: string; component: string; repeat: string; escape: string; subcomponent: string };

export const DEFAULT_HL7_DELIMITERS: Hl7Delimiters = { field: '|', component: '^', repeat: '~', escape: '\\', subcomponent: '&' };

export type Hl7Segment = {
  name: string;
  /** Raw (escaped) fields; index = field number. fields[0] is the name. For MSH, fields[1] is the field separator and fields[2] the encoding characters. */
  fields: string[];
};

export type Hl7Message = {
  delimiters: Hl7Delimiters;
  segments: Hl7Segment[];
  /** MSH-9: message type, trigger event and structure, e.g. OUL / R22 / OUL_R22. */
  type: string;
  trigger: string;
  structure: string;
  /** MSH-10. */
  controlId: string;
  /** MSH-12. */
  version: string;
  sendingApp: string;
  sendingFacility: string;
  receivingApp: string;
  receivingFacility: string;
  /** MSH-7 as sent. */
  timestamp: string;
};

export class Hl7ParseError extends Error {}

/** Parse an HL7 v2 message. Segments are separated by CR (LF and CR LF are tolerated). */
export function parseHl7(text: string): Hl7Message {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/^[\x0b\x1c]+|[\x0b\x1c]+$/g, ''))
    .filter((l) => l.trim().length > 0);
  const mshIndex = lines.findIndex((l) => l.startsWith('MSH'));
  if (mshIndex < 0) throw new Hl7ParseError('no MSH segment');
  const msh = lines[mshIndex]!;
  if (msh.length < 8) throw new Hl7ParseError('MSH segment too short');
  const field = msh[3]!;
  const encEnd = msh.indexOf(field, 4);
  const enc = encEnd < 0 ? msh.slice(4) : msh.slice(4, encEnd);
  if (enc.length < 4) throw new Hl7ParseError(`invalid encoding characters "${enc}"`);
  const d: Hl7Delimiters = { field, component: enc[0]!, repeat: enc[1]!, escape: enc[2]!, subcomponent: enc[3]! };
  if (new Set([d.field, d.component, d.repeat, d.escape, d.subcomponent]).size !== 5 || /[A-Za-z0-9]/.test(field + enc.slice(0, 4))) {
    throw new Hl7ParseError(`invalid delimiters "${field}${enc}"`);
  }
  const segments: Hl7Segment[] = lines.slice(mshIndex).map((line) => {
    if (line.startsWith('MSH')) {
      const parts = line.split(field);
      return { name: 'MSH', fields: ['MSH', field, ...parts.slice(1)] };
    }
    const fields = line.split(field);
    const name = fields[0]!.trim();
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7ParseError(`invalid segment name "${name.slice(0, 10)}"`);
    fields[0] = name;
    return { name, fields };
  });
  const head = segments[0]!;
  return {
    delimiters: d,
    segments,
    type: hl7Get(head, 9, d, 1),
    trigger: hl7Get(head, 9, d, 2),
    structure: hl7Get(head, 9, d, 3),
    controlId: hl7Get(head, 10, d),
    version: hl7Get(head, 12, d),
    sendingApp: hl7Get(head, 3, d),
    sendingFacility: hl7Get(head, 4, d),
    receivingApp: hl7Get(head, 5, d),
    receivingFacility: hl7Get(head, 6, d),
    timestamp: hl7Get(head, 7, d),
  };
}

/** "OUL^R22" style label of a parsed message. */
export function hl7Label(msg: Pick<Hl7Message, 'type' | 'trigger'>): string {
  return msg.trigger ? `${msg.type}^${msg.trigger}` : msg.type;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Undo HL7 escapes: \F\ \S\ \T\ \R\ \E\, \.br\ (line break), \Xhh..\ (hex); highlighting and charset escapes are dropped. */
export function hl7Unescape(value: string, d: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  if (!value.includes(d.escape)) return value;
  const e = escapeRe(d.escape);
  const re = new RegExp(`${e}([^${e}]*)${e}`, 'g');
  return value.replace(re, (whole, code: string) => {
    switch (code) {
      case 'F':
        return d.field;
      case 'S':
        return d.component;
      case 'T':
        return d.subcomponent;
      case 'R':
        return d.repeat;
      case 'E':
        return d.escape;
      case '.br':
        return '\n';
      case 'H':
      case 'N':
        return '';
      default:
        if (/^X[0-9A-Fa-f]+$/.test(code) && code.length % 2 === 1) {
          let out = '';
          for (let i = 1; i < code.length; i += 2) out += String.fromCharCode(parseInt(code.slice(i, i + 2), 16));
          return out;
        }
        if (/^[CM][0-9A-Fa-f]+$/.test(code)) return '';
        return whole;
    }
  });
}

/** Escape a data value. */
export function hl7Escape(value: string, d: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  let out = '';
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.subcomponent) out += `${d.escape}T${d.escape}`;
    else if (ch === d.repeat) out += `${d.escape}R${d.escape}`;
    else if (ch === '\n') out += `${d.escape}.br${d.escape}`;
    else if (ch === '\r') continue;
    else out += ch;
  }
  return out;
}

/** Raw text of field n (MSH-1 / MSH-2 included). */
export function hl7Raw(seg: Hl7Segment, n: number): string {
  return seg.fields[n] ?? '';
}

/** Decoded leaf value: field n, component c, repetition r, subcomponent s (all 1-based). */
export function hl7Get(seg: Hl7Segment, n: number, d: Hl7Delimiters, component = 1, repeat = 1, sub = 1): string {
  const raw = hl7Raw(seg, n);
  if (seg.name === 'MSH' && (n === 1 || n === 2)) return raw;
  const rep = raw.split(d.repeat)[repeat - 1] ?? '';
  const comp = rep.split(d.component)[component - 1] ?? '';
  const leaf = comp.split(d.subcomponent)[sub - 1] ?? '';
  return hl7Unescape(leaf, d);
}

/** Decoded components of one repetition (subcomponents joined back with their separator). */
export function hl7Components(seg: Hl7Segment, n: number, d: Hl7Delimiters, repeat = 1): string[] {
  const raw = hl7Raw(seg, n);
  const rep = raw.split(d.repeat)[repeat - 1] ?? '';
  if (rep === '') return [];
  return rep.split(d.component).map((c) => c.split(d.subcomponent).map((s) => hl7Unescape(s, d)).join(d.subcomponent));
}

/** Number of repetitions in field n. */
export function hl7RepeatCount(seg: Hl7Segment, n: number, d: Hl7Delimiters): number {
  const raw = hl7Raw(seg, n);
  return raw === '' ? 0 : raw.split(d.repeat).length;
}

/* ------------------------------------------------------------------ building */

type Leaf = string | number | null | undefined;
/** A component: a value, or subcomponents. */
export type Hl7Component = Leaf | Leaf[];
/** A field: a value, components, or { repeat: [...] } for repetitions. */
export type Hl7FieldInput = Leaf | Hl7Component[] | { repeat: Array<Leaf | Hl7Component[]> };

function leaf(v: Leaf, d: Hl7Delimiters): string {
  return v === null || v === undefined ? '' : hl7Escape(String(v), d);
}

function encodeComponents(v: Leaf | Hl7Component[], d: Hl7Delimiters): string {
  if (!Array.isArray(v)) return leaf(v, d);
  return v.map((c) => (Array.isArray(c) ? c.map((s) => leaf(s, d)).join(d.subcomponent) : leaf(c, d))).join(d.component);
}

function encodeField(v: Hl7FieldInput, d: Hl7Delimiters): string {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v.repeat.map((r) => encodeComponents(r, d)).join(d.repeat);
  return encodeComponents(v as Leaf | Hl7Component[], d);
}

/**
 * Build one segment. `fields` is keyed by field number; for MSH, MSH-1 and MSH-2 are
 * written from the delimiters and keys start at 3. Trailing empty fields are dropped.
 */
export function hl7Segment(name: string, fields: Record<number, Hl7FieldInput>, d: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  const numbers = Object.keys(fields).map(Number).filter((n) => Number.isInteger(n) && n >= 1);
  const last = Math.max(0, ...numbers);
  if (name === 'MSH') {
    const out = [`MSH${d.field}${d.component}${d.repeat}${d.escape}${d.subcomponent}`];
    for (let n = 3; n <= last; n++) out.push(encodeField(fields[n], d));
    while (out.length > 1 && out[out.length - 1] === '') out.pop();
    return out.join(d.field);
  }
  const out = [name];
  for (let n = 1; n <= last; n++) out.push(encodeField(fields[n], d));
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out.join(d.field);
}

/** Join segments into a message (each segment ends with CR). */
export function buildHl7(segments: string[]): string {
  return segments.map((s) => `${s}\r`).join('');
}

/** Message types that answer another message and never get an acknowledgement themselves. */
const RESPONSE_TYPES = new Set(['ACK', 'RSP', 'QCK', 'ORL', 'ORR', 'OSR', 'RRE', 'RRD', 'RAS']);

export function hl7IsResponse(type: string): boolean {
  return RESPONSE_TYPES.has(type);
}

/** The MSA-2 control ID a response refers to, or null. */
export function hl7AckedControlId(msg: Hl7Message): string | null {
  const msa = msg.segments.find((s) => s.name === 'MSA');
  return msa ? hl7Get(msa, 2, msg.delimiters) || null : null;
}

/** MSA-1 acknowledgement code (AA, AE, AR, CA, CE, CR), or null. */
export function hl7AckCode(msg: Hl7Message): string | null {
  const msa = msg.segments.find((s) => s.name === 'MSA');
  return msa ? hl7Get(msa, 1, msg.delimiters) || null : null;
}

export type Hl7AckOptions = {
  code: 'AA' | 'AE' | 'AR';
  text?: string;
  controlId: string;
  now?: Date;
  timeZone?: string;
  /** Override MSH-9 (e.g. "ORL^O34^ORL_O34" to answer OML^O33). */
  messageType?: string;
};

/** Acknowledgement for a received message: MSH with sender/receiver swapped, MSA, and ERR when not accepted. */
export function buildHl7Ack(original: Hl7Message, opts: Hl7AckOptions): string {
  const d = original.delimiters;
  const v = original.version || '2.5';
  const modern = !/^2\.[0-3]/.test(v);
  const msh = original.segments[0]!;
  const type = opts.messageType ?? (modern ? `ACK^${original.trigger}^ACK` : `ACK^${original.trigger}`);
  const segments = [
    hl7Segment(
      'MSH',
      {
        3: original.receivingApp,
        4: original.receivingFacility,
        5: original.sendingApp,
        6: original.sendingFacility,
        7: compactTimestamp(opts.now ?? new Date(), opts.timeZone ?? 'UTC'),
        9: type.split('^'),
        10: opts.controlId,
        11: hl7Get(msh, 11, d) || 'P',
        12: v,
        18: hl7Get(msh, 18, d) || undefined,
      },
      d,
    ),
    hl7Segment('MSA', { 1: opts.code, 2: original.controlId, 3: opts.text }, d),
  ];
  if (opts.code !== 'AA') {
    const reason = opts.code === 'AR' ? ['200', 'Unsupported message type', 'HL70357'] : ['207', 'Application internal error', 'HL70357'];
    segments.push(modern ? hl7Segment('ERR', { 3: reason, 4: 'E', 8: opts.text }, d) : hl7Segment('ERR', { 1: [null, null, null, reason] }, d));
  }
  return buildHl7(segments);
}

/** Segments of a message as `{type, fields: [{ref: 'OBX-5', value}]}` (non-empty fields only). */
export function hl7SegmentView(msg: Hl7Message): Array<{ type: string; fields: Array<{ ref: string; value: string }> }> {
  return msg.segments.map((s) => ({
    type: s.name,
    fields: s.fields.map((value, i) => ({ ref: `${s.name}-${i}`, value })).filter((f, i) => i > 0 && f.value !== ''),
  }));
}
